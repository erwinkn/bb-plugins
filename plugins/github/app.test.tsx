// @vitest-environment jsdom
import { act, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, mountPluginContentScripts, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { OPEN_PULL_REQUEST_EVENT, requestOpenPullRequest, resetOpenPullRequestBridge } from "./lib/open-pull-request";

const app = await loadPluginApp(() => import("./app"));
const panel = app.threadPanelActions.find((action) => action.id === "pull")!;
const headerAction = app.threadHeaderActions.find((action) => action.id === "pull-requests")!;
const overlay = app.appOverlays.find((entry) => entry.id === "open-pull-request")!;

const status = () => ({ ghOk: true, ghState: "ready" as const, ghError: null, repos: [{ repo: "get-bb/bb", projectId: null }], lastSyncedAt: null });
const link = (number: number, overrides: Record<string, unknown> = {}) => ({
  threadId: "thr-1",
  repo: "get-bb/bb",
  number,
  url: `https://github.com/get-bb/bb/pull/${number}`,
  source: "branch",
  title: `Change ${number}`,
  state: "open",
  linkedAt: "2026-09-13T00:00:00.000Z",
  ...overrides,
});
const pull = (number: number) => ({
  pull: {
    repo: "get-bb/bb",
    number,
    title: `Navigation fix ${number}`,
    state: "OPEN",
    author: "octocat",
    body: "",
    url: `https://github.com/get-bb/bb/pull/${number}`,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    baseRefName: "main",
    headRefName: "fix-navigation",
    additions: 1,
    deletions: 1,
    changedFiles: 2,
    labels: [],
    assignees: [],
    reviewDecision: "",
    mergeStateStatus: "CLEAN",
    reviewRequests: [],
    checks: [],
    comments: [],
    reviews: [],
    reviewThreads: [],
    files: [
      { path: "removed.ts", status: "removed", additions: 0, deletions: 1, patch: "@@ -1 +0,0 @@\n-removed" },
      { path: "modified.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+added" },
    ],
  },
});

beforeEach(() => {
  resetOpenPullRequestBridge();
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  resetOpenPullRequestBridge();
  vi.restoreAllMocks();
});

describe("GitHub app navigation", () => {
  it("opens issue details in the URL-backed page instead of a fixed tab", async () => {
    const navPanel = app.navPanels[0]!;
    expect(navPanel.fixedTabs).toBeUndefined();
    const slot = renderSlot(
      navPanel,
      { subPath: "issues" },
      {
        rpc: {
          listItems: () => ({
            items: [
              {
                repo: "get-bb/bb",
                number: 42,
                kind: "issue",
                title: "Route-backed issue",
                state: "OPEN",
                author: "octocat",
                labels: [],
                assignees: [],
                url: "https://github.com/get-bb/bb/issues/42",
                body: "",
                updatedAt: "2026-08-20T00:00:00.000Z",
              },
            ],
          }),
          listLinks: () => ({ links: {} }),
          status,
          viewer: () => ({ login: "octocat" }),
        },
      },
    );
    (await slot.findByText("Route-backed issue")).click();
    expect(slot.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "github", options: { subPath: "issues/get-bb/bb/42" } });
    slot.lifecycle.unmount();
  });

  it("uses the standard responsive page inset for the main panel", () => {
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { listItems: () => ({ items: [] }), status, viewer: () => ({ login: "octocat" }) } });
    expect(slot.container.firstElementChild?.className).toContain("p-4 md:p-5");
    slot.lifecycle.unmount();
  });
});

describe("GitHub PR panel", () => {
  it("lists linked pull requests and opens one in the read-only viewer", async () => {
    const slot = renderSlot(
      panel,
      { threadId: "thr-1", params: null },
      {
        rpc: {
          listPullRequests: () => ({ links: [link(42), link(7, { source: "agent", state: "merged" })], environmentId: "env-1" }),
          getPull: (input: unknown) => pull((input as { number: number }).number),
          listLinks: () => ({ links: {} }),
        },
      },
    );
    await slot.findByText("Linked pull requests · 2");
    expect(slot.getByText("Change 42")).toBeTruthy();
    expect(slot.getByText("linked by agent")).toBeTruthy();
    expect(slot.getByText("merged")).toBeTruthy();

    fireEvent.click(slot.getByLabelText("Open get-bb/bb#42"));
    await slot.findByText("Navigation fix 42");
    expect(slot.queryByText("Review with agent")).toBeNull();
    expect(slot.queryByPlaceholderText("Leave a comment…")).toBeNull();
    expect(slot.getByText("modified.ts").closest("a")?.getAttribute("href")).toBe("./modified.ts");
    expect(slot.getByText("removed.ts").closest("a")).toBeNull();
    expect(slot.getByText("Open on GitHub ↗").hasAttribute("data-github-open-external")).toBe(true);

    fireEvent.click(slot.getByText("← Linked PRs"));
    await slot.findByText("Linked pull requests · 2");
    slot.lifecycle.unmount();
  });

  it("opens the PR named by params straight away and refetches on the change signal", async () => {
    const lists = vi.fn(() => ({ links: [link(42)], environmentId: null }));
    const slot = renderSlot(
      panel,
      { threadId: "thr-1", params: { url: "https://github.com/get-bb/bb/pull/42/files" } },
      { rpc: { listPullRequests: lists, getPull: (input: unknown) => pull((input as { number: number }).number), listLinks: () => ({ links: {} }) } },
    );
    await slot.findByText("Navigation fix 42");
    await waitFor(() => expect(lists).toHaveBeenCalledTimes(1));
    await slot.emitRealtime("pull-requests-changed", { threadId: "thr-1" });
    await waitFor(() => expect(lists).toHaveBeenCalledTimes(2));
    await slot.emitRealtime("pull-requests-changed", { threadId: "thr-other" });
    expect(lists).toHaveBeenCalledTimes(2);
    await slot.setRealtimeConnectionState("reconnecting" as never);
    await slot.setRealtimeConnectionState("connected");
    await waitFor(() => expect(lists).toHaveBeenCalledTimes(3));
    slot.lifecycle.unmount();
  });

  it("links a pasted reference and unlinks a row", async () => {
    const linkPullRequest = vi.fn(() => ({ link: link(9, { source: "user" }), created: true }));
    const unlinkPullRequest = vi.fn(() => ({ ok: true as const, removed: true }));
    const slot = renderSlot(
      panel,
      { threadId: "thr-1", params: null },
      { rpc: { listPullRequests: () => ({ links: [link(42)], environmentId: null }), linkPullRequest, unlinkPullRequest, listLinks: () => ({ links: {} }) } },
    );
    await slot.findByText("Change 42");
    fireEvent.change(slot.getByLabelText("Pull request to link"), { target: { value: "#9" } });
    fireEvent.click(slot.getByText("Link"));
    await waitFor(() => expect(linkPullRequest).toHaveBeenCalledWith({ threadId: "thr-1", reference: "#9" }));
    fireEvent.click(slot.getByLabelText("Unlink get-bb/bb#42"));
    await waitFor(() => expect(unlinkPullRequest).toHaveBeenCalledWith({ threadId: "thr-1", repo: "get-bb/bb", number: 42 }));
    slot.lifecycle.unmount();
  });
});

describe("open pull request bridge", () => {
  it("opens the viewer tab of the mounted thread pane and shows a count button", async () => {
    const openThreadPanel = vi.fn(() => true);
    const slot = renderSlot(
      headerAction,
      { threadId: "thr-1", projectId: "proj-1", isCompactViewport: false },
      { rpc: { listPullRequests: () => ({ links: [link(42), link(43)], environmentId: null }) }, openThreadPanel },
    );
    await slot.findByText("PR · 2");
    expect(requestOpenPullRequest({ url: "https://github.com/get-bb/bb/pull/42", threadId: "thr-1" })).toBe(true);
    expect(openThreadPanel).toHaveBeenCalledWith({ actionId: "pull", title: "GitHub PR", params: { url: "https://github.com/get-bb/bb/pull/42" } });
    // No thread id but a single pane: still handled.
    expect(requestOpenPullRequest({ url: "https://github.com/get-bb/bb/pull/43", threadId: null })).toBe(true);
    // Another thread: not this pane's business.
    expect(requestOpenPullRequest({ url: "https://github.com/get-bb/bb/pull/44", threadId: "thr-2" })).toBe(false);
    fireEvent.click(slot.getByLabelText("2 linked pull requests"));
    expect(openThreadPanel).toHaveBeenLastCalledWith({ actionId: "pull", title: "GitHub PR", params: { list: true } });
    slot.lifecycle.unmount();
    expect(requestOpenPullRequest({ url: "https://github.com/get-bb/bb/pull/42", threadId: "thr-1" })).toBe(false);
  });

  it("renders nothing visible without links but still answers requests", async () => {
    const openThreadPanel = vi.fn(() => true);
    const slot = renderSlot(
      headerAction,
      { threadId: "thr-1", projectId: "proj-1", isCompactViewport: true },
      { rpc: { listPullRequests: () => ({ links: [], environmentId: null }) }, openThreadPanel },
    );
    await act(async () => {});
    expect(slot.queryByRole("button")).toBeNull();
    expect(requestOpenPullRequest({ url: "https://github.com/get-bb/bb/pull/1", threadId: "thr-1" })).toBe(true);
    slot.lifecycle.unmount();
  });

  it("overlay navigates to a thread that is not in view and parks the URL for its header action", async () => {
    const overlaySlot = renderSlot(overlay, {}, {});
    window.history.replaceState(null, "", "/projects/proj-1/threads/thr-9");
    expect(requestOpenPullRequest({ url: "https://github.com/get-bb/bb/pull/5", threadId: "thr-1" })).toBe(true);
    expect(overlaySlot.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr-1" });

    const openThreadPanel = vi.fn(() => true);
    const headerSlot = renderSlot(
      headerAction,
      { threadId: "thr-1", projectId: "proj-1", isCompactViewport: false },
      { rpc: { listPullRequests: () => ({ links: [], environmentId: null }) }, openThreadPanel },
    );
    await act(async () => {});
    expect(openThreadPanel).toHaveBeenCalledWith({ actionId: "pull", title: "GitHub PR", params: { url: "https://github.com/get-bb/bb/pull/5" } });
    headerSlot.lifecycle.unmount();
    overlaySlot.lifecycle.unmount();
  });

  it("overlay opens the URL with the browser preference when no thread is involved", () => {
    const openUrl = vi.fn(() => true);
    const overlaySlot = renderSlot(overlay, {}, { openUrl });
    expect(requestOpenPullRequest({ url: "https://github.com/get-bb/bb/pull/5", threadId: null })).toBe(true);
    expect(openUrl).toHaveBeenCalledWith("https://github.com/get-bb/bb/pull/5");
    overlaySlot.lifecycle.unmount();
    expect(requestOpenPullRequest({ url: "https://github.com/get-bb/bb/pull/5", threadId: null })).toBe(false);
  });

  it("header action wins over the overlay for the thread in view", async () => {
    const openUrl = vi.fn(() => true);
    const overlaySlot = renderSlot(overlay, {}, { openUrl });
    const openThreadPanel = vi.fn(() => true);
    const headerSlot = renderSlot(
      headerAction,
      { threadId: "thr-1", projectId: "proj-1", isCompactViewport: false },
      { rpc: { listPullRequests: () => ({ links: [], environmentId: null }) }, openThreadPanel },
    );
    await act(async () => {});
    expect(requestOpenPullRequest({ url: "https://github.com/get-bb/bb/pull/6", threadId: "thr-1" })).toBe(true);
    expect(openThreadPanel).toHaveBeenCalledTimes(1);
    expect(openUrl).not.toHaveBeenCalled();
    headerSlot.lifecycle.unmount();
    overlaySlot.lifecycle.unmount();
  });
});

describe("pull request link content script", () => {
  it("intercepts a Markdown-style PR anchor click and dispatches the window event", async () => {
    const mounted = await mountPluginContentScripts(app, { pluginId: "github-prs" });
    expect(mounted.inspection.mountedIds).toEqual(["pull-request-links"]);
    const seen: unknown[] = [];
    const handler = (event: Event) => {
      seen.push((event as CustomEvent).detail);
      event.preventDefault();
    };
    window.addEventListener(OPEN_PULL_REQUEST_EVENT, handler);
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    window.history.replaceState(null, "", "/threads/thr-1");
    const anchor = document.createElement("a");
    anchor.href = "https://github.com/get-bb/bb/pull/42";
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    document.body.append(anchor);

    const plain = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    anchor.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(true);
    expect(seen).toEqual([{ url: "https://github.com/get-bb/bb/pull/42", threadId: "thr-1", element: anchor }]);
    expect(open).not.toHaveBeenCalled();

    const modified = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, metaKey: true });
    anchor.dispatchEvent(modified);
    expect(modified.defaultPrevented).toBe(false);
    expect(seen).toHaveLength(1);

    window.removeEventListener(OPEN_PULL_REQUEST_EVENT, handler);
    const unhandled = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    anchor.dispatchEvent(unhandled);
    expect(unhandled.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith("https://github.com/get-bb/bb/pull/42", "_blank", "noopener,noreferrer");

    await mounted.lifecycle.dispose();
    const after = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    anchor.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
    anchor.remove();
  });
});
