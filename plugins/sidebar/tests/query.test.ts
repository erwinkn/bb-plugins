// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryObserver } from "@tanstack/react-query";
import { z } from "zod";
import {
  CACHE_VERSION,
  STORAGE_KEY,
  SIGNAL_DEBOUNCE_MS,
  createQueryClient,
  refresh,
} from "../lib/query";
import { persistedQueries, seedQueryCache } from "./fixtures";

const schemas = { names: z.array(z.string()) };
const disposers: (() => void)[] = [];
/** A client as a fresh page would make it; stopped after the test. */
const open = () => {
  const { queryClient, dispose } = createQueryClient(schemas);
  disposers.push(dispose);
  return queryClient;
};

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.useRealTimers();
});

describe("persistence", () => {
  it("restores listed queries whose data passes their schema, and drops the rest", () => {
    seedQueryCache([
      [["names"], ["Ada", "Grace"]],
      [["names", "bad"], [1, 2]],
      [["unlisted"], ["kept out"]],
    ]);
    const client = open();
    expect(client.getQueryData(["names"])).toEqual(["Ada", "Grace"]);
    expect(client.getQueryData(["names", "bad"])).toBeUndefined();
    expect(client.getQueryData(["unlisted"])).toBeUndefined();
    // Restored data draws at once but is read again on first use.
    expect(client.getQueryState(["names"])?.isInvalidated).toBe(true);
  });

  it("drops a cache written by another version or older than a week", () => {
    seedQueryCache([[["names"], ["Ada"]]]);
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...stored, buster: `${CACHE_VERSION}-old` }));
    expect(open().getQueryData(["names"])).toBeUndefined();
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...stored, timestamp: Date.now() - 8 * 24 * 60 * 60_000 }),
    );
    expect(open().getQueryData(["names"])).toBeUndefined();
  });

  it("starts empty on unreadable storage", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    expect(open().getQueryData(["names"])).toBeUndefined();
  });

  it("saves only listed, successful queries, at most once a second", async () => {
    vi.useFakeTimers();
    const client = open();
    client.setQueryData(["names"], ["Ada"]);
    client.setQueryData(["unlisted"], ["kept out"]);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(persistedQueries()).toEqual({ names: [["Ada"]] });
  });

  it("keeps saving last-good data through a failed read, and restores it as good", async () => {
    vi.useFakeTimers();
    const client = open();
    const observer = new QueryObserver(client, {
      queryKey: ["names"],
      queryFn: vi.fn().mockResolvedValueOnce(["Ada"]).mockRejectedValue(new Error("down")),
      retry: false,
    });
    const stop = observer.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    await observer.refetch();
    expect(client.getQueryState(["names"])?.status).toBe("error");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(persistedQueries()).toEqual({ names: [["Ada"]] });
    stop();
    const restored = open();
    expect(restored.getQueryData(["names"])).toEqual(["Ada"]);
    expect(restored.getQueryState(["names"])?.status).toBe("success");
  });

  it("forgets the hand-rolled caches it replaced", () => {
    window.localStorage.setItem("bb-plugin-sidebar:initiative-tree:v1", "{}");
    window.localStorage.setItem("bb-plugin-sidebar:snooze-cache", "{}");
    open();
    expect(window.localStorage.getItem("bb-plugin-sidebar:initiative-tree:v1")).toBeNull();
    expect(window.localStorage.getItem("bb-plugin-sidebar:snooze-cache")).toBeNull();
  });
});

describe("refresh", () => {
  const watch = (client: ReturnType<typeof open>, queryFn: () => Promise<string>) => {
    const observer = new QueryObserver(client, { queryKey: ["names"], queryFn, staleTime: Infinity });
    return observer.subscribe(() => {});
  };

  it("coalesces signals within the debounce window into one read", async () => {
    vi.useFakeTimers();
    const client = open();
    const read = vi.fn(async () => "answer");
    const stop = watch(client, read);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    for (let n = 0; n < 5; n++) refresh(client, ["names"]);
    await vi.advanceTimersByTimeAsync(SIGNAL_DEBOUNCE_MS);
    expect(read).toHaveBeenCalledTimes(2);
    stop();
  });

  it("lets a read in flight finish, then reads once more, however many signals came meanwhile", async () => {
    vi.useFakeTimers();
    const client = open();
    const answers: ((value: string) => void)[] = [];
    const read = vi.fn(() => new Promise<string>((resolve) => answers.push(resolve)));
    const stop = watch(client, read);
    await vi.advanceTimersByTimeAsync(0);
    for (let n = 0; n < 3; n++) {
      refresh(client, ["names"]);
      await vi.advanceTimersByTimeAsync(SIGNAL_DEBOUNCE_MS);
    }
    // Not cancelled and restarted: still the one read.
    expect(read).toHaveBeenCalledTimes(1);
    answers[0]!("before the change");
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    answers[1]!("after the change");
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getQueryData(["names"])).toBe("after the change");
    expect(read).toHaveBeenCalledTimes(2);
    stop();
  });

  it("marks a query nobody shows stale without reading it", async () => {
    vi.useFakeTimers();
    const client = open();
    client.setQueryData(["names"], ["Ada"]);
    refresh(client, ["names"]);
    await vi.advanceTimersByTimeAsync(SIGNAL_DEBOUNCE_MS);
    expect(client.getQueryState(["names"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["names"])?.fetchStatus).toBe("idle");
  });
});
