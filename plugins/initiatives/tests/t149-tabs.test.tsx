// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
await loadPluginApp(() => import("../app"));
const { useInitiativeTabs } = await import("../app");
type Group = ReturnType<typeof useInitiativeTabs>;

const slots: ReturnType<typeof renderSlot>[] = [];
afterEach(() => {
  for (const slot of slots.splice(0)) slot.unmount();
  last = null;
  cleanup();
});

/** What BB's tab strip gets from the hook, kept for the test. */
let last: Group = null;
function Probe({ threadId }: { threadId: string }) {
  last = useInitiativeTabs({ threadId });
  return null;
}
const membership = { projectId: "p1", name: "Search", role: "discussion", former: false };
const sidebarThread = (id: string, isArchived = false) => ({ id, isArchived }) as never;
/** The header of `threadId`, with `discussions` in the ledger and `listed` the threads BB's sidebar has. */
function header(threadId: string, options: { discussions: string[]; listed?: ReturnType<typeof sidebarThread>[]; status?: "ready" | "loading" | "error"; create?: () => unknown }) {
  const panel = { membership, summary: null, tabs: { coordinatorThreadId: "c", discussionThreadIds: options.discussions } };
  const slot = renderSlot({ component: Probe }, { threadId }, {
    rpc: { panel: () => panel, discussionCreate: options.create ?? (() => ({ threadId: "new", note: null })) } as never,
    sidebarThreads: { status: options.status ?? "ready", threads: options.listed ?? [], projects: [] },
  });
  slots.push(slot);
  return slot;
}
const ids = (group: Group) => group?.tabs.map((t) => (t.pinned ? `${t.threadId} (${t.label}, pinned)` : t.threadId));

describe("T149 the tabs of an Initiative's coordinator and discussions", () => {
  it("pins the coordinator first, then the discussions oldest first, then +", async () => {
    header("d1", { discussions: ["d1", "d2"], listed: [sidebarThread("c"), sidebarThread("d1"), sidebarThread("d2")] });
    await waitFor(() => expect(ids(last)).toEqual(["c (Coordinator, pinned)", "d1", "d2"]));
    expect(last!.create!.label).toBe("New discussion");
  });

  it("hides archived and deleted discussions, except in their own header (D483)", async () => {
    const listed = [sidebarThread("c"), sidebarThread("a1", true), sidebarThread("a2")];
    header("a2", { discussions: ["a1", "a2", "a3"], listed });
    await waitFor(() => expect(ids(last)).toEqual(["c (Coordinator, pinned)", "a2"]));
    cleanup();
    header("a1", { discussions: ["a1", "a2", "a3"], listed });
    await waitFor(() => expect(ids(last)).toEqual(["c (Coordinator, pinned)", "a1", "a2"]));
  });

  it("shows only its own tab until BB's list is ready, and every tab when that list failed", async () => {
    header("l1", { discussions: ["l1", "l2"], status: "loading" });
    await waitFor(() => expect(ids(last)).toEqual(["c (Coordinator, pinned)", "l1"]));
    cleanup();
    header("e1", { discussions: ["e1", "e2"], status: "error" });
    await waitFor(() => expect(ids(last)).toEqual(["c (Coordinator, pinned)", "e1", "e2"]));
  });

  it("+ opens the new discussion, and fails visibly when BB did not confirm it (D458)", async () => {
    const create = vi.fn()
      .mockReturnValueOnce({ threadId: "n1", note: null })
      .mockReturnValueOnce({ threadId: null, note: "BB did not confirm the thread. The plugin reconciles it; check the Initiative panel instead of retrying." });
    header("p1", { discussions: ["p1"], create });
    await waitFor(() => expect(last).not.toBeNull());
    await act(async () => expect(await last!.create!.onCreate()).toBe("n1"));
    expect(create).toHaveBeenCalledWith({ projectId: "p1" });
    await act(async () => { await expect(last!.create!.onCreate()).rejects.toThrow(/BB did not confirm the thread/); });
  });

  it("gives no group to a thread outside one", async () => {
    const slot = renderSlot({ component: Probe }, { threadId: "w1" }, {
      rpc: { panel: () => ({ membership: { ...membership, role: "work" }, summary: null, tabs: null }) } as never,
    });
    slots.push(slot);
    await act(async () => { await Promise.resolve(); });
    expect(last).toBeNull();
  });
});
