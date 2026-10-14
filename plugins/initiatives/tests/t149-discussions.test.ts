import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { projectFixture, report } from "./fake-native";
import { MIGRATIONS } from "../lib/store";
import { DISCUSSION_CAP } from "../lib/service";
import type { InitiativeTabs } from "../lib/contract";

/**
 * T149 (D446-D448, D480, D482, D483): an Initiative's coordinator and its discussions, which share
 * its memory. A discussion is a user thread the ledger marks as one (project_threads.discussion),
 * spawned with the memory's key; Chat memory attaches it from that key (its own tests,
 * chat-memory/tests/t149.test.ts). BB's archive state is never stored: it only changes the tabs.
 */
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const create = async (f: Fx, projectId: string) =>
  (await f.harness.callRpc("discussionCreate", { projectId })) as { threadId: string | null; note: string | null };
const tabs = async (f: Fx, threadId: string) => ((await f.harness.callRpc("panel", { threadId })) as { tabs: InitiativeTabs }).tabs;
const tools = async (f: Fx, threadId: string) =>
  (await f.harness.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: f.threads.get(threadId)! }))).tools.map((t) => t.name).sort();
const archive = (f: Fx, id: string) => f.threads.set(id, { ...f.threads.get(id)!, archivedAt: Date.now() });
const restore = (f: Fx, id: string) => f.threads.set(id, { ...f.threads.get(id)!, archivedAt: null });
/** `n` discussions the ledger already holds, each with its thread in BB: the history of a long-lived Initiative. */
const seed = (f: Fx, projectId: string, n: number, { archived }: { archived: boolean }) => f.store.tx(() => {
  for (let i = 0; i < n; i++) {
    const op = `seed-${archived ? "archived" : "open"}-${i}`;
    const id = `thread-${op}`;
    f.threads.set(id, makeThreadResponse({ id, createdAt: 1, projectId: "proj_a", environmentId: "env_a", parentThreadId: "coordinator", status: "idle", originPluginId: "initiatives", archivedAt: archived ? 1 : null }));
    f.store.openProjectThread({ projectId, opId: op, label: `Discussion ${i}`, bbProjectId: "proj_a", discussion: true });
    f.store.confirmProjectThread(op, id);
  }
});
/**
 * D480: a discussion is refused by every tool and `bb initiative` subcommand registered, today's and
 * any added later, except the reads, its message to the coordinator and PR notes.
 */
const refusesAllButReads = async (f: Fx, threadId: string) => {
  const refused = /A discussion only messages the coordinator and keeps PR notes/;
  const allowed = ["read", "zoom", "message", "pr"];
  const tools = f.harness.registrations.agentTools.map((t) => t.name)
    // A removed publisher, which refuses every caller.
    .filter((name) => name !== "project_knowledge" && !allowed.includes(name.replace(/^(initiative|project)_/, "")));
  expect(tools).toEqual(expect.arrayContaining(["initiative_create", "initiative_update", "initiative_decision", "initiative_report", "initiative_batch", "project_update"]));
  // project_report's parameters are checked before it runs: a valid payload reaches it.
  for (const tool of tools)
    await expect(f.harness.callAgentTool(tool, tool === "project_report" ? report() : {}, { threadId }), tool).rejects.toThrow(refused);
  const commands = f.harness.registrations.cli!.commands.map((c) => c.name).filter((name) => !["describe", "list", "overview", "read", "message"].includes(name));
  expect(commands).toEqual(["command", "pr", "report", "reconcile", "recreate-coordinators"]);
  for (const command of commands) {
    const cli = await f.harness.runCli(command === "recreate-coordinators" ? [command, "--all"] : [command, "{}"], { threadId });
    expect(cli.exitCode, command).toBe(1);
    expect(cli.stderr, command).toMatch(refused);
  }
};
/** Holds BB's list of open threads, the cap's one native read, until released. */
const holdOpenList = (f: Fx, holds: number) => {
  const held: (() => void)[] = [];
  f.intercept((path, args, call) => path === "threads.list" && args.originPluginId && held.length < holds
    ? new Promise((resolve) => held.push(() => resolve(call())))
    : call());
  return held;
};

describe("T149 a discussion starts where the coordinator runs, sharing its memory", () => {
  it("spawns under the coordinator with its settings, the memory's key and final-reports-only notices", async () => {
    const { f, project } = await projectFixture();
    f.execution.set("coordinator", { model: "claude-opus-5-5", reasoningLevel: "xhigh", permissionMode: "full", serviceTier: "fast" });
    const { threadId, note } = await create(f, project.id);
    expect(note).toBeNull();
    const args = f.spawn.mock.calls.at(-1)![0];
    expect(args).toMatchObject({
      projectId: "proj_a",
      environment: { type: "reuse", environmentId: "env_a" },
      providerId: f.threads.get("coordinator")!.providerId,
      model: "claude-opus-5-5",
      reasoningLevel: "xhigh",
      permissionMode: "full",
      serviceTier: "fast",
      parentThreadId: "coordinator",
      parentNotices: "explicit",
      title: "Chat 2",
      pluginMetadata: { role: "discussion", projectId: project.id, memoryScope: project.id },
    });
    // BB starts a thread only with a first message: a hidden one.
    expect(args.input).toEqual([expect.objectContaining({ type: "text", visibility: "agent-only" })]);
    expect(f.store.projectThreadByThreadId(threadId!)).toMatchObject({ discussion: true, state: "active", label: "Chat 2" });
    expect(f.store.membership(threadId!)).toMatchObject({ kind: "adhoc", discussion: true });
    expect(await f.harness.callRpc("membership", { threadId })).toMatchObject({ role: "discussion" });
    // The tabs: the coordinator, then the discussions oldest first, in both headers.
    const second = (await create(f, project.id)).threadId!;
    expect(f.spawn.mock.calls.at(-1)![0].title).toBe("Chat 3");
    const expected = { coordinatorThreadId: "coordinator", discussionThreadIds: [threadId, second] };
    expect(await tabs(f, "coordinator")).toEqual(expected);
    expect(await tabs(f, second)).toEqual(expected);
    // In the Threads sidebar it is a user thread of the Initiative.
    const tree = (await f.harness.callRpc("tree", null)) as { projects: { nodes: { threadId: string | null; role: string; label: string }[] }[] };
    expect(tree.projects[0]!.nodes).toContainEqual(expect.objectContaining({ threadId, role: "adhoc", label: "Chat 2" }));
  });

  it("gives workers no memory key, and plain user threads no discussion tabs", async () => {
    const { f, project } = await projectFixture();
    const [worker] = await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id).ref] });
    expect(f.metadata.get(worker.threadId!)).not.toHaveProperty("memoryScope");
    expect(await tabs(f, worker.threadId!)).toBeNull();
    expect(await tabs(f, "stranger")).toBeNull();
  });

  it("starts nothing, and says why, when BB has no settings for the coordinator yet", async () => {
    const { f, project } = await projectFixture();
    f.intercept((path, args, call) => (path === "threads.defaultExecutionOptions" ? null : call()));
    await expect(create(f, project.id)).rejects.toThrow(/where the coordinator runs/);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.store.projectThreads(project.id)).toEqual([]);
  });

  it("refuses, starting nothing, when the coordinator is replaced while BB is read (W382 finding 1)", async () => {
    const { f, project } = await projectFixture();
    f.execution.set("coordinator", { model: "claude-opus-5-5", reasoningLevel: "high", permissionMode: "full", serviceTier: "fast" });
    f.threads.set("codex", makeThreadResponse({ id: "codex", createdAt: 1, projectId: "proj_a", environmentId: "env_a", providerId: "codex", status: "idle" }));
    f.execution.set("codex", { model: "gpt-6.1-sol", reasoningLevel: "xhigh", permissionMode: "auto", serviceTier: "priority" });
    f.idle("coordinator");
    const held = holdOpenList(f, 1);
    const started = create(f, project.id);
    await vi.waitFor(() => expect(held).toHaveLength(1));
    await f.perform(project.id, { action: "replace-coordinator", reason: "Codex takes over", adoptThreadId: "codex" }, "user", null);
    expect(f.store.project(project.id)!.coordinatorThreadId).toBe("codex");
    held[0]!();
    await expect(started).rejects.toThrow("The coordinator changed while the discussion was starting");
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.store.projectThreads(project.id)).toEqual([]);
    // Pressed again, it starts with the new coordinator and its settings.
    await create(f, project.id);
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.spawn.mock.calls[0]![0]).toMatchObject({ parentThreadId: "codex", providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "xhigh", permissionMode: "auto", serviceTier: "priority" });
  });

  it("refuses, starting nothing, when a handover lands while the spawn reads its parent (W384 finding 1)", async () => {
    const { f, project } = await projectFixture();
    f.execution.set("coordinator", { model: "claude-opus-5-5", reasoningLevel: "high", permissionMode: "full", serviceTier: "fast" });
    const handover = { action: "coordinator-handover", reason: "Fresh context", profile: { providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "xhigh" } };
    expect((await f.harness.runCli(["command", JSON.stringify(handover), project.id], { threadId: "coordinator" })).exitCode).toBe(0);
    f.idle("coordinator");
    // The spawn's own read of its parent (the create's second read of the coordinator) answers
    // with what BB said before the handover, once the handover has landed.
    let reads = 0;
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const held: unknown[] = [];
    f.intercept((path, args, call) => {
      if (path !== "threads.get" || args.threadId !== "coordinator" || ++reads !== 2) return call();
      return Promise.resolve(call()).then(async (answer) => { held.push(answer); await released; return answer; });
    });
    const started = create(f, project.id);
    await vi.waitFor(() => expect(held).toHaveLength(1));
    // Runtime handovers run outside the writes queue, which the create holds.
    await f.service.drainHandover(project.id);
    const successor = f.store.project(project.id)!.coordinatorThreadId!;
    expect(successor).not.toBe("coordinator");
    const spawned = f.spawn.mock.calls.length;
    release();
    await expect(started).rejects.toThrow("The coordinator changed while the discussion was starting");
    expect(f.spawn).toHaveBeenCalledTimes(spawned);
    expect(f.store.projectThreads(project.id)).toEqual([]);
    f.intercept();
    // Pressed again, it starts under the new coordinator, with its provider.
    await create(f, project.id);
    expect(f.spawn.mock.calls.at(-1)![0]).toMatchObject({ parentThreadId: successor, providerId: "codex", title: "Chat 2" });
  });
});

describe("T149 the cap counts open discussions, only when one starts (D483)", () => {
  it("refuses the 63rd open one; archived and deleted ones don't count; a restore is never refused", async () => {
    const { f, project } = await projectFixture();
    const ids: string[] = [];
    for (let i = 0; i < DISCUSSION_CAP; i++) ids.push((await create(f, project.id)).threadId!);
    await expect(create(f, project.id)).rejects.toThrow(`Search has ${DISCUSSION_CAP} open discussions, the most it starts`);
    expect(f.spawn).toHaveBeenCalledTimes(DISCUSSION_CAP);
    // An archived one frees a place, a deleted one too (BB says so, or no longer has it).
    archive(f, ids[0]!);
    const next = (await create(f, project.id)).threadId!;
    f.threads.set(ids[1]!, { ...f.threads.get(ids[1]!)!, deletedAt: Date.now() });
    await create(f, project.id);
    f.intercept((path, args, call) => path === "threads.list" ? (call() as Promise<{ id: string }[]>).then((rows) => rows.filter((row) => row.id !== ids[2])) : call());
    await create(f, project.id);
    // Restoring the archived one is BB's alone: nothing here refuses it, and it is back in the tabs' list.
    restore(f, ids[0]!);
    expect((await tabs(f, "coordinator"))!.discussionThreadIds).toContain(ids[0]);
    await expect(create(f, project.id)).rejects.toThrow(`Search has ${DISCUSSION_CAP + 1} open discussions`);
    expect((await tabs(f, next))!.discussionThreadIds).toHaveLength(DISCUSSION_CAP + 3);
  });
});

describe("T149 the cap reads BB once, outside the writes (W380 finding 1)", () => {
  it("lists BB's open threads once per create, never once per archived discussion", async () => {
    const { f, project } = await projectFixture();
    seed(f, project.id, 1000, { archived: true });
    const calls: { path: string; args: any }[] = [];
    f.intercept((path, args, call) => { calls.push({ path, args }); return call(); });
    await create(f, project.id);
    await create(f, project.id);
    const reads = (path: string) => calls.filter((c) => c.path === path);
    // The coordinator, read when the create starts and again just before its spawn.
    expect(reads("threads.get").map((c) => c.args.threadId)).toEqual(["coordinator", "coordinator", "coordinator", "coordinator"]);
    expect(reads("threads.list")).toEqual([
      { path: "threads.list", args: { originPluginId: "initiatives", archived: false, includeHidden: true, limit: 200, offset: 0 } },
      { path: "threads.list", args: { originPluginId: "initiatives", archived: false, includeHidden: true, limit: 200, offset: 0 } },
    ]);
  });

  it("a slow list holds no other write: a task is created meanwhile", async () => {
    const { f, project } = await projectFixture();
    const held = holdOpenList(f, 1);
    const started = create(f, project.id);
    await vi.waitFor(() => expect(held).toHaveLength(1));
    const tasks = f.store.tasks(project.id).length;
    await f.harness.callAgentTool("initiative_task", { action: "create", title: "Rank by recency" }, { threadId: "coordinator" });
    expect(f.store.tasks(project.id)).toHaveLength(tasks + 1);
    expect(f.spawn).not.toHaveBeenCalled();
    held[0]!();
    expect((await started).threadId).toBeTruthy();
  });

  it("two creates at 61 open discussions start one, even when both read BB before either counts", async () => {
    const { f, project } = await projectFixture();
    seed(f, project.id, DISCUSSION_CAP - 1, { archived: false });
    const held = holdOpenList(f, 2);
    const both = Promise.allSettled([create(f, project.id), create(f, project.id)]);
    await vi.waitFor(() => expect(held).toHaveLength(2));
    held.forEach((release) => release());
    const [first, second] = await both;
    expect(first).toMatchObject({ status: "fulfilled" });
    expect(second).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: expect.stringContaining(`Search has ${DISCUSSION_CAP} open discussions`) }) });
    expect(f.spawn).toHaveBeenCalledTimes(1);
  });

  it("counts discussions still starting and those whose start is uncertain", async () => {
    const { f, project } = await projectFixture();
    seed(f, project.id, DISCUSSION_CAP - 2, { archived: false });
    for (const op of ["pending", "uncertain"])
      f.store.openProjectThread({ projectId: project.id, opId: op, label: op, bbProjectId: "proj_a", discussion: true });
    f.store.markProjectThread("uncertain", "uncertain");
    await expect(create(f, project.id)).rejects.toThrow(`Search has ${DISCUSSION_CAP} open discussions`);
    // A failed start never opened a thread, and frees its place.
    f.store.markProjectThread("pending", "failed");
    expect((await create(f, project.id)).threadId).toBeTruthy();
  });
});

const LEAD_TOOLS = ["initiative_batch", "initiative_manage", "initiative_message", "initiative_pr", "initiative_question", "initiative_read",
  "initiative_rule", "initiative_spawn", "initiative_task", "initiative_update", "initiative_worker"];

describe("T149 archive and restore change only the tabs (D482, D483)", () => {
  it("an archived discussion stays a discussion of the Initiative, with its tools and its memory key", async () => {
    const { f, project } = await projectFixture();
    const id = (await create(f, project.id)).threadId!;
    const before = await tabs(f, "coordinator");
    archive(f, id);
    expect(await tabs(f, "coordinator")).toEqual(before);
    expect(await tabs(f, id)).toEqual(before);
    expect(f.store.membership(id)).toMatchObject({ discussion: true });
    expect(f.metadata.get(id)).toMatchObject({ memoryScope: project.id });
    restore(f, id);
    expect(await tools(f, id)).toEqual(LEAD_TOOLS);
  });
});

describe("T149, v9: a discussion is a lead tab like the coordinator's", () => {
  it("has the lead tools and guidance, and its instructions say it is a lead", async () => {
    const { f, project } = await projectFixture();
    const id = (await create(f, project.id)).threadId!;
    const config = await f.harness.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: f.threads.get(id)! }));
    expect(config.tools.map((t) => t.name).sort()).toEqual(LEAD_TOOLS);
    expect(config.instructions).toContain('This tab is a lead of the "Search" Initiative');
    expect(config.instructions).toContain("You lead this Initiative for the user");
    expect(JSON.parse((await f.harness.callAgentTool("initiative_read", {}, { threadId: id })) as string)).toBeTruthy();
  });

  it("gives out work whose reports and messages come back to it", async () => {
    const { f, project } = await projectFixture();
    const id = (await create(f, project.id)).threadId!;
    f.threads.set(id, { ...f.threads.get(id)!, title: "Search ranking", status: "idle" });
    const [w] = JSON.parse((await f.harness.callAgentTool("initiative_spawn", { label: "Rank", purpose: "ranking", text: "Rank it." }, { threadId: id })) as string);
    expect(f.store.assignment(project.id, 1)).toMatchObject({ replyTo: id });
    f.send.mockClear();
    await f.harness.callAgentTool("initiative_message", { to: "lead", text: "Which TTL?" }, { threadId: w.threadId });
    expect(f.send.mock.calls[0]![0]).toMatchObject({ threadId: id, senderThreadId: w.threadId });
    await f.harness.callAgentTool("initiative_report", { outcome: "done", summary: "Ranked.", report: "Ranked." }, { threadId: w.threadId });
    expect(f.send.mock.calls[1]![0]).toMatchObject({ threadId: id, senderThreadId: w.threadId, mode: "queue-if-active" });
    // The coordinator tab is still one message away, named by the tab's title.
    await f.harness.callAgentTool("initiative_message", { to: "coordinator", text: "Erwin wants the 5m TTL." }, { threadId: id });
    expect(f.send.mock.calls[2]![0]).toMatchObject({ threadId: "coordinator", senderThreadId: id });
    expect(f.send.mock.calls[2]![0].input[0].text).toContain('From lead tab "Search ranking"');
  });

  it("an archived discussion hands its workers back to the coordinator tab", async () => {
    const { f, project } = await projectFixture();
    const id = (await create(f, project.id)).threadId!;
    const [w] = JSON.parse((await f.harness.callAgentTool("initiative_spawn", { label: "Rank", purpose: "ranking", text: "Rank it." }, { threadId: id })) as string);
    archive(f, id);
    f.send.mockClear();
    await f.harness.callAgentTool("initiative_report", { outcome: "done", summary: "Ranked.", report: "Ranked." }, { threadId: w.threadId });
    expect(f.send.mock.calls[0]![0]).toMatchObject({ threadId: "coordinator" });
  });

  it("keeps PR records like the coordinator", async () => {
    const { f, project } = await projectFixture();
    const id = (await create(f, project.id)).threadId!;
    const url = "https://github.com/erwinkn/bb/pull/12";
    const call = async (input: unknown, threadId = id) => JSON.parse((await f.harness.callAgentTool("initiative_pr", input, { threadId })) as string);
    await call({ prs: [{ url, notes: [{ kind: "question", text: "Keep the 5m TTL?" }] }] }, "coordinator");
    await call({ prs: [{ url, stage: "in-review", notes: [{ text: "Erwin: yes, 5m." }], answered: [{ n: 1, text: "Yes" }] }] });
    expect(f.store.prRecords(project.id).get(url)).toMatchObject({ stage: "in-review" });
    expect(f.service.prNotes.list(project.id, url).map((n) => n.author)).toEqual(["coordinator", "lead"]);
  });

  it("recreates no coordinator; a terminal or the coordinator does", async () => {
    const { f, project } = await projectFixture();
    const id = (await create(f, project.id)).threadId!;
    const fromDiscussion = await f.harness.runCli(["recreate-coordinators", "--all", "--wait=0"], { threadId: id });
    expect(fromDiscussion.exitCode).toBe(1);
    expect(fromDiscussion.stderr).toMatch(/from a terminal or from a coordinator thread/);
    expect((await f.harness.runCli(["recreate-coordinators", project.id, "--dry-run"])).exitCode).toBe(0);
  });

  it("can't be adopted as a worker; adopted as coordinator it leaves the tabs and keeps the memory", async () => {
    const { f, project } = await projectFixture();
    const id = (await create(f, project.id)).threadId!;
    await expect(f.service.adoptWorker(project.id, { threadId: id, role: "work", label: "x" })).rejects.toThrow("Discussions can't become workers: spawn a worker instead.");
    expect(f.store.workers(project.id)).toEqual([]);
    f.threads.set("coordinator", { ...f.threads.get("coordinator")!, status: "idle" });
    f.threads.set(id, { ...f.threads.get(id)!, status: "idle" });
    await f.service.replaceCoordinator(project.id, { adoptThreadId: id, reason: "take over" });
    expect(f.store.membership(id)).toMatchObject({ kind: "coordinator" });
    expect(await tabs(f, id)).toEqual({ coordinatorThreadId: id, discussionThreadIds: [] });
    expect(f.metadata.get(id)).toMatchObject({ role: "coordinator", memoryScope: project.id });
  });
});

describe("T149 D448: pr_records loses discussion_thread_id, and nothing else", () => {
  const before = MIGRATIONS.findIndex((sql) => sql.includes("ADD COLUMN discussion INTEGER"));
  const columns = (db: Database.Database, table: string) => (db.prepare(`SELECT name FROM pragma_table_info('${table}')`).pluck().all() as string[]);

  it("keeps every other field of every PR record and every user thread, through the SDK's runner", () => {
    expect(MIGRATIONS.slice(before, before + 2)).toEqual([
      "ALTER TABLE project_threads ADD COLUMN discussion INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE pr_records DROP COLUMN discussion_thread_id",
    ]);
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

  // A read-only copy of Erwin's live database (never the live file): INITIATIVES_DB_COPY=<copy> npx vitest run t149
  const copy = process.env.INITIATIVES_DB_COPY;
  it.runIf(!!copy && existsSync(copy))("migrates a copy of the live database, keeping every PR record and user thread", () => {
    const db = new Database(copy!);
    const count = (table: string) => Number(db.prepare(`SELECT count(*) FROM ${table}`).pluck().get());
    const tables = ["pr_records", "pr_notes", "pr_stage_changes", "project_threads", "projects", "workers", "assignments"];
    const counts = Object.fromEntries(tables.map((t) => [t, count(t)]));
    const keep = columns(db, "pr_records").filter((c) => c !== "discussion_thread_id").join(", ");
    const prs = db.prepare(`SELECT ${keep} FROM pr_records ORDER BY project_id, url`).all();
    expect(Number(db.prepare("SELECT count(discussion_thread_id) FROM pr_records").pluck().get())).toBe(0);
    createFakePluginHost().bb.storage.migrate(db, MIGRATIONS);
    expect(columns(db, "pr_records")).not.toContain("discussion_thread_id");
    expect(db.prepare(`SELECT * FROM pr_records ORDER BY project_id, url`).all()).toEqual(prs);
    expect(Object.fromEntries(tables.map((t) => [t, count(t)]))).toEqual(counts);
    expect(Number(db.prepare("SELECT count(*) FROM project_threads WHERE discussion = 1").pluck().get())).toBe(0);
    db.close();
  });
});
