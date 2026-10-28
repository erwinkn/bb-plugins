import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { reviewerCommand } from "../lib/brief";
import { DEFAULT_WORKER_INSTRUCTIONS, GUIDANCE_RESET_FLAG, PREVIOUS_DEFAULTS } from "../lib/guidance";
import { DEFAULT_PROFILES, PROFILE_ROLE_LABELS, policySchema } from "../lib/schema";
import { settingsDescriptors } from "../lib/settings";
import { fixture, projectFixture } from "./fake-native";

// W537 (rule R7 fallback, Erwin 2026-10-22): when the reviewer (Muse) can't run, the round runs
// again on the fallback reviewer, Claude Opus 5.5 high by default.
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const tool = async (f: Fx, name: string, input: unknown, threadId = "coordinator") =>
  JSON.parse((await f.harness.callAgentTool(name, input, { threadId })) as string);
const flat = (text: string) => text.replace(/\s+/g, " ");
const muse = { providerId: "muse", model: "muse-wonder-1.0", reasoningLevel: "xhigh" } as const;
const opus = { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" } as const;
const sonnet = { providerId: "claude-code", model: "claude-sonnet-5-5", reasoningLevel: "high" } as const;
const FALLBACK = "Fallback reviewer command:";
const spawnOf = (profile: { providerId: string; model: string; reasoningLevel: string }) =>
  `--provider ${profile.providerId} --model ${profile.model} --reasoning-level ${profile.reasoningLevel}`;

describe("W537 fallback reviewer", () => {
  it("defaults to Claude Opus 5.5 high, labelled Fallback reviewer, and is a policy key", () => {
    expect(DEFAULT_PROFILES.reviewFallback).toEqual(opus);
    expect(PROFILE_ROLE_LABELS.reviewFallback).toBe("Fallback reviewer");
    expect(policySchema.parse({ profiles: { reviewFallback: sonnet } }).profiles.reviewFallback).toEqual(sonnet);
    expect(JSON.parse(settingsDescriptors.executionProfiles.default).reviewFallback).toEqual(opus);
    expect(settingsDescriptors.executionProfiles.description).toContain("reviewFallback: fallback reviewer");
  });

  it("renders the fallback command after the reviewer's only when it differs", () => {
    const both = reviewerCommand(muse, opus);
    expect(both.startsWith("Reviewer command (code-review skill, other model family):\nbb thread spawn")).toBe(true);
    expect(both.indexOf(spawnOf(muse))).toBeLessThan(both.indexOf(FALLBACK));
    expect(both.indexOf(FALLBACK)).toBeLessThan(both.indexOf(spawnOf(opus)));
    // W545: the plugin reruns the round itself; the worker runs the command only when the reviewer command is refused.
    expect(both).toContain(`\n\n${FALLBACK} when a usage limit or an unavailable model stops a reviewer before its verdict, the plugin archives it, reruns that round on this profile itself (same prompt, under you) and tells you in this thread: wait for that reviewer; don't start another. Run this command yourself, even if it is your own model family, only when the reviewer command is refused, the plugin's message asks you to, or BB reports the reviewer failed on a limit and no plugin message comes within minutes. Name the fallback rounds in your report; if the fallback can't run either, report blocked. A review that gave a verdict or findings is never redone on the fallback.\nbb thread spawn`);
    // W545: the same model at another effort or tier hits the same quota, so it is no fallback.
    for (const single of [reviewerCommand(opus, opus), reviewerCommand(opus), reviewerCommand(muse, { ...muse }), reviewerCommand(muse, { ...muse, reasoningLevel: "high" }), reviewerCommand(opus, { ...opus, serviceTier: "fast" })]) {
      expect(single).not.toContain(FALLBACK);
      expect(single.match(/bb thread spawn/g)).toHaveLength(1);
    }
    // The fallback's own tier is carried.
    expect(reviewerCommand(muse, { ...opus, serviceTier: "fast" })).toContain(`${spawnOf(opus)} --service-tier fast`);
  });

  it("a brief and a work message carry the global fallback; the default one when unset", async () => {
    const { f } = await projectFixture({ executionProfiles: JSON.stringify({ reviewOfClaude: muse, reviewFallback: sonnet }) });
    const [w] = await tool(f, "initiative_spawn", { label: "Fix", purpose: "fix", text: "Fix it." });
    const brief = f.spawn.mock.calls.at(-1)![0].prompt as string;
    expect(brief).toContain(spawnOf(muse));
    expect(brief.slice(brief.indexOf(FALLBACK))).toContain(spawnOf(sonnet));
    await tool(f, "initiative_report", { outcome: "done", summary: "Done.", report: "Done." }, w.threadId);
    await tool(f, "initiative_message", { to: "W1", text: "One more thing.", work: true });
    const work = (f.send.mock.calls.at(-1)![0] as { input: { text: string }[] }).input.map((part) => part.text).join("");
    expect(work.slice(work.indexOf(FALLBACK))).toContain(spawnOf(sonnet));

    const plain = await projectFixture({ executionProfiles: JSON.stringify({ reviewOfClaude: muse }) });
    await tool(plain.f, "initiative_spawn", { label: "Fix", purpose: "fix", text: "Fix it." });
    const defaulted = plain.f.spawn.mock.calls.at(-1)![0].prompt as string;
    expect(defaulted.slice(defaulted.indexOf(FALLBACK))).toContain(spawnOf(opus));
  });

  it("an Adventure's own fallback overrides the global one; one equal to the reviewer is left out", async () => {
    const { f, project } = await projectFixture({ executionProfiles: JSON.stringify({ reviewOfClaude: muse, reviewFallback: sonnet }) });
    f.store.updateProject(project.id, { policy: { profiles: { reviewFallback: opus } } });
    await tool(f, "initiative_spawn", { label: "Fix", purpose: "fix", text: "Fix it." });
    const brief = f.spawn.mock.calls.at(-1)![0].prompt as string;
    expect(brief.slice(brief.indexOf(FALLBACK))).toContain(spawnOf(opus));
    expect(brief).not.toContain(spawnOf(sonnet));

    f.store.updateProject(project.id, { policy: { profiles: { reviewFallback: muse } } });
    await tool(f, "initiative_spawn", { label: "Other", purpose: "other", text: "Do it." });
    const same = f.spawn.mock.calls.at(-1)![0].prompt as string;
    expect(same).toContain(spawnOf(muse));
    expect(same).not.toContain(FALLBACK);
  });

  it("worker guidance, skill and README name the fallback; one reviewer per round stays", () => {
    const worker = flat(DEFAULT_WORKER_INSTRUCTIONS);
    expect(worker).toContain("one fresh reviewer each round");
    expect(worker).toContain("If it can't run (usage limit, model unavailable), the plugin reruns it on the fallback and tells you (no fallback command in your brief: report blocked); name those rounds in your report.");
    expect(flat(readFileSync("skills/initiative-worker/SKILL.md", "utf8"))).toContain("the plugin reruns it on the fallback and tells you (no fallback command in your brief: report blocked); name those rounds in your report.");
    const readme = flat(readFileSync("README.md", "utf8"));
    expect(readme).toContain("deletes the retries queued on it");
    expect(readme).toContain("a review that gave a verdict or findings is never redone on the fallback.");
    expect(readme).toContain("`reviewFallback` (the fallback reviewer, for either family; default Claude Opus 5.5 high)");
  });

  it("the worker default from before the fallback is kept as a legacy text and upgrades to the current one", async () => {
    // W545 keeps W537's text as a legacy one, before it; W548 keeps W545's in front of both.
    const [, w537, previous] = PREVIOUS_DEFAULTS.worker as [string, string, string];
    expect(w537).toContain("follow the fallback command's note in your brief (no fallback command: report blocked)");
    expect(previous).toContain("Clean means the verdict is correct with no P1 or P2.");
    expect(previous).not.toContain("fallback");
    for (const old of [w537, previous]) {
      const f = fixture({ workerInstructions: old });
      f.store.setFlag(GUIDANCE_RESET_FLAG);
      await f.preferences.ready;
      expect(f.preferences.configuration().workerInstructions).toBe(DEFAULT_WORKER_INSTRUCTIONS);
    }
    expect(PREVIOUS_DEFAULTS.worker).not.toContain(DEFAULT_WORKER_INSTRUCTIONS);
  });
});
