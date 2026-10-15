// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import { OTHER_THREADS, parseState, updateState } from "../lib/client-state";
import { cacheTree, cacheWorkers } from "../lib/initiative-tree-cache";
import { CREATE_TIMEOUT_MS, reloadSubmissions } from "../lib/initiative-submissions";
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
  reloadSubmissions();
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
    expect(workerIds(slot)).toEqual(["w3", "w", "w2"]);
    await chooseWorkers(slot, "None");
    expect(groups(slot)).toEqual([]);
    // Most recent activity first: w2 (2 min), w3 (20), w (30).
    expect(workerIds(slot)).toEqual(["w2", "w3", "w"]);
    await chooseWorkers(slot, "Newest worker");
    expect(workerIds(slot)).toEqual(["w3", "w2", "w"]);
    expect(stored().workerListing).toEqual({ groupBy: "none", sortBy: "worker" });
  });

  it("puts a quiet worker over a live review under Waiting, and names Done as the Workers tab does", async () => {
    // W2 reported done, then took more work: its review now asks for approval.
    const review = thread({ id: "rev2", title: "Review r2", parentThreadId: "w2", hasPendingInteraction: true, updatedAt: minutes(1) });
    const slot = mount(workerRpc(), {}, [...workerThreads, review]);
    await waitFor(() => expect(groups(slot)).toEqual(["needs", "working", "waiting"]));
    expect(slot.getByRole("region", { name: "Waiting" })).toBeTruthy();
    // Once the review ends, it is done again, a PR waiting on you.
    slot.unmount();
    const after = mount(workerRpc(), {}, workerThreads);
    await waitFor(() => expect(groups(after)).toEqual(["needs", "working", "done"]));
    expect(after.getByRole("region", { name: "Done · PR waiting" })).toBeTruthy();
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
    expect(link("w2").getAttribute("aria-current")).toBeNull();
  });

  it("offers a + level with the Adventures title, and the worker options over its workers", async () => {
    const slot = mount();
    await slot.findByRole("link", { name: "Open Useful search" });
    expect(
      slot.container.querySelector('[data-section-header="Adventures"] button[aria-label="New Adventure"]'),
    ).toBeTruthy();
    // Only the header creates: no Adventure row offers it.
    expect(slot.getAllByRole("button", { name: "New Adventure" })).toHaveLength(1);
    expect(
      slot.container.querySelector('[data-section-header="Useful search"] button[aria-label="Worker list options"]'),
    ).toBeTruthy();
  });
});

describe("New Adventure", () => {
  const fill = async (slot: ReturnType<typeof renderSlot>) => {
    fireEvent.click(await slot.findByRole("button", { name: "New Adventure" }));
    const dialog = await slot.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Faster builds" } });
    fireEvent.change(within(dialog).getByLabelText("What should it achieve?"), {
      target: { value: "Halve CI time" },
    });
    return dialog;
  };

  it("creates in the background from the + and opens the new coordinator", async () => {
    let finish!: (value: unknown) => void;
    const createInitiative = vi.fn(() => new Promise((resolve) => (finish = resolve)));
    const onNavigate = vi.fn();
    const slot = mount({ createInitiative }, { onNavigate });
    const dialog = await fill(slot);
    // The open thread's repository is preselected and hosts the coordinator.
    const alpha = within(dialog).getByRole("checkbox", { name: /Alpha/ }) as HTMLInputElement;
    expect(alpha.checked).toBe(true);
    expect(within(dialog).queryByText("No project")).toBeNull();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Beta/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Create Adventure" }));
    await settle();
    // The dialog closes at once; the list shows the draft while it is created.
    expect(slot.queryByRole("dialog")).toBeNull();
    expect(slot.container.querySelector('[data-initiative-submission="pending"]')?.textContent).toContain(
      "Faster builds",
    );
    expect(createInitiative).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Faster builds",
        objective: "Halve CI time",
        memberProjectIds: ["project-1", "project-2"],
        key: expect.stringMatching(/^sidebar-create:/),
      }),
    );
    await act(async () => finish({ write: "done", projectId: "p9", coordinatorThreadId: "c9", note: null }));
    await settle();
    expect(slot.container.querySelector("[data-initiative-submission]")).toBeNull();
    expect(slot.inspection.navigateCalls).toContainEqual(
      expect.objectContaining({ method: "toThread", threadId: "c9" }),
    );
    expect(onNavigate).toHaveBeenCalled();
  });

  it("selects the created Adventure once the tree lists it", async () => {
    const created = {
      ...initiative,
      id: "p9",
      name: "Faster builds",
      coordinatorThreadId: "c9",
      nodes: [{ ...initiative.nodes[0]!, threadId: "c9" }],
    };
    let listed = [initiative];
    const projectMode = async () => ({
      available: true,
      tree: { version: 1 as const, projects: listed },
      order: null,
      orderError: null,
    });
    let finish!: (value: unknown) => void;
    const createInitiative = vi.fn(() => new Promise((resolve) => (finish = resolve)));
    const slot = mount({ projectMode, createInitiative });
    const dialog = await fill(slot);
    fireEvent.click(within(dialog).getByRole("button", { name: "Create Adventure" }));
    await settle();
    expect(slot.getByRole("region", { name: "Useful search workers" })).toBeTruthy();
    listed = [initiative, created];
    await act(async () => finish({ write: "done", projectId: "p9", coordinatorThreadId: "c9", note: null }));
    await waitFor(() => expect(slot.getByRole("region", { name: "Faster builds workers" })).toBeTruthy());
    expect(adventureRow(slot, "Faster builds").getAttribute("aria-current")).toBe("true");
  });

  it("keeps a resumed create's pick when the first tree read places the open thread elsewhere", async () => {
    const first = mount({ createInitiative: vi.fn(() => new Promise(() => {})) });
    fireEvent.click(within(await fill(first)).getByRole("button", { name: "Create Adventure" }));
    await settle();
    first.unmount();
    // A reload onto a worker of Useful search, with no cached tree: the
    // resumed create answers before the first tree read does.
    reloadSubmissions();
    window.localStorage.removeItem("bb-plugin-sidebar:initiative-tree:v1");
    const created = {
      ...initiative,
      id: "p9",
      name: "Faster builds",
      coordinatorThreadId: "c9",
      nodes: [{ ...initiative.nodes[0]!, threadId: "c9" }],
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reads = 0;
    const projectMode = async () => {
      const projects = ++reads === 1 ? [initiative] : [initiative, created];
      await gate;
      return { available: true, tree: { version: 1 as const, projects }, order: null, orderError: null };
    };
    const createInitiative = vi.fn(async () => ({ write: "done", projectId: "p9", coordinatorThreadId: "c9", note: null }));
    const slot = mount({ projectMode, createInitiative }, { activeThreadId: "w" });
    await settle();
    expect(createInitiative).toHaveBeenCalledTimes(1);
    await act(async () => release());
    await waitFor(() => expect(slot.getByRole("region", { name: "Faster builds workers" })).toBeTruthy());
    expect(adventureRow(slot, "Faster builds").getAttribute("aria-current")).toBe("true");
  });

  const faster = {
    ...initiative,
    id: "p9",
    name: "Faster builds",
    coordinatorThreadId: "c9",
    nodes: [{ ...initiative.nodes[0]!, threadId: "c9" }],
  };
  /** A tree read that lists what `listed` holds at the time. */
  const listing = (listed: { current: (typeof initiative)[] }) => async () => ({
    available: true,
    tree: { version: 1 as const, projects: listed.current },
    order: null,
    orderError: null,
  });
  const created = async () => ({ write: "done", projectId: "p9", coordinatorThreadId: null, note: null });

  it("lets a pick made meanwhile in another tab win over the created Adventure", async () => {
    const listed = { current: [initiative] };
    const slot = mount({ projectMode: listing(listed), createInitiative: vi.fn(created) });
    fireEvent.click(within(await fill(slot)).getByRole("button", { name: "Create Adventure" }));
    await settle();
    expect(stored().selected).toBe("p9");
    // Another tab stores Other threads; its storage event has not arrived yet.
    const key = "bb-plugin-sidebar:v1";
    window.localStorage.setItem(key, JSON.stringify({ ...JSON.parse(window.localStorage.getItem(key)!), selected: OTHER_THREADS }));
    listed.current = [initiative, faster];
    await slot.behavior.emitRealtime("initiatives-changed", {});
    await waitFor(() => expect(slot.getByRole("link", { name: "Open Faster builds" })).toBeTruthy());
    expect(stored().selected).toBe(OTHER_THREADS);
    // The event lands: this tab follows.
    act(() => pickOther());
    expect(slot.getByRole("region", { name: "Other threads" })).toBeTruthy();
  });

  it("keeps the created Adventure picked when the open thread's ancestry answers later", async () => {
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    // The open helper hangs under an archived child of W1, which BB does not list.
    const threadAncestry = vi.fn(async () => {
      await answered;
      return { links: [{ id: "gone9", parentThreadId: "w" }] };
    });
    const listed = { current: [initiative] };
    const slot = mount(
      { projectMode: listing(listed), createInitiative: vi.fn(created), threadAncestry },
      { activeThreadId: "late9" },
      [...threads, thread({ id: "late9", title: "Late helper", parentThreadId: "gone9" })],
    );
    fireEvent.click(within(await fill(slot)).getByRole("button", { name: "Create Adventure" }));
    await settle();
    listed.current = [initiative, faster];
    await slot.behavior.emitRealtime("initiatives-changed", {});
    await waitFor(() => expect(slot.getByRole("region", { name: "Faster builds workers" })).toBeTruthy());
    expect(threadAncestry).toHaveBeenCalled();
    await act(async () => answer());
    await settle();
    expect(stored().selected).toBe("p9");
    expect(slot.getByRole("region", { name: "Faster builds workers" })).toBeTruthy();
  });

  it("keeps a failed draft with its reason and resends it under the same key", async () => {
    const createInitiative = vi
      .fn()
      .mockRejectedValueOnce(new Error("BB project project-1 does not exist."))
      .mockResolvedValueOnce({ write: "done", projectId: "p9", coordinatorThreadId: null, note: "Checkout pending." });
    const slot = mount({ createInitiative });
    const dialog = await fill(slot);
    fireEvent.click(within(dialog).getByRole("button", { name: "Create Adventure" }));
    await settle();
    const failed = slot.container.querySelector('[data-initiative-submission="failed"]') as HTMLElement;
    expect(within(failed).getByRole("alert").textContent).toBe("BB project project-1 does not exist.");
    fireEvent.click(within(failed).getByRole("button", { name: "Edit" }));
    const again = await slot.findByRole("dialog");
    expect((within(again).getByLabelText("Name") as HTMLInputElement).value).toBe("Faster builds");
    fireEvent.click(within(again).getByRole("button", { name: "Create Adventure" }));
    await settle();
    const [first, second] = createInitiative.mock.calls.map(([input]) => input.key);
    expect(second).toBe(first);
    // No coordinator yet: nothing navigates, and the note says why.
    expect(slot.inspection.navigateCalls).toEqual([]);
    expect(slot.getByText(/Checkout pending\./)).toBeTruthy();
  });

  it("needs a name, an objective and a repository", async () => {
    const slot = mount({}, { activeProjectId: "personal", activeThreadId: null });
    fireEvent.click(await slot.findByRole("button", { name: "New Adventure" }));
    const dialog = await slot.findByRole("dialog");
    const create = within(dialog).getByRole("button", { name: "Create Adventure" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "N" } });
    fireEvent.change(within(dialog).getByLabelText("What should it achieve?"), { target: { value: "O" } });
    // A personal project cannot host an Adventure, so nothing is preselected.
    expect(create.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Beta/ }));
    expect(create.disabled).toBe(false);
    expect(within(dialog).getByText("Coordinator")).toBeTruthy();
  });
});

describe("W447 review fixes", () => {
  const fill = async (slot: ReturnType<typeof renderSlot>) => {
    fireEvent.click(await slot.findByRole("button", { name: "New Adventure" }));
    const dialog = await slot.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Faster builds" } });
    fireEvent.change(within(dialog).getByLabelText("What should it achieve?"), {
      target: { value: "Halve CI time" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create Adventure" }));
    await settle();
  };
  const submission = (slot: ReturnType<typeof renderSlot>) =>
    slot.container.querySelector("[data-initiative-submission]") as HTMLElement | null;
  const resend = async (slot: ReturnType<typeof renderSlot>) => {
    fireEvent.click(within(submission(slot)!).getByRole("button", { name: "Edit" }));
    const dialog = await slot.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create Adventure" }));
    await settle();
  };
  it("finding 1: keeps a sent draft and its key across a remount of the list", async () => {
    let finish!: (value: unknown) => void;
    const createInitiative = vi
      .fn()
      .mockRejectedValueOnce(new Error("Connection lost."))
      .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const slot = mount({ createInitiative });
    await fill(slot);
    expect(submission(slot)?.getAttribute("data-initiative-submission")).toBe("failed");
    slot.unmount();
    expect(submission(slot)).toBeNull();
    let remounted = mount({ createInitiative });
    await settle();
    // The failed draft is still there, and sending it again reuses its key.
    expect(submission(remounted)?.getAttribute("data-initiative-submission")).toBe("failed");
    await resend(remounted);
    const [first, second] = createInitiative.mock.calls.map(([input]) => input.key);
    expect(second).toBe(first);
    // An answer that lands while the list is not mounted still settles it.
    remounted.unmount();
    await act(async () => finish({ write: "done", projectId: "p9", coordinatorThreadId: "c9", note: "Checkout pending." }));
    remounted = mount({ createInitiative });
    await settle();
    expect(submission(remounted)).toBeNull();
    expect(remounted.getByText(/Checkout pending\./)).toBeTruthy();
  });

  it("finding 1: sends a draft a reload cut off again under its key, without opening it", async () => {
    let finish!: (value: unknown) => void;
    const createInitiative = vi.fn((_input: { key: string }) => new Promise((resolve) => (finish = resolve)));
    const slot = mount({ createInitiative });
    await fill(slot);
    const [sent] = createInitiative.mock.calls.map(([input]) => input.key);
    slot.unmount();
    // A reload: the page forgets the call, storage keeps the draft.
    reloadSubmissions();
    const again = vi.fn((_input: { key: string }) => new Promise((resolve) => (finish = resolve)));
    const reloaded = mount({ createInitiative: again });
    await settle();
    expect(again).toHaveBeenCalledTimes(1);
    expect(again.mock.calls[0]![0].key).toBe(sent);
    expect(submission(reloaded)?.getAttribute("data-initiative-submission")).toBe("pending");
    await act(async () => finish({ write: "done", projectId: "p9", coordinatorThreadId: "c9", note: null }));
    await settle();
    expect(submission(reloaded)).toBeNull();
    expect(reloaded.inspection.navigateCalls).toEqual([]);
    // Once per page: a remount does not send it again.
    reloaded.unmount();
    mount({ createInitiative: again });
    await settle();
    expect(again).toHaveBeenCalledTimes(1);
  });

  it("finding 3: renews the key after a settled refusal or unknown outcome, keeps it after a lost answer", async () => {
    const createInitiative = vi
      .fn()
      .mockRejectedValueOnce(new Error("Connection lost."))
      .mockResolvedValueOnce({ write: "rejected", message: "BB project project-1 does not exist." })
      .mockResolvedValueOnce({ write: "unknown", message: "It is unclear what this saved." })
      .mockResolvedValueOnce({ write: "done", projectId: "p9", coordinatorThreadId: null, note: null });
    const slot = mount({ createInitiative });
    await fill(slot);
    await resend(slot);
    expect(within(submission(slot)!).getByRole("alert").textContent).toBe(
      "BB project project-1 does not exist.",
    );
    await resend(slot);
    expect(within(submission(slot)!).getByRole("alert").textContent).toBe("It is unclear what this saved.");
    await resend(slot);
    expect(submission(slot)).toBeNull();
    const keys = createInitiative.mock.calls.map(([input]) => input.key);
    // Lost answer: same key. Refused: new key. Unknown: new key again.
    expect(keys[1]).toBe(keys[0]);
    expect(new Set(keys.slice(1)).size).toBe(3);
  });

  it("finding 4: settles a create that succeeds after the deadline", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let finish!: (value: unknown) => void;
      const createInitiative = vi.fn(() => new Promise((resolve) => (finish = resolve)));
      const onNavigate = vi.fn();
      const slot = mount({ createInitiative }, { onNavigate });
      await fill(slot);
      await act(async () => { await vi.advanceTimersByTimeAsync(CREATE_TIMEOUT_MS); });
      expect(submission(slot)?.getAttribute("data-initiative-submission")).toBe("failed");
      await act(async () => finish({ write: "done", projectId: "p9", coordinatorThreadId: "c9", note: "Checkout pending." }));
      await settle();
      expect(submission(slot)).toBeNull();
      expect(slot.getByText(/Checkout pending\./)).toBeTruthy();
      // The user stayed put, so it still opens the coordinator.
      expect(slot.inspection.navigateCalls).toContainEqual(
        expect.objectContaining({ method: "toThread", threadId: "c9" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("W448 review fixes", () => {
  const DAY = 24 * 60 * 60_000;
  const fill = async (slot: ReturnType<typeof renderSlot>) => {
    fireEvent.click(await slot.findByRole("button", { name: "New Adventure" }));
    const dialog = await slot.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Faster builds" } });
    fireEvent.change(within(dialog).getByLabelText("What should it achieve?"), {
      target: { value: "Halve CI time" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create Adventure" }));
    await settle();
  };
  const rows = (slot: ReturnType<typeof renderSlot>) =>
    Array.from(slot.container.querySelectorAll<HTMLElement>("[data-initiative-submission]"));
  const edit = async (slot: ReturnType<typeof renderSlot>) => {
    fireEvent.click(within(rows(slot)[0]!).getByRole("button", { name: "Edit" }));
    return slot.findByRole("dialog");
  };
  const resend = async (slot: ReturnType<typeof renderSlot>) => {
    fireEvent.click(within(await edit(slot)).getByRole("button", { name: "Create Adventure" }));
    await settle();
  };
  const keys = (create: { mock: { calls: unknown[][] } }) =>
    create.mock.calls.map(([input]) => (input as { key: string }).key);
  const never = () => new Promise<never>(() => {});
  const done = { write: "done", projectId: "p9", coordinatorThreadId: null, note: null };
  afterEach(() => vi.useRealTimers());

  it("finding 1: a reload past the retry window keeps the draft to check instead of sending its key", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const createInitiative = vi.fn(never);
    const slot = mount({ createInitiative });
    await fill(slot);
    const [sent] = keys(createInitiative);
    slot.unmount();
    // The browser stays closed for nine days: Adventures no longer holds
    // the receipt, so sending the key again would create a second one.
    vi.setSystemTime(Date.now() + 9 * DAY);
    reloadSubmissions();
    const again = vi.fn(async (_input: { key: string }) => done);
    const reloaded = mount({ createInitiative: again });
    await settle();
    expect(again).not.toHaveBeenCalled();
    const [row] = rows(reloaded);
    expect(row?.getAttribute("data-initiative-submission")).toBe("failed");
    expect(within(row!).getByRole("alert").textContent).toMatch(/over 7 days ago/);
    // Sending it after that is a deliberate new create, under a new key.
    await resend(reloaded);
    expect(keys(again)).toHaveLength(1);
    expect(keys(again)[0]).not.toBe(sent);
    expect(rows(reloaded)).toEqual([]);
  });

  it("finding 1: refuses to send a key again by hand past the retry window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const createInitiative = vi
      .fn()
      .mockRejectedValueOnce(new Error("Connection lost."))
      .mockResolvedValue(done);
    const slot = mount({ createInitiative });
    await fill(slot);
    vi.setSystemTime(Date.now() + 8 * DAY);
    await resend(slot);
    expect(createInitiative).toHaveBeenCalledTimes(1);
    expect(within(rows(slot)[0]!).getByRole("alert").textContent).toMatch(/over 7 days ago/);
    await resend(slot);
    const [first, second] = keys(createInitiative);
    expect(second).not.toBe(first);
    expect(rows(slot)).toEqual([]);
  });

  it.each([
    ["rejected", "BB project project-1 does not exist."],
    ["unknown", "It is unclear what this saved."],
  ])(
    "finding 3: an Edit opened before a %s answer sends the renewed key and replaces its row",
    async (write, message) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      let finish!: (value: unknown) => void;
      const createInitiative = vi
        .fn()
        .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
        .mockImplementation(never);
      const slot = mount({ createInitiative });
      await fill(slot);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CREATE_TIMEOUT_MS);
      });
      const dialog = await edit(slot);
      // The first send's answer settles its key while the dialog is open.
      await act(async () => finish({ write, message }));
      await settle();
      expect(rows(slot)[0]!.querySelector('[role="alert"]')?.textContent).toBe(message);
      fireEvent.click(within(dialog).getByRole("button", { name: "Create Adventure" }));
      await settle();
      const [first, second] = keys(createInitiative);
      expect(second).toBeDefined();
      expect(second).not.toBe(first);
      expect(rows(slot).map((row) => row.getAttribute("data-initiative-submission"))).toEqual(["pending"]);
    },
  );

  it("closes an Edit dialog whose draft was created meanwhile", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let finish!: (value: unknown) => void;
    const createInitiative = vi.fn(() => new Promise((resolve) => (finish = resolve)));
    const slot = mount({ createInitiative });
    await fill(slot);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CREATE_TIMEOUT_MS);
    });
    await edit(slot);
    await act(async () => finish(done));
    await settle();
    // Nothing is left to send, so the dialog cannot send it twice.
    expect(slot.queryByRole("dialog")).toBeNull();
    expect(rows(slot)).toEqual([]);
    expect(createInitiative).toHaveBeenCalledTimes(1);
  });
});
