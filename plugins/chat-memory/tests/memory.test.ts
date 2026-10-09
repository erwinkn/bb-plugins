import { describe, expect, it } from "vitest";
import { TURN_CONTEXT_TOOL, type MemoryStatus } from "../lib/memory";
import { TURN_PROMPT } from "../lib/prompt";
import { fakeLuna, fixture, stuckLuna } from "./fixture";

const fresh = (answer: unknown) => answer as { session: "fresh"; sessionId: string; systemPrompt: string; input: string };
const toolNames = async (f: ReturnType<typeof fixture>, threadId: string, options?: Parameters<ReturnType<typeof fixture>["configureAgent"]>[1]) =>
  (await f.configureAgent(threadId, options)).tools.map((t) => t.name).sort();

describe("T145 scopes", () => {
  it("gives a scope's threads their memory tools in every mode, and Claude Code ones the hidden turn hook", async () => {
    const f = fixture();
    f.thread("coord", { originPluginId: "initiatives" });
    f.thread("talk", { originPluginId: "initiatives" });
    await f.setScope("initiatives", "prj_1", ["coord", "talk"]);
    expect(await toolNames(f, "coord")).toEqual([TURN_CONTEXT_TOOL, "memory_read", "memory_zoom"]);
    expect(await toolNames(f, "talk", { providerId: "codex" })).toEqual(["memory_read", "memory_zoom"]);
    const config = await f.configureAgent("coord");
    expect(config.instructions).toMatch(/^Memory: every message of this chat is logged/);
    // initiative_zoom only answers sessions built before T145; no new session gets it.
    expect(await toolNames(f, "worker", { parentThreadId: "coord", origin: "initiatives" })).toEqual([]);
    expect(await toolNames(f, "someone-else")).toEqual([]);
  });

  it("gives a top-level thread of a plugin that owns scopes its tools before its owner registers it", async () => {
    const f = fixture();
    await f.setScope("initiatives", "prj_1", [f.thread("coord")]);
    // A new coordinator is configured while it is spawned, before its id reaches its owner.
    expect(await toolNames(f, "new-coord", { origin: "initiatives" })).toEqual([TURN_CONTEXT_TOOL, "memory_read", "memory_zoom"]);
    expect(await toolNames(f, "adhoc", { origin: "initiatives", parentThreadId: "coord" })).toEqual([]);
    expect(await toolNames(f, "other", { origin: "another-plugin" })).toEqual([]);
  });

  it("lets only plugins set a scope's threads, and only the user switch a memory (D452)", async () => {
    const f = fixture();
    f.thread("coord");
    await expect(f.harness.behavior.callRpc("setScope", { key: "prj_1", threads: ["coord"] })).rejects.toThrow(/set by the plugin that owns it/);
    await f.setScope("initiatives", "prj_1", ["coord"]);
    await expect(
      f.harness.behavior.callRpc("configure", { threadId: "coord", mode: "hybrid" }, { experimental_caller: { kind: "plugin", pluginId: "initiatives" } }),
    ).rejects.toThrow(/Only the user switches/);
    expect(((await f.configure("coord", { mode: "hybrid" })) as MemoryStatus).mode).toBe("hybrid");
    // No tool or command writes it.
    expect(f.harness.inspection.registrations.agentTools.map((t: { name: string }) => t.name).sort()).toEqual([TURN_CONTEXT_TOOL, "memory_read", "memory_zoom"]);
    for (const argv of [["configure", "coord"], ["mode", "optchat"], ["set", "regular"]]) expect((await f.harness.behavior.runCli(argv, { threadId: "coord" })).exitCode).toBe(2);
  });

  it("logs every thread of a scope into one log, by time, and reads a retired thread until it is quiet", async () => {
    const f = fixture();
    f.thread("a", { title: "Coordinator" });
    f.thread("b", { title: "Discussion" });
    f.thread("w", { title: "W12 Fix the parser — parser" });
    await f.setScope("initiatives", "prj_1", ["a", "b"]);
    f.say("a", "plan the release");
    f.say("b", "what about docs?");
    f.reply("a", "Release planned.");
    f.say("a", "[bb message from thread:w] done: parser fixed", { initiator: "agent", senderThreadId: "w" });
    await f.idle("a");
    await f.idle("a");
    expect(f.store.messages("initiatives:prj_1").map((m) => `${m.threadId} ${m.kind}: ${m.text}`)).toEqual([
      "a user: plan the release",
      "b user: what about docs?",
      "a agent: Release planned.",
      "a work: [W12 Fix the parser — parser] done: parser fixed",
    ]);
    // b leaves the scope while busy: still read; once quiet, read through and done.
    f.threads.get("b")!.status = "active";
    await f.setScope("initiatives", "prj_1", ["a"]);
    f.reply("b", "Docs are fine.");
    await f.idle("b");
    expect(f.store.member("initiatives:prj_1", "b")).toMatchObject({ state: "retired" });
    f.threads.get("b")!.status = "idle";
    f.reply("b", "Last word.");
    await f.idle("b");
    expect(f.store.member("initiatives:prj_1", "b")).toMatchObject({ state: "done" });
    expect(f.store.messages("initiatives:prj_1").slice(-2).map((m) => m.text)).toEqual(["Docs are fine.", "Last word."]);
    // A tree builds over the shared log.
    expect((await f.memory.status("initiatives:prj_1")).tree.nodes).toBeGreaterThan(0);
  });

  it("logs a plugin's brief as a note, skips retries and /compact, and tags BB notices", async () => {
    const f = fixture();
    f.thread("c", { originPluginId: "initiatives" });
    await f.setScope("initiatives", "prj_1", ["c"]);
    f.say("c", "This thread is starting as coordinator…", { source: "spawn" });
    f.say("c", "hello");
    f.say("c", "hello", { retryOfRequestId: "creq_1", retryAttempt: 2, initiator: "system" });
    f.say("c", "/compact");
    f.say("c", "[bb system] W3 finished", { initiator: "system" });
    await f.idle("c");
    expect(f.store.messages("initiatives:prj_1").map((m) => `${m.kind}: ${m.text}`)).toEqual(["note: This thread is starting as coordinator…", "user: hello", "work: [bb] W3 finished"]);
  });
});

describe("T145 turns (one path per mode, D458)", () => {
  async function scoped(mode: "regular" | "hybrid" | "optchat" = "optchat") {
    const f = fixture();
    f.thread("a", { title: "Coordinator" });
    f.thread("b", { title: "Discussion" });
    await f.setScope("initiatives", "prj_1", ["a", "b"]);
    for (let n = 0; n < 3; n++) {
      f.say("a", `question ${n}`);
      f.reply("a", `answer ${n}`);
    }
    await f.idle("a");
    for (const t of ["a", "b"]) expect(await f.ask(t, f.say(t, "warm up"), "warm up")).toEqual({});
    await f.idle("a");
    await f.idle("b");
    if (mode !== "regular") await f.configure("a", { mode });
    return f;
  }

  it("lets the session go on in regular and hybrid, and records that the thread asked", async () => {
    for (const mode of ["regular", "hybrid"] as const) {
      const f = await scoped(mode);
      expect(await f.ask("a", f.say("a", "next"), "next")).toEqual({});
      expect(f.store.member("initiatives:prj_1", "a")).toMatchObject({ askedProtocol: 4 });
    }
    // A thread outside every scope: nothing to do.
    expect(await fixture().ask("x", "creq_1", "hi")).toEqual({});
  });

  it("starts an OptChat turn in a fresh session over the whole shared view, without the new message", async () => {
    const f = await scoped();
    f.say("b", `a point from the discussion: ${"long ".repeat(200)}`);
    await f.idle("b");
    const requestId = f.say("a", "what now?");
    const answer = fresh(await f.ask("a", requestId, "what now?"));
    expect(answer.session).toBe("fresh");
    expect(answer.systemPrompt.startsWith(TURN_PROMPT)).toBe(true);
    const view = `${answer.systemPrompt}\n${answer.input}`;
    // Every line is a summary (the turn waited for them), the discussion's message included.
    expect(view).toMatch(/\|summary of \d+/);
    expect(view).not.toMatch(/not summarized yet|user: what now\?/);
    // The lines cover every message before the new one (the last logged), in order, once.
    let covered = 0;
    for (const [, id, n] of view.matchAll(/^(\d+)\+(\d+)\|/gm)) {
      expect(Number(id)).toBe(covered);
      covered += Number(n);
    }
    expect(covered).toBe(f.store.count("initiatives:prj_1") - 1);
    expect(answer.input).toMatch(/Now: \d{4}-\d\d-\d\d \d\d:\d\dZ\.\n\nNew message:\nwhat now\?$/);
    // The next turn keeps the frozen lines, so the system prompt (and the fork's seed) is reused.
    f.reply("a", "do X");
    await f.idle("a");
    const next = fresh(await f.ask("a", f.say("a", "and then?"), "and then?"));
    expect(next.systemPrompt).toBe(answer.systemPrompt);
    // The previous turn is memory now, in the tail.
    expect(next.input).toMatch(/^<chat>\n9\+1\|user: what now\?\n10\+1\|agent: do X\n<\/chat>/);
  });

  it("waits for the newest messages' summaries before it answers", async () => {
    const f = await scoped();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    f.memory.useSummarizer(async (r) => {
      await gate;
      return fakeLuna(r);
    });
    f.reply("a", "x".repeat(2000));
    const turn = f.ask("a", f.say("a", "go on"), "go on");
    setTimeout(release, 300);
    expect(fresh(await turn).session).toBe("fresh");
  });

  it("fails the turn visibly when the summaries do not come in time (rate limit, stuck summarizer)", async () => {
    const f = await scoped();
    f.memory.useSummarizer(stuckLuna);
    f.reply("a", "y".repeat(2000));
    await expect(f.ask("a", f.say("a", "go on"), "go on")).rejects.toThrow(/OptChat memory unavailable for this turn: 1 earlier messages have no summary yet: the summarizer is still writing them\. The message was not sent/);
    f.memory.dispose();
  });

  it("fails the turn visibly when the thread's log cannot be read, after a bounded number of tries", async () => {
    const f = await scoped();
    const requestId = f.say("a", "go on");
    f.failReads(true);
    await expect(f.ask("a", requestId, "go on")).rejects.toThrow(/request could not be read \(events unavailable\)/);
    // The request was found, but every read of the log fails.
    f.failReads(false);
    const list = f.memory["deps"].list;
    let reads = 0;
    f.memory["deps"].list = async (args) => {
      if (args.types.length > 1 || args.order === "asc") {
        reads++;
        throw new Error("timeout");
      }
      return list(args);
    };
    await expect(f.ask("a", requestId, "go on")).rejects.toThrow(/reading the thread failed 3 times \(timeout\)/);
    expect(reads).toBe(3);
  });

  it("fails the turn visibly when its log does not catch up with it before the deadline", async () => {
    const f = await scoped();
    const requestId = f.say("a", "go on");
    const list = f.memory["deps"].list;
    // The request is found, but reading the log hangs (BB slow to serve events).
    f.memory["deps"].list = async (args) => (args.types.length === 1 && args.types[0] === "client/turn/requested" && args.order === "desc" && args.limit === "100" ? list(args) : new Promise(() => {}));
    const started = Date.now();
    await expect(f.ask("a", requestId, "go on")).rejects.toThrow(/OptChat memory unavailable for this turn: its log did not catch up with it in time\. The message was not sent/);
    expect(Date.now() - started).toBeLessThan(3_000);
    f.memory.dispose();
  });

  it("fails the turn visibly when its request is unknown or the memory view cannot be built", async () => {
    const f = await scoped();
    await expect(f.ask("a", "creq_nope", "hi")).rejects.toThrow(/its request creq_nope is not among/);
    const memory = f.memory as unknown as { tree: () => unknown };
    const tree = memory.tree;
    memory.tree = () => {
      throw new Error("tree store unreadable");
    };
    await expect(f.ask("a", f.say("a", "hi"), "hi")).rejects.toThrow(/tree store unreadable/);
    memory.tree = tree;
  });

  it("answers the fork's protocol 3 asks in Regular and Hybrid, ignoring their reports, fails OptChat on it, and refuses anything else", async () => {
    const reports = [{ requestId: "creq_old", offeredSessionId: null, outcome: "resident", sessionId: "s-a" }];
    const hybrid = await scoped("hybrid");
    expect(await hybrid.ask("a", hybrid.say("a", "go"), "go", { protocol: 3, reports })).toEqual({});
    // A471: a protocol 3 provider asks only in sessions built with the hook, so OptChat cannot be
    // enforced on it: its OptChat turns fail, and so does every OptChat message after.
    const f = await scoped();
    await expect(f.ask("a", f.say("a", "go"), "go", { protocol: 3, reports })).rejects.toThrow(/OptChat memory unavailable for this turn: BB's Claude Code provider is older than protocol 4/);
    expect(await f.dispatch("b")).toMatchObject({ action: "reject", message: expect.stringMatching(/older than protocol 4/) });
    expect((await f.memory.status("initiatives:prj_1")).problems).toContainEqual(expect.stringMatching(/older than protocol 4/));
    await expect(f.harness.behavior.callAgentTool(TURN_CONTEXT_TOOL, { input: "hi" }, { threadId: "a" })).rejects.toThrow(/called by BB's Claude Code provider only/);
  });

  it("waits for a new thread its owner names a scope for, until its owner registers it", async () => {
    const f = await scoped();
    f.thread("new-coord", { originPluginId: "initiatives", metadata: { memoryScope: "prj_1" } });
    // Configured while it is spawned, before its id reaches its owner: built with the hook.
    await f.configureAgent("new-coord", { origin: "initiatives" });
    const requestId = f.say("new-coord", "Handover: carry on");
    setTimeout(() => void f.setScope("initiatives", "prj_1", ["new-coord"]), 100);
    expect(fresh(await f.ask("new-coord", requestId, "Handover: carry on")).session).toBe("fresh");
    expect(await f.dispatch("new-coord")).toEqual({ action: "proceed" });
  });
});

describe("T145 switching (D452, D458, D460)", () => {
  it("refuses OptChat for a Codex thread; a thread that joined with a session built before needs nothing more", async () => {
    const f = fixture();
    f.thread("a");
    f.thread("c", { providerId: "codex", title: "Codex talk" });
    await f.setScope("initiatives", "prj_1", ["a", "c"]);
    await expect(f.configure("a", { mode: "optchat" })).rejects.toThrow(/OptChat runs on Claude Code only for now \(T146\): "Codex talk" runs on codex/);
    await f.setScope("initiatives", "prj_1", ["a"]);
    // Its next turn's tools have the hook, whatever its session was built with (FORK.md).
    expect(((await f.configure("a", { mode: "optchat" })) as MemoryStatus).mode).toBe("optchat");
    // A Codex thread that joins later is shown as a problem wherever the mode is, and its turns are refused.
    await f.setScope("initiatives", "prj_1", ["a", "c"]);
    expect((await f.memory.status("initiatives:prj_1")).problems).toEqual([expect.stringMatching(/OptChat cannot run in "Codex talk" \(codex\): its turns are refused/)]);
  });

  it("turns memory on for any thread as its own scope, and off again", async () => {
    const f = fixture();
    f.thread("plain");
    expect(await f.harness.behavior.callRpc("status", { threadId: "plain" })).toBeNull();
    const on = (await f.configure("plain", {})) as MemoryStatus;
    expect(on).toMatchObject({ scope: { id: "chat-memory:plain", owner: "chat-memory" }, mode: "regular" });
    expect(await toolNames(f, "plain")).toEqual([TURN_CONTEXT_TOOL, "memory_read", "memory_zoom"]);
    expect(await f.configure("plain", { enabled: false })).toBeNull();
    expect(await toolNames(f, "plain")).toEqual([]);
    // An owner's scope is not the user's to close.
    await f.setScope("initiatives", "prj_1", [f.thread("coord")]);
    await expect(f.configure("coord", { enabled: false })).rejects.toThrow(/belongs to the initiatives plugin/);
  });
});

describe("T145 compaction", () => {
  it("compacts past the limit of the scope's mode, once per snapshot; never in OptChat", async () => {
    const f = fixture();
    await f.setScope("initiatives", "prj_1", [f.thread("a")]);
    const scope = () => f.store.scope("initiatives:prj_1")!;
    expect(f.memory.compactLimit(scope())).toBe(300_000);
    await f.configure("a", { mode: "hybrid" });
    expect(f.memory.compactLimit(scope())).toBe(150_000);
    await f.configure("a", { compactTokens: 90_000 });
    expect(f.memory.compactLimit(scope())).toBe(90_000);
    f.usage("a", 80_000);
    await f.idle("a");
    expect(f.compacts).toEqual([]);
    f.usage("a", 95_000);
    await f.idle("a");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.compacts).toEqual(["a"]);
    await f.idle("a");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.compacts).toEqual(["a"]);
    expect(f.memory.compactLimit({ mode: "optchat", compactTokens: 90_000 })).toBe(0);
  });
});

describe("T145 reads", () => {
  it("reads the view and zooms with timestamps, under both tool names; a thread without memory is told so", async () => {
    const f = fixture();
    await f.setScope("initiatives", "prj_1", [f.thread("a")]);
    f.say("a", "first");
    f.reply("a", "second");
    await f.idle("a");
    const read = JSON.parse((await f.harness.behavior.callAgentTool("memory_read", {}, { threadId: "a" })) as string);
    expect(read).toMatchObject({ messages: 2, view: expect.stringContaining("|") });
    const zoom = await f.harness.behavior.callAgentTool("memory_zoom", { id: 0, n: 2 }, { threadId: "a" });
    expect(zoom).toMatch(/^2026-10-08 12:00Z 0\+1\|.+\n2026-10-08 12:00Z 1\+1\|.+$/);
    // The owner's aliases for sessions built before T145 (initiative_zoom, initiative_read {view:"memory"}).
    expect(await f.harness.behavior.callRpc("zoom", { threadId: "a", id: 1, n: 1 }, { experimental_caller: { kind: "plugin", pluginId: "initiatives" } })).toMatch(/^2026-10-08 12:00Z 1\+1\|agent: second$/);
    expect(await f.harness.behavior.callRpc("read", { threadId: "a" }, { experimental_caller: { kind: "plugin", pluginId: "initiatives" } })).toEqual(read);
    await expect(f.harness.behavior.callAgentTool("memory_zoom", { id: 0, n: 1 }, { threadId: "elsewhere" })).rejects.toThrow(/has no chat memory/);
    expect((await f.harness.behavior.runCli(["zoom", "0", "1"], { threadId: "a" })).stdout).toMatch(/0\+1\|user: first$/);
  });
});

describe("T145 a retried turn", () => {
  it("ends its view before the original request, which is logged already", async () => {
    const f = fixture();
    await f.setScope("initiatives", "prj_1", [f.thread("a")]);
    expect(await f.ask("a", f.say("a", "warm up"), "warm up")).toEqual({});
    await f.idle("a");
    await f.configure("a", { mode: "optchat" });
    const original = f.say("a", "Ship it");
    const retry = f.say("a", "Ship it", { retryOfRequestId: original, retryAttempt: 2, initiator: "system" });
    const answer = fresh(await f.ask("a", retry, "Ship it"));
    expect(`${answer.systemPrompt}\n${answer.input}`).not.toMatch(/\|user: Ship it/);
    expect(answer.input).toMatch(/New message:\nShip it$/);
  });
});
