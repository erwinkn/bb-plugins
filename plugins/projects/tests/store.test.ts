import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { MIGRATIONS, Store, StoreCorruptionError, parseRef } from "../lib/store";
import { DEFAULT_POLICY, DEFAULT_PROFILES } from "../lib/schema";
import { brief, memoryStore } from "./helpers";

describe("store", () => {
  it("numbers records per project with readable refs", () => {
    const { store } = memoryStore();
    store.createProject({
      id: "p1",
      name: "One",
      objective: "o",
      memberProjectIds: ["proj_a"],
      coordinatorThreadId: "thr_c",
    });
    store.createProject({
      id: "p2",
      name: "Two",
      objective: "o",
      memberProjectIds: ["proj_a"],
      coordinatorThreadId: null,
    });
    const base = {
      summary: "s",
      brief: brief(),
      priority: 2,
      dependsOn: [],
      workKind: "implementation" as const,
      profileOverride: null,
      profileSource: null,
    };
    expect(store.createTask({ projectId: "p1", title: "a", ...base }).ref).toBe(
      "T1",
    );
    expect(store.createTask({ projectId: "p1", title: "b", ...base }).ref).toBe(
      "T2",
    );
    expect(store.createTask({ projectId: "p2", title: "c", ...base }).ref).toBe(
      "T1",
    );
  });

  it("resolves membership for coordinators, workers, and former generations", () => {
    const { store } = memoryStore();
    store.createProject({
      id: "p1",
      name: "One",
      objective: "o",
      memberProjectIds: ["proj_a"],
      coordinatorThreadId: "thr_c1",
    });
    const worker = store.createWorker({
      projectId: "p1",
      role: "work",
      label: "API",
      area: "api",
      bbProjectId: "proj_a",
    });
    store.updateWorker("p1", worker.num, { threadId: "thr_w1", generation: 1 });
    store.openGeneration("p1", worker.num, 1, "thr_w1");
    expect(store.membership("thr_c1")).toMatchObject({
      workerNum: 0,
      former: false,
    });
    expect(store.membership("thr_w1")).toMatchObject({
      workerNum: 1,
      former: false,
    });
    store.setCoordinator("p1", "thr_c2", "replaced");
    expect(store.membership("thr_c1")).toMatchObject({
      workerNum: 0,
      former: true,
    });
    expect(store.membership("thr_c2")).toMatchObject({
      workerNum: 0,
      former: false,
    });
    expect(store.project("p1")!.coordinatorGeneration).toBe(2);
    expect(store.membership("thr_other")).toBeNull();
  });

  it("preserves legacy inbox/batch/message/lease rows as readable history", () => {
    const { store, db } = memoryStore();
    store.createProject({
      id: "p1",
      name: "One",
      objective: "o",
      memberProjectIds: [],
      coordinatorThreadId: "c",
    });
    // Rows written by the retired delivery controllers stay where they are.
    db.prepare(
      `INSERT INTO inbox (project_id, event_key, kind, priority, summary, payload, state, batch_id, created_at, delivered_at)
       VALUES ('p1','report:A1:1','report','normal','W1 reported','{}','delivered',3,100,200)`,
    ).run();
    db.prepare(
      `INSERT INTO batches (project_id, coordinator_thread_id, marker, text, mode, state, created_at, sent_at)
       VALUES ('p1','c','pb-1','batch text','start','sent',100,150)`,
    ).run();
    db.prepare(
      `INSERT INTO worker_messages (op_id, project_id, worker_num, generation, thread_id, assignment_num, kind, text, state, queued_id, created_at)
       VALUES ('opm1','p1',1,1,'thr_w1',1,'note','keep going','sent',NULL,110)`,
    ).run();
    db.prepare(
      `INSERT INTO leases (project_id, worker_num, thread_id, generation, fingerprint, state, reason, max_refreshes, refreshes, deadline, capability, created_at, ended_at, end_reason)
       VALUES ('p1',1,'thr_w1',1,'fp','ended','warm',2,1,9999,'{}',100,300,'done')`,
    ).run();
    const [event] = store.inbox("p1");
    expect(event).toMatchObject({
      eventKey: "report:A1:1",
      state: "delivered",
      summary: "W1 reported",
    });
    const count = (table: string, where = "") =>
      (db.prepare(`SELECT COUNT(*) n FROM ${table} ${where}`).get() as {
        n: number;
      }).n;
    expect(count("batches")).toBe(1);
    expect(count("worker_messages")).toBe(1);
    expect(count("leases")).toBe(1);
    // Nothing replays them: no pending rows are manufactured and no writer
    // methods exist for these tables anymore.
    expect(count("inbox", `WHERE state = 'pending'`)).toBe(0);
  });

  it("supersedes decisions by topic and keeps history", () => {
    const { store } = memoryStore();
    store.createProject({
      id: "p1",
      name: "One",
      objective: "o",
      memberProjectIds: [],
      coordinatorThreadId: "c",
    });
    const provenance = {
      author: "coordinator" as const,
      threadId: "c",
      assignment: null,
    };
    const first = store.addDecision({
      projectId: "p1",
      topic: "auth",
      status: "active",
      scope: "project",
      title: "v1",
      body: { title: "v1", outcome: "a", rationale: "user choice", humanAttention: "none", options: [], blocksTaskIds: [] },
      madeBy: "user",
      humanAttention: "none",
      blocks: [],
      deadline: null,
      provenance,
      supersedes: null,
    });
    const second = store.addDecision({
      projectId: "p1",
      topic: "auth",
      status: "active",
      scope: "project",
      title: "v2",
      body: { title: "v2", outcome: "b", rationale: "user choice", humanAttention: "none", options: [], blocksTaskIds: [] },
      madeBy: "user",
      humanAttention: "none",
      blocks: [],
      deadline: null,
      provenance,
      supersedes: first.num,
    });
    expect(second.version).toBe(2);
    expect(store.decisions("p1").map((item) => item.ref)).toEqual(["D2"]);
    expect(store.decisions("p1", { includeHistory: true })[0]!.status).toBe(
      "superseded",
    );
  });

  it("bounds the activity history", () => {
    const { store } = memoryStore();
    store.createProject({
      id: "p1",
      name: "One",
      objective: "o",
      memberProjectIds: [],
      coordinatorThreadId: "c",
    });
    for (let i = 0; i < 320; i++) store.log("p1", "k", `e${i}`);
    expect(store.activity("p1", 1000)).toHaveLength(300);
    expect(store.activity("p1", 1)[0]!.summary).toBe("e319");
  });

  it("fails loudly with context on corrupt persisted JSON", () => {
    const { store, db } = memoryStore();
    store.createProject({
      id: "p1",
      name: "One",
      objective: "o",
      memberProjectIds: ["proj_a"],
      coordinatorThreadId: "c",
    });
    db.prepare(
      `UPDATE projects SET member_project_ids = '{oops' WHERE id = 'p1'`,
    ).run();
    expect(() => store.project("p1")).toThrow(StoreCorruptionError);
    expect(() => store.project("p1")).toThrow(
      /projects\[p1\]\.member_project_ids: malformed JSON/,
    );
  });

  it("drops retired policy keys but still rejects malformed kept keys", () => {
    const { store, db } = memoryStore();
    store.createProject({
      id: "p1",
      name: "One",
      objective: "o",
      memberProjectIds: [],
      coordinatorThreadId: "c",
      policy: DEFAULT_POLICY,
    });
    // Historical blobs carrying removed engines normalize to profiles only.
    db.prepare(
      `UPDATE projects SET policy = '{"batching":{"quietMs":"soon"},"warming":{"enabled":true},"profiles":{"investigation":{"providerId":"codex","model":"gpt-6.1-sol","reasoningLevel":"high"}}}' WHERE id = 'p1'`,
    ).run();
    expect(store.project("p1")!.policy.profiles.investigation).toEqual({
      providerId: "codex",
      model: "gpt-6.1-sol",
      reasoningLevel: "high",
    });
    expect(store.project("p1")!.policy).not.toHaveProperty("batching");
    // A malformed value inside a retained key still fails loudly.
    db.prepare(
      `UPDATE projects SET policy = '{"profiles":{"coordinator":{"model":42}}}' WHERE id = 'p1'`,
    ).run();
    expect(() => store.project("p1")).toThrow(/projects\[p1\]\.policy/);
  });

  it("rejects a corrupt stored report", () => {
    const { store, db } = memoryStore();
    store.createProject({
      id: "p1",
      name: "One",
      objective: "o",
      memberProjectIds: [],
      coordinatorThreadId: "c",
    });
    const worker = store.createWorker({
      projectId: "p1",
      role: "work",
      label: "w",
      area: "a",
      bbProjectId: "proj_a",
    });
    store.createAssignment({
      projectId: "p1",
      workerNum: worker.num,
      taskNums: [1],
      route: "fresh",
      role: "work",
      workKind: "implementation",
      threadId: null,
      generation: 1,
      profile: {
        providerId: "codex",
        model: "gpt-6.1-sol",
        reasoningLevel: "high",
      },
      bbProjectId: "proj_a",
      environmentId: null,
      state: "running",
      opId: "op1",
      opState: "done",
      briefText: "b",
      reviewOf: null,
      rationale: null,
    });
    db.prepare(`UPDATE assignments SET report = '{"outcome":"done"}'`).run();
    expect(() => store.assignment("p1", 1)).toThrow(
      /assignments\[p1\/1\]\.report/,
    );
  });

  it("defaults, persists, and fails loudly on project context", () => {
    const { store, db } = memoryStore();
    store.createProject({
      id: "p1",
      name: "One",
      objective: "o",
      memberProjectIds: ["proj_a"],
      coordinatorThreadId: "c",
    });
    expect(store.project("p1")!.context).toEqual({
      vision: "",
      objectives: [],
      ideas: [],
    });
    store.updateProject("p1", {
      context: {
        vision: "v",
        objectives: ["ship it"],
        ideas: ["idea"],
      },
    });
    expect(store.project("p1")!.context).toEqual({
      vision: "v",
      objectives: ["ship it"],
      ideas: ["idea"],
    });
    db.prepare(
      `UPDATE projects SET context = '{"vision":42}' WHERE id = 'p1'`,
    ).run();
    expect(() => store.project("p1")).toThrow(StoreCorruptionError);
    expect(() => store.project("p1")).toThrow(/projects\[p1\]\.context/);
  });

  it("parses refs leniently but never accepts garbage", () => {
    expect(parseRef("T", "T12")).toBe(12);
    expect(parseRef("T", "t3")).toBe(3);
    expect(parseRef("T", "4")).toBe(4);
    expect(parseRef("T", "W4")).toBeNull();
    expect(parseRef("T", "T0")).toBeNull();
  });
});

describe("assignment access migration", () => {
  it("migrates legacy work conservatively and preserves read-only reviewer roles", () => {
    const db = new Database(":memory:");
    try {
      // Apply the frozen schema first, then seed actual rows without access.
      const firstNew = MIGRATIONS.findIndex((sql) => sql.includes("ADD COLUMN access"));
      expect(firstNew).toBeGreaterThanOrEqual(0);
      for (const statement of MIGRATIONS.slice(0, firstNew)) db.exec(statement);
      const insert = db.prepare(`INSERT INTO assignments
        (project_id, num, worker_num, task_nums, route, role, generation, profile,
         bb_project_id, state, op_id, op_state, brief_text, created_at, updated_at)
        VALUES ('p1', ?, ?, '[1]', 'fresh', ?, 1, ?, 'proj_a', ?, ?, ?, 'legacy audit brief', 1, 1)`);
      insert.run(1, 1, "work", JSON.stringify(DEFAULT_PROFILES.investigation), "queued", "op_legacy_work", "done");
      insert.run(2, 2, "work", JSON.stringify(DEFAULT_PROFILES.investigation), "cancelled", "op_legacy_uncertain", "uncertain");
      insert.run(3, 3, "review", JSON.stringify(DEFAULT_PROFILES.reviewOfGpt), "running", "op_legacy_review", "done");
      for (const statement of MIGRATIONS.slice(firstNew)) db.exec(statement);
      const reopened = new Store(db);
      expect(reopened.assignments("p1").map((a) => [a.role, a.state, a.opState, a.access])).toEqual([
        ["work", "queued", "done", "write"],
        ["work", "cancelled", "uncertain", "write"],
        ["review", "running", "done", "read-only"],
      ]);
      expect(db.prepare("SELECT access FROM assignments ORDER BY num").all()).toEqual([
        { access: "write" }, { access: "write" }, { access: "read-only" },
      ]);
      expect(() => db.prepare("UPDATE assignments SET access='inferred-audit' WHERE num=1").run()).toThrow(/CHECK constraint/);
    } finally {
      db.close();
    }
  });
});
