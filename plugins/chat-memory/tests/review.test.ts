import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { TreeBuilder, type NodeHow, type TreeStore } from "../lib/builder";
import type { ListEvents } from "../lib/ingest";
import { ChatMemory } from "../lib/memory";
import { DEFAULT_SETTINGS } from "../lib/settings";
import { MIGRATIONS, MemoryStore } from "../lib/store";
import type { Summarizer, SummarizerResult } from "../lib/summarizer";
import { NodeCache, VIEW_BYTES, emptyViews, key, viewBytes, type Views } from "../lib/tree";

// W225's review regressions (moved with T145), against an in-memory database, a fake event list
// and a fake summarizer: shutdown, a bounded tree in memory, builder edges, owned runs.

const usage = { input: 100, cached: 0, output: 10, reasoning: 0 };
const ok = (text: string): SummarizerResult => ({ ok: true, text, usage, latencyMs: 1 });
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
};
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
type Event = Awaited<ReturnType<ListEvents>>[number];
const turn = (seq: number, text: string): Event => ({ seq, type: "client/turn/requested", createdAt: seq, data: { initiator: "user", source: "tell", input: [{ type: "text", text }] } });
const completed = (seq: number): Event => ({ seq, type: "turn/completed", createdAt: seq, data: { status: "completed" } });
/** A list over fixed events per thread, as BB pages them: per type, after a sequence, up to the limit. */
const listing = (threads: Record<string, Event[]>): ListEvents => async (a) =>
  (threads[a.threadId] ?? [])
    .filter((e) => a.types.includes(e.type) && e.seq > Number(a.afterSeq ?? 0))
    .sort((x, y) => (a.order === "desc" ? y.seq - x.seq : x.seq - y.seq))
    .slice(0, Number(a.limit));

/**
 * The database behind a proxy that records every call on it, or on a statement it prepared, made
 * once `watch.closed` is set: BB closes the database when the plugin stops.
 */
function watched<T extends object>(target: T, watch: { closed: boolean; touched: string[] }): T {
  return new Proxy(target, {
    get(t, property) {
      const value = Reflect.get(t, property, t);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (watch.closed) watch.touched.push(String(property));
        const out = value.apply(t, args);
        return out && typeof out === "object" && typeof (out as { run?: unknown }).run === "function" ? watched(out, watch) : out;
      };
    },
  });
}

const SCOPE = "test:s";
function setup(list: ListEvents, options: { summarizer?: Summarizer } = {}) {
  const watch = { closed: false, touched: [] as string[] };
  const db = watched(new Database(":memory:"), watch);
  for (const sql of MIGRATIONS) db.exec(sql);
  const store = new MemoryStore(db);
  const memory = new ChatMemory({
    store,
    list,
    thread: async () => ({ providerId: "claude-code", title: null, originPluginId: null, archived: false }),
    settings: () => DEFAULT_SETTINGS,
    summarizer: options.summarizer ?? (async () => ok("summary")),
    log: () => {},
  });
  /** Dispose the memory as the plugin stops; from now on the database may not be touched. */
  const stop = () => {
    memory.dispose();
    watch.closed = true;
  };
  return { db, memory, store, stop, watch };
}
const withLog = (memory: ChatMemory, texts: string[]) => {
  memory.store.ensureScope(SCOPE, "test");
  memory.store.attach("current", SCOPE);
  memory.store.append("current", texts.map((text, k) => ({ kind: "user", text, at: 1, threadId: "current", seq: k + 1 })), texts.length);
};

/** A builder's store in memory, counting the node texts it reads. */
function treeStore(messages: number, text = (i: number) => `message ${i} `.padEnd(700, "y")) {
  const nodes = new Map<string, { text: string; how: NodeHow }>();
  const counts = { reads: 0, calls: 0, views: [] as Views[] };
  const store: TreeStore = {
    messageCount: () => messages,
    message: (i) => (i < messages ? { kind: "user", text: text(i) } : null),
    node: (l, i) => (counts.reads++, nodes.get(key(l, i))?.text ?? null),
    built: (l, from, to) => {
      const out: number[] = [];
      for (let i = from; i < to; i++) if (nodes.has(key(l, i))) out.push(i);
      return out;
    },
    saveNode: (l, i, text, how) => void nodes.set(key(l, i), { text, how }),
    saveViews: (views) => void counts.views.push(structuredClone(views)),
    recordCall: () => void counts.calls++,
  };
  return { store, nodes, counts };
}
const options = (summarize: Summarizer, concurrency = 8) => ({ summarize, instructions: () => "", effort: () => "high", concurrency: () => concurrency, cacheKey: "k" });

describe("W225 shutdown: no store access after dispose (P1)", () => {
  it("drops an ingest whose page read completes after dispose", async () => {
    const hold = gate();
    const { db, memory, store, stop, watch } = setup(async () => (await hold.promise, [turn(1, "late"), completed(2)]));
    withLog(memory, []);
    memory.kick("current");
    await tick();
    stop();
    hold.release();
    await memory.settled();
    expect(watch.touched).toEqual([]);
    memory.start();
    expect(store.count(SCOPE)).toBe(0);
    expect(store.thread("current")!.cursor).toBe(0);
    db.close();
  });

  it("records no call and saves no node when a summary lands after dispose", async () => {
    const hold = gate();
    const { db, memory, store, stop, watch } = setup(listing({}), { summarizer: async () => (await hold.promise, ok("late summary")) });
    withLog(memory, ["x".repeat(700), "y".repeat(700)]);
    memory.build(SCOPE);
    await tick();
    stop();
    hold.release();
    await memory.settled();
    // Neither the call's record, nor its node, nor the requeue's check reaches the database.
    expect(watch.touched).toEqual([]);
    memory.start();
    expect(store.totals(SCOPE)).toMatchObject({ calls: 0, nodes: 0 });
    expect(store.node(SCOPE, 0, 0)).toBeNull();
    db.close();
  });

  it("reads no further page once disposed while a page read was pending (P2)", async () => {
    const hold = gate();
    const calls: string[] = [];
    let disposed = false;
    const list = listing({ current: Array.from({ length: 300 }, (_, k) => (k % 2 ? completed(k + 1) : turn(k + 1, `t${k}`))) });
    const { db, memory, stop } = setup(async (a) => {
      if (disposed) calls.push(`${a.order} ${a.afterSeq}`);
      else await hold.promise;
      return list(a);
    });
    withLog(memory, []);
    memory.kick("current");
    await tick();
    stop();
    disposed = true;
    hold.release();
    await memory.settled();
    expect(calls).toEqual([]);
    db.close();
  });
});

describe("W225 a bounded tree in memory (P1)", () => {
  it("resumes a large built tree reading only a slice of node texts, and rebuilds just what is missing", async () => {
    const n = 5000;
    const { store, nodes, counts } = treeStore(n);
    for (let l = 0; 2 ** l <= n; l++) for (let i = 0; (i + 1) * 2 ** l <= n; i++) nodes.set(key(l, i), { text: `${l}:${i}`, how: "model" });
    // Message 3001 and the nodes above it were never built.
    for (let l = 0, i = 3001; 2 ** l <= n; l++, i >>= 1) nodes.delete(key(l, i));
    const views = { ...emptyViews(), fed: n, chat: [[12, 0], [9, 8], [8, 18], [7, 38], [3, 624]] as [number, number][] };
    let calls = 0;
    const b = new TreeBuilder(store, views, options(async () => (calls++, ok("rebuilt"))));
    await b.run(new AbortController().signal);
    // 3001's line (it is 700 bytes); the short lines above it merge without a call.
    expect(calls).toBe(1);
    expect(nodes.size).toBe([...Array(13).keys()].reduce((total, l) => total + Math.floor(n / 2 ** l), 0));
    expect(counts.reads).toBeLessThan(100);
    expect(b.summarized(n)).toBe(true);
  });

  it("keeps the node cache within its budget", () => {
    const cache = new NodeCache(() => null, 10_000);
    for (let i = 0; i < 1000; i++) cache.set(key(0, i), "x".repeat(500));
    expect((cache as unknown as { chars: number }).chars).toBeLessThanOrEqual(10_000);
    expect(cache.has(key(0, 999))).toBe(true);
    expect(cache.has(key(0, 0))).toBe(false);
  });

  it("reports status from running counts and view nodes, never the whole tree", async () => {
    const { db, memory, store } = setup(listing({}));
    withLog(memory, ["a".repeat(700), "b".repeat(700)]);
    const tree = store.tree(SCOPE);
    for (let i = 0; i < 2000; i++) tree.saveNode(0, i, "x".repeat(400), i % 100 ? "model" : "fallback", 1);
    tree.saveNode(0, 0, "duplicate", "model", 1);
    tree.saveViews({ ...emptyViews(), fed: 2, chat: [[0, 0], [0, 1]], compaction: [[0, 0], [0, 1]] });
    const read = store.node.bind(store);
    let reads = 0;
    store.node = (scope, l, i) => (reads++, read(scope, l, i));
    const status = await memory.status(SCOPE);
    expect(status.tree).toMatchObject({ nodes: 2000, fallbacks: 20 });
    expect(status.log.bytes).toBe(store.messages(SCOPE).reduce((sum, m) => sum + m.size, 0));
    expect(reads).toBeLessThanOrEqual(4);
    db.close();
  });
});

describe("W225 builder edges (P2)", () => {
  it("still pauses for a 429 that refuses a length retry, keeping the line it had", async () => {
    let calls = 0;
    const { store, nodes } = treeStore(1);
    const b = new TreeBuilder(store, emptyViews(), options(async () => (++calls === 1 ? ok("x".repeat(600)) : { ok: false, reason: "rate-limited", error: "429", retryAfterMs: 30_000 }), 1));
    await b.run(new AbortController().signal);
    expect(calls).toBe(2);
    expect(nodes.get(key(0, 0))!.text).toHaveLength(600);
    expect(b.status.state).toBe("backoff");
    expect(b.status.until).toBeGreaterThan(Date.now() + 20_000);
  });

  it("keeps a line that failed three times failed, never cut to fit, and holding no feed slot (D458)", async () => {
    const { store, nodes } = treeStore(128);
    const b = new TreeBuilder(store, emptyViews(), options(async () => ({ ok: false, reason: "failed", error: "400" })));
    await b.run(new AbortController().signal);
    // Every message got its three tries; none was built from its own text.
    expect(nodes.size).toBe(0);
    expect(b.views.fed).toBe(128);
    expect(b.failedLines()).toHaveLength(128);
    expect(b.failedBefore(128)).toEqual({ i: 0, error: "400" });
    expect((b as unknown as { failures: Map<string, number> }).failures.size).toBe(0);
  });

  it("goes on with a merge its durable nodes allow after a stop before the views were saved", async () => {
    const { store, nodes, counts } = treeStore(253);
    await new TreeBuilder(store, emptyViews(), options(async () => ok("x".repeat(500)))).run(new AbortController().signal);
    // The views as saved before the last lines landed: every message fed, no batch yet.
    const stale = emptyViews();
    for (let i = 0; i < 253; i++) stale.chat.push([0, i]), stale.compaction.push([0, i]);
    stale.fed = 253;
    const built = nodes.size;
    let calls = 0;
    const b = new TreeBuilder(store, stale, options(async () => (calls++, ok("y"))));
    await b.run(new AbortController().signal);
    expect(calls).toBe(0);
    expect(nodes.size).toBe(built);
    expect(viewBytes(b.views.chat, b.nodes)).toBeLessThanOrEqual(VIEW_BYTES.chat[1]);
    expect(b.views.merging).toBe(false);
    expect(counts.views.at(-1)).toEqual(b.views);
  });

  it("counts the messages a turn still waits for", async () => {
    const hold = gate();
    const { store } = treeStore(3);
    const b = new TreeBuilder(store, emptyViews(), options(async () => (await hold.promise, ok("s"))));
    const run = b.run(new AbortController().signal);
    await tick();
    expect(b.unsummarized(3)).toBe(3);
    hold.release();
    await run;
    expect(b.unsummarized(3)).toBe(0);
  });
});
