// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarPullRequest } from "@get-bb/plugin-sdk/app";
import { parseState, updateState } from "../lib/client-state";
import { thread } from "./fixtures";

const app = await loadPluginApp(() => import("../app"));
const projects = [{ id: "project-1", name: "One", isPersonal: false }];
const threads = [
  thread({ id: "worktree", title: "Worktree thread", updatedAt: 300 }),
  thread({ id: "shared", title: "Shared checkout thread", updatedAt: 200 }),
  thread({ id: "plain", title: "Plain thread", updatedAt: 100 }),
];

const pullRequest = (number: number): PluginSidebarPullRequest => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/acme/widgets/pull/${number}`,
  state: "open",
  attention: "none",
});

// A fake server: `branchPullRequestEligibility` answers from this map.
let eligibility: Record<string, boolean>;
const branchPullRequestEligibility = vi.fn(async (input: unknown) => {
  const { threadIds } = input as { threadIds: string[] };
  const eligible: Record<string, boolean> = {};
  for (const id of threadIds)
    if (eligibility[id] !== undefined) eligible[id] = eligibility[id]!;
  return { eligible };
});
const rpc = {
  getSpaces: async () => ({ revision: 0, spaces: [] }),
  getLibrary: async () => ({ revision: 0, ids: [] }),
  getSnoozes: async () => ({ revision: 0, entries: [] }),
  getSnoozePresets: async () => ({ revision: 0, presets: [] }),
  branchPullRequestEligibility,
};

const props = {
  activeThreadId: null,
  activeProjectId: "project-1",
  isCompactViewport: false,
  searchQuery: "",
  onNavigate: vi.fn(),
  Original: () => <p>BB fallback</p>,
};
const mounted: ReturnType<typeof renderSlot>[] = [];
const mount = (openUrl = vi.fn(() => true)) => {
  const slot = renderSlot(app.threadLists[0], props, {
    sidebarThreads: { threads, projects },
    sidebarPullRequests: {
      worktree: pullRequest(7),
      shared: pullRequest(1438),
    },
    rpc,
    openUrl,
  });
  mounted.push(slot);
  return slot;
};
const tick = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
// The chip sits beside the row link, inside the row's container.
const row = (slot: { container: HTMLElement }, id: string) =>
  slot.container.querySelector<HTMLElement>(`[data-sidebar-thread-id="${id}"]`)!.closest<HTMLElement>("[data-thread-status]")!;

beforeEach(() => {
  window.localStorage.clear();
  updateState(() => parseState(null));
  vi.clearAllMocks();
  eligibility = { worktree: true, shared: false };
});
afterEach(async () => {
  for (const slot of mounted.splice(0)) slot.lifecycle.unmount();
  cleanup();
  await tick();
});

describe("branch pull request chip", () => {
  it("checks every listed thread in one bulk call and hides a shared checkout's PR", async () => {
    const slot = mount();
    await waitFor(() =>
      expect(branchPullRequestEligibility).toHaveBeenCalledTimes(1),
    );
    expect(branchPullRequestEligibility.mock.calls[0]![0]).toEqual({
      threadIds: expect.arrayContaining(["worktree", "shared", "plain"]),
    });
    await waitFor(() =>
      expect(
        within(row(slot, "shared")).queryByRole("link", { name: /#1438/ }),
      ).toBeNull(),
    );
    expect(
      within(row(slot, "worktree")).getByRole("link", { name: /#7/ }),
    ).toBeTruthy();
    expect(within(row(slot, "plain")).queryByRole("link", { name: /pull request/ })).toBeNull();
  });

  it("opens the PR in BB's browser without selecting the row", async () => {
    const openUrl = vi.fn(() => true);
    const slot = mount(openUrl);
    const chip = await waitFor(() =>
      within(row(slot, "worktree")).getByRole("link", { name: /#7/ }),
    );
    fireEvent.click(chip);
    expect(openUrl).toHaveBeenCalledWith(
      "https://github.com/acme/widgets/pull/7",
    );
    expect(slot.inspection.sidebarActionCalls).toEqual([]);
    expect(props.onNavigate).not.toHaveBeenCalled();
  });
});
