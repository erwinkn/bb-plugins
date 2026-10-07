// The service signal lives as long as the plugin. Node 22's AbortSignal.any records each composite
// on every source and walks them all whenever one is collected, so per-read composites of the
// service signal froze the BB server; listeners left on it leaked one per tick or review.

import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { rig, oneLineDiff, type Rig } from "./helpers/world.js";

const API = { reviewEnabled: true, providerRequestsEnabled: true, route: "sonnet:anthropic-api", anthropicApiKey: "sk-ant-test", usdPerDay: 100, apiRequestsPerDay: 1000, budgetTimeZone: "UTC" };
const SONNET_OK = () =>
  new Response(JSON.stringify({ model: "claude-sonnet-5-5", content: [{ type: "text", text: '{"findings":[],"resolved":[]}' }], stop_reason: "end_turn", usage: { input_tokens: 3000, output_tokens: 200 } }), { status: 200 });

// Node keeps AbortSignal.any's composites in a private set on each source; absent means none.
function dependantsOf(signal: AbortSignal): number {
  const key = Object.getOwnPropertySymbols(signal).find((s) => s.description === "kDependantSignals");
  return key === undefined ? 0 : ((signal as unknown as Record<symbol, Set<unknown> | undefined>)[key]?.size ?? 0);
}

function turn(r: Rig, thread: string, n: number) {
  r.world.turnStart(thread);
  r.world.fileChange(thread, `/repo/tests/t${n}.test.ts`, oneLineDiff(1, "expect(a).toBe(1);", `expect(a).toBe(${n});`));
  r.world.turnEnd(thread);
}

describe("the service signal", () => {
  it("is left with no dependants or listeners after hundreds of ticks with reads, checkpoints and reviews", async () => {
    const posts: string[] = [];
    const r = await rig({ ...API }, { fetch: async (u) => (posts.push(u), SONNET_OK()) });
    const threads = ["thr_a", "thr_b", "thr_c"];
    for (const t of threads) {
      r.world.addThread(t);
      await r.advisor.watch(t, "test");
    }
    const service = new AbortController();
    const any = vi.spyOn(AbortSignal, "any");
    try {
      for (let i = 0; i < 300; i++) {
        turn(r, threads[i % threads.length]!, i);
        r.clock.advance(60_000);
        await r.advisor.tick(service.signal);
        await r.advisor.idle();
      }
      expect(any.mock.calls.length).toBeGreaterThan(300);
      expect(any.mock.calls.filter(([signals]) => [...signals].includes(service.signal)).length).toBe(0);
    } finally {
      any.mockRestore();
    }
    expect(posts.length).toBeGreaterThan(0);
    expect(getEventListeners(service.signal, "abort")).toEqual([]);
    expect(dependantsOf(service.signal)).toBe(0);
  });

  it("keeps one listener for the current wait across many loop passes, and still stops the loop", async () => {
    const r = await rig({});
    const service = new AbortController();
    const internals = r.advisor as unknown as { wakeResolve: (() => void) | null };
    const done = r.advisor.run(service.signal);
    const waiting = () => vi.waitFor(() => expect(internals.wakeResolve).not.toBeNull(), { interval: 1 });
    for (let i = 0; i < 100; i++) {
      await waiting();
      r.advisor.wake();
    }
    await waiting();
    expect(getEventListeners(service.signal, "abort")).toHaveLength(1);
    service.abort("unloading");
    await done;
    expect(getEventListeners(service.signal, "abort")).toEqual([]);
  });

  it("stops right away when the signal aborts during a tick, instead of after a poll interval", async () => {
    const r = await rig({});
    const service = new AbortController();
    (r.advisor as unknown as { tick: () => Promise<void> }).tick = async () => service.abort("unloading");
    const ended = await Promise.race([r.advisor.run(service.signal).then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), 200))]);
    expect(ended).toBe(true);
    expect(getEventListeners(service.signal, "abort")).toEqual([]);
  });
});
