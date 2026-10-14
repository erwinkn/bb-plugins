// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import { parseState, updateState } from "../lib/client-state";
import { cacheTree } from "../lib/initiative-tree-cache";
import { thread } from "./fixtures";

const app = await loadPluginApp(() => import("../app"));
const NOW = Date.now();
const minutes = (n: number) => NOW - n * 60_000;
const initiative = {
  id: "p1",
  name: "Useful search",
  objective: "Find historical work",
  paused: false,
  coordinatorThreadId: "c",
  memberProjectIds: ["project-1"],
  inFlight: 0,
  remaining: 0,
  opinions: 0,
  revisit: 0,
  retired: 0,
  nodes: [
    {
      threadId: "c",
      label: "Coordinator",
      role: "coordinator" as const,
      worker: null,
      parentWorker: null,
      state: "coordinating",
      bbProjectId: "project-1",
    },
    {
      threadId: "w",
      label: "Builder",
      role: "work" as const,
      worker: "W1",
      parentWorker: null,
      state: "active",
      bbProjectId: "project-1",
    },
  ],
};
const tree = { version: 1 as const, projects: [initiative] };
const projects = [
  { id: "project-1", name: "Alpha", isPersonal: false },
  { id: "project-2", name: "Beta", isPersonal: false },
  { id: "personal", name: "No project", isPersonal: true },
];
const threads = [
  thread({ id: "c", title: "Coordinator", updatedAt: minutes(5) }),
  thread({ id: "w", title: "Worker", updatedAt: minutes(90) }),
  thread({ id: "a-old", title: "A old", updatedAt: minutes(300), createdAt: minutes(400) }),
  thread({ id: "b-new", title: "B new", projectId: "project-2", updatedAt: minutes(10), createdAt: minutes(500) }),
  thread({ id: "a-mid", title: "A mid", updatedAt: minutes(60), createdAt: minutes(50) }),
];
const baseRpc = {
  projectMode: async () => ({ available: true, tree, order: null, orderError: null }),
  initiativeThreads: async () => ({ available: true, threadIds: ["c", "w"], status: "ready" }),
  getSpaces: async () => ({ revision: 0, spaces: [] }),
  listArchived: async () => [],
  getLibrary: async () => ({ revision: 0, ids: [] }),
  branchPullRequestEligibility: async () => ({ eligible: {} }),
};
const slots: ReturnType<typeof renderSlot>[] = [];
function mount(
  rpc: Record<string, (input: never) => unknown> = {},
  props: Record<string, unknown> = {},
  threadList = threads,
) {
  const slot = renderSlot(
    app.threadLists[0],
    {
      activeThreadId: "c",
      activeProjectId: "project-1",
      isCompactViewport: false,
      searchQuery: "",
      onNavigate: vi.fn(),
      Original: () => null,
      ...props,
    } as PluginThreadListProps,
    { rpc: { ...baseRpc, ...rpc }, sidebarThreads: { threads: threadList, projects } },
  );
  slots.push(slot);
  return slot;
}
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
const listed = (slot: ReturnType<typeof renderSlot>) =>
  Array.from(
    slot.container.querySelectorAll("[data-activity-thread-groups] [data-sidebar-thread-id]"),
    (row) => row.getAttribute("data-sidebar-thread-id"),
  );
const sectionTitles = (slot: ReturnType<typeof renderSlot>) =>
  Array.from(slot.container.querySelectorAll("[data-section-header]"), (el) =>
    el.getAttribute("data-section-header"),
  );
async function openListMenu(slot: ReturnType<typeof renderSlot>) {
  fireEvent.keyDown(slot.getByRole("button", { name: "Thread list options" }), { key: "Enter" });
  await settle();
  return slot.getByRole("menu");
}
async function choose(slot: ReturnType<typeof renderSlot>, submenu: RegExp, item: string) {
  const menu = await openListMenu(slot);
  fireEvent.keyDown(within(menu).getByRole("menuitem", { name: submenu }), { key: "ArrowRight" });
  await settle();
  fireEvent.click(slot.getByRole("menuitemradio", { name: item }));
  await settle();
}

beforeEach(() => {
  window.localStorage.clear();
  updateState(() => ({ ...parseState(null), mode: "initiatives" }));
});
afterEach(async () => {
  for (const slot of slots.splice(0)) slot.unmount();
  cleanup();
  updateState(() => parseState(null));
  await settle();
});

describe("Initiatives view layout", () => {
  it("shows Initiatives, then every other thread ungrouped and most recent first", async () => {
    const slot = mount();
    await slot.findByRole("link", { name: "Open Useful search" });
    await waitFor(() => expect(listed(slot)).toEqual(["b-new", "a-mid", "a-old"]));
    expect(sectionTitles(slot)).toEqual(["Initiatives", "Threads"]);
    expect(slot.container.querySelector("[data-group-header]")).toBeNull();
    // The Threads view's own display menu moves to the list's header.
    expect(slot.queryByRole("button", { name: "Threads display options" })).toBeNull();
  });

  it("draws one dense row per Initiative with its last activity", async () => {
    const slot = mount();
    const row = await slot.findByRole("link", { name: "Open Useful search" });
    // The coordinator changed 5 minutes ago, the worker 90.
    expect(row.querySelector("[data-initiative-age]")?.textContent).toBe("5m");
    expect(row.querySelector("[data-project-icon]")).toBeTruthy();
    expect(row.textContent).toBe("Useful search5m");
  });

  it("names the current grouping and order in the list menu", async () => {
    const slot = mount();
    await waitFor(() => expect(listed(slot)).toHaveLength(3));
    const menu = await openListMenu(slot);
    expect(within(menu).getByRole("menuitem", { name: /Grouping/ }).textContent).toContain("None");
    expect(within(menu).getByRole("menuitem", { name: /Ordering/ }).textContent).toContain("Recent");
    expect(within(menu).getByRole("menuitemcheckbox", { name: /Archived/ })).toBeTruthy();
  });

  it("groups by project under a Projects header, on this view only", async () => {
    const slot = mount();
    await waitFor(() => expect(listed(slot)).toHaveLength(3));
    await choose(slot, /Grouping/, "Project");
    expect(sectionTitles(slot)).toEqual(["Initiatives", "Projects"]);
    const groups = Array.from(slot.container.querySelectorAll("[data-group-header]"), (el) =>
      el.getAttribute("data-group-header"),
    );
    expect(groups).toEqual(["project:project-1", "project:project-2"]);
    expect(listed(slot)).toEqual(["a-mid", "a-old", "b-new"]);
    // The Threads view keeps BB's synced grouping.
    expect(parseState(window.localStorage.getItem("bb-plugin-sidebar:v1")).groupBy).toBe("status");
  });

  it("groups by status", async () => {
    const slot = mount();
    await waitFor(() => expect(listed(slot)).toHaveLength(3));
    await choose(slot, /Grouping/, "Status");
    expect(sectionTitles(slot)).toEqual(["Initiatives", "Threads"]);
    expect(slot.container.querySelector('[data-group-header="status:done"]')).toBeTruthy();
  });

  it("orders oldest first, or by creation", async () => {
    const slot = mount();
    await waitFor(() => expect(listed(slot)).toHaveLength(3));
    await choose(slot, /Ordering/, "Oldest first");
    expect(listed(slot)).toEqual(["a-old", "a-mid", "b-new"]);
    await choose(slot, /Ordering/, "Date created");
    // Created: b-new 500 min ago, a-old 400, a-mid 50; oldest first.
    expect(listed(slot)).toEqual(["b-new", "a-old", "a-mid"]);
  });

  it("titles the ungrouped list Recent under Pinned, so it does not read as pinned", async () => {
    const slot = mount({}, {}, [...threads, thread({ id: "pin", title: "Pinned", isPinned: true })]);
    await waitFor(() => expect(listed(slot)).toContain("pin"));
    const groups = Array.from(slot.container.querySelectorAll("[data-group-header]"), (el) =>
      el.getAttribute("data-group-header"),
    );
    expect(groups).toEqual(["pinned", "recent"]);
  });

  it("draws the cached Initiatives at once, before the first read answers", async () => {
    cacheTree(tree);
    const slot = mount({ projectMode: () => new Promise(() => {}) });
    expect(slot.getByRole("link", { name: "Open Useful search" })).toBeTruthy();
    expect(slot.queryByText("Loading initiatives…")).toBeNull();
  });

  it("caches the confirmed tree and forgets it once Initiatives is gone", async () => {
    const slot = mount();
    await slot.findByRole("link", { name: "Open Useful search" });
    await waitFor(() =>
      expect(window.localStorage.getItem("bb-plugin-sidebar:initiative-tree:v1")).toContain("Useful search"),
    );
    slot.unmount();
    mount({ projectMode: async () => ({ available: false, tree: null, order: null, orderError: null }) });
    await waitFor(() =>
      expect(window.localStorage.getItem("bb-plugin-sidebar:initiative-tree:v1")).toBeNull(),
    );
  });
});

describe("Archived", () => {
  const archivedThread = (id: string, parentThreadId: string | null) => ({
    id,
    projectId: "project-1",
    title: `Archived ${id}`,
    titleFallback: null,
    parentThreadId,
    providerId: "codex",
    createdAt: 1,
    updatedAt: 1,
    environmentId: null,
    environmentName: null,
    environmentBranchName: null,
    environmentProviderId: null,
    environmentWorkspaceDisplayKind: "other",
  });
  const switchView = async (mode: "threads" | "initiatives") => {
    act(() => updateState((current) => ({ ...current, mode })));
    await settle();
  };

  it("keeps Initiative threads and their descendants out of Archived in both views", async () => {
    const listArchived = async () => [
      archivedThread("w-old", null),
      archivedThread("w-child", "w"),
      archivedThread("plain", null),
    ];
    const initiativeThreads = async () => ({
      available: true,
      threadIds: ["c", "w", "w-old"],
      status: "ready",
    });
    act(() => updateState((current) => ({ ...current, showArchives: true })));
    for (const mode of ["initiatives", "threads"] as const) {
      await switchView(mode);
      const slot = mount({ listArchived, initiativeThreads });
      const archive = await slot.findByRole("button", { name: "Archived" });
      // The section remembers being open across mounts.
      if (archive.getAttribute("aria-expanded") !== "true") fireEvent.click(archive);
      await waitFor(() =>
        expect(slot.container.querySelector('[data-sidebar-thread-id="plain"]')).toBeTruthy(),
      );
      expect(slot.container.querySelector('[data-sidebar-thread-id="w-old"]')).toBeNull();
      expect(slot.container.querySelector('[data-sidebar-thread-id="w-child"]')).toBeNull();
      slot.unmount();
    }
  });
});
