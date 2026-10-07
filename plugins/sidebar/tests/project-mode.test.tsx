// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import {
  loadPluginApp,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import { parseState, updateState } from "../lib/client-state";
import { PROJECT_ORDER_CHANNEL } from "../lib/project-order-schema";
import type { PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import { thread } from "./fixtures";
import { projectHueStep } from "../lib/project-hue";
import { READ_TIMEOUT_MS, READ_TIMEOUT_MESSAGE, resetReports } from "../lib/read-timeout";
const app = await loadPluginApp(() => import("../app"));
const Component = app.threadLists[0].component;
const slots: ReturnType<typeof renderSlot>[] = [];
beforeEach(() => {
  localStorage.clear();
  updateState(() => ({ ...parseState(null), mode: "initiatives" }));
});
afterEach(() => {
  for (const s of slots.splice(0)) s.unmount();
  cleanup();
  updateState(() => parseState(null));
});
const tree = {
  version: 1,
  projects: [
    {
      id: "p1",
      name: "Useful search",
      objective: "Find historical work",
      paused: false,
      coordinatorThreadId: "c",
      memberProjectIds: ["project-1"],
      inFlight: 2,
      remaining: 3,
      opinions: 1,
      revisit: 1,
      retired: 2,
      nodes: [
        {
          threadId: "c",
          label: "Coordinator",
          role: "coordinator",
          worker: null,
          parentWorker: null,
          state: "coordinating",
          bbProjectId: "project-1",
        },
        {
          threadId: "w",
          label: "Search reviewer",
          role: "review",
          worker: "W1",
          parentWorker: null,
          state: "active",
          bbProjectId: "project-1",
        },
      ],
    },
  ],
};
const secondProject = {
  id: "p2",
  name: "Second push",
  objective: "Ship the fix",
  paused: false,
  coordinatorThreadId: "c2",
  memberProjectIds: ["project-2"],
  inFlight: 0,
  remaining: 0,
  opinions: 0,
  revisit: 0,
  retired: 0,
  nodes: [
    {
      threadId: "c2",
      label: "Coordinator",
      role: "coordinator",
      worker: null,
      parentWorker: null,
      state: "coordinating",
      bbProjectId: "project-2",
    },
    {
      threadId: "w2",
      label: "Builder",
      role: "work",
      worker: "W1",
      parentWorker: null,
      state: "active",
      bbProjectId: "project-2",
    },
    {
      threadId: "w2-archived",
      label: "Old helper",
      role: "work",
      worker: "W2",
      parentWorker: null,
      state: "idle",
      bbProjectId: "project-2",
    },
  ],
};
const richTree = {
  ...tree,
  projects: [tree.projects[0], secondProject],
};
const richThreads = [
  thread({ id: "c", title: "Coordinator c" }),
  thread({ id: "w", title: "Reviewer thread" }),
  // A former generation still hangs off the coordinator natively; it is not a
  // current node and must not list.
  thread({
    id: "former",
    title: "Former generation",
    parentThreadId: "c",
    indicator: "runtime",
  }),
  // Children of a worker list only while they carry a live status.
  thread({ id: "done-child", title: "Settled child", parentThreadId: "w" }),
  thread({
    id: "run-child",
    title: "Running child",
    parentThreadId: "w",
    indicator: "runtime",
  }),
  thread({ id: "c2", title: "Coordinator 2", projectId: "project-2" }),
  thread({ id: "w2", title: "Builder thread", projectId: "project-2" }),
  thread({
    id: "w2-archived",
    title: "Archived worker",
    projectId: "project-2",
    isArchived: true,
  }),
];
const nativeProjects = [
  { id: "project-1", name: "Repository", isPersonal: false },
  { id: "project-2", name: "Second repo", isPersonal: false },
];
function mount(
  available = true,
  overrides: {
    props?: Partial<PluginThreadListProps>;
    treeData?: typeof richTree;
    threads?: typeof richThreads;
    order?: { revision: number; order: string[] } | null;
    saveProjectOrder?: (input: {
      expectedRevision: number;
      order: string[];
    }) => { revision: number; order: string[] } | Promise<never>;
    rpc?: Record<string, (input: never) => unknown>;
  } = {},
) {
  const props = {
    activeThreadId: "c",
    activeProjectId: "project-1",
    isCompactViewport: false,
    searchQuery: "",
    onNavigate: vi.fn(),
    Original: () => null,
    ...overrides.props,
  };
  const slot = renderSlot(app.threadLists[0], props, {
    rpc: {
      projectMode: () => ({
        available,
        tree: available ? (overrides.treeData ?? tree) : null,
        order: available ? (overrides.order ?? null) : null,
        orderError: null,
      }),
      saveProjectOrder: (input: unknown) => {
        const save =
          overrides.saveProjectOrder ??
          ((args: { expectedRevision: number; order: string[] }) => ({
            revision: args.expectedRevision + 1,
            order: args.order,
          }));
        return save(input as { expectedRevision: number; order: string[] });
      },
      renameTreeProject: async () => ({}),
      linkedPullRequests: async () => ({
        pullRequests: {},
        branchPrEligible: {},
      }),
      ...overrides.rpc,
    },
    openUrl: () => true,
    sidebarThreads: {
      projects: nativeProjects,
      threads: overrides.threads ?? [
        thread({ id: "c" }),
        thread({ id: "w" }),
      ],
    },
  });
  slots.push(slot);
  return slot;
}
const rowOrder = (slot: ReturnType<typeof renderSlot>) =>
  Array.from(
    slot.container.querySelectorAll("[data-project-row]"),
  ).map((row) => row.getAttribute("data-project-row"));
const rowAnchor = (
  slot: ReturnType<typeof renderSlot>,
  name: string,
) => slot.getByRole("link", { name: `Open ${name}` });
const openContextMenu = async (
  slot: ReturnType<typeof renderSlot>,
  name: string,
) => {
  const anchor = await slot.findByRole("link", { name: `Open ${name}` });
  fireEvent.contextMenu(anchor);
  return slot.findByRole("menu", { name: `Actions for ${name}` });
};
describe("Projects sidebar mode", () => {
  it("T63 shares pending reads and coalesces ledger signals without withholding the initial tree", async () => {
    let release!: (value: unknown) => void;
    const held = new Promise(resolve => { release = resolve; });
    const read = vi.fn((_input: unknown) => read.mock.calls.length === 1 ? held : { available: true, tree, order: null, orderError: null });
    const slot = mount(true, { rpc: { projectMode: read } });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    for (let n = 0; n < 5; n++) await slot.behavior.emitRealtime("initiatives-changed", { projectId: "p1" });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 240)); });
    expect(read).toHaveBeenCalledTimes(1);
    // T125: the signals may postdate the held read, so exactly one read follows it.
    await act(async () => { release({ available: true, tree, order: null, orderError: null }); });
    await slot.findByRole("link", { name: "Open Useful search" });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    for (let n = 0; n < 5; n++) await slot.behavior.emitRealtime("initiatives-changed", { projectId: "p1" });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 240)); }); expect(read).toHaveBeenCalledTimes(3);
    await slot.behavior.emitRealtime("initiatives-changed", {}); slot.unmount();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 240)); }); expect(read).toHaveBeenCalledTimes(3);
  });

  it("T125 lists a just-delegated worker when its signal lands during a read that predates it", async () => {
    // The tree before the delegate recorded W1, and after.
    const before = { ...tree, projects: [{ ...tree.projects[0], nodes: tree.projects[0].nodes.filter(n => n.role === "coordinator") }] };
    const answers: ((value: unknown) => void)[] = [];
    const read = vi.fn((_input: unknown) => read.mock.calls.length === 1
      ? { available: true, tree: before, order: null, orderError: null }
      : new Promise(resolve => answers.push(resolve)));
    const slot = mount(true, { rpc: { projectMode: read } });
    await slot.findByRole("link", { name: "Open Useful search" });
    expect(slot.queryByText("W1 Search reviewer")).toBeNull();
    // BB lists the spawned thread first: a read starts before the ledger has W1.
    await slot.behavior.emitRealtime("initiatives-changed", { projectId: "p1" });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    // The delegate's own signal arrives while that read is still in flight.
    await slot.behavior.emitRealtime("initiatives-changed", { projectId: "p1" });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 240)); });
    await act(async () => { answers[0]!({ available: true, tree: before, order: null, orderError: null }); });
    // No reload and no 15 s poll: one more read lists the worker.
    await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    await act(async () => { answers[1]!({ available: true, tree, order: null, orderError: null }); });
    expect(await slot.findByText("W1 Search reviewer")).toBeTruthy();
  });

  it("T129 a tree read that never answers times out instead of freezing the tree until reload", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const before = { ...tree, projects: [{ ...tree.projects[0], nodes: tree.projects[0].nodes.filter(n => n.role === "coordinator") }] };
      const read = vi.fn((_input: unknown) => read.mock.calls.length === 1
        ? { available: true, tree: before, order: null, orderError: null }
        : read.mock.calls.length === 2 ? new Promise(() => {}) : { available: true, tree, order: null, orderError: null });
      const slot = mount(true, { rpc: { projectMode: read } });
      await slot.findByRole("link", { name: "Open Useful search" });
      await slot.behavior.emitRealtime("initiatives-changed", { projectId: "p1" });
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(read).toHaveBeenCalledTimes(2);
      // The change lands while that read hangs: it waits for it, but not forever.
      await slot.behavior.emitRealtime("initiatives-changed", { projectId: "p1" });
      await act(async () => { await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS); });
      await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
      expect(await slot.findByText("W1 Search reviewer")).toBeTruthy();
    } finally { vi.useRealTimers(); }
  });

  it("W196 keeps the tree through one missed read, retries at once, and shows the banner from the second miss", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    resetReports();
    try {
      // Polls during a hung read queue the next one, so three reads hang.
      const read = vi.fn((_input: unknown) => [2, 3, 4].includes(read.mock.calls.length)
        ? new Promise(() => {})
        : { available: true, tree, order: null, orderError: null });
      const reportReadTimeout = vi.fn((_input: unknown) => ({ ok: true }));
      const slot = mount(true, { rpc: { projectMode: read, reportReadTimeout } });
      await slot.findByRole("link", { name: "Open Useful search" });
      await slot.behavior.emitRealtime("initiatives-changed", { projectId: "p1" });
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(read).toHaveBeenCalledTimes(2);
      // The first miss reads again at once and shows nothing.
      await act(async () => { await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS); });
      expect(read).toHaveBeenCalledTimes(3);
      expect(slot.queryByRole("alert")).toBeNull();
      // The second miss in a row shows the banner over the last good tree.
      await act(async () => { await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS); });
      expect((await slot.findByRole("alert")).textContent).toContain(READ_TIMEOUT_MESSAGE);
      expect(slot.getByRole("link", { name: "Open Useful search" })).toBeTruthy();
      // One report per minute per client, with the tab's state.
      expect(reportReadTimeout).toHaveBeenCalledTimes(1);
      expect(reportReadTimeout.mock.calls[0]![0]).toMatchObject({ hidden: false, online: true, sinceVisibleMs: 0, hiddenDuringRead: false });
      expect((reportReadTimeout.mock.calls[0]![0] as { elapsedMs: number }).elapsedMs).toBeGreaterThanOrEqual(READ_TIMEOUT_MS);
      // A later read answers and clears it.
      await act(async () => { await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS + 250); });
      await waitFor(() => expect(slot.queryByRole("alert")).toBeNull());
      expect(read).toHaveBeenCalledTimes(5);
    } finally { vi.useRealTimers(); }
  });

  it("W196 reads at once when the tab becomes visible again or the network returns", async () => {
    let visibility: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    try {
      const read = vi.fn((_input: unknown) => ({ available: true, tree, order: null, orderError: null }));
      const slot = mount(true, { rpc: { projectMode: read } });
      await slot.findByRole("link", { name: "Open Useful search" });
      expect(read).toHaveBeenCalledTimes(1);
      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 240)); });
      expect(read).toHaveBeenCalledTimes(1);
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
      window.dispatchEvent(new Event("online"));
      await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    } finally {
      delete (document as { visibilityState?: unknown }).visibilityState;
    }
  });

  it("T112 keeps the current tree when a refresh answers unchanged", async () => {
    const read = vi.fn((input: { known: string | null } | null) =>
      input?.known === "r1"
        ? { available: true, tree: null, revision: "r1", unchanged: true, order: null, orderError: null }
        : { available: true, tree, revision: "r1", unchanged: false, order: null, orderError: null });
    const slot = mount(true, { rpc: { projectMode: read } });
    const row = await slot.findByRole("link", { name: "Open Useful search" });
    expect(read.mock.calls[0]![0]).toEqual({ known: null });
    await slot.behavior.emitRealtime("initiatives-changed", { projectId: "p1" });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(read.mock.calls[1]![0]).toEqual({ known: "r1" });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    // Same row element: an unchanged answer re-renders nothing.
    expect(slot.getByRole("link", { name: "Open Useful search" })).toBe(row);
  });

  it("T112 switches coordinators in the click's frame while a tree read is pending", async () => {
    let calls = 0;
    const read = vi.fn(() => (++calls === 1
      ? { available: true, tree: richTree, order: null, orderError: null }
      : new Promise(() => {})));
    const slot = mount(true, { rpc: { projectMode: read }, threads: richThreads });
    await slot.findByRole("link", { name: "Open Second push" });
    await slot.behavior.emitRealtime("initiatives-changed", { projectId: "p2" });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    const rpcBefore = slot.inspection.rpcCalls.length;
    fireEvent.click(slot.getByRole("link", { name: "Open Second push" }));
    // Navigation is synchronous with the click, and the click reads nothing.
    expect(slot.inspection.navigateCalls).toContainEqual(expect.objectContaining({ method: "toThread", threadId: "c2" }));
    expect(slot.inspection.rpcCalls.length).toBe(rpcBefore);
    fireEvent.click(slot.getByRole("link", { name: "Open Useful search" }));
    expect(slot.inspection.navigateCalls).toContainEqual(expect.objectContaining({ method: "toThread", threadId: "c" }));
  });

  it("T106: puts the one Advisor entry right above the Initiatives header", async () => {
    const slot = mount(true, { rpc: { advisorEntry: () => ({ available: true, summary: { unseen: 2, reviewing: true, initiatives: 1, threads: 3 } }) } });
    const entry = await slot.findByRole("link", { name: "Advisor, 2 new findings" });
    const header = slot.getAllByText("Initiatives").find((el) => el.tagName === "SPAN")!;
    expect(entry.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(slot.container.querySelectorAll("[data-advisor-entry]")).toHaveLength(1);
  });
  it("renders one colored project row that opens its coordinator", async () => {
    const slot = mount();
    await waitFor(() => expect(slot.getByRole("link", { name: "Open Useful search" })).toBeTruthy());
    expect(
      slot.getByText(/1 needs you · 2 in flight · 3 remaining · 1 to revisit/),
    ).toBeTruthy();
    expect(slot.queryByText("Search reviewer")).toBeNull();
    expect(slot.queryByText("Coordinator")).toBeNull();
    const row = slot.getByRole("link", { name: "Open Useful search" });
    expect(row.getAttribute("data-project-status")).toBe("attention");
    expect(within(row).getByLabelText("Needs you")).toBeTruthy();
    expect(row.querySelector("[data-project-hue]")).toBeTruthy();
    fireEvent.click(row);
    expect(slot.inspection.navigateCalls).toContainEqual(
      expect.objectContaining({ method: "toThread", threadId: "c" }),
    );
  });
  it("keeps modifier clicks browser-owned", async () => {
    const slot = mount();
    await waitFor(() => expect(slot.getByRole("link", { name: "Open Useful search" })).toBeTruthy());
    const row = slot.getByRole("link", { name: "Open Useful search" });
    expect(row.getAttribute("href")).toBe("/projects/project-1/threads/c");
    let prevented = true;
    row.addEventListener("click", (event) => {
      prevented = event.defaultPrevented;
      // jsdom cannot perform the browser-owned navigation under test.
      event.preventDefault();
    });
    fireEvent.click(row, { ctrlKey: true });
    expect(prevented).toBe(false);
    expect(slot.inspection.navigateCalls).toHaveLength(0);
  });
  it("offers a return to Threads when Initiatives is disabled", async () => {
    const slot = mount(false);
    await waitFor(() =>
      expect(
        slot.getByText(/Install or enable the Initiatives plugin/),
      ).toBeTruthy(),
    );
    expect(
      slot.getByRole("button", { name: "Switch to Threads view" }),
    ).toBeTruthy();
  });
  it.each([false, true])(
    "uses whole-sidebar scrolling only in compact mode: %s",
    async (isCompactViewport) => {
      const slot = mount(true, { props: { isCompactViewport } });
      await waitFor(() => expect(slot.getByRole("link", { name: "Open Useful search" })).toBeTruthy());
      const root = slot.container.querySelector("[data-activity-sidebar]")!;
      const styles = root.querySelector("[data-activity-mobile-scroll]");
      expect(root.hasAttribute("data-mobile-scroll")).toBe(isCompactViewport);
      expect(Boolean(styles)).toBe(isCompactViewport);
      if (styles)
        expect(styles.textContent).toContain(
          ":has([data-activity-sidebar][data-mobile-scroll])",
        );
    },
  );
  it("lists the viewed project's current workers below the flat list", async () => {
    const slot = mount(true, {
      treeData: richTree,
      threads: richThreads,
    });
    await waitFor(() =>
      expect(
        slot.getByRole("region", { name: "Threads in Useful search" }),
      ).toBeTruthy(),
    );
    const section = slot.getByRole("region", {
      name: "Threads in Useful search",
    });
    const ids = Array.from(
      section.querySelectorAll("[data-sidebar-thread-id]"),
      (row) => row.getAttribute("data-sidebar-thread-id"),
    );
    // The coordinator, its former generation, settled children, and other
    // projects' threads are absent; a live child nests under its worker.
    expect(ids).toEqual(["w", "run-child"]);
    expect(
      within(section).getByRole("list", {
        name: "Children of Reviewer thread",
      }),
    ).toBeTruthy();
    // Row order stays below the project rows in the same scroll area.
    expect(
      slot.getByRole("link", { name: "Open Useful search" })
        .compareDocumentPosition(section) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
  it("opens a worker through the native thread action and closes the drawer", async () => {
    const onNavigate = vi.fn();
    const slot = mount(true, {
      props: { onNavigate },
      treeData: richTree,
      threads: richThreads,
    });
    const section = await slot.findByRole("region", {
      name: "Threads in Useful search",
    });
    fireEvent.click(
      within(section).getByRole("link", { name: /Reviewer thread/ }),
    );
    expect(slot.inspection.sidebarActionCalls).toContainEqual(
      expect.objectContaining({ method: "open", threadId: "w" }),
    );
    expect(onNavigate).toHaveBeenCalled();
  });
  it("switches the listed threads with the viewed project", async () => {
    const onNavigate = vi.fn();
    const slot = mount(true, {
      props: { activeThreadId: "c", onNavigate },
      treeData: richTree,
      threads: richThreads,
    });
    await waitFor(() =>
      expect(
        slot.getByRole("region", { name: "Threads in Useful search" }),
      ).toBeTruthy(),
    );
    slot.rerender(
      <Component
        activeThreadId="w2"
        activeProjectId="project-2"
        isCompactViewport={false}
        searchQuery=""
        onNavigate={onNavigate}
        Original={() => null}
      />,
    );
    const section = await slot.findByRole("region", {
      name: "Threads in Second push",
    });
    const ids = Array.from(
      section.querySelectorAll("[data-sidebar-thread-id]"),
      (row) => row.getAttribute("data-sidebar-thread-id"),
    );
    // The archived worker node is skipped; nothing from the previous project
    // remains.
    expect(ids).toEqual(["w2"]);
    expect(
      slot.queryByRole("region", { name: "Threads in Useful search" }),
    ).toBeNull();
  });
  it("stays quiet when the selection has no current worker threads", async () => {
    const slot = mount(true, {
      props: { activeThreadId: null, activeProjectId: null },
      treeData: richTree,
      threads: richThreads,
    });
    await waitFor(() => expect(slot.getByRole("link", { name: "Open Useful search" })).toBeTruthy());
    expect(slot.queryByRole("region")).toBeNull();
  });
  it("lays rows out in the saved order, not the tree order", async () => {
    const slot = mount(true, {
      treeData: richTree,
      threads: richThreads,
      order: { revision: 3, order: ["p2", "p1"] },
    });
    await waitFor(() => expect(rowOrder(slot)).toEqual(["p2", "p1"]));
    expect(slot.getByRole("link", { name: "Open Second push" })).toBeTruthy();
  });
  it("appends projects the saved order has not seen", async () => {
    const slot = mount(true, {
      treeData: richTree,
      threads: richThreads,
      order: { revision: 2, order: ["p2"] },
    });
    await waitFor(() => expect(rowOrder(slot)).toEqual(["p2", "p1"]));
  });
  it("keeps the saved order when a refreshed tree arrives reordered", async () => {
    let current: typeof richTree = richTree;
    const doc = { revision: 3, order: ["p2", "p1"] };
    const slot = mount(true, {
      threads: richThreads,
      rpc: {
        projectMode: () => ({ available: true, tree: current, order: doc }),
      },
    });
    await waitFor(() => expect(rowOrder(slot)).toEqual(["p2", "p1"]));
    // A refresh returns the tree in the opposite order; the doc wins.
    current = {
      ...richTree,
      projects: [richTree.projects[1], richTree.projects[0]],
    };
    await slot.setRealtimeConnectionState("reconnecting");
    await slot.setRealtimeConnectionState("connected");
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.filter(
          (call) => call.method === "projectMode",
        ).length,
      ).toBeGreaterThan(1),
    );
    expect(rowOrder(slot)).toEqual(["p2", "p1"]);
  });
  it("reorders by keyboard: Space lifts, arrows move, Space drops", async () => {
    const saves: { expectedRevision: number; order: string[] }[] = [];
    const slot = mount(true, {
      treeData: richTree,
      threads: richThreads,
      order: { revision: 1, order: ["p1", "p2"] },
      saveProjectOrder: (input) => {
        saves.push(input);
        return { revision: input.expectedRevision + 1, order: input.order };
      },
    });
    await waitFor(() => expect(rowOrder(slot)).toEqual(["p1", "p2"]));
    const rowOf = (id: string) =>
      slot.container.querySelector(
        `[data-project-row="${id}"]`,
      ) as HTMLElement;
    // jsdom has no layout; give each row real geometry for collision checks.
    ["p1", "p2"].forEach((id, index) => {
      const top = index * 48;
      rowOf(id).getBoundingClientRect = () =>
        ({
          x: 0,
          y: top,
          top,
          left: 0,
          bottom: top + 48,
          right: 240,
          width: 240,
          height: 48,
          toJSON: () => ({}),
        }) as DOMRect;
    });
    const anchor = within(rowOf("p1")).getByRole("link", {
      name: "Open Useful search",
    });
    anchor.focus();
    fireEvent.keyDown(anchor, { code: "Space" });
    await waitFor(() =>
      expect(rowOf("p1").className).toContain("opacity-50"),
    );
    fireEvent.keyDown(document, { code: "ArrowDown" });
    await waitFor(() =>
      expect(rowOf("p2").hasAttribute("data-drop-target")).toBe(true),
    );
    fireEvent.keyDown(document, { code: "Space" });
    await waitFor(() => expect(rowOrder(slot)).toEqual(["p2", "p1"]));
    expect(saves).toEqual([{ expectedRevision: 1, order: ["p2", "p1"] }]);
    // A keyboard drag suppresses the click it would otherwise trigger.
    fireEvent.click(anchor);
    expect(
      slot.inspection.navigateCalls.filter(
        (call) => call.method === "toThread" && call.threadId === "c",
      ),
    ).toHaveLength(0);
  });
  it("keeps the reordered list and reports when the save fails", async () => {
    const slot = mount(true, {
      treeData: richTree,
      threads: richThreads,
      order: { revision: 1, order: ["p1", "p2"] },
      saveProjectOrder: () => Promise.reject(new Error("kv is down")),
    });
    await waitFor(() => expect(rowOrder(slot)).toEqual(["p1", "p2"]));
    const rowOf = (id: string) =>
      slot.container.querySelector(
        `[data-project-row="${id}"]`,
      ) as HTMLElement;
    ["p1", "p2"].forEach((id, index) => {
      const top = index * 48;
      rowOf(id).getBoundingClientRect = () =>
        ({
          x: 0,
          y: top,
          top,
          left: 0,
          bottom: top + 48,
          right: 240,
          width: 240,
          height: 48,
          toJSON: () => ({}),
        }) as DOMRect;
    });
    const anchor = within(rowOf("p1")).getByRole("link", {
      name: "Open Useful search",
    });
    anchor.focus();
    fireEvent.keyDown(anchor, { code: "Space" });
    await waitFor(() =>
      expect(rowOf("p1").className).toContain("opacity-50"),
    );
    fireEvent.keyDown(document, { code: "ArrowDown" });
    fireEvent.keyDown(document, { code: "Space" });
    await waitFor(() =>
      expect(
        slot.getByText(/Could not save the initiative order: kv is down/),
      ).toBeTruthy(),
    );
    // The optimistic order is kept on screen and stays retryable.
    expect(rowOrder(slot)).toEqual(["p2", "p1"]);
    // The drop's click-suppression window is still open; a real user reaching
    // Dismiss lands outside it.
    await new Promise((resolve) => setTimeout(resolve, 400));
    fireEvent.click(slot.getByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(
        slot.queryByText(/Could not save the project order/),
      ).toBeNull(),
    );
    expect(rowOrder(slot)).toEqual(["p2", "p1"]);
  });
  it("opens row actions on right-click, without a menu button or navigation", async () => {
    const slot = mount(true, {
      treeData: richTree,
      threads: richThreads,
    });
    await waitFor(() =>
      expect(rowAnchor(slot, "Useful search")).toBeTruthy(),
    );
    expect(slot.queryByRole("button", { name: /Reorder/ })).toBeNull();
    const menu = await openContextMenu(slot, "Useful search");
    expect(within(menu).getByRole("menuitem", { name: "Rename…" })).toBeTruthy();
    expect(
      within(menu).getByRole("menuitem", { name: "Initiative overview" }),
    ).toBeTruthy();
    expect(slot.queryByRole("menuitem", { name: /Move/ })).toBeNull();
    // A right click never opens the row's link.
    expect(slot.inspection.navigateCalls).toHaveLength(0);
    expect(
      slot.inspection.rpcCalls.filter((call) => call.method === "saveProjectOrder"),
    ).toHaveLength(0);
  });
  it("opens row actions from the keyboard with the ContextMenu key", async () => {
    const slot = mount(true, {
      treeData: richTree,
      threads: richThreads,
    });
    await waitFor(() =>
      expect(rowAnchor(slot, "Useful search")).toBeTruthy(),
    );
    const anchor = rowAnchor(slot, "Useful search");
    anchor.focus();
    fireEvent.keyDown(anchor, { key: "ContextMenu" });
    expect(
      await slot.findByRole("menu", { name: "Actions for Useful search" }),
    ).toBeTruthy();
  });
  it("opens a project's overview page from the row menu", async () => {
    const onNavigate = vi.fn();
    const slot = mount(true, {
      props: { onNavigate },
      treeData: richTree,
      threads: richThreads,
    });
    const menu = await openContextMenu(slot, "Useful search");
    const item = within(menu).getByRole("menuitem", {
      name: "Initiative overview",
    });
    // A real link to the Initiatives plugin's panel route — the app router owns
    // the navigation; the click also closes a compact drawer.
    expect(item.getAttribute("href")).toBe("/plugins/initiatives/initiatives/p1");
    fireEvent.click(item);
    expect(onNavigate).toHaveBeenCalled();
  });

  it("renames a project through the Projects command RPC", async () => {
    const renamed: { projectId: string; name: string }[] = [];
    const slot = mount(true, {
      treeData: richTree,
      threads: richThreads,
      rpc: {
        renameTreeProject: async (input: { projectId: string; name: string }) => {
          renamed.push(input);
          return {};
        },
      },
    });
    const menu = await openContextMenu(slot, "Useful search");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Rename…" }));
    const form = await slot.findByRole("form", {
      name: "Rename Useful search",
    });
    const input = within(form).getByRole("textbox", {
      name: "Initiative name",
    }) as HTMLInputElement;
    expect(input.value).toBe("Useful search");
    fireEvent.change(input, { target: { value: "Better search" } });
    fireEvent.submit(form);
    await waitFor(() => expect(renamed).toEqual([{ projectId: "p1", name: "Better search" }]));
    await waitFor(() => expect(slot.queryByRole("form")).toBeNull());
    // A fresh read picks up the new name.
    await waitFor(() => expect(
      slot.inspection.rpcCalls.filter((call) => call.method === "projectMode").length,
    ).toBeGreaterThan(1));
  });
  it("shows a chosen icon and color, and falls back to the default look for unknown values", async () => {
    const styled = { ...tree, projects: [{ ...tree.projects[0]!, appearance: { icon: "Bug", color: "teal" } }] };
    const slot = mount(true, { treeData: styled as typeof richTree });
    const row = await slot.findByRole("link", { name: "Open Useful search" });
    expect(row.querySelector("[data-project-icon]")?.getAttribute("data-project-icon")).toBe("Bug");
    expect(row.querySelector("[data-project-hue]")?.getAttribute("data-project-hue")).toBe("7");
    slot.unmount();
    const unknown = { ...tree, projects: [{ ...tree.projects[0]!, appearance: { icon: "Skull", color: "chartreuse" } }] };
    const plain = mount(true, { treeData: unknown as typeof richTree });
    const fallback = await plain.findByRole("link", { name: "Open Useful search" });
    expect(fallback.querySelector("[data-project-icon]")?.getAttribute("data-project-icon")).toBe("Target");
    expect(fallback.querySelector("[data-project-hue]")?.getAttribute("data-project-hue")).toBe(String(projectHueStep("Useful search")));
  });
  it("edits icon and color from the row menu next to Rename, and resets to the default", async () => {
    const calls: unknown[] = [];
    const slot = mount(true, {
      treeData: richTree,
      threads: richThreads,
      rpc: {
        setTreeProjectAppearance: async (input: unknown) => {
          calls.push(input);
          return {};
        },
      },
    });
    const menu = await openContextMenu(slot, "Useful search");
    const items = within(menu).getAllByRole("menuitem").map((item) => item.textContent);
    expect(items.indexOf("Icon and color…")).toBe(items.indexOf("Rename…") + 1);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Icon and color…" }));
    const editor = await slot.findByRole("group", { name: "Icon and color for Useful search" });
    fireEvent.click(within(editor).getByRole("button", { name: "green" }));
    await waitFor(() => expect(calls).toEqual([{ projectId: "p1", color: "green" }]));
    await waitFor(() => expect(within(editor).getByRole("button", { name: "green" }).getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(within(editor).getByRole("button", { name: "Brain" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    fireEvent.click(within(editor).getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(calls.at(-1)).toEqual({ projectId: "p1", icon: null, color: null }));
    fireEvent.click(within(editor).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(slot.queryByRole("group", { name: /Icon and color/ })).toBeNull());
    expect(await slot.findByRole("link", { name: "Open Useful search" })).toBeTruthy();
  });
  it("keeps the editor open and shows the reason when a save is refused", async () => {
    const slot = mount(true, {
      treeData: richTree,
      threads: richThreads,
      rpc: {
        setTreeProjectAppearance: async () => {
          throw new Error("The Initiatives plugin is not running.");
        },
      },
    });
    const menu = await openContextMenu(slot, "Useful search");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Icon and color…" }));
    const editor = await slot.findByRole("group", { name: "Icon and color for Useful search" });
    fireEvent.click(within(editor).getByRole("button", { name: "red" }));
    expect((await within(editor).findByRole("alert")).textContent).toBe("The Initiatives plugin is not running.");
    expect(within(editor).getByRole("button", { name: "red" }).getAttribute("aria-pressed")).toBe("false");
  });
  const expectNativeComposerLink = (
    slot: ReturnType<typeof renderSlot>,
    link: HTMLElement,
    initiativeId: string,
    onNavigate: ReturnType<typeof vi.fn>,
  ) => {
    // UrlLink asks BB to open the same-origin route. toPluginPanel is scoped
    // to Sidebar and would navigate to the wrong plugin.
    expect(link.getAttribute("href")).toBe(
      `/plugins/initiatives/initiatives/${encodeURIComponent(initiativeId)}/compose`,
    );
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledOnce();
    expect(slot.queryByRole("form")).toBeNull();
    expect(slot.queryByRole("textbox", { name: "First message" })).toBeNull();
    expect(slot.inspection.navigateCalls).toEqual([
      {
        method: "openUrl",
        url: `/plugins/initiatives/initiatives/${encodeURIComponent(initiativeId)}/compose`,
      },
    ]);
    expect(
      slot.inspection.rpcCalls.filter((call) =>
        ["createProjectThread", "command"].includes(call.method),
      ),
    ).toEqual([]);
  };
  it.each([false, true])(
    "opens the native composer directly from the menu, compact=%s",
    async (isCompactViewport) => {
      const onNavigate = vi.fn();
      const slot = mount(true, {
        props: { onNavigate, isCompactViewport },
        treeData: richTree,
        threads: richThreads,
      });
      const menu = await openContextMenu(slot, "Useful search");
      expectNativeComposerLink(
        slot,
        within(menu).getByRole("menuitem", { name: "New thread" }),
        "p1",
        onNavigate,
      );
    },
  );
  it("keeps one menu action for multi-member initiatives and lets the native composer choose the repo", async () => {
    const onNavigate = vi.fn();
    const slot = mount(true, {
      props: { onNavigate },
      treeData: {
        ...tree,
        projects: [
          {
            ...tree.projects[0],
            memberProjectIds: ["project-1", "project-2"],
          },
        ],
      },
    });
    const menu = await openContextMenu(slot, "Useful search");
    expect(within(menu).queryByRole("menuitem", { name: "New thread in…" })).toBeNull();
    expectNativeComposerLink(
      slot,
      within(menu).getByRole("menuitem", { name: "New thread" }),
      "p1",
      onNavigate,
    );
  });
  it("encodes the Initiative id as one composer route segment", async () => {
    const onNavigate = vi.fn();
    const initiativeId = "p/with space?#";
    const slot = mount(true, {
      props: { onNavigate },
      treeData: {
        ...tree,
        projects: [{ ...tree.projects[0], id: initiativeId }],
      },
    });
    const link = await slot.findByRole("link", { name: "New thread in Useful search" });
    expect(link.getAttribute("href")).toBe(
      "/plugins/initiatives/initiatives/p%2Fwith%20space%3F%23/compose",
    );
    expectNativeComposerLink(slot, link, initiativeId, onNavigate);
  });
  it.each([false, true])(
    "opens the native composer with one row action, compact=%s",
    async (isCompactViewport) => {
      const onNavigate = vi.fn();
      const slot = mount(true, {
        props: { onNavigate, isCompactViewport },
        treeData: richTree,
        threads: richThreads,
      });
      const link = await slot.findByRole("link", { name: "New thread in Second push" });
      expect(link.className.includes("opacity-0")).toBe(!isCompactViewport);
      expectNativeComposerLink(slot, link, "p2", onNavigate);
      // The sibling action leaves the coordinator link and ordering alone.
      expect(rowAnchor(slot, "Second push").getAttribute("href")).toBe(
        "/projects/project-2/threads/c2",
      );
      expect(rowOrder(slot)).toEqual(["p1", "p2"]);
      expect(slot.inspection.rpcCalls.some((call) => call.method === "saveProjectOrder")).toBe(false);
    },
  );
  it("opens the same composer from the keyboard context menu", async () => {
    const onNavigate = vi.fn();
    const slot = mount(true, { props: { onNavigate } });
    const anchor = await slot.findByRole("link", { name: "Open Useful search" });
    anchor.focus();
    fireEvent.keyDown(anchor, { key: "F10", shiftKey: true });
    const menu = await slot.findByRole("menu", { name: "Actions for Useful search" });
    expectNativeComposerLink(
      slot,
      within(menu).getByRole("menuitem", { name: "New thread" }),
      "p1",
      onNavigate,
    );
  });
  it("lists an adhoc project thread in the selected project section", async () => {
    const slot = mount(true, {
      treeData: {
        ...tree,
        projects: [
          {
            ...tree.projects[0],
            nodes: [
              ...tree.projects[0].nodes,
              {
                threadId: "adhoc-1",
                label: "You",
                role: "adhoc",
                worker: null,
                parentWorker: null,
                state: "active",
                bbProjectId: "project-1",
              },
            ],
          },
        ],
      },
      threads: [
        thread({ id: "c" }),
        thread({ id: "w" }),
        thread({
          id: "adhoc-1",
          title: "Scratch investigation",
          projectId: "project-1",
        }),
      ],
    });
    await waitFor(() =>
      expect(slot.getByText("Scratch investigation")).toBeTruthy(),
    );
  });
  it("opens the native composer from a stationary mobile long press instead of dragging", async () => {
    const onNavigate = vi.fn();
    const slot = mount(true, {
      props: { onNavigate, isCompactViewport: true },
      treeData: richTree,
      threads: richThreads,
      order: { revision: 1, order: ["p1", "p2"] },
    });
    await waitFor(() => expect(rowOrder(slot)).toEqual(["p1", "p2"]));
    const rowOf = (id: string) =>
      slot.container.querySelector(
        `[data-project-row="${id}"]`,
      ) as HTMLElement;
    ["p1", "p2"].forEach((id, index) => {
      const top = index * 48;
      rowOf(id).getBoundingClientRect = () =>
        ({
          x: 0,
          y: top,
          top,
          left: 0,
          bottom: top + 48,
          right: 240,
          width: 240,
          height: 48,
          toJSON: () => ({}),
        }) as DOMRect;
    });
    const anchor = within(rowOf("p1")).getByRole("link", {
      name: "Open Useful search",
    });
    const touch = (x: number, y: number) => ({
      clientX: x,
      clientY: y,
      identifier: 1,
      target: anchor,
    });
    // A real press arms the touch drag sensor and the long-press timer.
    fireEvent.touchStart(anchor, {
      clientX: 20,
      clientY: 10,
      touches: [touch(20, 10)],
    });
    const pointerDown = new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: 10,
    });
    Object.defineProperty(pointerDown, "pointerType", { value: "touch" });
    fireEvent(anchor, pointerDown);
    // Past the 200 ms hold the drag is armed; still without movement.
    await waitFor(
      () => expect(rowOf("p1").className).toContain("opacity-50"),
      { timeout: 2000 },
    );
    // The 450 ms stationary long press then claims the gesture: the hook
    // cancels the armed drag and opens the menu in its place.
    await waitFor(
      () =>
        expect(
          slot.getByRole("menu", { name: "Actions for Useful search" }),
        ).toBeTruthy(),
      { timeout: 2000 },
    );
    await waitFor(() =>
      expect(rowOf("p1").className).not.toContain("opacity-50"),
    );
    fireEvent.touchEnd(anchor, { changedTouches: [touch(20, 10)] });
    // dnd-kit removes its own document listener after 50ms. The row still
    // guards the release, and a menu tap works inside our 350ms drag window.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fireEvent.click(anchor, { detail: 1 })).toBe(false);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(rowOrder(slot)).toEqual(["p1", "p2"]);
    expect(
      slot.inspection.rpcCalls.filter((call) => call.method === "saveProjectOrder"),
    ).toHaveLength(0);
    expectNativeComposerLink(
      slot,
      within(slot.getByRole("menu", { name: "Actions for Useful search" }))
        .getByRole("menuitem", { name: "New thread" }),
      "p1",
      onNavigate,
    );
  });
  it("swallows the release click after a long-press menu opened", async () => {
    const slot = mount(true, {
      treeData: richTree,
      threads: richThreads,
      order: { revision: 1, order: ["p1", "p2"] },
    });
    await waitFor(() => expect(rowOrder(slot)).toEqual(["p1", "p2"]));
    const anchor = await slot.findByRole("link", { name: "Open Useful search" });
    // The finger lands on a descendant; sensors listen on the press target.
    const target = anchor.querySelector("span")!;
    const touch = (x: number, y: number) => ({
      clientX: x,
      clientY: y,
      identifier: 1,
      target,
    });
    fireEvent.touchStart(target, {
      clientX: 20,
      clientY: 10,
      touches: [touch(20, 10)],
    });
    const pointerDown = new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: 10,
    });
    Object.defineProperty(pointerDown, "pointerType", { value: "touch" });
    fireEvent(target, pointerDown);
    await waitFor(
      () =>
        expect(
          slot.getByRole("menu", { name: "Actions for Useful search" }),
        ).toBeTruthy(),
      { timeout: 2000 },
    );
    // The release lands past the 350 ms post-drag window; the row's own
    // suppression must still prevent the native href navigation.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const pointerUp = new MouseEvent("pointerup", {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: 10,
    });
    Object.defineProperty(pointerUp, "pointerType", { value: "touch" });
    fireEvent(target, pointerUp);
    fireEvent.touchEnd(target, { changedTouches: [touch(20, 10)] });
    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      detail: 1,
    });
    // A real release click lands on the deepest element under the finger.
    fireEvent(anchor.querySelector("span")!, click);
    expect(click.defaultPrevented).toBe(true);
    expect(slot.inspection.navigateCalls).toHaveLength(0);
    expect(
      slot.inspection.rpcCalls.filter((call) => call.method === "saveProjectOrder"),
    ).toHaveLength(0);
  });
  it("adopts a foreign client's order from realtime and ignores stale docs", async () => {
    const slot = mount(true, {
      treeData: richTree,
      threads: richThreads,
      order: { revision: 1, order: ["p1", "p2"] },
    });
    await waitFor(() => expect(rowOrder(slot)).toEqual(["p1", "p2"]));
    await slot.emitRealtime(PROJECT_ORDER_CHANNEL, {
      revision: 2,
      order: ["p2", "p1"],
    });
    expect(rowOrder(slot)).toEqual(["p2", "p1"]);
    await slot.emitRealtime(PROJECT_ORDER_CHANNEL, {
      revision: 1,
      order: ["p1", "p2"],
    });
    expect(rowOrder(slot)).toEqual(["p2", "p1"]);
  });
  it("refreshes logical worker labels on the Projects change signal", async () => {
    let calls = 0;
    let treeData = richTree;
    const slot = mount(true, {
      threads: richThreads,
      rpc: {
        projectMode: () => {
          calls += 1;
          return {
            available: true,
            tree: treeData,
            order: null,
            orderError: null,
          };
        },
      },
    });
    await waitFor(() => expect(calls).toBe(1));
    expect(await slot.findByText("W1 Search reviewer")).toBeTruthy();
    treeData = {
      ...richTree,
      projects: richTree.projects.map((project) => ({
        ...project,
        nodes: project.nodes.map((node) =>
          node.threadId === "w" ? { ...node, label: "Queue reviewer" } : node,
        ),
      })),
    };
    // The republished signal refreshes immediately, without polling timers.
    await slot.emitRealtime("initiatives-changed", {});
    await waitFor(() => expect(calls).toBeGreaterThan(1));
    await waitFor(() => expect(slot.getByText("W1 Queue reviewer")).toBeTruthy());
    expect(slot.queryByText("W1 Search reviewer")).toBeNull();
  });
  it("reorders by dragging a row and does not navigate on drop", async () => {
    const saves: { expectedRevision: number; order: string[] }[] = [];
    const slot = mount(true, {
      treeData: richTree,
      threads: richThreads,
      order: { revision: 1, order: ["p1", "p2"] },
      saveProjectOrder: (input) => {
        saves.push(input);
        return { revision: input.expectedRevision + 1, order: input.order };
      },
    });
    await waitFor(() => expect(rowOrder(slot)).toEqual(["p1", "p2"]));
    const rowOf = (id: string) =>
      slot.container.querySelector(
        `[data-project-row="${id}"]`,
      ) as HTMLElement;
    // jsdom has no layout; give each row real geometry for collision checks.
    ["p1", "p2"].forEach((id, index) => {
      const top = index * 48;
      rowOf(id).getBoundingClientRect = () =>
        ({
          x: 0,
          y: top,
          top,
          left: 0,
          bottom: top + 48,
          right: 240,
          width: 240,
          height: 48,
          toJSON: () => ({}),
        }) as DOMRect;
    });
    const anchor = within(rowOf("p1")).getByRole("link", {
      name: "Open Useful search",
    });
    fireEvent.mouseDown(anchor, { clientX: 20, clientY: 10 });
    fireEvent.mouseMove(document.body, { clientX: 20, clientY: 20 });
    await waitFor(() =>
      expect(rowOf("p1").className).toContain("opacity-50"),
    );
    fireEvent.mouseMove(document.body, { clientX: 20, clientY: 60 });
    await waitFor(() =>
      expect(rowOf("p2").hasAttribute("data-drop-target")).toBe(true),
    );
    fireEvent.mouseUp(document.body);
    await waitFor(() => expect(rowOrder(slot)).toEqual(["p2", "p1"]));
    expect(saves).toEqual([{ expectedRevision: 1, order: ["p2", "p1"] }]);
    // The release click that follows a drag must not open the coordinator.
    fireEvent.click(anchor);
    expect(
      slot.inspection.navigateCalls.filter(
        (call) => call.method === "toThread" && call.threadId === "c",
      ),
    ).toHaveLength(0);
  });
  it("reorders by touch drag after a hold", async () => {
    const saves: { expectedRevision: number; order: string[] }[] = [];
    const slot = mount(true, {
      treeData: richTree,
      threads: richThreads,
      order: { revision: 1, order: ["p1", "p2"] },
      saveProjectOrder: (input) => {
        saves.push(input);
        return { revision: input.expectedRevision + 1, order: input.order };
      },
    });
    await waitFor(() => expect(rowOrder(slot)).toEqual(["p1", "p2"]));
    const rowOf = (id: string) =>
      slot.container.querySelector(
        `[data-project-row="${id}"]`,
      ) as HTMLElement;
    ["p1", "p2"].forEach((id, index) => {
      const top = index * 48;
      rowOf(id).getBoundingClientRect = () =>
        ({
          x: 0,
          y: top,
          top,
          left: 0,
          bottom: top + 48,
          right: 240,
          width: 240,
          height: 48,
          toJSON: () => ({}),
        }) as DOMRect;
    });
    const anchor = within(rowOf("p1")).getByRole("link", {
      name: "Open Useful search",
    });
    // jsdom has no TouchEvent class, so dnd-kit reads coordinates from the
    // event itself; keep `touches` populated for the sensor's activator.
    const touch = (x: number, y: number) => ({
      clientX: x,
      clientY: y,
      identifier: 1,
      target: anchor,
    });
    fireEvent.touchStart(anchor, {
      clientX: 20,
      clientY: 10,
      touches: [touch(20, 10)],
    });
    // The TouchSensor hold: a flick scrolls instead, a held finger drags.
    await new Promise((resolve) => setTimeout(resolve, 250));
    // Touch events keep targeting the element the touch started on, which is
    // where dnd-kit's TouchSensor listens — dispatch on the anchor.
    fireEvent.touchMove(anchor, {
      clientX: 20,
      clientY: 30,
      touches: [touch(20, 30)],
    });
    await waitFor(() =>
      expect(rowOf("p1").className).toContain("opacity-50"),
    );
    fireEvent.touchMove(anchor, {
      clientX: 20,
      clientY: 60,
      touches: [touch(20, 60)],
    });
    await waitFor(() =>
      expect(rowOf("p2").hasAttribute("data-drop-target")).toBe(true),
    );
    fireEvent.touchEnd(anchor, {
      changedTouches: [touch(20, 60)],
    });
    await waitFor(() => expect(rowOrder(slot)).toEqual(["p2", "p1"]));
    expect(saves).toEqual([{ expectedRevision: 1, order: ["p2", "p1"] }]);
    // A real drop ends in a release click on the row — suppressed, so no
    // navigation, and the flag is consumed for whatever gesture comes next.
    const releaseClick = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      detail: 1,
    });
    fireEvent(anchor, releaseClick);
    expect(releaseClick.defaultPrevented).toBe(true);
    expect(slot.inspection.navigateCalls).toHaveLength(0);
    // dnd-kit removes its document-level click blocker 50ms after detach;
    // let that settle so it cannot swallow the next test's click.
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
  it("still navigates on a plain click when reordering is enabled", async () => {
    const slot = mount(true, {
      treeData: richTree,
      threads: richThreads,
      order: { revision: 1, order: ["p1", "p2"] },
    });
    const row = await slot.findByRole("link", { name: "Open Useful search" });
    fireEvent.click(row);
    expect(slot.inspection.navigateCalls).toContainEqual(
      expect.objectContaining({ method: "toThread", threadId: "c" }),
    );
  });
});
