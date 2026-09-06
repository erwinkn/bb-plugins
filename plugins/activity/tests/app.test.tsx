// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import {
  loadPluginApp,
  renderSlot as renderSdkSlot,
} from "@get-bb/plugin-sdk/testing/app";
import { parseState, updateState, recordDraft } from "../lib/client-state";
import { thread } from "./fixtures";

const app = await loadPluginApp(() => import("../app"));
const mountedSlots: ReturnType<typeof renderSdkSlot>[] = [];
const renderSlot: typeof renderSdkSlot = (registration, props, options) => {
  const slot = renderSdkSlot(registration, props, options);
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
beforeEach(() => {
  localStorage.clear();
  updateState(() => parseState(null));
  vi.clearAllMocks();
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
  it("uses plain group labels and only working spinners or unread dots on rows", () => {
    const slot = mount();
    act(() => {
      recordDraft("thread:done", true);
      recordDraft("new:project-1", true);
    });
    for (const group of slot.getAllByRole("region")) {
      const header = group.querySelector(":scope > button")!;
      expect(header.textContent).toBe(group.getAttribute("aria-label"));
      expect(header.hasAttribute("title")).toBe(false);
      expect(header.querySelectorAll("svg")).toHaveLength(1);
      expect(header.querySelector("[data-group-chevron]")).not.toBeNull();
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
    expect(
      slot.container.querySelector('[data-sidebar-thread-id="done"] svg'),
    ).toBeNull();
    expect(slot.getByText("New thread draft")).toBeTruthy();
  });
  it("groups children by their own status, excludes archived threads, and preserves shortcuts", () => {
    const slot = mount();
    expect(
      slot
        .getAllByRole("region")
        .map((region) => region.getAttribute("aria-label")),
    ).toEqual(["Needs Attention", "Unread", "Working", "Done"]);
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
  it("shows Threads without filters and ignores the old saved project selector", () => {
    updateState(() => parseState(JSON.stringify({ projectId: "project-1" })));
    const slot = mount();
    expect(slot.getByRole("heading", { name: "Threads" })).toBeTruthy();
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
  it("shows title, project, branch, and age; keeps provider in the tooltip", () => {
    const slot = renderSlot(app.threadLists[0], props, {
      sidebarThreads: {
        projects,
        threads: [
          thread({
            environment: {
              id: "env",
              name: "Local",
              branchName: "feature/activity",
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
    expect(link.title).toContain("codex");
    expect(link.querySelector("time")?.getAttribute("datetime")).toBe(
      new Date(100).toISOString(),
    );
  });
  it(
    "supports keyboard menus, status filters, and project grouping",
    async () => {
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
      ).toEqual(["Needs Attention", "Unread", "Working", "Draft", "Done"]);
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
    },
  );
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
      expect(rowTime.getAttribute("title")).toMatch(/^Created /);
      expect(
        parseState(localStorage.getItem("bb-plugin-erwin-activity:v1")).sortBy,
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
    expect(localStorage.getItem("bb-plugin-erwin-activity:v1")).toContain(
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
        "bb-plugin-erwin-activity:v1",
        JSON.stringify({ ...parseState(null), hidden: ["done"] }),
      );
      window.dispatchEvent(
        new StorageEvent("storage", { key: "bb-plugin-erwin-activity:v1" }),
      );
    });
    expect(slot.queryByRole("region", { name: "Done" })).toBeNull();
  });
  it("shows loading and falls back to BB on errors", () => {
    const slot = renderSlot(app.threadLists[0], props, {
      sidebarThreads: { status: "loading" },
    });
    expect(slot.getByRole("status").textContent).toBe("Loading threads…");
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
    expect(localStorage.getItem("bb-plugin-erwin-activity:v1")).toContain(
      "thread:draft-thread",
    );
    expect(localStorage.getItem("bb-plugin-erwin-activity:v1")).not.toContain(
      "Private",
    );
    await slot.behavior.setComposerText("");
    expect(localStorage.getItem("bb-plugin-erwin-activity:v1")).not.toContain(
      "thread:draft-thread",
    );
    await slot.behavior.setComposerText("Another draft");
    slot.unmount();
    expect(localStorage.getItem("bb-plugin-erwin-activity:v1")).toContain(
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
    expect(localStorage.getItem("bb-plugin-erwin-activity:v1")).toContain(
      "new:project-1",
    );
  });
});
