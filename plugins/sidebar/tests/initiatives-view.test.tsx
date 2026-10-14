// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import { parseState, updateState } from "../lib/client-state";
import { cacheTree } from "../lib/initiative-tree-cache";
import { CREATE_TIMEOUT_MS, reloadSubmissions } from "../lib/initiative-submissions";
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
  it("shows Initiatives, then every other thread ungrouped and most recent first", async () => {
    const slot = mount();
    await slot.findByRole("link", { name: "Open Useful search" });
    await waitFor(() => expect(listed(slot)).toEqual(["b-new", "a-mid", "a-old"]));
    expect(sectionTitles(slot)).toEqual(["Initiatives", "Threads"]);
    expect(slot.container.querySelector("[data-group-header]")).toBeNull();
    expect(slot.getByRole("button", { name: "Thread list options" })).toBeTruthy();
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

  it("groups by project under a Projects header", async () => {
    const slot = mount();
    await waitFor(() => expect(listed(slot)).toHaveLength(3));
    await choose(slot, /Grouping/, "Project");
    expect(sectionTitles(slot)).toEqual(["Initiatives", "Projects"]);
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

describe("New initiative", () => {
  const fill = async (slot: ReturnType<typeof renderSlot>) => {
    fireEvent.click(await slot.findByRole("button", { name: "New initiative" }));
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
    fireEvent.click(within(dialog).getByRole("button", { name: "Create initiative" }));
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

  it("keeps a failed draft with its reason and resends it under the same key", async () => {
    const createInitiative = vi
      .fn()
      .mockRejectedValueOnce(new Error("BB project project-1 does not exist."))
      .mockResolvedValueOnce({ write: "done", projectId: "p9", coordinatorThreadId: null, note: "Checkout pending." });
    const slot = mount({ createInitiative });
    const dialog = await fill(slot);
    fireEvent.click(within(dialog).getByRole("button", { name: "Create initiative" }));
    await settle();
    const failed = slot.container.querySelector('[data-initiative-submission="failed"]') as HTMLElement;
    expect(within(failed).getByRole("alert").textContent).toBe("BB project project-1 does not exist.");
    fireEvent.click(within(failed).getByRole("button", { name: "Edit" }));
    const again = await slot.findByRole("dialog");
    expect((within(again).getByLabelText("Name") as HTMLInputElement).value).toBe("Faster builds");
    fireEvent.click(within(again).getByRole("button", { name: "Create initiative" }));
    await settle();
    const [first, second] = createInitiative.mock.calls.map(([input]) => input.key);
    expect(second).toBe(first);
    // No coordinator yet: nothing navigates, and the note says why.
    expect(slot.inspection.navigateCalls).toEqual([]);
    expect(slot.getByText(/Checkout pending\./)).toBeTruthy();
  });

  it("needs a name, an objective and a repository", async () => {
    const slot = mount({}, { activeProjectId: "personal", activeThreadId: null });
    fireEvent.click(await slot.findByRole("button", { name: "New initiative" }));
    const dialog = await slot.findByRole("dialog");
    const create = within(dialog).getByRole("button", { name: "Create initiative" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "N" } });
    fireEvent.change(within(dialog).getByLabelText("What should it achieve?"), { target: { value: "O" } });
    // A personal project cannot host an Initiative, so nothing is preselected.
    expect(create.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Beta/ }));
    expect(create.disabled).toBe(false);
    expect(within(dialog).getByText("Coordinator")).toBeTruthy();
  });
});

describe("W447 review fixes", () => {
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
  const fill = async (slot: ReturnType<typeof renderSlot>) => {
    fireEvent.click(await slot.findByRole("button", { name: "New initiative" }));
    const dialog = await slot.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Faster builds" } });
    fireEvent.change(within(dialog).getByLabelText("What should it achieve?"), {
      target: { value: "Halve CI time" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create initiative" }));
    await settle();
  };
  const submission = (slot: ReturnType<typeof renderSlot>) =>
    slot.container.querySelector("[data-initiative-submission]") as HTMLElement | null;
  const resend = async (slot: ReturnType<typeof renderSlot>) => {
    fireEvent.click(within(submission(slot)!).getByRole("button", { name: "Edit" }));
    const dialog = await slot.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create initiative" }));
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

  it("finding 2: keeps Initiative threads and their descendants out of Archived", async () => {
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
    fireEvent.click(await slot.findByRole("button", { name: "New initiative" }));
    const dialog = await slot.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Faster builds" } });
    fireEvent.change(within(dialog).getByLabelText("What should it achieve?"), {
      target: { value: "Halve CI time" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create initiative" }));
    await settle();
  };
  const rows = (slot: ReturnType<typeof renderSlot>) =>
    Array.from(slot.container.querySelectorAll<HTMLElement>("[data-initiative-submission]"));
  const edit = async (slot: ReturnType<typeof renderSlot>) => {
    fireEvent.click(within(rows(slot)[0]!).getByRole("button", { name: "Edit" }));
    return slot.findByRole("dialog");
  };
  const resend = async (slot: ReturnType<typeof renderSlot>) => {
    fireEvent.click(within(await edit(slot)).getByRole("button", { name: "Create initiative" }));
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
    // The browser stays closed for nine days: Initiatives no longer holds
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
      fireEvent.click(within(dialog).getByRole("button", { name: "Create initiative" }));
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
