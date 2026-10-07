// T129 hardening: a read whose RPC never settles must not freeze its view
// until a reload. It fails after READ_TIMEOUT_MS; the next signal or poll
// reads again, and the late answer is ignored.
import { describe, expect, it, vi } from "vitest";
import { SharedReads } from "../lib/dashboard-data";
import { READ_TIMEOUT_MESSAGE, READ_TIMEOUT_MS } from "../lib/read-timeout";

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

  it("W196 one timed-out read stays quiet and reads again at once; the second in a row shows the error", async () => {
    vi.useFakeTimers();
    try {
      const cache = new SharedReads();
      cache.subscribe("k", vi.fn());
      await cache.refresh("k", async () => "before");
      const hung = vi.fn(() => new Promise(() => {}));
      void cache.refresh("k", hung);
      await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
      expect(hung).toHaveBeenCalledTimes(2);
      expect(cache.entry("k")).toMatchObject({ data: "before", error: null });
      expect(cache.entry("k").pending).not.toBeNull();
      await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
      expect(hung).toHaveBeenCalledTimes(2);
      expect(cache.entry("k")).toMatchObject({ data: "before", error: READ_TIMEOUT_MESSAGE, pending: null });
      await cache.refresh("k", async () => "after");
      expect(cache.entry("k")).toMatchObject({ data: "after", error: null });
    } finally { vi.useRealTimers(); }
  });

  it("W196 reports a timeout with the view and the tab's state, at most once a minute", async () => {
    vi.useFakeTimers();
    try {
      const cache = new SharedReads();
      const reporter = vi.fn();
      cache.reporter = reporter;
      cache.subscribe("overview:prj_1", vi.fn());
      void cache.refresh("overview:prj_1", () => new Promise(() => {}));
      await vi.advanceTimersByTimeAsync(2 * READ_TIMEOUT_MS);
      expect(reporter).toHaveBeenCalledTimes(1);
      expect(reporter.mock.calls[0]![0]).toEqual({
        read: "overview", elapsedMs: READ_TIMEOUT_MS, hidden: false, online: true, sinceVisibleMs: 0, hiddenDuringRead: false,
      });
      void cache.refresh("overview:prj_1", () => new Promise(() => {}));
      await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
      expect(reporter).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
});
