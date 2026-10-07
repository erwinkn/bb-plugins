// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { orderQueue, parsePullRequests, type MergeQueue } from "../lib/merge-queue";
import { PR_STAGES } from "../lib/pr-stages";
import { projectFixture } from "./fake-native";
await loadPluginApp(() => import("../app"));
const { Dashboard } = await import("../app");
const { MergeQueueView } = await import("../merge-queue-view");
const slots: ReturnType<typeof renderSlot>[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.unmount(); cleanup(); vi.restoreAllMocks(); });

const NOW = Date.now();
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const ghPr = (number: number, overrides: Record<string, unknown> = {}) => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/erwinkn/bb-plugins/pull/${number}`,
  isDraft: false,
  reviewDecision: "APPROVED",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  headRefName: `feature-${number}`,
  baseRefName: "main",
  createdAt: iso(600 - number),
  updatedAt: iso(30),
  statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
  ...overrides,
});
const queue = (overrides: Partial<MergeQueue> = {}, prs = [
  ghPr(68, { title: "Questions: drop string maxLength", headRefName: "bb/w198-merge-queue-thr_5t6t6jjct3" }),
  ghPr(70, { title: "Sidebar: branch chip", isDraft: true, reviewDecision: "" }),
  ghPr(71, { title: "Editor: conflicts", mergeable: "CONFLICTING", statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }, { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] }),
  ghPr(72, { title: "Plans: checks running", reviewDecision: "REVIEW_REQUIRED", statusCheckRollup: [{ __typename: "CheckRun", status: "IN_PROGRESS" }] }),
]): MergeQueue => ({
  projectId: "init-1",
  login: "erwinkn",
  repos: [{ repo: "erwinkn/bb-plugins", fetchedAt: NOW - 60_000, error: null }],
  skipped: [],
  stages: PR_STAGES.map((stage) => ({ ...stage })),
  pullRequests: orderQueue(parsePullRequests("erwinkn/bb-plugins", JSON.stringify(prs)).map((pr) =>
    pr.number === 68 ? { ...pr, worker: { ref: "W198", threadId: "thr_5t6t6jjct3" } } : pr)),
  ...overrides,
});
const view = (props: Partial<Parameters<typeof MergeQueueView>[0]>, openUrl: (url: string) => boolean = () => true) => {
  const slot = renderSlot({ component: MergeQueueView }, { queue: queue(), error: null, refreshing: false, onRefresh: () => {}, ...props }, { openUrl });
  slots.push(slot);
  return slot;
};

describe("W198 merge queue view", () => {
  it("groups PRs by stage with their review, checks, mergeability, branches and times", () => {
    const slot = view({});
    const groups = slot.container.querySelectorAll<HTMLElement>(".cr-mq-group");
    // GitHub guesses: approved, green and mergeable is ready for you; drafts are being worked on.
    expect(Array.from(groups).map((g) => g.querySelector("h3")!.textContent)).toEqual(["Ready for you1", "Ready for review2", "Being worked on1"]);
    const ready = within(groups[0]!).getByRole("link");
    expect(ready.getAttribute("href")).toBe("https://github.com/erwinkn/bb-plugins/pull/68");
    expect(ready.textContent).toContain("Questions: drop string maxLength");
    // The user's own repos drop the owner; the head and base branches show.
    expect(ready.textContent).toContain("bb-plugins #68");
    expect(within(ready).getByText("bb/w198-merge-queue-thr_5t6t6jjct3")).toBeTruthy();
    expect(ready.querySelector(".cr-mq-branch")!.textContent).toBe("bb/w198-merge-queue-thr_5t6t6jjct3→main");
    expect(Array.from(ready.querySelectorAll(".cr-mq-signal")).map((s) => s.textContent)).toEqual(["1/1 checks", "approved", "mergeable"]);
    expect(ready.querySelector(".cr-mq-worker")!.textContent).toBe("W198");
    expect(ready.querySelector(".cr-mq-updated time")!.textContent).toBe("30m");
    expect(ready.querySelector(".cr-mq-opened time")!.textContent).toBe("8h");
    const [fix, waiting] = within(groups[1]!).getAllByRole("link");
    expect(Array.from(waiting!.querySelectorAll(".cr-mq-signal")).map((s) => s.textContent)).toEqual(["1 of 1 running", "review required", "mergeable"]);
    expect(Array.from(fix!.querySelectorAll(".cr-mq-signal")).map((s) => [s.textContent, s.getAttribute("data-tone")])).toEqual([
      ["1 of 2 failing", "bad"], ["approved", "good"], ["conflicts", "bad"],
    ]);
    expect(fix!.getAttribute("title")).toBe("Editor: conflicts\n1 check failing, conflicts");
    expect(fix!.getAttribute("data-group")).toBe("fix");
    expect(within(groups[2]!).getByRole("link").getAttribute("data-group")).toBe("draft");
    // Every stage here is guessed, and says so quietly.
    expect(slot.container.querySelectorAll(".cr-mq-guess")).toHaveLength(4);
    expect(slot.getByText("Updated 1m ago")).toBeTruthy();
    expect(slot.container.querySelector(".cr-mq-foot")!.textContent).toBe("Open PRs by erwinkn in erwinkn/bb-plugins");
  });

  it("tells the coordinator's stage and note from a guess", () => {
    const base = queue();
    const pullRequests = orderQueue(base.pullRequests.map((pr) => pr.number === 70
      ? { ...pr, stage: "in-review" as const, stageSource: "coordinator" as const, stageNote: "W14 reviewing", stageSetAt: NOW - 3_600_000 }
      : pr));
    const slot = view({ queue: { ...base, pullRequests } });
    const groups = Array.from(slot.container.querySelectorAll<HTMLElement>(".cr-mq-group"));
    expect(groups.map((g) => [g.getAttribute("data-stage"), g.querySelector("h3")!.textContent])).toEqual([
      ["ready-for-erwin", "Ready for you1"], ["in-review", "In review1"], ["ready-for-review", "Ready for review2"],
    ]);
    const staged = within(groups[1]!).getByRole("link");
    expect(staged.querySelector(".cr-mq-guess")).toBeNull();
    expect(staged.querySelector(".cr-mq-stage-note")!.textContent).toBe("W14 reviewing");
    expect(staged.querySelector(".cr-mq-stage-note")!.getAttribute("title")).toMatch(/^Set by the coordinator /);
    // The row keeps its GitHub signals: the draft glyph and "draft".
    expect(staged.getAttribute("data-group")).toBe("draft");
    expect(within(groups[0]!).getByRole("link").querySelector(".cr-mq-guess")!.textContent).toBe("guessed");
  });

  it("opens a PR in a tab of BB's browser and leaves modifier clicks to the anchor", () => {
    const openUrl = vi.fn(() => true);
    const slot = view({}, openUrl);
    const link = within(slot.container.querySelector<HTMLElement>(".cr-mq-group")!).getByRole("link");
    // fireEvent returns false when the handler prevented the default.
    expect(fireEvent.click(link)).toBe(false);
    expect(openUrl).toHaveBeenCalledWith("https://github.com/erwinkn/bb-plugins/pull/68");
    expect(slot.inspection.navigateCalls).toEqual([{ method: "openUrl", url: "https://github.com/erwinkn/bb-plugins/pull/68" }]);
    expect(fireEvent.click(link, { metaKey: true })).toBe(true);
    expect(fireEvent.click(link, { button: 1 })).toBe(true);
    expect(openUrl).toHaveBeenCalledTimes(1);
    // A safe default when script never runs: a new tab, never BB's own window.
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("falls back to a new tab when the host declines the URL", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const slot = view({}, () => false);
    fireEvent.click(within(slot.container.querySelector<HTMLElement>(".cr-mq-group")!).getByRole("link"));
    expect(open).toHaveBeenCalledWith("https://github.com/erwinkn/bb-plugins/pull/68", "_blank", "noopener,noreferrer");
  });

  it("keeps the last good data beside a failed refresh", () => {
    const slot = view({ queue: queue({ repos: [{ repo: "erwinkn/bb-plugins", fetchedAt: NOW - 12 * 60_000, error: "HTTP 502: Server Error" }] }) });
    expect(slot.getByText("Couldn't refresh · from 12m ago")).toBeTruthy();
    expect(slot.getByRole("status").textContent).toBe("erwinkn/bb-plugins: HTTP 502: Server Error. Showing the last data that loaded.");
    expect(slot.getAllByRole("link")).toHaveLength(4);
  });

  it("explains a fetch that never succeeded and retries from the alert", () => {
    const onRefresh = vi.fn();
    const slot = view({
      onRefresh,
      queue: queue({ login: null, repos: [{ repo: "erwinkn/bb-plugins", fetchedAt: null, error: "To get started with GitHub CLI, please run: gh auth login" }], pullRequests: [] }),
    });
    const alert = slot.getByRole("alert");
    expect(alert.textContent).toContain("gh auth login");
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(slot.queryByText(/No open pull requests/)).toBeNull();
  });

  it("shows loading, empty, no-remote and read-error states", () => {
    expect(view({ queue: null }).getByText("Loading pull requests…")).toBeTruthy();
    cleanup();
    expect(view({ queue: queue({}, []) }).getByText("No open pull requests by erwinkn.")).toBeTruthy();
    cleanup();
    expect(view({ queue: queue({ repos: [], skipped: [{ project: "scratch", reason: "no GitHub origin remote" }] }, []) }).getByText("No member project has a GitHub origin remote.")).toBeTruthy();
    cleanup();
    expect(view({ queue: null, error: "Unknown Initiative init-1." }).getByRole("alert").textContent).toContain("Couldn't load the merge queue: Unknown Initiative init-1.");
    cleanup();
    expect(view({ error: "connection lost" }).getByRole("status").textContent).toBe("Couldn't refresh: connection lost");
  });
});

describe("W198 merge queue on the dashboard", () => {
  it("loads when the dashboard opens, counts PRs on its tab and refreshes on demand in the side panel", async () => {
    const { f, project } = await projectFixture();
    const summary = await f.harness.callRpc("overview", { projectId: project.id, detail: "summary" });
    let current = queue({ projectId: project.id });
    const mergeQueue = vi.fn(async (input: unknown) => {
      void input;
      return current;
    });
    const openUrl = vi.fn(() => true);
    const slot = renderSlot({ component: Dashboard }, { projectId: project.id, variant: "panel" as const }, { rpc: { overview: async () => summary, mergeQueue }, openUrl });
    slots.push(slot);
    expect(slot.container.querySelector(".bb-projects--panel")).toBeTruthy();
    // Read at open, before the tab is chosen, so the tab carries the count.
    const tab = await slot.findByRole("tab", { name: /PRs/ });
    await waitFor(() => expect(tab.textContent).toBe("PRs4"));
    expect(mergeQueue).toHaveBeenCalledWith({ projectId: project.id });
    fireEvent.click(tab);
    const panel = slot.getByRole("tabpanel");
    const section = within(panel).getByRole("region", { name: "Merge queue" });
    expect(within(section).getAllByRole("link")).toHaveLength(4);
    fireEvent.click(within(section).getAllByRole("link")[0]!);
    expect(openUrl).toHaveBeenCalledWith("https://github.com/erwinkn/bb-plugins/pull/68");

    current = queue({ projectId: project.id }, [ghPr(80, { title: "Fresh PR" })]);
    fireEvent.click(within(section).getByRole("button", { name: "Refresh merge queue" }));
    expect(mergeQueue).toHaveBeenLastCalledWith({ projectId: project.id, refresh: true });
    await within(section).findByText("Fresh PR");
    await waitFor(() => expect(tab.textContent).toBe("PRs1"));
  });
});
