import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { projectFixture } from "./fake-native";
import { TreeBuilder, type NodeHow, type TreeStore } from "../lib/memory/builder";
import type { ListEvents } from "../lib/memory/ingest";
import { CoordinatorMemory } from "../lib/memory/memory";
import { MEMORY_MIGRATIONS } from "../lib/memory/store";
import type { Summarizer, SummarizerResult } from "../lib/memory/summarizer";
import { NodeCache, VIEW_BYTES, emptyViews, key, viewBytes, type Views } from "../lib/memory/tree";

// W225: regressions for W222's review of the coordinator memory (W220, D431 phase 1), one or more
// per finding, against an in-memory database, a fake event list and a fake summarizer.

const usage = { input: 100, cached: 0, output: 10, reasoning: 0 };
const ok = (text: string): SummarizerResult => ({ ok: true, text, usage, latencyMs: 1 });
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
};
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
type Event = Awaited<ReturnType<ListEvents>>[number];
const turn = (seq: number, text: string, source = "tell"): Event => ({ seq, type: "client/turn/requested", createdAt: seq, data: { initiator: "user", source, input: [{ type: "text", text }] } } as Event);
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

function setup(list: ListEvents, options: { generations?: string[]; ended?: Record<string, number>; summarizer?: Summarizer } = {}) {
  const watch = { closed: false, touched: [] as string[] };
  const db = watched(new Database(":memory:"), watch);
  for (const sql of MEMORY_MIGRATIONS) db.exec(sql);
  const project = { id: "p", archivedAt: null, coordinatorThreadId: "current" };
  const ledger = {
    db,
    now: () => Date.now(),
    project: () => project,
    projects: () => [project],
    generations: () => (options.generations ?? []).map((threadId) => ({ threadId, endedAt: options.ended?.[threadId] ?? null })),
    membership: () => null,
    activity: [] as string[],
    flags: new Set<string>(),
    hasFlag: (flag: string) => ledger.flags.has(flag),
    setFlag: (flag: string) => void ledger.flags.add(flag),
    log: (_projectId: string, _kind: string, summary: string) => void ledger.activity.push(summary),
  };
  const memory = new CoordinatorMemory({
    ledger: ledger as never,
    list,
    threadStatus: async () => "idle",
    preferences: () => ({ coordinatorCompactTokens: 300_000, hybridCompactTokens: 150_000, memoryEffort: "xhigh", memoryConcurrency: 8, coordinatorInstructions: "" }) as never,
    summarizer: options.summarizer ?? (async () => ok("summary")),
    log: () => {},
  });
  /** Dispose the memory as the plugin stops; from now on the database may not be touched. */
  const stop = () => {
    memory.dispose();
    watch.closed = true;
  };
  return { db, memory, stop, watch, activity: ledger.activity };
}
const hybridWith = (memory: CoordinatorMemory, texts: string[]) => {
  memory.store.addCursor("p", "current");
  memory.store.append("p", "current", texts.map((text, k) => ({ kind: "user", text, at: 1, threadId: "current", seq: k + 1 })), texts.length);
  memory.store.saveSettings("p", { mode: "hybrid", compactTokens: null });
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
    const { db, memory, stop, watch } = setup(async (a) => (await hold.promise, a.order === "desc" || a.types[0] === "client/turn/requested" ? [turn(1, "late")] : []));
    memory.store.addCursor("p", "current");
    memory.kick("p");
    await tick();
    stop();
    hold.release();
    await memory.settled();
    expect(watch.touched).toEqual([]);
    memory.start();
    expect(memory.store.count("p")).toBe(0);
    expect(memory.store.cursors("p")[0]!.lastSeq).toBe(0);
    db.close();
  });

  it("finishes no former coordinator whose status read completes after dispose", async () => {
    const hold = gate();
    const { db, memory, stop, watch } = setup(listing({ old: [turn(1, "old")] }));
    (memory as unknown as { deps: { threadStatus: () => Promise<string> } }).deps.threadStatus = async () => (await hold.promise, "idle");
    memory.store.addCursor("p", "old", 1);
    memory.store.addCursor("p", "current", 2);
    memory.kick("p");
    await tick();
    stop();
    hold.release();
    await memory.settled();
    expect(watch.touched).toEqual([]);
    memory.start();
    expect(memory.store.cursors("p").map((c) => c.done)).toEqual([false, false]);
    db.close();
  });

  it("records no call and saves no node when a summary lands after dispose", async () => {
    const hold = gate();
    const { db, memory, stop, watch } = setup(listing({}), { summarizer: async () => (await hold.promise, ok("late summary")) });
    hybridWith(memory, ["x".repeat(700), "y".repeat(700)]);
    memory.build("p");
    await tick();
    stop();
    hold.release();
    await memory.settled();
    // Neither the call's record, nor its node, nor the requeue's check reaches the database,
    // and the store itself refuses whatever else would.
    expect(watch.touched).toEqual([]);
    expect(() => memory.store.count("p")).toThrow(/closed/);
    expect(watch.touched).toEqual([]);
    memory.start();
    expect(memory.store.totals("p")).toMatchObject({ calls: 0, nodes: 0 });
    expect(memory.store.node("p", 0, 0)).toBeNull();
    db.close();
  });
});

describe("W225 shutdown: no SDK read starts after dispose (P2)", () => {
  it("reads no pages once disposed while the boundary read was pending", async () => {
    const hold = gate();
    const calls: string[] = [];
    let disposed = false;
    const list = listing({ current: [turn(1, "late")] });
    const { db, memory, stop } = setup(async (a) => {
      if (disposed) calls.push(`${a.order} ${a.types.join(",")}`);
      if (a.order === "desc") await hold.promise;
      return list(a);
    });
    memory.store.addCursor("p", "current");
    memory.kick("p");
    await tick();
    stop();
    disposed = true;
    hold.release();
    await memory.settled();
    expect(calls).toEqual([]);
    db.close();
  });
});

describe("W225 a replacement coordinator's first session (P1)", () => {
  it("gets the hybrid tools and guidance before its spawn is confirmed", async () => {
    const { f, project } = await projectFixture();
    await f.perform(project.id, { action: "memory", mode: "hybrid" }, "user", null);
    await f.service.memory.settled();
    const original = f.spawn.getMockImplementation()!;
    let seen: Awaited<ReturnType<typeof f.harness.resolveAgentConfiguration>> | undefined;
    f.spawn.mockImplementationOnce(async (args) => {
      const thread = await original(args);
      seen = await f.harness.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread, origin: { pluginId: "projects" }, pluginMetadata: args.pluginMetadata }));
      return thread;
    });
    f.idle("coordinator");
    await f.service.replaceCoordinator(project.id, { reason: "Fresh hybrid context" });
    expect(seen!.instructions).toContain("pending coordinator");
    expect(seen!.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["initiative_zoom", "initiative_date"]));
    expect(seen!.instructions).toMatch(/pending coordinator[\s\S]*\n\nMemory \(hybrid\)/);
    await f.service.memory.settled();
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
    const { db, memory } = setup(listing({}));
    hybridWith(memory, ["a".repeat(700), "b".repeat(700)]);
    const tree = memory.store.tree("p");
    for (let i = 0; i < 2000; i++) tree.saveNode(0, i, "x".repeat(400), i % 100 ? "model" : "fallback", 1);
    tree.saveNode(0, 0, "duplicate", "model", 1);
    tree.saveViews({ ...emptyViews(), fed: 2, chat: [[0, 0], [0, 1]], compaction: [[0, 0], [0, 1]] });
    const read = memory.store.node.bind(memory.store);
    let reads = 0;
    memory.store.node = (projectId, l, i) => (reads++, read(projectId, l, i));
    memory.store.saveSettings("p", { mode: "regular", compactTokens: null });
    const status = memory.status("p");
    expect(status.tree).toMatchObject({ nodes: 2000, fallbacks: 20 });
    expect(status.log.bytes).toBe(memory.store.messages("p").reduce((sum, m) => sum + m.size, 0));
    expect(reads).toBeLessThanOrEqual(4);
    db.close();
  });
});

describe("W225 aborted builds stay owned until settled (P2)", () => {
  it("settles only once a stopped run's call returns, and a switch back starts after it", async () => {
    const hold = gate();
    let live = 0;
    let most = 0;
    const { db, memory } = setup(listing({}), {
      summarizer: async () => {
        most = Math.max(most, ++live);
        await hold.promise;
        live--;
        return ok("summary");
      },
    });
    hybridWith(memory, ["x".repeat(700), "y".repeat(700)]);
    memory.build("p");
    await tick();
    expect(live).toBe(2);
    memory.configure("p", { mode: "regular" }, "user");
    let settled = false;
    const settling = memory.settled().then(() => (settled = true));
    await tick();
    expect(settled).toBe(false);
    // Back to hybrid while the stopped run still holds its calls: the next run waits for it.
    memory.configure("p", { mode: "hybrid" }, "user");
    await tick();
    expect(live).toBe(2);
    hold.release();
    await settling;
    expect(live).toBe(0);
    expect(most).toBe(2);
    expect(memory.status("p").tree).toMatchObject({ nodes: 3, summarized: 2, state: "idle" });
    db.close();
  });
});

describe("W225 the log: every event once, in order (P1, P2)", () => {
  it("never skips an event that lands while the event types are read", async () => {
    const events: Record<string, Event[]> = { current: [turn(1, "first")] };
    const list = listing(events);
    let landed = false;
    const { db, memory } = setup((a) => {
      const rows = list(a);
      // Once the input page is read, an input (2) and a reply (3) land before the item page is read.
      if (!landed && a.order === "asc" && a.types[0] === "client/turn/requested") {
        landed = true;
        events.current!.push(turn(2, "second"), { seq: 3, type: "item/completed", createdAt: 3, data: { item: { type: "agentMessage", id: "i3", text: "third" } } } as Event);
      }
      return rows;
    });
    memory.store.addCursor("p", "current");
    await memory.ingest("p");
    await memory.ingest("p");
    expect(memory.store.messages("p").map((m) => m.text)).toEqual(["first", "second", "third"]);
    db.close();
  });

  it("keeps a former coordinator's final reply that lands during the read, ahead of the new coordinator's input", async () => {
    const events: Record<string, Event[]> = { old: [turn(1, "old input")], current: [] };
    const list = listing(events);
    let landed = false;
    const { db, memory } = setup((a) => {
      const rows = list(a);
      // Its final reply lands once the boundary is read, then the new coordinator's first input;
      // from then on the old thread is idle.
      if (!landed && a.threadId === "old" && a.order === "desc") {
        landed = true;
        events.old!.push({ seq: 2, type: "item/completed", createdAt: 2, data: { item: { type: "agentMessage", id: "i2", text: "final reply" } } } as Event);
        events.current!.push(turn(3, "current input"));
      }
      return rows;
    });
    (memory as unknown as { deps: { threadStatus: () => Promise<string> } }).deps.threadStatus = async () => (landed ? "idle" : "active");
    memory.store.addCursor("p", "old", 1);
    memory.store.addCursor("p", "current", 2);
    await memory.ingest("p");
    await memory.ingest("p");
    expect(memory.store.messages("p").map((m) => m.text)).toEqual(["old input", "final reply", "current input"]);
    expect(memory.store.cursors("p")[0]).toMatchObject({ threadId: "old", lastSeq: 2, done: true });
    db.close();
  });

  it("stops holding the current coordinator back once a former one is busy 10 minutes after its replacement", async () => {
    const events: Record<string, Event[]> = { old: [turn(1, "old input")], current: [turn(3, "current input")] };
    let busy = true;
    const ended = { old: Date.now() - 5 * 60_000 };
    const { db, memory, activity } = setup(listing(events), { generations: ["old"], ended });
    (memory as unknown as { deps: { threadStatus: () => Promise<string> } }).deps.threadStatus = async () => (busy ? "active" : "idle");
    memory.store.addCursor("p", "old", 1);
    memory.store.addCursor("p", "current", 2);
    // Five minutes after its replacement, the current coordinator still waits.
    await memory.ingest("p");
    expect(memory.store.messages("p").map((m) => m.text)).toEqual(["old input"]);
    // Past ten minutes it is logged, with one note, and the former's tail follows when it lands.
    ended.old = Date.now() - 11 * 60_000;
    await memory.ingest("p");
    await memory.ingest("p");
    expect(memory.store.messages("p").map((m) => m.text)).toEqual(["old input", "current input"]);
    expect(activity).toEqual([expect.stringMatching(/former coordinator \(thread old\) is still busy 10 minutes after its replacement/)]);
    events.old!.push({ seq: 2, type: "item/completed", createdAt: 2, data: { item: { type: "agentMessage", id: "i2", text: "late reply" } } } as Event);
    busy = false;
    await memory.ingest("p");
    expect(memory.store.messages("p").map((m) => m.text)).toEqual(["old input", "current input", "late reply"]);
    expect(memory.store.cursors("p")[0]).toMatchObject({ threadId: "old", done: true });
    db.close();
  });

  it("drains an older coordinator's backlog before a newer one appends", async () => {
    const old = Array.from({ length: 2101 }, (_, i) => turn(i + 1, `old ${i}`));
    const { db, memory } = setup(listing({ old, current: [turn(3000, "current")] }));
    memory.store.addCursor("p", "old", 1);
    memory.store.addCursor("p", "current", 2);
    expect(await memory.ingest("p")).toMatchObject({ appended: 2000, behind: true });
    await memory.ingest("p");
    const texts = memory.store.messages("p").map((m) => m.text);
    expect(texts).toHaveLength(2102);
    expect(texts.indexOf("current")).toBe(2101);
    expect(texts.slice(1999, 2001)).toEqual(["old 1999", "old 2000"]);
    db.close();
  });
});

describe("W225 seeding completes or retries (P2)", () => {
  const start = turn(1, "This thread is starting as coordinator of a new Initiative \"X\".", "spawn");

  it("saves nothing when a read fails, and seeds the whole chain on the next pass", async () => {
    let failing = true;
    const list = listing({ old: [start], current: [turn(2, "current")] });
    const { db, memory } = setup(async (a) => {
      if (failing && a.threadId === "current") throw new Error("temporary events read failure");
      return list(a);
    }, { generations: ["old"] });
    await expect(memory.ingest("p")).rejects.toThrow(/temporary/);
    expect(memory.store.cursors("p")).toEqual([]);
    failing = false;
    await memory.ingest("p");
    expect(memory.store.cursors("p").map((c) => c.threadId)).toEqual(["old", "current"]);
    expect(memory.store.messages("p").map((m) => m.text)).toEqual([start.data!.input[0].text, "current"]);
    db.close();
  });

  it("reaches back past four generations to the thread that starts afresh", async () => {
    const generations = ["g1", "g2", "g3", "g4", "g5", "g6"];
    const { db, memory } = setup(listing({ g1: [turn(1, "before")], g2: [start], current: [turn(9, "now")] }), { generations });
    await memory.ingest("p");
    expect(memory.store.cursors("p").map((c) => c.threadId)).toEqual(["g2", "g3", "g4", "g5", "g6", "current"]);
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

  it("forgets a node's failures once it is cut to fit", async () => {
    const { store, nodes } = treeStore(128);
    const b = new TreeBuilder(store, emptyViews(), options(async () => ({ ok: false, reason: "failed", error: "400" })));
    await b.run(new AbortController().signal);
    expect(nodes.size).toBe(255);
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

  it("starts a chat batch when built lines push a quiet chat past 128 KB, and saves it", async () => {
    const { store, counts } = treeStore(253);
    const b = new TreeBuilder(store, emptyViews(), options(async () => ok("x".repeat(500))));
    await b.run(new AbortController().signal);
    expect(viewBytes(b.views.chat, b.nodes)).toBeLessThanOrEqual(VIEW_BYTES.chat[1]);
    expect(b.views.merging).toBe(false);
    expect(counts.views.at(-1)).toEqual(b.views);
  });
});

describe("W225 summary waiters end with their builder (P2)", () => {
  it("resolves false on a switch to regular, and on dispose", async () => {
    const hold = gate();
    const { db, memory } = setup(listing({}), { summarizer: async () => (await hold.promise, ok("summary")) });
    hybridWith(memory, ["x".repeat(700)]);
    const forever = new AbortController().signal;
    const switched = memory.waitSummarized("p", 1, forever);
    await tick();
    memory.configure("p", { mode: "regular" }, "user");
    expect(await switched).toBe(false);
    memory.configure("p", { mode: "hybrid" }, "user");
    const disposed = memory.waitSummarized("p", 1, forever);
    await tick();
    memory.dispose();
    expect(await disposed).toBe(false);
    hold.release();
    await memory.settled();
    db.close();
  });
});
