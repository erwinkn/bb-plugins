import { describe, expect, it } from "vitest";
import {
  chooseWorkProfile,
  delegationViolations,
  foldUsage,
  pathsOverlap,
  planReview,
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
  allTasks: [task(1)],
  bbProjectId: "proj_a",
  worker: null,
  workerOpenAssignment: null,
  thread: null,
  requestedProfile: DEFAULT_PROFILES.implementation,
  workspace: "shared",
  concurrentWork: [],
  paths: ["src"],
  providerSupportsFork: true,
  forkAtCompletedPoint: true,
  reviewOf: [],
  reviewOfTasks: [],
  ...patch,
});

const implemented = (
  taskNums: number[],
  providerId: string,
  model: string,
): Pick<
  AssignmentRecord,
  "taskNums" | "role" | "state" | "actualProfile" | "profile"
> => ({
  taskNums,
  role: "work",
  state: "accepted",
  profile: DEFAULT_PROFILES.implementation,
  actualProfile: { providerId, model, reasoningLevel: "high" },
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

describe("review routing", () => {
  it("routes by the recorded implementer, not the project default", () => {
    expect(seriesOf({ providerId: "codex", model: "gpt-6.1-sol" })).toBe("gpt");
    expect(
      seriesOf({ providerId: "claude-code", model: "claude-opus-5-5" }),
    ).toBe("claude");
    const plan = planReview({
      policy: DEFAULT_POLICY,
      taskNums: [1],
      assignments: [implemented([1], "codex", "gpt-6.1-sol")],
    });
    expect(plan).toHaveLength(1);
    expect(plan[0]!.profile).toEqual(DEFAULT_PROFILES.reviewOfGpt);
  });

  it("by default splits a mixed milestone into one recommended reviewer per implementing family", () => {
    const plan = planReview({
      policy: DEFAULT_POLICY,
      taskNums: [1, 2, 3],
      assignments: [
        implemented([1], "claude-code", "claude-opus-5-5"),
        implemented([2], "codex", "gpt-6.1-sol"),
        implemented([3], "claude-code", "claude-opus-5-5"),
        implemented([3], "codex", "gpt-6.1-sol"),
      ],
    });
    const byKey = Object.fromEntries(
      plan.map((part) => [part.key, part.taskNums]),
    );
    expect(byKey).toEqual({ reviewOfClaude: [1, 3], reviewOfGpt: [2, 3] });
    // The built-in defaults are cross-family, so no part is flagged as same-family.
    expect(plan.every((part) => /Configured reviewer: /.test(part.rationale))).toBe(true);
    expect(plan.some((part) => /same model family/.test(part.rationale))).toBe(false);
  });

  it("ignores review assignments when finding implementers", () => {
    const plan = planReview({
      policy: DEFAULT_POLICY,
      taskNums: [1],
      assignments: [
        implemented([1], "codex", "gpt-6.1-sol"),
        {
          ...implemented([1], "claude-code", "claude-fable-5-1"),
          role: "review",
        },
      ],
    });
    expect(plan.map((part) => part.key)).toEqual(["reviewOfGpt"]);
  });
});

describe("delegation eligibility", () => {
  it("accepts a valid fresh delegation", () => {
    expect(delegationViolations(facts())).toEqual([]);
  });

  it("holds new work while paused and enforces the project boundary", () => {
    const reasons = delegationViolations(
      facts({ project: { paused: true, memberProjectIds: ["proj_b"] } }),
    );
    expect(reasons.join(" ")).toMatch(/paused/);
    expect(reasons.join(" ")).toMatch(/not a member/);
  });

  it("checks dependencies without scheduling them", () => {
    const blocked = task(2, { dependsOn: [1] });
    const reasons = delegationViolations(
      facts({ tasks: [blocked], allTasks: [task(1), blocked] }),
    );
    expect(reasons).toEqual(["T2 depends on T1, which is not done."]);
    expect(
      delegationViolations(
        facts({
          tasks: [blocked],
          allTasks: [task(1, { status: "done" }), blocked],
        }),
      ),
    ).toEqual([]);
  });

  it("keeps roles immutable across reuse", () => {
    const reviewer = worker({ role: "review", ref: "W2", num: 2 });
    expect(
      delegationViolations(
        facts({
          route: "continue",
          worker: reviewer,
          thread: { archived: false, status: "idle", model: "claude-opus-5-5" },
        }),
      ).join(" "),
    ).toMatch(/Reviewers never implement/);
    expect(
      delegationViolations(
        facts({
          route: "continue",
          role: "review",
          worker: worker(),
          reviewOf: [1],
          reviewOfTasks: [task(1, { status: "awaiting_acceptance" })],
          thread: { archived: false, status: "idle", model: "claude-opus-5-5" },
        }),
      ).join(" "),
    ).toMatch(/cannot review/);
  });

  it("never continues or forks a reviewer: reviews are fresh threads only", () => {
    const reviewer = worker({
      role: "review",
      model: "gpt-6-astra",
      providerId: "codex",
    });
    expect(
      delegationViolations(
        facts({
          route: "continue",
          role: "review",
          tasks: [],
          worker: reviewer,
          reviewOf: [1],
          reviewOfTasks: [task(1, { status: "awaiting_acceptance" })],
          requestedProfile: DEFAULT_PROFILES.reviewOfClaude,
          thread: { archived: false, status: "idle", model: "gpt-6-astra" },
        }),
      ).join(" "),
    ).toMatch(/fresh/);
    expect(
      delegationViolations(
        facts({
          route: "fork",
          role: "review",
          tasks: [],
          worker: reviewer,
          reviewOf: [1],
          reviewOfTasks: [task(1, { status: "awaiting_acceptance" })],
          requestedProfile: DEFAULT_PROFILES.reviewOfClaude,
          thread: { archived: false, status: "idle", model: "gpt-6-astra" },
          forkAtCompletedPoint: true,
        }),
      ).join(" "),
    ).toMatch(/fresh/);
  });

  it("refuses to fork an implementer into a reviewer and requires a completed point", () => {
    const reasons = delegationViolations(
      facts({
        route: "fork",
        role: "review",
        worker: worker(),
        reviewOf: [1],
        reviewOfTasks: [task(1, { status: "awaiting_acceptance" })],
        forkAtCompletedPoint: false,
      }),
    );
    expect(reasons.join(" ")).toMatch(
      /Do not fork an implementer's transcript/,
    );
    expect(reasons.join(" ")).toMatch(/completed point/);
  });

  it("blocks a worker with an open assignment; BB owns queueing", () => {
    const open = { ref: "A3", state: "running" } as AssignmentRecord;
    const busy = facts({
      route: "continue",
      worker: worker(),
      workerOpenAssignment: open,
      thread: { archived: false, status: "active", model: "claude-opus-5-5" },
    });
    expect(delegationViolations(busy).join(" ")).toMatch(/still has A3 open/);
  });

  it("does not continue a worker on a different model", () => {
    expect(
      delegationViolations(
        facts({
          route: "continue",
          worker: worker(),
          requestedProfile: DEFAULT_PROFILES.investigation,
          thread: { archived: false, status: "idle", model: "claude-opus-5-5" },
        }),
      ).join(" "),
    ).toMatch(/mix models/);
  });

  it("refuses a retired worker's thread and an archived one", () => {
    const retired = facts({
      route: "continue",
      worker: worker({ state: "retired" }),
      thread: { archived: true, status: "idle", model: "claude-opus-5-5" },
    });
    expect(delegationViolations(retired).join(" ")).toMatch(/retired/);
  });

  it.each([
    ["read-only", "read-only"],
    ["read-only", "write"],
    ["write", "read-only"],
  ] as const)("allows overlapping %s / %s assignments", (access, otherAccess) => {
    expect(delegationViolations(facts({
      access,
      concurrentWork: [{ ref: "A2", workerRef: "W2", paths: ["src/auth"], workspace: "shared", access: otherAccess }],
    }))).toEqual([]);
  });

  it("serializes overlapping writes in a shared workspace", () => {
    const concurrentWork = [
      {
        ref: "A2",
        workerRef: "W2",
        paths: ["src/auth"],
        workspace: "shared" as const,
      },
    ];
    expect(
      delegationViolations(facts({ concurrentWork, paths: ["src"] })).join(" "),
    ).toMatch(/overlapping paths/);
    expect(
      delegationViolations(facts({ concurrentWork, paths: ["docs"] })),
    ).toEqual([]);
    expect(
      delegationViolations(
        facts({ concurrentWork, paths: ["src"], workspace: "isolated" }),
      ),
    ).toEqual([]);
    expect(pathsOverlap([], ["x"])).toBe(true);
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
