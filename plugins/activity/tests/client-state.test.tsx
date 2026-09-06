// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { parseState, updateState, useClientState } from "../lib/client-state";

const KEY = "bb-plugin-erwin-activity:v1";
const storage = window.localStorage;

beforeEach(() => {
  storage.clear();
  updateState(() => parseState(null));
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  updateState(() => parseState(null));
});

describe("client state persistence", () => {
  it("keeps consecutive updates when reads work but writes fail", () => {
    storage.setItem(KEY, JSON.stringify(parseState(null)));
    const { result } = renderHook(useClientState);
    const write = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("Full", "QuotaExceededError");
      });
    act(() => {
      updateState((state) => ({ ...state, groupBy: "project" }));
      updateState((state) => ({ ...state, sortBy: "created" }));
    });
    expect(result.current).toMatchObject({
      groupBy: "project",
      sortBy: "created",
    });
    // A remote event must not replace the unsaved local snapshot.
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: KEY })));
    expect(result.current).toMatchObject({
      groupBy: "project",
      sortBy: "created",
    });
    write.mockRestore();
    // Even an unchanged update retries persistence once storage recovers.
    act(() => updateState((state) => state));
    expect(JSON.parse(storage.getItem(KEY)!)).toMatchObject({
      groupBy: "project",
      sortBy: "created",
    });
    storage.setItem(
      KEY,
      JSON.stringify({ ...result.current, groupBy: "status" }),
    );
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: KEY })));
    expect(result.current.groupBy).toBe("status");
  });

  it("writes a toggle that matches stale memory but differs from storage", () => {
    const { result } = renderHook(useClientState);
    storage.setItem(
      KEY,
      JSON.stringify({ ...parseState(null), groupBy: "project" }),
    );
    act(() =>
      updateState((state) => ({
        ...state,
        groupBy: state.groupBy === "project" ? "status" : "project",
      })),
    );
    expect(result.current.groupBy).toBe("status");
    expect(JSON.parse(storage.getItem(KEY)!).groupBy).toBe("status");
  });

  it("does not reset preferences when a storage event arrives while reads fail", () => {
    const { result } = renderHook(useClientState);
    act(() => updateState((state) => ({ ...state, groupBy: "project" })));
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Blocked");
    });
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: KEY })));
    expect(result.current.groupBy).toBe("project");
  });
});
