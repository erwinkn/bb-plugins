import { describe, expect, it } from "vitest";
import { commandSchema } from "../lib/commands";
import { clearCatalogCache } from "../lib/bb";
import { profileFor } from "../lib/policy";
import { reviewerProfileFor } from "../lib/reviewer-fallback";
import { DEFAULT_PROFILES, DEFAULT_POLICY, PROFILE_KEYS, PROFILE_ROLE_LABELS, policySchema, storedPolicySchema, type Profile } from "../lib/schema";
import { parseProfileDefaults, settingsDescriptors } from "../lib/settings";
import { memoryStore } from "./helpers";
import { projectFixture, report } from "./fake-native";

// W634: one reviewer role for every worker model (Claude, GPT, Gemini/Antigravity, ...), with the
// reviewFallback profile for outages. Settings and policies saved with reviewOfClaude/reviewOfGpt still load.
const opus: Profile = { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" };
const sol: Profile = { providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "xhigh" };
const luna: Profile = { providerId: "codex", model: "gpt-6-luna", reasoningLevel: "xhigh" };
const muse: Profile = { providerId: "muse", model: "muse-wonder-1.0", reasoningLevel: "xhigh" };
const neon: Profile = { providerId: "acp-antigravity", model: "gemini-pro-orchestrator-neon", reasoningLevel: "high" };

type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const tool = async (f: Fx, name: string, input: unknown, threadId = "coordinator") =>
  JSON.parse((await f.harness.callAgentTool(name, input, { threadId })) as string);
const spawnOf = (profile: Profile) => `--provider ${profile.providerId} --model ${profile.model} --reasoning-level ${profile.reasoningLevel}`;

describe("W634 the role set", () => {
  it("has six roles, with one Reviewer and the Fallback reviewer", () => {
    expect([...PROFILE_KEYS]).toEqual(["coordinator", "implementation", "straightforward", "mechanical", "reviewer", "reviewFallback"]);
    expect(Object.values(PROFILE_ROLE_LABELS)).toEqual(["Coordinator", "Worker", "Fast worker", "Very fast worker", "Reviewer", "Fallback reviewer"]);
    expect(DEFAULT_PROFILES.reviewer).toEqual({ providerId: "acp-antigravity", model: "gemini-4-neon", reasoningLevel: "high" });
    expect(DEFAULT_PROFILES.reviewFallback).toEqual(opus);
    expect(Object.keys(JSON.parse(settingsDescriptors.executionProfiles.default))).toEqual([...PROFILE_KEYS]);
  });

  it("documents reviewer, and the legacy keys, in the Settings description", () => {
    const description = settingsDescriptors.executionProfiles.description;
    expect(description).toContain("reviewer: reviewer, for every worker model");
    expect(description).toContain("reviewOfClaude");
    expect(description).toContain("reviewOfGpt");
  });
});

describe("W634 legacy reviewer keys", () => {
  it.each([
    ["policySchema", (profiles: unknown) => policySchema.parse({ profiles }).profiles],
    ["storedPolicySchema", (profiles: unknown) => storedPolicySchema.parse({ profiles }).profiles],
    ["parseProfileDefaults", (profiles: unknown) => parseProfileDefaults(JSON.stringify(profiles))],
  ])("%s: migrates the legacy keys to reviewer and drops them", (_, parse) => {
    expect(parse({ reviewOfClaude: sol })).toEqual({ reviewer: sol });
    expect(parse({ reviewOfGpt: opus })).toEqual({ reviewer: opus });
    // Claude's key wins when both are set; an explicit reviewer wins over both.
    expect(parse({ reviewOfClaude: sol, reviewOfGpt: opus })).toEqual({ reviewer: sol });
    expect(parse({ reviewer: muse, reviewOfClaude: sol, reviewOfGpt: opus })).toEqual({ reviewer: muse });
    // Other keys stay; the retired work kinds are still ignored.
    expect(parse({ implementation: opus, investigation: luna, reviewOfGpt: sol, reviewFallback: opus })).toEqual({ implementation: opus, reviewer: sol, reviewFallback: opus });
    // A null or missing legacy entry migrates nothing; the next one in order is used.
    expect(parse({ reviewOfClaude: null, reviewOfGpt: opus })).toEqual({ reviewer: opus });
    expect(parse({ reviewOfClaude: null })).toEqual({});
    expect(parse({})).toEqual({});
  });

  it("a malformed legacy value is still rejected, so an edited JSON map is validated", () => {
    expect(() => policySchema.parse({ profiles: { reviewOfClaude: { model: 42 } } })).toThrow();
    expect(() => parseProfileDefaults(JSON.stringify({ reviewOfGpt: "sol" }))).toThrow();
    // Validated even when another value wins: an explicit reviewer, or an earlier legacy key.
    expect(() => policySchema.parse({ profiles: { reviewer: sol, reviewOfClaude: "bad" } })).toThrow();
    expect(() => policySchema.parse({ profiles: { reviewOfClaude: sol, reviewOfGpt: { model: 42 } } })).toThrow();
    expect(() => parseProfileDefaults(JSON.stringify({ reviewer: sol, reviewOfGpt: { model: 42 } }))).toThrow();
    expect(() => parseProfileDefaults(JSON.stringify({ reviewOfOther: sol }))).toThrow();
  });

  it("reads a stored policy blob with the legacy keys, and rewrites it without them on the next edit", async () => {
    const { store, db } = memoryStore();
    store.createProject({ id: "p1", name: "One", objective: "o", memberProjectIds: [], coordinatorThreadId: "c", policy: DEFAULT_POLICY });
    db.prepare(`UPDATE projects SET policy = ? WHERE id = 'p1'`).run(JSON.stringify({ profiles: { reviewOfGpt: opus, reviewOfClaude: sol, implementation: luna } }));
    expect(store.project("p1")!.policy.profiles).toEqual({ implementation: luna, reviewer: sol });
    db.prepare(`UPDATE projects SET policy = ? WHERE id = 'p1'`).run(JSON.stringify({ profiles: { reviewer: muse, reviewOfClaude: sol } }));
    expect(store.project("p1")!.policy.profiles).toEqual({ reviewer: muse });
  });

  it("edit sets and clears reviewer, also over a stored legacy key", async () => {
    const { f, project } = await projectFixture();
    f.store.db.prepare(`UPDATE projects SET policy = ? WHERE id = ?`).run(JSON.stringify({ profiles: { reviewOfClaude: sol } }), project.id);
    expect(f.store.project(project.id)!.policy.profiles).toEqual({ reviewer: sol });
    f.service.editProject(project.id, { profiles: { reviewer: muse } });
    expect(f.store.project(project.id)!.policy.profiles).toEqual({ reviewer: muse });
    expect(JSON.parse((f.store.db.prepare(`SELECT policy FROM projects WHERE id = ?`).get(project.id) as { policy: string }).policy).profiles).toEqual({ reviewer: muse });
    f.service.editProject(project.id, { profiles: { reviewer: null } });
    expect(f.store.project(project.id)!.policy.profiles).toEqual({});
    // A stale client naming a retired key is refused, not silently dropped.
    expect(commandSchema.safeParse({ action: "edit", profiles: { reviewOfGpt: null } }).success).toBe(false);
    expect(commandSchema.safeParse({ action: "edit", profiles: { reviewer: null } }).success).toBe(true);
    expect(commandSchema.safeParse({ action: "edit", profiles: { reviewer: sol } }).success).toBe(true);
  });

  it("the global setting with legacy keys supplies the reviewer for a brief", async () => {
    const { f } = await projectFixture({ executionProfiles: JSON.stringify({ reviewOfGpt: muse }) });
    await tool(f, "initiative_spawn", { label: "Fix", purpose: "fix", text: "Fix it." });
    expect(f.spawn.mock.calls.at(-1)![0].prompt as string).toContain(spawnOf(muse));
  });
});

describe("W634 one reviewer for every worker model", () => {
  it("profileFor and reviewerProfileFor return the reviewer regardless of the worker", () => {
    const policy = policySchema.parse({ profiles: { reviewer: muse } });
    expect(reviewerProfileFor(policy)).toEqual(muse);
    expect(profileFor(policy, "reviewer")).toEqual(muse);
    expect(reviewerProfileFor(DEFAULT_POLICY)).toEqual(DEFAULT_PROFILES.reviewer);
  });

  it("every brief names the same reviewer, for a Claude, a GPT and a Gemini worker, and the review assignment records the reviewer key", async () => {
    const { f, project } = await projectFixture({ executionProfiles: JSON.stringify({ reviewer: muse }) });
    f.threads.set("ag", { ...f.threads.get("coordinator")!, id: "ag", providerId: neon.providerId });
    f.threads.set("mu", { ...f.threads.get("coordinator")!, id: "mu", providerId: muse.providerId });
    f.execution.set("mu", { model: muse.model, reasoningLevel: muse.reasoningLevel });
    f.execution.set("ag", { model: neon.model, reasoningLevel: neon.reasoningLevel });
    for (const profile of [opus, sol, neon, muse]) f.execution.set(`probe-${profile.model}`, { model: profile.model, reasoningLevel: profile.reasoningLevel });
    clearCatalogCache();
    for (const [index, profile] of [opus, sol, neon].entries()) {
      await tool(f, "initiative_spawn", { label: `W${index}`, purpose: "x", text: "Do it.", profile, permissionMode: "full" });
      const sent = f.spawn.mock.calls.at(-1)![0];
      expect(sent).toMatchObject({ providerId: profile.providerId, model: profile.model });
      const brief = sent.prompt as string;
      expect(brief).toContain(spawnOf(muse));
      expect(brief).not.toContain(spawnOf(profile === opus ? sol : opus) + "\n");
    }
    // A review the service itself starts (v9 keeps the path) uses the same role for each worker.
    const worker = f.store.workers(project.id)[0]!;
    await f.service.report(worker.threadId!, report());
    f.idle(worker.threadId!);
    await f.service.delegate(project.id, { route: "fresh", label: "Review", area: "review", note: "Review W1.", role: "review", reviews: "W1", permissionMode: "full" });
    expect(f.spawn.mock.calls.at(-1)![0]).toMatchObject({ providerId: muse.providerId, model: muse.model });
    const review = f.store.assignments(project.id).find((a) => a.role === "review")!;
    expect(review.reviewKey).toBe("reviewer");
    expect(f.store.assignments(project.id).filter((a) => a.role === "work").every((a) => a.reviewKey === null)).toBe(true);
  });

  it("a stored review row from before the single role still reads its legacy key", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "Fix", purpose: "fix", text: "Fix it." });
    f.store.db.prepare(`UPDATE assignments SET review_key = 'reviewOfGpt' WHERE project_id = ? AND num = 1`).run(project.id);
    expect(f.store.assignment(project.id, 1)!.reviewKey).toBe("reviewOfGpt");
    f.store.db.prepare(`UPDATE assignments SET review_key = 'reviewOfClaude' WHERE project_id = ? AND num = 1`).run(project.id);
    expect(f.store.assignment(project.id, 1)!.reviewKey).toBe("reviewOfClaude");
    expect(w.threadId).toBeTruthy();
  });
});
