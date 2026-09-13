// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import {
  loadPluginApp,
  renderSlot as renderSdkSlot,
} from "@get-bb/plugin-sdk/testing/app";
import { parseState, updateState, recordDraft } from "../lib/client-state";
import { thread, visibleStatus } from "./fixtures";

const splitOverride = vi.hoisted(() => ({ enabled: false, drag: vi.fn() }));
const renameOverride = vi.hoisted(() => ({ handler: null as null | ((id: string, title: string) => Promise<void>) }));
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@get-bb/plugin-sdk/app")>();
  return {
    ...actual,
    experimental_useSidebarThreadActions: () => {
      const actions = actual.experimental_useSidebarThreadActions();
      return { ...actions, rename: renameOverride.handler ?? actions.rename };
    },
    experimental_useSidebarThreadSplit: (id: string) =>
      splitOverride.enabled
        ? {
            isAvailable: true,
            splitProps: { onPointerDown: splitOverride.drag },
            layout: null,
          }
        : actual.experimental_useSidebarThreadSplit(id),
  };
});

const app = await loadPluginApp(() => import("../app"));
const mountedSlots: ReturnType<typeof renderSdkSlot>[] = [];
const renderSlot: typeof renderSdkSlot = (registration, props, options) => {
  const slot = renderSdkSlot(registration, props, {
    ...options,
    rpc: {
      listArchived: async () => [],
      archiveTree: async () => ({ ok: true }),
      getLibrary: async () => ({ revision: 0, ids: [] }),
      save: async () => ({ revision: 0, ids: [] }),
      remove: async () => ({ revision: 0, ids: [] }),
      ...options?.rpc,
    },
  });
  mountedSlots.push(slot);
  return slot;
};
// Node 26 also defines a localStorage global; use the actual browser storage.
const localStorage = window.localStorage;
const props = {
  activeThreadId: "working",
  activeProjectId: "project-1",
  isCompactViewport: false,
  searchQuery: "",
  onNavigate: vi.fn(),
  Original: () => <p>BB fallback</p>,
};
const projects = [
  { id: "project-1", name: "One", isPersonal: false },
  { id: "project-2", name: "Two", isPersonal: false },
];
const threads = [
  thread({ id: "done", title: "Read reply" }),
  thread({ id: "unread", title: "New reply", isUnread: true }),
  thread({ id: "working", title: "Running parent", indicator: "runtime" }),
  thread({
    id: "child",
    title: "Blocked child",
    parentThreadId: "working",
    projectId: "project-2",
    hasPendingInteraction: true,
  }),
  thread({ id: "archived", title: "Archived", isArchived: true }),
];
const mount = () =>
  renderSlot(app.threadLists[0], props, {
    sidebarThreads: { threads, projects },
  });
// jsdom has no PointerEvent constructor. Preserve the fields Radix uses.
function touch(target: Element, type: string, pointerType = "touch") {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: 40,
    clientY: 60,
  });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  fireEvent(target, event);
}
beforeEach(() => {
  localStorage.clear();
  updateState(() => parseState(null));
  vi.clearAllMocks();
  renameOverride.handler = null;
});
afterEach(async () => {
  for (const slot of mountedSlots.splice(0)) slot.lifecycle.unmount();
  cleanup();
  // Let portaled menus finish deferred focus restoration before the next mount.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe("activity sidebar", () => {
  it("keeps the name after a failed save and prevents duplicate submissions", async () => {
    let rejectSave!: (error: Error) => void;
    const rename = vi.fn().mockImplementationOnce(() => new Promise<void>((_, reject) => { rejectSave = reject; })).mockResolvedValue(undefined);
    renameOverride.handler = rename;
    const slot = mount();
    fireEvent.contextMenu(slot.container.querySelector('[data-sidebar-thread-id="working"]')!);
    fireEvent.click(within(await slot.findByRole("menu")).getByRole("menuitem", { name: "Rename" }));
    fireEvent.change(slot.getByRole("textbox"), { target: { value: "Retry name" } });
    const form = slot.getByRole("form", { name: "Rename thread" });
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(slot.getByRole("textbox"));
    expect((slot.getByRole("textbox") as HTMLInputElement).readOnly).toBe(true);
    await act(async () => rejectSave(new Error("offline")));
    expect(slot.getByRole("alert").textContent).toContain("Try again");
    expect((slot.getByRole("textbox") as HTMLInputElement).value).toBe("Retry name");
    expect(document.activeElement).toBe(slot.getByRole("textbox"));
    expect((slot.getByRole("textbox") as HTMLInputElement).readOnly).toBe(false);
    fireEvent.submit(form);
    await waitFor(() => expect(slot.queryByRole("textbox")).toBeNull());
    expect(rename).toHaveBeenLastCalledWith("working", "Retry name");
    expect(document.activeElement).toBe(slot.container.querySelector('[data-sidebar-thread-id="working"]'));
  });
  it.each([false, true])("renames a thread in compact mode %s without navigation", async (isCompactViewport) => {
    const slot = renderSlot(app.threadLists[0], { ...props, isCompactViewport }, {
      sidebarThreads: { threads, projects },
    });
    fireEvent.contextMenu(slot.container.querySelector('[data-sidebar-thread-id="child"]')!);
    fireEvent.click(within(await slot.findByRole("menu")).getByRole("menuitem", { name: "Rename" }));
    const input = slot.getByRole("textbox", { name: "Thread name" }) as HTMLInputElement;
    expect(input.value).toBe("Blocked child");
    fireEvent.change(input, { target: { value: "   " } });
    expect((slot.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "  New child name  " } });
    fireEvent.submit(slot.getByRole("form", { name: "Rename thread" }));
    await waitFor(() => expect(slot.queryByRole("textbox")).toBeNull());
    expect(slot.inspection.sidebarActionCalls).toEqual([
      { method: "rename", threadId: "child", title: "New child name" },
    ]);
    expect(props.onNavigate).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(slot.container.querySelector('[data-sidebar-thread-id="child"]'));
  });
  it.each(["Cancel", "Escape", "unchanged"])("closes rename with %s without saving", async (method) => {
    const slot = mount();
    fireEvent.contextMenu(slot.container.querySelector('[data-sidebar-thread-id="working"]')!);
    fireEvent.click(within(await slot.findByRole("menu")).getByRole("menuitem", { name: "Rename" }));
    if (method === "Cancel") fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
    else if (method === "Escape") fireEvent.keyDown(slot.getByRole("textbox"), { key: "Escape" });
    else fireEvent.submit(slot.getByRole("form", { name: "Rename thread" }));
    expect(slot.queryByRole("textbox")).toBeNull();
    expect(slot.inspection.sidebarActionCalls).toEqual([]);
    expect(document.activeElement).toBe(slot.container.querySelector('[data-sidebar-thread-id="working"]'));
  });
  it.each(["status", "project"] as const)(
    "keeps pins above %s groups, including children and filtered statuses",
    (groupBy) => {
      updateState((state) => ({ ...state, groupBy, hidden: ["done"] }));
      const slot = renderSlot(app.threadLists[0], props, {
        sidebarThreads: {
          projects,
          threads: [
            thread({ id: "parent", indicator: "runtime" }),
            thread({
              id: "pin-child",
              parentThreadId: "parent",
              isPinned: true,
              updatedAt: 300,
            }),
            thread({
              id: "pin-parent",
              projectId: "project-2",
              isPinned: true,
              updatedAt: 200,
            }),
            thread({
              id: "child",
              parentThreadId: "pin-parent",
              isUnread: true,
            }),
            thread({ id: "archived-pin", isPinned: true, isArchived: true }),
          ],
        },
      });
      expect(slot.getAllByRole("region")[0].getAttribute("aria-label")).toBe(
        "Pinned",
      );
      const pins = slot.getByRole("list", { name: "Pinned threads" });
      expect(
        Array.from(pins.querySelectorAll("[data-sidebar-thread-id]"), (row) =>
          row.getAttribute("data-sidebar-thread-id"),
        ),
      ).toEqual(["pin-child", "pin-parent", "child"]);
      expect(
        slot.container.querySelectorAll("[data-sidebar-thread-id]"),
      ).toHaveLength(4);
      expect(
        slot.container.querySelector('[data-sidebar-thread-id="child"]'),
      ).not.toBeNull();
      act(() =>
        updateState((state) => ({
          ...state,
          groupBy: groupBy === "status" ? "project" : "status",
        })),
      );
      expect(slot.getAllByRole("region")[0].getAttribute("aria-label")).toBe(
        "Pinned",
      );
    },
  );

  it.each(["status", "project"] as const)(
    "keeps a pinned family together across filters and pin changes in %s view",
    (groupBy) => {
      updateState((state) => ({ ...state, groupBy, hidden: ["done", "working"] }));
      const threads = [
        thread({ id: "grandchild", parentThreadId: "child", isPinned: true }),
        thread({ id: "child", title: "child", parentThreadId: "pin", projectId: "project-2", indicator: "runtime" }),
        thread({ id: "pin", title: "pin", isPinned: true }),
        thread({ id: "archived-child", parentThreadId: "pin", isArchived: true }),
        thread({ id: "other", isUnread: true }),
      ];
      const slot = renderSlot(app.threadLists[0], props, {
        sidebarThreads: { projects, threads },
      });
      const pins = slot.getByRole("list", { name: "Pinned threads" });
      const rowIds = (element: Element) => Array.from(
        element.querySelectorAll("[data-sidebar-thread-id]"),
        (row) => row.getAttribute("data-sidebar-thread-id"),
      );
      expect(rowIds(pins)).toEqual(["pin", "child", "grandchild"]);
      expect(within(pins).getByRole("img", { name: "Working" })).toBeTruthy();
      expect(rowIds(slot.container).sort()).toEqual(["child", "grandchild", "other", "pin"]);
      expect(within(pins).getByRole("list", { name: "Children of pin" })).toBeTruthy();
      expect(within(pins).getByRole("list", { name: "Descendants of child" })).toBeTruthy();

      // Unpin the ancestor: the independently pinned grandchild stays visible.
      threads[2] = { ...threads[2], isPinned: false };
      const Component = app.threadLists[0].component;
      slot.rerender(<Component {...props} />);
      expect(rowIds(slot.getByRole("list", { name: "Pinned threads" }))).toEqual(["grandchild"]);
      expect(rowIds(slot.container).sort()).toEqual(["grandchild", "other"]);
    },
  );

  it("hides the pinned section when there are no pins", () => {
    const slot = mount();
    expect(slot.queryByRole("region", { name: "Pinned" })).toBeNull();
  });

  it("lists No project last, above Archived, in Project view", async () => {
    updateState((state) => ({
      ...state,
      groupBy: "project",
      showArchives: true,
    }));
    const slot = renderSlot(app.threadLists[0], props, {
      sidebarThreads: {
        projects: [
          { id: "personal", name: "Personal", isPersonal: true },
          { id: "project-z", name: "Zeta", isPersonal: false },
          { id: "project-a", name: "Alpha", isPersonal: false },
        ],
        threads: [
          thread({ id: "t-personal", projectId: "personal" }),
          thread({ id: "t-z", projectId: "project-z" }),
          thread({ id: "t-a", projectId: "project-a" }),
        ],
      },
      rpc: { listArchived: async () => archiveRows.slice(0, 1) },
    });
    await slot.findByRole("region", { name: "Archived" });
    expect(
      slot
        .getAllByRole("region")
        .map((region) => region.getAttribute("aria-label")),
    ).toEqual(["Alpha", "Zeta", "No project", "Archived"]);
  });

  it("uses a single-line row under No project", () => {
    updateState((state) => ({ ...state, groupBy: "project" }));
    const environment = {
      id: "env",
      name: "Local",
      branchName: "main",
      providerId: "codex",
      workspaceDisplayKind: "managed-worktree" as const,
    };
    const slot = renderSlot(app.threadLists[0], props, {
      sidebarThreads: {
        projects: [
          { id: "personal", name: "Personal", isPersonal: true },
          { id: "project-1", name: "One", isPersonal: false },
        ],
        threads: [
          thread({ id: "loose", projectId: "personal", environment }),
          thread({ id: "grouped", projectId: "project-1", environment }),
        ],
      },
    });
    const row = (id: string) =>
      slot.container.querySelector(
        `[data-sidebar-thread-id="${id}"]`,
      ) as HTMLElement;
    const lines = (id: string) =>
      Array.from(row(id).children).filter((e) => e.tagName === "SPAN");
    // No project rows hold the title and the age on one line; the branch is
    // omitted because a stray worktree name means nothing there.
    expect(lines("loose")).toHaveLength(1);
    expect(row("loose").textContent).not.toContain("main");
    expect(lines("loose")[0]!.querySelector("time")).not.toBeNull();
    expect(lines("grouped")).toHaveLength(2);
    expect(row("grouped").textContent).toContain("main");
  });

  const archiveRows = ["project-1", "project-2"].map((projectId, index) => ({
    id: `old-${index}`,
    projectId,
    title: `Old thread ${index}`,
    titleFallback: null,
    parentThreadId: null,
    providerId: "codex",
    createdAt: 1,
    updatedAt: 2,
    environmentId: null,
    environmentName: null,
    environmentBranchName: null,
    environmentWorkspaceDisplayKind: "other",
  }));
  it("hides archives until the display setting is enabled", async () => {
    const list = vi.fn(async () => archiveRows);
    const slot = renderSlot(app.threadLists[0], props, {
      sidebarThreads: { projects, threads: [] },
      rpc: { listArchived: list },
    });
    await act(async () => {});
    expect(list).not.toHaveBeenCalled();
    expect(slot.queryByRole("button", { name: "Archived" })).toBeNull();

    fireEvent.keyDown(
      slot.getByRole("button", { name: "Threads display options" }),
      { key: "Enter" },
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const toggle = slot.getByRole("menuitemcheckbox", {
      name: "Archived",
      hidden: true,
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(
      toggle.querySelector("[data-icon]")?.getAttribute("aria-hidden"),
    ).toBe("true");
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(list).toHaveBeenCalledWith({ offset: 0 }),
    );
    const archive = await slot.findByRole("button", {
      name: "Archived",
      hidden: true,
    });
    expect(archive.getAttribute("aria-expanded")).toBe("false");
    expect(
      parseState(localStorage.getItem("bb-plugin-sidebar:v1"))
        .showArchives,
    ).toBe(true);

    fireEvent.click(
      slot.getByRole("menuitemcheckbox", {
        name: "Archived",
        hidden: true,
      }),
    );
    expect(
      slot.queryByRole("button", { name: "Archived", hidden: true }),
    ).toBeNull();
    expect(
      parseState(localStorage.getItem("bb-plugin-sidebar:v1"))
        .showArchives,
    ).toBe(false);
  });
  it.each(["status", "project"] as const)(
    "browses and restores archives in %s view",
    async (groupBy) => {
      updateState((state) => ({
        ...state,
        groupBy,
        hidden: ["done"],
        showArchives: true,
      }));
      const restore = vi.fn(async () => ({ ok: true }));
      const slot = renderSlot(app.threadLists[0], props, {
        sidebarThreads: { projects, threads: [] },
        rpc: { listArchived: async () => archiveRows, restoreThread: restore },
      });
      await waitFor(() =>
        expect(slot.getAllByRole("button", { name: "Archived" })).toHaveLength(
          1,
        ),
      );
      expect(slot.queryByText("Old thread 0")).toBeNull();
      expect(slot.queryByText("No matching threads.")).toBeNull();
      fireEvent.click(slot.getByRole("button", { name: "Archived" }));
      expect(slot.getByText("Old thread 0")).toBeTruthy();
      expect(slot.getByText("Old thread 1")).toBeTruthy();
      const target = slot.container.querySelector(
        '[data-sidebar-thread-id="old-0"]',
      )!;
      const marker = within(target as HTMLElement).getByRole("img", { name: "Archived" });
      expect(
        marker.querySelector("[data-icon]")?.getAttribute("aria-hidden"),
      ).toBe("true");
      expect(marker.parentElement?.firstElementChild?.textContent).toBe("Old thread 0");
      fireEvent.click(target);
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "toThread",
        threadId: "old-0",
      });
      fireEvent.contextMenu(target);
      expect(
        slot.getAllByRole("menuitem").map((item) => item.textContent),
      ).toEqual(["Restore"]);
      fireEvent.click(slot.getByRole("menuitem", { name: "Restore" }));
      await waitFor(() =>
        expect(restore).toHaveBeenCalledWith({ threadId: "old-0" }),
      );
      expect(
        parseState(localStorage.getItem("bb-plugin-sidebar:v1"))
          .expandedArchives,
      ).toEqual(["archive"]);
      fireEvent.click(slot.getByRole("button", { name: "Archived" }));
      expect(slot.queryByText("Old thread 0")).toBeNull();
    },
  );
  it("does not expose split gestures or other active actions for archives", async () => {
    splitOverride.enabled = true;
    try {
      updateState((state) => ({ ...state, showArchives: true }));
      const slot = renderSlot(app.threadLists[0], props, {
        rpc: { listArchived: async () => archiveRows },
      });
      fireEvent.click(await slot.findByRole("button", { name: "Archived" }));
      const row = slot.container.querySelector(
        '[data-sidebar-thread-id="old-0"]',
      )!;
      touch(row, "pointerdown", "mouse");
      expect(splitOverride.drag).not.toHaveBeenCalled();
      fireEvent.click(row, { ctrlKey: true });
      expect(slot.inspection.navigateCalls).toEqual([
        { method: "toThread", threadId: "old-0" },
      ]);
      expect(slot.inspection.sidebarActionCalls).toEqual([]);
      fireEvent.contextMenu(row);
      expect(
        slot.getAllByRole("menuitem").map((item) => item.textContent),
      ).toEqual(["Restore"]);
    } finally {
      splitOverride.enabled = false;
    }
  });
  it("loads every archive page, limits mounted rows, and refreshes on restore signals", async () => {
    updateState((state) => ({ ...state, showArchives: true }));
    const firstPage = Array.from({ length: 200 }, (_, index) => ({
      ...archiveRows[0],
      id: `page-${index}`,
      title: `Page ${index}`,
      updatedAt: 1000 - index,
    }));
    let restored = false;
    const list = vi.fn(async (input: unknown) =>
      restored
        ? []
        : (input as { offset: number }).offset === 0
          ? firstPage
          : [archiveRows[1]],
    );
    const slot = renderSlot(app.threadLists[0], props, {
      rpc: { listArchived: list },
    });
    fireEvent.click(await slot.findByRole("button", { name: "Archived" }));
    expect(list.mock.calls.map(([input]) => input)).toEqual([
      { offset: 0 },
      { offset: 200 },
    ]);
    expect(
      slot.container.querySelectorAll("[data-sidebar-thread-id]"),
    ).toHaveLength(10);
    expect(
      slot.getByRole("button", {
        name: "Show more Archived threads, 191 hidden",
      }),
    ).toBeTruthy();
    restored = true;
    await slot.behavior.emitRealtime("archives-changed", {});
    await waitFor(() =>
      expect(slot.queryByRole("region", { name: "Archived" })).toBeNull(),
    );
  });
  it("retains archive expansion on remount", async () => {
    updateState((state) => ({ ...state, showArchives: true }));
    const options = { rpc: { listArchived: async () => archiveRows } };
    let slot = renderSlot(app.threadLists[0], props, options);
    fireEvent.click(await slot.findByRole("button", { name: "Archived" }));
    slot.unmount();
    slot = renderSlot(app.threadLists[0], props, options);
    expect(await slot.findByText("Old thread 0")).toBeTruthy();
  });
  it("retries archive loading without hiding active threads", async () => {
    updateState((state) => ({ ...state, showArchives: true }));
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValue(archiveRows);
    const slot = renderSlot(app.threadLists[0], props, {
      sidebarThreads: { projects, threads },
      rpc: { listArchived: list },
    });
    await slot.findByText("Cannot load archived threads.");
    expect(slot.getByText("Read reply")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Retry" }));
    await slot.findByRole("button", { name: "Archived" });
    expect(slot.queryByText("Cannot load archived threads.")).toBeNull();
  });
  it("reports restore errors and keeps the archive available", async () => {
    updateState((state) => ({ ...state, showArchives: true }));
    const slot = renderSlot(app.threadLists[0], props, {
      rpc: {
        listArchived: async () => archiveRows,
        restoreThread: async () => {
          throw new Error("Restore failed");
        },
      },
    });
    fireEvent.click(await slot.findByRole("button", { name: "Archived" }));
    fireEvent.contextMenu(
      slot.container.querySelector('[data-sidebar-thread-id="old-0"]')!,
    );
    fireEvent.click(slot.getByRole("menuitem", { name: "Restore" }));
    await slot.findByText("Restore failed");
    expect(slot.getByText("Old thread 0")).toBeTruthy();
  });
  it.each([
    ["Needs Attention", { hasPendingInteraction: true }],
    ["Unread", { isUnread: true }],
    ["Working", { indicator: "runtime" as const }],
    ["Draft", {}],
    ["Done", {}],
  ] as const)(
    "keeps %s child hit areas full width and indents only their contents",
    (label, overrides) => {
      const ids = ["root", "child", "grandchild"];
      if (label === "Draft") {
        updateState((state) => ({
          ...state,
          drafts: ids.map((id) => `thread:${id}`),
        }));
      }
      const slot = renderSlot(app.threadLists[0], props, {
        sidebarThreads: {
          projects,
          threads: ids.map((id, depth) =>
            thread({
              id,
              parentThreadId: depth ? ids[depth - 1] : null,
              ...overrides,
            }),
          ),
        },
      });
      const rows = ids.map(
        (id) =>
          slot.container.querySelector(
            `[data-sidebar-thread-id="${id}"]`,
          ) as HTMLElement,
      );
      rows.forEach((row, depth) => {
        expect(row.style.paddingLeft).toBe(
          ["0.5rem", "1.75rem", "3.25rem"][depth],
        );
        expect(row.parentElement?.className).toBe(
          rows[0].parentElement?.className,
        );
        if (label !== "Done") {
          const marker = within(row).getByRole("img", { name: label });
          // The marker ends the title line; nesting never moves it.
          expect(marker.classList.contains("absolute")).toBe(false);
          expect(marker.style.left).toBe("");
          expect(marker.parentElement?.firstElementChild?.textContent).toBe(
            "Test thread",
          );
          expect(marker.parentElement?.lastElementChild).toBe(marker);
        }
      });
      for (const list of Array.from(
        slot.container.querySelectorAll("[data-thread-children-depth]"),
      )) {
        expect(list.className).toBe("m-0 list-none p-0");
      }
      fireEvent.click(
        label === "Done"
          ? rows[1]
          : within(rows[1]).getByRole("img", { name: label }),
      );
      expect(props.onNavigate).toHaveBeenCalledOnce();
    },
  );

  it.each(["updated", "created"] as const)(
    "pages projects independently with %s sorting",
    (sortBy) => {
      updateState((state) => ({ ...state, groupBy: "project", sortBy }));
      const slot = renderSlot(app.threadLists[0], props, {
        sidebarThreads: {
          projects,
          threads: projects.flatMap((project) =>
            Array.from({ length: 23 }, (_, i) =>
              thread({
                id: `${project.id}-${i}`,
                projectId: project.id,
                updatedAt: 1000 - i,
                createdAt: i,
              }),
            ),
          ),
        },
      });
      const one = slot.getByRole("list", { name: "One threads" });
      const two = slot.getByRole("list", { name: "Two threads" });
      const count = (list: HTMLElement) =>
        list.querySelectorAll("[data-sidebar-thread-id]").length;
      expect(count(one)).toBe(10);
      expect(count(two)).toBe(10);
      expect(
        one
          .querySelector("[data-sidebar-thread-id]")
          ?.getAttribute("data-sidebar-thread-id"),
      ).toBe(`project-1-${sortBy === "updated" ? 0 : 22}`);
      const moreOne = within(one).getByRole("button", {
        name: "Show more One threads, 13 hidden",
      });
      // Root rows start at 0.5rem, so the control keeps only its own padding.
      expect((moreOne.parentElement as HTMLElement).className).not.toMatch(
        /\bpl-/,
      );
      expect(moreOne.classList.contains("px-2")).toBe(true);
      fireEvent.click(moreOne);
      expect(count(one)).toBe(20);
      expect(count(two)).toBe(10);
      const less = within(one).getByRole("button", {
        name: "Show fewer One threads",
      });
      less.focus();
      fireEvent.click(less);
      expect(count(one)).toBe(10);
      expect(document.activeElement).toBe(
        within(one).getByRole("button", {
          name: "Show more One threads, 13 hidden",
        }),
      );
      fireEvent.click(
        within(one).getByRole("button", {
          name: "Show more One threads, 13 hidden",
        }),
      );
      fireEvent.click(
        within(one).getByRole("button", {
          name: "Show more One threads, 3 hidden",
        }),
      );
      expect(count(one)).toBe(23);
      expect(slot.inspection.sidebarActionCalls).toEqual([]);
    },
  );

  it("keeps a selected family visible beyond a thousand project roots and counts new drafts in the page", () => {
    updateState((state) => ({
      ...state,
      groupBy: "project",
      drafts: ["new:project-2"],
    }));
    const slot = renderSlot(
      app.threadLists[0],
      { ...props, activeThreadId: "selected" },
      {
        sidebarThreads: {
          projects,
          threads: [
            ...Array.from({ length: 1000 }, (_, i) =>
              thread({ id: `root-${i}`, updatedAt: 2000 - i }),
            ),
            thread({ id: "selected", parentThreadId: "root-999" }),
            ...Array.from({ length: 10 }, (_, i) =>
              thread({ id: `other-${i}`, projectId: "project-2" }),
            ),
          ],
        },
      },
    );
    const one = slot.getByRole("list", { name: "One threads" });
    expect(one.querySelectorAll("[data-sidebar-thread-id]")).toHaveLength(12);
    expect(
      one.querySelector('[data-sidebar-thread-id="selected"]'),
    ).not.toBeNull();
    expect(
      within(one).getByRole("button", {
        name: "Show more One threads, 989 hidden",
      }),
    ).toBeTruthy();
    const two = slot.getByRole("list", { name: "Two threads" });
    expect(
      within(two).queryByRole("button", { name: /New thread draft/ }),
    ).toBeNull();
    fireEvent.click(
      within(two).getByRole("button", {
        name: "Show more Two threads, 1 hidden",
      }),
    );
    expect(
      within(two).getByRole("button", { name: /New thread draft/ }),
    ).toBeTruthy();
  });

  it.each(["status", "project"] as const)(
    "keeps new drafts without project metadata visible in %s view",
    (groupBy) => {
      updateState((state) => ({
        ...state,
        groupBy,
        drafts: ["new:missing-project", "new:"],
      }));
      const slot = renderSlot(app.threadLists[0], props, {
        sidebarThreads: { projects: [], threads: [] },
      });
      const draft = slot.getByRole("button", {
        name: "New thread draft Draft Unknown project",
      });
      expect(slot.getAllByText("New thread draft")).toHaveLength(1);
      expect(slot.queryByText("No matching threads.")).toBeNull();
      expect(
        slot.getByRole("region", {
          name: groupBy === "status" ? "Draft" : "Unknown project",
        }),
      ).toBeTruthy();
      fireEvent.click(draft);
      expect(slot.inspection.sidebarActionCalls).toEqual([
        {
          method: "openNewThread",
          options: { projectId: "missing-project", focusPrompt: true },
        },
      ]);
      expect(props.onNavigate).toHaveBeenCalledOnce();

      act(() => updateState((state) => ({ ...state, hidden: ["draft"] })));
      expect(slot.queryByText("New thread draft")).toBeNull();
      expect(slot.queryByRole("region")).toBeNull();
      act(() => updateState((state) => ({ ...state, hidden: [] })));
      expect(slot.getAllByText("New thread draft")).toHaveLength(1);

      // Re-mount with a later SDK snapshot; the stored flag is unchanged.
      slot.lifecycle.unmount();
      const loaded = renderSlot(app.threadLists[0], props, {
        sidebarThreads: {
          threads: [],
          projects: [
            { id: "missing-project", name: "Recovered", isPersonal: false },
          ],
        },
      });
      expect(loaded.getAllByText("New thread draft")).toHaveLength(1);
      expect(loaded.queryByText("Unknown project")).toBeNull();
      expect(
        loaded.getByRole("button", {
          name: "New thread draft Draft Recovered",
        }),
      ).toBeTruthy();
    },
  );

  it("keeps unmatched projects and their selected children visible in Project view", () => {
    updateState((state) => ({ ...state, groupBy: "project" }));
    const slot = renderSlot(
      app.threadLists[0],
      { ...props, activeThreadId: "missing-child" },
      {
        sidebarThreads: {
          projects,
          threads: [
            thread({ id: "known", projectId: "project-1" }),
            thread({ id: "missing-parent", projectId: "missing-a" }),
            thread({
              id: "missing-child",
              projectId: "missing-a",
              parentThreadId: "missing-parent",
            }),
            thread({ id: "other-missing", projectId: "missing-b" }),
          ],
        },
      },
    );
    const unknown = slot.getAllByRole("region", { name: "Unknown project" });
    expect(unknown).toHaveLength(2);
    expect(
      unknown[0].querySelectorAll("[data-sidebar-thread-id]"),
    ).toHaveLength(2);
    expect(
      unknown[1].querySelectorAll("[data-sidebar-thread-id]"),
    ).toHaveLength(1);
    const selected = unknown[0].querySelector(
      '[data-sidebar-thread-id="missing-child"]',
    )!;
    expect(selected.getAttribute("aria-current")).toBe("page");
    expect(selected.closest("[data-thread-children-depth]")).not.toBeNull();
    fireEvent.click(
      within(unknown[0]).getByRole("button", { name: "Unknown project" }),
    );
    expect(
      unknown[0].querySelectorAll("[data-sidebar-thread-id]"),
    ).toHaveLength(0);
    expect(
      unknown[1].querySelectorAll("[data-sidebar-thread-id]"),
    ).toHaveLength(1);
  });

  it.each([
    ["Needs Attention", 5, { hasPendingInteraction: true }],
    ["Unread", 5, { isUnread: true }],
    ["Working", 5, { indicator: "runtime" as const }],
    ["Draft", 5, {}],
    ["Done", 10, {}],
  ] as const)("pages %s roots in batches of %i", (label, size, overrides) => {
    const roots = Array.from({ length: size * 2 + 2 }, (_, i) =>
      thread({
        id: `root-${i}`,
        title: `Root ${i}`,
        updatedAt: 1000 - i,
        ...overrides,
      }),
    );
    if (label === "Draft") {
      updateState((state) => ({
        ...state,
        drafts: roots.map((t) => `thread:${t.id}`),
      }));
    }
    const slot = renderSlot(app.threadLists[0], props, {
      sidebarThreads: { threads: roots, projects },
    });
    const list = slot.getByRole("list", { name: `${label} threads` });
    const count = () =>
      list.querySelectorAll("[data-sidebar-thread-id]").length;
    const more = () =>
      within(list).getByRole("button", {
        name: new RegExp(`^Show more ${label}`),
      });
    const less = () =>
      within(list).getByRole("button", { name: `Show fewer ${label} threads` });
    expect(count()).toBe(size);
    expect(more().textContent).toContain(String(size + 2));
    expect(
      list
        .querySelector("[data-sidebar-thread-id]")
        ?.getAttribute("data-sidebar-thread-id"),
    ).toBe("root-0");
    fireEvent.click(more());
    expect(count()).toBe(size * 2);
    less().focus();
    fireEvent.click(less());
    expect(count()).toBe(size);
    expect(document.activeElement).toBe(more());
    fireEvent.click(more());
    more().focus();
    fireEvent.click(more());
    expect(count()).toBe(size * 2 + 2);
    expect(document.activeElement).toBe(less());
    fireEvent.click(less());
    expect(count()).toBe(size);
    fireEvent.click(more());
    const group = slot.getByRole("button", { name: label });
    fireEvent.click(group);
    expect(slot.queryByRole("list", { name: `${label} threads` })).toBeNull();
    fireEvent.click(group);
    expect(
      slot
        .getByRole("list", { name: `${label} threads` })
        .querySelectorAll("[data-sidebar-thread-id]"),
    ).toHaveLength(size);
    expect(slot.inspection.sidebarActionCalls).toEqual([]);
    expect(props.onNavigate).not.toHaveBeenCalled();
  });

  it("shares the Draft limit between existing threads and new-thread drafts", () => {
    const roots = Array.from({ length: 4 }, (_, i) =>
      thread({ id: `draft-${i}` }),
    );
    updateState((state) => ({
      ...state,
      drafts: [
        ...roots.map((t) => `thread:${t.id}`),
        ...projects.map((p) => `new:${p.id}`),
      ],
    }));
    const slot = renderSlot(app.threadLists[0], props, {
      sidebarThreads: { threads: roots, projects },
    });
    const list = slot.getByRole("list", { name: "Draft threads" });
    expect(
      within(list).getAllByRole("button", { name: /New thread draft/ }),
    ).toHaveLength(1);
    expect(list.querySelectorAll("[data-sidebar-thread-id]")).toHaveLength(4);
    fireEvent.click(
      within(list).getByRole("button", {
        name: /Show more Draft threads, 1 hidden/,
      }),
    );
    expect(
      within(list).getAllByRole("button", { name: /New thread draft/ }),
    ).toHaveLength(2);
  });

  it("keeps a selected descendant's family visible beyond a thousand roots", () => {
    const slot = renderSlot(
      app.threadLists[0],
      { ...props, activeThreadId: "selected" },
      {
        sidebarThreads: {
          projects,
          threads: [
            ...Array.from({ length: 1000 }, (_, i) =>
              thread({ id: `root-${i}`, updatedAt: 2000 - i }),
            ),
            thread({ id: "selected", parentThreadId: "root-999" }),
          ],
        },
      },
    );
    const list = slot.getByRole("list", { name: "Done threads" });
    expect(list.querySelectorAll("[data-sidebar-thread-id]")).toHaveLength(12);
    expect(
      list.querySelector('[data-sidebar-thread-id="selected"]'),
    ).not.toBeNull();
    expect(
      list.querySelector('[data-sidebar-thread-id="root-998"]'),
    ).toBeNull();
    expect(
      within(list).getByRole("button", {
        name: /Show more Done threads, 989 hidden/,
      }),
    ).toBeTruthy();
  });

  it.each(["status", "project"] as const)(
    "does not add a root control at the exact limit in %s view",
    (groupBy) => {
      updateState((state) => ({ ...state, groupBy }));
      const slot = renderSlot(app.threadLists[0], props, {
        sidebarThreads: {
          projects,
          threads: Array.from({ length: 10 }, (_, i) =>
            thread({ id: `root-${i}` }),
          ),
        },
      });
      expect(slot.queryByRole("button", { name: /Show more/ })).toBeNull();
      expect(
        slot.container.querySelectorAll("[data-sidebar-thread-id]"),
      ).toHaveLength(10);
    },
  );

  it.each(["status", "project"] as const)(
    "reveals three more children at a time and can shorten the list in %s view",
    (groupBy) => {
      updateState((state) => ({ ...state, groupBy }));
      const slot = renderSlot(app.threadLists[0], props, {
        sidebarThreads: {
          projects,
          threads: [
            thread({ id: "parent", title: "Parent" }),
            ...Array.from({ length: 8 }, (_, i) =>
              thread({
                id: `child-${i}`,
                title: `Child ${i}`,
                parentThreadId: "parent",
                updatedAt: 1000 - i,
              }),
            ),
          ],
        },
      });
      const list = slot.getByRole("list", { name: "Children of Parent" });
      const rowCount = () =>
        list.querySelectorAll("[data-sidebar-thread-id]").length;
      const more = () =>
        within(list).getByRole("button", { name: /^Show more children/ });
      expect(rowCount()).toBe(3);
      expect(more().textContent).toContain("5");
      // The control's text starts where the child rows' text starts:
      // the list item inset plus the button's own 0.5rem padding.
      expect(
        (more().parentElement as HTMLElement).style.paddingLeft,
      ).toBe("1.25rem");
      expect(more().classList.contains("px-2")).toBe(true);
      fireEvent.click(more());
      expect(rowCount()).toBe(6);
      const less = within(list).getByRole("button", {
        name: /^Show fewer children/,
      });
      less.focus();
      fireEvent.click(less);
      expect(rowCount()).toBe(3);
      expect(document.activeElement).toBe(more());
      fireEvent.click(more());
      const finalMore = more();
      finalMore.focus();
      fireEvent.click(finalMore);
      expect(rowCount()).toBe(8);
      expect(document.activeElement).toBe(
        within(list).getByRole("button", { name: /^Show fewer children/ }),
      );
      expect(slot.inspection.sidebarActionCalls).toEqual([]);
      expect(props.onNavigate).not.toHaveBeenCalled();
      fireEvent.click(
        within(list).getByRole("button", { name: /^Show fewer children/ }),
      );
      expect(rowCount()).toBe(3);
    },
  );
  it("caps nesting at children and grandchildren without losing deeper threads", () => {
    const slot = renderSlot(app.threadLists[0], props, {
      sidebarThreads: {
        projects,
        threads: Array.from({ length: 7 }, (_, i) =>
          thread({
            id: `level-${i}`,
            title: `Level ${i}`,
            parentThreadId: i ? `level-${i - 1}` : null,
          }),
        ),
      },
    });
    expect(
      slot.container.querySelectorAll("[data-sidebar-thread-id]"),
    ).toHaveLength(5);
    expect(
      slot.container.querySelector('[data-thread-children-depth="3"]'),
    ).toBeNull();
    const list = slot.getByRole("list", { name: "Descendants of Level 1" });
    fireEvent.click(
      within(list).getByRole("button", { name: /^Show more descendants/ }),
    );
    expect(
      slot.container.querySelectorAll("[data-sidebar-thread-id]"),
    ).toHaveLength(7);
    expect(
      Array.from(list.children).filter((el) =>
        el.hasAttribute("data-thread-node"),
      ),
    ).toHaveLength(5);
    const deepest = list.querySelector('[data-sidebar-thread-id="level-6"]')!;
    fireEvent.focus(deepest);
    expect(
      document.querySelector('[data-thread-info="level-6"]')?.textContent,
    ).toContain("Level 5");
    fireEvent.click(deepest);
    expect(slot.inspection.sidebarActionCalls).toEqual([
      { method: "open", threadId: "level-6", options: { split: false } },
    ]);
  });
  it("keeps the selected descendant visible without expanding every preceding sibling", () => {
    const slot = renderSlot(
      app.threadLists[0],
      { ...props, activeThreadId: "deep-active" },
      {
        sidebarThreads: {
          projects,
          threads: [
            thread({ id: "parent", title: "Parent" }),
            ...Array.from({ length: 1000 }, (_, i) =>
              thread({
                id: `child-${i}`,
                parentThreadId: "parent",
                updatedAt: 2000 - i,
              }),
            ),
            thread({
              id: "deep-active",
              parentThreadId: "child-999",
              indicator: "runtime",
            }),
          ],
        },
      },
    );
    expect(
      slot.container.querySelectorAll("[data-sidebar-thread-id]"),
    ).toHaveLength(6);
    expect(
      slot.container
        .querySelector('[aria-current="page"]')
        ?.getAttribute("data-sidebar-thread-id"),
    ).toBe("deep-active");
    expect(
      within(slot.getByRole("region", { name: "Working" })).getByRole(
        "button",
        { name: /996 hidden/ },
      ),
    ).toBeTruthy();
  });
  it("still groups by a hidden descendant's status and unmounts rows in a closed group", () => {
    const slot = renderSlot(app.threadLists[0], props, {
      sidebarThreads: {
        projects,
        threads: [
          thread({ id: "parent", title: "Parent" }),
          ...Array.from({ length: 4 }, (_, i) =>
            thread({
              id: `child-${i}`,
              parentThreadId: "parent",
              updatedAt: 1000 - i,
              hasPendingInteraction: i === 3,
            }),
          ),
        ],
      },
    });
    expect(
      slot.container.querySelector('[data-sidebar-thread-id="child-3"]'),
    ).toBeNull();
    const group = slot.getByRole("region", { name: "Needs Attention" });
    expect(
      group.querySelector('[data-sidebar-thread-id="parent"]'),
    ).not.toBeNull();
    fireEvent.click(
      within(group).getByRole("button", { name: "Needs Attention" }),
    );
    expect(
      slot.container.querySelectorAll("[data-sidebar-thread-id]"),
    ).toHaveLength(0);
  });
  it.each([false, true])(
    "uses whole-sidebar scrolling only in compact mode: %s",
    (isCompactViewport) => {
      const slot = renderSlot(
        app.threadLists[0],
        { ...props, isCompactViewport },
        { sidebarThreads: { threads, projects } },
      );
      const root = slot.container.querySelector("[data-activity-sidebar]")!;
      const groups = root.querySelector("[data-activity-thread-groups]")!;
      const styles = root.querySelector("[data-activity-mobile-scroll]");
      expect(root.hasAttribute("data-mobile-scroll")).toBe(isCompactViewport);
      expect(groups.classList.contains("overflow-y-auto")).toBe(
        !isCompactViewport,
      );
      expect(root.classList.contains("h-full")).toBe(!isCompactViewport);
      expect(Boolean(styles)).toBe(isCompactViewport);
      if (styles) {
        // Host overrides are gated by this mounted list, not by a global
        // viewport selector that would also change other sidebar providers.
        expect(styles.textContent).toContain(
          ":has([data-activity-sidebar][data-mobile-scroll])",
        );
        slot.lifecycle.unmount();
        expect(
          document.querySelector("[data-activity-mobile-scroll]"),
        ).toBeNull();
      }
    },
  );
  it.each(["working", "child"])(
    "archives the selected %s thread through the recursive RPC",
    async (id) => {
      const slot = mount();
      const row = slot.container.querySelector(
        `[data-sidebar-thread-id="${id}"]`,
      )!;
      fireEvent.contextMenu(row);
      const menu = await slot.findByRole("menu");
      expect(slot.inspection.sidebarActionCalls).toEqual([]);
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Archive" }));
      await waitFor(() => expect(slot.inspection.rpcCalls).toContainEqual({
        method: "archiveTree", input: { threadId: id },
      }));
      expect(slot.inspection.sidebarActionCalls).toEqual([]);
      expect(props.onNavigate).not.toHaveBeenCalled();
      expect(slot.queryByRole("menu")).toBeNull();
    },
  );
  it("shows recursive archive failures without hiding the active row", async () => {
    const slot = renderSlot(app.threadLists[0], props, {
      sidebarThreads: { threads, projects },
      rpc: { archiveTree: async () => { throw new Error("Archive stopped after 1 of 3 threads."); } },
    });
    fireEvent.contextMenu(slot.container.querySelector('[data-sidebar-thread-id="working"]')!);
    fireEvent.click(await slot.findByRole("menuitem", { name: "Archive" }));
    await slot.findByText("Archive stopped after 1 of 3 threads.");
    expect(slot.getByText("Running parent")).toBeTruthy();
  });
  it("opens row actions on right-click without an actions button or navigation", async () => {
    const slot = mount();
    expect(slot.queryByRole("button", { name: /^Actions for/ })).toBeNull();
    const row = slot.container.querySelector(
      '[data-sidebar-thread-id="unread"]',
    )!;
    fireEvent.contextMenu(row, { clientX: 40, clientY: 60 });
    const menu = await slot.findByRole("menu", {
      name: "Actions for New reply",
    });
    expect(menu.hasAttribute("data-bb-portaled-overlay")).toBe(true);
    expect(
      document.querySelector("[data-thread-touch-selection-guard]"),
    ).toBeNull();
    expect(slot.inspection.sidebarActionCalls).toEqual([]);
    expect(props.onNavigate).not.toHaveBeenCalled();
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Mark as read" }),
    );
    expect(slot.inspection.sidebarActionCalls).toEqual([
      { method: "setRead", threadId: "unread", read: true },
    ]);
  });
  it.each([{ key: "ContextMenu" }, { key: "F10", shiftKey: true }])(
    "opens row actions from the keyboard with $key",
    async (key) => {
      const slot = mount();
      const row = slot.container.querySelector(
        '[data-sidebar-thread-id="done"]',
      )!;
      (row as HTMLElement).focus();
      fireEvent.keyDown(row, key);
      const menu = await slot.findByRole("menu", {
        name: "Actions for Read reply",
      });
      expect(slot.inspection.sidebarActionCalls).toEqual([]);
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Pin" }));
      expect(slot.inspection.sidebarActionCalls).toEqual([
        { method: "setPinned", threadId: "done", pinned: true },
      ]);
    },
  );
  it("reparents a nested thread through the row menu and detaches to top level", async () => {
    const setParent = vi.fn().mockResolvedValue({ ok: true });
    const slot = renderSlot(app.threadLists[0], props, {
      sidebarThreads: { threads, projects },
      rpc: { setParent },
    });
    const childrenOf = (title: string) =>
      slot.queryAllByRole("list", {
        name: (name) => name.startsWith(`Children of ${title}`),
      });
    expect(childrenOf("Blocked child")).toHaveLength(0);

    fireEvent.contextMenu(
      slot.container.querySelector('[data-sidebar-thread-id="child"]')!,
    );
    const menu = await slot.findByRole("menu", {
      name: "Actions for Blocked child",
    });
    // Its own parent must not be offered as a candidate.
    const trigger = within(menu).getByRole("menuitem", {
      name: "Make child of…",
    });
    fireEvent.pointerMove(trigger);
    fireEvent.keyDown(trigger, { key: "ArrowRight" });
    const subMenu = await waitFor(() =>
      within(document.body)
        .getAllByRole("menu")
        .find((candidate) => !candidate.hasAttribute("aria-label")),
    );
    expect(
      within(subMenu!).queryByRole("menuitem", { name: "Running parent" }),
    ).toBeNull();
    fireEvent.click(
      within(subMenu!).getByRole("menuitem", { name: "Read reply" }),
    );
    expect(setParent).toHaveBeenCalledWith({
      threadId: "child",
      parentThreadId: "done",
    });
    // The local override nests the row immediately.
    expect(childrenOf("Read reply")).toHaveLength(1);

    fireEvent.contextMenu(
      slot.container.querySelector('[data-sidebar-thread-id="child"]')!,
    );
    const menu2 = await slot.findByRole("menu", {
      name: "Actions for Blocked child",
    });
    fireEvent.click(
      within(menu2).getByRole("menuitem", { name: "Move to top level" }),
    );
    expect(setParent).toHaveBeenLastCalledWith({
      threadId: "child",
      parentThreadId: null,
    });
    expect(childrenOf("Read reply")).toHaveLength(0);
  });
  it("rolls back the local nesting when setParent fails", async () => {
    const setParent = vi.fn().mockRejectedValue(new Error("depth limit"));
    const slot = renderSlot(app.threadLists[0], props, {
      sidebarThreads: { threads, projects },
      rpc: { setParent },
    });
    fireEvent.contextMenu(
      slot.container.querySelector('[data-sidebar-thread-id="child"]')!,
    );
    const menu = await slot.findByRole("menu", {
      name: "Actions for Blocked child",
    });
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Move to top level" }),
    );
    expect(setParent).toHaveBeenCalledWith({
      threadId: "child",
      parentThreadId: null,
    });
    await waitFor(() =>
      expect(
        slot.container.querySelector(
          '[data-thread-children-depth="1"] [data-sidebar-thread-id="child"]',
        ),
      ).toBeTruthy(),
    );
    await waitFor(() =>
      expect(slot.getByRole("alert").textContent).toContain("depth limit"),
    );
  });
  it("keeps a newer reparent when an earlier overlapping request fails", async () => {
    let rejectFirst!: (error: Error) => void;
    const setParent = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ ok: boolean }>((_, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockResolvedValue({ ok: true });
    const slot = renderSlot(app.threadLists[0], props, {
      sidebarThreads: { threads, projects },
      rpc: { setParent },
    });
    const childrenOf = (title: string) =>
      slot.queryAllByRole("list", {
        name: (name) => name.startsWith(`Children of ${title}`),
      });
    const reparentViaMenu = async (target: string) => {
      fireEvent.contextMenu(
        slot.container.querySelector('[data-sidebar-thread-id="child"]')!,
      );
      const menu = await slot.findByRole("menu", {
        name: "Actions for Blocked child",
      });
      const trigger = within(menu).getByRole("menuitem", {
        name: "Make child of…",
      });
      fireEvent.pointerMove(trigger);
      fireEvent.keyDown(trigger, { key: "ArrowRight" });
      const subMenu = await waitFor(() =>
        within(document.body)
          .getAllByRole("menu")
          .find((candidate) => !candidate.hasAttribute("aria-label")),
      );
      fireEvent.click(within(subMenu!).getByRole("menuitem", { name: target }));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    await reparentViaMenu("Read reply");
    expect(childrenOf("Read reply")).toHaveLength(1);
    await reparentViaMenu("New reply");
    expect(childrenOf("New reply")).toHaveLength(1);
    expect(childrenOf("Read reply")).toHaveLength(0);
    // The earlier request fails late; the newer override must survive.
    await act(async () => rejectFirst(new Error("offline")));
    expect(childrenOf("New reply")).toHaveLength(1);
    await waitFor(() =>
      expect(slot.getByRole("alert").textContent).toContain("offline"),
    );
  });
  it("offers every valid candidate parent without truncating the list", async () => {
    const many = [
      thread({ id: "source", title: "Source", projectId: "project-1" }),
      ...Array.from({ length: 40 }, (_, index) =>
        thread({
          id: `candidate-${index}`,
          title: `Candidate ${index}`,
          projectId: "project-1",
          updatedAt: index,
        }),
      ),
    ];
    const slot = renderSlot(app.threadLists[0], props, {
      sidebarThreads: { threads: many, projects },
    });
    fireEvent.contextMenu(
      slot.container.querySelector('[data-sidebar-thread-id="source"]')!,
    );
    const menu = await slot.findByRole("menu", { name: "Actions for Source" });
    const trigger = within(menu).getByRole("menuitem", {
      name: "Make child of…",
    });
    fireEvent.pointerMove(trigger);
    fireEvent.keyDown(trigger, { key: "ArrowRight" });
    const subMenu = await waitFor(() =>
      within(document.body)
        .getAllByRole("menu")
        .find((candidate) => !candidate.hasAttribute("aria-label")),
    );
    expect(within(subMenu!).getAllByRole("menuitem")).toHaveLength(40);
    // The oldest candidate is the first a cap would drop.
    expect(
      within(subMenu!).getByRole("menuitem", { name: "Candidate 0" }),
    ).toBeTruthy();
  });
  it("does not swallow the click after Escape when no drag is active", async () => {
    const slot = mount();
    const row = slot.container.querySelector(
      '[data-sidebar-thread-id="unread"]',
    )!;
    fireEvent.keyDown(row, { key: "Escape" });
    fireEvent.click(row);
    expect(props.onNavigate).toHaveBeenCalledOnce();
  });
  it("opens a child's menu after a long press and suppresses the release click", async () => {
    const slot = mount();
    const row = slot.container.querySelector(
      '[data-sidebar-thread-id="child"]',
    )!;
    vi.useFakeTimers();
    try {
      touch(row, "pointerdown");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(449);
      });
      expect(slot.queryByRole("menu")).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(
        slot.getByRole("menu", { name: "Actions for Blocked child" }),
      ).toBeTruthy();
      expect(
        slot.queryByRole("menu", { name: "Actions for Running parent" }),
      ).toBeNull();
      touch(row, "pointerup");
      fireEvent.click(row, { detail: 1 });
      expect(slot.inspection.sidebarActionCalls).toEqual([]);
      fireEvent.keyDown(slot.getByRole("menu"), { key: "Escape" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(slot.queryByRole("menu")).toBeNull();
      touch(row, "pointerdown");
      touch(row, "pointerup");
      fireEvent.click(row);
      expect(slot.inspection.sidebarActionCalls).toEqual([
        { method: "open", threadId: "child", options: { split: false } },
      ]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });
      expect(slot.queryByRole("menu")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(["dismiss", "unmount"])(
    "blocks background text selection only while a touch menu is open, then restores it on %s",
    async (finish) => {
      const slot = mount();
      const row = slot.container.querySelector(
        '[data-sidebar-thread-id="child"]',
      )!;
      const panel = document.createElement("div");
      panel.textContent = "Existing main panel selection";
      panel.style.userSelect = "text";
      document.body.append(panel);
      vi.useFakeTimers();
      try {
        touch(row, "pointerdown");
        expect(
          document.querySelector("[data-thread-touch-selection-guard]"),
        ).toBeNull();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(450);
        });
        touch(row, "pointerup");
        expect(
          document.querySelectorAll("[data-thread-touch-selection-guard]"),
        ).toHaveLength(1);
        for (const type of ["selectstart", "contextmenu"]) {
          const event = new Event(type, { bubbles: true, cancelable: true });
          fireEvent(panel, event);
          expect(event.defaultPrevented).toBe(true);
        }
        if (finish === "dismiss") {
          fireEvent.keyDown(slot.getByRole("menu"), { key: "Escape" });
        } else {
          slot.lifecycle.unmount();
        }
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10);
        });
        expect(
          document.querySelector("[data-thread-touch-selection-guard]"),
        ).toBeNull();
        const event = new Event("selectstart", {
          bubbles: true,
          cancelable: true,
        });
        fireEvent(panel, event);
        expect(event.defaultPrevented).toBe(false);
        expect(panel.style.userSelect).toBe("text");
      } finally {
        panel.remove();
        vi.useRealTimers();
      }
    },
  );
  it("keeps BB's programmatic shortcut clicks working after a menu closes", async () => {
    const slot = mount();
    const row = slot.container.querySelector(
      '[data-sidebar-thread-id="done"]',
    )!;
    fireEvent.contextMenu(row);
    const menu = await slot.findByRole("menu");
    fireEvent.keyDown(menu, { key: "Escape" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.click(row, { detail: 0 });
    expect(slot.inspection.sidebarActionCalls).toEqual([
      { method: "open", threadId: "done", options: { split: false } },
    ]);
  });
  it.each(["pointerup", "pointermove", "pointercancel"])(
    "cancels a pending long press on %s",
    async (type) => {
      const slot = mount();
      const row = slot.container.querySelector(
        '[data-sidebar-thread-id="done"]',
      )!;
      vi.useFakeTimers();
      try {
        touch(row, "pointerdown");
        await act(async () => {
          await vi.advanceTimersByTimeAsync(100);
        });
        touch(row, type);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(750);
        });
        expect(slot.queryByRole("menu")).toBeNull();
        expect(slot.inspection.sidebarActionCalls).toEqual([]);
        if (type === "pointerup") {
          fireEvent.click(row);
          expect(slot.inspection.sidebarActionCalls).toEqual([
            { method: "open", threadId: "done", options: { split: false } },
          ]);
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it.each(["status", "project"] as const)(
    "uses the same status markers for children and parents in %s view",
    (groupBy) => {
      updateState((state) => ({ ...state, groupBy }));
      const slot = renderSlot(app.threadLists[0], props, {
        sidebarThreads: {
          projects,
          threads: [
            thread({ id: "parent", title: "Parent", indicator: "runtime" }),
            thread({
              id: "done",
              title: "Child done",
              parentThreadId: "parent",
            }),
            thread({
              id: "working",
              title: "Child working",
              parentThreadId: "parent",
              indicator: "runtime",
            }),
            thread({
              id: "unread",
              title: "Child unread",
              parentThreadId: "parent",
              isUnread: true,
            }),
            thread({
              id: "attention",
              title: "Child attention",
              parentThreadId: "parent",
              hasPendingInteraction: true,
            }),
            thread({
              id: "draft",
              title: "Child draft",
              parentThreadId: "parent",
            }),
          ],
        },
      });
      act(() => recordDraft("thread:draft", true));
      const children = slot.getByRole("list", { name: "Children of Parent" });
      fireEvent.click(
        within(children).getByRole("button", { name: /^Show more children/ }),
      );
      for (const [id, label] of [
        ["done", "Done"],
        ["working", "Working"],
        ["unread", "Unread"],
        ["attention", "Needs Attention"],
        ["draft", "Draft"],
      ]) {
        const row = children.querySelector(
          `[data-sidebar-thread-id="${id}"]`,
        ) as HTMLElement;
        expect(within(row).queryByText(label)).toBeNull();
        if (id === "done") {
          expect(within(row).queryByRole("img")).toBeNull();
        } else {
          const marker = within(row).getByRole("img", { name: label });
          if (id === "unread") {
            expect(marker.querySelector(".bg-sky-600")).not.toBeNull();
            expect(marker.querySelector("svg")).toBeNull();
          } else {
            expect(marker.querySelector("svg")).not.toBeNull();
            if (id === "working") {
              const parent = slot.container.querySelector(
                '[data-sidebar-thread-id="parent"]',
              ) as HTMLElement;
              expect(marker.innerHTML).toBe(
                within(parent).getByRole("img", { name: "Working" }).innerHTML,
              );
            }
          }
        }
      }
    },
  );
  it("cancels the long press when its row unmounts", async () => {
    const slot = mount();
    vi.useFakeTimers();
    try {
      touch(
        slot.container.querySelector('[data-sidebar-thread-id="child"]')!,
        "pointerdown",
      );
      slot.lifecycle.unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(slot.inspection.sidebarActionCalls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
  it("uses plain group labels and status icons for attention, draft, and working, plus unread dots", () => {
    const slot = mount();
    act(() => {
      recordDraft("thread:done", true);
      recordDraft("new:project-1", true);
    });
    for (const group of slot.getAllByRole("region")) {
      const header = group.querySelector(":scope > button")!;
      expect(header.textContent).toBe(group.getAttribute("aria-label"));
      expect(header.hasAttribute("title")).toBe(false);
      expect(header.querySelectorAll("[data-icon]")).toHaveLength(1);
      expect(
        header.querySelector("[data-icon='ChevronDown']"),
      ).not.toBeNull();
    }
    const working = slot.container.querySelector(
      '[data-sidebar-thread-id="working"]',
    )!;
    expect(
      within(working as HTMLElement)
        .getByRole("img", { name: "Working" })
        .querySelector("svg"),
    ).not.toBeNull();
    const unread = slot.container.querySelector(
      '[data-sidebar-thread-id="unread"]',
    )!;
    expect(
      within(unread as HTMLElement)
        .getByRole("img", { name: "Unread" })
        .querySelector("svg"),
    ).toBeNull();
    expect(unread.querySelector(".rounded-full")).not.toBeNull();
    const draft = slot.container.querySelector(
      '[data-sidebar-thread-id="done"]',
    )!;
    expect(
      within(draft as HTMLElement)
        .getByRole("img", { name: "Draft" })
        .querySelector("svg"),
    ).not.toBeNull();
    const attention = slot.container.querySelector(
      '[data-sidebar-thread-id="child"]',
    )!;
    expect(
      within(attention as HTMLElement)
        .getByRole("img", { name: "Needs Attention" })
        .querySelector("svg"),
    ).not.toBeNull();
    expect(slot.getByText("New thread draft")).toBeTruthy();
    expect(
      within(
        slot.getByRole("button", { name: "New thread draft Draft One" }),
      ).getByRole("img", { name: "Draft" }),
    ).toBeTruthy();
  });
  it("uses an inset arrow inside each child row instead of an outside connecting line", () => {
    const slot = renderSlot(app.threadLists[0], props, {
      sidebarThreads: {
        projects,
        threads: [
          thread({ id: "parent", title: "Done parent" }),
          thread({
            id: "child",
            title: "Done child",
            parentThreadId: "parent",
          }),
          thread({
            id: "grandchild",
            title: "Draft child",
            parentThreadId: "child",
          }),
        ],
      },
    });
    act(() => recordDraft("thread:grandchild", true));
    const parent = slot.container.querySelector(
      '[data-sidebar-thread-id="parent"]',
    )!;
    const child = slot.container.querySelector(
      '[data-sidebar-thread-id="child"]',
    )!;
    const grandchild = slot.container.querySelector(
      '[data-sidebar-thread-id="grandchild"]',
    )!;
    expect(parent.querySelector("[data-child-arrow]")).toBeNull();
    expect(child.querySelector("[data-child-arrow]")).not.toBeNull();
    expect(within(child as HTMLElement).queryByRole("img")).toBeNull();
    expect((parent as HTMLElement).style.paddingLeft).toBe("0.5rem");
    expect((child as HTMLElement).style.paddingLeft).toBe("1.75rem");
    expect(
      (child.querySelector("[data-child-arrow]") as SVGElement).style.left,
    ).toBe("0.5rem");
    expect(grandchild.querySelector("[data-child-arrow]")).not.toBeNull();
    expect(
      within(grandchild as HTMLElement).getByRole("img", { name: "Draft" }),
    ).toBeTruthy();
    expect((grandchild as HTMLElement).style.paddingLeft).toBe("3.25rem");
    expect(
      (grandchild.querySelector("[data-child-arrow]") as SVGElement).style.left,
    ).toBe("2rem");
    expect(
      within(grandchild as HTMLElement)
        .getByRole("img", { name: "Draft" })
        .classList.contains("absolute"),
    ).toBe(false);
    for (const list of slot.getAllByRole("list", { name: /Children of/ })) {
      expect(list.classList.contains("border-l")).toBe(false);
      expect(list.className).toBe("m-0 list-none p-0");
    }
  });
  it("nests children in their family's priority group, excludes archives, and preserves shortcuts", () => {
    const slot = mount();
    expect(
      slot
        .getAllByRole("region")
        .map((region) => region.getAttribute("aria-label")),
    ).toEqual(["Needs Attention", "Unread", "Done"]);
    const children = slot.getByRole("list", {
      name: "Children of Running parent",
    });
    expect(within(children).getByText("Blocked child")).toBeTruthy();
    expect(children.closest("section")?.getAttribute("aria-label")).toBe(
      "Needs Attention",
    );
    expect(
      slot.container.querySelectorAll('[data-sidebar-thread-id="child"]'),
    ).toHaveLength(1);
    expect(
      within(slot.getByRole("region", { name: "Needs Attention" })).getByText(
        "Blocked child",
      ),
    ).toBeTruthy();
    expect(slot.queryByText("Archived")).toBeNull();
    const target = slot.container.querySelector(
      '[data-sidebar-thread-id="working"]',
    )!;
    expect(target.getAttribute("aria-current")).toBe("page");
    expect(target).toBeInstanceOf(HTMLAnchorElement);
    fireEvent.click(target);
    expect(slot.inspection.sidebarActionCalls).toContainEqual({
      method: "open",
      threadId: "working",
      options: { split: false },
    });
    expect(props.onNavigate).toHaveBeenCalledOnce();
  });
  it("nests mixed-status children in Project view and preserves child actions", async () => {
    updateState((state) => ({ ...state, groupBy: "project" }));
    const slot = renderSlot(app.threadLists[0], props, {
      sidebarThreads: {
        projects,
        threads: [
          thread({ id: "parent", title: "Parent" }),
          thread({
            id: "child",
            title: "Question",
            parentThreadId: "parent",
            hasPendingInteraction: true,
          }),
        ],
      },
    });
    const children = slot.getByRole("list", { name: "Children of Parent" });
    expect(within(children).queryByText("Needs Attention")).toBeNull();
    expect(
      within(children).getByRole("img", { name: "Needs Attention" }),
    ).toBeTruthy();
    fireEvent.click(within(children).getByRole("link"), { metaKey: true });
    expect(slot.inspection.sidebarActionCalls).toContainEqual({
      method: "open",
      threadId: "child",
      options: { split: true },
    });
    fireEvent.contextMenu(within(children).getByRole("link"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.click(
      slot.getByRole("menuitem", { name: "Mark as unread", hidden: true }),
    );
    expect(slot.inspection.sidebarActionCalls).toContainEqual({
      method: "setRead",
      threadId: "child",
      read: false,
    });
  });
  it("shows a child when its parent is hidden or archived", () => {
    updateState((state) => ({ ...state, hidden: ["done"] }));
    const slot = renderSlot(app.threadLists[0], props, {
      sidebarThreads: {
        projects,
        threads: [
          thread({ id: "hidden", title: "Hidden parent" }),
          thread({
            id: "child",
            title: "Visible child",
            parentThreadId: "hidden",
            isUnread: true,
          }),
          thread({ id: "archived", isArchived: true }),
          thread({
            id: "orphan",
            title: "Archived parent child",
            parentThreadId: "archived",
            hasPendingInteraction: true,
          }),
        ],
      },
    });
    expect(slot.queryByText("Hidden parent")).toBeNull();
    expect(slot.getByText("Visible child")).toBeTruthy();
    expect(slot.getByText("Archived parent child")).toBeTruthy();
    expect(slot.queryByRole("list", { name: /Children of/ })).toBeNull();
  });
  it("shows Threads without filters and ignores the old saved project selector", () => {
    updateState(() => parseState(JSON.stringify({ projectId: "project-1" })));
    const slot = mount();
    expect(slot.getByRole("button", { name: "Threads: All projects" })).toBeTruthy();
    expect(slot.queryByRole("textbox")).toBeNull();
    expect(slot.queryByRole("combobox")).toBeNull();
    expect(slot.getByText("New reply")).toBeTruthy();
    expect(slot.getByText("Blocked child")).toBeTruthy();
    expect(slot.inspection.sidebarActionCalls).toEqual([]);
  });
  it("hides empty categories and shows one clear message when nothing matches", () => {
    const slot = mount();
    expect(slot.queryByRole("region", { name: "Draft" })).toBeNull();
    slot.unmount();
    const empty = renderSlot(app.threadLists[0], props, {
      sidebarThreads: { projects, threads: [] },
    });
    expect(empty.queryAllByRole("region")).toHaveLength(0);
    expect(empty.getByText("No matching threads.")).toBeTruthy();
  });
  it("shows an instant, structured info card with no native tooltips", async () => {
    const slot = renderSlot(app.threadLists[0], props, {
      sidebarThreads: {
        projects,
        threads: [
          thread({
            host: { id: "host", name: "Development Mac" },
            environment: {
              id: "env",
              name: "Local",
              branchName: "feature/activity",
              providerId: null,
              workspaceDisplayKind: "managed-worktree",
            },
          }),
        ],
      },
    });
    const link = slot.getByRole("link");
    expect(link.textContent).toContain("Test thread");
    expect(link.textContent).toContain("One");
    expect(link.textContent).toContain("feature/activity");
    expect(link.textContent).not.toContain("codex");
    expect(link.hasAttribute("title")).toBe(false);
    expect(link.querySelector("[title]")).toBeNull();
    expect(link.querySelector("time")?.getAttribute("datetime")).toBe(
      new Date(100).toISOString(),
    );
    vi.useFakeTimers();
    try {
      touch(link, "pointermove", "mouse");
      // Radix schedules a zero-delay timer, not a hover dwell delay.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    } finally {
      vi.useRealTimers();
    }
    const tooltip = slot.getByRole("tooltip");
    expect(link.getAttribute("aria-describedby")).toBe(tooltip.id);
    const card = document.querySelector('[data-thread-info="thread-1"]')!;
    expect(card.hasAttribute("data-bb-portaled-overlay")).toBe(true);
    for (const label of [
      "Project",
      "Branch",
      "Machine",
      "Workspace",
      "Created",
      "Updated",
    ]) {
      expect(
        Array.from(card.querySelectorAll("dt")).some(
          (e) => e.textContent === label,
        ),
      ).toBe(true);
    }
    for (const value of [
      "codex",
      "Development Mac",
      "Worktree · Local",
      "feature/activity",
    ]) {
      expect(card.textContent).toContain(value);
    }
    expect(card.textContent).not.toContain("Manage Environment");
    expect(slot.inspection.sidebarActionCalls).toEqual([]);
  });
  it("shows the pull request, project, and branch with a right-aligned age, and the PR in the info card", async () => {
    const slot = renderSlot(app.threadLists[0], props, {
      sidebarThreads: {
        projects,
        threads: [
          thread({
            id: "open",
            title: "Open",
            updatedAt: 100,
            environment: {
              id: "env",
              name: "Local",
              branchName: "feat/prod-step",
              providerId: null,
              workspaceDisplayKind: "managed-worktree",
            },
          }),
          thread({ id: "merged", title: "Merged", updatedAt: 100 }),
          thread({ id: "none", title: "None", updatedAt: 100 }),
        ],
      },
      sidebarPullRequests: {
        open: {
          number: 2683,
          title: "Reduce prod step overhead",
          url: "https://github.com/example/capy/pull/2683",
          state: "open",
          attention: "checks_failed",
        },
        merged: {
          number: 12,
          title: "Ship it",
          url: "https://github.com/example/capy/pull/12",
          state: "merged",
          attention: "merged",
        },
      },
    });
    const row = (id: string) =>
      slot.container.querySelector(
        `[data-sidebar-thread-id="${id}"]`,
      ) as HTMLElement;
    const lines = (id: string) =>
      Array.from(row(id).children).filter((e) => e.tagName === "SPAN");
    // Title line, then one metadata line.
    expect(lines("open")).toHaveLength(2);
    const meta = lines("open")[1] as HTMLElement;
    // PR · project · branch on the left, age last.
    expect(meta.firstElementChild?.textContent).toBe("#2683·One·feat/prod-step");
    expect(meta.lastElementChild?.tagName).toBe("TIME");
    expect(
      within(meta).getByRole("img", {
        name: "Open pull request #2683, checks failed",
      }),
    ).toBeTruthy();
    expect(row("open").textContent).not.toContain("Reduce prod step overhead");
    expect(
      within(lines("merged")[1] as HTMLElement).getByRole("img", {
        name: "Merged pull request #12",
      }),
    ).toBeTruthy();
    expect(lines("none")[1]!.firstElementChild?.textContent).toBe("One");
    expect(lines("none")[1]!.querySelector("time")).not.toBeNull();
    expect(row("none").querySelector("[data-thread-pull-request]")).toBeNull();
    // A link cannot nest another link; the info card carries the title.
    expect(row("open").querySelector("a")).toBeNull();
    vi.useFakeTimers();
    try {
      touch(row("open"), "pointermove", "mouse");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    } finally {
      vi.useRealTimers();
    }
    const card = document.querySelector('[data-thread-info="open"]')!;
    expect(
      Array.from(card.querySelectorAll("dt")).some((e) => e.textContent === "PR"),
    ).toBe(true);
    expect(card.textContent).toContain("#2683 Reduce prod step overhead");
    expect(slot.getByRole("tooltip").textContent).toContain(
      "Open pull request #2683, checks failed: Reduce prod step overhead",
    );
  });
  it("drops the project name from rows under a project header", () => {
    updateState((state) => ({ ...state, groupBy: "project" }));
    const slot = renderSlot(app.threadLists[0], props, {
      sidebarThreads: {
        projects,
        threads: [
          thread({
            id: "branch",
            environment: {
              id: "env",
              name: "Local",
              branchName: "feature/activity",
              providerId: null,
              workspaceDisplayKind: "managed-worktree",
            },
          }),
          thread({ id: "plain" }),
          thread({ id: "pinned", isPinned: true }),
        ],
      },
      sidebarPullRequests: {
        branch: {
          number: 7,
          title: "Seven",
          url: "https://github.com/example/repo/pull/7",
          state: "open",
          attention: "none",
        },
      },
    });
    const meta = (id: string) =>
      slot.container.querySelector(
        `[data-sidebar-thread-id="${id}"] > span:nth-child(2) > span`,
      )!;
    expect(meta("branch").textContent).toBe("#7·feature/activity");
    expect(meta("plain").textContent).toBe("");
    // The Pinned section has no project header, so its rows keep the name.
    expect(meta("pinned").textContent).toBe("One");
    expect(slot.getByRole("region", { name: "One" })).toBeTruthy();
  });
  it.each([false, true])("fetches a missing parent title on focus with compact=%s, without loading archives", async (isCompactViewport) => {
    const parentTitle = vi.fn(async () => "Archived parent name");
    const listArchived = vi.fn(async () => []);
    const slot = renderSlot(app.threadLists[0], { ...props, isCompactViewport }, {
      sidebarThreads: { projects, threads: [thread({ id: "restored", parentThreadId: "missing-parent" })] },
      rpc: { parentTitle, listArchived },
    });
    expect(parentTitle).not.toHaveBeenCalled();
    const row = slot.container.querySelector('[data-sidebar-thread-id="restored"]')!;
    fireEvent.focus(row);
    await waitFor(() => expect(slot.getByRole("tooltip").textContent).toContain("Child of Archived parent name"));
    expect(parentTitle).toHaveBeenCalledWith({ threadId: "missing-parent" });
    expect(slot.getByRole("tooltip").textContent).not.toContain("missing-parent");
    expect(listArchived).not.toHaveBeenCalled();
    expect(slot.queryByRole("button", { name: "Archived" })).toBeNull();
  });
  it("shows an unavailable parent and retries on reopening the card", async () => {
    const parentTitle = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValue("Recovered parent");
    const slot = renderSlot(app.threadLists[0], props, {
      sidebarThreads: { projects, threads: [thread({ id: "restored", parentThreadId: "missing-parent" })] },
      rpc: { parentTitle },
    });
    const row = slot.container.querySelector('[data-sidebar-thread-id="restored"]')!;
    fireEvent.focus(row);
    await waitFor(() => expect(slot.getByRole("tooltip").textContent).toContain("Unavailable"));
    fireEvent.keyDown(row, { key: "Escape" });
    fireEvent.blur(row);
    fireEvent.focus(row);
    await waitFor(() => expect(slot.getByRole("tooltip").textContent).toContain("Recovered parent"));
    expect(parentTitle).toHaveBeenCalledTimes(2);
  });
  it("shows child details on keyboard focus and closes them with Escape", () => {
    const slot = mount();
    const row = slot.container.querySelector(
      '[data-sidebar-thread-id="child"]',
    )!;
    fireEvent.focus(row);
    expect(slot.getByRole("tooltip").textContent).toContain(
      "Child of Running parent",
    );
    expect(slot.inspection.rpcCalls.some(call => call.method === "parentTitle")).toBe(false);
    const card = document.querySelector('[data-thread-info="child"]')!;
    expect(
      Array.from(card.querySelectorAll("dt")).map((e) => e.textContent),
    ).not.toContain("Machine");
    expect(card.textContent).not.toContain("Cloud");
    fireEvent.keyDown(row, { key: "Escape" });
    expect(slot.queryByRole("tooltip")).toBeNull();
  });
  it("keeps full metadata in aligned labelled rows without decorative body icons", () => {
    const branch = "bb/" + "long-branch-name-".repeat(12);
    const parent =
      "A parent thread with a long title that must remain fully readable";
    const slot = renderSlot(app.threadLists[0], props, {
      sidebarThreads: {
        projects,
        threads: [
          thread({ id: "parent", title: parent }),
          thread({
            id: "child",
            parentThreadId: "parent",
            isPinned: true,
            environment: {
              id: "env",
              name: "Review workspace",
              branchName: branch,
              providerId: null,
              workspaceDisplayKind: "managed-worktree",
            },
            host: { id: "host", name: "Review machine" },
          }),
        ],
      },
    });
    fireEvent.focus(
      slot.container.querySelector('[data-sidebar-thread-id="child"]')!,
    );
    const card = document.querySelector('[data-thread-info="child"]')!;
    const lists = Array.from(card.querySelectorAll("dl"));
    expect(lists).toHaveLength(2);
    for (const list of lists) {
      expect(list.className).toContain("grid-cols-[64px_minmax(0,1fr)]");
      expect(list.querySelector("svg")).toBeNull();
      expect(
        Array.from(list.children).every(
          (e) => e.tagName === "DT" || e.tagName === "DD",
        ),
      ).toBe(true);
    }
    expect(
      Array.from(card.querySelectorAll("dt")).map((e) => e.textContent),
    ).toEqual([
      "Project",
      "Branch",
      "Machine",
      "Workspace",
      "Parent",
      "Created",
      "Updated",
    ]);
    expect(
      Array.from(card.querySelectorAll("dd")).map((e) => e.textContent),
    ).toContain(branch);
    expect(
      Array.from(card.querySelectorAll("dd")).map((e) => e.textContent),
    ).toContain(parent);
    const description = slot.getByRole("tooltip").textContent;
    for (const fact of [
      branch,
      parent,
      "Review workspace",
      "Review machine",
      "Pinned",
    ]) {
      expect(description).toContain(fact);
    }
  });
  it("replaces the hover card with the row actions menu", async () => {
    const slot = mount();
    const row = slot.container.querySelector(
      '[data-sidebar-thread-id="child"]',
    )!;
    touch(row, "pointermove", "mouse");
    expect(await slot.findByRole("tooltip")).toBeTruthy();
    fireEvent.contextMenu(row);
    expect(
      await slot.findByRole("menu", { name: "Actions for Blocked child" }),
    ).toBeTruthy();
    expect(slot.queryByRole("tooltip")).toBeNull();
    expect(slot.inspection.sidebarActionCalls).toEqual([]);
  });
  it("does not show hover information on touch", () => {
    const slot = mount();
    const row = slot.container.querySelector(
      '[data-sidebar-thread-id="done"]',
    )!;
    touch(row, "pointermove");
    touch(row, "pointerdown");
    fireEvent.focus(row);
    touch(row, "pointerup");
    expect(slot.queryByRole("tooltip")).toBeNull();
  });
  it("closes the info card on scrolling or a BB shortcut click", () => {
    const slot = mount();
    const row = slot.container.querySelector(
      '[data-sidebar-thread-id="done"]',
    )!;
    fireEvent.focus(row);
    expect(slot.getByRole("tooltip")).toBeTruthy();
    fireEvent.scroll(slot.container);
    expect(slot.queryByRole("tooltip")).toBeNull();
    fireEvent.blur(row);
    fireEvent.focus(row);
    expect(slot.getByRole("tooltip")).toBeTruthy();
    fireEvent.click(row, { detail: 0 });
    expect(slot.queryByRole("tooltip")).toBeNull();
    expect(slot.inspection.sidebarActionCalls).toEqual([
      { method: "open", threadId: "done", options: { split: false } },
    ]);
  });
  it("supports keyboard menus, status filters, and project grouping", async () => {
    const slot = mount();
    fireEvent.keyDown(
      slot.getByRole("button", { name: "Threads display options" }),
      { key: "Enter" },
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(
      slot
        .getAllByRole("menuitemcheckbox", { hidden: true })
        .map((item) => item.textContent?.replace("✓", "")),
    ).toEqual([
      "Needs Attention",
      "Unread",
      "Working",
      "Draft",
      "Done",
      "Archived",
    ]);
    fireEvent.click(
      slot.getByRole("menuitemcheckbox", { name: "Done", hidden: true }),
    );
    expect(
      slot.container.querySelector('section[aria-label="Done"]'),
    ).toBeNull();
    fireEvent.click(
      slot.getByRole("menuitemradio", { name: "Project", hidden: true }),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(
      slot
        .getAllByRole("region")
        .map((region) => region.getAttribute("aria-label")),
    ).toEqual(["One", "Two"]);
  });
  it.each(["status", "project"] as const)(
    "sorts by created or updated date in %s view and keeps the choice",
    async (groupBy) => {
      updateState((current) => ({ ...current, groupBy }));
      const fixture = [
        thread({
          id: "new-created",
          title: "Newly created",
          createdAt: 2000,
          updatedAt: 2000,
          indicator: groupBy === "project" ? "runtime" : "none",
        }),
        thread({
          id: "new-updated",
          title: "Recently updated",
          createdAt: 1000,
          updatedAt: 3000,
        }),
        thread({
          id: "pinned",
          title: "Pinned",
          createdAt: 500,
          updatedAt: 500,
          isPinned: true,
        }),
      ];
      let slot = renderSlot(app.threadLists[0], props, {
        sidebarThreads: { projects, threads: fixture },
      });
      const order = () =>
        Array.from(
          slot.container.querySelectorAll("[data-sidebar-thread-id]"),
        ).map((row) => row.getAttribute("data-sidebar-thread-id"));
      const chooseSort = async (name: string) => {
        fireEvent.keyDown(
          slot.getByRole("button", { name: "Threads display options" }),
          { key: "Enter" },
        );
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        fireEvent.click(
          slot.getByRole("menuitemradio", { name, hidden: true }),
        );
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      };
      expect(order()).toEqual(["pinned", "new-updated", "new-created"]);
      await chooseSort("Date created");
      expect(order()).toEqual(["pinned", "new-created", "new-updated"]);
      const rowTime = slot.container.querySelector(
        '[data-sidebar-thread-id="new-updated"] time',
      )!;
      expect(rowTime.getAttribute("datetime")).toBe(
        new Date(1000).toISOString(),
      );
      expect(rowTime.getAttribute("aria-label")).toMatch(/^Created /);
      expect(
        parseState(localStorage.getItem("bb-plugin-sidebar:v1")).sortBy,
      ).toBe("created");
      slot.unmount();
      slot = renderSlot(app.threadLists[0], props, {
        sidebarThreads: { projects, threads: fixture },
      });
      expect(order()).toEqual(["pinned", "new-created", "new-updated"]);
      await chooseSort("Date updated");
      expect(order()).toEqual(["pinned", "new-updated", "new-created"]);
      expect(slot.inspection.sidebarActionCalls).toEqual([]);
    },
  );
  it("persists collapsed groups and responds to draft changes", () => {
    const slot = mount();
    act(() => recordDraft("thread:done", true));
    expect(
      within(slot.getByRole("region", { name: "Draft" })).getByText(
        "Read reply",
      ),
    ).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Draft" }));
    expect(slot.queryByText("Read reply")).toBeNull();
    expect(localStorage.getItem("bb-plugin-sidebar:v1")).toContain(
      "status:draft",
    );
    act(() => recordDraft("thread:done", false));
    expect(
      within(slot.getByRole("region", { name: "Done" })).getByText(
        "Read reply",
      ),
    ).toBeTruthy();
  });
  it("warns when realtime disconnects", async () => {
    const slot = mount();
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    const warning = slot.getByText(
      "Reconnecting… Statuses can be out of date.",
    );
    expect(warning.getAttribute("role")).toBe("status");
  });
  it("updates when another window changes the plugin preferences", () => {
    const slot = mount();
    act(() => {
      localStorage.setItem(
        "bb-plugin-sidebar:v1",
        JSON.stringify({ ...parseState(null), hidden: ["done"] }),
      );
      window.dispatchEvent(
        new StorageEvent("storage", { key: "bb-plugin-sidebar:v1" }),
      );
    });
    expect(slot.queryByRole("region", { name: "Done" })).toBeNull();
  });
  it("shows loading and falls back to BB on errors", () => {
    const slot = renderSlot(app.threadLists[0], props, {
      sidebarThreads: { status: "loading" },
    });
    expect(visibleStatus(slot)?.textContent).toBe("Loading threads…");
    slot.unmount();
    const failed = renderSlot(app.threadLists[0], props, {
      sidebarThreads: { status: "error" },
    });
    expect(failed.getByText("BB fallback")).toBeTruthy();
  });
});

describe("composer draft observation", () => {
  const registration = app.composerCustomizations[0].banners![0];
  it("tracks existing text, clearing, and new text without storing content", async () => {
    const slot = renderSlot(
      registration,
      {},
      {
        composer: {
          scope: { kind: "thread", threadId: "draft-thread" },
          text: "Private draft content",
        },
      },
    );
    expect(localStorage.getItem("bb-plugin-sidebar:v1")).toContain(
      "thread:draft-thread",
    );
    expect(localStorage.getItem("bb-plugin-sidebar:v1")).not.toContain(
      "Private",
    );
    await slot.behavior.setComposerText("");
    expect(localStorage.getItem("bb-plugin-sidebar:v1")).not.toContain(
      "thread:draft-thread",
    );
    await slot.behavior.setComposerText("Another draft");
    slot.unmount();
    expect(localStorage.getItem("bb-plugin-sidebar:v1")).toContain(
      "thread:draft-thread",
    );
  });
  it("tracks attachment-only new-thread drafts", () => {
    renderSlot(
      registration,
      {},
      {
        composer: {
          scope: { kind: "new-thread", projectId: "project-1" },
          text: "",
          attachmentCount: 1,
        },
      },
    );
    expect(localStorage.getItem("bb-plugin-sidebar:v1")).toContain(
      "new:project-1",
    );
  });
});
