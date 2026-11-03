import { describe, expect, it } from "vitest";
import { TreeBuilder, type TreeStore } from "../lib/builder";
import { FairPermits } from "../lib/permits";
import type { SummarizerRequest, SummarizerResult } from "../lib/summarizer";
import { VIEW_BYTES, emptyViews, key } from "../lib/tree";

// W570: a waiting turn's lines start before any merge. On 2026-11-02 turns failed after 90 s with
// 1 to 6 lines unbuilt (W144: 20 line calls and 39 merge calls in its wait, its last line started
// after the deadline): the build ordered its calls by the last message they cover, so the merges
// of the earlier lines went before the last lines the turn needed.

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const ticks = async (n = 30) => {
  for (let k = 0; k < n; k++) await tick();
};
const ok = (text: string): SummarizerResult => ({ ok: true, text, usage: { input: 1, cached: 0, output: 1, reasoning: 0 }, latencyMs: 0 });
/** Lines of 300 bytes: two do not fit one line, so every merge needs a call too. */
const LINE = "m".repeat(300);

/** A store of `count` messages of 1 KB each (every line needs a call), every node kept in memory. */
function memoryStore(count: () => number) {
  const texts = new Map<string, string>();
  const store: TreeStore = {
    messageCount: count,
    message: (i) => ({ kind: "agent", text: `${i} `.padEnd(1000, "y") }),
    node: (l, i) => texts.get(key(l, i)) ?? null,
    built: () => [],
    saveNode: (l, i, text) => void texts.set(key(l, i), text),
    saveViews: () => {},
    recordCall: () => {},
  };
  return store;
}

/** Calls held until let go, through `permits` when given; each one's task ("3", "0+1 and 1+1") in start order. */
function heldSummarizer(permits?: FairPermits, owner = "k") {
  const started: string[] = [];
  const held: { task: string; go: () => void }[] = [];
  const summarize = async (r: SummarizerRequest, urgent: () => boolean) => {
    const work = () =>
      new Promise<SummarizerResult>((resolve) => {
        r.onStart?.();
        r.signal.addEventListener("abort", () => resolve({ ok: false, reason: "aborted", error: "stopped" }));
        const task = /compress message (\d+)|merge lines (\d+\+\d+ and \d+\+\d+)/.exec(r.input.find((m) => m.role === "user")!.content[0]!.text)!.slice(1).find(Boolean)!;
        started.push(`${owner}:${task}`);
        held.push({ task, go: () => resolve(ok(LINE)) });
      });
    return permits ? ((await permits.run(owner, r.signal, work, urgent)) ?? { ok: false, reason: "aborted", error: "stopped" }) : work();
  };
  return { started, held, summarize };
}

const isLine = (task: string) => /^(\w+:)?\d+$/.test(task);

describe("W570 a waiting turn's lines go before merges", () => {
  it("builds the 8 lines a turn waits for in 4 rounds of 2 calls, every merge after them", async () => {
    const store = memoryStore(() => 9);
    const { started, held, summarize } = heldSummarizer();
    const builder = new TreeBuilder(store, emptyViews(), { summarize, instructions: () => "", effort: () => "high", concurrency: () => 2, cacheKey: "k" });
    // The turn's own message is 8: it waits for lines 0..7.
    const release = builder.need(8);
    const stop = new AbortController();
    const run = builder.run(stop.signal);
    await ticks();
    // Each round lets every call in flight answer, as one call latency would.
    let rounds = 0;
    while (!builder.summarized(8) && rounds < 20) {
      for (const h of held.splice(0)) h.go();
      rounds++;
      await ticks();
    }
    // By end alone, merge 0+1 went before line 2 and the lines took 6 rounds: a turn whose
    // deadline allowed 4 failed with lines unbuilt.
    expect(rounds).toBe(4);
    expect(started.slice(0, 8)).toEqual(["k:0", "k:1", "k:2", "k:3", "k:4", "k:5", "k:6", "k:7"]);
    // The merges follow once no line it needs is left to start.
    expect(started.slice(8).every((t) => !isLine(t))).toBe(true);
    release();
    stop.abort();
    await run;
  });

  it("keeps merges before later lines when no turn waits, and when the turn's lines are all started", async () => {
    const store = memoryStore(() => 4);
    const { started, held, summarize } = heldSummarizer();
    const builder = new TreeBuilder(store, emptyViews(), { summarize, instructions: () => "", effort: () => "high", concurrency: () => 2, cacheKey: "k" });
    const stop = new AbortController();
    const run = builder.run(stop.signal);
    await ticks();
    for (const h of held.splice(0)) h.go();
    await ticks();
    // Background build: the merge of 0..1 covers earlier messages than line 2.
    expect(started).toEqual(["k:0", "k:1", "k:0+1 and 1+1", "k:2"]);
    // A turn needing 0..2 (its own message is 3): line 3 is no line it needs, so it keeps its place.
    const release = builder.need(3);
    for (const h of held.splice(0)) h.go();
    await ticks();
    expect(started.slice(4)).toEqual(["k:3"]);
    release();
    stop.abort();
    await run;
  });

  it("keeps every call's context near the compaction view's bound while a turn waits for 300 lines", async () => {
    const store = memoryStore(() => 301);
    const sizes: number[] = [];
    const held: (() => void)[] = [];
    let n = 0;
    const builder = new TreeBuilder(store, emptyViews(), {
      summarize: (r) =>
        new Promise<SummarizerResult>((resolve) => {
          r.onStart?.();
          r.signal.addEventListener("abort", () => resolve({ ok: false, reason: "aborted", error: "stopped" }));
          sizes.push(r.input.reduce((sum, m) => sum + m.content.reduce((s, c) => s + Buffer.byteLength(c.text), 0), 0));
          // Lines of ~500 bytes, each different: 300 of them are ~150 KB.
          held.push(() => resolve(ok(`${n++} `.padEnd(500, "z"))));
        }),
      instructions: () => "",
      effort: () => "high",
      concurrency: () => 8,
      cacheKey: "k",
    });
    const release = builder.need(300);
    const stop = new AbortController();
    const run = builder.run(stop.signal);
    await ticks();
    for (let round = 0; round < 400 && !builder.summarized(300); round++) {
      for (const go of held.splice(0)) go();
      await ticks(10);
    }
    expect(builder.summarized(300)).toBe(true);
    // The compaction view merges back under 32 KB as the lines land: a call's context stays near
    // it (lines still in flight and the task aside), never the ~150 KB of every line built.
    expect(Math.max(...sizes)).toBeLessThan(VIEW_BYTES.compaction[0] + 12_000);
    release();
    stop.abort();
    for (const go of held.splice(0)) go();
    await run;
  });

  it("a turn's need for all its lines puts them first, and its merges still take permits before another scope's background work", async () => {
    const permits = new FairPermits(() => 2);
    const mine = heldSummarizer(permits, "mine");
    const other = heldSummarizer(permits, "other");
    const builder = new TreeBuilder(memoryStore(() => 6), emptyViews(), { summarize: mine.summarize, instructions: () => "", effort: () => "high", concurrency: () => 2, cacheKey: "mine" });
    const background = new TreeBuilder(memoryStore(() => 50), emptyViews(), { summarize: other.summarize, instructions: () => "", effort: () => "high", concurrency: () => 2, cacheKey: "other" });
    const stop = new AbortController();
    const runs = [builder.run(stop.signal), background.run(stop.signal)];
    const release = builder.need(Infinity);
    await ticks();
    const done = async () => {
      for (const h of [...mine.held.splice(0), ...other.held.splice(0)]) h.go();
      await ticks();
    };
    for (let round = 0; round < 6 && !builder.summarized(6); round++) await done();
    const order = [...mine.started, ...other.started].filter((t) => t.startsWith("mine:"));
    // Lines 0..5 first, two at a time, before any merge of this scope.
    expect(order.slice(0, 6)).toEqual(["mine:0", "mine:1", "mine:2", "mine:3", "mine:4", "mine:5"]);
    expect(builder.summarized(6)).toBe(true);
    // Its merges are urgent: once started they go before the other scope's waiting calls.
    await done();
    expect(mine.held.length).toBeGreaterThan(0);
    expect(mine.held.every((h) => !isLine(h.task))).toBe(true);
    expect(other.held.length).toBe(0);
    release();
    stop.abort();
    for (const h of [...mine.held.splice(0), ...other.held.splice(0)]) h.go();
    await Promise.all(runs);
  });
});
