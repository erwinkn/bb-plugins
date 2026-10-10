import { describe, expect, it } from "vitest";
import { TURN_CONTEXT_TOOL, type MemoryStatus } from "../lib/memory";
import { TURN_PROMPT } from "../lib/prompt";
import { fakeLuna, fixture, stuckLuna } from "./fixture";

const fresh = (answer: unknown) => answer as { session: "fresh"; sessionId: string; systemPrompt: string; input: string };
const toolNames = async (f: ReturnType<typeof fixture>, threadId: string, options?: Parameters<ReturnType<typeof fixture>["configureAgent"]>[1]) =>
  (await f.configureAgent(threadId, options)).tools.map((t) => t.name).sort();

describe("T145 scopes", () => {
  it("gives a scope's threads their memory tools in every mode, and the hidden turn hook only in OptChat (D490)", async () => {
    const f = fixture();
    await f.attach("initiatives", "prj_1", f.thread("coord"), f.thread("talk", { providerId: "codex" }));
    expect(await toolNames(f, "coord")).toEqual(["memory_read", "memory_zoom"]);
    expect(await toolNames(f, "talk", { providerId: "codex" })).toEqual(["memory_read", "memory_zoom"]);
    const config = await f.configureAgent("coord");
    expect(config.instructions).toMatch(/^Memory: every message of this chat is logged/);
    await f.configure("talk", { mode: "hybrid" });
    expect(await toolNames(f, "coord")).toEqual(["memory_read", "memory_zoom"]);
    // A worker carries no memoryScope; a thread nobody attached has nothing.
    f.thread("worker", { originPluginId: "initiatives", metadata: { role: "worker" } });
    expect(await toolNames(f, "worker", { parentThreadId: "coord", origin: "initiatives" })).toEqual([]);
    expect(await toolNames(f, "someone-else")).toEqual([]);
    expect(f.store.thread("worker")).toBeNull();
  });

  it("lets only plugins attach a thread, and only the user switch a memory (D452)", async () => {
    const f = fixture();
    f.thread("coord");
    await expect(f.harness.behavior.callRpc("attach", { threadId: "coord", key: "prj_1" })).rejects.toThrow(/attached to a memory by the plugin that owns it/);
    expect(await f.attach("initiatives", "prj_1", "coord")).toBe("initiatives:prj_1");
    await expect(
      f.harness.behavior.callRpc("configure", { threadId: "coord", mode: "hybrid" }, { experimental_caller: { kind: "plugin", pluginId: "initiatives" } }),
    ).rejects.toThrow(/Only the user switches/);
    expect(((await f.configure("coord", { mode: "hybrid" })) as MemoryStatus).mode).toBe("hybrid");
    // No tool or command writes it.
    expect(f.harness.inspection.registrations.agentTools.map((t: { name: string }) => t.name).sort()).toEqual(["memory_read", "memory_zoom", TURN_CONTEXT_TOOL].sort());
    for (const argv of [["configure", "coord"], ["mode", "optchat"], ["set", "regular"], ["import-initiatives"]]) expect((await f.harness.behavior.runCli(argv, { threadId: "coord" })).exitCode).toBe(2);
  });

  it("logs every thread of a scope into one log, a turn at a time as each one completes", async () => {
    const f = fixture();
    f.thread("a", { title: "Coordinator" });
    f.thread("b", { title: "Discussion" });
    f.thread("w", { title: "W12 Fix the parser — parser" });
    await f.attach("initiatives", "prj_1", "a", "b");
    f.say("a", "plan the release");
    f.say("b", "what about docs?");
    f.reply("a", "Release planned.");
    f.say("a", "[bb message from thread:w] done: parser fixed", { initiator: "agent", senderThreadId: "w" });
    f.done("a");
    await f.idle("a");
    await f.idle("a");
    f.reply("b", "Docs are fine.");
    f.done("b");
    await f.idle("b");
    expect(f.store.messages("initiatives:prj_1").map((m) => `${m.threadId} ${m.kind}: ${m.text}`)).toEqual([
      "a user: plan the release",
      "a agent: Release planned.",
      "a work: [W12 Fix the parser — parser] done: parser fixed",
      "b user: what about docs?",
      "b agent: Docs are fine.",
    ]);
    // A tree builds over the shared log.
    expect((await f.memory.status("initiatives:prj_1")).tree.nodes).toBeGreaterThan(0);
  });

  it("logs a plugin's brief as a note, skips /compact, tags BB notices, and marks a stopped turn", async () => {
    const f = fixture();
    await f.attach("initiatives", "prj_1", f.thread("c", { originPluginId: "initiatives" }));
    f.say("c", "This thread is starting as coordinator…", { source: "spawn" });
    f.say("c", "hello");
    f.say("c", "/compact");
    f.say("c", "[bb system] W3 finished", { initiator: "system" });
    f.reply("c", "On it");
    f.done("c", "interrupted");
    await f.idle("c");
    expect(f.log("initiatives:prj_1")).toEqual([
      "note: This thread is starting as coordinator…",
      "user: hello",
      "work: [bb] W3 finished",
      "agent: On it",
      "work: [bb] (stopped) This turn was stopped before it finished.",
    ]);
  });
});

describe("T145 turns (one path per mode, D458)", () => {
  async function scoped(mode: "regular" | "hybrid" | "optchat" = "optchat") {
    const f = fixture();
    await f.attach("initiatives", "prj_1", f.thread("a", { title: "Coordinator" }), f.thread("b", { title: "Discussion" }));
    for (let n = 0; n < 3; n++) f.turn("a", `question ${n}`, `answer ${n}`);
    await f.idle("a");
    if (mode !== "regular") await f.configure("a", { mode });
    return f;
  }

  it("lets the session go on in regular and hybrid (a mode switched since the turn's tools were resolved)", async () => {
    for (const mode of ["regular", "hybrid"] as const) {
      const f = await scoped(mode);
      expect(await f.ask("a", f.say("a", "next"), "next")).toEqual({});
    }
    // A thread outside every scope: nothing to do.
    expect(await fixture().ask("x", "creq_1", "hi")).toEqual({});
  });

  it("starts an OptChat turn in a fresh session over the whole shared log, which holds completed turns only", async () => {
    const f = await scoped();
    f.turn("b", `a point from the discussion: ${"long ".repeat(200)}`);
    await f.idle("b");
    const answer = fresh(await f.ask("a", f.say("a", "what now?"), "what now?"));
    expect(answer.session).toBe("fresh");
    expect(answer.systemPrompt.startsWith(TURN_PROMPT)).toBe(true);
    const view = `${answer.systemPrompt}\n${answer.input}`;
    // Every message logged so far is summarized here (idle waited for the builds), the discussion's included.
    expect(view).toMatch(/\|summary of \d+/);
    expect(view).not.toMatch(/user: what now\?/);
    // The lines cover every message logged, in order, once.
    let covered = 0;
    for (const [, id, n] of view.matchAll(/^(\d+)\+(\d+)\|/gm)) {
      expect(Number(id)).toBe(covered);
      covered += Number(n);
    }
    expect(covered).toBe(f.store.count("initiatives:prj_1"));
    expect(answer.input).toMatch(/Now: \d{4}-\d\d-\d\d \d\d:\d\dZ\.\n\nNew message:\nwhat now\?$/);
    // The turn ends; nobody announces it. The next turn copies it first, shows it whole (no summary
    // yet), and keeps the frozen lines, so the system prompt (and the fork's seed) is reused.
    f.reply("a", "do X");
    f.done("a");
    f.memory.useSummarizer(stuckLuna);
    const next = fresh(await f.ask("a", f.say("a", "and then?"), "and then?"));
    expect(next.systemPrompt).toBe(answer.systemPrompt);
    expect(next.input).toMatch(/^<chat>\n8\+1\|user: what now\?\n9\+1\|agent: do X\n<\/chat>/);
    f.memory.dispose();
  });

  it("fails the turn visibly when the memory view cannot be built, and refuses an ask that is not protocol 4", async () => {
    const f = await scoped();
    const memory = f.memory as unknown as { tree: () => unknown };
    const tree = memory.tree;
    memory.tree = () => {
      throw new Error("tree store unreadable");
    };
    await expect(f.ask("a", f.say("a", "hi"), "hi")).rejects.toThrow(/OptChat memory unavailable for this turn: tree store unreadable/);
    memory.tree = tree;
    await expect(f.ask("a", f.say("a", "go"), "go", { protocol: 3 })).rejects.toThrow(/called by BB's Claude Code provider only/);
    await expect(f.harness.behavior.callAgentTool(TURN_CONTEXT_TOOL, { input: "hi" }, { threadId: "a" })).rejects.toThrow(/called by BB's Claude Code provider only/);
  });

  it("waits for summaries only once more than 32 KB has none (D487), then answers", async () => {
    const f = await scoped();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    f.memory.useSummarizer(async (r) => {
      await gate;
      return fakeLuna(r);
    });
    for (let n = 0; n < 3; n++) f.turn("a", `part ${n}`, "x".repeat(14_000));
    const started = Date.now();
    const turn = f.ask("a", f.say("a", "go on"), "go on");
    setTimeout(release, 300);
    expect(fresh(await turn).session).toBe("fresh");
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });
});

describe("T145 switching (D452, D458, D460)", () => {
  it("refuses OptChat for a Codex thread; shows one that joins later, and refuses its turns", async () => {
    const f = fixture();
    await f.attach("initiatives", "prj_1", f.thread("a"), f.thread("c", { providerId: "codex", title: "Codex talk" }));
    await expect(f.configure("a", { mode: "optchat" })).rejects.toThrow(/OptChat runs on Claude Code only for now \(T146\): "Codex talk" runs on codex/);
    // Without the Codex thread, the Initiative's memory goes OptChat.
    f.memory.attach("c", null);
    expect(((await f.configure("a", { mode: "optchat" })) as MemoryStatus).mode).toBe("optchat");
    await f.attach("initiatives", "prj_1", "c");
    expect((await f.memory.status("initiatives:prj_1")).problems).toEqual([expect.stringMatching(/OptChat cannot run in "Codex talk" \(codex\): its turns are refused/)]);
    // The hook in a Codex thread's tools makes BB refuse each of its turns; the gate says why first.
    expect(await toolNames(f, "c", { providerId: "codex" })).toEqual([TURN_CONTEXT_TOOL, "memory_read", "memory_zoom"]);
    expect(await f.dispatch("c")).toMatchObject({ action: "reject", message: expect.stringMatching(/OptChat runs on Claude Code only for now \(T146\): "Codex talk" runs on codex, so this message was not sent/) });
    expect(await f.dispatch("c", { attempt: "join-turn" })).toEqual({ action: "proceed" });
    expect(await f.dispatch("a")).toEqual({ action: "proceed" });
  });

  it("turns memory on for any thread as its own scope, off again, and on again from where it left", async () => {
    const f = fixture();
    f.thread("plain");
    expect(await f.harness.behavior.callRpc("status", { threadId: "plain" })).toBeNull();
    const on = (await f.configure("plain", {})) as MemoryStatus;
    expect(on).toMatchObject({ scope: { id: "chat-memory:plain", owner: "chat-memory" }, mode: "regular" });
    f.turn("plain", "one");
    await f.idle("plain");
    expect(await toolNames(f, "plain")).toEqual(["memory_read", "memory_zoom"]);
    expect(await f.configure("plain", { enabled: false })).toBeNull();
    expect(await toolNames(f, "plain")).toEqual([]);
    // Off: its turns are not logged; on again, the turns made meanwhile are copied once.
    f.turn("plain", "two");
    await f.idle("plain");
    expect(f.log("chat-memory:plain")).toEqual(["user: one", "agent: re: one"]);
    await f.configure("plain", {});
    await f.memory.settled();
    expect(f.log("chat-memory:plain")).toEqual(["user: one", "agent: re: one", "user: two", "agent: re: two"]);
    // An owner's scope is not the user's to leave.
    await f.attach("initiatives", "prj_1", f.thread("coord"));
    await expect(f.configure("coord", { enabled: false })).rejects.toThrow(/belongs to the initiatives plugin/);
  });
});

describe("T145 compaction", () => {
  it("compacts past the limit of the scope's mode, once per snapshot; never in OptChat", async () => {
    const f = fixture();
    await f.attach("initiatives", "prj_1", f.thread("a"));
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
    await f.attach("initiatives", "prj_1", f.thread("a"));
    f.turn("a", "first", "second");
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
