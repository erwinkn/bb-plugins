import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createFakePluginHost, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { legacyDiscussion, projectFixture } from "./fake-native";
import { MIGRATIONS, Store } from "../lib/store";
import { queueTargets } from "../lib/not-delivered";

/**
 * W501 (R3, R6): Discussion tabs are gone. Nothing creates a discussion any more, and a thread the
 * previous build started as one is an ordinary user thread of its Initiative. Its ledger flag
 * (project_threads.discussion) stays, so rolling back needs no restore.
 */
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
/** BB configures a thread with the metadata its spawn carried, from the plugin that spawned it. */
const configure = (f: Fx, threadId: string) =>
  f.harness.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: f.threads.get(threadId)!,
    pluginMetadata: (f.metadata.get(threadId) ?? {}) as never, origin: { kind: "plugin", pluginId: "initiatives" } as never }));
const tool = async (f: Fx, name: string, input: unknown, threadId = "coordinator") =>
  JSON.parse((await f.harness.callAgentTool(name, input, { threadId })) as string);

describe("W501 nothing opens or lists a discussion", () => {
  it("the create RPC is gone and starts nothing; the panel carries no tabs", async () => {
    const { f, project } = await projectFixture();
    f.spawn.mockClear();
    await expect(f.harness.callRpc("discussionCreate", { projectId: project.id })).rejects.toThrow(/no rpc method "discussionCreate"/);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.store.projectThreads(project.id)).toEqual([]);
    const panel = (await f.harness.callRpc("panel", { threadId: "coordinator" })) as Record<string, unknown>;
    expect(Object.keys(panel).sort()).toEqual(["membership", "summary"]);
    expect(panel.membership).toMatchObject({ projectId: project.id, role: "coordinator", former: false });
  });

  it("the overview names no lead per worker and no lead tabs", async () => {
    const { f, project } = await projectFixture();
    legacyDiscussion(f, project.id);
    await tool(f, "initiative_spawn", { label: "Fix", purpose: "fix", text: "Fix it." });
    const overview = (await f.harness.callRpc("overview", { projectId: project.id })) as { workers: { current: Record<string, unknown>[] } } & Record<string, unknown>;
    expect(overview).not.toHaveProperty("leadTabs");
    expect(overview.workers.current).toHaveLength(1);
    expect(overview.workers.current[0]).not.toHaveProperty("lead");
  });
});

describe("W501 a former discussion is an ordinary user thread", () => {
  it("reads as adhoc and gets the user thread's tools, not the coordinator's", async () => {
    const { f, project } = await projectFixture();
    const chat = legacyDiscussion(f, project.id);
    expect(await f.harness.callRpc("membership", { threadId: chat })).toMatchObject({ projectId: project.id, role: "adhoc", former: false });
    const config = await configure(f, chat);
    expect(config.tools.map((t) => t.name).sort()).toEqual(["initiative_read", "initiative_update"]);
    expect(config.skills).toEqual([]);
    expect(config.instructions).toMatch(/user's own thread/);
    const coordinator = await configure(f, "coordinator");
    expect(coordinator.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["initiative_spawn", "initiative_message", "initiative_rule", "initiative_manage"]));
    expect(coordinator.skills).toEqual([expect.stringContaining("initiative-coordinator")]);
  });

  it("can't spawn, message, keep PR records, ask, set rules or manage work from its CLI", async () => {
    const { f, project } = await projectFixture();
    const chat = legacyDiscussion(f, project.id);
    await tool(f, "initiative_spawn", { label: "Fix", purpose: "fix", text: "Fix it." });
    f.spawn.mockClear();
    f.send.mockClear();
    await expect(tool(f, "initiative_spawn", { label: "Fix", purpose: "fix", text: "Fix it." }, chat)).rejects.toThrow();
    await expect(tool(f, "initiative_message", { to: "W1", text: "Hi." }, chat)).rejects.toThrow(/user-owned threads cannot use this wrapper/);
    await expect(tool(f, "initiative_pr", { prs: [{ url: "https://github.com/o/r/pull/1", stage: "in-review" }] }, chat)).rejects.toThrow();
    await expect(tool(f, "initiative_question", { question: "Pages?", context: "Both work." }, chat)).rejects.toThrow();
    await expect(tool(f, "initiative_rule", { action: "add", text: "Every PR targets dev." }, chat)).rejects.toThrow();
    const cli = await f.harness.runCli(["command", JSON.stringify({ action: "task-create", title: "T" }), project.id], { threadId: chat });
    expect(cli.exitCode).toBe(1);
    expect(cli.stderr).toMatch(/Only the coordinator manages work from an agent CLI/);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.store.prRecords(project.id).size).toBe(0);
    expect(f.store.rules(project.id)).toEqual([]);
  });

  it("is listed in the tree as a plain member thread, and its held messages aren't watched", async () => {
    const { f, project } = await projectFixture();
    const chat = legacyDiscussion(f, project.id);
    const tree = (await f.harness.callRpc("tree", null)) as { projects: { nodes: Record<string, unknown>[] }[] };
    const node = tree.projects[0]!.nodes.find((n) => n.threadId === chat)!;
    expect(node).toMatchObject({ role: "adhoc", state: "member" });
    expect(node).not.toHaveProperty("discussion");
    expect([...queueTargets(f.store, project.id).keys()]).toEqual(["coordinator"]);
  });

  it("can be adopted as a worker like any user thread", async () => {
    const { f, project } = await projectFixture();
    const chat = legacyDiscussion(f, project.id);
    await f.service.adoptWorker(project.id, { threadId: chat, role: "work", label: "Audit" });
    expect(f.store.membership(chat)).toMatchObject({ kind: "worker", workerNum: 1 });
  });

  it("a discussion spawn in flight at the upgrade is confirmed as a user thread", async () => {
    const { f, project } = await projectFixture();
    f.threads.set("late", { ...f.threads.get("coordinator")!, id: "late", parentThreadId: "coordinator", status: "idle" });
    f.metadata.set("late", { role: "discussion", projectId: project.id, op: "op_late", v: 1, memoryScope: project.id });
    f.store.db.prepare(`INSERT INTO project_threads (project_id, op_id, label, bb_project_id, state, discussion, created_at)
      VALUES (?, 'op_late', 'Chat 2', 'proj_a', 'pending', 1, 1)`).run(project.id);
    const config = await configure(f, "late");
    expect(f.store.projectThreadByOp("op_late")).toMatchObject({ threadId: "late", state: "active" });
    expect(f.store.membership("late")).toMatchObject({ kind: "adhoc", workerNum: -1 });
    expect(config.tools.map((t) => t.name).sort()).toEqual(["initiative_read", "initiative_update"]);
  });
});

describe("W501 the coordinator stays every worker's lead, through a handover", () => {
  it("a successor gets the coordinator's tools; reports and rule changes reach it, never a former discussion", async () => {
    const { f, project } = await projectFixture();
    const chat = legacyDiscussion(f, project.id);
    const [w] = await tool(f, "initiative_spawn", { label: "Fix", purpose: "fix", text: "Fix it." });
    f.threads.set("coordinator", { ...f.threads.get("coordinator")!, status: "idle" });
    f.threads.set("next", { ...f.threads.get("coordinator")!, id: "next", parentThreadId: null, status: "idle" });
    await f.service.replaceCoordinator(project.id, { adoptThreadId: "next", reason: "Switch model" });
    expect(f.store.project(project.id)!.coordinatorThreadId).toBe("next");
    expect(f.store.membership("coordinator")).toMatchObject({ kind: "coordinator", former: true });
    expect((await configure(f, "next")).tools.map((t) => t.name)).toEqual(expect.arrayContaining(["initiative_spawn", "initiative_rule"]));
    // The former discussion is still the user's own thread of the Initiative.
    expect(f.store.membership(chat)).toMatchObject({ kind: "adhoc" });
    f.send.mockClear();
    await f.perform(project.id, { action: "rule-add", text: "Every PR targets dev." }, "user", null);
    const report = await tool(f, "initiative_report", { outcome: "done", summary: "Fixed.", report: "Fixed." }, w.threadId);
    expect(report.note).toBe("Report recorded and sent to the coordinator.");
    expect(f.send.mock.calls.map(([a]) => a.threadId)).toEqual(["next", w.threadId, "next"]);
  });
});

describe("W501 a report notice the previous build sent to a discussion", () => {
  it("is sent again to the coordinator, even while the former discussion is open and busy", async () => {
    const { f, project } = await projectFixture();
    const chat = legacyDiscussion(f, project.id);
    f.threads.set(chat, { ...f.threads.get(chat)!, status: "active" });
    const [w] = await tool(f, "initiative_spawn", { label: "Fix", purpose: "fix", text: "Fix it." });
    await tool(f, "initiative_report", { outcome: "done", summary: "Fixed.", report: "Fixed." }, w.threadId);
    // The previous build addressed it to the discussion, which never recorded the turn.
    f.store.db.prepare("UPDATE report_notices SET lead_thread_id = ?, sent_at = sent_at - 60000, started_at = started_at - 60000").run(chat);
    f.send.mockClear();
    await f.service.redeliverReports();
    expect(f.send.mock.calls.map(([a]) => a.threadId)).toEqual(["coordinator"]);
    expect(f.store.reportNotice(project.id, 1)).toMatchObject({ leadThreadId: "coordinator", attempts: 2 });
  });
});

describe("W501 the ledger keeps the discussion column (additive only)", () => {
  const before = MIGRATIONS.findIndex((sql) => sql.includes("ADD COLUMN discussion INTEGER"));
  const columns = (db: Database.Database, table: string) => (db.prepare(`SELECT name FROM pragma_table_info('${table}')`).pluck().all() as string[]);

  it("still migrates project_threads.discussion in, and new user threads leave it 0", async () => {
    expect(MIGRATIONS.slice(before, before + 2)).toEqual([
      "ALTER TABLE project_threads ADD COLUMN discussion INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE pr_records DROP COLUMN discussion_thread_id",
    ]);
    const { f, project } = await projectFixture();
    expect(columns(f.store.db, "project_threads")).toContain("discussion");
    const own = (await f.perform(project.id, { action: "thread-create", title: "Mine", request: {
      projectId: "proj_a", providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high", permissionMode: "full",
      executionInputSources: {}, environment: { type: "project-default" }, input: [{ type: "text", text: "hi" }] } as never }, "user", null)) as { threadId: string };
    expect(f.store.db.prepare("SELECT discussion FROM project_threads WHERE thread_id = ?").pluck().get(own.threadId)).toBe(0);
    expect(f.metadata.get(own.threadId)).toMatchObject({ role: "adhoc" });
    expect(f.metadata.get(own.threadId)).not.toHaveProperty("memoryScope");
  });

  // T149 (D448), kept: the migration that added the column dropped nothing else.
  it("keeps every other field of every PR record and every user thread, through the SDK's runner", () => {
    const host = createFakePluginHost();
    const db = host.bb.storage.database();
    host.bb.storage.migrate(db, MIGRATIONS.slice(0, before));
    db.prepare(`INSERT INTO pr_records (project_id, url, stage, note, stage_set_at, category, waiting_on, changes, decision, worker, assignment, discussion_thread_id, updated_at)
      VALUES ('p', 'u', 'in-review', 'n', 1, 'Search', 'W1', '["x"]', '{"text":"t","at":1}', 'W1', 'A1', NULL, 2)`).run();
    db.prepare(`INSERT INTO project_threads (project_id, op_id, thread_id, label, bb_project_id, state, created_at) VALUES ('p', 'op', 't', 'Notes', 'proj_a', 'active', 1)`).run();
    const prs = db.prepare("SELECT * FROM pr_records").all() as Record<string, unknown>[];
    host.bb.storage.migrate(db, MIGRATIONS);
    expect(columns(db, "pr_records")).not.toContain("discussion_thread_id");
    expect(db.prepare("SELECT * FROM pr_records").all()).toEqual(prs.map(({ discussion_thread_id: _, ...rest }) => rest));
    expect(db.prepare("SELECT * FROM project_threads").get()).toMatchObject({ thread_id: "t", label: "Notes", discussion: 0 });
  });

  // A read-only copy of Erwin's live database (never the live file): INITIATIVES_DB_COPY=<copy> npx vitest run w501
  const copy = process.env.INITIATIVES_DB_COPY;
  it.runIf(!!copy && existsSync(copy))("migrates a copy of the live database and decodes its former discussions as user threads", () => {
    const db = new Database(copy!);
    createFakePluginHost().bb.storage.migrate(db, MIGRATIONS);
    const store = new Store(db);
    const rows = db.prepare("SELECT project_id, thread_id FROM project_threads WHERE discussion = 1 AND thread_id IS NOT NULL").all() as { project_id: string; thread_id: string }[];
    for (const row of rows) {
      expect(store.projectThreads(row.project_id).some((t) => t.threadId === row.thread_id)).toBe(true);
      expect(store.membership(row.thread_id, true)?.kind ?? "none").toMatch(/^(adhoc|coordinator)$/);
    }
    db.close();
  });
});
