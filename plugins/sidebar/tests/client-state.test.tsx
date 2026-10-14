// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  parseState,
  updateState,
  useClientState,
  type ClientState,
} from "../lib/client-state";

const KEY = "bb-plugin-sidebar:v1";
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

const setListing = (patch: Partial<ClientState["listing"]>) =>
  updateState((state) => ({
    ...state,
    listing: { ...state.listing, ...patch },
  }));

describe("client state persistence", () => {
  it("hides archives by default and accepts only a boolean setting", () => {
    expect(parseState(null).showArchives).toBe(false);
    expect(
      parseState(JSON.stringify({ showArchives: true })).showArchives,
    ).toBe(true);
    expect(
      parseState(JSON.stringify({ showArchives: "true" })).showArchives,
    ).toBe(false);
  });

  it("shows snoozed threads by default and accepts only a boolean setting", () => {
    expect(parseState(null).showSnoozed).toBe(true);
    expect(parseState(JSON.stringify({ showSnoozed: false })).showSnoozed).toBe(
      false,
    );
    expect(
      parseState(JSON.stringify({ showSnoozed: "false" })).showSnoozed,
    ).toBe(true);
  });

  it("keeps consecutive updates when reads work but writes fail", () => {
    storage.setItem(KEY, JSON.stringify(parseState(null)));
    const { result } = renderHook(useClientState);
    const write = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("Full", "QuotaExceededError");
      });
    act(() => {
      setListing({ groupBy: "project" });
      setListing({ sortBy: "created" });
    });
    expect(result.current.listing).toMatchObject({
      groupBy: "project",
      sortBy: "created",
    });
    // A remote event must not replace the unsaved local snapshot.
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: KEY })));
    expect(result.current.listing).toMatchObject({
      groupBy: "project",
      sortBy: "created",
    });
    write.mockRestore();
    // Even an unchanged update retries persistence once storage recovers.
    act(() => updateState((state) => state));
    expect(JSON.parse(storage.getItem(KEY)!).listing).toMatchObject({
      groupBy: "project",
      sortBy: "created",
    });
    storage.setItem(
      KEY,
      JSON.stringify({
        ...result.current,
        listing: { ...result.current.listing, groupBy: "status" },
      }),
    );
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: KEY })));
    expect(result.current.listing.groupBy).toBe("status");
  });

  it("writes a toggle that matches stale memory but differs from storage", () => {
    const { result } = renderHook(useClientState);
    storage.setItem(
      KEY,
      JSON.stringify({
        ...parseState(null),
        listing: { ...parseState(null).listing, groupBy: "project" },
      }),
    );
    act(() =>
      updateState((state) => ({
        ...state,
        listing: {
          ...state.listing,
          groupBy: state.listing.groupBy === "project" ? "status" : "project",
        },
      })),
    );
    expect(result.current.listing.groupBy).toBe("status");
    expect(JSON.parse(storage.getItem(KEY)!).listing.groupBy).toBe("status");
  });

  it("does not reset preferences when a storage event arrives while reads fail", () => {
    const { result } = renderHook(useClientState);
    act(() => setListing({ groupBy: "project" }));
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Blocked");
    });
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: KEY })));
    expect(result.current.listing.groupBy).toBe("project");
  });
});
