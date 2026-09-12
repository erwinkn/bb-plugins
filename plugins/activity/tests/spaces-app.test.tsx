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
const managed = (
  id: string,
  name: string,
  path: string,
  hostId = "host-1",
) => ({
  id,
  name,
  isPersonal: false,
  source: { id: `src-${id}`, hostId, path },
});
const inventory = {
  projects: [
    managed("project-1", "One", "/code/one"),
    managed("project-2", "Two", "/code/two"),
    managed("project-3", "Three", "/code/three"),
  ],
  hosts: [{ id: "host-1", name: "MacBook", connected: true }],
};
// A fake server: the save handler echoes the document with a bumped revision.
function server(start: SpaceCatalog = initial, projectsStart = inventory) {
  let catalog = start;
  let projectList = projectsStart;
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
  const createProject = vi.fn(async (input: unknown) => {
    const { name, hostId, path } = input as {
      name: string;
      hostId: string;
      path: string;
    };
    const created = managed("project-new", name, path, hostId);
    projectList = {
      ...projectList,
      projects: [...projectList.projects, created],
    };
    return created;
  });
  const renameProject = vi.fn(async (input: unknown) => {
    const { projectId, name } = input as { projectId: string; name: string };
    projectList = {
      ...projectList,
      projects: projectList.projects.map((p) =>
        p.id === projectId ? { ...p, name } : p,
      ),
    };
    return projectList.projects.find((p) => p.id === projectId)!;
  });
  const deleteProject = vi.fn(async (input: unknown) => {
    const { projectId } = input as { projectId: string };
    projectList = {
      ...projectList,
      projects: projectList.projects.filter((p) => p.id !== projectId),
    };
    return { ok: true };
  });
  const reorderProject = vi.fn(async (input: unknown) => {
    const { projectId, previousProjectId } = input as {
      projectId: string;
      previousProjectId: string | null;
    };
    const moving = projectList.projects.find((p) => p.id === projectId)!;
    const rest = projectList.projects.filter((p) => p.id !== projectId);
    const at = previousProjectId
      ? rest.findIndex((p) => p.id === previousProjectId) + 1
      : 0;
    projectList = {
      ...projectList,
      projects: [...rest.slice(0, at), moving, ...rest.slice(at)],
    };
    return projectList;
  });
  const changeProjectFolder = vi.fn(async (input: unknown) => {
    const { projectId, path } = input as { projectId: string; path: string };
    projectList = {
      ...projectList,
      projects: projectList.projects.map((p) =>
        p.id === projectId && p.source
          ? { ...p, source: { ...p.source, path } }
          : p,
      ),
    };
    return projectList.projects.find((p) => p.id === projectId)!;
  });
  const listDirectory = vi.fn(async (input: unknown) => {
    const { path } = input as { path?: string };
    const directory = path ?? "/";
    return {
      directory,
      parent: "/",
      entries: [
        { name: "alpha", path: `${directory}/alpha`.replace("//", "/") },
        { name: "archive", path: `${directory}/archive`.replace("//", "/") },
        { name: "beta", path: `${directory}/beta`.replace("//", "/") },
      ],
    };
  });
  const pickFolder = vi.fn(async () => ({ path: "/picked/gamma" }));
  return {
    getSpaces: async () => catalog,
    saveSpaces,
    listArchived: async () => [],
    getLibrary: async () => ({ revision: 0, ids: [] }),
    listProjects: async () => projectList,
    createProject,
    renameProject,
    deleteProject,
    reorderProject,
    changeProjectFolder,
    listDirectory,
    pickFolder,
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
    ).toMatchObject({ spaceId: "one" });

    fireEvent.click(slot.getByRole("button", { name: "Show all projects" }));
    expect(scopeButton(slot).getAttribute("aria-label")).toBe(
      "Threads: All projects",
    );
    expect(slot.queryByRole("status")).toBeNull();
    expect(rows(slot)).toHaveLength(4);
  });

  it("sends Manage spaces to the Spaces page", async () => {
    const rpc = server();
    const slot = mount(rpc);
    await tick();
    await openScope(slot);
    // The menu is scope radios plus one Manage entry.
    expect(
      slot
        .getAllByRole("menuitem", { hidden: true })
        .map((node) => node.textContent),
    ).toEqual(["Manage spaces…"]);
    // Manage opens the list when All projects is selected...
    fireEvent.click(
      slot.getByRole("menuitem", {
        name: "Manage spaces…",
        hidden: true,
      }),
    );
    expect(slot.inspection.navigateCalls.at(-1)).toEqual({
      method: "toPluginPanel",
      path: "spaces",
      options: { subPath: "" },
    });
    // ...and the selected space otherwise.
    await openScope(slot);
    fireEvent.click(
      slot.getByRole("menuitemradio", { name: "Both", hidden: true }),
    );
    await tick();
    await openScope(slot);
    fireEvent.click(
      slot.getByRole("menuitem", {
        name: "Manage spaces…",
        hidden: true,
      }),
    );
    expect(slot.inspection.navigateCalls.at(-1)).toEqual({
      method: "toPluginPanel",
      path: "spaces",
      options: { subPath: "both" },
    });
  });

  it("links an empty space to its page and Manage to All projects when there are no spaces", async () => {
    const rpc = server({
      revision: 1,
      spaces: [{ id: "blank", name: "Blank", projectIds: [] }],
    });
    updateState((state) => ({ ...state, spaceId: "blank" }));
    const slot = mount(rpc, { activeThreadId: "", activeProjectId: "" });
    await waitFor(() =>
      expect(scopeButton(slot).getAttribute("aria-label")).toBe(
        "Threads: Blank",
      ),
    );
    expect(rows(slot)).toEqual([]);
    expect(slot.container.textContent).toContain("No projects in this space.");
    // New thread has nowhere in scope to go, so it does nothing.
    const plus = slot.getByRole("button", { name: "New thread" });
    expect(plus.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(plus);
    expect(slot.inspection.sidebarActionCalls).toEqual([]);
    fireEvent.click(slot.getByRole("button", { name: "Choose projects" }));
    expect(slot.inspection.navigateCalls.at(-1)).toEqual({
      method: "toPluginPanel",
      path: "spaces",
      options: { subPath: "blank" },
    });
    slot.lifecycle.unmount();

    const none = mount(server({ revision: 1, spaces: [] }), {
      activeThreadId: "",
      activeProjectId: "",
    });
    await tick();
    await openScope(none);
    fireEvent.click(
      none.getByRole("menuitem", {
        name: "Manage spaces…",
        hidden: true,
      }),
    );
    expect(none.inspection.navigateCalls.at(-1)).toEqual({
      method: "toPluginPanel",
      path: "spaces",
      options: { subPath: "projects" },
    });
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

  it("ignores a stale fetch that lands after a newer catalog", async () => {
    updateState((state) => ({ ...state, spaceId: "one" }));
    let resolve!: (catalog: SpaceCatalog) => void;
    const rpc = {
      ...server(),
      getSpaces: () => new Promise<SpaceCatalog>((r) => (resolve = r)),
    };
    const slot = mount(rpc);
    await slot.behavior.emitRealtime("spaces-changed", {
      revision: 5,
      spaces: [{ ...one, name: "Newer" }],
    });
    expect(scopeButton(slot).getAttribute("aria-label")).toBe("Threads: Newer");
    await act(async () => resolve(initial));
    expect(scopeButton(slot).getAttribute("aria-label")).toBe("Threads: Newer");
    expect(JSON.parse(localStorage.getItem(CACHE_KEY)!).revision).toBe(5);
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
      expandedArchives: ["archive"],
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
