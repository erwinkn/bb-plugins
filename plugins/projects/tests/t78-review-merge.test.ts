import { describe, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { report, projectFixture } from "./fake-native";
import { DEFAULT_PROFILES, type Profile } from "../lib/schema";
import { planReview } from "../lib/policy";

// T78: when the configured reviewOfClaude and reviewOfGpt profiles are
// identical, a mixed scope gets one reviewer, not two identical ones.
// Profiles that differ in any field still split per family.

const claude: Profile = { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" };
const fable: Profile = { providerId: "claude-code", model: "claude-fable-5-1", reasoningLevel: "xhigh" };
const sol: Profile = { providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "high" };
const astra: Profile = { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "xhigh" };

type Fixture = Awaited<ReturnType<typeof projectFixture>>["f"];

async function implemented(f: Fixture, projectId: string, profile: Profile, title: string) {
  const task = f.task(projectId, title);
  const [d] = await f.service.delegate(projectId, { route: "fresh", tasks: [task.ref], profile });
  await f.service.report(d.threadId!, report());
  // The native turn ends after its report (T91 keeps a running reporter's scope).
  f.idle(d.threadId!);
  return task;
}

async function mixed(reviewOfClaude: Profile, reviewOfGpt: Profile) {
  const { f, project } = await projectFixture({ executionProfiles: JSON.stringify({ reviewOfClaude, reviewOfGpt }) });
  const t1 = await implemented(f, project.id, claude, "Claude part");
  const t2 = await implemented(f, project.id, sol, "GPT part");
  f.spawn.mockClear();
  const results = await f.service.delegate(project.id, { route: "fresh", role: "review", reviewOf: [t1.ref, t2.ref] });
  return { f, project, t1, t2, results, reviews: f.store.assignments(project.id).filter((a) => a.role === "review") };
}

describe("T78 identical configured reviewers merge", () => {
  it("starts one reviewer over a mixed scope when both family profiles are identical", async () => {
    const { f, t1, t2, results, reviews } = await mixed(fable, fable);
    expect(results).toHaveLength(1);
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.spawn.mock.calls[0][0]).toMatchObject({ providerId: fable.providerId, model: fable.model, reasoningLevel: fable.reasoningLevel });
    expect(reviews).toHaveLength(1);
    const [a] = reviews;
    expect(a).toMatchObject({ access: "read-only", route: "fresh", profile: fable, reviewKey: null, reviewOf: [t1.num, t2.num] });
    expect(a!.reviewTargets!.map((t) => [t.task, t.assignment, t.revision])).toEqual([
      [t1.ref, "A1", report().handoff.workspaceRevision],
      [t2.ref, "A2", report().handoff.workspaceRevision],
    ]);
    expect(a!.briefText).toMatch(/Review scope: the mixed Claude and GPT implementation contributions\./);
    expect(a!.briefText).not.toMatch(/Another reviewer|other reviewer/i);
    expect(a!.rationale).toMatch(/T1 was implemented by Claude; T2 was implemented by GPT/);
    expect(a!.rationale).toMatch(/one reviewer/);
  });

  it("keeps both implementers' targets of a single task authored by both families", async () => {
    const { f, project } = await projectFixture({ executionProfiles: JSON.stringify({ reviewOfClaude: astra, reviewOfGpt: astra }) });
    const task = await implemented(f, project.id, claude, "Shared part");
    const first = f.store.assignments(project.id)[0]!;
    // A second, GPT implementer on the same task, recorded as reported work.
    const second = f.store.createAssignment({ ...first, opId: "op_gpt", profile: sol, briefText: "GPT follow-up", reviewOf: null, rationale: null });
    f.store.updateAssignment(project.id, second.num, { state: "reported", report: report(), reportedAt: 1, actualProfile: sol });
    f.spawn.mockClear();
    const results = await f.service.delegate(project.id, { route: "fresh", role: "review", reviewTargets: [
      { task: task.ref, assignment: first.ref, revision: report().handoff.workspaceRevision },
      { task: task.ref, assignment: second.ref, revision: report().handoff.workspaceRevision },
    ] });
    expect(results).toHaveLength(1);
    expect(f.spawn).toHaveBeenCalledTimes(1);
    const a = f.store.assignments(project.id).at(-1)!;
    expect(a).toMatchObject({ role: "review", profile: astra, reviewKey: null, reviewOf: [task.num] });
    expect(a.reviewTargets!.map((t) => [t.assignment, t.profile])).toEqual([[first.ref, claude], [second.ref, sol]]);
    expect(a.briefText).toMatch(/mixed Claude and GPT/);
    expect(a.briefText).not.toMatch(/Another reviewer/);
  });

  it("merges identical profiles in the plan, with an honest rationale", () => {
    const plan = planReview({
      policy: { profiles: { ...DEFAULT_PROFILES, reviewOfClaude: fable, reviewOfGpt: { ...fable } } },
      taskNums: [1, 2],
      assignments: [
        { taskNums: [1], role: "work", state: "reported", actualProfile: claude, profile: claude },
        { taskNums: [2], role: "work", state: "reported", actualProfile: sol, profile: sol },
      ],
    });
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ key: null, profile: fable, taskNums: [1, 2] });
    expect(plan[0]!.rationale).toBe(
      "T1 was implemented by Claude; T2 was implemented by GPT. Configured reviewer: claude-code / claude-fable-5-1 / xhigh / tier unspecified (same model family as the Claude implementer); both families' reviewer profiles are identical, so one reviewer covers the whole scope.",
    );
  });
});

describe("T78 different profiles still split", () => {
  it.each([
    ["model", fable, claude],
    ["reasoning level", fable, { ...fable, reasoningLevel: "high" }],
    ["service tier", { ...astra, serviceTier: "fast" }, astra],
  ] as const)("starts one reviewer per family when only the %s differs", async (_, ofClaude, ofGpt) => {
    const { f, t1, t2, results, reviews } = await mixed(ofClaude as Profile, ofGpt as Profile);
    expect(results).toHaveLength(2);
    expect(f.spawn).toHaveBeenCalledTimes(2);
    expect(reviews.map((a) => a.profile)).toEqual([ofClaude, ofGpt]);
    expect(reviews.map((a) => a.reviewKey)).toEqual(["reviewOfClaude", "reviewOfGpt"]);
    expect(reviews.map((a) => a.reviewTargets!.map((t) => t.task))).toEqual([[t1.ref], [t2.ref]]);
    for (const a of reviews) expect(a.briefText).toMatch(/Another reviewer covers the other model family's contributions/);
  });

  it("starts one reviewer per family when only the provider differs", async () => {
    const { f, project } = await projectFixture({
      executionProfiles: JSON.stringify({ reviewOfClaude: astra, reviewOfGpt: { ...astra, providerId: "pi" } }),
    });
    f.threads.set("seed-pi", makeThreadResponse({ id: "seed-pi", projectId: "proj_b", providerId: "pi" }));
    const t1 = await implemented(f, project.id, claude, "Claude part");
    const t2 = await implemented(f, project.id, sol, "GPT part");
    f.spawn.mockClear();
    await f.service.delegate(project.id, { route: "fresh", role: "review", reviewOf: [t1.ref, t2.ref] });
    expect(f.spawn.mock.calls.map((c) => c[0].providerId)).toEqual(["codex", "pi"]);
  });

  it("an explicit profile over the mixed scope is still one reviewer", async () => {
    const { f, project } = await projectFixture({ executionProfiles: JSON.stringify({ reviewOfClaude: fable, reviewOfGpt: astra }) });
    const t1 = await implemented(f, project.id, claude, "Claude part");
    const t2 = await implemented(f, project.id, sol, "GPT part");
    f.spawn.mockClear();
    const results = await f.service.delegate(project.id, { route: "fresh", role: "review", reviewOf: [t1.ref, t2.ref], profile: claude });
    expect(results).toHaveLength(1);
    expect(f.spawn.mock.calls[0][0].model).toBe(claude.model);
  });

  it("refuses an identical but unavailable configured reviewer without substituting one", async () => {
    const bogus: Profile = { providerId: "claude-code", model: "claude-nonexistent-9", reasoningLevel: "high" };
    const { f, project } = await projectFixture({ executionProfiles: JSON.stringify({ reviewOfClaude: bogus, reviewOfGpt: bogus }) });
    const t1 = await implemented(f, project.id, claude, "Claude part");
    const t2 = await implemented(f, project.id, sol, "GPT part");
    f.spawn.mockClear();
    await expect(f.service.delegate(project.id, { route: "fresh", role: "review", reviewOf: [t1.ref, t2.ref] })).rejects.toThrow(/claude-nonexistent-9 is not in claude-code's catalog .* No fallback model/);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.store.assignments(project.id).filter((a) => a.role === "review")).toHaveLength(0);
  });
});
