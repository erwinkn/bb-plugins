import { afterEach, describe, expect, it, vi } from "vitest";
import { TreeBuilder, type TreeStore } from "../lib/builder";
import { FairPermits } from "../lib/permits";
import type { SummarizerRequest, SummarizerResult } from "../lib/summarizer";
import { emptyViews, feed, key } from "../lib/tree";

// W570: urgent calls go by the fewest calls their scope's waiting turns still need. By turns, the
// six to seven scopes waiting at once on 2026-11-02 13:22-13:34 shared the permits evenly and
// missed their 90 s together (W569 failed with 6 messages unbuilt, W309 with 8).

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const ticks = async (n: number) => {
  for (let k = 0; k < n; k++) await tick();
};

afterEach(() => vi.useRealTimers());

/** A demand of `left` calls, urgent since before the test began. */
const calls = (left: number) => ({ left, since: -Infinity });

describe("W570 urgent calls by fewest calls left", () => {
  it("lets in the urgent call of the scope with the fewest calls left, ties by turns, then the rest as before", async () => {
    const left: Record<string, number> = { a: 5, b: 2, c: 2 };
    const permits = new FairPermits(() => 1, (owner) => (owner === "coord" ? 1 : 0), (owner) => calls(left[owner] ?? 0));
    const order: string[] = [];
    let release!: () => void;
    const first = permits.run("w", new AbortController().signal, () => new Promise<void>((resolve) => (release = resolve)));
    await tick();
    const work = (owner: string, k: number, urgent = true) => permits.run(owner, new AbortController().signal, async () => void order.push(`${owner}.${k}`), () => urgent);
    const waiting = [work("a", 1), work("b", 1), work("b", 2), work("c", 1), work("w", 1, false), work("coord", 1, false)];
    await tick();
    release();
    await first;
    await Promise.all(waiting);
    // b and c tie at 2: b first, then c, whose turn it is once b went to the back of the rotation.
    expect(order).toEqual(["b.1", "c.1", "b.2", "a.1", "coord.1", "w.1"]);
  });

  it("lets in a scope passed over for 15 s first, then goes back to the fewest calls left", async () => {
    let now = 0;
    const permits = new FairPermits(() => 1, undefined, (owner) => calls(owner === "big" ? 100 : 1), () => now);
    const order: string[] = [];
    let release!: () => void;
    const first = permits.run("x", new AbortController().signal, () => new Promise<void>((resolve) => (release = resolve)));
    await tick();
    // Every call takes 4 s.
    const work = (owner: string, k: number) =>
      permits.run(owner, new AbortController().signal, async () => {
        order.push(`${owner}.${k}`);
        now += 4_000;
      }, () => true);
    const waiting = [work("big", 1), work("big", 2), ...[1, 2, 3, 4, 5, 6, 7, 8].map((k) => work("small", k))];
    await tick();
    release();
    await first;
    await Promise.all(waiting);
    // big waits from 0: at 16 s it has been passed over 15 s; again from 16 s, at 32 s.
    expect(order).toEqual(["small.1", "small.2", "small.3", "small.4", "big.1", "small.5", "small.6", "small.7", "big.2", "small.8"]);
  });

  it.each(["drained", "aborted"])("forgets how long a scope was passed over once it has no urgent call waiting: %s", async (how) => {
    let now = 0;
    const permits = new FairPermits(() => 1, undefined, (owner) => calls(owner === "big" ? 100 : 1), () => now);
    const order: string[] = [];
    /** An urgent call that, once let in, holds its permit until let go (which it may be before). */
    const held = (owner: string, signal = new AbortController().signal) => {
      let go!: () => void;
      const gate = new Promise<void>((resolve) => (go = resolve));
      const done = permits.run(owner, signal, async () => {
        order.push(owner);
        await gate;
      }, () => true);
      return { done, go };
    };
    // big waits from 0 while small runs: passed over once, its age starts.
    const first = held("small");
    await tick();
    const stop = new AbortController();
    const big = held("big", stop.signal);
    await tick();
    first.go();
    await first.done;
    const second = held("small");
    await tick();
    // Then big runs (drained) or is aborted while small runs: either way nothing of big waits.
    let holder = second;
    if (how === "drained") {
      second.go();
      await second.done;
      await tick();
      holder = big;
    } else {
      stop.abort();
      expect(await big.done).toBeNull();
    }
    // At 20 s, while that call still runs, both ask at once: big was passed over 20 s ago, but not
    // since it last waited.
    now = 20_000;
    const both = [held("big"), held("small")];
    await tick();
    for (const h of both) h.go();
    holder.go();
    await Promise.all([holder.done, ...both.map((h) => h.done)]);
    expect(order.slice(-2)).toEqual(["small", "big"]);
  });

  it("ages a scope from when its demand began: a need that ended and came back while no permit freed", async () => {
    // big is passed over at 0, loses its need at 1 s and needs again at 19 s, with no permit
    // freeing in between. At 20 s it has waited 1 s, not 20: the small turn goes first.
    let now = 0;
    let bigSince = 0;
    let bigUrgent = true;
    const permits = new FairPermits(() => 1, undefined, (owner) => (owner === "big" ? { left: 100, since: bigSince } : calls(1)), () => now);
    const order: string[] = [];
    const held = (owner: string, urgent = () => true) => {
      let go!: () => void;
      const gate = new Promise<void>((resolve) => (go = resolve));
      const done = permits.run(owner, new AbortController().signal, async () => {
        order.push(owner);
        await gate;
      }, urgent);
      return { done, go };
    };
    const first = held("x");
    await tick();
    const big = held("big", () => bigUrgent);
    const small = held("small");
    await tick();
    first.go();
    await first.done;
    await tick();
    expect(order).toEqual(["x", "small"]);
    [now, bigUrgent, bigSince] = [1_000, false, 1_000];
    [now, bigUrgent, bigSince] = [19_000, true, 19_000];
    now = 20_000;
    const later = held("small");
    await tick();
    small.go();
    await small.done;
    await tick();
    expect(order).toEqual(["x", "small", "small"]);
    later.go();
    await later.done;
    await tick();
    big.go();
    await big.done;
  });

  it("asks each scope's demand once per batch of permits, not once per permit", async () => {
    const asked = new Map<string, number>();
    const permits = new FairPermits(() => 8, undefined, (owner) => {
      asked.set(owner, (asked.get(owner) ?? 0) + 1);
      return calls(owner.length);
    });
    const stop = new AbortController();
    const runs = ["a", "bb", "ccc", "dddd"].flatMap((owner) => Array.from({ length: 4 }, () => permits.run(owner, stop.signal, () => new Promise<void>(() => {}), () => true)));
    await tick();
    // 8 permits out of 16 urgent calls in one batch: every scope asked once.
    expect(permits.inFlight).toBe(8);
    expect([...asked.values()]).toEqual([1, 1, 1, 1]);
    stop.abort();
    void runs;
  });

  it("counts what a builder's waiting turns still lack: a turn's lines, an admission's whole log", async () => {
    let count = 10;
    const texts = new Map<string, string>();
    const store: TreeStore = {
      messageCount: () => count,
      message: (i) => ({ kind: "agent", text: `${i} `.padEnd(1000, "y") }),
      node: (l, i) => texts.get(key(l, i)) ?? null,
      built: () => [],
      saveNode: (l, i, text) => void texts.set(key(l, i), text),
      saveViews: () => {},
      recordCall: () => {},
    };
    const ok: SummarizerResult = { ok: true, text: "s".repeat(300), usage: { input: 1, cached: 0, output: 1, reasoning: 0 }, latencyMs: 0 };
    let now = 0;
    const builder = new TreeBuilder(store, emptyViews(), { summarize: async () => ok, instructions: () => "", effort: () => "high", concurrency: () => 2, cacheKey: "k", now: () => now });
    expect(builder.left).toBe(0);
    now = 5;
    const turn = builder.need(4, Infinity);
    expect(builder.left).toBe(4);
    now = 7;
    const admission = builder.need(Infinity, Infinity, "priority-only");
    expect(builder.left).toBe(10);
    // Waiting since the first need; a need joining others keeps that.
    expect(builder.waitingSince).toBe(5);
    await builder.run(new AbortController().signal);
    expect(builder.left).toBe(0);
    count = 13;
    expect(builder.left).toBe(3);
    now = 9;
    admission();
    expect(builder.left).toBe(0);
    // A release restarts it: what is still urgent has been only since then.
    expect(builder.waitingSince).toBe(9);
    turn();
  });

  it("renders a view's bound merges once until something changes, not on every ask", () => {
    // 600 built lines (~300 KB): the chat view merges, and rendering it reads every node in it.
    const { store, views } = backlogStore(600, 600);
    const builder = new TreeBuilder(store, views, { summarize: async () => ({ ok: false, reason: "aborted", error: "stopped" }), instructions: () => "", effort: () => "high", concurrency: () => 8, cacheKey: "k" });
    const reads = vi.spyOn(builder.nodes, "get");
    const release = builder.need(Infinity, Infinity, "priority-only");
    const left = builder.left;
    expect(left).toBeGreaterThan(200);
    expect(reads.mock.calls.length).toBeGreaterThan(600);
    reads.mockClear();
    expect(builder.left).toBe(left);
    expect(reads).not.toHaveBeenCalled();
    release();
  });
});

/** A store of `count` messages of 1 KB, with lines of ~500 bytes already built for the first `lines`. */
function backlogStore(count: number, lines: number) {
  const texts = new Map<string, string>();
  for (let i = 0; i < lines; i++) texts.set(key(0, i), `${i} `.padEnd(500, "x"));
  const store: TreeStore = {
    messageCount: () => count,
    message: (i) => ({ kind: "agent", text: `${i} `.padEnd(1000, "y") }),
    node: (l, i) => texts.get(key(l, i)) ?? null,
    built: (l, from, to) => Array.from({ length: Math.max(0, to - from) }, (_, k) => from + k).filter((i) => texts.has(key(l, i))),
    saveNode: (l, i, text) => void texts.set(key(l, i), text),
    saveViews: () => {},
    recordCall: () => {},
  };
  // Its views as a load finds them: every line fed, the chat view past 128 KB and merging.
  const views = emptyViews();
  for (let i = 0; i < lines; i++) feed(views, { has: (k) => texts.has(k), get: (k) => texts.get(k) });
  return { store, views };
}

describe("W570 fewest calls left, with real builders", () => {
  it("counts an admission's merges: one whose lines are all built does not go before a turn missing 6", async () => {
    // An admission over 512 built lines (~256 KB, so its chat view must merge to 64 KB), and a
    // turn whose 6 lines are unbuilt, share 8 permits. Counted by lines alone, the admission had
    // 0 calls left and took every permit until the turn's scope aged.
    const builders = new Map<string, TreeBuilder>();
    const permits = new FairPermits(() => 8, undefined, (owner) => calls(builders.get(owner)?.left ?? 0), () => 0);
    const started: string[] = [];
    const held: (() => void)[] = [];
    const ok: SummarizerResult = { ok: true, text: "s".repeat(500), usage: { input: 1, cached: 0, output: 1, reasoning: 0 }, latencyMs: 0 };
    const summarize = (owner: string) => async (r: SummarizerRequest, urgent: () => boolean) =>
      (await permits.run(owner, r.signal, () =>
        new Promise<SummarizerResult>((resolve) => {
          r.onStart?.();
          r.signal.addEventListener("abort", () => resolve({ ok: false, reason: "aborted", error: "stopped" }));
          started.push(owner);
          held.push(() => resolve(ok));
        }), urgent)) ?? { ok: false, reason: "aborted", error: "stopped" };
    const make = (owner: string, { store, views }: ReturnType<typeof backlogStore>) => {
      const builder = new TreeBuilder(store, views, { summarize: summarize(owner), instructions: () => "", effort: () => "high", concurrency: () => 8, cacheKey: owner });
      builders.set(owner, builder);
      return builder;
    };
    const admission = make("admission", backlogStore(512, 512));
    const turn = make("turn", backlogStore(7, 0));
    const releases = [admission.need(Infinity, Infinity, "priority-only")];
    const stop = new AbortController();
    const runs = [admission.run(stop.signal)];
    await ticks(40);
    // The admission holds every permit with merges, and has hundreds left.
    expect(started).toEqual(Array(8).fill("admission"));
    expect(admission.left).toBeGreaterThan(200);
    releases.push(turn.need(6, Infinity));
    runs.push(turn.run(stop.signal));
    await ticks(40);
    expect(turn.left).toBe(6);
    // One call latency: the 8 freed permits go to the turn's 6 lines first.
    for (const go of held.splice(0)) go();
    await ticks(40);
    expect(started.slice(8, 14)).toEqual(Array(6).fill("turn"));
    for (const go of held.splice(0)) go();
    await ticks(40);
    expect(turn.summarized(6)).toBe(true);
    for (const release of releases) release();
    stop.abort();
    for (const go of held.splice(0)) go();
    await Promise.all(runs);
  });
});

/** A scope's demand: from `at` (s), `calls` calls, urgent for 90 s if a turn, else (an admission) until done. */
type Demand = { name: string; at: number; calls: number; turn: boolean };

/** Calls of 2.2 to 9.5 s (mean 5.8 s, ~83 calls/min through 8 permits), fixed by scope and call. */
function duration(name: string, k: number) {
  let h = 2166136261;
  for (const c of `${name}#${k}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return Math.round((2000 + ((h >>> 0) % 6600)) * 1.1);
}

/**
 * Real permits, 8 of them, fake time: each scope keeps up to 8 calls asked for (as a builder does),
 * a background scope keeps every free permit busy. "by turns" is the order before W570: every
 * urgent scope counts as having as many calls left, and a clock that stands still never ages one.
 * Returns each scope's time to its last call in seconds (null: not done within `seconds`), and its calls done.
 */
type Order = "by turns" | "fewest left" | "fewest left, never aged";

async function simulate(order: Order, demands: Demand[], seconds: number) {
  vi.useFakeTimers({ now: 0, toFake: ["setTimeout", "clearTimeout", "setImmediate", "clearImmediate", "Date"] });
  const scopes = new Map(demands.map((d) => [d.name, { ...d, asked: 0, done: 0, until: Infinity, took: null as number | null }]));
  const fewest = order !== "by turns";
  const permits = new FairPermits(
    () => 8,
    () => 0,
    (owner) => {
      const s = scopes.get(owner);
      return { left: fewest && s ? s.calls - s.done : 0, since: s ? s.at * 1000 : -Infinity };
    },
    order === "fewest left" ? Date.now : () => 0,
  );
  const stop = new AbortController();
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  let k = 0;
  const background = () => void permits.run("background", stop.signal, () => sleep(duration("background", k++))).then(() => !stop.signal.aborted && background());
  for (let i = 0; i < 8; i++) background();
  const ask = (s: NonNullable<ReturnType<typeof scopes.get>>) => {
    if (s.asked >= s.calls) return;
    const n = s.asked++;
    void permits.run(s.name, stop.signal, () => sleep(duration(s.name, n)), () => s.took === null && Date.now() < s.until).then(() => {
      if (stop.signal.aborted) return;
      if (++s.done === s.calls) s.took = Date.now() / 1000 - s.at;
      ask(s);
    });
  };
  for (const s of scopes.values())
    setTimeout(() => {
      if (s.turn) s.until = Date.now() + 90_000;
      for (let i = 0; i < 8; i++) ask(s);
    }, s.at * 1000);
  for (let t = 0; t < seconds * 10; t++) await vi.advanceTimersByTimeAsync(100);
  stop.abort();
  vi.useRealTimers();
  return {
    took: new Map([...scopes.values()].map((s) => [s.name, s.took === null ? null : Math.round(s.took)])),
    done: new Map([...scopes.values()].map((s) => [s.name, s.done])),
  };
}

// 2026-11-02 from 13:22:00 (t 0): turn waits and admission holds ("a") as data.db and the
// logs show them, 1.2 calls per message unbuilt when each began (the ratio in data.db).
const WINDOW: Demand[] = [
  { name: "W42", at: 52.5, calls: 170, turn: true },
  { name: "W306a", at: 113, calls: 69, turn: false },
  { name: "W143a", at: 120, calls: 72, turn: false },
  { name: "W304a", at: 120, calls: 61, turn: false },
  { name: "W569", at: 165.5, calls: 35, turn: true },
  { name: "W142a", at: 173, calls: 54, turn: false },
  { name: "W570", at: 270.4, calls: 148, turn: true },
  { name: "W140", at: 298.8, calls: 1, turn: true },
  { name: "W2516", at: 419.1, calls: 29, turn: true },
  { name: "W309", at: 441.3, calls: 90, turn: true },
  { name: "W140a", at: 486, calls: 15, turn: false },
  { name: "W306", at: 503.8, calls: 18, turn: true },
  { name: "W145a", at: 527, calls: 190, turn: false },
  { name: "W143", at: 595.9, calls: 5, turn: true },
  { name: "W309a", at: 630, calls: 20, turn: false },
  { name: "W304", at: 692.9, calls: 30, turn: true },
  { name: "W57", at: 733.6, calls: 144, turn: true },
];

describe("W570 the 13:22-13:34 window replayed", () => {
  it("finishes more turns inside 90 s by fewest calls left than by turns, and the admissions sooner", async () => {
    const inTime = (took: Map<string, number | null>) =>
      WINDOW.filter((d) => d.turn && took.get(d.name) !== null && took.get(d.name)! <= 90).map((d) => d.name);
    const holds = (took: Map<string, number | null>) =>
      WINDOW.filter((d) => !d.turn).reduce((sum, d) => {
        const t = took.get(d.name);
        // An admission still held at the end would count as no wait at all.
        expect(t, d.name).not.toBeNull();
        return sum + t!;
      }, 0);
    const before = (await simulate("by turns", WINDOW, 1_100)).took;
    const after = (await simulate("fewest left", WINDOW, 1_100)).took;
    // By turns, the five that failed that day fail here too (W42, W569, W570, W309, W57).
    expect(inTime(before)).toEqual(["W140", "W2516", "W306", "W143", "W304"]);
    // W569 (35 calls) makes it; the other four needed 90 to 170 calls, more than 90 s can give.
    expect(inTime(after)).toEqual(["W569", "W140", "W2516", "W306", "W143", "W304"]);
    expect(holds(after)).toBeLessThan(holds(before) * 0.8);
  }, 30_000);

  it("never starves a large admission: small turns that fill every permit still leave it a call every 15 s", async () => {
    // A 300-call admission, and a 6-call turn every 4 s: ~90 calls/min asked of ~83.
    const small = Array.from({ length: 75 }, (_, n): Demand => ({ name: `t${n}`, at: 1 + 4 * n, calls: 6, turn: true }));
    const demands = [{ name: "hold", at: 0, calls: 300, turn: false }, ...small];
    const run = async (order: Order) => {
      const { took, done } = await simulate(order, demands, 300);
      return { turns: small.filter((d) => took.get(d.name) !== null && took.get(d.name)! <= 90).length, hold: done.get("hold")! };
    };
    const before = await run("by turns");
    const after = await run("fewest left");
    const never = await run("fewest left, never aged");
    // By turns 39 of the 75 turns finish in 90 s; by fewest calls left 61, and the hold still gets
    // a call about every 15 s (18 in 300 s). Never aged, it would get none.
    expect(after.turns).toBeGreaterThan(before.turns + 15);
    expect(after.hold).toBeGreaterThanOrEqual(15);
    expect(never.hold).toBe(0);
  }, 30_000);
});
