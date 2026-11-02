import { describe, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { cacheKey } from "../lib/memory";
import { FairPermits } from "../lib/permits";
import type { Summarizer, SummarizerResult } from "../lib/summarizer";
import { fixture, type Fixture } from "./fixture";

// W568: archived threads' trees rest; Adventure coordinators' scopes go first.

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const ticks = async (n = 30) => {
  for (let k = 0; k < n; k++) await tick();
};
const line: SummarizerResult = { ok: true, text: "summary".padEnd(300, "."), usage: { input: 1, cached: 0, output: 1, reasoning: 0 }, latencyMs: 0 };

/** A summarizer whose calls wait until released (or aborted), recording each call's scope by its cache key. */
function heldLuna() {
  const held: (() => void)[] = [];
  const luna = { calls: [] as string[], active: 0, release: () => { for (const go of held.splice(0)) go(); } };
  const summarize: Summarizer = async (r) => {
    luna.calls.push(r.cacheKey);
    luna.active++;
    r.onStart?.();
    await new Promise<void>((resolve) => {
      held.push(resolve);
      r.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    luna.active--;
    return r.signal.aborted ? { ok: false, reason: "aborted", error: "stopped" } : line;
  };
  return { luna, summarize };
}
const concurrency = (f: Fixture, n: number) =>
  ((f.memory as unknown as { deps: { settings: () => object } }).deps.settings = () => ({ regularCompactTokens: 0, hybridCompactTokens: 0, summarizerEffort: "high", summarizerConcurrency: n }));

/** A scope "<owner>:<key>" with `n` logged messages of 1 KB, from a thread of its own named `key`. */
async function seeded(f: Fixture, key: string, n: number, owner = "test", facts: { archived?: boolean } = {}) {
  const scope = await f.attach(owner, key, f.thread(key, facts));
  f.store.append(key, Array.from({ length: n }, (_, i) => ({ kind: "user" as const, text: `${i}: `.padEnd(1000, "x"), at: i, threadId: key, seq: i + 1 })), n);
  return scope;
}
const emit = (f: Fixture, name: "thread.unarchived" | "thread.active" | "thread.archived", threadId: string) =>
  f.harness.behavior.emitThreadEvent(name, { thread: makeThreadResponse({ id: threadId }) } as never);

describe("W568 permits by priority", () => {
  it("lets urgent calls in first, then higher-priority scopes by turns, then the rest by turns", async () => {
    const permits = new FairPermits(() => 1, (owner) => (owner.startsWith("coord") ? 1 : 0));
    const order: string[] = [];
    let release!: () => void;
    const first = permits.run("w1", new AbortController().signal, () => new Promise<void>((resolve) => (release = resolve)));
    // Permits are given out once per macrotask (W568): the first call holds its permit before the rest ask.
    await tick();
    const work = (owner: string, k: number, urgent = false) => permits.run(owner, new AbortController().signal, async () => void order.push(`${owner}.${k}`), () => urgent);
    const waiting = [work("w1", 1), work("w1", 2), work("w2", 1), work("coordA", 1), work("coordA", 2), work("coordB", 1), work("w3", 1, true)];
    await tick();
    release();
    await first;
    await Promise.all(waiting);
    expect(order).toEqual(["w3.1", "coordA.1", "coordB.1", "coordA.2", "w1.1", "w2.1", "w1.2"]);
  });
});

describe("W568 archived threads' trees rest", () => {
  it("never calls the summarizer for an archived thread's scope, and builds once it is unarchived", async () => {
    const f = fixture();
    const { luna, summarize } = heldLuna();
    f.memory.useSummarizer(summarize);
    const scope = await seeded(f, "old", 6, "test", { archived: true });
    f.memory.build(scope);
    await ticks();
    await f.memory.settled();
    expect(luna.calls).toEqual([]);
    // Its log stays whole.
    expect(f.store.count(scope)).toBe(6);
    f.threads.get("old")!.archived = false;
    await emit(f, "thread.unarchived", "old");
    await ticks();
    expect(luna.calls.length).toBeGreaterThan(0);
    f.memory.dispose();
    await f.memory.settled();
  });

  it("builds again when the archived thread starts a turn", async () => {
    const f = fixture();
    const { luna, summarize } = heldLuna();
    f.memory.useSummarizer(summarize);
    const scope = await seeded(f, "old", 6, "test", { archived: true });
    f.memory.build(scope);
    await ticks();
    expect(luna.calls).toEqual([]);
    await emit(f, "thread.active", "old");
    await ticks();
    expect(luna.calls.length).toBeGreaterThan(0);
    f.memory.dispose();
    await f.memory.settled();
  });

  it("stops a running build when its thread is archived, logs the final copy, and calls nothing more", async () => {
    const f = fixture();
    const { luna, summarize } = heldLuna();
    f.memory.useSummarizer(summarize);
    const scope = await seeded(f, "w", 40);
    f.memory.build(scope);
    await ticks();
    const started = luna.calls.length;
    expect(started).toBeGreaterThan(0);
    f.turn("w", "last words");
    await f.archived("w");
    expect(luna.active).toBe(0);
    expect(f.log(scope).at(-2)).toContain("last words");
    luna.release();
    f.memory.build(scope);
    await ticks();
    await f.memory.settled();
    expect(luna.calls.length).toBe(started);
    f.memory.dispose();
  });

  it("starts the build again when the thread wakes while the archive is still cancelling its run", async () => {
    const f = fixture();
    const { luna, summarize } = heldLuna();
    f.memory.useSummarizer(summarize);
    const scope = await seeded(f, "w", 40);
    f.memory.build(scope);
    await ticks();
    const started = luna.calls.length;
    expect(started).toBeGreaterThan(0);
    // Archived and back before the cancelled run has ended: the request must not die with it.
    f.memory.threadArchived("w", true);
    f.memory.threadArchived("w", false);
    luna.release();
    await ticks();
    expect(luna.calls.length).toBeGreaterThan(started);
    f.memory.dispose();
    await f.memory.settled();
  });

  it("builds for a turn that asks while the scope's archive state is being read", async () => {
    const f = fixture();
    const { luna, summarize } = heldLuna();
    f.memory.useSummarizer(summarize);
    const scope = await seeded(f, "old", 6, "test", { archived: true });
    const deps = (f.memory as unknown as { deps: { thread: (id: string) => Promise<unknown> } }).deps;
    const read = deps.thread;
    let answer!: () => void;
    deps.thread = (id) => new Promise((resolve) => (answer = () => resolve(read(id))));
    f.memory.build(scope);
    await ticks();
    // The read is out; a turn waits for the tree (its need on the builder, as waitSummarized takes it); then BB answers "archived".
    const builder = (f.memory as unknown as { builder: (id: string) => { need: (count: number, deadline: number) => () => void } }).builder(scope);
    const release = builder.need(Infinity, Date.now() + 60_000);
    f.memory.build(scope);
    answer();
    await ticks();
    expect(luna.calls.length).toBeGreaterThan(0);
    release();
    f.memory.dispose();
    await f.memory.settled();
  });

  it("does not build again after an archive cancels a run an admission asked for: the admission left with it", async () => {
    const f = fixture();
    const { luna, summarize } = heldLuna();
    f.memory.useSummarizer(summarize);
    const scope = await seeded(f, "coord", 40, "initiatives");
    await f.dispatch("coord");
    await ticks();
    const started = luna.calls.length;
    expect(started).toBeGreaterThan(0);
    // Archived with a last turn: the admission is released, the run cancelled, and the final copy asks for a build again.
    f.turn("coord", "last words");
    await f.archived("coord");
    expect(f.log(scope).at(-2)).toContain("last words");
    luna.release();
    await ticks();
    expect(luna.calls.length).toBe(started);
    f.memory.dispose();
    await f.memory.settled();
  });

  it("stops an archived scope's run when the admission that started it is released", async () => {
    const f = fixture();
    const { luna, summarize } = heldLuna();
    f.memory.useSummarizer(summarize);
    const scope = await seeded(f, "coord", 40, "initiatives", { archived: true });
    await f.dispatch("coord");
    await ticks();
    const started = luna.calls.length;
    expect(started).toBeGreaterThan(0);
    // The admission expires (or is released): nothing waits any more, so the backlog stays unbuilt.
    f.memory.releasePreparation("coord");
    await ticks();
    expect(luna.active).toBe(0);
    luna.release();
    await ticks();
    expect(luna.calls.length).toBe(started);
    await f.memory.settled();
    // A wake still builds.
    f.memory.threadArchived("coord", false);
    await ticks();
    expect(luna.calls.length).toBeGreaterThan(started);
    f.memory.dispose();
    await f.memory.settled();
    void scope;
  });

  it("stops an archived scope's run when the turn that waited for it leaves", async () => {
    const f = fixture();
    const { luna, summarize } = heldLuna();
    f.memory.useSummarizer(summarize);
    const scope = await seeded(f, "old", 40, "test", { archived: true });
    // A turn's need, as waitSummarized takes it (and releases it in its finally when the turn stops or times out).
    const builder = (f.memory as unknown as { builder: (id: string) => { need: (count: number, deadline: number) => () => void } }).builder(scope);
    const release = builder.need(Infinity, Date.now() + 60_000);
    f.memory.build(scope);
    await ticks();
    const started = luna.calls.length;
    expect(started).toBeGreaterThan(0);
    release();
    await ticks();
    expect(luna.active).toBe(0);
    luna.release();
    await ticks();
    expect(luna.calls.length).toBe(started);
    f.memory.dispose();
    await f.memory.settled();
  });

  it("builds when the thread wakes while a run is deciding, from its cached state, to rest", async () => {
    const f = fixture();
    const { luna, summarize } = heldLuna();
    f.memory.useSummarizer(summarize);
    const scope = await seeded(f, "old", 6, "test", { archived: true });
    f.memory.build(scope);
    await ticks();
    await f.memory.settled();
    expect(luna.calls).toEqual([]);
    // The state is cached now: the run's check answers "archived" one await later, after the wake.
    f.memory.build(scope);
    f.memory.threadArchived("old", false);
    await ticks();
    expect(luna.calls.length).toBeGreaterThan(0);
    f.memory.dispose();
    await f.memory.settled();
  });

  it("still builds for a turn that waits on an archived thread's UniiChat memory", async () => {
    const f = fixture();
    const { luna, summarize } = heldLuna();
    f.memory.useSummarizer(summarize);
    const scope = await seeded(f, "coord", 6, "initiatives", { archived: true });
    f.memory.build(scope);
    await ticks();
    expect(luna.calls).toEqual([]);
    await f.dispatch("coord");
    await ticks();
    expect(luna.calls.length).toBeGreaterThan(0);
    f.memory.dispose();
    await f.memory.settled();
  });

  it("leaves the database alone when an archive-state read answers after the service stopped and BB closed it", async () => {
    const f = fixture();
    const { summarize } = heldLuna();
    f.memory.useSummarizer(summarize);
    await seeded(f, "coord", 40, "initiatives", { archived: true });
    const deps = (f.memory as unknown as { deps: { thread: (id: string) => Promise<unknown> } }).deps;
    const read = deps.thread;
    const late: (() => void)[] = [];
    deps.thread = (id) => new Promise((resolve, reject) => late.push(() => read(id).then(resolve, reject)));
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => void rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      // An admission asks for a build (its need skips the archive-state read); archive-state reads hang.
      await f.dispatch("coord");
      await ticks();
      // The plugin stops, releasing the admission, whose release asks whether the run should rest;
      // BB closes the database, then any read in flight answers "archived".
      f.memory.dispose();
      f.store.handle.close();
      for (const answer of late.splice(0)) answer();
      await ticks();
      for (const answer of late.splice(0)) answer();
      await ticks();
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("stops a run that began on a failed archive-state read once a sweep's retry finds the thread archived", async () => {
    const f = fixture();
    const { luna, summarize } = heldLuna();
    f.memory.useSummarizer(summarize);
    const scope = await seeded(f, "old", 40, "test", { archived: true });
    const deps = (f.memory as unknown as { deps: { thread: (id: string) => Promise<unknown> } }).deps;
    const read = deps.thread;
    let fails = 1;
    deps.thread = (id) => (fails-- > 0 ? Promise.reject(new Error("BB unavailable")) : read(id));
    // The first read fails, so the run counts the thread as awake and starts on the backlog.
    f.memory.build(scope);
    await ticks();
    const started = luna.calls.length;
    expect(started).toBeGreaterThan(0);
    // The sweep reads again and learns the thread is archived: the run stops, and nothing more is called.
    await f.memory.sweep(true);
    await ticks();
    expect(luna.active).toBe(0);
    luna.release();
    await ticks();
    expect(luna.calls.length).toBe(started);
    f.memory.dispose();
    await f.memory.settled();
  });

  it("reads each thread's archive state once at the startup sweep, then keeps it from events", async () => {
    const f = fixture();
    const { luna, summarize } = heldLuna();
    f.memory.useSummarizer(summarize);
    const scope = await seeded(f, "old", 6, "test", { archived: true });
    let gets = 0;
    const deps = (f.memory as unknown as { deps: { thread: (id: string) => Promise<unknown> } }).deps;
    const read = deps.thread;
    deps.thread = (id) => (gets++, read(id));
    await f.memory.sweep(false);
    await f.memory.sweep(true);
    await ticks();
    expect(gets).toBe(1);
    expect(luna.calls).toEqual([]);
    expect(f.store.count(scope)).toBe(6);
    f.memory.dispose();
    await f.memory.settled();
  });
});

describe("W568 coordinator scopes first", () => {
  it("builds a prioritized scope's nodes before a worker scope's, and keeps the priority in the store", async () => {
    const f = fixture();
    const { luna, summarize } = heldLuna();
    f.memory.useSummarizer(summarize);
    // Two permits: a scope with a backlog has a call waiting whenever one of its calls ends.
    concurrency(f, 2);
    const worker = await seeded(f, "prj:worker:1", 8, "initiatives");
    const coord = await seeded(f, "prj", 8, "initiatives");
    expect(await f.harness.behavior.callRpc("prioritize", { key: "prj", priority: 1 }, { experimental_caller: { kind: "plugin", pluginId: "initiatives" } })).toEqual({ scope: coord });
    expect(f.store.scope(coord)?.priority).toBe(1);
    await expect(f.harness.behavior.callRpc("prioritize", { key: "prj", priority: 1 }, { experimental_caller: { kind: "client" } } as never)).rejects.toThrow(/plugin that owns it/);
    f.memory.build(worker);
    f.memory.build(coord);
    for (let round = 0; round < 200 && (await f.memory.status(coord)).tree.state !== "idle"; round++) {
      await ticks(5);
      luna.release();
    }
    // Asked for in the same macrotask, the coordinator's calls went first: its 8 lines and the
    // merges over them, until a merge waiting for its halves left it nothing to ask for.
    expect(luna.calls.slice(0, 12)).toEqual(Array(12).fill(cacheKey(coord)));
    expect(luna.calls).toContain(cacheKey(worker));
    f.memory.dispose();
    await f.memory.settled();
  });
});
