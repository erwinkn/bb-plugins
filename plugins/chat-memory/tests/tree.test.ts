import { describe, expect, it } from "vitest";
import { TreeBuilder, type NodeHow, type TreeStore } from "../lib/builder";
import { eventEntries, splitEntry, type MemoryKind } from "../lib/log";
import { readEvents } from "../lib/ingest";
import { responsesSummarizer, usageCost, type Summarizer, type SummarizerRequest, type SummarizerResult } from "../lib/summarizer";
import { LIMIT, VIEW_BYTES, bytes, emptyViews, feed, key, label, mergeOnce, viewBytes, type NodeRef, type Views } from "../lib/tree";

// W220 (D431), moved with T145: a chat memory's tree, as the OptChat gist and W216 build it, against a
// fake summarizer: merge order, the 128→64 KB sawtooth, the "Too long" retries, cancellation,
// rate limits and the fallback that keeps one bad message from blocking the tree.

type Message = { kind: MemoryKind; text: string };
function memoryStore(messages: Message[]) {
  const saved = { nodes: new Map<string, { text: string; how: NodeHow; tries: number }>(), views: [] as Views[], calls: 0 };
  const store: TreeStore = {
    messageCount: () => messages.length,
    message: (i) => messages[i] ?? null,
    node: (l, i) => saved.nodes.get(key(l, i))?.text ?? null,
    built: (l, from, to) => [...saved.nodes.keys()].map((k) => k.split(":").map(Number) as NodeRef).filter(([nl, i]) => nl === l && i >= from && i < to).map(([, i]) => i),
    saveNode: (l, i, text, how, tries) => void saved.nodes.set(key(l, i), { text, how, tries }),
    saveViews: (views) => void saved.views.push(structuredClone(views)),
    recordCall: () => void saved.calls++,
  };
  return { store, saved };
}
const usage = { input: 1000, cached: 800, output: 50, reasoning: 20 };
/** The node a task names, as its label. */
const target = (r: SummarizerRequest) => {
  const task = (r.input[0]!.content[1] as { text: string }).text;
  const compress = /compress message (\d+)/.exec(task);
  if (compress) return `${compress[1]}+1`;
  const merge = /merge lines (\d+)\+(\d+) and/.exec(task)!;
  return `${merge[1]}+${2 * Number(merge[2])}`;
};
/** A line of `size` bytes naming its node. */
const line = (r: SummarizerRequest, size = 500) => `L${target(r)} `.padEnd(size, "x");
const ok = (text: string): SummarizerResult => ({ ok: true, text, usage, latencyMs: 1 });
const builder = (store: TreeStore, summarize: Summarizer, extra: Partial<ConstructorParameters<typeof TreeBuilder>[2]> = {}, views = emptyViews()) =>
  new TreeBuilder(store, views, { summarize, instructions: () => "system", effort: () => "xhigh", concurrency: () => 8, cacheKey: "k", backoff: { min: 5, max: 20, unavailable: 30 }, ...extra });
const long = (n: number, size = 700): Message[] => Array.from({ length: n }, (_, i) => ({ kind: i % 2 ? "agent" : "user", text: `message ${i} `.padEnd(size, "y") }));
const treeSize = (n: number) => {
  let total = 0;
  for (let size = 1; size <= n; size *= 2) total += Math.floor(n / size);
  return total;
};

describe("W220 tree addressing and merge order", () => {
  it("labels nodes id+n and merges the most due pair, due = (T+1)/2^l − i", () => {
    expect(label([3, 5])).toBe("40+8");
    const built = new Map([[key(2, 0), "a"], [key(1, 2), "b"], [key(1, 3), "c"]]);
    // Pairs: 0+2|2+2 (due 9/2−0 = 4.5), 4+1|5+1 (due 9−4 = 5), 6+1|7+1 (due 9−6 = 3).
    const view: NodeRef[] = [[1, 0], [1, 1], [0, 4], [0, 5], [0, 6], [0, 7]];
    expect(mergeOnce(view, 8, built)).toBe(true);
    expect(view).toEqual([[1, 0], [1, 1], [1, 2], [0, 6], [0, 7]]);
    // Ties go to the oldest pair; a pair whose parent is unbuilt never merges.
    const tie: NodeRef[] = [[0, 0], [0, 1], [0, 2], [0, 3]];
    expect(mergeOnce(tie, 3, new Map([[key(1, 1), "x"]]))).toBe(true);
    expect(tie).toEqual([[0, 0], [0, 1], [1, 1]]);
    expect(mergeOnce([[0, 0], [0, 1]], 2, new Map())).toBe(false);
  });
});

describe("W220 tree builder", () => {
  it("builds every node of the tree once, with free lines for what already fits", async () => {
    const messages: Message[] = [...long(6), { kind: "user", text: "short" }, { kind: "work", text: "[W1] done" }, ...long(2)];
    const { store, saved } = memoryStore(messages);
    let calls = 0;
    const b = builder(store, async (r) => (calls++, ok(line(r, 200))));
    await b.run(new AbortController().signal);
    expect(saved.nodes.size).toBe(treeSize(10));
    expect(saved.nodes.get(key(0, 6))).toMatchObject({ text: "user: short", how: "free" });
    // 6+1 and 7+1 fit together in one line: their parent needs no call either.
    expect(saved.nodes.get(key(1, 3))).toMatchObject({ text: "user: short\nwork: [W1] done", how: "free" });
    expect(calls).toBe(saved.calls);
    expect(b.status.state).toBe("idle");
  });

  it("keeps the chat view on its 128→64 KB sawtooth and the memory view under 32 KB", async () => {
    const { store, saved } = memoryStore(long(900));
    const b = builder(store, async (r) => ok(line(r)));
    await b.run(new AbortController().signal);
    expect(saved.nodes.size).toBe(treeSize(900));
    const sizes = saved.views.map((v) => ({ chat: viewBytes(v.chat, b.nodes), memory: viewBytes(v.compaction, b.nodes), merging: v.merging }));
    // A batch merges only pairs whose parent is built, so a view passes its limit by at most the
    // lines still being built (8 at once, up to 512 bytes each).
    const slack = 9 * (LIMIT + 20);
    expect(Math.max(...sizes.map((s) => s.chat))).toBeLessThanOrEqual(VIEW_BYTES.chat[0] + slack);
    expect(Math.max(...sizes.map((s) => s.memory))).toBeLessThanOrEqual(VIEW_BYTES.compaction[0] + slack);
    // Batches ran (one per ~128 messages here) and each ended near 64 KB: a batch measures lines
    // still being built at their placeholder's size. Between batches the view only grows at its end.
    const batches = sizes.filter((s, k) => k > 0 && s.chat < sizes[k - 1]!.chat);
    expect(batches.length).toBeGreaterThanOrEqual(4);
    for (const s of batches) expect(s.chat).toBeLessThanOrEqual(VIEW_BYTES.chat[1] + slack);
    const view = b.views.chat;
    for (let k = 1; k < view.length; k++) expect(view[k]![1] * 2 ** view[k]![0]).toBe((view[k - 1]![1] + 1) * 2 ** view[k - 1]![0]);
    expect(b.views.fed).toBe(900);
  });

  it("retries a line over 512 bytes in the same conversation and keeps the shortest", async () => {
    const { store, saved } = memoryStore(long(1));
    const requests: SummarizerRequest[] = [];
    const sizes = [700, 600, 650, 610, 620];
    const b = builder(store, async (r) => (requests.push(r), ok(line(r, sizes[requests.length - 1]))));
    await b.run(new AbortController().signal);
    expect(requests).toHaveLength(5);
    expect(saved.nodes.get(key(0, 0))).toMatchObject({ how: "model", tries: 5 });
    expect(bytes(saved.nodes.get(key(0, 0))!.text)).toBe(600);
    const retry = requests[1]!.input;
    expect(retry).toHaveLength(3);
    expect(retry[1]).toMatchObject({ role: "assistant" });
    expect((retry[2]!.content[0] as { text: string }).text).toMatch(/^Too long: your line is 700 bytes, over the 512-byte limit\. Write the whole line again for the same <input> in at most 384 bytes/);
    // The first task carries the ruler and the message as kind: text.
    const task = (requests[0]!.input[0]!.content[1] as { text: string }).text;
    expect(task).toContain("-".repeat(512));
    expect(task).toContain("<input>\nuser: message 0");
  });

  it("stops at the first line that fits", async () => {
    const { store, saved } = memoryStore(long(1));
    let n = 0;
    const b = builder(store, async (r) => ok(line(r, ++n === 1 ? 600 : 400)));
    await b.run(new AbortController().signal);
    expect(n).toBe(2);
    expect(bytes(saved.nodes.get(key(0, 0))!.text)).toBe(400);
  });

  it("gives a merge its context: the memory view up to the node, and the two lines", async () => {
    const { store } = memoryStore(long(4));
    const tasks: string[] = [];
    const b = builder(store, async (r) => (tasks.push(r.input[0]!.content.map((c) => (c as { text: string }).text).join("")), ok(line(r, 300))));
    await b.run(new AbortController().signal);
    const merge = tasks.find((t) => t.includes("merge lines 0+2 and 2+2"))!;
    expect(merge).toMatch(/^<chat>\n0\+1\|L0\+1 /);
    expect(merge).toContain("<chat> may hold their messages, 0 to 3, in more detail");
    expect(merge).toMatch(/<input>\n0\+2\|L0\+2 x+\n2\+2\|L2\+2 x+\n<\/input>$/);
  });

  it("cancels calls in flight on abort, keeps what was built, and goes on in the next run", async () => {
    const { store, saved } = memoryStore(long(12));
    const controller = new AbortController();
    let started = 0;
    const hanging: Summarizer = (r) => {
      started++;
      return new Promise((resolve) => r.signal.addEventListener("abort", () => resolve({ ok: false, reason: "aborted", error: "aborted" }), { once: true }));
    };
    const b = builder(store, hanging);
    const run = b.run(controller.signal);
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toBe(8);
    controller.abort();
    await run;
    expect(saved.nodes.size).toBe(0);
    b["options"].summarize = async (r) => ok(line(r, 300));
    await b.run(new AbortController().signal);
    expect(saved.nodes.size).toBe(treeSize(12));
  });

  it("backs off on 429 and pauses on an unavailable route, then goes on", async () => {
    const { store, saved } = memoryStore(long(2));
    const answers: SummarizerResult[] = [
      { ok: false, reason: "rate-limited", error: "429 slow down", retryAfterMs: 15 },
      { ok: false, reason: "unavailable", error: "403 advisor route for codex is off" },
    ];
    const states: string[] = [];
    const sample = () => setTimeout(() => states.push(b.status.state), 5);
    const b = builder(store, async (r) => (sample(), answers.shift() ?? ok(line(r, 300))), { concurrency: () => 1, backoff: { min: 40, max: 80, unavailable: 60 } });
    await b.run(new AbortController().signal);
    expect(states.slice(0, 2)).toEqual(["backoff", "unavailable"]);
    expect(saved.nodes.size).toBe(treeSize(2));
    expect(b.status.state).toBe("idle");
  });

  it("leaves a node that failed three times unbuilt and failed, and tries it again later (D458)", async () => {
    const { store, saved } = memoryStore(long(4));
    let now = 0;
    let calls = 0;
    const b = builder(store, async (r) => (target(r) === "1+1" ? (calls++, { ok: false, reason: "failed", error: "400 bad request" }) : ok(line(r, 300))), { now: () => now });
    await b.run(new AbortController().signal);
    expect(calls).toBe(3);
    expect(saved.nodes.has(key(0, 1))).toBe(false);
    expect([...saved.nodes.values()].some((n) => n.how === "fallback")).toBe(false);
    // Its parent waits; the rest of the tree builds.
    expect(saved.nodes.has(key(1, 0))).toBe(false);
    expect(saved.nodes.get(key(1, 1))).toMatchObject({ how: "model" });
    expect(b.failedBefore(2)).toEqual({ i: 1, error: "400 bad request" });
    expect(b.failedBefore(1)).toBeNull();
    // Not before its wait is over; then three more tries.
    await b.run(new AbortController().signal);
    expect(calls).toBe(3);
    now += 30 * 60_000;
    await b.run(new AbortController().signal);
    expect(calls).toBe(6);
  });

  it("builds a line whose three replies were empty as a fallback cut to fit, and lets a waiting turn go on", async () => {
    // Multi-byte characters across the cut: it must land on a character boundary.
    const messages: Message[] = [{ kind: "user", text: "é".repeat(600) }, ...long(1)];
    const { store, saved } = memoryStore(messages);
    const logs: string[] = [];
    let calls = 0;
    const b = builder(store, async (r) => (target(r) === "0+1" ? (calls++, ok("  ")) : ok(line(r, 300))), { log: (m) => logs.push(m) });
    const release = b.need(1, Date.now() + 90_000);
    await b.run(new AbortController().signal);
    release();
    expect(calls).toBe(3);
    const node = saved.nodes.get(key(0, 0))!;
    expect(node.how).toBe("fallback");
    expect(node.text.startsWith("user: éé")).toBe(true);
    expect(node.text.endsWith("…")).toBe(true);
    expect(node.text).not.toContain("\uFFFD");
    expect(bytes(node.text)).toBeLessThanOrEqual(LIMIT);
    expect(b.failedLines()).toEqual([]);
    expect(b.failedBefore(2)).toBeNull();
    expect(b.summarized(1)).toBe(true);
    expect(logs.filter((m) => m.includes("fallback"))).toHaveLength(1);
    // Its parent is built from it, and a later run finds nothing left to retry.
    expect(saved.nodes.get(key(1, 0))).toMatchObject({ how: "model" });
    await b.run(new AbortController().signal);
    expect(calls).toBe(3);
  });

  it("builds a merged line the same way when its replies are empty", async () => {
    const { store, saved } = memoryStore(long(2));
    const b = builder(store, async (r) => (target(r) === "0+2" ? ok("") : ok(line(r, 400))));
    await b.run(new AbortController().signal);
    const node = saved.nodes.get(key(1, 0))!;
    expect(node.how).toBe("fallback");
    expect(node.text.startsWith(`${saved.nodes.get(key(0, 0))!.text}\n`)).toBe(true);
    expect(node.text.endsWith("…")).toBe(true);
    expect(bytes(node.text)).toBeLessThanOrEqual(LIMIT);
    expect(b.failedLines()).toEqual([]);
  });

  it("still fails a line, unbuilt, when its calls time out or error rather than answer empty", async () => {
    for (const result of [{ ok: false, reason: "timeout", error: "no reply within 30 s" }, { ok: false, reason: "failed", error: "500" }] as const) {
      const { store, saved } = memoryStore(long(1));
      const b = builder(store, async () => result);
      await b.run(new AbortController().signal);
      expect(saved.nodes.has(key(0, 0))).toBe(false);
      expect(b.failedBefore(1)).toEqual({ i: 0, error: result.error });
      expect(b.summarized(1)).toBe(false);
    }
  });

  it("resumes from saved nodes and views: built nodes are never rebuilt", async () => {
    const messages = long(6);
    const { store, saved } = memoryStore(messages);
    const first = builder(store, async (r) => ok(line(r, 300)));
    await first.run(new AbortController().signal);
    messages.push(...long(2));
    let calls = 0;
    const second = builder(store, async (r) => (calls++, ok(line(r, 300))), {}, structuredClone(first.views));
    await second.run(new AbortController().signal);
    // Messages 6 and 7, their parent 6+2, then 4+4 and 0+8.
    expect(calls).toBe(5);
    expect(saved.nodes.size).toBe(treeSize(8));
  });

  it("feeds a message only once fewer than `concurrency` earlier ones are unbuilt", () => {
    const views = emptyViews();
    for (let i = 0; i < 3; i++) feed(views, new Map());
    expect(views.chat).toEqual([[0, 0], [0, 1], [0, 2]]);
    expect(views.fed).toBe(3);
  });
});

describe("W220 log entries from BB events", () => {
  const facts = { spawnedByPlugin: false, sender: (threadId: string) => (threadId === "thr_w" ? "W12 Parser — parser" : threadId) };
  const spawned = { ...facts, spawnedByPlugin: true };
  const turn = (data: Record<string, unknown>) => ({ seq: 5, type: "client/turn/requested", createdAt: 1000, data: { direction: "outbound", source: "tell", ...data } });
  const item = (item: Record<string, unknown>) => ({ seq: 6, type: "item/completed", createdAt: 2000, data: { item } });
  const entries = (row: Parameters<typeof eventEntries>[0], f = facts) => eventEntries(row, "coord", f).map((e) => `${e.kind}: ${e.text}`);

  it("maps inputs: the user, a sending thread by its title, BB as [bb], a plugin's brief or handover as a note", () => {
    expect(entries(turn({ initiator: "user", input: [{ type: "text", text: "Ship it" }] }))).toEqual(["user: Ship it"]);
    expect(entries(turn({ initiator: "agent", senderThreadId: "thr_w", input: [{ type: "text", text: "[bb message from thread:thr_w]\n\nInitiative · X · W12\n\nW12 reported (done)" }] }))).toEqual(["work: [W12 Parser — parser] Initiative · X · W12\n\nW12 reported (done)"]);
    expect(entries(turn({ initiator: "system", input: [{ type: "text", text: "[bb system]\n\n@thread:thr_w completed: ok" }] }))).toEqual(["work: [bb] @thread:thr_w completed: ok"]);
    const brief = turn({ initiator: "user", source: "spawn", input: [{ type: "text", text: "This thread is starting as the replacement coordinator of the Initiative \"X\".\n\nHandover from the previous coordinator:\n\nAll good." }] });
    expect(entries(brief, spawned)[0]).toMatch(/^note: This thread is starting/);
    // A thread the user started: its first message is the user's.
    expect(entries(turn({ initiator: "user", source: "spawn", input: [{ type: "text", text: "Fix the build" }] }))).toEqual(["user: Fix the build"]);
    expect(entries(turn({ initiator: "user", input: [{ type: "text", text: "/compact" }] }))).toEqual([]);
  });

  it("maps items: replies, tool calls with their echo, commands; never thoughts", () => {
    expect(entries(item({ type: "agentMessage", text: "Done." }))).toEqual(["agent: Done."]);
    expect(entries(item({ type: "reasoning", content: ["secret"] }))).toEqual([]);
    expect(entries(item({ type: "toolCall", tool: "initiative_read", arguments: { view: "workers" }, result: "{\"items\":[]}" }))).toEqual(['tool: initiative_read {"view":"workers"}', 'echo: {"items":[]}']);
    expect(entries(item({ type: "toolCall", tool: "ToolSearch", arguments: {}, result: "x", presentation: { suppress: true } }))).toEqual([]);
    expect(entries(item({ type: "commandExecution", command: "git status", exitCode: 0, aggregatedOutput: "clean" }))).toEqual(["tool: Bash git status", "echo: exit 0\nclean"]);
    expect(entries(item({ type: "toolCall", tool: "x", parentToolCallId: "p", arguments: {} }))).toEqual([]);
    expect(entries(item({ type: "contextCompaction" }))[0]).toMatch(/^note: Context compacted/);
    const summary = { seq: 7, type: "provider/unhandled", data: { rawType: "sdk/user", rawEvent: { params: { message: { message: { content: "This session is being continued from a previous conversation. Summary: …" } } } } } };
    expect(entries(summary)).toEqual(["note: This session is being continued from a previous conversation. Summary: …"]);
  });

  it("clips tool output to its head and tail and splits other long text", () => {
    const [, echo] = eventEntries(item({ type: "commandExecution", command: "cat big", exitCode: 0, aggregatedOutput: "a".repeat(40_000) + "END" }), "coord", facts);
    expect(echo!.text.length).toBeLessThan(30_100);
    expect(echo!.text).toMatch(/clipped[\s\S]*END$/);
    const parts = eventEntries(item({ type: "agentMessage", text: "b".repeat(65_000) }), "coord", facts).flatMap(splitEntry);
    expect(parts.map((p) => p.text.length)).toEqual([30_000, 30_000, 5_000]);
  });

  it("pages each event type on its own and never skips a slower type", async () => {
    const rows = [
      ...Array.from({ length: 150 }, (_, k) => ({ seq: 10 + 2 * k, type: "item/completed" })),
      { seq: 15, type: "client/turn/requested" },
      { seq: 400, type: "client/turn/requested" },
    ];
    const list = async (a: { types: readonly string[]; order: string; afterSeq?: string; limit: string }) =>
      rows.filter((r) => a.types.includes(r.type) && r.seq > Number(a.afterSeq ?? 0)).sort((x, y) => (a.order === "desc" ? y.seq - x.seq : x.seq - y.seq)).slice(0, Number(a.limit));
    const first = await readEvents(list, "t", 0);
    // The item page ends at seq 208; the input at 400 waits for the next read.
    expect(first.through).toBe(208);
    expect(first.more).toBe(true);
    expect(first.rows.map((r) => r.seq)).toContain(15);
    expect(first.rows.map((r) => r.seq)).not.toContain(400);
    const second = await readEvents(list, "t", first.through);
    expect(second.more).toBe(false);
    expect(second.rows.map((r) => r.seq)).toContain(400);
    expect(second.through).toBe(400);
  });
});

describe("W220 Luna through the Pooler", () => {
  const sse = (events: unknown[]) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  it("streams one response, sends the cache session, and prices it at list price", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const summarize = responsesSummarizer({
      fetch: (async (url: string, init: RequestInit) => (seen.push({ url, init }), sse([
        { type: "response.created" },
        { type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text: "user: ship it" }] }], usage: { input_tokens: 10_000, input_tokens_details: { cached_tokens: 9_000 }, output_tokens: 300, output_tokens_details: { reasoning_tokens: 200 } } } },
      ]))) as never,
      url: () => "http://pool/advisor/v1/responses",
      headers: async () => ({ "x-bb-plugin-token": "t" }),
    });
    let started = false;
    const r = await summarize({ instructions: "sys", input: [], effort: "xhigh", cacheKey: "session-1", signal: new AbortController().signal, onStart: () => (started = true) });
    expect(r).toMatchObject({ ok: true, text: "user: ship it", usage: { input: 10_000, cached: 9_000, output: 300, reasoning: 200 } });
    expect(started).toBe(true);
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers).toMatchObject({ session_id: "session-1", "x-bb-plugin-token": "t" });
    expect(JSON.parse(String(seen[0]!.init.body))).toMatchObject({ model: "gpt-6-luna", store: false, stream: true, reasoning: { effort: "xhigh" }, prompt_cache_key: "session-1" });
    expect(usageCost({ input: 10_000, cached: 9_000, output: 300, reasoning: 200 })).toBeCloseTo((1000 * 0.1 + 9000 * 0.01 + 300 * 0.5) / 1e6);
  });

  it("classifies refusals: 429 backs off with Retry-After, 403 is an unavailable route", async () => {
    const answer = (res: Response) => responsesSummarizer({ fetch: (async () => res) as never, url: () => "u", headers: async () => ({}) });
    const request = { instructions: "", input: [], effort: "high", cacheKey: "k", signal: new AbortController().signal };
    expect(await answer(new Response("slow down", { status: 429, headers: { "retry-after": "30" } }))(request)).toMatchObject({ ok: false, reason: "rate-limited", retryAfterMs: 30_000 });
    expect(await answer(new Response("route off", { status: 403 }))(request)).toMatchObject({ ok: false, reason: "unavailable" });
    expect(await answer(new Response("bad", { status: 400 }))(request)).toMatchObject({ ok: false, reason: "failed" });
    expect(await answer(sse([{ type: "response.failed", response: { error: { message: "rate limit reached" } } }]))(request)).toMatchObject({ ok: false, reason: "rate-limited" });
  });
});
