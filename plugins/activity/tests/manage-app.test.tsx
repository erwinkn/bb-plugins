// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { parseState, updateState } from "../lib/client-state";
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
async function mountManage(
  rpc: Rpc = server(),
  overrides: Partial<typeof props> = {},
  sidebarProjects = projects,
) {
  const slot = renderSlot(
    app.threadLists[0],
    { ...props, ...overrides },
    { sidebarThreads: { threads, projects: sidebarProjects }, rpc },
  );
  mounted.push(slot);
  await waitFor(() =>
    expect(slot.inspection.rpcCalls.map((c) => c.method)).toContain(
      "getSpaces",
    ),
  );
  fireEvent.keyDown(
    slot.getByRole("button", { name: /^Threads: /, hidden: true }),
    { key: "Enter" },
  );
  await tick();
  fireEvent.click(
    slot.getByRole("menuitem", {
      name: "Manage spaces and projects…",
      hidden: true,
    }),
  );
  await slot.findByRole("dialog", { name: "Spaces and projects" });
  await waitFor(() =>
    expect(slot.inspection.rpcCalls.map((c) => c.method)).toContain(
      "listProjects",
    ),
  );
  await tick();
  return slot;
}
const spaceRows = (slot: ReturnType<typeof renderSlot>) =>
  within(slot.getByRole("list", { name: "Spaces" }))
    .getAllByRole("listitem")
    .map((item) => item.textContent?.replace("⋮⋮", "").replace("…", "").trim());
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

beforeEach(() => {
  window.localStorage.clear();
  updateState(() => parseState(null));
  vi.clearAllMocks();
});
afterEach(async () => {
  for (const slot of mounted.splice(0)) slot.lifecycle.unmount();
  cleanup();
  await tick();
});

describe("manage view", () => {
  it("opens as a dialog that lists spaces with counts and projects with folders, and edits one space at a time", async () => {
    const slot = await mountManage();
    const dialog = slot.getByRole("dialog", { name: "Spaces and projects" });
    expect(dialog.textContent).toContain(
      "Pick a space, then check the projects that belong to it.",
    );
    expect(spaceRows(slot)).toEqual(["Only One1", "Both2"]);
    expect(projectRows(slot)).toEqual(["One", "Two", "Three", "Personal"]);
    expect(slot.getByText("/code/one")).toBeTruthy();
    // One host: no host badges.
    expect(slot.queryByText("MacBook")).toBeNull();
    // The first space is edited by default; the scope is untouched.
    expect(
      slot
        .getByRole("button", { name: /^Only One/ })
        .getAttribute("aria-current"),
    ).toBe("true");
    expect(slot.getByText("Projects in Only One")).toBeTruthy();
    expect(
      parseState(window.localStorage.getItem("bb-plugin-erwin-activity:v1"))
        .spaceId,
    ).toBeNull();

    fireEvent.click(slot.getByRole("button", { name: /^Both/ }));
    expect(slot.getByText("Projects in Both")).toBeTruthy();
    const boxes = slot.getAllByRole("checkbox") as HTMLInputElement[];
    expect(
      boxes.map((box) => [box.getAttribute("aria-label"), box.checked]),
    ).toEqual([
      ["Include One in Both", true],
      ["Include Two in Both", true],
      ["Include Three in Both", false],
      ["Include Personal in Both", false],
    ]);

    fireEvent.click(slot.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    expect(
      slot
        .getByRole("button", { name: /^Threads: / })
        .getAttribute("aria-label"),
    ).toBe("Threads: All projects");
  });

  it("starts on the selected space and renames, reorders, and deletes spaces through nested dialogs", async () => {
    updateState((state) => ({ ...state, spaceId: "both" }));
    const rpc = server();
    const slot = await mountManage(rpc);
    expect(
      slot.getByRole("button", { name: /^Both/ }).getAttribute("aria-current"),
    ).toBe("true");

    await openRowMenu(slot, "Space actions: Only One");
    expect(item(slot, "Move up").getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(item(slot, "Move down"));
    await waitFor(() => expect(rpc.saveSpaces).toHaveBeenCalledTimes(1));
    expect(rpc.saveSpaces.mock.calls[0][0]).toMatchObject({
      spaces: [both, one],
    });
    await waitFor(() =>
      expect(spaceRows(slot)).toEqual(["Both2", "Only One1"]),
    );

    await openRowMenu(slot, "Space actions: Both");
    fireEvent.click(item(slot, "Rename…"));
    const rename = await slot.findByRole("dialog", { name: "Rename space" });
    const input = within(rename).getByRole("textbox", {
      name: "Space name",
    }) as HTMLInputElement;
    expect(input.value).toBe("Both");
    fireEvent.change(input, { target: { value: "Pair" } });
    fireEvent.click(within(rename).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(rpc.saveSpaces).toHaveBeenCalledTimes(2));
    expect(rpc.saveSpaces.mock.calls[1][0]).toMatchObject({
      spaces: [{ ...both, name: "Pair" }, one],
    });
    await waitFor(() =>
      expect(slot.queryByRole("dialog", { name: "Rename space" })).toBeNull(),
    );
    expect(slot.getByText("Projects in Pair")).toBeTruthy();

    await openRowMenu(slot, "Space actions: Pair");
    fireEvent.click(item(slot, "Delete…"));
    const confirm = await slot.findByRole("dialog", { name: "Delete space" });
    expect(confirm.textContent).toContain("Delete space “Pair”?");
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(rpc.saveSpaces).toHaveBeenCalledTimes(3));
    expect(rpc.saveSpaces.mock.calls[2][0]).toMatchObject({ spaces: [one] });
    // Editing falls back to the remaining space; the Manage dialog stays open.
    await waitFor(() =>
      expect(slot.getByText("Projects in Only One")).toBeTruthy(),
    );
    expect(
      slot.getByRole("dialog", { name: "Spaces and projects" }),
    ).toBeTruthy();
  });

  it("creates a space from Manage with its projects and switches to it", async () => {
    const rpc = server();
    const slot = await mountManage(rpc);
    fireEvent.click(slot.getByRole("button", { name: "+ New space…" }));
    const dialog = await slot.findByRole("dialog", { name: "New space" });
    // Nothing pre-checked here; the heading's New space… seeds the open thread's project.
    const boxes = within(dialog).getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.every((box) => !box.checked)).toBe(true);
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: "Space name" }),
      {
        target: { value: "Fresh" },
      },
    );
    fireEvent.click(boxes[2]!);
    expect(dialog.textContent).toContain("1 of 4 selected.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(rpc.saveSpaces).toHaveBeenCalledTimes(1));
    expect(rpc.saveSpaces.mock.calls[0][0]).toMatchObject({
      spaces: [one, both, { name: "Fresh", projectIds: ["project-3"] }],
    });
    await waitFor(() =>
      expect(slot.getByText("Projects in Fresh")).toBeTruthy(),
    );
    expect(
      (
        slot.getByRole("checkbox", {
          name: "Include Three in Fresh",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });

  it("renames, moves, and re-folders a project through BB, and toggles spaces from its menu", async () => {
    const rpc = server();
    const slot = await mountManage(rpc);
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
      expect(projectRows(slot)).toEqual(["One", "Deux", "Three", "Personal"]),
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
      expect(projectRows(slot)).toEqual(["Deux", "One", "Three", "Personal"]),
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

    // The Spaces submenu toggles membership without leaving the view.
    await openRowMenu(slot, "Project actions: Three");
    fireEvent.click(item(slot, "Spaces"));
    await tick();
    fireEvent.click(
      slot.getByRole("menuitemcheckbox", { name: "Both", hidden: true }),
    );
    await waitFor(() => expect(rpc.saveSpaces).toHaveBeenCalledTimes(1));
    expect(rpc.saveSpaces.mock.calls[0][0]).toMatchObject({
      spaces: [
        one,
        { ...both, projectIds: ["project-1", "project-2", "project-3"] },
      ],
    });

    // Close the still-open menus, then check Personal has no destructive actions.
    for (const menu of slot.getAllByRole("menu", { hidden: true }))
      fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() =>
      expect(slot.queryAllByRole("menu", { hidden: true })).toHaveLength(0),
    );
    await openRowMenu(slot, "Project actions: Personal");
    expect(
      slot.queryByRole("menuitem", { name: "Remove…", hidden: true }),
    ).toBeNull();
    expect(
      slot.queryByRole("menuitem", { name: "Rename…", hidden: true }),
    ).toBeNull();
    fireEvent.click(item(slot, "New thread"));
    expect(slot.inspection.sidebarActionCalls).toEqual([
      {
        method: "openNewThread",
        options: { projectId: "personal", focusPrompt: true },
      },
    ]);
  });

  it("removes a project through a confirmation dialog gated on its name, and drops it from spaces", async () => {
    const rpc = server();
    const slot = await mountManage(rpc);
    await openRowMenu(slot, "Project actions: One");
    fireEvent.click(item(slot, "Remove…"));
    const dialog = await slot.findByRole("dialog", { name: "Remove project" });
    expect(dialog.textContent).toContain("its 2 active threads");
    const remove = within(dialog).getByRole("button", {
      name: "Remove",
    }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    const confirm = within(dialog).getByRole("textbox", {
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
      expect(slot.queryByRole("dialog", { name: "Remove project" })).toBeNull(),
    );
    await waitFor(() =>
      expect(projectRows(slot)).toEqual(["Two", "Three", "Personal"]),
    );
  });

  it("adds a project from a typed or picked folder and joins the edited space", async () => {
    const rpc = server();
    const slot = await mountManage(rpc);
    fireEvent.click(slot.getByRole("button", { name: "+ Add project…" }));
    const dialog = await slot.findByRole("dialog", { name: "Add project" });
    expect(dialog.textContent).toContain("The project joins Only One.");
    // One host: no host selector.
    expect(within(dialog).queryByRole("combobox", { name: "Host" })).toBeNull();
    const add = within(dialog).getByRole("button", {
      name: "Add",
    }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);

    fireEvent.click(within(dialog).getByRole("button", { name: "Browse…" }));
    await waitFor(() =>
      expect(rpc.pickFolder).toHaveBeenCalledWith({ hostId: "host-1" }),
    );
    const path = within(dialog).getByRole("combobox", {
      name: "Folder path",
    }) as HTMLInputElement;
    await waitFor(() => expect(path.value).toBe("/picked/gamma"));
    const name = within(dialog).getByRole("textbox", {
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
    await waitFor(() =>
      expect(slot.queryByRole("dialog", { name: "Add project" })).toBeNull(),
    );
    await waitFor(() => expect(projectRows(slot)).toContain("Delta!"));
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
    const slot = await mountManage(server(multi));
    expect(slot.getAllByText("MacBook")).toHaveLength(2);
    expect(slot.getByText("Server")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "+ Add project…" }));
    const host = (await slot.findByRole("combobox", {
      name: "Host",
    })) as HTMLSelectElement;
    expect(host.value).toBe("host-1");
    expect(
      Array.from(host.options).map((option) => option.textContent),
    ).toEqual(["MacBook", "Server (offline)"]);
    slot.lifecycle.unmount();

    const failing = await mountManage({
      ...server(),
      listProjects: async () => {
        throw new Error("offline");
      },
    });
    expect(failing.getByRole("alert").textContent).toContain(
      "Cannot load project folders.",
    );
    // The sidebar's own list still renders.
    expect(projectRows(failing)).toEqual(["One", "Two", "Three", "Personal"]);
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
      "Manage spaces and projects…",
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
    const remove = await slot.findByRole("dialog", { name: "Remove project" });
    expect(remove.textContent).toContain("its 2 active threads");
    fireEvent.keyDown(
      within(remove).getByRole("textbox", {
        name: "Type the project name to confirm",
      }),
      { key: "Escape" },
    );
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());

    fireEvent.contextMenu(header);
    await tick();
    fireEvent.click(item(slot, "Manage spaces and projects…"));
    await slot.findByRole("dialog", { name: "Spaces and projects" });
  });
});
