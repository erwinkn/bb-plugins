// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import { OTHER_THREADS, parseState, updateState } from "../lib/client-state";
import { cacheTree, cacheWorkers } from "../lib/initiative-tree-cache";
import { thread } from "./fixtures";

const app = await loadPluginApp(() => import("../app"));
const Component = app.threadLists[0].component;
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
  listArchived: async () => [],
  branchPullRequestEligibility: async () => ({ eligible: {} }),
};
const slots: ReturnType<typeof renderSlot>[] = [];
function mount(
  rpc: Record<string, (input: never) => unknown> = {},
  props: Record<string, unknown> = {},
  threadList = threads,
  sidebarStatus?: "error",
) {
  const slot = renderSlot(
    app.threadLists[0],
    {
      activeThreadId: null,
      activeProjectId: "project-1",
      isCompactViewport: false,
      searchQuery: "",
      onNavigate: vi.fn(),
      Original: () => null,
      ...props,
    } as PluginThreadListProps,
    {
      rpc: { ...baseRpc, ...rpc },
      sidebarThreads: sidebarStatus ? { status: sidebarStatus } : { threads: threadList, projects },
    },
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
/** Picks Other threads, as a click on its entry would. */
const pickOther = () => updateState((current) => ({ ...current, selected: OTHER_THREADS }));
const stored = () => parseState(window.localStorage.getItem("bb-plugin-sidebar:v1"));
const adventureRow = (slot: ReturnType<typeof renderSlot>, name = "Useful search") =>
  slot.getByRole("link", { name: `Open ${name}` });
const otherEntry = (slot: ReturnType<typeof renderSlot>) =>
  slot.getByRole("button", { name: /^Other threads/ });
/** Rerenders with another open thread, as BB does on navigation. */
function open(slot: ReturnType<typeof renderSlot>, activeThreadId: string | null) {
  slot.rerender(
    <Component
      activeThreadId={activeThreadId}
      activeProjectId="project-1"
      isCompactViewport={false}
      searchQuery=""
      onNavigate={vi.fn()}
      Original={() => null}
    />,
  );
}
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

const OPUS = "claude-code / claude-opus-5-5 / high / tier unspecified";
/** One Adventure with three workers: W1 works, W2 is done, W3 (a reviewer) needs you. */
const workerTree = {
  version: 1 as const,
  projects: [
    {
      ...initiative,
      nodes: [
        initiative.nodes[0]!,
        { ...initiative.nodes[1]!, label: "Build the index" },
        { threadId: "w2", label: "Ship it", role: "work" as const, worker: "W2", parentWorker: null, state: "active", bbProjectId: "project-1" },
        { threadId: "w3", label: "Review", role: "review" as const, worker: "W3", parentWorker: null, state: "active", bbProjectId: "project-1" },
      ],
    },
  ],
};
const FACTS = [
  { ref: "W1", profile: OPUS, group: "working" as const },
  { ref: "W2", profile: "codex / gpt-6.1-sol / xhigh", group: "done" as const },
  { ref: "W3", profile: null, group: "needs" as const },
];
const workerThreads = [
  thread({ id: "c", title: "Coordinator", updatedAt: minutes(5) }),
  thread({ id: "w", title: "W1 Build the index", updatedAt: minutes(30) }),
  thread({ id: "w2", title: "W2 Ship it", updatedAt: minutes(2) }),
  thread({ id: "w3", title: "W3 Review", updatedAt: minutes(20) }),
  thread({ id: "rev", title: "Review W1", parentThreadId: "w", updatedAt: minutes(25) }),
  thread({ id: "rev-helper", title: "Helper", parentThreadId: "rev", updatedAt: minutes(24) }),
  ...threads.filter((t) => !["c", "w"].includes(t.id)),
];
/** A tree read that answers the worker facts of the Adventures it is asked for. */
const withFacts = () =>
  vi.fn(async (input: { known: string | null; workersOf?: string[] } | null) => ({
    available: true,
    tree: workerTree,
    order: null,
    orderError: null,
    ...(input?.workersOf ? { workers: { p1: FACTS } } : {}),
  }));
const workerRpc = (projectMode = withFacts()) => ({
  projectMode,
  initiativeThreads: async () => ({ available: true, threadIds: ["c", "w", "w2", "w3"], status: "ready" }),
});
const workerRow = (slot: ReturnType<typeof renderSlot>, id: string) =>
  slot.container.querySelector<HTMLElement>(`[data-adventure-workers] [data-thread-node="${id}"]`);
const workerIds = (slot: ReturnType<typeof renderSlot>) =>
  Array.from(slot.container.querySelectorAll("[data-adventure-workers] [data-thread-node]"), (row) =>
    row.getAttribute("data-thread-node"),
  );
const groups = (slot: ReturnType<typeof renderSlot>) =>
  Array.from(slot.container.querySelectorAll("[data-worker-group]"), (el) => el.getAttribute("data-worker-group"));
async function chooseWorkers(slot: ReturnType<typeof renderSlot>, item: string) {
  fireEvent.keyDown(slot.getByRole("button", { name: "Worker list options" }), { key: "Enter" });
  await settle();
  fireEvent.click(slot.getByRole("menuitemradio", { name: item }));
  await settle();
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(async () => {
  for (const slot of slots.splice(0)) slot.unmount();
  cleanup();
  updateState(() => parseState(null));
  await settle();
});

describe("sidebar layout", () => {
  beforeEach(pickOther);

  it("shows the Adventures and Other threads, then every other thread ungrouped and most recent first", async () => {
    const slot = mount();
    await slot.findByRole("link", { name: "Open Useful search" });
    await waitFor(() => expect(listed(slot)).toEqual(["b-new", "a-mid", "a-old"]));
    expect(sectionTitles(slot)).toEqual(["Adventures", "Other threads"]);
    expect(otherEntry(slot).getAttribute("aria-current")).toBe("true");
    expect(slot.container.querySelector("[data-group-header]")).toBeNull();
    expect(slot.getByRole("button", { name: "Thread list options" })).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Threads display options" })).toBeNull();
  });

  it("draws one dense row per Adventure with its last activity", async () => {
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

  it("groups Other threads by project", async () => {
    const slot = mount();
    await waitFor(() => expect(listed(slot)).toHaveLength(3));
    await choose(slot, /Grouping/, "Project");
    expect(sectionTitles(slot)).toEqual(["Adventures", "Other threads"]);
    const groups = Array.from(slot.container.querySelectorAll("[data-group-header]"), (el) =>
      el.getAttribute("data-group-header"),
    );
    expect(groups).toEqual(["project:project-1", "project:project-2"]);
    expect(listed(slot)).toEqual(["a-mid", "a-old", "b-new"]);
    expect(stored().listing.groupBy).toBe("project");
  });

  it("groups by status", async () => {
    const slot = mount();
    await waitFor(() => expect(listed(slot)).toHaveLength(3));
    await choose(slot, /Grouping/, "Status");
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

  it("caches the confirmed tree and forgets it once Adventures is gone", async () => {
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

describe("picking what the lower section lists", () => {
  /** Two Adventures: p2's coordinator c2 runs worker x. */
  const twoTree = {
    version: 1 as const,
    projects: [
      initiative,
      {
        ...initiative,
        id: "p2",
        name: "Second push",
        coordinatorThreadId: "c2",
        nodes: [
          { ...initiative.nodes[0]!, threadId: "c2" },
          { ...initiative.nodes[1]!, threadId: "x", worker: "W9" },
        ],
      },
    ],
  };
  const twoThreads = [
    ...threads,
    thread({ id: "c2", title: "Second coordinator", updatedAt: minutes(3) }),
    thread({ id: "x", title: "W9 Second work", updatedAt: minutes(4) }),
    thread({ id: "x-child", title: "Helper", parentThreadId: "x", updatedAt: minutes(4) }),
  ];
  const twoRpc = (read = vi.fn(async (_input: { workersOf?: string[] } | null) => ({
    available: true, tree: twoTree, order: null, orderError: null,
  }))) => ({
    projectMode: read,
    initiativeThreads: async () => ({ available: true, threadIds: ["c", "w", "c2", "x"], status: "ready" }),
  });
  const selectedHeader = (slot: ReturnType<typeof renderSlot>) =>
    sectionTitles(slot)[1];

  it("selects the first Adventure when nothing was picked and the open thread is elsewhere", async () => {
    const slot = mount(twoRpc(), { activeThreadId: "a-old" }, twoThreads);
    await waitFor(() => expect(workerRow(slot, "w")).toBeTruthy());
    expect(adventureRow(slot).getAttribute("aria-current")).toBe("true");
    expect(adventureRow(slot, "Second push").getAttribute("aria-current")).toBeNull();
    expect(otherEntry(slot).getAttribute("aria-current")).toBeNull();
    expect(selectedHeader(slot)).toBe("Useful search");
    expect(slot.container.querySelector("[data-activity-thread-groups]")).toBeNull();
    // A default is not a pick: nothing is stored.
    expect(stored().selected).toBeNull();
  });

  it("switches to Other threads and back to an Adventure, which opens its coordinator", async () => {
    const slot = mount(twoRpc(), {}, twoThreads);
    await waitFor(() => expect(workerRow(slot, "w")).toBeTruthy());
    fireEvent.click(otherEntry(slot));
    await waitFor(() => expect(listed(slot)).toEqual(["b-new", "a-mid", "a-old"]));
    expect(slot.container.querySelector("[data-adventure-workers]")).toBeNull();
    expect(otherEntry(slot).getAttribute("aria-current")).toBe("true");
    expect(adventureRow(slot).getAttribute("aria-current")).toBeNull();
    expect(selectedHeader(slot)).toBe("Other threads");
    // Its list options and New thread lead its section; the worker options are gone.
    const header = slot.container.querySelector('[data-section-header="Other threads"]')!;
    expect(within(header as HTMLElement).getByRole("button", { name: "Thread list options" })).toBeTruthy();
    expect(within(header as HTMLElement).getByRole("button", { name: "New thread" })).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Worker list options" })).toBeNull();
    expect(stored().selected).toBe(OTHER_THREADS);

    fireEvent.click(adventureRow(slot, "Second push"));
    expect(slot.inspection.navigateCalls).toContainEqual(
      expect.objectContaining({ method: "toThread", threadId: "c2" }),
    );
    await waitFor(() => expect(workerRow(slot, "x")).toBeTruthy());
    expect(workerRow(slot, "w")).toBeNull();
    expect(listed(slot)).toEqual([]);
    expect(selectedHeader(slot)).toBe("Second push");
    expect(stored().selected).toBe("p2");
  });

  it("keeps the pick across reloads", async () => {
    updateState((current) => ({ ...current, selected: "p2" }));
    const slot = mount(twoRpc(), {}, twoThreads);
    await waitFor(() => expect(workerRow(slot, "x")).toBeTruthy());
    expect(adventureRow(slot, "Second push").getAttribute("aria-current")).toBe("true");
    slot.unmount();
    pickOther();
    const again = mount(twoRpc(), {}, twoThreads);
    await waitFor(() => expect(listed(again)).toEqual(["b-new", "a-mid", "a-old"]));
    expect(again.container.querySelector("[data-adventure-workers]")).toBeNull();
  });

  it("selects the Adventure of an opened thread: its coordinator, a worker or a worker's child", async () => {
    pickOther();
    const slot = mount(twoRpc(), { activeThreadId: "x-child" }, twoThreads);
    await waitFor(() => expect(workerRow(slot, "x")).toBeTruthy());
    expect(stored().selected).toBe("p2");
    open(slot, "w");
    await waitFor(() => expect(workerRow(slot, "w")).toBeTruthy());
    expect(stored().selected).toBe("p1");
    open(slot, "c2");
    await waitFor(() => expect(workerRow(slot, "x")).toBeTruthy());
    expect(stored().selected).toBe("p2");
  });

  it("keeps a pick made while an Adventure's thread stays open, until another opens", async () => {
    const slot = mount(twoRpc(), { activeThreadId: "x" }, twoThreads);
    await waitFor(() => expect(workerRow(slot, "x")).toBeTruthy());
    fireEvent.click(otherEntry(slot));
    await waitFor(() => expect(listed(slot)).toHaveLength(3));
    // A refresh of the tree or the threads does not take the pick back.
    await slot.behavior.emitRealtime("initiatives-changed", { projectId: "p2" });
    await settle();
    expect(listed(slot)).toHaveLength(3);
    expect(stored().selected).toBe(OTHER_THREADS);
    // Opening an other thread keeps Other threads picked.
    open(slot, "a-old");
    await settle();
    expect(stored().selected).toBe(OTHER_THREADS);
    // Reopening the worker selects its Adventure again.
    open(slot, "x");
    await waitFor(() => expect(workerRow(slot, "x")).toBeTruthy());
  });

  it("selects the Adventure that names an opened thread, not the one it hangs under", async () => {
    // p2's coordinator was spawned from p1's.
    const nested = twoThreads.map((t) => (t.id === "c2" ? { ...t, parentThreadId: "c" } : t));
    const slot = mount(twoRpc(), { activeThreadId: "x" }, nested);
    await waitFor(() => expect(workerRow(slot, "x")).toBeTruthy());
    expect(stored().selected).toBe("p2");
  });

  it("selects the Adventure of a thread under an archived child of its worker, which BB does not list", async () => {
    pickOther();
    // BB's list holds the helper but not its archived parent; the host knows the chain.
    const threadAncestry = vi.fn(async ({ threadId }: { threadId: string }) => ({
      links: threadId === "gone" ? [{ id: "gone", parentThreadId: "x" }, { id: "x", parentThreadId: "c2" }] : [],
    }));
    const threadList = [...twoThreads, thread({ id: "late", title: "Late helper", parentThreadId: "gone" })];
    const slot = mount({ ...twoRpc(), threadAncestry }, { activeThreadId: "late" }, threadList);
    await waitFor(() => expect(workerRow(slot, "x")).toBeTruthy());
    expect(stored().selected).toBe("p2");
    expect(threadAncestry.mock.calls).toEqual([[{ threadId: "gone" }]]);
    // An answered chain is not asked again.
    open(slot, "a-old");
    open(slot, "late");
    await settle();
    expect(threadAncestry).toHaveBeenCalledTimes(1);
  });

  it("delivers a chain read before a remount to the sidebar mounted after it", async () => {
    pickOther();
    let answer!: (value: { links: { id: string; parentThreadId: string | null }[] }) => void;
    const threadAncestry = vi.fn(() => new Promise<{ links: { id: string; parentThreadId: string | null }[] }>((resolve) => (answer = resolve)));
    const threadList = [...twoThreads, thread({ id: "late-r", title: "Late helper", parentThreadId: "gone-r" })];
    const first = mount({ ...twoRpc(), threadAncestry }, { activeThreadId: "late-r" }, threadList);
    await waitFor(() => expect(threadAncestry).toHaveBeenCalledTimes(1));
    first.unmount();
    const second = mount({ ...twoRpc(), threadAncestry }, { activeThreadId: "late-r" }, threadList);
    await settle();
    // The read in flight is shared, not repeated.
    expect(threadAncestry).toHaveBeenCalledTimes(1);
    await act(async () => answer({ links: [{ id: "gone-r", parentThreadId: "x" }] }));
    await waitFor(() => expect(workerRow(second, "x")).toBeTruthy());
    expect(stored().selected).toBe("p2");
  });

  it("asks again on the next opening after a failed chain read", async () => {
    pickOther();
    const threadAncestry = vi
      .fn(async (_input: { threadId: string }) => ({ links: [{ id: "gone-f", parentThreadId: "x" }] }))
      .mockRejectedValueOnce(new Error("host busy"));
    const threadList = [
      ...twoThreads,
      thread({ id: "one-f", title: "Helper one", parentThreadId: "gone-f" }),
      thread({ id: "two-f", title: "Helper two", parentThreadId: "gone-f" }),
    ];
    const slot = mount({ ...twoRpc(), threadAncestry }, { activeThreadId: "one-f" }, threadList);
    await waitFor(() => expect(threadAncestry).toHaveBeenCalledTimes(1));
    await settle();
    expect(stored().selected).toBe(OTHER_THREADS);
    // Another helper under the same omitted parent asks again.
    open(slot, "two-f");
    await waitFor(() => expect(workerRow(slot, "x")).toBeTruthy());
    expect(threadAncestry).toHaveBeenCalledTimes(2);
    expect(stored().selected).toBe("p2");
  });

  it("asks the host nothing for a thread BB lists up to its root", async () => {
    const threadAncestry = vi.fn(async () => ({ links: [] }));
    const slot = mount({ ...twoRpc(), threadAncestry }, { activeThreadId: "a-old" }, twoThreads);
    await waitFor(() => expect(workerRow(slot, "w")).toBeTruthy());
    expect(threadAncestry).not.toHaveBeenCalled();
  });

  it("says the threads failed to load instead of listing no workers", async () => {
    const slot = mount(twoRpc(), {}, [], "error");
    const section = await slot.findByRole("region", { name: "Useful search workers" });
    expect(within(section).getByRole("alert").textContent).toContain("Cannot load threads.");
    expect(within(section).queryByText("No live workers.")).toBeNull();
  });

  it("falls back to the first Adventure when the picked one is gone", async () => {
    updateState((current) => ({ ...current, selected: "retired" }));
    const slot = mount(twoRpc(), {}, twoThreads);
    await waitFor(() => expect(workerRow(slot, "w")).toBeTruthy());
    expect(adventureRow(slot).getAttribute("aria-current")).toBe("true");
  });

  it("lists Other threads when Adventures is not running", async () => {
    const slot = mount({
      projectMode: async () => ({ available: false, tree: null, order: null, orderError: null }),
    });
    await waitFor(() => expect(listed(slot)).toEqual(["b-new", "a-mid", "a-old"]));
    expect(otherEntry(slot).getAttribute("aria-current")).toBe("true");
  });

  it("draws a picked Other threads at once, before the first tree read answers", async () => {
    pickOther();
    const slot = mount({ projectMode: () => new Promise(() => {}) });
    await waitFor(() => expect(listed(slot)).toEqual(["b-new", "a-mid", "a-old"]));
    expect(slot.getByText("Loading Adventures…")).toBeTruthy();
  });

  it("lists nothing below until the first tree read says what is first", async () => {
    const slot = mount({ projectMode: () => new Promise(() => {}) });
    await settle();
    expect(slot.getByText("Loading Adventures…")).toBeTruthy();
    expect(sectionTitles(slot)).toEqual(["Adventures"]);
    expect(slot.container.querySelector("[data-activity-thread-groups]")).toBeNull();
    expect(otherEntry(slot).getAttribute("aria-current")).toBeNull();
  });

  it("asks worker facts for the selected Adventure only, and none for Other threads", async () => {
    const read = vi.fn(async (_input: { known: string | null; workersOf?: string[] } | null) => ({
      available: true, tree: twoTree, order: null, orderError: null,
    }));
    const slot = mount(twoRpc(read), {}, twoThreads);
    await waitFor(() => expect(read.mock.calls.at(-1)?.[0]?.workersOf).toEqual(["p1"]));
    fireEvent.click(adventureRow(slot, "Second push"));
    await waitFor(() => expect(read.mock.calls.at(-1)?.[0]?.workersOf).toEqual(["p2"]));
    fireEvent.click(otherEntry(slot));
    await slot.behavior.emitRealtime("initiatives-changed", { projectId: "p2" });
    await waitFor(() => expect(read.mock.calls.at(-1)?.[0]?.workersOf).toBeUndefined());
  });
});

describe("Other threads", () => {
  beforeEach(pickOther);
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
  it("keeps Adventure threads and their descendants out of Archived", async () => {
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
    const slot = mount({ listArchived, initiativeThreads });
    const archive = await slot.findByRole("button", { name: "Archived" });
    // The section remembers being open across mounts.
    if (archive.getAttribute("aria-expanded") !== "true") fireEvent.click(archive);
    await waitFor(() =>
      expect(slot.container.querySelector('[data-sidebar-thread-id="plain"]')).toBeTruthy(),
    );
    expect(slot.container.querySelector('[data-sidebar-thread-id="w-old"]')).toBeNull();
    expect(slot.container.querySelector('[data-sidebar-thread-id="w-child"]')).toBeNull();
  });

  it("never lists a worker, its child threads or the coordinator", async () => {
    const slot = mount(workerRpc(), {}, workerThreads);
    await waitFor(() => expect(listed(slot)).toEqual(["b-new", "a-mid", "a-old"]));
    for (const id of ["c", "w", "w2", "w3", "rev", "rev-helper"])
      expect(slot.container.querySelector(`[data-sidebar-thread-id="${id}"]`)).toBeNull();
  });
});

describe("Adventure workers", () => {
  it("lists the selected Adventure's workers with their id and model, the title without the id", async () => {
    const read = withFacts();
    const slot = mount(workerRpc(read), {}, workerThreads);
    await waitFor(() => expect(workerRow(slot, "w")?.querySelector("[data-worker-model]")).toBeTruthy());
    const row = workerRow(slot, "w")!;
    expect(row.querySelector("[data-worker-ref]")?.textContent).toBe("W1");
    expect(row.querySelector("[data-worker-model]")?.textContent).toBe("Opus 5.5 · high");
    expect(row.querySelector("[data-worker-model]")?.getAttribute("title")).toBe(OPUS);
    expect(within(row).getByText("Build the index")).toBeTruthy();
    expect(row.textContent).not.toContain("W1 Build");
    // The selected Adventure's facts are asked for by id.
    expect(read.mock.calls.some(([input]) => input?.workersOf?.includes("p1"))).toBe(true);
  });

  it("lists the coordinator first, labelled, without the threads it spawned", async () => {
    const slot = mount(workerRpc(), {}, workerThreads);
    await waitFor(() => expect(workerIds(slot)[0]).toBe("c"));
    const row = workerRow(slot, "c")!;
    expect(row.querySelector("[data-worker-ref]")?.textContent).toBe("Coordinator");
    expect(row.querySelector("[data-worker-model]")).toBeNull();
    expect(within(row).queryByRole("button", { name: /child thread/ })).toBeNull();
  });

  it("draws the cached Adventures and worker facts at once, before the first read answers", async () => {
    cacheTree(tree);
    cacheWorkers({ p1: [{ ref: "W1", profile: OPUS, group: "working" }] });
    const slot = mount({ projectMode: () => new Promise(() => {}) });
    expect(slot.getByRole("link", { name: "Open Useful search" })).toBeTruthy();
    expect(slot.queryByText("Loading Adventures…")).toBeNull();
    expect(workerRow(slot, "w")?.querySelector("[data-worker-model]")?.textContent).toBe("Opus 5.5 · high");
  });

  it("folds a worker's child threads under a toggle shown only when it has some", async () => {
    const slot = mount(workerRpc(), {}, workerThreads);
    await waitFor(() => expect(workerRow(slot, "w")).toBeTruthy());
    const toggle = within(workerRow(slot, "w")!).getByRole("button", { name: /Show 1 child thread of/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(slot.container.querySelector('[data-adventure-workers] [data-sidebar-thread-id="rev"]')).toBeNull();
    fireEvent.click(toggle);
    expect(slot.container.querySelector('[data-adventure-workers] [data-sidebar-thread-id="rev"]')).toBeTruthy();
    // Its own child folds under a toggle of its own.
    expect(slot.container.querySelector('[data-adventure-workers] [data-sidebar-thread-id="rev-helper"]')).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: /Show 1 child thread of Review W1/ }));
    expect(slot.container.querySelector('[data-adventure-workers] [data-sidebar-thread-id="rev-helper"]')).toBeTruthy();
    // A worker without children has no toggle.
    expect(within(workerRow(slot, "w2")!).queryByRole("button", { name: /child thread/ })).toBeNull();
  });

  it("opens a folded toggle that holds the open thread", async () => {
    const slot = mount(workerRpc(), { activeThreadId: "rev" }, workerThreads);
    await waitFor(() =>
      expect(slot.container.querySelector('[data-adventure-workers] [data-sidebar-thread-id="rev"]')).toBeTruthy(),
    );
  });

  it("groups workers by state, or lists them by recent activity or worker id, and remembers it", async () => {
    const slot = mount(workerRpc(), {}, workerThreads);
    await waitFor(() => expect(groups(slot)).toEqual(["needs", "working", "done"]));
    expect(workerIds(slot)).toEqual(["c", "w3", "w", "w2"]);
    await chooseWorkers(slot, "None");
    expect(groups(slot)).toEqual([]);
    // Most recent activity first: w2 (2 min), w3 (20), w (30).
    expect(workerIds(slot)).toEqual(["c", "w2", "w3", "w"]);
    await chooseWorkers(slot, "Newest worker");
    expect(workerIds(slot)).toEqual(["c", "w3", "w2", "w"]);
    expect(stored().workerListing).toEqual({ groupBy: "none", sortBy: "worker" });
  });

  it("lists the workers in one list, without models, until their facts arrive", async () => {
    const slot = mount(
      workerRpc(vi.fn(async () => ({ available: true, tree: workerTree, order: null, orderError: null }))),
      {},
      workerThreads,
    );
    await waitFor(() => expect(workerRow(slot, "w")).toBeTruthy());
    expect(groups(slot)).toEqual([]);
    expect(slot.container.querySelector("[data-worker-model]")).toBeNull();
    expect(workerRow(slot, "w")!.querySelector("[data-worker-ref]")?.textContent).toBe("W1");
  });

  it("marks the selected Adventure and the open thread apart", async () => {
    const slot = mount(workerRpc(), { activeThreadId: "w" }, workerThreads);
    await waitFor(() => expect(workerRow(slot, "w")).toBeTruthy());
    expect(adventureRow(slot).getAttribute("aria-current")).toBe("true");
    const link = (id: string) =>
      slot.container.querySelector(`[data-adventure-workers] [data-sidebar-thread-id="${id}"]`)!;
    expect(link("w").getAttribute("aria-current")).toBe("page");
    expect(link("c").getAttribute("aria-current")).toBeNull();
  });

  it("offers no way to create an Adventure, and the worker options sit over its workers", async () => {
    const slot = mount();
    await slot.findByRole("link", { name: "Open Useful search" });
    expect(slot.queryByRole("button", { name: /New (initiative|adventure)/i })).toBeNull();
    expect(slot.queryByRole("dialog")).toBeNull();
    expect(slot.container.querySelector('[data-section-header="Adventures"] button')).toBeNull();
    expect(
      slot.container.querySelector('[data-section-header="Useful search"] button[aria-label="Worker list options"]'),
    ).toBeTruthy();
  });
});
