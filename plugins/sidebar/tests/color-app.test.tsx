// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import {
  loadPluginApp,
  renderSlot as renderSdkSlot,
} from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarPullRequest } from "@get-bb/plugin-sdk/app";
import { parseState, updateState } from "../lib/client-state";
import { projectHueStep } from "../lib/project-hue";
import { STATUS_COLOR_CLASS } from "../components/status-icon";
import { pullRequestColorClass } from "../components/pull-request";
import { thread } from "./fixtures";

const app = await loadPluginApp(() => import("../app"));
const mountedSlots: ReturnType<typeof renderSdkSlot>[] = [];
const renderSlot: typeof renderSdkSlot = (registration, props, options) => {
  const slot = renderSdkSlot(registration, props, {
    ...options,
    rpc: {
      listArchived: async () => [],
      archiveTree: async () => ({ ok: true }),
      restoreThread: async () => ({ ok: true }),
      getLibrary: async () => ({ revision: 0, ids: [] }),
      ...options?.rpc,
    },
  });
  mountedSlots.push(slot);
  return slot;
};
const props = {
  activeThreadId: null,
  activeProjectId: "project-1",
  isCompactViewport: false,
  searchQuery: "",
  onNavigate: vi.fn(),
  Original: () => <p>BB fallback</p>,
};
const projects = [
  { id: "project-1", name: "One", isPersonal: false },
  { id: "project-2", name: "Two", isPersonal: false },
  { id: "personal", name: "Personal", isPersonal: true },
];
const environment = {
  id: "env",
  name: "Local",
  branchName: "feat/colors",
  providerId: null,
  workspaceDisplayKind: "managed-worktree" as const,
};
const pullRequest = (
  state: PluginSidebarPullRequest["state"],
  attention: PluginSidebarPullRequest["attention"] = "none",
): PluginSidebarPullRequest => ({
  number: 7,
  title: "Tint the sidebar",
  url: "https://github.com/example/bb/pull/7",
  state,
  attention,
});
const threads = [
  thread({ id: "done", title: "Read reply", environment }),
  thread({ id: "unread", title: "New reply", isUnread: true, projectId: "project-2" }),
  thread({ id: "working", title: "Running", indicator: "runtime", providerId: "claude-code" }),
  thread({ id: "attention", title: "Blocked", hasPendingInteraction: true }),
  thread({ id: "child", title: "Child", parentThreadId: "working", projectId: "project-2" }),
  thread({ id: "orphan", title: "Orphan child", parentThreadId: "missing" }),
  thread({ id: "personal", title: "Loose", projectId: "personal" }),
];
const row = (slot: { container: HTMLElement }, id: string) =>
  slot.container.querySelector(`[data-sidebar-thread-id="${id}"]`) as HTMLElement;
const wrapper = (slot: { container: HTMLElement }, id: string) =>
  row(slot, id).closest("[data-thread-status]") as HTMLElement;
// jsdom has no matchMedia; the sidebar treats that as a touch viewport.
let finePointer = false;
const originalMatchMedia = window.matchMedia;
beforeEach(() => {
  window.localStorage.clear();
  updateState(() => parseState(null));
  vi.clearAllMocks();
  finePointer = false;
  window.matchMedia = ((query: string) =>
    ({
      matches: query.includes("pointer") && finePointer,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
});
afterEach(async () => {
  for (const slot of mountedSlots.splice(0)) slot.lifecycle.unmount();
  cleanup();
  window.matchMedia = originalMatchMedia;
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
const mount = (options: Parameters<typeof renderSlot>[2] = {}) =>
  renderSlot(app.threadLists[0], props, {
    sidebarThreads: { threads, projects },
    ...options,
  });

describe("status colors", () => {
  it("maps every status onto a palette role with a BB fallback", () => {
    expect(STATUS_COLOR_CLASS).toEqual({
      attention: "text-[var(--bbp-attention,var(--warning-text))]",
      unread: "text-[var(--bbp-file,var(--timeline-accent))]",
      working: "text-[var(--bbp-done,var(--success))]",
      draft: "text-[var(--bbp-agent,var(--pr-merged))]",
      done: "text-[var(--subtle-foreground)]",
    });
    for (const value of Object.values(STATUS_COLOR_CLASS)) {
      expect(value).not.toMatch(/oklch|sky-|violet-/);
    }
  });
  it("washes attention rows, keeps the green spinner, and colors the unread dot and child arrow", () => {
    const slot = mount();
    expect(wrapper(slot, "attention").className).toContain("bg-[var(--surface-attention)]");
    expect(wrapper(slot, "attention").getAttribute("data-thread-status")).toBe("attention");
    expect(wrapper(slot, "working").className).not.toContain("surface-attention");
    const spinner = within(row(slot, "working")).getByRole("img", { name: "Working" }).querySelector("svg")!;
    expect(spinner.getAttribute("data-status-icon")).toBe("working");
    expect(spinner.classList.contains("text-[var(--bbp-done,var(--success))]")).toBe(true);
    expect(spinner.classList.contains("motion-safe:animate-spin")).toBe(true);
    const dot = row(slot, "unread").querySelector("[data-status-dot='unread']")!;
    expect(dot.classList.contains("bg-[var(--bbp-file,var(--timeline-accent))]")).toBe(true);
    // Both child arrows: the inset arrow under a parent and the ↳ of a child
    // whose parent is missing.
    const arrow = row(slot, "child").querySelector("[data-child-arrow]")!;
    expect(arrow.classList.contains("text-[var(--bbp-agent,var(--pr-merged))]")).toBe(true);
    const orphanArrow = Array.from(row(slot, "orphan").querySelectorAll("span")).find((e) => e.textContent === "↳")!;
    expect(orphanArrow.classList.contains("text-[var(--bbp-agent,var(--pr-merged))]")).toBe(true);
    expect(orphanArrow.getAttribute("aria-hidden")).toBe("true");
  });
  it("does not wash the selected row", () => {
    const slot = renderSlot(app.threadLists[0], { ...props, activeThreadId: "attention" }, {
      sidebarThreads: { threads, projects },
    });
    expect(wrapper(slot, "attention").className).toContain("bg-accent");
    expect(wrapper(slot, "attention").className).not.toContain("surface-attention");
  });
});

describe("provider and branch glyphs", () => {
  it("renders the host provider icon left of every title with the provider record", () => {
    const slot = mount({
      providers: {
        providers: [
          {
            id: "claude-code",
            displayName: "Claude Code",
            logoUrl: "https://bb.test/claude.svg",
            strings: { iconTint: { light: "#a05", dark: "#f6a" } },
          } as never,
        ],
      },
    });
    const line = row(slot, "working").firstElementChild as HTMLElement;
    const glyph = line.firstElementChild as HTMLElement;
    expect(glyph.getAttribute("data-thread-provider")).toBe("claude-code");
    const icon = glyph.firstElementChild!;
    expect(icon.getAttribute("data-provider-kind")).toBe("agent");
    expect(icon.getAttribute("data-provider-id")).toBe("claude-code");
    expect(icon.getAttribute("data-provider-logo")).toBe("https://bb.test/claude.svg");
    expect(JSON.parse(icon.getAttribute("data-provider-tint")!)).toEqual({ light: "#a05", dark: "#f6a" });
    expect(icon.getAttribute("data-provider-fallback")).toBe("Code");
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(line.children[1]!.textContent).toBe("Running");
    // Unknown to the directory: an id-only record still reaches the host.
    const codex = row(slot, "done").querySelector("[data-thread-provider='codex'] [data-provider-id]")!;
    expect(codex.getAttribute("data-provider-id")).toBe("codex");
    expect(codex.hasAttribute("data-provider-logo")).toBe(false);
  });
  it("puts a file-blue git-branch glyph before the branch name", () => {
    const slot = mount();
    const branch = row(slot, "done").querySelector("[data-thread-branch]")!;
    expect(branch.textContent).toBe("feat/colors");
    const glyph = branch.querySelector("[data-icon='GitBranch']")!;
    expect(glyph.classList.contains("text-[var(--bbp-file,var(--timeline-accent))]")).toBe(true);
    expect(row(slot, "unread").querySelector("[data-thread-branch]")).toBeNull();
  });
});

describe("project identity color", () => {
  it("tints project headers with a deterministic hue and accents rows in status view", () => {
    const slot = mount();
    // Status view lists every project, so rows carry their project's accent.
    const accent = wrapper(slot, "done").querySelector("[data-project-accent]")!;
    expect(accent.getAttribute("data-project-hue")).toBe(String(projectHueStep("One")));
    expect(wrapper(slot, "unread").querySelector("[data-project-accent]")?.getAttribute("data-project-hue")).toBe(String(projectHueStep("Two")));
    expect(projectHueStep("One")).not.toBe(projectHueStep("Two"));
    expect(slot.container.querySelector("style[data-project-hue-style]")?.textContent).toContain('[data-project-hue="0"]');
    act(() => updateState((current) => ({ ...current, groupBy: "project" })));
    const header = slot.getByRole("button", { name: "One" });
    const glyph = header.querySelector("[data-project-glyph]")!;
    expect(glyph.getAttribute("data-project-hue")).toBe(String(projectHueStep("One")));
    expect(glyph.querySelector("[data-icon='Folder']")).not.toBeNull();
    // Under its own header the project is implied, so no accent.
    expect(wrapper(slot, "done").querySelector("[data-project-accent]")).toBeNull();
    const personal = slot.getByRole("button", { name: "No project" }).querySelector("[data-project-glyph]")!;
    expect(personal.hasAttribute("data-project-hue")).toBe(false);
    // Pinned rows show the project again, and so the accent.
    act(() => updateState((current) => ({ ...current, groupBy: "status" })));
  });
});

describe("group headers", () => {
  it("shows a tinted glyph and a count; Needs Attention colors its count only while non-zero", () => {
    const slot = mount();
    const count = (name: string) => slot.getByRole("button", { name }).querySelector("[data-group-count]")!;
    expect(count("Needs Attention").textContent).toBe("1");
    expect(count("Needs Attention").getAttribute("data-group-count-tone")).toBe("attention");
    expect(count("Needs Attention").className).toContain("text-[var(--warning-text)]");
    expect(count("Working").textContent).toBe("1");
    expect(count("Working").getAttribute("data-group-count-tone")).toBe("muted");
    expect(count("Done").textContent).toBe("3");
    expect(slot.getByRole("button", { name: "Needs Attention" }).querySelector("[data-group-icon] [data-status-icon='attention']")).not.toBeNull();
    expect(slot.getByRole("button", { name: "Working" }).querySelector("[data-group-icon] [data-status-icon='working']")).not.toBeNull();
    // An empty group is not rendered, so an attention count is never a colored zero.
    expect(slot.container.querySelector("[data-group-count-tone='attention'][data-group-count='0']")).toBeNull();
  });
  it("counts pinned and project groups", () => {
    const slot = mount({
      sidebarThreads: {
        projects,
        threads: [...threads, thread({ id: "pin", title: "Pinned one", isPinned: true, projectId: "project-2" })],
      },
    });
    const pinned = slot.getByRole("button", { name: "Pinned" });
    expect(pinned.querySelector("[data-group-count]")?.textContent).toBe("1");
    expect(pinned.querySelector("[data-group-icon] [data-icon='Pin']")).not.toBeNull();
    act(() => updateState((current) => ({ ...current, groupBy: "project" })));
    expect(slot.getByRole("button", { name: "One" }).querySelector("[data-group-count]")?.textContent).toBe("4");
    // Project view lists the cross-project child under its own project.
    expect(slot.getByRole("button", { name: "Two" }).querySelector("[data-group-count]")?.textContent).toBe("2");
  });
});

describe("pull request link", () => {
  it("aligns chip colors to the palette roles", () => {
    expect(pullRequestColorClass(pullRequest("merged", "merged"))).toBe("text-[var(--bbp-agent,var(--pr-merged))]");
    expect(pullRequestColorClass(pullRequest("open"))).toBe("text-[var(--bbp-done,var(--success))]");
    expect(pullRequestColorClass(pullRequest("open", "checks_failed"))).toBe("text-[var(--bbp-attention,var(--warning-text))]");
    expect(pullRequestColorClass(pullRequest("closed", "closed"))).toBe("text-[var(--bbp-error,var(--destructive-text))]");
    expect(pullRequestColorClass(pullRequest("draft", "draft"))).toBe("text-[var(--bbp-edit,var(--warning-text))]");
  });
  it("opens the pull request through BB's URL opener without selecting the row", () => {
    const openUrl = vi.fn(() => true);
    const slot = mount({ sidebarPullRequests: { done: pullRequest("open") }, openUrl });
    const link = within(row(slot, "done")).getByRole("link", { name: "Open pull request #7: Tint the sidebar" });
    expect(link.getAttribute("data-thread-pull-request")).toBe("");
    expect(link.getAttribute("data-pull-request-state")).toBeNull();
    expect(link.querySelector("[data-pull-request-state='open']")).not.toBeNull();
    expect(link.className).toContain("hover:underline");
    // Still no nested anchor inside the row link.
    expect(row(slot, "done").querySelector("a")).toBeNull();
    fireEvent.click(link);
    expect(openUrl).toHaveBeenCalledWith("https://github.com/example/bb/pull/7");
    expect(slot.inspection.navigateCalls).toEqual([{ method: "openUrl", url: "https://github.com/example/bb/pull/7" }]);
    expect(slot.inspection.sidebarActionCalls).toEqual([]);
    expect(props.onNavigate).not.toHaveBeenCalled();
    fireEvent.keyDown(link, { key: "Enter" });
    expect(openUrl).toHaveBeenCalledTimes(2);
  });
  it("falls back to a new tab when the host declines the URL", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    try {
      const slot = mount({ sidebarPullRequests: { done: pullRequest("merged", "merged") }, openUrl: () => false });
      fireEvent.click(within(row(slot, "done")).getByRole("link"));
      expect(open).toHaveBeenCalledWith("https://github.com/example/bb/pull/7", "_blank", "noopener,noreferrer");
      expect(slot.inspection.sidebarActionCalls).toEqual([]);
    } finally {
      open.mockRestore();
    }
  });
});

describe("hover archive", () => {
  const hover = (target: Element) => fireEvent.pointerOver(target);
  const leave = (target: Element) => fireEvent.pointerOut(target);
  it("swaps the status marker for an archive control on a fine pointer", async () => {
    finePointer = true;
    const archiveTree = vi.fn(async () => ({ ok: true as const }));
    const slot = mount({ rpc: { archiveTree } });
    const working = wrapper(slot, "working");
    expect(within(working).getByRole("img", { name: "Working" })).toBeTruthy();
    hover(working);
    expect(within(working).queryByRole("img", { name: "Working" })).toBeNull();
    const control = within(working).getByRole("button", { name: "Archive thread" });
    expect(control.getAttribute("data-thread-archive-action")).toBe("archive");
    expect(control.querySelector("[data-icon='Archive']")).not.toBeNull();
    // Other rows keep their markers; a Done row gains the control in its empty slot.
    expect(within(wrapper(slot, "attention")).getByRole("img", { name: "Needs Attention" })).toBeTruthy();
    hover(wrapper(slot, "done"));
    expect(within(wrapper(slot, "done")).getByRole("button", { name: "Archive thread" })).toBeTruthy();
    leave(working);
    expect(within(working).getByRole("img", { name: "Working" })).toBeTruthy();
    hover(working);
    fireEvent.click(within(working).getByRole("button", { name: "Archive thread" }));
    await act(async () => {});
    expect(archiveTree).toHaveBeenCalledWith({ threadId: "working" });
    expect(slot.inspection.sidebarActionCalls).toEqual([]);
    expect(props.onNavigate).not.toHaveBeenCalled();
  });
  it("keeps the marker on touch viewports", () => {
    finePointer = false;
    const slot = mount();
    const working = wrapper(slot, "working");
    hover(working);
    expect(within(working).getByRole("img", { name: "Working" })).toBeTruthy();
    expect(within(working).queryByRole("button", { name: "Archive thread" })).toBeNull();
  });
  it("offers Unarchive on archived rows and restores without navigating", async () => {
    finePointer = true;
    const restoreThread = vi.fn(async () => ({ ok: true as const }));
    const slot = mount({
      rpc: {
        listArchived: async () => [
          {
            id: "old",
            projectId: "project-1",
            title: "Old thread",
            titleFallback: null,
            parentThreadId: null,
            providerId: "codex",
            createdAt: 1,
            updatedAt: 1,
            environmentId: null,
            environmentName: null,
            environmentBranchName: null,
            environmentProviderId: null,
            environmentWorkspaceDisplayKind: "other",
          },
        ],
        restoreThread,
      },
    });
    act(() => updateState((current) => ({ ...current, showArchives: true })));
    fireEvent.click(await slot.findByRole("button", { name: "Archived" }));
    const old = wrapper(slot, "old");
    expect(old.getAttribute("data-thread-status")).toBe("archived");
    expect(within(old).getByRole("img", { name: "Archived" })).toBeTruthy();
    hover(old);
    const control = within(old).getByRole("button", { name: "Unarchive thread" });
    expect(control.getAttribute("data-thread-archive-action")).toBe("unarchive");
    expect(control.querySelector("[data-icon='ArchiveRestore']")).not.toBeNull();
    fireEvent.click(control);
    await act(async () => {});
    expect(restoreThread).toHaveBeenCalledWith({ threadId: "old" });
    expect(slot.inspection.navigateCalls).toEqual([]);
  });
});
