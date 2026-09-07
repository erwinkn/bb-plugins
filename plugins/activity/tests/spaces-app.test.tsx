// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { parseState, updateState } from "../lib/client-state";
import type { Space, SpaceCatalog } from "../lib/space-schema";
import { thread } from "./fixtures";

const app = await loadPluginApp(() => import("../app"));
const localStorage = window.localStorage;
const CACHE_KEY = "bb-plugin-erwin-activity:spaces-cache";

const projects = [
  { id: "project-1", name: "One", isPersonal: false },
  { id: "project-2", name: "Two", isPersonal: false },
  { id: "project-3", name: "Three", isPersonal: false },
];
const threads = [
  thread({ id: "p1-root", title: "Pinned one", isPinned: true }),
  thread({
    id: "p2-child-of-p1",
    title: "Two child of pinned",
    parentThreadId: "p1-root",
    projectId: "project-2",
  }),
  thread({ id: "p2-root", title: "Two root", projectId: "project-2" }),
  thread({
    id: "p1-child-of-p2",
    title: "One child of two",
    parentThreadId: "p2-root",
  }),
];
const one: Space = { id: "one", name: "Only One", projectIds: ["project-1"] };
const both: Space = {
  id: "both",
  name: "Both",
  projectIds: ["project-1", "project-2"],
};
const initial: SpaceCatalog = { revision: 1, spaces: [one, both] };

const tick = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
const props = {
  activeThreadId: "p2-root",
  activeProjectId: "project-2",
  isCompactViewport: false,
  searchQuery: "",
  onNavigate: vi.fn(),
  Original: () => <p>BB fallback</p>,
};
// A fake server: the save handler echoes the document with a bumped revision.
function server(start: SpaceCatalog = initial) {
  let catalog = start;
  const saveSpaces = vi.fn(async (input: unknown) => {
    const { expectedRevision, spaces } = input as {
      expectedRevision: number;
      spaces: Space[];
    };
    if (expectedRevision !== catalog.revision)
      throw new Error("Spaces changed on another client. Reload and retry.");
    catalog = { revision: catalog.revision + 1, spaces };
    return catalog;
  });
  return {
    getSpaces: async () => catalog,
    saveSpaces,
    listArchived: async () => [],
  };
}
const mounted: ReturnType<typeof renderSlot>[] = [];
type Rpc = NonNullable<Parameters<typeof renderSlot>[2]>["rpc"];
const mount = (rpc: Rpc = server(), overrides: Partial<typeof props> = {}) => {
  const slot = renderSlot(
    app.threadLists[0],
    { ...props, ...overrides },
    { sidebarThreads: { threads, projects }, rpc },
  );
  mounted.push(slot);
  return slot;
};
const scopeButton = (slot: ReturnType<typeof renderSlot>) =>
  slot.getByRole("button", { name: /^Threads: /, hidden: true });
async function openScope(slot: ReturnType<typeof renderSlot>) {
  fireEvent.keyDown(scopeButton(slot), { key: "Enter" });
  await tick();
}
const rows = (slot: ReturnType<typeof renderSlot>) =>
  Array.from(slot.container.querySelectorAll("[data-thread-node]")).map(
    (node) => node.getAttribute("data-thread-node"),
  );

beforeEach(() => {
  localStorage.clear();
  updateState(() => parseState(null));
  vi.clearAllMocks();
});
afterEach(async () => {
  for (const slot of mounted.splice(0)) slot.lifecycle.unmount();
  cleanup();
  await tick();
});

describe("spaces", () => {
  it("filters by the selected space before pins and families, and flags an outside thread", async () => {
    const slot = mount();
    await waitFor(() =>
      expect(slot.inspection.rpcCalls.map((c) => c.method)).toContain(
        "getSpaces",
      ),
    );
    await tick();
    expect(rows(slot)).toEqual(
      expect.arrayContaining(["p1-root", "p2-child-of-p1", "p2-root"]),
    );

    await openScope(slot);
    fireEvent.click(
      slot.getByRole("menuitemradio", { name: "Only One", hidden: true }),
    );
    await tick();
    expect(scopeButton(slot).getAttribute("aria-label")).toBe(
      "Threads: Only One",
    );
    // The pinned parent stays, its outside child is gone, and the inside child
    // of an outside parent is a root.
    expect(rows(slot)).toEqual(["p1-root", "p1-child-of-p2"]);
    expect(slot.getByRole("status").textContent).toContain(
      "outside this scope",
    );
    expect(
      parseState(localStorage.getItem("bb-plugin-erwin-activity:v1")),
    ).toMatchObject({
      spaceId: "one",
      projectIds: [],
    });

    fireEvent.click(slot.getByRole("button", { name: "Show all projects" }));
    expect(scopeButton(slot).getAttribute("aria-label")).toBe(
      "Threads: All projects",
    );
    expect(slot.queryByRole("status")).toBeNull();
    expect(rows(slot)).toHaveLength(4);
  });

  it("creates a space from All projects seeded with the current thread's project", async () => {
    const rpc = server();
    const slot = mount(rpc);
    await tick();
    await openScope(slot);
    fireEvent.click(
      slot.getByRole("menuitem", { name: "New space…", hidden: true }),
    );
    await tick();
    const form = slot.getByRole("form", { name: "New space" });
    expect(form.textContent).toContain(
      "Starts with Two. Add projects from the menu.",
    );
    fireEvent.change(slot.getByRole("textbox", { name: "Space name" }), {
      target: { value: "Fresh" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(rpc.saveSpaces).toHaveBeenCalledTimes(1));
    expect(rpc.saveSpaces.mock.calls[0][0]).toMatchObject({
      spaces: [one, both, { name: "Fresh", projectIds: ["project-2"] }],
    });
    await waitFor(() =>
      expect(scopeButton(slot).getAttribute("aria-label")).toBe(
        "Threads: Fresh",
      ),
    );
    expect(rows(slot)).toEqual(["p2-child-of-p1", "p2-root"]);
  });

  it("creates an empty space without a current thread and explains the next step", async () => {
    const rpc = server();
    const slot = mount(rpc, { activeThreadId: "", activeProjectId: "" });
    await tick();
    await openScope(slot);
    // Also available while a space is selected.
    fireEvent.click(
      slot.getByRole("menuitemradio", { name: "Both", hidden: true }),
    );
    await tick();
    await openScope(slot);
    fireEvent.click(
      slot.getByRole("menuitem", { name: "New space…", hidden: true }),
    );
    await tick();
    const form = slot.getByRole("form", { name: "New space" });
    expect(form.textContent).toContain(
      "Add projects from the menu after creating it.",
    );
    fireEvent.change(slot.getByRole("textbox", { name: "Space name" }), {
      target: { value: "Blank" },
    });
    fireEvent.submit(form);
    await waitFor(() => expect(rpc.saveSpaces).toHaveBeenCalledTimes(1));
    expect(rpc.saveSpaces.mock.calls[0][0]).toMatchObject({
      spaces: [one, both, { name: "Blank", projectIds: [] }],
    });
    await waitFor(() =>
      expect(scopeButton(slot).getAttribute("aria-label")).toBe(
        "Threads: Blank",
      ),
    );
    expect(rows(slot)).toEqual([]);
    expect(slot.container.textContent).toContain(
      "No projects in this space. Choose projects from the heading menu.",
    );
    // Checking a project from the menu adds it to the new space.
    await openScope(slot);
    fireEvent.click(
      slot.getByRole("menuitemcheckbox", { name: "One", hidden: true }),
    );
    await waitFor(() => expect(rpc.saveSpaces).toHaveBeenCalledTimes(2));
    expect(rpc.saveSpaces.mock.calls[1][0]).toMatchObject({
      spaces: [one, both, { name: "Blank", projectIds: ["project-1"] }],
    });
  });

  it("starts an ad-hoc selection from All projects and saves it as a space", async () => {
    const rpc = server();
    const slot = mount(rpc);
    await tick();
    await openScope(slot);
    const two = slot.getByRole("menuitemcheckbox", {
      name: "Two",
      hidden: true,
    });
    expect(two.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(two);
    await tick();
    expect(scopeButton(slot).getAttribute("aria-label")).toBe(
      "Threads: 2 projects",
    );
    expect(rows(slot)).toEqual(["p1-root", "p1-child-of-p2"]);
    // Unchecking the last project returns to All projects rather than an empty view.
    fireEvent.click(
      slot.getByRole("menuitemcheckbox", { name: "One", hidden: true }),
    );
    fireEvent.click(
      slot.getByRole("menuitemcheckbox", { name: "Three", hidden: true }),
    );
    await tick();
    expect(scopeButton(slot).getAttribute("aria-label")).toBe(
      "Threads: All projects",
    );
    fireEvent.click(
      slot.getByRole("menuitemcheckbox", { name: "Two", hidden: true }),
    );
    await tick();

    fireEvent.click(
      slot.getByRole("menuitem", { name: "New space…", hidden: true }),
    );
    await tick();
    const form = slot.getByRole("form", { name: "New space" });
    expect(form.textContent).toContain("Starts with the 2 selected projects.");
    await waitFor(() =>
      expect(document.activeElement).toBe(
        slot.getByRole("textbox", { name: "Space name" }),
      ),
    );
    fireEvent.change(slot.getByRole("textbox", { name: "Space name" }), {
      target: { value: "  Mine " },
    });
    fireEvent.submit(form);
    await waitFor(() => expect(rpc.saveSpaces).toHaveBeenCalledTimes(1));
    expect(rpc.saveSpaces.mock.calls[0][0]).toMatchObject({
      expectedRevision: 1,
      spaces: [
        one,
        both,
        { name: "Mine", projectIds: ["project-1", "project-3"] },
      ],
    });
    await waitFor(() =>
      expect(scopeButton(slot).getAttribute("aria-label")).toBe(
        "Threads: Mine",
      ),
    );
    expect(slot.queryByRole("form")).toBeNull();
    expect(JSON.parse(localStorage.getItem(CACHE_KEY)!)).toMatchObject({
      revision: 2,
    });
  });

  it("edits the selected space's membership, renames it, and deletes it", async () => {
    updateState((state) => ({ ...state, spaceId: "one" }));
    const rpc = server();
    const slot = mount(rpc);
    await waitFor(() =>
      expect(scopeButton(slot).getAttribute("aria-label")).toBe(
        "Threads: Only One",
      ),
    );

    await openScope(slot);
    fireEvent.click(
      slot.getByRole("menuitemcheckbox", { name: "Two", hidden: true }),
    );
    await waitFor(() => expect(rpc.saveSpaces).toHaveBeenCalledTimes(1));
    expect(rpc.saveSpaces.mock.calls[0][0]).toEqual({
      expectedRevision: 1,
      spaces: [{ ...one, projectIds: ["project-1", "project-2"] }, both],
    });
    await waitFor(() => expect(rows(slot)).toHaveLength(4));
    expect(scopeButton(slot).getAttribute("aria-label")).toBe(
      "Threads: Only One",
    );

    fireEvent.click(
      slot.getByRole("menuitem", { name: "Rename space…", hidden: true }),
    );
    await tick();
    const input = slot.getByRole("textbox", {
      name: "Space name",
    }) as HTMLInputElement;
    expect(input.value).toBe("Only One");
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.submit(slot.getByRole("form", { name: "Rename space" }));
    await waitFor(() =>
      expect(scopeButton(slot).getAttribute("aria-label")).toBe(
        "Threads: Renamed",
      ),
    );
    expect(rpc.saveSpaces.mock.calls[1][0]).toMatchObject({
      expectedRevision: 2,
    });

    await openScope(slot);
    fireEvent.click(
      slot.getByRole("menuitem", { name: "Delete space…", hidden: true }),
    );
    await tick();
    const confirm = slot.getByRole("form", { name: "Delete space" });
    expect(confirm.textContent).toContain("Delete space “Renamed”?");
    fireEvent.click(slot.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(scopeButton(slot).getAttribute("aria-label")).toBe(
        "Threads: All projects",
      ),
    );
    expect(rpc.saveSpaces.mock.calls[2][0]).toEqual({
      expectedRevision: 3,
      spaces: [both],
    });
    expect(
      parseState(localStorage.getItem("bb-plugin-erwin-activity:v1")).spaceId,
    ).toBeNull();
  });

  it("cancels edits with Escape and shows a save error in the form", async () => {
    updateState((state) => ({ ...state, spaceId: "one" }));
    const rpc = server();
    rpc.saveSpaces.mockRejectedValueOnce(
      new Error('A space named "Both" already exists.'),
    );
    const slot = mount(rpc);
    await waitFor(() =>
      expect(scopeButton(slot).getAttribute("aria-label")).toBe(
        "Threads: Only One",
      ),
    );
    await openScope(slot);
    fireEvent.click(
      slot.getByRole("menuitem", { name: "Rename space…", hidden: true }),
    );
    await tick();
    fireEvent.change(slot.getByRole("textbox", { name: "Space name" }), {
      target: { value: "Both" },
    });
    fireEvent.submit(slot.getByRole("form", { name: "Rename space" }));
    await waitFor(() =>
      expect(slot.getByRole("alert").textContent).toBe(
        'A space named "Both" already exists.',
      ),
    );
    // A failed save reloads the catalog in case another client changed it.
    expect(
      slot.inspection.rpcCalls.filter((c) => c.method === "getSpaces").length,
    ).toBeGreaterThanOrEqual(2);
    fireEvent.keyDown(slot.getByRole("textbox", { name: "Space name" }), {
      key: "Escape",
    });
    expect(slot.queryByRole("form")).toBeNull();
    expect(scopeButton(slot).getAttribute("aria-label")).toBe(
      "Threads: Only One",
    );
  });

  it("applies realtime catalog updates and reports a deleted space", async () => {
    updateState((state) => ({ ...state, spaceId: "one" }));
    const slot = mount();
    await waitFor(() =>
      expect(scopeButton(slot).getAttribute("aria-label")).toBe(
        "Threads: Only One",
      ),
    );
    await slot.behavior.emitRealtime("spaces-changed", {
      revision: 2,
      spaces: [{ ...one, name: "Renamed elsewhere" }],
    });
    expect(scopeButton(slot).getAttribute("aria-label")).toBe(
      "Threads: Renamed elsewhere",
    );
    await slot.behavior.emitRealtime("spaces-changed", {
      revision: 3,
      spaces: [],
    });
    expect(scopeButton(slot).getAttribute("aria-label")).toBe(
      "Threads: All projects",
    );
    expect(slot.getByRole("status").textContent).toContain("no longer exists");
    expect(rows(slot)).toHaveLength(4);
    fireEvent.click(slot.getByRole("button", { name: "Dismiss" }));
    expect(slot.queryByRole("status")).toBeNull();
    // Garbage payloads are ignored.
    await slot.behavior.emitRealtime("spaces-changed", { nope: true });
    expect(JSON.parse(localStorage.getItem(CACHE_KEY)!)).toEqual({
      revision: 3,
      spaces: [],
    });
  });

  it("keeps New thread inside the scope", async () => {
    updateState((state) => ({ ...state, spaceId: "one" }));
    const slot = mount(server(), { activeProjectId: "project-2" });
    await waitFor(() =>
      expect(scopeButton(slot).getAttribute("aria-label")).toBe(
        "Threads: Only One",
      ),
    );
    fireEvent.click(slot.getByRole("button", { name: "New thread" }));
    expect(slot.inspection.sidebarActionCalls).toEqual([
      {
        method: "openNewThread",
        options: { projectId: "project-1", focusPrompt: true },
      },
    ]);
    slot.lifecycle.unmount();

    updateState((state) => ({ ...state, spaceId: "both" }));
    const picker = mount(server(), { activeProjectId: "project-3" });
    await waitFor(() =>
      expect(scopeButton(picker).getAttribute("aria-label")).toBe(
        "Threads: Both",
      ),
    );
    fireEvent.keyDown(picker.getByRole("button", { name: "New thread" }), {
      key: "Enter",
    });
    await tick();
    expect(
      picker
        .getAllByRole("menuitem", { hidden: true })
        .map((item) => item.textContent),
    ).toEqual(["One", "Two"]);
    fireEvent.click(
      picker.getByRole("menuitem", { name: "Two", hidden: true }),
    );
    expect(picker.inspection.sidebarActionCalls).toEqual([
      {
        method: "openNewThread",
        options: { projectId: "project-2", focusPrompt: true },
      },
    ]);
    picker.lifecycle.unmount();

    // The active project wins when it belongs to the scope.
    const active = mount(server(), { activeProjectId: "project-1" });
    await waitFor(() =>
      expect(scopeButton(active).getAttribute("aria-label")).toBe(
        "Threads: Both",
      ),
    );
    fireEvent.click(active.getByRole("button", { name: "New thread" }));
    expect(active.inspection.sidebarActionCalls).toEqual([
      {
        method: "openNewThread",
        options: { projectId: "project-1", focusPrompt: true },
      },
    ]);
  });

  it("waits for the catalog, uses the cache, and falls back to All projects on failure", async () => {
    updateState((state) => ({ ...state, spaceId: "one" }));
    let resolve!: (catalog: SpaceCatalog) => void;
    const pending = mount({
      ...server(),
      getSpaces: () => new Promise<SpaceCatalog>((r) => (resolve = r)),
    });
    expect(pending.getByRole("status").textContent).toBe("Loading spaces…");
    expect(rows(pending)).toHaveLength(0);
    await act(async () => resolve(initial));
    expect(rows(pending)).toEqual(["p1-root", "p1-child-of-p2"]);
    pending.lifecycle.unmount();

    // The cache written above renders before the server answers.
    const cached = mount({
      ...server(),
      getSpaces: () => new Promise<SpaceCatalog>(() => {}),
    });
    expect(cached.queryByText("Loading spaces…")).toBeNull();
    expect(rows(cached)).toEqual(["p1-root", "p1-child-of-p2"]);
    cached.lifecycle.unmount();

    localStorage.removeItem(CACHE_KEY);
    const failed = mount({
      ...server(),
      getSpaces: async () => {
        throw new Error("offline");
      },
    });
    await waitFor(() =>
      expect(failed.getByRole("alert").textContent).toContain(
        "Cannot load spaces",
      ),
    );
    expect(rows(failed)).toHaveLength(4);
    expect(scopeButton(failed).getAttribute("aria-label")).toBe(
      "Threads: All projects",
    );
    expect(failed.queryByText(/no longer exists/)).toBeNull();
  });

  it("scopes archives, drafts, and the project view", async () => {
    updateState((state) => ({
      ...state,
      spaceId: "one",
      showArchives: true,
      groupBy: "project",
      drafts: ["new:project-2", "new:project-1"],
      expandedArchives: [
        "archive:project:project-1",
        "archive:project:project-2",
      ],
    }));
    const slot = mount({
      ...server(),
      listArchived: async () => [
        {
          id: "arch-1",
          projectId: "project-1",
          title: "Archived one",
          titleFallback: null,
          parentThreadId: null,
          providerId: "codex",
          createdAt: 1,
          updatedAt: 1,
          environmentId: null,
          environmentName: null,
          environmentBranchName: null,
          environmentWorkspaceDisplayKind: "other",
        },
        {
          id: "arch-2",
          projectId: "project-2",
          title: "Archived two",
          titleFallback: null,
          parentThreadId: null,
          providerId: "codex",
          createdAt: 1,
          updatedAt: 1,
          environmentId: null,
          environmentName: null,
          environmentBranchName: null,
          environmentWorkspaceDisplayKind: "other",
        },
      ],
    });
    await waitFor(() =>
      expect(scopeButton(slot).getAttribute("aria-label")).toBe(
        "Threads: Only One",
      ),
    );
    await waitFor(() => expect(slot.getByText("Archived one")).toBeTruthy());
    expect(slot.queryByText("Archived two")).toBeNull();
    expect(slot.getAllByText("New thread draft")).toHaveLength(1);
    expect(slot.getByRole("region", { name: "One" })).toBeTruthy();
    expect(slot.queryByRole("region", { name: "Two" })).toBeNull();
    expect(slot.queryByRole("region", { name: "Three" })).toBeNull();
  });
});
