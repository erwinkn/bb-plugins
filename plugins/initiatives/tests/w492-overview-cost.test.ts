import { describe, expect, it, vi } from "vitest";
import { memoryStore } from "./helpers";
import { buildOverview, threadsToWatch, type LiveThread, type OverviewDetail } from "../lib/overview";
import { reportSchema } from "../lib/schema";
import type { Store } from "../lib/store";

const profile = { providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "high" as const };
const report = (summary: string, outcome: "succeeded" | "blocked" = "succeeded") =>
  reportSchema.parse({
    outcome, summary, finalMessage: `${summary}. ${"A long final message. ".repeat(200)}`,
    ...(outcome === "blocked" ? { blocker: { question: `${summary}?`, context: "Context" } } : {}),
    handoff: { summary, workspaceRevision: "main", files: ["src/a.ts"] },
  });

/** One Initiative; `grow` adds workers that each did one reported assignment, with a thread, turns and a nested helper. */
function initiative() {
  const { store, db, clock } = memoryStore();
  store.createProject({ id: "p", name: "P", objective: "Ship", memberProjectIds: ["proj_a"], coordinatorThreadId: "coordinator" });
  let n = 0;
  const grow = (count: number, state: "idle" | "retired" = "retired") =>
    store.tx(() => {
      for (const end = n + count; n < end; n++) {
        clock.now += 1_000;
        const w = store.createWorker({ projectId: "p", role: "work", label: `Worker ${n}`, area: "fixture", bbProjectId: "proj_a" });
        store.updateWorker("p", w.num, { threadId: `thr_${n}`, generation: 1, state });
        store.openGeneration("p", w.num, 1, `thr_${n}`);
        const a = store.createAssignment({
          projectId: "p", workerNum: w.num, taskNums: [], route: "fresh", role: "work", workKind: "implementation", threadId: `thr_${n}`,
          generation: 1, profile, bbProjectId: "proj_a", environmentId: null, state: "running", opId: `op_${n}`, opState: "done",
          briefText: `Brief ${n}. ${"Context. ".repeat(500)}`, reviewOf: null, rationale: null,
        });
        store.updateAssignment("p", a.num, { state: "reported", report: report(`Report ${n}`), reportedAt: clock.now });
        db.prepare("INSERT INTO usage_turns (thread_id, turn_key, turn_id, started_at, completed_at, status) VALUES (?, 't1', 't1', 1, 2, 'completed')").run(`thr_${n}`);
        db.prepare("INSERT INTO usage_turn_cursors (thread_id, project_id, last_seq, first_observed_at, last_observed_at) VALUES (?, 'p', 1, 1, 2)").run(`thr_${n}`);
        store.associateNestedThread({ projectId: "p", threadId: `nested_${n}`, label: `Helper ${n}`, bbProjectId: "proj_a" });
      }
    });
  const live = () => new Map<string, LiveThread>(threadsToWatch(store, "p").map((id) => [id, { status: "idle", archived: false, title: id }]));
  return { store, db, clock, grow, live };
}

/** Statements one overview build prepares, and the reports it reads. */
function cost(store: Store, live: Map<string, LiveThread>, detail: OverviewDetail) {
  const prepare = vi.spyOn(store.db, "prepare");
  const reports = vi.spyOn(store, "reports");
  try {
    buildOverview(store, "p", live, store.now(), null, detail);
    return { queries: prepare.mock.calls.length, reports: reports.mock.calls.reduce((sum, [, nums]) => sum + nums.length, 0) };
  } finally {
    prepare.mockRestore();
    reports.mockRestore();
  }
}

describe("W492 overview cost", () => {
  it("builds every tier with the same number of queries however long the Initiative's history", () => {
    const { store, grow, live } = initiative();
    grow(2, "idle");
    grow(3);
    const small = (["summary", "history", "full"] as const).map((detail) => cost(store, live(), detail).queries);
    grow(200);
    expect((["summary", "history", "full"] as const).map((detail) => cost(store, live(), detail).queries)).toEqual(small);
  });

  it("decodes a retired worker's reports once per filing, and a new filing at once", () => {
    const { store, clock, grow, live } = initiative();
    grow(2, "idle");
    grow(50);
    // The first paint reads only the live workers' reports; history also each retired worker's latest, once.
    expect(cost(store, live(), "summary").reports).toBe(2);
    expect(cost(store, live(), "history").reports).toBe(2 + 52);
    expect(cost(store, live(), "history").reports).toBe(2);
    // A re-filed report of a retired worker is a new filing: the next build reads it, and shows it.
    clock.now += 1_000;
    store.updateAssignment("p", 10, { report: report("Filed again", "blocked"), reportedAt: clock.now });
    expect(cost(store, live(), "history").reports).toBe(3);
    const w10 = buildOverview(store, "p", live(), store.now(), null, "history").workers.retired.find((w) => w.ref === "W10")!;
    expect(w10.latestReport).toMatchObject({ ref: "A10", outcome: "blocked", summary: "Filed again", question: "Filed again?" });
  });

  it("keeps nothing from a filing it read inside a transaction that rolled back", () => {
    const { store, clock, grow, live } = initiative();
    grow(3);
    const latest = () => buildOverview(store, "p", live(), store.now(), null, "history").workers.retired.find((w) => w.ref === "W2")!.latestReport?.summary;
    expect(latest()).toBe("Report 1");
    expect(() => store.tx(() => {
      store.updateAssignment("p", 2, { report: report("Rolled back"), reportedAt: clock.now });
      expect(latest()).toBe("Rolled back");
      throw new Error("abort");
    })).toThrow("abort");
    expect(latest()).toBe("Report 1");
  });

  it("reads the dashboard's assignment facts from the covering index, never the rows' briefs and reports", () => {
    const { store } = initiative();
    const read = vi.spyOn(store.db, "prepare");
    store.assignmentsForOverview("p", true);
    const sql = read.mock.calls[0]![0];
    read.mockRestore();
    const plan = (store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("p") as { detail: string }[]).map((row) => row.detail).join("\n");
    expect(plan).toContain("COVERING INDEX assignments_overview");
  });
});
