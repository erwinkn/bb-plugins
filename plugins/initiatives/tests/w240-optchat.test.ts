import { beforeEach, describe, expect, it, vi } from "vitest";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { projectFixture } from "./fake-native";
import { TURN_CONTEXT_TOOL } from "../lib/memory/memory";
import { TURN_PROMPT, handoverMessage, turnMessage, turnSystem } from "../lib/memory/prompt";
import { MAX_MISSING, RAW_BYTES, TAIL_BYTES, rawLine, runLine, turnView, type TurnViewInput } from "../lib/memory/turn";
import { key, PLACEHOLDER, type NodeRef } from "../lib/memory/tree";
import type { Summarizer, SummarizerRequest } from "../lib/memory/summarizer";
import type { MemoryMessage } from "../lib/memory/log";

// W240 (D431 phase 2): an optchat coordinator's turn is a fresh session over the summary view.

type Kind = MemoryMessage["kind"];
/** A tree where messages 0..built-1 have their line ("L<i>") and the rest are logged only. */
function tree(count: number, built: number, kind: (i: number) => Kind = () => "user", text = (i: number) => `message ${i}`) {
  const nodes = new Map<string, string>();
  for (let i = 0; i < built; i++) nodes.set(key(0, i), `L${i}`);
  const input: TurnViewInput = {
    chat: Array.from({ length: count }, (_, i): NodeRef => [0, i]),
    fed: count,
    nodes,
    message: (i) => (i < count + 10 ? { kind: kind(i), text: text(i) } : null),
    cut: count,
    frozen: null,
  };
  return { nodes, input };
}

describe("W240 turn view", () => {
  it("freezes the built lines for the system prompt and shows the newest messages raw in the turn", () => {
    const { input } = tree(10, 8);
    const view = turnView(input);
    expect(view.frozenLines).toEqual(Array.from({ length: 8 }, (_, i) => `${i}+1|L${i}`));
    expect(view.tailLines).toEqual(["8+1|user: message 8", "9+1|user: message 9"]);
    expect(view).toMatchObject({ missing: 0, refrozen: true });
  });

  it("leaves out the new message and anything after it", () => {
    const { input } = tree(10, 10);
    const view = turnView({ ...input, cut: 7 });
    expect([...view.frozenLines, ...view.tailLines].at(-1)).toBe("6+1|L6");
  });

  it("keeps the frozen lines turn after turn, so the system prompt stays a cached prefix", () => {
    const first = turnView(tree(10, 8).input);
    // Two turns later: messages 8..13 are built or logged; the frozen lines are the same.
    const { input } = tree(14, 12);
    const next = turnView({ ...input, frozen: first.frozen });
    expect(next.refrozen).toBe(false);
    expect(next.frozenLines).toEqual(first.frozenLines);
    expect(next.tailLines).toEqual(["8+1|L8", "9+1|L9", "10+1|L10", "11+1|L11", "12+1|user: message 12", "13+1|user: message 13"]);
    expect(turnSystem(next.frozenLines)).toBe(turnSystem(first.frozenLines));
  });

  it("freezes again once the newest lines pass TAIL_BYTES, or once a merge rewrites the frozen lines", () => {
    const long = (i: number) => `message ${i} `.padEnd(1500, "x");
    const first = turnView(tree(10, 10, undefined, long).input);
    const { input, nodes } = tree(80, 76, undefined, long);
    for (let i = 0; i < 76; i++) nodes.set(key(0, i), `L${i} `.padEnd(500, "s"));
    const grown = turnView({ ...input, frozen: first.frozen });
    expect(grown.refrozen).toBe(true);
    expect(grown.frozen).toHaveLength(76);
    expect(grown.tailLines.reduce((sum, l) => sum + Buffer.byteLength(l) + 1, 0)).toBeLessThanOrEqual(TAIL_BYTES);

    // A merge batch replaced 0+1 and 1+1 with 0+2: the frozen prefix no longer holds.
    const merged = tree(12, 12);
    merged.nodes.set(key(1, 0), "M0");
    const view = turnView({ ...merged.input, chat: [[1, 0], ...merged.input.chat.slice(2)], frozen: first.frozen });
    expect(view.refrozen).toBe(true);
    expect(view.frozenLines[0]).toBe("0+2|M0");
  });

  it("clips a long unsummarized message to its head and tail, tool output tighter than words", () => {
    const text = `start ${"a".repeat(5000)} end`;
    const user = rawLine(7, { kind: "user", text });
    const echo = rawLine(8, { kind: "echo", text });
    expect(user).toMatch(/^7\+1\|user: start a+ … a+ end$/);
    expect(Buffer.byteLength(user)).toBeLessThanOrEqual(2048 + 8);
    expect(Buffer.byteLength(echo)).toBeLessThanOrEqual(512 + 8);
    expect(rawLine(9, { kind: "coord", text: "Done.\n\nNext." })).toBe("9+1|coord: Done. Next.");
  });

  it("shows placeholders past RAW_BYTES of unsummarized messages, newest kept, and counts them", () => {
    const { input } = tree(200, 0, () => "user", (i) => `message ${i} `.padEnd(1500, "y"));
    const view = turnView(input);
    expect(view.frozen).toEqual([]);
    expect(view.tailLines.at(-1)).toMatch(/^199\+1\|user: message 199/);
    // The placeholders are one run, one line.
    expect(view.tailLines[0]).toBe(`0..${view.missing - 1}|(${view.missing} messages not summarized yet: zoom each, n: 1)`);
    expect(runLine(7, 7)).toBe(`7+1|${PLACEHOLDER}`);
    expect(view.missing).toBeGreaterThan(MAX_MISSING);
    const raw = view.tailLines.slice(1);
    expect(raw.reduce((sum, l) => sum + Buffer.byteLength(l) + 1, 0)).toBeLessThanOrEqual(RAW_BYTES);
  });
});

describe("W240 turn framing", () => {
  it("puts the view first, then the time, then the new message after a fixed header", () => {
    const at = Date.UTC(2026, 9, 8, 9, 22);
    expect(turnMessage(at, "W12 reported")).toBe("Now: 2026-10-08 09:22 UTC.\n\nNew message:\nW12 reported");
    expect(turnMessage(at, "[W12] done", ["5+1|coord: ok"])).toBe("<chat>\n5+1|coord: ok\n</chat>\n\nNow: 2026-10-08 09:22 UTC.\n\nNew message:\n[W12] done");
    expect(turnSystem(["0+4|user: hi"])).toBe(`${TURN_PROMPT}\n\n<chat>\n0+4|user: hi\n</chat>`);
    // W216's fixes: the message never takes a compaction's kind: form, and zooming comes first.
    expect(TURN_PROMPT).toContain('Answer that message, and only it');
    expect(TURN_PROMPT).toContain("When unsure whether a line holds what you need, zoom");
    expect(TURN_PROMPT).not.toMatch(/Compaction:|<input>/);
    const handover = handoverMessage(at, "Back to normal?", ["0+1|user: hi"]);
    expect(handover).toMatch(/^# Memory \(OptChat handover\)[\s\S]*<chat>\n0\+1\|user: hi\n<\/chat>\n\nNow: 2026-10-08 09:22 UTC\.\n\nNew message:\nBack to normal\?$/);
  });
});

type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
let seq = 900_000;
let at = 1_790_000_000_000;
/** The user sends a message: BB records its request; returns the request's id. */
const say = (f: Fx, threadId: string, text: string) => {
  const requestId = `creq_${seq + 1}`;
  f.history.push({ type: "client/turn/requested", seq: ++seq, createdAt: ++at, threadId, data: { direction: "outbound", source: "tell", initiator: "user", requestId, input: [{ type: "text", text }] } } as never);
  return requestId;
};
const reply = (f: Fx, threadId: string, text: string) =>
  f.history.push({ type: "item/completed", seq: ++seq, createdAt: ++at, threadId, data: { item: { type: "agentMessage", id: `i${seq}`, text } } } as never);
const idles = async (f: Fx) => {
  await f.runtime.onThreadIdle(f.idle("coordinator"));
  await f.service.memory.settled();
};
const fakeLuna: Summarizer = async (r: SummarizerRequest) => {
  const task = (r.input[0]!.content[1] as { text: string }).text;
  const name = /compress message (\d+)/.exec(task)?.[1] ?? /merge lines (\d+\+\d+ and \d+\+\d+)/.exec(task)![1];
  return { ok: true, text: `summary of ${name}`, usage: { input: 2000, cached: 1500, output: 100, reasoning: 50 }, latencyMs: 1 };
};
type Report = { requestId: string; offeredSessionId: string | null; outcome: "fresh" | "resident" | "failed"; sessionId: string };
/** By thread: what BB's Claude Code bridge knows, the session it runs and the reports no answer has acknowledged. */
const bridges = new Map<string, { sessionId: string; reports: Report[] }>();
beforeEach(() => bridges.clear());
type Answer = { ack?: string; session?: string; sessionId?: string; systemPrompt?: string; input?: string };
/**
 * What BB's Claude Code bridge asks before a turn, once the user's message is requested: the
 * turn's text and request, the session it runs in, and what became of its earlier asks until an
 * answer acknowledges them. The bridge applies a fresh answer unless `dropped` (no answer in
 * time, so no acknowledgement either), `failed` (its session failed to start) or `cancelled`
 * (the turn never ran). Returns the answer without its acknowledgement.
 */
const turn = async (
  f: Fx,
  text: string,
  { threadId = "coordinator", requestId = say(f, threadId, text), dropped = false, failed = false, cancelled = false } = {},
) => {
  const bridge = bridges.get(threadId) ?? { sessionId: `resident-${threadId}`, reports: [] };
  bridges.set(threadId, bridge);
  const ask = { protocol: 3, input: text, requestId, sessionId: bridge.sessionId, reports: bridge.reports };
  const { ack, ...answer } = JSON.parse((await f.harness.callAgentTool(TURN_CONTEXT_TOOL, ask, { threadId })) as string) as Answer;
  const acked = dropped ? -1 : bridge.reports.findIndex((r) => r.requestId === ack);
  bridge.reports = bridge.reports.slice(acked + 1);
  const fresh = answer.session === "fresh" && !dropped;
  if (cancelled) return answer;
  if (fresh && !failed) {
    bridge.sessionId = answer.sessionId!;
    bridge.reports.push({ requestId, offeredSessionId: answer.sessionId!, outcome: "fresh", sessionId: answer.sessionId! });
  } else bridge.reports.push({ requestId, offeredSessionId: fresh ? answer.sessionId! : null, outcome: fresh ? "failed" : "resident", sessionId: bridge.sessionId });
  return answer;
};
/** A raw call of the tool, as the bridge or a model would make it. */
const call = async (f: Fx, args: Record<string, unknown>, threadId = "coordinator") =>
  JSON.parse((await f.harness.callAgentTool(TURN_CONTEXT_TOOL, args, { threadId })) as string) as Answer;

async function optchat() {
  const { f, project } = await projectFixture();
  f.service.memory.useSummarizer(fakeLuna);
  for (let n = 0; n < 4; n++) {
    say(f, "coordinator", `Ask ${n}: ${"q".repeat(600)}`);
    reply(f, "coordinator", `Answer ${n}`);
  }
  await f.perform(project.id, { action: "memory", mode: "optchat" }, "user", null);
  await idles(f);
  return { f, project };
}

describe("W240 optchat turns", () => {
  it("lets a regular or hybrid coordinator's session go on", async () => {
    const { f, project } = await projectFixture();
    expect(await turn(f, "Hello")).toEqual({});
    await f.perform(project.id, { action: "memory", mode: "hybrid" }, "user", null);
    expect(await turn(f, "Hello again")).toEqual({});
    await f.service.memory.settled();
  });

  it("runs an optchat turn in a fresh session: the view's older lines in the system prompt, the newest, the time and the message first", async () => {
    const { f, project } = await optchat();
    const context = await turn(f, "What did I ask first?");
    expect(context.session).toBe("fresh");
    expect(context.systemPrompt).toContain(TURN_PROMPT);
    expect(context.systemPrompt).toMatch(/<chat>\n0\+\d+\|[\s\S]*\n<\/chat>$/);
    // The new message is the turn's, never a line of the view.
    expect(context.input).toMatch(/(^|\n)Now: \d{4}-\d\d-\d\d \d\d:\d\d UTC\.\n\nNew message:\nWhat did I ask first\?$/);
    expect(`${context.systemPrompt}\n${context.input}`.match(/What did I ask first/g)).toHaveLength(1);
    expect(f.service.memory.status(project.id).optchat).toEqual({ turns: 1, fallbacks: 0, lastFallback: null });
    // Zoom reads the log whole, whatever the view shows.
    expect(await f.harness.callAgentTool("initiative_zoom", { id: 0, n: 1 }, { threadId: "coordinator" })).toMatch(/^user: Ask 0: q+$/);
    await f.service.memory.settled();
  });

  it("keeps the system prompt the same across turns while the view only grows", async () => {
    const { f } = await optchat();
    const first = await turn(f, "First");
    reply(f, "coordinator", "Reply to first");
    await idles(f);
    const second = await turn(f, "Second");
    expect(second.systemPrompt).toBe(first.systemPrompt);
    expect(second.input).toContain("|user: First");
    expect(second.input).toContain("|coord: Reply to first");
    await f.service.memory.settled();
  });

  it("hands a coordinator that leaves optchat the whole view once, then lets its new session go on, and back", async () => {
    const { f, project } = await optchat();
    await turn(f, "In optchat");
    await f.perform(project.id, { action: "memory", mode: "hybrid" }, "user", null);
    const handover = await turn(f, "Now hybrid");
    expect(handover).toMatchObject({ session: "fresh", systemPrompt: "" });
    expect(handover.input).toMatch(/^# Memory \(OptChat handover\)[\s\S]*<chat>\n0\+[\s\S]*\|user: In optchat[\s\S]*New message:\nNow hybrid$/);
    expect(await turn(f, "Still hybrid")).toEqual({});
    // Logged once the provider reports the handover's session ran.
    expect(f.store.activity(project.id, 10).map((a) => a.summary)).toContain("Coordinator memory: the coordinator left OptChat for a regular session, handed its memory view");
    await f.perform(project.id, { action: "memory", mode: "optchat" }, "user", null);
    expect((await turn(f, "Optchat again")).session).toBe("fresh");
    await f.service.memory.settled();
  });

  it("runs the turn as hybrid, and logs it, when the view is unavailable", async () => {
    const { f, project } = await optchat();
    const memory = f.service.memory as unknown as { tree: () => unknown };
    const spy = vi.spyOn(memory, "tree").mockImplementation(() => {
      throw new Error("tree store unreadable");
    });
    expect(await turn(f, "Are you there?")).toEqual({});
    spy.mockRestore();
    expect(f.service.memory.status(project.id).optchat).toMatchObject({ fallbacks: 1, lastFallback: "tree store unreadable" });
    expect(f.store.activity(project.id, 10).map((a) => a.summary)).toContain("Coordinator memory: an OptChat turn of the coordinator ran as hybrid (tree store unreadable)");
    expect((await turn(f, "And now?")).session).toBe("fresh");
    await f.service.memory.settled();
  });

  it("runs as hybrid while too many recent messages have no line, rather than a view of placeholders", async () => {
    const { f, project } = await projectFixture();
    // A summarizer that never answers: nothing gets a line.
    f.service.memory.useSummarizer(() => new Promise(() => {}));
    for (let n = 0; n < 60; n++) say(f, "coordinator", `Long ${n}: ${"z".repeat(3000)}`);
    await f.perform(project.id, { action: "memory", mode: "optchat" }, "user", null);
    await f.runtime.onThreadIdle(f.idle("coordinator"));
    expect(await turn(f, "Hi")).toEqual({});
    expect(f.service.memory.status(project.id).optchat.lastFallback).toMatch(/recent messages have no summary yet/);
    f.service.memory.dispose();
  });

  it("is a coordinator's: other threads' sessions go on", async () => {
    const { f, project } = await optchat();
    const [w] = JSON.parse((await f.harness.callAgentTool("initiative_spawn", { label: "Search", purpose: "search", text: "Do it." }, { threadId: "coordinator" })) as string);
    expect(await turn(f, "hello", { threadId: w.threadId })).toEqual({});
    expect(f.service.memory.status(project.id).optchat.turns).toBe(0);
    await f.service.memory.settled();
  });

  it("gives the turn context tool to Claude Code coordinators only", async () => {
    const { f } = await projectFixture();
    const tools = async (provider: string) =>
      (await f.harness.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: f.threads.get("coordinator")!, provider: { id: provider } as never }))).tools.map((t) => t.name);
    expect(await tools("claude-code")).toEqual(expect.arrayContaining([TURN_CONTEXT_TOOL, "initiative_zoom", "initiative_date"]));
    expect(await tools("codex")).not.toContain(TURN_CONTEXT_TOOL);
  });
});

describe("W240 compaction", () => {
  it("never compacts an optchat session, but compacts a coordinator that runs as hybrid", async () => {
    const { f, project } = await optchat();
    expect(f.service.memory.compactLimit(project.id, "coordinator")).toBe(150_000);
    // The plugin learns which session runs from the next turn's ask.
    await turn(f, "Hi");
    await turn(f, "Again");
    expect(f.service.memory.compactLimit(project.id, "coordinator")).toBe(0);
    expect(f.service.memory.compactLimit(project.id)).toBe(150_000);
    await f.perform(project.id, { action: "memory", mode: "hybrid" }, "user", null);
    await turn(f, "Handed over");
    await turn(f, "In the regular session");
    expect(f.service.memory.compactLimit(project.id, "coordinator")).toBe(150_000);
    await f.service.memory.settled();
  });
});

describe("W245 review fixes", () => {
  it("never cuts a merged line through the new message: it opens into the lines before it", () => {
    const nodes = new Map([[key(0, 0), "L0"], [key(0, 1), "L1"], [key(0, 2), "L2"], [key(1, 0), "M01"], [key(1, 1), "M23"], [key(2, 0), "M0123"]]);
    const input = { fed: 4, nodes, message: () => null, frozen: null };
    const view = turnView({ ...input, chat: [[2, 0]], cut: 3 });
    expect([...view.frozenLines, ...view.tailLines]).toEqual(["0+2|M01", "2+1|L2"]);
    expect(turnView({ ...input, chat: [[1, 0]], fed: 2, cut: 1 }).frozenLines).toEqual(["0+1|L0"]);
  });

  it("cuts the view at the turn's own request, not a later one", async () => {
    const { f } = await optchat();
    const first = say(f, "coordinator", "First request");
    say(f, "coordinator", "Queued second request");
    const context = await turn(f, "First request", { requestId: first });
    expect(context.session).toBe("fresh");
    expect(`${context.systemPrompt}\n${context.input}`.match(/First request/g)).toHaveLength(1);
    expect(`${context.systemPrompt}\n${context.input}`).not.toContain("Queued second request");
    await f.service.memory.settled();
  });

  it("runs as hybrid, never fresh over a stale view, when the log cannot read through the turn", async () => {
    const { f, project } = await optchat();
    say(f, "coordinator", "Previous decision: keep the customer data");
    const memory = f.service.memory as unknown as { deps: { list: (args: { types: string[] }) => Promise<unknown> } };
    const list = memory.deps.list;
    memory.deps.list = async (args) => {
      if (args.types.length === 1 && args.types[0] === "client/turn/requested") return list(args);
      throw new Error("thread event read failed");
    };
    expect(await turn(f, "Continue")).toEqual({});
    memory.deps.list = list;
    expect(f.service.memory.status(project.id).optchat).toMatchObject({ fallbacks: 1, lastFallback: expect.stringMatching(/not caught up/) });
    // Read through again: fresh, with the decision in view.
    const context = await turn(f, "Continue again");
    expect(context.session).toBe("fresh");
    expect(`${context.systemPrompt}\n${context.input}`).toContain("Previous decision");
    await f.service.memory.settled();
  });

  it("is harmless when a model calls it as an ordinary tool (a provider that doesn't hide it)", async () => {
    const { f, project } = await optchat();
    await turn(f, "Start");
    await turn(f, "Next");
    expect(f.service.memory.compactLimit(project.id, "coordinator")).toBe(0);
    const ordinary = await f.harness.callAgentTool(TURN_CONTEXT_TOOL, { input: "what is this tool?" }, { threadId: "coordinator" });
    expect(ordinary).toBe("{}");
    expect(f.service.memory.status(project.id).optchat.turns).toBe(2);
    expect(f.service.memory.compactLimit(project.id, "coordinator")).toBe(0);
    // Nor does it start optchat's compaction exemption for a coordinator that never ran one.
    const other = await projectFixture();
    await other.f.perform(other.project.id, { action: "memory", mode: "optchat" }, "user", null);
    expect(await other.f.harness.callAgentTool(TURN_CONTEXT_TOOL, { input: "hi" }, { threadId: "coordinator" })).toBe("{}");
    expect(other.f.service.memory.compactLimit(other.project.id, "coordinator")).toBe(150_000);
    await f.service.memory.settled();
    await other.f.service.memory.settled();
  });

  it("never counts a session as optchat until the provider reports it runs", async () => {
    const { f, project } = await optchat();
    expect((await turn(f, "Lost", { dropped: true })).session).toBe("fresh");
    await turn(f, "Next");
    // The dropped answer's session never ran: the resident one is still a regular session.
    expect(f.service.memory.compactLimit(project.id, "coordinator")).toBe(150_000);
    await turn(f, "Then");
    expect(f.service.memory.compactLimit(project.id, "coordinator")).toBe(0);
    await f.service.memory.settled();
  });

  it("hands over again when a handover answer is dropped", async () => {
    const { f, project } = await optchat();
    await turn(f, "In optchat");
    await f.perform(project.id, { action: "memory", mode: "regular" }, "user", null);
    expect((await turn(f, "Dropped", { dropped: true })).session).toBe("fresh");
    const handover = await turn(f, "Actual next turn");
    expect(handover).toMatchObject({ session: "fresh", systemPrompt: "" });
    expect(handover.input).toMatch(/^# Memory \(OptChat handover\)/);
    expect(await turn(f, "Regular from here")).toEqual({});
    await f.service.memory.settled();
  });

  it("hands over to regular during a summary backlog, its unsummarized run as one line", async () => {
    const { f, project } = await optchat();
    await turn(f, "Start optchat");
    f.service.memory.useSummarizer(() => new Promise(() => {}));
    for (let n = 0; n < 60; n++) say(f, "coordinator", `Previous long message ${n}: ${"x".repeat(3000)}`);
    await f.perform(project.id, { action: "memory", mode: "regular" }, "user", null);
    const handover = await turn(f, "Back to regular");
    expect(handover.session).toBe("fresh");
    expect(handover.input).toMatch(/\n\d+\.\.\d+\|\(\d+ messages not summarized yet: zoom each, n: 1\)\n/);
    expect(handover.input).toContain("Previous long message 59");
    expect(await turn(f, "Regular from here")).toEqual({});
    f.service.memory.dispose();
  });

  it("compacts an optchat session that ran a turn as hybrid, and still hands it over on leaving", async () => {
    const { f, project } = await optchat();
    await turn(f, "Optchat");
    const memory = f.service.memory as unknown as { tree: () => unknown };
    const spy = vi.spyOn(memory, "tree").mockImplementation(() => {
      throw new Error("tree unavailable");
    });
    expect(await turn(f, "Hybrid fallback")).toEqual({});
    spy.mockRestore();
    expect(f.service.memory.compactLimit(project.id, "coordinator")).toBe(150_000);
    await f.perform(project.id, { action: "memory", mode: "hybrid" }, "user", null);
    expect((await turn(f, "Leaving")).input).toMatch(/^# Memory \(OptChat handover\)/);
    await f.service.memory.settled();
  });
});

describe("W250: the bridge reports what became of each ask", () => {
  it("compacts an optchat session again, and counts the fallback, once the bridge reports it dropped or failed a fresh answer", async () => {
    const { f, project } = await optchat();
    await turn(f, "Start optchat");
    await turn(f, "Times out: runs in the optchat session", { dropped: true });
    expect(f.service.memory.compactLimit(project.id, "coordinator")).toBe(0);
    await turn(f, "Its session fails to start", { failed: true });
    expect(f.service.memory.compactLimit(project.id, "coordinator")).toBe(150_000);
    expect(f.service.memory.status(project.id).optchat).toMatchObject({ fallbacks: 1, lastFallback: expect.stringMatching(/no answer in time/) });
    expect((await turn(f, "Applied again")).session).toBe("fresh");
    expect(f.service.memory.status(project.id).optchat).toMatchObject({ fallbacks: 2, lastFallback: expect.stringMatching(/failed to start/) });
    await turn(f, "In the new session");
    expect(f.service.memory.compactLimit(project.id, "coordinator")).toBe(0);
    expect(f.service.memory.status(project.id).optchat.fallbacks).toBe(2);
    await f.service.memory.settled();
  });

  it("consumes the exit handover only once the bridge reports a fresh regular session ran", async () => {
    const { f, project } = await optchat();
    await turn(f, "In optchat");
    await f.perform(project.id, { action: "memory", mode: "regular" }, "user", null);
    expect((await turn(f, "Its session fails to start", { failed: true })).session).toBe("fresh");
    expect((await turn(f, "Interrupted before it ran", { cancelled: true })).session).toBe("fresh");
    expect(f.store.activity(project.id, 10).map((a) => a.summary)).not.toContain("Coordinator memory: the coordinator left OptChat for a regular session, handed its memory view");
    const handover = await turn(f, "Actual next turn");
    expect(handover.input).toMatch(/^# Memory \(OptChat handover\)/);
    expect(await turn(f, "Regular from here")).toEqual({});
    expect(f.store.activity(project.id, 10).map((a) => a.summary).filter((s) => /left OptChat/.test(s))).toHaveLength(1);
    expect(f.service.memory.compactLimit(project.id, "coordinator")).toBe(300_000);
    // The failed handover ran a regular turn; the interrupted one ran nothing.
    expect(f.service.memory.status(project.id).optchat.fallbacks).toBe(1);
    await f.service.memory.settled();
  });

  it("ignores, changing nothing, a call without protocol 3 or with an unknown, older or inconsistent request", async () => {
    const { f, project } = await optchat();
    const older = say(f, "coordinator", "An older request");
    await turn(f, "Enter optchat");
    await turn(f, "Second optchat turn", { dropped: true });
    const optchatSession = bridges.get("coordinator")!.sessionId;
    expect(f.service.memory.compactLimit(project.id, "coordinator")).toBe(0);
    const before = { ...f.service.memory.status(project.id).optchat };
    const latest = say(f, "coordinator", "The latest request");
    for (const args of [
      { input: "visible ordinary tool" },
      { input: "x", requestId: latest, sessionId: "not-the-provider-session", reports: [] },
      { protocol: 2, input: "x", requestId: latest, sessionId: "not-the-provider-session", reports: [] },
      { protocol: 3, input: "x", requestId: "creq_does_not_exist", sessionId: "not-the-provider-session", reports: [] },
      { protocol: 3, input: "x", requestId: older, sessionId: optchatSession, reports: [] },
    ]) expect(await call(f, args)).toEqual({});
    // Reports the provider never sends are acknowledged, so they never come again, and change nothing.
    for (const reports of [
      [{ requestId: latest, offeredSessionId: "other", outcome: "fresh", sessionId: "other" }],
      [{ requestId: older, offeredSessionId: "a", outcome: "fresh", sessionId: "b" }],
      [{ requestId: older, offeredSessionId: null, outcome: "resident", sessionId: "elsewhere" }],
    ]) expect(await call(f, { protocol: 3, input: "x", requestId: latest, sessionId: "other", reports })).toEqual({ ack: reports[0]!.requestId });
    expect(f.service.memory.compactLimit(project.id, "coordinator")).toBe(0);
    expect(f.service.memory.status(project.id).optchat).toEqual(before);
    // The real optchat session is still known: leaving optchat hands it over.
    await f.perform(project.id, { action: "memory", mode: "regular" }, "user", null);
    expect((await turn(f, "Real next turn")).input).toMatch(/^# Memory \(OptChat handover\)/);
    await f.service.memory.settled();
  });

  it("never lets a call acknowledge the session it was offered", async () => {
    const { f, project } = await optchat();
    const requestId = say(f, "coordinator", "Ordinary visible-tool request");
    const offered = await call(f, { protocol: 3, input: "ordinary", requestId, sessionId: "resident-coordinator", reports: [] });
    expect(offered.session).toBe("fresh");
    const report = { requestId, offeredSessionId: offered.sessionId, outcome: "fresh", sessionId: offered.sessionId };
    expect(await call(f, { protocol: 3, input: "ordinary", requestId, sessionId: offered.sessionId, reports: [report] })).toEqual({ ack: requestId });
    await call(f, { protocol: 3, input: "ordinary", requestId, sessionId: offered.sessionId, reports: [] });
    expect(f.service.memory.compactLimit(project.id, "coordinator")).toBe(150_000);
    await f.service.memory.settled();
  });

  it("finds the turn's request behind more steers than a page of requests", async () => {
    const { f, project } = await optchat();
    const active = say(f, "coordinator", "Active request");
    for (let i = 0; i < 120; i++) say(f, "coordinator", `Steered correction ${i}`);
    const context = await turn(f, "Active request", { requestId: active });
    expect(context.session).toBe("fresh");
    expect(`${context.systemPrompt}\n${context.input}`).not.toContain("Steered correction");
    expect(f.service.memory.status(project.id).optchat.fallbacks).toBe(0);
    await f.service.memory.settled();
  });
});

describe("W253: a report stays with the bridge until an answer acknowledges it", () => {
  it("hands over after one failed request read: the bridge sends the unread report again with the next ask", async () => {
    const { f, project } = await optchat();
    await turn(f, "First OptChat turn");
    await turn(f, "Second OptChat turn");
    const applied = bridges.get("coordinator")!.sessionId;
    await f.perform(project.id, { action: "memory", mode: "regular" }, "user", null);
    const memory = f.service.memory as unknown as { deps: { list: (args: { types: string[] }) => Promise<unknown> } };
    const list = memory.deps.list;
    memory.deps.list = async (args) => {
      if (args.types.length === 1 && args.types[0] === "client/turn/requested") throw new Error("one transient request read error");
      return list(args);
    };
    expect(await turn(f, "Exit during the read error")).toEqual({});
    memory.deps.list = list;
    // Unacknowledged: the applied OptChat turn's report, then the exit turn that ran in its session.
    expect(bridges.get("coordinator")!.reports.map((r) => [r.outcome, r.sessionId])).toEqual([["fresh", applied], ["resident", applied]]);
    const handover = await turn(f, "Exit after read recovery");
    expect(handover).toMatchObject({ session: "fresh", systemPrompt: "" });
    expect(handover.input).toMatch(/^# Memory \(OptChat handover\)[\s\S]*New message:\nExit after read recovery$/);
    expect(await turn(f, "Regular from here")).toEqual({});
    expect(f.store.activity(project.id, 30).map((a) => a.summary).filter((s) => /left OptChat/.test(s))).toHaveLength(1);
    expect(f.service.memory.compactLimit(project.id, "coordinator")).toBe(300_000);
    await f.service.memory.settled();
  });

  it("takes a report sent again, its acknowledgement lost, only once", async () => {
    const { f, project } = await optchat();
    await turn(f, "Start");
    // The answer is lost: the turn runs in the optchat session, and both reports come again.
    await turn(f, "Answer lost", { dropped: true });
    expect(bridges.get("coordinator")!.reports).toHaveLength(2);
    expect((await turn(f, "Next")).session).toBe("fresh");
    expect(bridges.get("coordinator")!.reports).toHaveLength(1);
    expect(f.service.memory.status(project.id).optchat).toMatchObject({ turns: 3, fallbacks: 1 });
    await f.perform(project.id, { action: "memory", mode: "regular" }, "user", null);
    expect((await turn(f, "Leave")).input).toMatch(/^# Memory \(OptChat handover\)/);
    expect(await turn(f, "Answer lost again", { dropped: true })).toEqual({});
    expect(await turn(f, "Regular from here")).toEqual({});
    expect(f.store.activity(project.id, 30).map((a) => a.summary).filter((s) => /left OptChat/.test(s))).toHaveLength(1);
    expect(f.service.memory.status(project.id).optchat).toMatchObject({ turns: 3, fallbacks: 1 });
    expect(f.service.memory.compactLimit(project.id, "coordinator")).toBe(300_000);
    await f.service.memory.settled();
  });
});
