// T129 hardening: a read whose RPC never settles must not freeze its view
// until a reload. It fails after READ_TIMEOUT_MS; the next signal or poll
// reads again, and the late answer is ignored.
import { describe, expect, it, vi } from "vitest";
import { READ_TIMEOUT_MS, SharedReads } from "../lib/dashboard-data";

describe("T129 shared reads time out", () => {
  it("a hung read fails after the timeout, keeps the last value, and the next schedule reads again", async () => {
    vi.useFakeTimers();
    try {
      const cache = new SharedReads();
      const listener = vi.fn();
      cache.subscribe("k", listener);
      await cache.refresh("k", async () => "before");
      let answerLate!: (value: string) => void;
      const fetch = vi.fn()
        .mockReturnValueOnce(new Promise<string>((resolve) => { answerLate = resolve; }))
        .mockResolvedValue("after");
      void cache.refresh("k", fetch);
      // While it hangs, refreshes join it.
      cache.schedule("k", fetch);
      await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS - 1);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(cache.entry("k").pending).not.toBeNull();
      // Timed out: the scheduled catch-up reads again at once.
      await vi.advanceTimersByTimeAsync(1);
      expect(fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(cache.entry("k")).toMatchObject({ data: "after", error: null, pending: null });
      // The hung read's late answer changes nothing.
      answerLate("stale");
      await vi.advanceTimersByTimeAsync(0);
      expect(cache.entry("k").data).toBe("after");
    } finally { vi.useRealTimers(); }
  });

  it("with no change pending, a timed-out read reports the error and the next refresh recovers", async () => {
    vi.useFakeTimers();
    try {
      const cache = new SharedReads();
      cache.subscribe("k", vi.fn());
      await cache.refresh("k", async () => "before");
      void cache.refresh("k", () => new Promise(() => {}));
      await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
      expect(cache.entry("k")).toMatchObject({ data: "before", error: expect.stringMatching(/did not answer in time/), pending: null });
      await cache.refresh("k", async () => "after");
      expect(cache.entry("k")).toMatchObject({ data: "after", error: null });
    } finally { vi.useRealTimers(); }
  });
});
