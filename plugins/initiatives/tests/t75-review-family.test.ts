import { describe, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { report, projectFixture } from "./fake-native";
import { DEFAULT_PROFILES, type Profile } from "../lib/schema";
import { planReview } from "../lib/policy";
import { MAX_GUIDANCE_CHARACTERS } from "../lib/settings";
import { DEFAULT_COORDINATOR_INSTRUCTIONS, upgradeDecisionGuidance } from "../lib/guidance";

// T75: a different model family is the default recommendation for reviews,
// never a dispatch requirement. Independence comes from a fresh read-only
// context bound to the reported task/assignment/revision.

const claude: Profile = { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" };
const fable: Profile = { providerId: "claude-code", model: "claude-fable-5-1", reasoningLevel: "xhigh" };
const sol: Profile = { providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "high" };
const astra: Profile = { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "xhigh" };
const kimi: Profile = { providerId: "pi", model: "kimi-k3", reasoningLevel: "high" };

/** Put an unclassified provider/model in the native catalog, as BB would list it. */
function seedUnclassified(f: Awaited<ReturnType<typeof projectFixture>>["f"]) {
  f.threads.set("seed-pi", makeThreadResponse({ id: "seed-pi", projectId: "proj_b", providerId: "pi" }));
  f.execution.set("seed-pi", { model: kimi.model, reasoningLevel: "high" });
}

async function implemented(
  f: Awaited<ReturnType<typeof projectFixture>>["f"],
  projectId: string,
  profile?: Profile,
  title?: string,
) {
  const task = f.task(projectId, title);
  const [d] = await f.service.delegate(projectId, { route: "fresh", tasks: [task.ref], ...(profile ? { profile } : {}) });
  await f.service.report(d.threadId!, report());
  // The native turn ends after its report (T91 keeps a running reporter's scope).
  f.idle(d.threadId!);
  return task;
}

describe("T75 same-family reviewers are accepted", () => {
  it.each([
    ["Claude", claude, fable],
    ["GPT", sol, astra],
  ] as const)("dispatches an explicit same-family reviewer of %s work with the chosen profile", async (_, implementer, reviewer) => {
    const { f, project } = await projectFixture();
    const task = await implemented(f, project.id, implementer);
    f.spawn.mockClear();
    const [r] = await f.service.delegate(project.id, { route: "fresh", role: "review", reviewOf: [task.ref], profile: reviewer });
    expect(r.state).toBe("running");
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.spawn.mock.calls[0][0]).toMatchObject({ providerId: reviewer.providerId, model: reviewer.model, reasoningLevel: reviewer.reasoningLevel });
    const a = f.store.assignments(project.id).at(-1)!;
    expect(a).toMatchObject({ role: "review", access: "read-only", route: "fresh", profile: reviewer });
    expect(a.reviewTargets).toMatchObject([{ task: task.ref, assignment: "A1", revision: report().handoff.workspaceRevision, profile: implementer }]);
    expect(a.briefText).not.toMatch(/Another reviewer/);
  });

  it("an agent-requested CLI reviewer with a same-family profile dispatches", async () => {
    const { f, project } = await projectFixture();
    const task = await implemented(f, project.id);
    f.spawn.mockClear();
    const result = await f.harness.runCli(["command", JSON.stringify({
      action: "delegate", route: "fresh", role: "review", label: "Review", area: "Review",
      reviewTargets: [{ task: task.ref, assignment: "A1", revision: report().handoff.workspaceRevision }],
      profile: fable, permissionMode: "full",
    }), project.id], { threadId: "coordinator" });
    expect(result.exitCode).toBe(0);
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.spawn.mock.calls[0][0]).toMatchObject({ providerId: "claude-code", model: fable.model, permissionMode: "full" });
  });

  it.each([
    ["reviewOfClaude", claude, fable],
    ["reviewOfGpt", sol, astra],
  ] as const)("uses a configured same-family %s profile by default", async (key, implementer, configured) => {
    const { f, project } = await projectFixture({ executionProfiles: JSON.stringify({ [key]: configured }) });
    const task = await implemented(f, project.id, implementer);
    f.spawn.mockClear();
    const [r] = await f.service.delegate(project.id, { route: "fresh", role: "review", reviewOf: [task.ref] });
    expect(r.state).toBe("running");
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.spawn.mock.calls[0][0]).toMatchObject({ providerId: configured.providerId, model: configured.model });
    const a = f.store.assignments(project.id).at(-1)!;
    expect(a.reviewKey).toBe(key);
    expect(a.rationale).not.toMatch(/other series/);
  });

  it("keeps the built-in cross-family default when nothing else is chosen", async () => {
    const { f, project } = await projectFixture();
    const task = await implemented(f, project.id);
    f.spawn.mockClear();
    await f.service.delegate(project.id, { route: "fresh", role: "review", reviewOf: [task.ref] });
    expect(f.spawn.mock.calls[0][0].model).toBe(DEFAULT_PROFILES.reviewOfClaude.model);
  });
});

describe("T75 unclassified model families", () => {
  it("accepts a valid unclassified reviewer profile for Claude work", async () => {
    const { f, project } = await projectFixture();
    seedUnclassified(f);
    const task = await implemented(f, project.id);
    f.spawn.mockClear();
    const [r] = await f.service.delegate(project.id, { route: "fresh", role: "review", reviewOf: [task.ref], profile: kimi });
    expect(r.state).toBe("running");
    expect(f.spawn.mock.calls[0][0]).toMatchObject({ providerId: "pi", model: kimi.model });
  });

  it("accepts an unclassified reviewer of unclassified work", async () => {
    const { f, project } = await projectFixture();
    seedUnclassified(f);
    const task = await implemented(f, project.id, kimi);
    f.spawn.mockClear();
    const [r] = await f.service.delegate(project.id, { route: "fresh", role: "review", reviewOf: [task.ref], profile: kimi });
    expect(r.state).toBe("running");
    expect(f.store.assignments(project.id).at(-1)!.reviewKey).toBeNull();
  });
});

describe("T75 mixed authorship", () => {
  it("one explicit reviewer covers the whole mixed scope without duplicates or false coverage claims", async () => {
    const { f, project } = await projectFixture();
    const t1 = await implemented(f, project.id, claude, "Claude part");
    const t2 = await implemented(f, project.id, sol, "GPT part");
    f.spawn.mockClear();
    const results = await f.service.delegate(project.id, { route: "fresh", role: "review", reviewOf: [t1.ref, t2.ref], profile: fable });
    expect(results).toHaveLength(1);
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.spawn.mock.calls[0][0].model).toBe(fable.model);
    const a = f.store.assignments(project.id).at(-1)!;
    expect(a.reviewOf).toEqual([t1.num, t2.num]);
    expect(a.reviewTargets!.map((t) => t.assignment)).toEqual(["A1", "A2"]);
    expect(a.reviewKey).toBeNull();
    expect(a.briefText).not.toMatch(/Another reviewer|other reviewer/i);
    expect(a.briefText).toMatch(/mixed Claude and GPT/);
  });

  it("without a chosen profile, still recommends one reviewer per family and says so truthfully", async () => {
    const { f, project } = await projectFixture();
    const t1 = await implemented(f, project.id, claude, "Claude part");
    const t2 = await implemented(f, project.id, sol, "GPT part");
    f.spawn.mockClear();
    const results = await f.service.delegate(project.id, { route: "fresh", role: "review", reviewOf: [t1.ref, t2.ref] });
    expect(results).toHaveLength(2);
    expect(f.spawn.mock.calls.map((c) => c[0].model)).toEqual([DEFAULT_PROFILES.reviewOfClaude.model, DEFAULT_PROFILES.reviewOfGpt.model]);
    const [ra, rb] = f.store.assignments(project.id).slice(-2);
    expect(ra!.reviewTargets!.map((t) => t.task)).toEqual([t1.ref]);
    expect(rb!.reviewTargets!.map((t) => t.task)).toEqual([t2.ref]);
    expect(ra!.briefText).toMatch(/Another reviewer/);
  });

  it("plan rationale describes a configured reviewer honestly", () => {
    const [part] = planReview({
      policy: { profiles: { ...DEFAULT_PROFILES, reviewOfClaude: fable } },
      taskNums: [1],
      assignments: [{ taskNums: [1], role: "work", state: "reported", actualProfile: claude, profile: claude }],
    });
    expect(part!.profile).toEqual(fable);
    expect(part!.rationale).not.toMatch(/other series/);
    expect(part!.rationale).toMatch(/same model family/);
  });
});

describe("T75 genuine review safeguards are unchanged", () => {
  it("still refuses continuing or forking any context into a review", async () => {
    const { f, project } = await projectFixture();
    const task = await implemented(f, project.id);
    const worker = f.store.workers(project.id)[0]!;
    f.idle(worker.threadId!);
    for (const route of ["continue", "fork"] as const)
      await expect(
        f.service.delegate(project.id, { route, worker: worker.ref, role: "review", reviewOf: [task.ref], profile: claude }),
      ).rejects.toThrow(/always fresh independent threads/);
  });

  it("forces read-only access on a same-family reviewer", async () => {
    const { f, project } = await projectFixture();
    const task = await implemented(f, project.id);
    await f.service.delegate(project.id, { route: "fresh", role: "review", reviewOf: [task.ref], profile: fable, access: "write" });
    expect(f.store.assignments(project.id).at(-1)!.access).toBe("read-only");
  });

  it("still binds the actual reported revision", async () => {
    const { f, project } = await projectFixture();
    const task = await implemented(f, project.id);
    await expect(
      f.service.delegate(project.id, {
        route: "fresh", role: "review", profile: fable,
        reviewTargets: [{ task: task.ref, assignment: "A1", revision: "stale-revision" }],
      }),
    ).rejects.toThrow(/reports revision/);
    expect(f.store.assignments(project.id).filter((a) => a.role === "review")).toHaveLength(0);
  });
});

describe("T75 coordinator guidance", () => {
  const shipped = "Use configured independent reviewers from the other recorded implementer series, respecting explicit user choices and tool independence guards.";

  it("the default recommends a different family without requiring it", () => {
    expect(DEFAULT_COORDINATOR_INSTRUCTIONS).not.toContain("other recorded implementer series");
    expect(DEFAULT_COORDINATOR_INSTRUCTIONS).toMatch(/different model family is recommended, not required/);
    expect(DEFAULT_COORDINATOR_INSTRUCTIONS.length).toBeLessThanOrEqual(MAX_GUIDANCE_CHARACTERS);
  });

  it("migrates only the shipped sentence in saved guidance, keeping custom text and staying idempotent", async () => {
    const custom = `Our review rule. ${shipped} Always ask Erwin before merging.`;
    const { f } = await projectFixture({ coordinatorInstructions: custom });
    await f.preferences.ready;
    const saved = (await f.preferences.handle.get()).coordinatorInstructions;
    expect(saved).not.toContain(shipped);
    expect(saved.startsWith("Our review rule. ")).toBe(true);
    expect(saved.endsWith(" Always ask Erwin before merging.")).toBe(true);
    expect(saved).toMatch(/different model family is recommended, not required/);
    expect(upgradeDecisionGuidance(saved, "coordinator", MAX_GUIDANCE_CHARACTERS)).toBe(saved);
    const unrelated = "Reviews must come from the other series, per our team rule.";
    expect(upgradeDecisionGuidance(unrelated, "coordinator", MAX_GUIDANCE_CHARACTERS)).toBe(unrelated);
  });
});
