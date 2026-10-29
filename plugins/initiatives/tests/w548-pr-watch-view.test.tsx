// @vitest-environment jsdom
// W548, W554: the PR detail panel's Watch section, read with TanStack Query.
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PrWatchView } from "../lib/pr-watch";
import { SIGNAL_DEBOUNCE_MS, adventuresQueryClient } from "../lib/query";
await loadPluginApp(() => import("../app"));
const { PrWatch } = await import("../pr-watch-view");

const slots: ReturnType<typeof renderSlot>[] = [];
afterEach(() => {
  for (const slot of slots.splice(0)) slot.unmount();
  cleanup();
  adventuresQueryClient().clear();
});

const url = (n: number) => `https://github.com/eq/market/pull/${n}`;
const view = (n: number, watched = true): PrWatchView => ({
  url: url(n), watcher: watched ? { label: "W1", projectId: "eq", adventure: "Equisafe" } : null, commentWakes: 0, commentCap: 10, ended: null,
  wakes: [{ at: Date.UTC(2026, 9, 28, 12), head: "abc1234def", changes: ["Checks failed: tests."], state: "sent", routed: "W1: A7" }],
});

describe("W548 PR watch view", () => {
  it("reads once on open and once more for a burst of realtime signals", async () => {
    const slot = renderSlot({ component: PrWatch }, { projectId: "eq", url: url(1) }, { rpc: { prWatch: async (input) => view(Number((input as { url: string }).url.split("/").pop())) } });
    slots.push(slot);
    await slot.findByText("Checks failed: tests.");
    expect(slot.getByText("W1: A7")).toBeTruthy();
    const reads = () => slot.rpcCalls.filter((c) => c.method === "prWatch").length;
    expect(reads()).toBe(1);
    for (let i = 0; i < 20; i++) await slot.emitRealtime("merge-queue-changed", { repo: "eq/market" });
    await act(() => new Promise((resolve) => setTimeout(resolve, SIGNAL_DEBOUNCE_MS * 2)));
    await waitFor(() => expect(reads()).toBe(2));
  });

  it("shows who watches the PR, and applies an unwatch's answer to the PR it was for, even after the panel moved to another", async () => {
    const unwatched = new Set<string>();
    let release: () => void = () => {};
    const slot = renderSlot({ component: PrWatch }, { projectId: "eq", url: url(1) }, { rpc: {
      prWatch: async (input) => {
        const u = (input as { url: string }).url;
        return view(Number(u.split("/").pop()), !unwatched.has(u));
      },
      prUnwatch: async (input) => {
        const { url: u } = input as { url: string };
        await new Promise<void>((resolve) => { release = resolve; });
        unwatched.add(u);
        return view(Number(u.split("/").pop()), false);
      },
    } });
    slots.push(slot);
    await slot.findByText(/Watched by W1:/);
    fireEvent.click(await slot.findByRole("button", { name: "Unwatch" }));
    slot.rerender(createElement(PrWatch, { projectId: "eq", url: url(2) }));
    await slot.findByRole("button", { name: "Unwatch" });
    await act(async () => release());
    await waitFor(() => expect(adventuresQueryClient().getQueryData<PrWatchView>(["pr-watch", "eq", url(1)])?.watcher).toBeNull());
    expect(adventuresQueryClient().getQueryData<PrWatchView>(["pr-watch", "eq", url(2)])?.watcher?.label).toBe("W1");
    expect(slot.getByRole("button", { name: "Unwatch" })).toBeTruthy();
    expect(slot.rpcCalls.find((c) => c.method === "prUnwatch")?.input).toEqual({ projectId: "eq", url: url(1) });
    // Back on PR 1: nobody watches it, and there is nothing to unwatch.
    slot.rerender(createElement(PrWatch, { projectId: "eq", url: url(1) }));
    await slot.findByText(/^Not watched\./);
    expect(slot.queryByRole("button", { name: "Unwatch" })).toBeNull();
  });
});
