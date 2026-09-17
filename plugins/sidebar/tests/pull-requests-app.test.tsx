// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarPullRequest } from "@get-bb/plugin-sdk/app";
import { parseState, updateState } from "../lib/client-state";
import type { LinkedPullRequest } from "../lib/pull-requests-schema";
import { thread } from "./fixtures";

const app = await loadPluginApp(() => import("../app"));
const projects = [{ id: "project-1", name: "One", isPersonal: false }];
const threads = [
  thread({ id: "linked", title: "Linked thread", updatedAt: 300 }),
  thread({ id: "plain", title: "Plain thread", updatedAt: 200 }),
  thread({ id: "multi", title: "Multi thread", updatedAt: 100 }),
];

const link = (overrides: Partial<LinkedPullRequest>): LinkedPullRequest => ({
  repo: "acme/widgets",
  number: 1,
  url: "https://github.com/acme/widgets/pull/1",
  title: "Linked PR",
  state: "open",
  ...overrides,
});

// A fake server: `linkedPullRequests` answers from these maps per call.
let links: Record<string, LinkedPullRequest[]>;
let branchEligible: Record<string, boolean>;
const linkedPullRequests = vi.fn(
  async (input: unknown) => {
    const { threadIds } = input as { threadIds: string[] };
    const pullRequests: Record<string, LinkedPullRequest[]> = {};
    const branchPrEligible: Record<string, boolean> = {};
    for (const id of threadIds) {
      if (links[id]?.length) pullRequests[id] = links[id]!;
      if (branchEligible[id] !== undefined)
        branchPrEligible[id] = branchEligible[id]!;
    }
    return { pullRequests, branchPrEligible };
  },
);
const rpc = {
  getSpaces: async () => ({ revision: 0, spaces: [] }),
  getLibrary: async () => ({ revision: 0, ids: [] }),
  getSnoozes: async () => ({ revision: 0, entries: [] }),
  getSnoozePresets: async () => ({ revision: 0, presets: [] }),
  linkedPullRequests,
  pullRequestsChanged: async () => ({ ok: true }),
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
const mount = (
  options: {
    sidebarPullRequests?: Record<string, PluginSidebarPullRequest>;
  } = {},
) => {
  const slot = renderSlot(app.threadLists[0], props, {
    sidebarThreads: { threads, projects },
    rpc,
    ...options,
  });
  mounted.push(slot);
  return slot;
};
const tick = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
const row = (slot: { container: HTMLElement }, id: string) =>
  slot.container.querySelector(`[data-sidebar-thread-id="${id}"]`)!;
const openRequests = () => {
  const requests: CustomEvent[] = [];
  const listener = (event: Event) => {
    event.preventDefault();
    requests.push(event as CustomEvent);
  };
  window.addEventListener("bb-plugins:open-pull-request", listener);
  return {
    requests,
    close: () =>
      window.removeEventListener("bb-plugins:open-pull-request", listener),
  };
};

beforeEach(() => {
  window.localStorage.clear();
  updateState(() => parseState(null));
  vi.clearAllMocks();
  links = {};
  branchEligible = {};
});
afterEach(async () => {
  for (const slot of mounted.splice(0)) slot.lifecycle.unmount();
  cleanup();
  await tick();
});

describe("linked pull request chips", () => {
  it("fetches the visible threads' links in one bulk call and chips a metadata-only PR", async () => {
    links["linked"] = [
      link({
        repo: "erwinkn/pulse-ui",
        number: 145,
        url: "https://github.com/erwinkn/pulse-ui/pull/145",
        title: "Pulse UI",
      }),
    ];
    const slot = mount();
    const chip = await waitFor(() =>
      within(row(slot, "linked") as HTMLElement).getByRole("link", {
        name: /#145/,
      }),
    );
    expect(chip.getAttribute("data-thread-pull-request")).toBe("");
    expect(
      within(row(slot, "plain") as HTMLElement).queryByRole("link"),
    ).toBeNull();
    // One call covered every listed thread.
    expect(linkedPullRequests).toHaveBeenCalledTimes(1);
    expect(linkedPullRequests.mock.calls[0]![0]).toEqual({
      threadIds: expect.arrayContaining(["linked", "plain", "multi"]),
    });
  });

  it("hides the environment PR on a shared checkout but keeps persisted links", async () => {
    const envPr: PluginSidebarPullRequest = {
      number: 1438,
      title: "Shared checkout PR",
      url: "https://github.com/acme/widgets/pull/1438",
      state: "open",
      attention: "none",
    };
    links["linked"] = [
      link({ number: 5, url: "https://github.com/acme/widgets/pull/5" }),
    ];
    branchEligible["linked"] = false;
    const slot = mount({ sidebarPullRequests: { linked: envPr } });
    // Only the persisted github-prs link remains; #1438 never appears.
    const chip = await waitFor(() =>
      within(row(slot, "linked") as HTMLElement).getByRole("link", {
        name: /#5/,
      }),
    );
    expect(chip.getAttribute("aria-label")).not.toContain("1438");
    expect(
      within(row(slot, "linked") as HTMLElement).queryByRole("link", {
        name: /#1438/,
      }),
    ).toBeNull();
  });

  it("dedupes the branch PR against its linked copy", async () => {
    const branchPr: PluginSidebarPullRequest = {
      number: 7,
      title: "Branch pull request",
      url: "https://github.com/acme/widgets/pull/7",
      state: "open",
      attention: "none",
    };
    links["linked"] = [link({ number: 7, url: branchPr.url })];
    const slot = mount({
      sidebarPullRequests: { linked: branchPr },
    });
    await waitFor(() =>
      expect(
        within(row(slot, "linked") as HTMLElement).getAllByRole("link"),
      ).toHaveLength(1),
    );
    expect(
      within(row(slot, "linked") as HTMLElement).getByRole("link", {
        name: /#7/,
      }),
    ).toBeTruthy();
  });

  it("collapses several links into a count badge and picks one from the popover", async () => {
    links["multi"] = [
      link({ number: 11, url: "https://github.com/acme/widgets/pull/11", title: "First PR", state: "merged" }),
      link({ number: 12, url: "https://github.com/acme/widgets/pull/12", title: "Second PR", state: "open" }),
    ];
    const capture = openRequests();
    try {
      const slot = mount();
      const badge = await waitFor(() =>
        within(row(slot, "multi") as HTMLElement).getByRole("button", {
          name: "2 linked pull requests",
        }),
      );
      // The most attention-worthy state colours the icon: open over merged.
      expect(
        badge.querySelector("[data-pull-request-state]")?.getAttribute(
          "data-pull-request-state",
        ),
      ).toBe("open");
      expect(badge.textContent).toContain("2");

      fireEvent.click(badge);
      const popover = await waitFor(() =>
        slot.getByRole("dialog", { name: "Linked pull requests" }),
      );
      const entries = within(popover).getAllByRole("link");
      expect(entries).toHaveLength(2);
      expect(entries[0]!.textContent).toContain("#11");
      expect(entries[0]!.textContent).toContain("First PR");
      expect(entries[1]!.textContent).toContain("#12");

      fireEvent.click(entries[1]!);
      await tick();
      expect(capture.requests).toHaveLength(1);
      expect(capture.requests[0]!.detail).toEqual({
        url: "https://github.com/acme/widgets/pull/12",
        threadId: "multi",
      });
      // Picking a link neither selects the row nor navigates.
      expect(slot.inspection.sidebarActionCalls).toEqual([]);
      expect(slot.inspection.navigateCalls).toEqual([]);
      expect(
        slot.queryByRole("dialog", { name: "Linked pull requests" }),
      ).toBeNull();
    } finally {
      capture.close();
    }
  });

  it("opens the popover and picks an entry from the keyboard", async () => {
    links["multi"] = [
      link({ number: 11, url: "https://github.com/acme/widgets/pull/11", title: "First PR" }),
      link({ number: 12, url: "https://github.com/acme/widgets/pull/12", title: "Second PR" }),
    ];
    const capture = openRequests();
    try {
      const slot = mount();
      const badge = await waitFor(() =>
        within(row(slot, "multi") as HTMLElement).getByRole("button", {
          name: "2 linked pull requests",
        }),
      );
      fireEvent.keyDown(badge, { key: "Enter" });
      const popover = await waitFor(() =>
        slot.getByRole("dialog", { name: "Linked pull requests" }),
      );
      const entries = within(popover).getAllByRole("link");
      expect(document.activeElement).toBe(entries[0]);
      fireEvent.keyDown(entries[0]!, { key: "ArrowDown" });
      expect(document.activeElement).toBe(entries[1]);
      fireEvent.keyDown(entries[1]!, { key: "Enter" });
      await tick();
      expect(capture.requests[0]?.detail).toEqual({
        url: "https://github.com/acme/widgets/pull/12",
        threadId: "multi",
      });
      expect(slot.inspection.sidebarActionCalls).toEqual([]);
    } finally {
      capture.close();
    }
  });

  it("opens a single chip without selecting the row and refreshes on change signals", async () => {
    links["linked"] = [link({ number: 5 })];
    const capture = openRequests();
    try {
      const slot = mount();
      const chip = await waitFor(() =>
        within(row(slot, "linked") as HTMLElement).getByRole("link", {
          name: /#5/,
        }),
      );
      fireEvent.click(chip);
      expect(capture.requests[0]?.detail).toEqual({
        url: "https://github.com/acme/widgets/pull/1",
        threadId: "linked",
      });
      expect(slot.inspection.sidebarActionCalls).toEqual([]);
      expect(slot.inspection.navigateCalls).toEqual([]);

      // The republished change signal refetches just that thread.
      links["linked"] = [];
      await slot.behavior.emitRealtime("linked-pull-requests-changed", {
        threadId: "linked",
      });
      await waitFor(() =>
        expect(linkedPullRequests).toHaveBeenLastCalledWith({
          threadIds: ["linked"],
        }),
      );
      await waitFor(() =>
        expect(
          within(row(slot, "linked") as HTMLElement).queryByRole("link"),
        ).toBeNull(),
      );
    } finally {
      capture.close();
    }
  });
});
