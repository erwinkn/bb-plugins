import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { linkSignals } from "./signals.js";
import { dependantsOf } from "./testing/signals.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("linkSignals", () => {
  it("aborts with the reason of the first source to abort", () => {
    const first = new AbortController();
    const second = new AbortController();
    const link = linkSignals([first.signal, second.signal]);
    second.abort("second");
    first.abort("first");
    expect(link.signal.aborted).toBe(true);
    expect(link.signal.reason).toBe("second");
    expect(getEventListeners(first.signal, "abort")).toEqual([]);
  });

  it("starts aborted with the first already-aborted source's reason, like AbortSignal.any", () => {
    const live = new AbortController();
    const link = linkSignals([
      live.signal,
      AbortSignal.abort("one"),
      AbortSignal.abort("two"),
    ]);
    expect(link.signal.reason).toBe("one");
    expect(
      AbortSignal.any([live.signal, AbortSignal.abort("one")]).reason,
    ).toBe("one");
    expect(getEventListeners(live.signal, "abort")).toEqual([]);
  });

  // W195's parity probes: each case runs against native AbortSignal.any and linkSignals.
  const both = [
    ["AbortSignal.any", (sources: AbortSignal[]) => AbortSignal.any(sources)],
    ["linkSignals", (sources: AbortSignal[]) => linkSignals(sources).signal],
  ] as const;

  it.each(both)(
    "%s takes the earlier source's reason when its listener aborts a later source",
    (_name, make) => {
      const first = new AbortController();
      const second = new AbortController();
      first.signal.addEventListener("abort", () => second.abort("second"));
      const signal = make([first.signal, second.signal]);
      first.abort("first");
      expect(signal.reason).toBe("first");
    },
  );

  it.each(both)(
    "%s aborts even when an earlier listener stops immediate propagation",
    (_name, make) => {
      const source = new AbortController();
      source.signal.addEventListener("abort", (event) =>
        event.stopImmediatePropagation(),
      );
      const signal = make([source.signal]);
      source.abort("canceled");
      expect(signal.aborted).toBe(true);
      expect(signal.reason).toBe("canceled");
    },
  );

  it("times out with AbortSignal.timeout's TimeoutError, and dispose clears the timer", () => {
    vi.useFakeTimers();
    const timed = linkSignals([], 1_000);
    const disposed = linkSignals([], 1_000);
    disposed.dispose();
    vi.advanceTimersByTime(999);
    expect(timed.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(timed.signal.reason).toBeInstanceOf(DOMException);
    expect((timed.signal.reason as DOMException).name).toBe("TimeoutError");
    expect((timed.signal.reason as DOMException).message).toBe(
      "The operation was aborted due to timeout",
    );
    expect(disposed.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves a long-lived source with no listeners or dependants after thousands of links", () => {
    const lifetime = new AbortController();
    for (let i = 0; i < 5_000; i++) {
      const request = new AbortController();
      const link = linkSignals([request.signal, lifetime.signal], 60_000);
      if (i % 2 === 0) request.abort("canceled");
      link.dispose();
    }
    expect(getEventListeners(lifetime.signal, "abort")).toEqual([]);
    expect(dependantsOf(lifetime.signal)).toBe(0);
    const live = linkSignals([lifetime.signal]);
    lifetime.abort("stopped");
    expect(live.signal.reason).toBe("stopped");
  });

  it("detects AbortSignal.any dependants, so the check above can fail", () => {
    const lifetime = new AbortController();
    const kept = AbortSignal.any([lifetime.signal]);
    kept.addEventListener("abort", () => {}); // Node 24 records a composite once it is observed
    expect(dependantsOf(lifetime.signal)).toBe(1);
    expect(kept.aborted).toBe(false);
  });
});
