import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectFixture } from "./fake-native";

// W193: the sweep never hands the long-lived service signal to the BB SDK. The SDK wraps each
// signal it gets in AbortSignal.any with a 75 s timeout; on the service signal those composites
// stay recorded for 75 s each, and hundreds of them made every GC walk the set.

/** Node keeps AbortSignal.any's composites in a private set on each source signal; absent means none. */
function dependantsOf(signal: AbortSignal): number {
  const key = Object.getOwnPropertySymbols(signal).find(symbol => symbol.description === "kDependantSignals");
  return key === undefined ? 0 : (signal as unknown as Record<symbol, Set<unknown>>)[key].size;
}

afterEach(() => vi.restoreAllMocks());

describe("W193 sweep signals", () => {
  it("after many sweep passes the service signal has no listeners and no dependants, and never reaches AbortSignal.any", async () => {
    const { f } = await projectFixture();
    const service = new AbortController().signal;
    const any = vi.spyOn(AbortSignal, "any");
    const listed: AbortSignal[] = [];
    // Do what the BB SDK does with a signal it is given.
    f.intercept((path, args, call) => {
      const signal = (args as { signal?: AbortSignal } | undefined)?.signal;
      if (signal) {
        listed.push(signal);
        AbortSignal.any([signal, AbortSignal.timeout(75_000)]);
      }
      return call();
    });
    for (let pass = 0; pass < 40; pass++) await f.runtime.sweep(service);
    expect(listed.length).toBeGreaterThanOrEqual(40);
    expect(listed).not.toContain(service);
    // One signal per pass, not one shared signal.
    expect(new Set(listed).size).toBeGreaterThanOrEqual(40);
    expect(any.mock.calls.some(([sources]) => [...sources].includes(service))).toBe(false);
    expect(getEventListeners(service, "abort")).toEqual([]);
    expect(dependantsOf(service)).toBe(0);
    // Each pass's signal is aborted when the pass ends.
    expect(listed.every(signal => signal.aborted)).toBe(true);
  });

  it("aborting the service signal aborts the running pass, and a pass started after it does nothing", async () => {
    const { f } = await projectFixture();
    const controller = new AbortController();
    let seen: AbortSignal | null = null;
    f.intercept((path, args, call) => {
      const signal = (args as { signal?: AbortSignal } | undefined)?.signal;
      if (signal && !seen) {
        seen = signal;
        controller.abort("stopping");
      }
      return call();
    });
    await f.runtime.sweep(controller.signal);
    expect(seen).not.toBeNull();
    expect(seen!.aborted).toBe(true);
    expect(seen!.reason).toBe("stopping");
    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
    const calls: string[] = [];
    f.intercept((path, _args, call) => { calls.push(path); return call(); });
    await f.runtime.sweep(controller.signal);
    expect(calls.filter(p => p === "threads.list" )).toEqual([]);
  });
});
