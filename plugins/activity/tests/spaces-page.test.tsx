// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { updateState } from "../lib/client-state";
import type { Space, SpaceCatalog } from "../lib/space-schema";
import type { ProjectInventory } from "../lib/project-schema";
import { thread } from "./fixtures";

const app = await loadPluginApp(() => import("../app"));

const projects = [
  { id: "project-1", name: "One", isPersonal: false },
  { id: "project-2", name: "Two", isPersonal: false },
  { id: "project-3", name: "Three", isPersonal: false },
  { id: "personal", name: "Personal", isPersonal: true },
];
const threads = [
  thread({ id: "t1", title: "One a" }),
  thread({ id: "t2", title: "One b" }),
  thread({ id: "t3", title: "Two a", projectId: "project-2" }),
];
const one: Space = { id: "one", name: "Only One", projectIds: ["project-1"] };
const both: Space = {
  id: "both",
  name: "Both",
  projectIds: ["project-1", "project-2"],
};
const initial: SpaceCatalog = { revision: 1, spaces: [one, both] };
const managed = (
  id: string,
  name: string,
  path: string | null,
  hostId = "host-1",
) => ({
  id,
  name,
  isPersonal: path === null,
  source: path === null ? null : { id: `src-${id}`, hostId, path },
});
const inventory: ProjectInventory = {
  projects: [
    managed("project-1", "One", "/code/one"),
    managed("project-2", "Two", "/code/two"),
    managed("project-3", "Three", "/code/three"),
    managed("personal", "Personal", null),
  ],
  hosts: [{ id: "host-1", name: "MacBook", connected: true }],
};

const tick = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => undefined);
const props = {
  activeThreadId: "t1",
  activeProjectId: "project-1",
  isCompactViewport: false,
  searchQuery: "",
  onNavigate: vi.fn(),
  Original: () => <p>BB fallback</p>,
};

function server(projectsStart: ProjectInventory = inventory) {
  let catalog = initial;
  let list = projectsStart;
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
    list = { ...list, projects: [...list.projects, created] };
    return created;
  });
  const renameProject = vi.fn(async (input: unknown) => {
    const { projectId, name } = input as { projectId: string; name: string };
    list = {
      ...list,
      projects: list.projects.map((p) =>
        p.id === projectId ? { ...p, name } : p,
      ),
    };
    return list.projects.find((p) => p.id === projectId)!;
  });
  const deleteProject = vi.fn(async (input: unknown) => {
    const { projectId } = input as { projectId: string };
    list = {
      ...list,
      projects: list.projects.filter((p) => p.id !== projectId),
    };
    return { ok: true };
  });
  const reorderProject = vi.fn(async (input: unknown) => {
    const { projectId, previousProjectId } = input as {
      projectId: string;
      previousProjectId: string | null;
    };
    const moving = list.projects.find((p) => p.id === projectId)!;
    const rest = list.projects.filter((p) => p.id !== projectId);
    const at = previousProjectId
      ? rest.findIndex((p) => p.id === previousProjectId) + 1
      : 0;
    list = {
      ...list,
      projects: [...rest.slice(0, at), moving, ...rest.slice(at)],
    };
    return list;
  });
  const changeProjectFolder = vi.fn(async (input: unknown) => {
    const { projectId, path } = input as { projectId: string; path: string };
    list = {
      ...list,
      projects: list.projects.map((p) =>
        p.id === projectId && p.source
          ? { ...p, source: { ...p.source, path } }
          : p,
      ),
    };
    return list.projects.find((p) => p.id === projectId)!;
  });
  const listDirectory = vi.fn(async (input: unknown) => {
    const { path } = input as { path?: string };
    const directory = (path ?? "/").replace(/\/+$/, "") || "/";
    const join = (name: string) => `${directory}/${name}`.replace("//", "/");
    return {
      directory,
      parent: "/",
      entries: [
        { name: "alpha", path: join("alpha") },
        { name: "archive", path: join("archive") },
        { name: "beta", path: join("beta") },
        { name: ".hidden", path: join(".hidden") },
      ],
    };
  });
  const pickFolder = vi.fn(async () => ({ path: "/picked/gamma" }));
  return {
    getSpaces: async () => catalog,
    saveSpaces,
    listArchived: async () => [],
    listProjects: async () => list,
    createProject,
    renameProject,
    deleteProject,
    reorderProject,
    changeProjectFolder,
    listDirectory,
    pickFolder,
  };
}
type Rpc = NonNullable<Parameters<typeof renderSlot>[2]>["rpc"];
const mounted: ReturnType<typeof renderSlot>[] = [];
let compact = false;
beforeEach(() => {
  compact = false;
  window.matchMedia = ((query: string) =>
    ({
      matches: query.includes("max-width") && compact,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
});
async function mountPage(
  subPath = "",
  rpc: Rpc = server(),
  sidebarProjects = projects,
) {
  const slot = renderSlot(
    app.navPanels[0],
    { subPath },
    { sidebarThreads: { threads, projects: sidebarProjects }, rpc },
  );
  mounted.push(slot);
  await waitFor(() =>
    expect(slot.inspection.rpcCalls.map((c) => c.method)).toContain(
      "listProjects",
    ),
  );
  await waitFor(() => expect(slot.queryByText("Loading…")).toBeNull());
  await tick();
  return slot;
}
const spaceRows = (slot: ReturnType<typeof renderSlot>) =>
  within(slot.getByRole("navigation", { name: "Spaces" }))
    .getAllByRole("listitem")
    .map((item) => item.textContent?.replace("⋮⋮", "").replace("›", "").trim());
const projectRows = (slot: ReturnType<typeof renderSlot>) =>
  Array.from(
    slot
      .getByRole("list", { name: "Projects" })
      .querySelectorAll("[data-project-name]"),
  ).map((node) => node.textContent);
async function openRowMenu(slot: ReturnType<typeof renderSlot>, label: string) {
  fireEvent.keyDown(slot.getByRole("button", { name: label }), {
    key: "Enter",
  });
  await tick();
}
const item = (slot: ReturnType<typeof renderSlot>, name: string) =>
  slot.getByRole("menuitem", { name, hidden: true });
const lastNavigation = (slot: ReturnType<typeof renderSlot>) =>
  slot.inspection.navigateCalls.at(-1);

afterEach(() => {
  for (const slot of mounted.splice(0)) slot.lifecycle.unmount();
  cleanup();
  window.localStorage.clear();
});

describe("spaces page", () => {
  it("registers a sidebar page and lists spaces beside the first space's projects", async () => {
    expect(app.navPanels[0]).toMatchObject({
      id: "spaces",
      title: "Spaces",
      path: "spaces",
    });
    const slot = await mountPage();
    expect(spaceRows(slot)).toEqual(["Only One1", "Both2"]);
    expect(
      slot
        .getByRole("button", { name: /^Only One/ })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(slot.getByRole("heading", { name: "Only One" })).toBeTruthy();
    expect(projectRows(slot)).toEqual(["One", "Two", "Three", "No project"]);
    expect(slot.getByText("/code/one")).toBeTruthy();
    expect(slot.queryByText("MacBook")).toBeNull();
    const boxes = slot.getAllByRole("checkbox") as HTMLInputElement[];
    expect(
      boxes.map((box) => [box.getAttribute("aria-label"), box.checked]),
    ).toEqual([
      ["Include One in Only One", true],
      ["Include Two in Only One", false],
      ["Include Three in Only One", false],
      ["Include No project in Only One", false],
    ]);
    // Rows navigate within the page.
    fireEvent.click(slot.getByRole("button", { name: /^Both/ }));
    expect(lastNavigation(slot)).toEqual({
      method: "toPluginPanel",
      path: "spaces",
      options: { subPath: "both", replace: false },
    });
    fireEvent.click(slot.getByRole("button", { name: /^All projects/ }));
    expect(lastNavigation(slot)).toMatchObject({
      options: { subPath: "projects", replace: false },
    });
  });

  it("edits membership, renames, reorders, and deletes the routed space", async () => {
    const rpc = server();
    const slot = await mountPage("both", rpc);
    expect(slot.getByRole("heading", { name: "Both" })).toBeTruthy();
    fireEvent.click(
      slot.getByRole("checkbox", { name: "Include Three in Both" }),
    );
    await waitFor(() => expect(rpc.saveSpaces).toHaveBeenCalledTimes(1));
    expect(rpc.saveSpaces.mock.calls[0][0]).toEqual({
      expectedRevision: 1,
      spaces: [
        one,
        { ...both, projectIds: ["project-1", "project-2", "project-3"] },
      ],
    });
    await waitFor(() =>
      expect(spaceRows(slot)).toEqual(["Only One1", "Both3"]),
    );

    // The list row's context menu reorders.
    fireEvent.contextMenu(
      slot.container.querySelector('[data-space-row="Only One"]')!,
    );
    await tick();
    expect(item(slot, "Move up").getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(item(slot, "Move down"));
    await waitFor(() => expect(rpc.saveSpaces).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(spaceRows(slot)).toEqual(["Both3", "Only One1"]),
    );

    // The heading menu edits the routed space in place.
    await openRowMenu(slot, "Space actions: Both");
    fireEvent.click(item(slot, "Rename…"));
    const input = (await slot.findByRole("textbox", {
      name: "Space name",
    })) as HTMLInputElement;
    expect(input.value).toBe("Both");
    fireEvent.change(input, { target: { value: "Pair" } });
    fireEvent.submit(slot.getByRole("form", { name: "Rename space" }));
    await waitFor(() => expect(rpc.saveSpaces).toHaveBeenCalledTimes(3));
    expect(rpc.saveSpaces.mock.calls[2][0]).toMatchObject({
      spaces: [
        {
          ...both,
          name: "Pair",
          projectIds: ["project-1", "project-2", "project-3"],
        },
        one,
      ],
    });
    await waitFor(() =>
      expect(slot.getByRole("heading", { name: "Pair" })).toBeTruthy(),
    );
    expect(slot.queryByRole("form")).toBeNull();

    await openRowMenu(slot, "Space actions: Pair");
    fireEvent.click(item(slot, "Delete…"));
    const confirm = await slot.findByRole("form", { name: "Delete space" });
    expect(confirm.textContent).toContain("Delete space “Pair”?");
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(rpc.saveSpaces).toHaveBeenCalledTimes(4));
    expect(rpc.saveSpaces.mock.calls[3][0]).toMatchObject({ spaces: [one] });
    await waitFor(() =>
      expect(lastNavigation(slot)).toEqual({
        method: "toPluginPanel",
        path: "spaces",
        options: { subPath: "", replace: true },
      }),
    );
  });

  it("opens a space's rename form from the list's context menu", async () => {
    const slot = await mountPage("one");
    fireEvent.contextMenu(
      slot.container.querySelector('[data-space-row="Both"]')!,
    );
    await tick();
    fireEvent.click(item(slot, "Rename…"));
    expect(lastNavigation(slot)).toMatchObject({
      options: { subPath: "both" },
    });
    // The page re-renders at the new route with the form already open.
    const Page = app.navPanels[0]!.component;
    slot.lifecycle.rerender(<Page subPath="both" />);
    const input = (await slot.findByRole("textbox", {
      name: "Space name",
    })) as HTMLInputElement;
    expect(input.value).toBe("Both");
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.keyDown(input, { key: "Escape" });
    expect(slot.queryByRole("form")).toBeNull();
  });

  it("filters long project lists by name or folder", async () => {
    const many: ProjectInventory = {
      projects: [
        ...inventory.projects,
        managed("project-4", "Four", "/srv/four"),
        managed("project-5", "Five", "/srv/five"),
      ],
      hosts: inventory.hosts,
    };
    const slot = await mountPage("one", server(many));
    const filter = slot.getByRole("searchbox", { name: "Filter projects" });
    fireEvent.change(filter, { target: { value: "srv" } });
    expect(projectRows(slot)).toEqual(["Four", "Five"]);
    // Reordering is off while filtering.
    await openRowMenu(slot, "Project actions: Four");
    expect(item(slot, "Move up").getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(slot.getByRole("menu", { hidden: true }), {
      key: "Escape",
    });
    fireEvent.change(filter, { target: { value: "zzz" } });
    expect(projectRows(slot)).toEqual([]);
    expect(slot.getByText("No projects match “zzz”.")).toBeTruthy();
    fireEvent.change(filter, { target: { value: "" } });
    expect(projectRows(slot)).toHaveLength(6);
    slot.lifecycle.unmount();

    // The New space checklist filters too, without a field for short lists.
    const short = await mountPage("new");
    expect(short.queryByRole("searchbox")).toBeNull();
    short.lifecycle.unmount();
    const long = await mountPage("new", server(many));
    const checked = () =>
      within(long.getByRole("form", { name: "New space" }))
        .getAllByRole("checkbox")
        .map((box) => box.parentElement?.textContent);
    fireEvent.change(long.getByRole("searchbox", { name: "Filter projects" }), {
      target: { value: "fi" },
    });
    expect(checked()).toEqual(["Five"]);
    // Folder paths match too.
    fireEvent.change(long.getByRole("searchbox", { name: "Filter projects" }), {
      target: { value: "/srv" },
    });
    expect(checked()).toEqual(["Four", "Five"]);
  });

  it("reorders spaces and projects by dragging one row onto another", async () => {
    const rpc = server();
    const slot = await mountPage("one", rpc);
    const rowOf = (name: string) =>
      slot.container.querySelector(`[data-space-row="${name}"]`)!
        .parentElement as HTMLElement;
    expect(rowOf("Only One").getAttribute("draggable")).toBe("true");
    const transfer = { effectAllowed: "", setData: () => {} };
    fireEvent.dragStart(rowOf("Only One"), { dataTransfer: transfer });
    fireEvent.dragOver(rowOf("Both"), { dataTransfer: transfer });
    expect(rowOf("Both").className).toContain("ring-ring");
    fireEvent.drop(rowOf("Both"), { dataTransfer: transfer });
    await waitFor(() => expect(rpc.saveSpaces).toHaveBeenCalledTimes(1));
    expect(rpc.saveSpaces.mock.calls[0][0]).toMatchObject({
      spaces: [both, one],
    });

    const projectRow = (name: string) =>
      Array.from(
        slot.getByRole("list", { name: "Projects" }).querySelectorAll("li"),
      ).find(
        (li) => li.querySelector("[data-project-name]")?.textContent === name,
      )!;
    expect(projectRow("No project").getAttribute("draggable")).toBeNull();
    fireEvent.dragStart(projectRow("Three"), { dataTransfer: transfer });
    fireEvent.dragOver(projectRow("One"), { dataTransfer: transfer });
    fireEvent.drop(projectRow("One"), { dataTransfer: transfer });
    await waitFor(() =>
      expect(rpc.reorderProject).toHaveBeenCalledWith({
        projectId: "project-3",
        previousProjectId: null,
        nextProjectId: "project-1",
      }),
    );
    await waitFor(() =>
      expect(projectRows(slot)).toEqual(["Three", "One", "Two", "No project"]),
    );
  });

  it("redirects an unknown space to the list", async () => {
    const slot = await mountPage("gone");
    await waitFor(() =>
      expect(lastNavigation(slot)).toEqual({
        method: "toPluginPanel",
        path: "spaces",
        options: { subPath: "", replace: true },
      }),
    );
  });

  it("keeps a routed space the cache does not know until the server answers", async () => {
    // Another client created "fresh"; this one still has an older cache.
    window.localStorage.setItem(
      "bb-plugin-erwin-activity:spaces-cache",
      JSON.stringify(initial),
    );
    const fresh: Space = { id: "fresh", name: "Fresh", projectIds: [] };
    let resolve!: (catalog: SpaceCatalog) => void;
    const rpc = {
      ...server(),
      getSpaces: () => new Promise<SpaceCatalog>((r) => (resolve = r)),
    };
    const slot = await mountPage("fresh", rpc);
    expect(slot.inspection.navigateCalls).toHaveLength(0);
    resolve({ revision: 2, spaces: [one, both, fresh] });
    await waitFor(() =>
      expect(slot.getByRole("heading", { name: "Fresh" })).toBeTruthy(),
    );
    expect(slot.inspection.navigateCalls).toHaveLength(0);
  });

  it("chains membership edits started while a save is in flight", async () => {
    const base = server();
    const gates: Array<() => void> = [];
    const rpc = {
      ...base,
      saveSpaces: vi.fn(async (input: unknown) => {
        await new Promise<void>((release) => gates.push(release));
        return base.saveSpaces(input);
      }),
    };
    const slot = await mountPage("one", rpc);
    fireEvent.click(
      slot.getByRole("checkbox", { name: "Include Two in Only One" }),
    );
    fireEvent.click(
      slot.getByRole("checkbox", { name: "Include Three in Only One" }),
    );
    await waitFor(() => expect(rpc.saveSpaces).toHaveBeenCalledTimes(1));
    expect(rpc.saveSpaces.mock.calls[0][0]).toMatchObject({
      expectedRevision: 1,
      spaces: [{ ...one, projectIds: ["project-1", "project-2"] }, both],
    });
    gates.shift()!();
    // The second edit starts from the first save's result and revision.
    await waitFor(() => expect(rpc.saveSpaces).toHaveBeenCalledTimes(2));
    expect(rpc.saveSpaces.mock.calls[1][0]).toMatchObject({
      expectedRevision: 2,
      spaces: [
        { ...one, projectIds: ["project-1", "project-2", "project-3"] },
        both,
      ],
    });
    gates.shift()!();
    await waitFor(() =>
      expect(spaceRows(slot)).toEqual(["Only One3", "Both2"]),
    );
    expect(slot.queryByRole("alert")).toBeNull();
  });

  it("shows a load error with Retry, and sends an unknown route back once the load fails", async () => {
    const getSpaces = vi
      .fn<() => Promise<SpaceCatalog>>()
      .mockRejectedValueOnce(new Error("Spaces store is offline."))
      .mockResolvedValue(initial);
    const rpc = { ...server(), getSpaces };
    const slot = await mountPage("", rpc);
    const alert = await slot.findByRole("alert");
    expect(alert.textContent).toContain("Spaces store is offline.");
    expect(slot.queryByText(/No spaces yet/)).toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(slot.queryByRole("alert")).toBeNull());
    expect(spaceRows(slot)).toEqual(["Only One1", "Both2"]);
    slot.lifecycle.unmount();

    // With no cache and a failed load, an unknown space still leaves.
    const failing = {
      ...server(),
      getSpaces: async () => {
        throw new Error("Spaces store is offline.");
      },
    };
    const gone = await mountPage("gone", failing);
    await waitFor(() =>
      expect(lastNavigation(gone)).toMatchObject({
        options: { subPath: "", replace: true },
      }),
    );
  });

  it("shows a placeholder for a space the cache does not know while the load is pending", async () => {
    compact = true;
    window.localStorage.setItem(
      "bb-plugin-erwin-activity:spaces-cache",
      JSON.stringify(initial),
    );
    const rpc = {
      ...server(),
      getSpaces: () => new Promise<SpaceCatalog>(() => {}),
    };
    const slot = await mountPage("fresh", rpc);
    const section = slot.getByRole("region", { name: "Space" });
    expect(section.textContent).toContain("Loading space…");
    fireEvent.click(within(section).getByRole("button", { name: "‹ Spaces" }));
    expect(lastNavigation(slot)).toMatchObject({ options: { subPath: "" } });
  });

  it("resolves a queued move against the order the earlier move produced", async () => {
    const three: Space = { id: "three", name: "Third", projectIds: [] };
    const base = server();
    const gates: Array<() => void> = [];
    const rpc = {
      ...base,
      getSpaces: async () => ({ revision: 1, spaces: [one, both, three] }),
      saveSpaces: vi.fn(async (input: unknown) => {
        await new Promise<void>((release) => gates.push(release));
        return base.saveSpaces(input);
      }),
    };
    const slot = await mountPage("one", rpc);
    // Move "Only One" down, then "Both" down, before the first save lands.
    fireEvent.contextMenu(
      slot.container.querySelector('[data-space-row="Only One"]')!,
    );
    await tick();
    fireEvent.click(item(slot, "Move down"));
    fireEvent.contextMenu(
      slot.container.querySelector('[data-space-row="Both"]')!,
    );
    await tick();
    fireEvent.click(item(slot, "Move down"));
    await waitFor(() => expect(rpc.saveSpaces).toHaveBeenCalledTimes(1));
    gates.shift()!();
    await waitFor(() => expect(rpc.saveSpaces).toHaveBeenCalledTimes(2));
    gates.shift()!();
    // "Both" was first after the first move, so it moves to second.
    await waitFor(() =>
      expect(spaceRows(slot)).toEqual(["Only One1", "Both2", "Third0"]),
    );
    expect(rpc.saveSpaces.mock.calls[1][0]).toMatchObject({
      expectedRevision: 2,
      spaces: [one, both, three],
    });
  });

  it("refetches after a conflict so the next queued edit builds on the server's catalog", async () => {
    let elsewhere: SpaceCatalog = {
      revision: 7,
      spaces: [{ ...one, name: "Elsewhere" }, both],
    };
    const saveSpaces = vi.fn(async (input: unknown) => {
      const { expectedRevision, spaces } = input as {
        expectedRevision: number;
        spaces: Space[];
      };
      if (expectedRevision !== elsewhere.revision)
        throw new Error("Spaces changed on another client. Reload and retry.");
      elsewhere = { revision: elsewhere.revision + 1, spaces };
      return elsewhere;
    });
    let served = 0;
    const rpc = {
      ...server(),
      getSpaces: async () => (served++ === 0 ? initial : elsewhere),
      saveSpaces,
    };
    const slot = await mountPage("one", rpc);
    fireEvent.click(
      slot.getByRole("checkbox", { name: "Include Two in Only One" }),
    );
    fireEvent.click(
      slot.getByRole("checkbox", { name: "Include Three in Only One" }),
    );
    await waitFor(() => expect(saveSpaces).toHaveBeenCalledTimes(2));
    expect(saveSpaces.mock.calls[0][0]).toMatchObject({ expectedRevision: 1 });
    // The first edit conflicted and is reported; the second carries on.
    expect(saveSpaces.mock.calls[1][0]).toMatchObject({
      expectedRevision: 7,
      spaces: [
        { ...one, name: "Elsewhere", projectIds: ["project-1", "project-3"] },
        both,
      ],
    });
    expect((await slot.findByRole("alert")).textContent).toContain(
      "another client",
    );
    await waitFor(() =>
      expect(slot.getByRole("heading", { name: "Elsewhere" })).toBeTruthy(),
    );
  });

  it("creates a space with its projects and moves to it", async () => {
    const rpc = server();
    const slot = await mountPage("new", rpc);
    const form = slot.getByRole("form", { name: "New space" });
    expect(form.textContent).toContain(
      "An empty space shows no threads until projects are added.",
    );
    const boxes = within(form).getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes).toHaveLength(4);
    fireEvent.click(boxes[2]!);
    expect(form.textContent).toContain("1 of 4 selected.");
    const create = within(form).getByRole("button", {
      name: "Create",
    }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(
      within(form).getByRole("textbox", { name: "Space name" }),
      {
        target: { value: "  Fresh " },
      },
    );
    fireEvent.click(create);
    await waitFor(() => expect(rpc.saveSpaces).toHaveBeenCalledTimes(1));
    expect(rpc.saveSpaces.mock.calls[0][0]).toMatchObject({
      spaces: [one, both, { name: "Fresh", projectIds: ["project-3"] }],
    });
    await waitFor(() =>
      expect(lastNavigation(slot)).toMatchObject({
        method: "toPluginPanel",
        options: { replace: true },
      }),
    );
    const { subPath } = (
      lastNavigation(slot) as { options: { subPath: string } }
    ).options;
    expect(subPath).not.toBe("");
    expect(slot.inspection.navigateCalls).toHaveLength(1);
  });

  it("cancels New space back to the list", async () => {
    const slot = await mountPage("new");
    fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
    expect(lastNavigation(slot)).toEqual({
      method: "toPluginPanel",
      path: "spaces",
      options: { subPath: "", replace: true },
    });
  });

  it("renames, moves, and re-folders a project through BB", async () => {
    const rpc = server();
    const slot = await mountPage("projects", rpc);
    expect(slot.getByRole("heading", { name: "All projects" })).toBeTruthy();
    expect(slot.queryAllByRole("checkbox")).toHaveLength(0);
    await openRowMenu(slot, "Project actions: Two");
    fireEvent.click(item(slot, "Rename…"));
    const input = (await slot.findByRole("textbox", {
      name: "Project name",
    })) as HTMLInputElement;
    expect(input.value).toBe("Two");
    fireEvent.change(input, { target: { value: "Deux" } });
    fireEvent.submit(slot.getByRole("form", { name: "Rename project" }));
    await waitFor(() =>
      expect(rpc.renameProject).toHaveBeenCalledWith({
        projectId: "project-2",
        name: "Deux",
      }),
    );
    await waitFor(() =>
      expect(projectRows(slot)).toEqual(["One", "Deux", "Three", "No project"]),
    );

    await openRowMenu(slot, "Project actions: Deux");
    fireEvent.click(item(slot, "Move up"));
    await waitFor(() =>
      expect(rpc.reorderProject).toHaveBeenCalledWith({
        projectId: "project-2",
        previousProjectId: null,
        nextProjectId: "project-1",
      }),
    );
    await waitFor(() =>
      expect(projectRows(slot)).toEqual(["Deux", "One", "Three", "No project"]),
    );

    await openRowMenu(slot, "Project actions: Three");
    expect(item(slot, "Move down").getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(item(slot, "Change folder…"));
    const path = (await slot.findByRole("combobox", {
      name: "Folder path",
    })) as HTMLInputElement;
    expect(path.value).toBe("/code/three");
    fireEvent.change(path, { target: { value: "/code/a" } });
    await waitFor(() =>
      expect(rpc.listDirectory).toHaveBeenCalledWith({
        hostId: "host-1",
        path: "/code",
      }),
    );
    const options = await slot.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "/code/alpha",
      "/code/archive",
    ]);
    fireEvent.keyDown(path, { key: "ArrowDown" });
    fireEvent.keyDown(path, { key: "Enter" });
    expect(path.value).toBe("/code/alpha/");
    fireEvent.submit(slot.getByRole("form", { name: "Change folder" }));
    await waitFor(() =>
      expect(rpc.changeProjectFolder).toHaveBeenCalledWith({
        projectId: "project-3",
        path: "/code/alpha",
      }),
    );
    await waitFor(() => expect(slot.getByText("/code/alpha")).toBeTruthy());
    // The personal project has no row menu.
    expect(
      slot.queryByRole("button", { name: "Project actions: No project" }),
    ).toBeNull();
  });

  it("removes a project after typing its name and drops it from every space", async () => {
    const rpc = server();
    const slot = await mountPage("one", rpc);
    await openRowMenu(slot, "Project actions: One");
    fireEvent.click(item(slot, "Remove…"));
    const form = await slot.findByRole("form", { name: "Remove project" });
    expect(form.textContent).toContain("its 2 active threads");
    const remove = within(form).getByRole("button", {
      name: "Remove",
    }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    const confirm = within(form).getByRole("textbox", {
      name: "Type the project name to confirm",
    });
    fireEvent.change(confirm, { target: { value: "one" } });
    expect(remove.disabled).toBe(true);
    fireEvent.change(confirm, { target: { value: "One" } });
    expect(remove.disabled).toBe(false);
    fireEvent.click(remove);
    await waitFor(() =>
      expect(rpc.deleteProject).toHaveBeenCalledWith({
        projectId: "project-1",
      }),
    );
    await waitFor(() => expect(rpc.saveSpaces).toHaveBeenCalledTimes(1));
    expect(rpc.saveSpaces.mock.calls[0][0]).toMatchObject({
      spaces: [
        { ...one, projectIds: [] },
        { ...both, projectIds: ["project-2"] },
      ],
    });
    await waitFor(() =>
      expect(projectRows(slot)).toEqual(["Two", "Three", "No project"]),
    );
    expect(slot.queryByRole("form")).toBeNull();
  });

  it("adds a project from a typed or picked folder and joins the routed space", async () => {
    const rpc = server();
    const slot = await mountPage("one", rpc);
    fireEvent.click(slot.getByRole("button", { name: "Add project…" }));
    const form = slot.getByRole("form", { name: "Add project" });
    expect(form.textContent).toContain("The project joins Only One.");
    expect(within(form).queryByRole("combobox", { name: "Host" })).toBeNull();
    const add = within(form).getByRole("button", {
      name: "Add",
    }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);

    fireEvent.click(within(form).getByRole("button", { name: "Browse…" }));
    await waitFor(() =>
      expect(rpc.pickFolder).toHaveBeenCalledWith({ hostId: "host-1" }),
    );
    const path = within(form).getByRole("combobox", {
      name: "Folder path",
    }) as HTMLInputElement;
    await waitFor(() => expect(path.value).toBe("/picked/gamma"));
    const name = within(form).getByRole("textbox", {
      name: "Project name",
    }) as HTMLInputElement;
    expect(name.value).toBe("gamma");
    fireEvent.change(path, { target: { value: "/picked/delta/" } });
    expect(name.value).toBe("delta");
    fireEvent.change(name, { target: { value: "Delta!" } });
    fireEvent.change(path, { target: { value: "/picked/epsilon" } });
    expect(name.value).toBe("Delta!");
    expect(add.disabled).toBe(false);
    fireEvent.click(add);
    await waitFor(() =>
      expect(rpc.createProject).toHaveBeenCalledWith({
        name: "Delta!",
        hostId: "host-1",
        path: "/picked/epsilon",
      }),
    );
    await waitFor(() => expect(rpc.saveSpaces).toHaveBeenCalledTimes(1));
    expect(rpc.saveSpaces.mock.calls[0][0]).toMatchObject({
      spaces: [{ ...one, projectIds: ["project-1", "project-new"] }, both],
    });
    await waitFor(() => expect(projectRows(slot)).toContain("Delta!"));
    expect(slot.queryByRole("form")).toBeNull();
  });

  it("enables Add once the host inventory arrives after the form opened", async () => {
    let resolve!: (list: ProjectInventory) => void;
    const rpc = {
      ...server(),
      listProjects: () => new Promise<ProjectInventory>((r) => (resolve = r)),
    };
    const slot = renderSlot(
      app.navPanels[0],
      { subPath: "one" },
      { sidebarThreads: { threads, projects }, rpc },
    );
    mounted.push(slot);
    fireEvent.click(await slot.findByRole("button", { name: "Add project…" }));
    const form = slot.getByRole("form", { name: "Add project" });
    fireEvent.change(
      within(form).getByRole("combobox", { name: "Folder path" }),
      { target: { value: "/late/host" } },
    );
    const add = within(form).getByRole("button", {
      name: "Add",
    }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    resolve(inventory);
    await waitFor(() => expect(add.disabled).toBe(false));
    fireEvent.click(add);
    await waitFor(() =>
      expect(rpc.createProject).toHaveBeenCalledWith({
        name: "host",
        hostId: "host-1",
        path: "/late/host",
      }),
    );
  });

  it("does not create the space when Enter is pressed in the New space filter", async () => {
    const many: ProjectInventory = {
      projects: [
        ...inventory.projects,
        managed("project-4", "Four", "/srv/four"),
        managed("project-5", "Five", "/srv/five"),
      ],
      hosts: inventory.hosts,
    };
    const rpc = server(many);
    const slot = await mountPage("new", rpc);
    const form = slot.getByRole("form", { name: "New space" });
    fireEvent.change(
      within(form).getByRole("textbox", { name: "Space name" }),
      { target: { value: "Filtered" } },
    );
    const filter = within(form).getByRole("searchbox", {
      name: "Filter projects",
    });
    fireEvent.change(filter, { target: { value: "fi" } });
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    filter.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await tick();
    expect(rpc.saveSpaces).not.toHaveBeenCalled();
    expect(slot.inspection.navigateCalls).toHaveLength(0);
  });

  it("shows host badges and a host selector with several hosts, and reports load failures", async () => {
    const multi: ProjectInventory = {
      projects: [
        managed("project-1", "One", "/code/one", "host-1"),
        managed("project-2", "Two", "/srv/two", "host-2"),
        managed("project-3", "Three", "/code/three", "host-1"),
        managed("personal", "Personal", null),
      ],
      hosts: [
        { id: "host-1", name: "MacBook", connected: true },
        { id: "host-2", name: "Server", connected: false },
      ],
    };
    const slot = await mountPage("projects", server(multi));
    expect(slot.getAllByText("MacBook")).toHaveLength(2);
    expect(slot.getByText("Server")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Add project…" }));
    const host = slot.getByRole("combobox", {
      name: "Host",
    }) as HTMLSelectElement;
    expect(host.value).toBe("host-1");
    expect(
      Array.from(host.options).map((option) => option.textContent),
    ).toEqual(["MacBook", "Server (offline)"]);
    slot.lifecycle.unmount();

    const failing = renderSlot(
      app.navPanels[0],
      { subPath: "projects" },
      {
        sidebarThreads: { threads, projects },
        rpc: {
          ...server(),
          listProjects: async () => {
            throw new Error("offline");
          },
        },
      },
    );
    mounted.push(failing);
    await waitFor(() =>
      expect(failing.getByRole("alert").textContent).toContain(
        "Cannot load projects.",
      ),
    );
  });

  it("shows one column at a time on phones with a back link", async () => {
    compact = true;
    const index = await mountPage("");
    expect(index.getByRole("navigation", { name: "Spaces" })).toBeTruthy();
    expect(index.queryByRole("list", { name: "Projects" })).toBeNull();
    expect(index.queryByRole("heading", { name: "Only One" })).toBeNull();
    // No drag handles or row menus in the list; edits live on the detail.
    expect(index.container.querySelector("[draggable]")).toBeNull();
    expect(index.queryByRole("button", { name: /actions/i })).toBeNull();
    index.lifecycle.unmount();

    const detail = await mountPage("both");
    expect(detail.queryByRole("navigation", { name: "Spaces" })).toBeNull();
    expect(detail.getByRole("heading", { name: "Both" })).toBeTruthy();
    expect(detail.container.querySelector("[draggable]")).toBeNull();
    await openRowMenu(detail, "Space actions: Both");
    expect(item(detail, "Move up")).toBeTruthy();
    fireEvent.keyDown(detail.getByRole("menu", { hidden: true }), {
      key: "Escape",
    });
    fireEvent.click(detail.getByRole("button", { name: "‹ Spaces" }));
    expect(lastNavigation(detail)).toEqual({
      method: "toPluginPanel",
      path: "spaces",
      options: { subPath: "", replace: false },
    });
  });

  it("offers project actions on group headers in the by-project view", async () => {
    updateState((state) => ({ ...state, groupBy: "project" }));
    const rpc = server();
    const slot = renderSlot(app.threadLists[0], props, {
      sidebarThreads: { threads, projects },
      rpc,
    });
    mounted.push(slot);
    await waitFor(() =>
      expect(slot.getByRole("region", { name: "One" })).toBeTruthy(),
    );
    const header = slot
      .getByRole("region", { name: "One" })
      .querySelector("[data-project-header]")!;
    fireEvent.contextMenu(header);
    await tick();
    const menu = slot.getByRole("menu", { name: "Actions for project One" });
    expect(
      Array.from(menu.querySelectorAll("[role^=menuitem]")).map(
        (node) => node.textContent,
      ),
    ).toEqual([
      "New thread",
      "Spaces›",
      "Rename…",
      "Manage spaces…",
      "Remove…",
    ]);
    fireEvent.click(item(slot, "Rename…"));
    const input = (await slot.findByRole("textbox", {
      name: "Project name",
    })) as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.change(input, { target: { value: "Uno" } });
    fireEvent.submit(slot.getByRole("form", { name: "Rename project" }));
    await waitFor(() =>
      expect(rpc.renameProject).toHaveBeenCalledWith({
        projectId: "project-1",
        name: "Uno",
      }),
    );
    await waitFor(() => expect(slot.queryByRole("form")).toBeNull());

    fireEvent.contextMenu(header);
    await tick();
    fireEvent.click(item(slot, "Remove…"));
    const remove = await slot.findByRole("form", { name: "Remove project" });
    expect(remove.textContent).toContain("its 2 active threads");
    fireEvent.keyDown(
      within(remove).getByRole("textbox", {
        name: "Type the project name to confirm",
      }),
      { key: "Escape" },
    );
    expect(slot.queryByRole("form")).toBeNull();

    fireEvent.contextMenu(header);
    await tick();
    fireEvent.click(item(slot, "Manage spaces…"));
    expect(lastNavigation(slot)).toEqual({
      method: "toPluginPanel",
      path: "spaces",
      options: { subPath: "" },
    });
  });
});
