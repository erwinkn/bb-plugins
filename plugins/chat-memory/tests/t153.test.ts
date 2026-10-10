import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { UNAVAILABLE, type EventRow, type LogEntry } from "../lib/log";
import { TURN_CONTEXT_TOOL } from "../lib/memory";
import { MIGRATIONS, MemoryStore } from "../lib/store";
import plugin from "../server";
import { fakeLuna, fixture, stuckLuna, type Fixture } from "./fixture";

/**
 * T153 (D487, D491): one row per thread (the scope it writes to now, the cursor of its BB events);
 * a thread's completed turns are copied into the scope its row names when the copy commits. Which
 * memory a turn "used" is not tracked: a thread moved mid-turn lands that whole turn in the new one.
 */

const fresh = (answer: unknown) => answer as { session: "fresh"; sessionId: string; systemPrompt: string; input: string };
const tools = async (f: Fixture, threadId: string, options?: Parameters<Fixture["configureAgent"]>[1]) => (await f.configureAgent(threadId, options)).tools.map((t) => t.name).sort();
const P = "initiatives:prj_1";

/** A coordinator of Initiative prj_1, in `mode`. */
async function initiative(mode: "regular" | "optchat" = "regular") {
  const f = fixture();
  await f.attach("initiatives", "prj_1", f.thread("coord", { title: "Coordinator" }));
  if (mode !== "regular") await f.configure("coord", { mode });
  return f;
}

describe("T153 copy: idempotent whatever the triggers", () => {
  it("copies a turn once however many triggers announce it: idle twice, failed, archived, sweeps", async () => {
    const f = await initiative();
    f.turn("coord", "hello");
    await f.idle("coord");
    await f.idle("coord");
    await f.failed("coord");
    await f.memory.sweep(true);
    await f.memory.sweep(false);
    await f.memory.settled();
    expect(f.log(P)).toEqual(["user: hello", "agent: re: hello"]);
    expect(f.store.thread("coord")!.cursor).toBe(f.history.at(-1)!.seq);
  });

  it("catches a turn whose idle BB never announced at the next sweep, and never reads a thread with nothing new", async () => {
    const f = await initiative();
    f.turn("coord", "unannounced");
    await f.memory.sweep(true);
    await f.memory.settled();
    expect(f.log(P)).toEqual(["user: unannounced", "agent: re: unannounced"]);
    // Nothing new: one probe of its newest turn/completed, no page read.
    f.reads.length = 0;
    await f.memory.sweep(true);
    expect(f.reads).toEqual([expect.objectContaining({ threadId: "coord", types: ["turn/completed"] })]);
  });

  it("never logs a turn in progress, from an idle, a failure or the sweep", async () => {
    const f = await initiative();
    f.turn("coord", "one");
    f.say("coord", "two");
    f.reply("coord", "working on two…");
    await f.idle("coord");
    await f.memory.sweep(true);
    await f.memory.settled();
    expect(f.log(P)).toEqual(["user: one", "agent: re: one"]);
    f.done("coord");
    await f.failed("coord");
    expect(f.log(P).slice(2)).toEqual(["user: two", "agent: working on two…"]);
  });

  it("drops the request of a turn that failed for want of its memory (D502), and logs the message sent again once", async () => {
    const f = await initiative();
    f.say("coord", "deploy it");
    f.providerError("coord", `Claude Code could not get the turn's memory context: Tool "claude_code_turn_context" failed: ${UNAVAILABLE}: message 7 could not be summarized (empty reply); it is tried again within 30 minutes. The message was not sent; send it again, or switch this thread's memory mode.`);
    f.done("coord", "failed");
    await f.failed("coord");
    expect(f.log(P)).toEqual([]);
    // The user sends it again.
    f.turn("coord", "deploy it", "Deployed.");
    await f.idle("coord");
    expect(f.log(P)).toEqual(["user: deploy it", "agent: Deployed."]);
    // A failed turn that said something is logged whole.
    f.say("coord", "and the docs");
    f.reply("coord", "Half done");
    f.done("coord", "failed");
    await f.failed("coord");
    expect(f.log(P).slice(2)).toEqual(["user: and the docs", "agent: Half done"]);
  });

  it("keeps the question of a turn the provider failed silently, so BB's \"Please continue.\" has it in memory (D502)", async () => {
    const f = await initiative("optchat");
    const question = "Which database should we use for the billing service?";
    const original = f.say("coord", question);
    f.providerError("coord", "API Error: 429 rate_limit_error: This request would exceed your account's rate limit.");
    f.done("coord", "failed");
    await f.failed("coord");
    expect(f.log(P)).toEqual([`user: ${question}`]);
    // BB's automatic retry of an accepted input: a continuation nudge, never logged itself.
    const retry = f.say("coord", "Please continue.", { retryOfRequestId: original, retryAttempt: 1 });
    const answer = fresh(await f.ask("coord", retry, "Please continue."));
    expect(`${answer.systemPrompt}\n${answer.input}`).toContain(question);
    f.reply("coord", "Postgres.");
    f.done("coord");
    await f.idle("coord");
    expect(f.log(P)).toEqual([`user: ${question}`, "agent: Postgres."]);
  });

  it("logs once a request BB re-sends verbatim after a failure before the provider accepted it", async () => {
    const f = await initiative();
    const original = f.say("coord", "ship it");
    f.providerError("coord", "Claude session closed before the turn started");
    f.done("coord", "failed");
    await f.failed("coord");
    f.say("coord", "ship it", { retryOfRequestId: original, retryAttempt: 1 });
    f.reply("coord", "Shipped.");
    f.done("coord");
    await f.idle("coord");
    expect(f.log(P)).toEqual(["user: ship it", "agent: Shipped."]);
  });

  it("reads a turn longer than a page whole, and a long history in slices that each end with a turn", async () => {
    const f = fixture();
    f.store.ensureScope(P, "initiatives");
    f.store.attach(f.thread("coord"), P);
    f.say("coord", "long turn");
    for (let n = 0; n < 250; n++) f.reply("coord", `step ${n}`);
    f.done("coord");
    for (let n = 0; n < 700; n++) f.turn("coord", `q${n}`);
    const ends = new Set(f.history.filter((r) => r.type === "turn/completed").map((r) => r.seq));
    let slices = 0;
    for (let more = true; more; slices++) {
      ({ more } = await f.memory.ingest("coord"));
      expect(ends.has(f.store.thread("coord")!.cursor)).toBe(true);
    }
    expect(slices).toBe(2);
    const log = f.log(P);
    expect(log).toHaveLength(1 + 250 + 1400);
    expect(log.at(-1)).toBe("agent: re: q699");
    expect(new Set(log).size).toBe(log.length);
  });
});

describe("T153 attach, detach, move (D491)", () => {
  it("moves a thread between turns: earlier turns stay in its old memory, later ones go to the new one, none twice", async () => {
    const f = fixture();
    f.thread("t");
    await f.configure("t", {});
    f.turn("t", "before");
    await f.idle("t");
    expect(await f.attach("initiatives", "prj_1", "t")).toBe(P);
    f.turn("t", "after");
    await f.idle("t");
    expect(f.log("chat-memory:t")).toEqual(["user: before", "agent: re: before"]);
    expect(f.log(P)).toEqual(["user: after", "agent: re: after"]);
    expect(await tools(f, "t")).toEqual(["memory_read", "memory_zoom"]);
    expect((await f.memory.status(P)).threads.map((t) => t.threadId)).toEqual(["t"]);
  });

  it("lands a turn moved mid-turn wholly in the new memory", async () => {
    const f = fixture();
    f.thread("t");
    await f.configure("t", {});
    f.say("t", "started in my own memory");
    await f.attach("initiatives", "prj_1", "t");
    f.reply("t", "finished in the Initiative's");
    f.done("t");
    await f.idle("t");
    expect(f.log("chat-memory:t")).toEqual([]);
    expect(f.log(P)).toEqual(["user: started in my own memory", "agent: finished in the Initiative's"]);
  });

  it("a move while a copy reads: the copy lands in the memory the row names at commit, once", async () => {
    const f = fixture();
    f.thread("t");
    await f.configure("t", {});
    f.turn("t", "racing");
    const list = f.memory["deps"].list;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    f.memory["deps"].list = async (args) => {
      if (args.order === "asc") await held;
      return list(args);
    };
    const copy = f.memory.kick("t")!;
    await new Promise((resolve) => setTimeout(resolve, 10));
    f.memory.attach("t", P);
    release();
    await copy.done;
    await f.memory.settled();
    expect(f.log("chat-memory:t")).toEqual([]);
    expect(f.log(P)).toEqual(["user: racing", "agent: re: racing"]);
  });

  it("detached at commit: nothing is appended and the cursor stays, so attaching again copies the turn once", async () => {
    const f = fixture();
    f.thread("t");
    await f.configure("t", {});
    f.turn("t", "pending");
    f.memory.attach("t", null);
    await f.idle("t");
    expect(f.store.thread("t")).toMatchObject({ scope: null, cursor: 0 });
    await f.configure("t", {});
    await f.memory.settled();
    expect(f.log("chat-memory:t")).toEqual(["user: pending", "agent: re: pending"]);
  });

  it("attaches a thread its owner spawned with memoryScope at its first configure; a detach or move then stands", async () => {
    const f = fixture();
    f.thread("new", { originPluginId: "initiatives", metadata: { role: "coordinator", memoryScope: "prj_1" } });
    expect(await tools(f, "new", { origin: "initiatives" })).toEqual(["memory_read", "memory_zoom"]);
    expect(f.store.thread("new")).toMatchObject({ scope: P, cursor: 0 });
    // Moved by its owner to another Initiative, or detached: a later configure with the same spawn metadata changes nothing.
    await f.attach("initiatives", "prj_2", "new");
    await tools(f, "new", { origin: "initiatives" });
    expect(f.store.thread("new")!.scope).toBe("initiatives:prj_2");
    f.memory.attach("new", null);
    expect(await tools(f, "new", { origin: "initiatives" })).toEqual([]);
    expect(f.store.thread("new")!.scope).toBeNull();
  });

  it("a former coordinator stays in the Initiative's memory: a later turn of it is logged there (D487 3)", async () => {
    const f = await initiative();
    f.thread("next", { originPluginId: "initiatives", metadata: { memoryScope: "prj_1" } });
    await tools(f, "next", { origin: "initiatives" });
    f.turn("next", "I took over");
    await f.idle("next");
    f.turn("coord", "still here");
    await f.idle("coord");
    expect(f.log(P)).toEqual(["user: I took over", "agent: re: I took over", "user: still here", "agent: re: still here"]);
  });
});

describe("T153 archive (D485, D487 7)", () => {
  it("copies the turn of a thread archived mid-turn when it ends; the recurring sweep skips it, the startup walk does not", async () => {
    const f = await initiative();
    f.say("coord", "last words");
    await f.archived("coord");
    expect(f.log(P)).toEqual([]);
    f.reply("coord", "noted");
    f.done("coord");
    await f.idle("coord");
    expect(f.log(P)).toEqual(["user: last words", "agent: noted"]);
    // An archived thread's turn whose announcements were all missed: only the startup walk copies it.
    f.turn("coord", "after the archive");
    await f.memory.sweep(true);
    await f.memory.settled();
    expect(f.log(P)).toHaveLength(2);
    await f.memory.sweep(false);
    await f.memory.settled();
    expect(f.log(P)).toHaveLength(4);
  });

  it("forgets a thread BB deleted", async () => {
    const f = await initiative();
    f.turn("coord", "bye");
    f.threads.delete("coord");
    await f.memory.sweep(true);
    expect(f.store.thread("coord")).toBeNull();
  });
});

describe("T153 restarts", () => {
  it("the startup sweep copies what finished while the plugin was down, archived threads included", async () => {
    const f = await initiative();
    await f.attach("initiatives", "prj_1", f.thread("talk", { archived: true }));
    f.turn("coord", "while down");
    f.turn("talk", "archived while down");
    const service = f.harness.behavior.runService("chat-memory-sweep");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await f.memory.settled();
    service.controller.abort();
    await service.done;
    expect(f.log(P).sort()).toEqual(["agent: re: archived while down", "agent: re: while down", "user: archived while down", "user: while down"]);
  });

  it("a stop during the startup sweep's read ends the service at once; the read's late answer does nothing", async () => {
    const f = await initiative();
    f.turn("coord", "while down");
    const list = f.memory["deps"].list;
    let answer: ((rows: EventRow[]) => void) | undefined;
    f.memory["deps"].list = (args) => (args.order === "desc" ? new Promise((resolve) => (answer = resolve)) : list(args));
    const service = f.harness.behavior.runService("chat-memory-sweep");
    await vi.waitFor(() => expect(answer).toBeDefined());
    const stopped = Date.now();
    service.controller.abort();
    await service.done;
    expect(Date.now() - stopped).toBeLessThan(1_000);
    answer!([f.history.at(-1)!]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.memory["ingests"].size).toBe(0);
    expect(f.log(P)).toEqual([]);
  });

  it("a sweep disposed mid-read returns without touching the database, even when the read then fails with a 404", async () => {
    const f = await initiative();
    let fail!: (error: unknown) => void;
    f.memory["deps"].list = () => new Promise((_, reject) => (fail = reject));
    const sweep = f.memory.sweep(true);
    f.memory.dispose();
    f.store.handle.close();
    fail(Object.assign(new Error("not found"), { status: 404 }));
    await expect(sweep).resolves.toBeUndefined();
  });

  it("an OptChat turn after a reload copies its own previous turn first, from the cursor the database kept", async () => {
    const f = await initiative("optchat");
    f.turn("coord", "before the reload");
    await f.idle("coord");
    // The reload drops the idle of the turn that ends meanwhile.
    const rebuilt = await f.harness.lifecycle.reload((bb) => void plugin(bb));
    f.turn("coord", "during the reload");
    const answer = fresh(
      JSON.parse((await rebuilt.harness.behavior.callAgentTool(TURN_CONTEXT_TOOL, { protocol: 4, input: "next", requestId: f.say("coord", "next"), sessionId: null }, { threadId: "coord" })) as string),
    );
    const view = `${answer.systemPrompt}\n${answer.input}`;
    expect(view).toMatch(/2\+1\|(user: during the reload|summary of 2)/);
    expect(view).not.toMatch(/user: next/);
    const log = (rebuilt.bb.storage.database().prepare(`SELECT text FROM log WHERE scope = ? ORDER BY i`).pluck().all(P) as string[]);
    expect(log).toEqual(["before the reload", "re: before the reload", "during the reload", "re: during the reload"]);
    await rebuilt.harness.lifecycle.dispose();
  });
});

describe("T153 OptChat turns", () => {
  it("shows messages with no summary yet whole, up to 32 KB, without waiting (D487 1)", async () => {
    const f = await initiative("optchat");
    f.memory.useSummarizer(stuckLuna);
    f.turn("coord", "short", "y".repeat(10_000));
    const started = Date.now();
    const answer = fresh(await f.ask("coord", f.say("coord", "go"), "go"));
    expect(Date.now() - started).toBeLessThan(1_000);
    // A short message is its own line at once; the long reply has no summary, so it is shown
    // whole, in the first message: a line shown whole is never frozen into the system prompt.
    expect(answer.systemPrompt).toMatch(/<chat>\n0\+1\|user: short\n<\/chat>$/);
    expect(answer.input).toMatch(/^<chat>\n1\+1\|agent: y{10000}\n<\/chat>/);
    f.memory.dispose();
  });

  it("fails the turn visibly when more than 32 KB has no summary by the deadline, naming why", async () => {
    const f = await initiative("optchat");
    f.memory.useSummarizer(stuckLuna);
    for (let n = 0; n < 3; n++) f.turn("coord", `part ${n}`, "z".repeat(14_000));
    await expect(f.ask("coord", f.say("coord", "go"), "go")).rejects.toThrow(/OptChat memory unavailable for this turn: \d+ earlier messages have no summary yet: the summarizer is still writing them\. The message was not sent/);
    f.memory.dispose();
  });

  it("fails the turn after the bounded tries of a summary that keeps failing; a message that fits is shown whole, never cut (A469 4)", async () => {
    const f = await initiative("optchat");
    f.memory.useSummarizer(async () => ({ ok: false, reason: "failed", error: "400 rejected" }));
    f.turn("coord", `${"background ".repeat(200)} NEVER DEPLOY TO PRODUCTION`, "ok");
    expect(fresh(await f.ask("coord", f.say("coord", "proceed"), "proceed")).input).toContain("NEVER DEPLOY TO PRODUCTION");
    for (let n = 0; n < 3; n++) f.turn("coord", `part ${n}`, "w".repeat(14_000));
    await expect(f.ask("coord", f.say("coord", "proceed"), "proceed")).rejects.toThrow(/OptChat memory unavailable for this turn: message \d+ could not be summarized \(400 rejected\)/);
    const status = await f.memory.status(P);
    expect(status.tree.fallbacks).toBe(0);
    expect(status.problems).toContainEqual(expect.stringMatching(/could not be summarized/));
    f.memory.dispose();
  });

  it("fails the turn visibly when its own last turn cannot be read, after a bounded number of tries", async () => {
    const f = await initiative("optchat");
    f.turn("coord", "previous");
    let reads = 0;
    const list = f.memory["deps"].list;
    f.memory["deps"].list = async (args) => {
      if (args.order !== "asc") return list(args);
      reads++;
      throw new Error("timeout");
    };
    await expect(f.ask("coord", f.say("coord", "go"), "go")).rejects.toThrow(/OptChat memory unavailable for this turn: its last turn could not be read \(timeout\)/);
    expect(reads).toBe(3);
  });

  it("stops a hung read of its own last turn as soon as BB stops the turn, not at the deadline (D488)", async () => {
    const f = await initiative("optchat");
    f.turn("coord", "previous");
    f.memory["deps"].list = () => new Promise(() => {});
    f.memory.waits = { turn: 60_000 };
    const stop = new AbortController();
    const turn = f.memory.turnContext("coord", { protocol: 4, input: "go", requestId: f.say("coord", "go"), sessionId: null }, stop.signal);
    setTimeout(() => stop.abort(), 50);
    const started = Date.now();
    await expect(turn).rejects.toThrow(/the turn stopped/);
    expect(Date.now() - started).toBeLessThan(1_000);
    f.memory.dispose();
  });

  it("follows a move made while its hook copies: view and last turn are the new memory's", async () => {
    const f = await initiative("optchat");
    await f.attach("initiatives", "prj_2", f.thread("other"));
    f.turn("other", "the other memory");
    await f.idle("other");
    await f.configure("other", { mode: "optchat" });
    f.turn("coord", "moving");
    const list = f.memory["deps"].list;
    f.memory["deps"].list = async (args) => {
      if (args.order === "asc" && args.threadId === "coord") f.store.attach("coord", "initiatives:prj_2");
      return list(args);
    };
    const answer = fresh(await f.ask("coord", f.say("coord", "where am I?"), "where am I?"));
    expect(`${answer.systemPrompt}\n${answer.input}`).toMatch(/0\+1\|(user: the other memory|summary of 0)/);
    expect(f.log("initiatives:prj_2")).toEqual(["user: the other memory", "agent: re: the other memory", "user: moving", "agent: re: moving"]);
    expect(f.log(P)).toEqual([]);
  });

  it("two tabs at once: each hook copies its own previous turn, every turn lands whole and once", async () => {
    const f = await initiative("optchat");
    await f.attach("initiatives", "prj_1", f.thread("talk"));
    f.turn("coord", "coordinator turn");
    f.turn("talk", "discussion turn");
    const [a, b] = await Promise.all([f.ask("coord", f.say("coord", "next a"), "next a"), f.ask("talk", f.say("talk", "next b"), "next b")]);
    expect(fresh(a).session).toBe("fresh");
    expect(fresh(b).session).toBe("fresh");
    const log = f.log(P);
    expect(log).toHaveLength(4);
    for (const turn of [["user: coordinator turn", "agent: re: coordinator turn"], ["user: discussion turn", "agent: re: discussion turn"]]) {
      const at = log.indexOf(turn[0]!);
      expect(log.slice(at, at + 2)).toEqual(turn);
    }
  });

  it("gives a new coordinator's first turn the whole memory, before anything of it is logged", async () => {
    const f = await initiative("optchat");
    f.turn("coord", "the plan");
    await f.idle("coord");
    f.memory.useSummarizer(fakeLuna);
    f.thread("next", { originPluginId: "initiatives", metadata: { memoryScope: "prj_1" } });
    expect(await tools(f, "next", { origin: "initiatives" })).toEqual([TURN_CONTEXT_TOOL, "memory_read", "memory_zoom"]);
    const answer = fresh(await f.ask("next", f.say("next", "Handover: carry on", { source: "spawn" }), "Handover: carry on"));
    expect(`${answer.systemPrompt}\n${answer.input}`).toMatch(/0\+\d+\|/);
    expect(answer.input).toMatch(/New message:\nHandover: carry on$/);
  });
});

describe("T153 the migration from T145's members", () => {
  /** A database as T145 left it, and the statement that adds one of its members. */
  const t145 = () => {
    const db = new Database(":memory:");
    for (const sql of MIGRATIONS.slice(0, T153)) db.exec(sql);
    const member = db.prepare(`INSERT INTO members (scope, thread_id, state, last_seq, compacted_seq, compact_tries, compact_error, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    return { db, member: (scope: string, threadId: string, state: string, lastSeq: number, joinedAt: number) => member.run(scope, threadId, state, lastSeq, null, 0, null, joinedAt) };
  };
  const T153 = MIGRATIONS.findIndex((m) => m.startsWith("CREATE TABLE threads"));
  const migrate = (db: Database.Database) => {
    for (const sql of MIGRATIONS.slice(T153)) db.exec(sql);
  };
  const rows = (db: Database.Database) => db.prepare(`SELECT thread_id, scope, cursor FROM threads ORDER BY thread_id`).all();
  const entry = (seq: number, text: string): LogEntry => ({ kind: "user", text, at: seq, threadId: "t", seq });

  it("gives every member one row, a current one winning over its earlier scopes, and keeps every other table as it was", () => {
    const db = new Database(":memory:");
    for (const sql of MIGRATIONS.slice(0, T153)) db.exec(sql);
    const member = db.prepare(`INSERT INTO members (scope, thread_id, state, last_seq, compacted_seq, compact_tries, compact_error, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    member.run("initiatives:a", "coord", "current", 500, 480, 1, null, 2);
    member.run("initiatives:old", "coord", "done", 100, null, 0, null, 1);
    member.run("initiatives:a", "former", "done", 300, null, 2, "503", 1);
    member.run("initiatives:b", "c2", "retired", 40, null, 0, null, 3);
    db.prepare(`INSERT INTO log (scope, i, kind, text, size, at, thread_id, seq) VALUES ('initiatives:a', 0, 'user', 'hi', 2, 1, 'coord', 10)`).run();
    migrate(db);
    expect(db.prepare(`SELECT thread_id, scope, cursor, compacted_seq, compact_tries, compact_error FROM threads ORDER BY thread_id`).all()).toEqual([
      { thread_id: "c2", scope: "initiatives:b", cursor: 40, compacted_seq: null, compact_tries: 0, compact_error: null },
      { thread_id: "coord", scope: "initiatives:a", cursor: 500, compacted_seq: 480, compact_tries: 1, compact_error: null },
      { thread_id: "former", scope: "initiatives:a", cursor: 300, compacted_seq: null, compact_tries: 2, compact_error: "503" },
    ]);
    expect(db.prepare(`SELECT COUNT(*) FROM members`).pluck().get()).toBe(4);
    expect(db.prepare(`SELECT text FROM log`).pluck().all()).toEqual(["hi"]);
  });

  it("leaves a personal memory the user turned off detached, with its cursor, while a former coordinator stays attached", () => {
    const { db, member } = t145();
    db.prepare(`INSERT INTO scopes (id, owner, created_at, updated_at) VALUES ('chat-memory:t', 'chat-memory', 1, 1)`).run();
    member("chat-memory:t", "t", "done", 50, 1);
    member("chat-memory:on", "on", "current", 20, 1);
    member("initiatives:a", "former", "done", 300, 1);
    migrate(db);
    expect(rows(db)).toEqual([
      { thread_id: "former", scope: "initiatives:a", cursor: 300 },
      { thread_id: "on", scope: "chat-memory:on", cursor: 20 },
      { thread_id: "t", scope: null, cursor: 50 },
    ]);
    // What it says while its memory is off is logged nowhere.
    expect(new MemoryStore(db).append("t", [entry(60, "Written while memory was off")], 70)).toBeNull();
    expect(db.prepare(`SELECT COUNT(*) FROM log`).pluck().get()).toBe(0);
  });

  it("starts a thread with several memberships from the furthest any of them read, in the scope it is current in", () => {
    const { db, member } = t145();
    member("initiatives:old", "t", "done", 500, 1);
    member("initiatives:new", "t", "current", 100, 2);
    db.prepare(`INSERT INTO log (scope, i, kind, text, size, at, thread_id, seq) VALUES ('initiatives:old', 0, 'user', 'logged once', 11, 400, 't', 400)`).run();
    migrate(db);
    expect(rows(db)).toEqual([{ thread_id: "t", scope: "initiatives:new", cursor: 500 }]);
    // The new membership's catch-up through 500 copies nothing the old one logged.
    expect(new MemoryStore(db).append("t", [entry(400, "logged once")], 500)).toEqual({ scope: "initiatives:new", appended: 0 });
    expect(db.prepare(`SELECT scope, text FROM log`).all()).toEqual([{ scope: "initiatives:old", text: "logged once" }]);
  });
});
