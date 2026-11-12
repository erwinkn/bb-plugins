import { describe, expect, it } from "vitest";
import { TreeBuilder, type TreeStore } from "../lib/builder";
import { chatBounds } from "../lib/store";
import type { Summarizer, SummarizerRequest } from "../lib/summarizer";
import { LIMIT, NodeCache, VIEW_BYTES, emptyViews, key, viewBytes, type NodeRef, type ViewBounds, type Views } from "../lib/tree";
import { fakeLuna, fixture } from "./fixture";

// W604: an Initiative worker's chat view is on a 64→32 KB sawtooth, a coordinator's stays on
// 128→64 KB; a worker view saved over its new bound shrinks at its first settle, with no call.

/** A line of about 400 bytes, so a view passes 64 KB within ~160 lines. */
const wide: Summarizer = async (r: SummarizerRequest) => {
  const reply = await fakeLuna(r);
  return reply.ok ? { ...reply, text: reply.text.padEnd(400, "x") } : reply;
};

function memoryStore(count: number) {
  const nodes = new Map<string, string>();
  const saved: Views[] = [];
  let calls = 0;
  const store: TreeStore = {
    messageCount: () => count,
    message: (i) => (i < count ? { kind: "user", text: `message ${i} `.padEnd(700, "y") } : null),
    node: (l, i) => nodes.get(key(l, i)) ?? null,
    built: (l, from, to) => [...nodes.keys()].map((k) => k.split(":").map(Number) as NodeRef).filter(([nl, i]) => nl === l && i >= from && i < to).map(([, i]) => i),
    saveNode: (l, i, text) => void nodes.set(key(l, i), text),
    saveViews: (views) => void saved.push(structuredClone(views)),
    recordCall: () => void calls++,
  };
  return { store, saved, calls: () => calls };
}
const build = (store: TreeStore, summarize: Summarizer, chatBounds?: ViewBounds, views = emptyViews()) =>
  new TreeBuilder(store, views, { summarize, instructions: () => "system", effort: () => "high", concurrency: () => 8, cacheKey: "k", chatBounds });
// A batch merges only pairs whose parent is built: a view passes its bound by at most the lines
// still being built (8 at once).
const slack = 9 * (LIMIT + 20);

describe("W604 chat view bounds by role", () => {
  it("gives an Initiative worker's private scope the worker's bounds, every other scope the coordinator's", () => {
    expect(chatBounds("initiatives:prj_2f8657f020:worker:604")).toEqual([64_000, 32_000]);
    expect(chatBounds("initiatives:prj_2f8657f020")).toEqual([128_000, 64_000]);
    expect(chatBounds("chat-memory:thr_968w2bk28m")).toEqual([128_000, 64_000]);
    // Only the Initiatives owner's worker key counts.
    expect(chatBounds("chat-memory:worker:1")).toEqual(VIEW_BYTES.chat);
  });

  it("keeps a worker's view under 64 KB, merged back to 32 KB, and a coordinator's up to 128 KB", async () => {
    const sizes = async (bounds?: ViewBounds) => {
      const { store, saved } = memoryStore(900);
      const b = build(store, async (r) => ({ ok: true, text: `L ${r.input.at(-1)!.content[0]!.text.length}`.padEnd(500, "x"), usage: { input: 1, cached: 0, output: 1, reasoning: 0 }, latencyMs: 1 }), bounds);
      await b.run(new AbortController().signal);
      return saved.map((v) => viewBytes(v.chat, b.nodes));
    };
    const worker = await sizes(VIEW_BYTES.workerChat);
    expect(Math.max(...worker)).toBeLessThanOrEqual(64_000 + slack);
    const batches = worker.filter((s, k) => k > 0 && s < worker[k - 1]!);
    expect(batches.length).toBeGreaterThanOrEqual(8);
    for (const s of batches) expect(s).toBeLessThanOrEqual(32_000 + slack);
    const coordinator = await sizes();
    expect(Math.max(...coordinator)).toBeGreaterThan(120_000);
    expect(Math.max(...coordinator)).toBeLessThanOrEqual(128_000 + slack);
  });

  it("merges a worker view saved over its new bound at its first settle, with no summarizer call", async () => {
    const { store, saved, calls } = memoryStore(300);
    const summarize: Summarizer = async () => ({ ok: true, text: "y".repeat(500), usage: { input: 1, cached: 0, output: 1, reasoning: 0 }, latencyMs: 1 });
    // Built under today's bounds: 300 lines of ~510 bytes sit between 64 and 128 KB.
    const before = build(store, summarize);
    await before.run(new AbortController().signal);
    const views = structuredClone(before.views);
    expect(viewBytes(views.chat, before.nodes)).toBeGreaterThan(VIEW_BYTES.workerChat[0]);
    const made = calls();
    // A reload: the worker's builder recovers the saved view and settles it, with every node built.
    const after = build(store, async () => {
      throw new Error("no call");
    }, VIEW_BYTES.workerChat, views);
    await after.run(new AbortController().signal);
    expect(calls()).toBe(made);
    expect(viewBytes(after.views.chat, after.nodes)).toBeLessThanOrEqual(VIEW_BYTES.workerChat[1]);
    expect(after.views.merging).toBe(false);
    expect(saved.at(-1)).toEqual(after.views);
  });

  it("runs a worker scope's turns on the worker's bounds and a coordinator's on its own", async () => {
    const f = fixture();
    f.memory.useSummarizer(wide);
    const coordinator = await f.attach("initiatives", "prj_a", f.thread("c"));
    const worker = await f.attach("initiatives", "prj_a:worker:7", f.thread("w"));
    expect(worker).toBe("initiatives:prj_a:worker:7");
    for (let n = 0; n < 140; n++) {
      // Longer than a line, so each is summarized (by `wide`) rather than kept as it is.
      f.turn("c", `coordinator message ${n} `.padEnd(700, "y"), `re ${n} `.padEnd(700, "z"));
      f.turn("w", `worker message ${n} `.padEnd(700, "y"), `re ${n} `.padEnd(700, "z"));
    }
    await f.idle("c");
    await f.idle("w");
    const size = (scope: string) => viewBytes(f.store.views(scope).chat, new NodeCache((l, i) => f.store.tree(scope).node(l, i)));
    // 280 lines of ~410 bytes, 115 KB: the worker's view merged back under 64 KB, the coordinator's has not merged.
    expect(f.store.count(worker)).toBe(280);
    expect(size(worker)).toBeLessThanOrEqual(64_000);
    expect(size(coordinator)).toBeGreaterThan(100_000);
    expect(f.store.views(coordinator).chat.every(([l]) => l === 0)).toBe(true);
  }, 30_000); // 560 real turns through the service: about 5 s, over vitest's default.
});
