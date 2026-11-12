import { describe, expect, it } from "vitest";
import { cacheKey } from "../lib/memory";
import type { Summarizer } from "../lib/summarizer";
import { TARGET_BYTES } from "../lib/tree";
import { fixture, type Fixture } from "./fixture";

// D586: a coordinator whose view is over the ceiling gets its summaries first, with no manual step.

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const ticks = async (n = 30) => {
  for (let k = 0; k < n; k++) await tick();
};

/** A summarizer whose calls wait until released, one at a time, answering a short line; records each call's scope by its cache key. */
function heldLuna() {
  const held: (() => void)[] = [];
  const luna = { calls: [] as string[], next: () => held.shift()?.() };
  const summarize: Summarizer = async (r) => {
    luna.calls.push(r.cacheKey);
    await new Promise<void>((resolve) => {
      held.push(resolve);
      r.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return r.signal.aborted ? { ok: false, reason: "aborted", error: "stopped" } : { ok: true, text: "s", usage: { input: 1, cached: 0, output: 1, reasoning: 0 }, latencyMs: 0 };
  };
  return { luna, summarize };
}
/** One summarizer call at a time, so each grant is a choice between the scopes waiting. */
const oneAtATime = (f: Fixture) =>
  ((f.memory as unknown as { deps: { settings: () => object } }).deps.settings = () => ({ regularCompactTokens: 0, hybridCompactTokens: 0, summarizerEffort: "high", summarizerConcurrency: 1 }));
/** A scope "<owner>:<key>" with `n` logged messages of 1 KB, from a thread of its own named `key`. */
async function seeded(f: Fixture, owner: string, key: string, n: number) {
  const scope = await f.attach(owner, key, f.thread(key));
  f.store.append(key, Array.from({ length: n }, (_, i) => ({ kind: "user" as const, text: `${i}: `.padEnd(1000, "x"), at: i, threadId: key, seq: i + 1 })), n);
  return scope;
}
const fits = (f: Fixture, scope: string) => (f.memory as unknown as { fits: (id: string, count: number) => boolean }).fits(scope, f.store.count(scope));
type Builder = { need: (count: number) => () => void; unsummarized: (count: number) => number };
const builder = (f: Fixture, scope: string) => (f.memory as unknown as { builder: (id: string) => Builder }).builder(scope);
const need = (f: Fixture, scope: string) => builder(f, scope).need(Infinity);

/**
 * A coordinator's 8 unsummarized messages show by their start (TARGET_BYTES each): over a ceiling
 * of 5 of them; once 4 lines are summarized (a few bytes each) it is back under.
 */
async function setup() {
  const f = fixture();
  f.memory.ceiling = 5 * TARGET_BYTES;
  const { luna, summarize } = heldLuna();
  f.memory.useSummarizer(summarize);
  oneAtATime(f);
  const coord = await seeded(f, "initiatives", "prj", 8);
  const high = await seeded(f, "test", "high", 8);
  f.memory.prioritize(high, 2);
  return { f, luna, coord, high };
}

describe("D586 over-ceiling coordinators first", () => {
  it("gives an over-ceiling coordinator's calls before a priority-2 scope's, then its own priority back once under", async () => {
    const { f, luna, coord, high } = await setup();
    expect(fits(f, coord)).toBe(false);
    f.memory.build(high);
    f.memory.build(coord);
    await ticks();
    // Each grant, with the coordinator's state when it was made.
    const grants: Array<{ to: string; over: boolean; pending: number }> = [];
    const pending = () => builder(f, coord).unsummarized(8);
    let over = !fits(f, coord);
    let left = pending();
    for (let k = 0; k < 12; k++) {
      while (grants.length < luna.calls.length) grants.push({ to: luna.calls[grants.length]!, over, pending: left });
      luna.next();
      await ticks();
      over = !fits(f, coord);
      left = pending();
    }
    const firstUnder = grants.findIndex((g) => !g.over);
    expect(firstUnder).toBeGreaterThan(0);
    // Over the ceiling, every call was the coordinator's, though the other scope had a higher priority.
    expect(grants.slice(0, firstUnder).every((g) => g.to === cacheKey(coord))).toBe(true);
    // Back under with lines still to summarize, it has its own priority (0) again: the priority-2 scope goes first.
    expect(grants[firstUnder]!.pending).toBeGreaterThan(0);
    expect(grants.slice(firstUnder, firstUnder + 3).map((g) => g.to)).toEqual(Array(3).fill(cacheKey(high)));
    f.memory.dispose();
    await f.memory.settled();
  });

  it("is over the ceiling again when its log grows past it", async () => {
    const { f, luna, coord } = await setup();
    f.memory.build(coord);
    for (let k = 0; k < 40 && !fits(f, coord); k++) {
      luna.next();
      await ticks();
    }
    expect(fits(f, coord)).toBe(true);
    const priority = (f.memory as unknown as { priority: (id: string) => number }).priority;
    expect(priority.call(f.memory, coord)).toBe(0);
    // Messages that BB copies in bring the view back over: read again, not from the cache.
    f.turn("prj", "z".repeat(2000));
    f.turn("prj", "y".repeat(2000));
    f.turn("prj", "w".repeat(2000));
    f.turn("prj", "v".repeat(2000));
    await f.memory.kick("prj")!.done;
    expect(fits(f, coord)).toBe(false);
    expect(priority.call(f.memory, coord)).toBe(Infinity);
    f.memory.dispose();
    await f.memory.settled();
  });

  it("still lets a waiting turn's urgent calls in before an over-ceiling coordinator's", async () => {
    const { f, luna, coord } = await setup();
    const worker = await seeded(f, "test", "worker", 4);
    expect(fits(f, coord)).toBe(false);
    f.memory.build(coord);
    await ticks();
    // The coordinator holds the one permit; a turn of the worker's scope now waits for its lines.
    expect(luna.calls).toEqual([cacheKey(coord)]);
    const release = need(f, worker);
    f.memory.build(worker);
    await ticks();
    luna.next();
    await ticks();
    expect(luna.calls[1]).toBe(cacheKey(worker));
    release();
    f.memory.dispose();
    await f.memory.settled();
  });
});
