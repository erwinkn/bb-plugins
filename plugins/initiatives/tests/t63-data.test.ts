import { describe, expect, it, vi } from "vitest";
import { SharedReads } from "../lib/dashboard-data";
import { projectFixture } from "./fake-native";
import { buildOverview, buildSummary } from "../lib/overview";
const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

describe("T63 shared keyed reads", () => {
  it("shares simultaneous requests, displays the first valid result, retains content on refresh failure", async () => {
    const cache = new SharedReads(); const held = deferred<string>(); const fetch = vi.fn(() => held.promise);
    const a = cache.refresh("p1", fetch), b = cache.refresh("p1", fetch);
    expect(a).toBe(b); held.resolve("valid"); await a;
    expect(fetch).toHaveBeenCalledTimes(1); expect(cache.entry("p1").data).toBe("valid");
    // W196: one failure stays quiet; the second in a row shows its error.
    await cache.refresh("p1", () => Promise.reject(new Error("offline")));
    expect(cache.entry("p1")).toMatchObject({ data: "valid", error: null });
    await cache.refresh("p1", () => Promise.reject(new Error("offline")));
    expect(cache.entry("p1")).toMatchObject({ data: "valid", error: "offline" });
    expect(cache.entry("p2").data).toBeNull();
  });
  it("rejects pre-save snapshots, holds reads during mutation and shares the post-save fetch", async () => {
    const cache = new SharedReads(); await cache.refresh("p1", async () => ({ verdict: "pending" }));
    const old = deferred<unknown>(); const first = cache.refresh("p1", () => old.promise);
    const end = cache.begin("p1"); const held = vi.fn(); await cache.refresh("p1", held); expect(held).not.toHaveBeenCalled();
    end(() => ({ verdict: "okay" }));
    const post = deferred<unknown>(); const fetch = vi.fn(() => post.promise);
    const a = cache.refresh("p1", fetch), b = cache.refresh("p1", fetch);
    old.resolve({ verdict: "pending" }); await first;
    expect(cache.entry("p1").data).toEqual({ verdict: "okay" });
    expect(a).toBe(b); post.resolve({ verdict: "okay" }); await a;
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("coalesces scheduled invalidations and cancels unsubscribed work", async () => {
    vi.useFakeTimers();
    try {
      const cache = new SharedReads(); const fetch = vi.fn(async () => "value");
      const unsubscribe = cache.subscribe("p1", vi.fn());
      for (let n = 0; n < 5; n++) cache.schedule("p1", fetch);
      await vi.advanceTimersByTimeAsync(150); expect(fetch).toHaveBeenCalledTimes(1);
      cache.schedule("p1", fetch); unsubscribe(); await vi.advanceTimersByTimeAsync(150);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});

describe("T63 cheap summary/dashboard reads", () => {
  it("list/tree and compact overview avoid usage turns and worker generation histories in a large corpus", async () => {
    const { f, project } = await projectFixture();
    f.store.tx(() => {
    for (let n = 0; n < 120; n++) f.task(project.id, `Task ${n}`);
    for (let n = 0; n < 30; n++) {
      const w = f.store.createWorker({ projectId: project.id, role: "work", label: `Worker ${n}`, area: "fixture", bbProjectId: "proj_a" });
      for (let generation = 1; generation <= 8; generation++) {
        f.store.openGeneration(project.id, w.num, generation, `history-${n}-${generation}`);
        f.store.closeGeneration(project.id, w.num, "Fixture history");
      }
      f.store.updateWorker(project.id, w.num, { threadId: `current-${n}`, generation: 9 });
      f.store.openGeneration(project.id, w.num, 9, `current-${n}`);
    }
    });
    const usage = vi.spyOn(f.store, "projectUsage"), turns = vi.spyOn(f.store, "usageTurns"), generations = vi.spyOn(f.store, "generations");
    const summary = buildSummary(f.store, project.id);
    expect(summary.remaining).toBe(120);
    await f.harness.callRpc("list", null); await f.harness.callRpc("tree", null);
    expect(usage).not.toHaveBeenCalled(); expect(turns).not.toHaveBeenCalled(); expect(generations).not.toHaveBeenCalled();
    const compact = buildOverview(f.store, project.id, new Map(), Date.now(), null, false);
    expect(compact.detailsLoaded).toBe(false); expect(compact.remaining).toHaveLength(120);
    expect(compact.memberThreads).toEqual([]); expect(usage).not.toHaveBeenCalled(); expect(turns).not.toHaveBeenCalled();
    const detailed = buildOverview(f.store, project.id, new Map(), Date.now());
    expect(detailed.memberThreads.length).toBeGreaterThan(0); expect(usage).toHaveBeenCalled();
    expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(Buffer.byteLength(JSON.stringify(detailed)));
  });
});
