import { describe, expect, it } from "vitest";
import {
  chooseWorkProfile,
  delegationViolations,
  foldUsage,
  seriesOf,
  type DelegationFacts,
} from "../lib/policy";
import { DEFAULT_POLICY, DEFAULT_PROFILES } from "../lib/schema";
import type { AssignmentRecord, TaskRecord, WorkerRecord } from "../lib/store";
import { zeroTotals } from "../lib/store";
import { brief } from "./helpers";

const task = (num: number, patch: Partial<TaskRecord> = {}): TaskRecord => ({
  projectId: "p1",
  num,
  ref: `T${num}`,
  title: `Task ${num}`,
  summary: "s",
  brief: brief(),
  status: "planned",
  priority: 2,
  dependsOn: [],
  workKind: "implementation",
  profileOverride: null,
  profileSource: null,
  progress: null,
  nextCheckpoint: null,
  result: null,
  acceptedAssignment: null,
  createdAt: 0,
  updatedAt: 0,
  ...patch,
});

const worker = (patch: Partial<WorkerRecord> = {}): WorkerRecord => ({
  projectId: "p1",
  num: 1,
  ref: "W1",
  role: "work",
  kind: null,
  label: "API",
  area: "api",
  threadId: "thr_w1",
  generation: 1,
  bbProjectId: "proj_a",
  environmentId: "env_1",
  providerId: "claude-code",
  model: "claude-opus-5-5",
  reasoningLevel: "high",
  state: "idle",
  retention: null,
  handoff: null,
  forkedFrom: null,
  nativeParent: false,
  userStopped: false,
  interventionAt: null,
  createdAt: 0,
  updatedAt: 0,
  ...patch,
});

const facts = (patch: Partial<DelegationFacts> = {}): DelegationFacts => ({
  project: { paused: false, memberProjectIds: ["proj_a", "proj_b"] },
  route: "fresh",
  role: "work",
  tasks: [task(1)],
  bbProjectId: "proj_a",
  worker: null,
  workerOpenAssignment: null,
  thread: null,
  requestedProfile: DEFAULT_PROFILES.implementation,
  ...patch,
});

describe("profiles", () => {
  it("uses the confirmed defaults", () => {
    expect(DEFAULT_PROFILES.coordinator).toEqual({
      providerId: "claude-code",
      model: "claude-opus-5-5",
      reasoningLevel: "high",
    });
    expect(DEFAULT_PROFILES.investigation).toEqual({
      providerId: "codex",
      model: "gpt-6.1-sol",
      reasoningLevel: "high",
    });
    expect(DEFAULT_PROFILES.straightforward).toEqual({
      providerId: "codex",
      model: "gpt-6.1-sol",
      reasoningLevel: "high",
    });
    expect(DEFAULT_PROFILES.reviewOfClaude).toEqual({
      providerId: "codex",
      model: "gpt-6-astra",
      reasoningLevel: "xhigh",
    });
    expect(DEFAULT_PROFILES.reviewOfGpt).toEqual({
      providerId: "claude-code",
      model: "claude-fable-5-1",
      reasoningLevel: "xhigh",
    });
  });

  it("preserves an explicit user choice and refuses a silent replacement", () => {
    const user = {
      providerId: "codex",
      model: "gpt-6-sol",
      reasoningLevel: "high" as const,
    };
    const chosen = task(1, { profileOverride: user, profileSource: "user" });
    expect(
      chooseWorkProfile({
        policy: DEFAULT_POLICY,
        kind: "implementation",
        task: chosen,
        explicit: null,
      }),
    ).toEqual({ ok: true, profile: user, source: "user" });
    const conflict = chooseWorkProfile({
      policy: DEFAULT_POLICY,
      kind: "implementation",
      task: chosen,
      explicit: DEFAULT_PROFILES.implementation,
    });
    expect(conflict.ok).toBe(false);
  });

  it("falls back to the work kind's default, never to another model", () => {
    expect(
      chooseWorkProfile({
        policy: DEFAULT_POLICY,
        kind: "investigation",
        task: task(1),
        explicit: null,
      }),
    ).toEqual({
      ok: true,
      profile: DEFAULT_PROFILES.investigation,
      source: "default",
    });
  });
});

describe("delegation eligibility (T136)", () => {
  const idle = { archived: false, status: "idle", model: "claude-opus-5-5" };
  it("accepts a valid fresh delegation, with or without tasks", () => {
    expect(delegationViolations(facts())).toEqual([]);
    expect(delegationViolations(facts({ tasks: [] }))).toEqual([]);
  });

  it("holds new work while paused and enforces the project boundary", () => {
    const reasons = delegationViolations(
      facts({ project: { paused: true, memberProjectIds: ["proj_b"] } }),
    );
    expect(reasons.join(" ")).toMatch(/paused/);
    expect(reasons.join(" ")).toMatch(/not a member/);
  });

  it("asks to reopen a closed task before more work on it", () => {
    expect(delegationViolations(facts({ tasks: [task(1, { status: "done" })] }))).toEqual(["T1 is done. Reopen it first if it needs more work."]);
  });

  it("keeps reviewers out of implementation; a review is a reviewer's, which may re-review its batch", () => {
    const reviewer = worker({ role: "review", ref: "W2", num: 2 });
    expect(delegationViolations(facts({ route: "continue", worker: reviewer, thread: idle })).join(" ")).toMatch(/Reviewers never implement/);
    expect(delegationViolations(facts({ route: "continue", role: "review", worker: worker(), thread: idle })).join(" ")).toMatch(/A review is done by a reviewer/);
    expect(delegationViolations(facts({ route: "continue", role: "review", worker: reviewer, thread: idle }))).toEqual([]);
  });

  it("asks to steer or wait while a worker is still working", () => {
    const open = { ref: "A3", state: "running" } as AssignmentRecord;
    const busy = facts({ route: "continue", worker: worker(), workerOpenAssignment: open, thread: { ...idle, status: "active" } });
    expect(delegationViolations(busy).join(" ")).toMatch(/W1 is still working on A3 \(running\)\. Send a plain initiative_message/);
  });

  it("does not continue a worker on a different model", () => {
    expect(delegationViolations(facts({ route: "continue", worker: worker(), requestedProfile: DEFAULT_PROFILES.investigation, thread: idle })).join(" ")).toMatch(/mix models/);
  });

  it("refuses a retired worker's thread and an archived one", () => {
    const retired = facts({ route: "continue", worker: worker({ state: "retired" }), thread: { ...idle, archived: true } });
    expect(delegationViolations(retired).join(" ")).toMatch(/retired/);
  });
});

describe("usage", () => {
  const totals = (total: number) => ({ ...zeroTotals(), input: total, total });
  const empty = {
    lastSeq: 0,
    providerThreadId: null,
    sessionTotals: null,
    closedTotals: zeroTotals(),
    resets: 0,
  };

  it("folds cumulative reports without double counting", () => {
    const a = foldUsage(empty, {
      seq: 5,
      at: 1,
      providerThreadId: "s1",
      total: totals(100),
    });
    const b = foldUsage(a, {
      seq: 9,
      at: 2,
      providerThreadId: "s1",
      total: totals(250),
    });
    expect(b.sessionTotals!.total).toBe(250);
    expect(b.closedTotals.total).toBe(0);
    expect(
      foldUsage(b, {
        seq: 9,
        at: 3,
        providerThreadId: "s1",
        total: totals(999),
      }).sessionTotals!.total,
    ).toBe(250);
  });

  it("closes a session on a native reset", () => {
    const a = foldUsage(empty, {
      seq: 5,
      at: 1,
      providerThreadId: "s1",
      total: totals(100),
    });
    const b = foldUsage(a, {
      seq: 9,
      at: 2,
      providerThreadId: "s2",
      total: totals(20),
    });
    expect(b).toMatchObject({ reset: true, resets: 1 });
    expect(b.closedTotals.total).toBe(100);
    expect(b.sessionTotals!.total).toBe(20);
  });

  it("recognizes a larger first-result counter after a runtime restart with the same conversation", () => {
    const a = foldUsage(empty, {
      seq: 1,
      at: 1,
      providerThreadId: "s1",
      total: totals(22_229_476),
      last: totals(22_229_476),
    });
    const b = foldUsage(a, {
      seq: 2,
      at: 2,
      providerThreadId: "s1",
      total: totals(65_950_431),
      last: totals(65_950_431),
    });
    expect(b.closedTotals.total).toBe(22_229_476);
    expect(b.resets).toBe(1);
    const repeated = foldUsage(b, {
      seq: 3,
      at: 3,
      providerThreadId: "s1",
      total: totals(65_950_431),
      last: totals(65_950_431),
    });
    expect(repeated.closedTotals).toEqual(b.closedTotals);
    expect(repeated.resets).toBe(1);
  });
});
