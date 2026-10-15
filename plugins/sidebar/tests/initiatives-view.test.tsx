// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import { parseState, updateState } from "../lib/client-state";
import { cacheTree, cacheWorkers } from "../lib/initiative-tree-cache";
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
  listArchived: async () => [],
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
  it("shows Adventures, then every other thread ungrouped and most recent first", async () => {
    const slot = mount();
    await slot.findByRole("link", { name: "Open Useful search" });
    await waitFor(() => expect(listed(slot)).toEqual(["b-new", "a-mid", "a-old"]));
    expect(sectionTitles(slot)).toEqual(["Adventures"]);
    expect(slot.getByRole("button", { name: /^Other threads/ }).getAttribute("aria-expanded")).toBe("true");
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

  it("groups by project under the Other threads entry", async () => {
    const slot = mount();
    await waitFor(() => expect(listed(slot)).toHaveLength(3));
    await choose(slot, /Grouping/, "Project");
    expect(sectionTitles(slot)).toEqual(["Adventures"]);
    const groups = Array.from(slot.container.querySelectorAll("[data-group-header]"), (el) =>
      el.getAttribute("data-group-header"),
    );
    expect(groups).toEqual(["project:project-1", "project:project-2"]);
    expect(listed(slot)).toEqual(["a-mid", "a-old", "b-new"]);
    expect(parseState(window.localStorage.getItem("bb-plugin-sidebar:v1")).listing.groupBy).toBe("project");
  });

  it("groups by status", async () => {
    const slot = mount();
    await waitFor(() => expect(listed(slot)).toHaveLength(3));
    await choose(slot, /Grouping/, "Status");
    expect(sectionTitles(slot)).toEqual(["Adventures"]);
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

  it("draws the cached Adventures and worker facts at once, before the first read answers", async () => {
    cacheTree(tree);
    cacheWorkers({ p1: [{ ref: "W1", profile: OPUS, group: "working" }] });
    const slot = mount({ projectMode: () => new Promise(() => {}) });
    expect(slot.getByRole("link", { name: "Open Useful search" })).toBeTruthy();
    expect(slot.queryByText("Loading Adventures…")).toBeNull();
    expect(workerRow(slot, "w")?.querySelector("[data-worker-model]")?.textContent).toBe("Opus 5.5 · high");
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

describe("Other threads", () => {
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

  it("folds and unfolds, and remembers it", async () => {
    const slot = mount();
    await waitFor(() => expect(listed(slot)).toHaveLength(3));
    const entry = slot.getByRole("button", { name: /^Other threads/ });
    fireEvent.click(entry);
    expect(entry.getAttribute("aria-expanded")).toBe("false");
    expect(listed(slot)).toEqual([]);
    expect(parseState(window.localStorage.getItem("bb-plugin-sidebar:v1")).collapsed).toContain("other-threads");
    // The list options and New thread stay on the entry.
    expect(slot.getByRole("button", { name: "Thread list options" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "New thread" })).toBeTruthy();
    fireEvent.click(entry);
    expect(listed(slot)).toEqual(["b-new", "a-mid", "a-old"]);
  });

  it("never lists a worker, its child threads or the coordinator", async () => {
    const slot = mount(workerRpc(), {}, workerThreads);
    await waitFor(() => expect(workerRow(slot, "w")).toBeTruthy());
    expect(listed(slot)).toEqual(["b-new", "a-mid", "a-old"]);
  });
});

describe("Adventure workers", () => {
  it("lists an open Adventure's workers with their id and model, the title without the id", async () => {
    const read = withFacts();
    const slot = mount(workerRpc(read), {}, workerThreads);
    await waitFor(() => expect(workerRow(slot, "w")?.querySelector("[data-worker-model]")).toBeTruthy());
    const row = workerRow(slot, "w")!;
    expect(row.querySelector("[data-worker-ref]")?.textContent).toBe("W1");
    expect(row.querySelector("[data-worker-model]")?.textContent).toBe("Opus 5.5 · high");
    expect(row.querySelector("[data-worker-model]")?.getAttribute("title")).toBe(OPUS);
    expect(within(row).getByText("Build the index")).toBeTruthy();
    expect(row.textContent).not.toContain("W1 Build");
    // The open Adventure's facts are asked for by id.
    expect(read.mock.calls.some(([input]) => input?.workersOf?.includes("p1"))).toBe(true);
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
    expect(parseState(window.localStorage.getItem("bb-plugin-sidebar:v1")).workerListing).toEqual({
      groupBy: "none",
      sortBy: "worker",
    });
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

  it("opens and closes an Adventure from its chevron, and keeps a closed one closed", async () => {
    const slot = mount(workerRpc(), {}, workerThreads);
    await waitFor(() => expect(workerRow(slot, "w")).toBeTruthy());
    const chevron = slot.getByRole("button", { name: "Hide the workers of Useful search" });
    fireEvent.click(chevron);
    expect(slot.container.querySelector("[data-adventure-workers]")).toBeNull();
    expect(parseState(window.localStorage.getItem("bb-plugin-sidebar:v1")).adventures).toEqual({ p1: false });
    fireEvent.click(slot.getByRole("button", { name: "Show the workers of Useful search" }));
    expect(workerRow(slot, "w")).toBeTruthy();
  });

  it("starts closed when the open thread is elsewhere", async () => {
    const slot = mount(workerRpc(), { activeThreadId: "a-old" }, workerThreads);
    await slot.findByRole("button", { name: "Show the workers of Useful search" });
    expect(slot.container.querySelector("[data-adventure-workers]")).toBeNull();
  });

  it("marks the open thread once: the worker row, or the Adventure row for its coordinator or while folded", async () => {
    const slot = mount(workerRpc(), { activeThreadId: "w" }, workerThreads);
    await waitFor(() => expect(workerRow(slot, "w")).toBeTruthy());
    expect(slot.getByRole("link", { name: "Open Useful search" }).getAttribute("aria-current")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Hide the workers of Useful search" }));
    expect(slot.getByRole("link", { name: "Open Useful search" }).getAttribute("aria-current")).toBe("page");
  });

  it("asks worker facts for at most 64 open Adventures, so the tree read stays valid", async () => {
    const many = Array.from({ length: 70 }, (_, i) => ({ ...initiative, id: `p${i}`, name: `A${i}`, coordinatorThreadId: null, nodes: [] }));
    updateState((current) => ({ ...current, adventures: Object.fromEntries(many.map((p) => [p.id, true])) }));
    const read = vi.fn(async (_input: { workersOf?: string[] } | null) => ({
      available: true, tree: { version: 1 as const, projects: many }, order: null, orderError: null,
    }));
    const slot = mount({ projectMode: read });
    await slot.findByRole("link", { name: "Open A69" });
    await waitFor(() => expect(read.mock.calls.some(([input]) => input?.workersOf)).toBe(true));
    for (const [input] of read.mock.calls) expect(input?.workersOf?.length ?? 0).toBeLessThanOrEqual(64);
  });

  it("offers no way to create an Adventure", async () => {
    const slot = mount();
    await slot.findByRole("link", { name: "Open Useful search" });
    expect(slot.queryByRole("button", { name: /New (initiative|adventure)/i })).toBeNull();
    expect(slot.queryByRole("dialog")).toBeNull();
    expect(slot.container.querySelector('[data-section-header="Adventures"] button[aria-label="Worker list options"]')).toBeTruthy();
  });
});
