// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { OTHER_THREADS, parseState, updateState } from "../lib/client-state";
import type { SnoozeDoc } from "../lib/snooze-schema";
import { seedInitiativeCache, thread } from "./fixtures";

// BB's live thread list, which a test can change as the host would.
const host = vi.hoisted(() => {
  let threads: readonly PluginSidebarThread[] = [];
  const listeners = new Set<() => void>();
  return {
    get: () => threads,
    set(next: readonly PluginSidebarThread[]) {
      threads = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@get-bb/plugin-sdk/app")>();
  const { useSyncExternalStore } = await import("react");
  return {
    ...actual,
    experimental_useSidebarThreads: () => ({
      status: "ready" as const,
      threads: useSyncExternalStore(host.subscribe, host.get),
      projects: [{ id: "project-1", name: "One", isPersonal: false }],
    }),
  };
});

const app = await loadPluginApp(() => import("../app"));
const now = Date.now();
const HOUR = 3_600_000;
const props = {
  activeThreadId: null,
  activeProjectId: "project-1",
  isCompactViewport: false,
  searchQuery: "",
  onNavigate: vi.fn(),
  Original: () => null,
};
const noSnoozes: SnoozeDoc = { revision: 0, entries: [] };
const slots: ReturnType<typeof renderSlot>[] = [];
const mount = (rpc: Record<string, unknown> = {}) => {
  const slot = renderSlot(app.threadLists[0], props, {
    rpc: {
      listArchived: async () => [],
      getSnoozes: async () => noSnoozes,
      projectMode: async () => ({
        available: true,
        tree: { version: 1, projects: [] },
        order: null,
        orderError: null,
      }),
      ...rpc,
    },
  });
  slots.push(slot);
  return slot;
};
const listed = (slot: ReturnType<typeof renderSlot>) =>
  Array.from(slot.container.querySelectorAll("[data-thread-node]")).map((row) =>
    row.getAttribute("data-thread-node"),
  );
const shownTime = (slot: ReturnType<typeof renderSlot>, id: string) =>
  slot.container.querySelector(`[data-thread-node="${id}"] time`)?.textContent;

beforeEach(() => {
  localStorage.clear();
  seedInitiativeCache();
  // Other threads, ungrouped, most recent first: the defaults.
  updateState(() => ({ ...parseState(null), selected: OTHER_THREADS }));
});
afterEach(() => {
  for (const slot of slots.splice(0)) slot.unmount();
  cleanup();
  updateState(() => parseState(null));
});

describe("Other threads and read state", () => {
  it("keeps a thread's place and shown time when it is read", async () => {
    const unread = thread({
      id: "unread",
      title: "Finished two hours ago",
      isUnread: true,
      createdAt: now - 3 * HOUR,
      updatedAt: now - 2 * HOUR,
      lastReadAt: now - 3 * HOUR,
    });
    host.set([
      thread({ id: "recent", title: "Finished an hour ago", updatedAt: now - HOUR }),
      unread,
      thread({ id: "old", title: "Finished three hours ago", updatedAt: now - 3 * HOUR }),
    ]);
    const slot = mount();
    await waitFor(() => expect(listed(slot)).toEqual(["recent", "unread", "old"]));
    expect(shownTime(slot, "unread")).toBe("2h");
    // Opening it: BB stamps lastReadAt and, with it, updatedAt.
    await act(async () =>
      host.set(
        host.get().map((row) =>
          row.id === "unread"
            ? { ...unread, isUnread: false, lastReadAt: now, updatedAt: now }
            : row,
        ),
      ),
    );
    expect(listed(slot)).toEqual(["recent", "unread", "old"]);
    expect(shownTime(slot, "unread")).toBe("2h");
  });

  it("marks every unread thread read, and clears a woke snooze, from the header", async () => {
    const woke: SnoozeDoc = {
      revision: 1,
      entries: [
        {
          threadId: "woke",
          until: now - HOUR,
          createdAt: now - 5 * HOUR,
          wokeAt: now - HOUR,
          wasPinned: false,
        },
      ],
    };
    host.set([
      thread({ id: "read", title: "Read", updatedAt: now - HOUR }),
      thread({ id: "unread", title: "Unread", isUnread: true, updatedAt: now - 2 * HOUR }),
      thread({ id: "woke", title: "Back from snooze", isUnread: true, updatedAt: now - 9 * HOUR }),
      thread({
        id: "child",
        title: "Unread child",
        parentThreadId: "read",
        isUnread: true,
        updatedAt: now - 3 * HOUR,
      }),
    ]);
    const markRead = vi.fn(async (_input: unknown) => ({
      doc: { revision: 2, entries: [] },
      failed: [],
    }));
    const slot = mount({ getSnoozes: async () => woke, markRead });
    // The woke thread resurfaces at its wake time, above the older unread one.
    await waitFor(() =>
      expect(listed(slot)).toEqual(["read", "child", "woke", "unread"]),
    );
    const entry = slot.container.querySelector("[data-other-threads]")!;
    expect(entry.getAttribute("title")).toBe("1 back from snooze · 3 unread");
    expect(
      slot.getByRole("img", { name: "Needs Attention: 1 back from snooze · 3 unread" }),
    ).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Mark all as read" }));
    await waitFor(() => expect(markRead).toHaveBeenCalledTimes(1));
    expect(
      (markRead.mock.calls[0][0] as { threadIds: string[] }).threadIds.sort(),
    ).toEqual(["child", "unread", "woke"]);
    // BB pushes each thread read; the answer cleared the snooze.
    await act(async () =>
      host.set(host.get().map((row) => ({ ...row, isUnread: false }))),
    );
    await waitFor(() =>
      expect(slot.queryByRole("button", { name: "Mark all as read" })).toBeNull(),
    );
    expect(entry.hasAttribute("title")).toBe(false);
  });

  it("offers Mark all as read only once Adventure threads are known", async () => {
    localStorage.clear();
    let answer!: (ids: { available: true; threadIds: string[]; status: "ready" }) => void;
    host.set([
      thread({ id: "plain", title: "Plain", isUnread: true }),
      thread({ id: "worker", title: "Adventure worker", isUnread: true }),
    ]);
    const slot = mount({
      initiativeThreads: () =>
        new Promise<Parameters<typeof answer>[0]>((resolve) => (answer = resolve)),
    });
    await slot.findByText(/Loading/);
    expect(slot.queryByRole("button", { name: "Mark all as read" })).toBeNull();
    await act(async () =>
      answer({ available: true, threadIds: ["worker"], status: "ready" }),
    );
    await waitFor(() => expect(listed(slot)).toEqual(["plain"]));
    expect(slot.getByRole("button", { name: "Mark all as read" }).getAttribute("title")).toBe(
      "Mark all as read (1)",
    );
  });

  it("does not offer Mark all as read when the first membership read failed", async () => {
    localStorage.clear();
    host.set([
      thread({ id: "plain", title: "Plain", isUnread: true }),
      thread({ id: "worker", title: "Adventure worker", isUnread: true }),
    ]);
    const slot = mount({
      initiativeThreads: async () => ({ available: true, threadIds: [], status: "failed" }),
    });
    // The list falls back to every thread; the bulk action waits for a real answer.
    await waitFor(() => expect(listed(slot)).toEqual(["plain", "worker"]));
    expect(slot.queryByRole("button", { name: "Mark all as read" })).toBeNull();
  });

  it("reports the threads BB refused to mark read", async () => {
    host.set([
      thread({ id: "a", title: "A", isUnread: true }),
      thread({ id: "b", title: "B", isUnread: true }),
    ]);
    const slot = mount({
      markRead: async () => ({ doc: noSnoozes, failed: ["b"] }),
    });
    fireEvent.click(await slot.findByRole("button", { name: "Mark all as read" }));
    expect(
      await slot.findByText("Could not mark 1 of 2 threads as read."),
    ).toBeTruthy();
  });

  it("names why Other threads needs attention", async () => {
    host.set([
      thread({ id: "asks", title: "Asks", hasPendingInteraction: true }),
      thread({ id: "failed", title: "Failed", indicator: "unread-error", isUnread: true }),
    ]);
    const slot = mount();
    await waitFor(() =>
      expect(
        slot.container.querySelector("[data-other-threads]")!.getAttribute("title"),
      ).toBe("1 waiting for your answer · 1 with an unread error · 1 unread"),
    );
  });
});
