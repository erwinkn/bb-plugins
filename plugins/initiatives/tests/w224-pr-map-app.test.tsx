// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { orderQueue, parsePullRequests, type MergeQueue, type QueuedPullRequest } from "../lib/merge-queue";
import { PR_STAGES, type PrStage } from "../lib/pr-stages";
import { linkStacks } from "../lib/pr-map";
import { projectFixture } from "./fake-native";
await loadPluginApp(() => import("../app"));
const { MergeQueueView } = await import("../merge-queue-view");
const { Dashboard } = await import("../app");
const slots: ReturnType<typeof renderSlot>[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.unmount(); cleanup(); });

const NOW = Date.now();
const gh = (number: number, head: string, base: string) => ({
  number, title: `PR ${number}`, url: `https://github.com/erwinkn/bb/pull/${number}`, isDraft: false, reviewDecision: "",
  mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefName: head, baseRefName: base,
  createdAt: new Date(NOW - (100 - number) * 3_600_000).toISOString(), updatedAt: new Date(NOW - 60_000).toISOString(), statusCheckRollup: [],
});
const records: Record<number, [PrStage, string | null, string?]> = {
  1: ["ready-for-erwin", "Security", "Rebased, clean"],
  2: ["ready-for-erwin", "Security"],
  3: ["working", "Security"],
  4: ["ready-for-erwin", "Security"],
  5: ["in-review", "CI"],
  6: ["ready-for-review", null],
};
const queue = (): MergeQueue => ({
  projectId: "p", login: "erwinkn", repos: [{ repo: "erwinkn/bb", fetchedAt: NOW - 60_000, error: null, fetching: false, detailsFetchedAt: null, detailsError: null }], skipped: [],
  stages: PR_STAGES.map((s) => ({ ...s })),
  // #1 ← #2 ← #3 ← #4: #4 is ready but waits on #3.
  pullRequests: orderQueue(linkStacks(parsePullRequests("erwinkn/bb", JSON.stringify([
    gh(1, "a", "main"), gh(2, "b", "a"), gh(3, "c", "b"), gh(4, "d", "c"), gh(5, "ci", "main"), gh(6, "misc", "main"),
  ])).map((pr): QueuedPullRequest => {
    const [stage, category, note] = records[pr.number]!;
    return { ...pr, stage, category, stageSource: "coordinator", stageNote: note ?? null, stageSetAt: NOW };
  }))),
});
const view = (openUrl: (url: string) => boolean = () => true) => {
  const slot = renderSlot({ component: MergeQueueView }, { queue: queue(), error: null, refreshing: false, onRefresh: () => {} }, { openUrl });
  slots.push(slot);
  return slot;
};
const headings = (root: HTMLElement, selector: string) => Array.from(root.querySelectorAll(selector)).map((h) => h.textContent);

describe("W224 PR map", () => {
  it("lists PRs by category then stage, with stack positions, Next up and what waits", () => {
    const slot = view();
    expect(headings(slot.container, ".cr-mq-group > h3")).toEqual(["CI1", "Security4", "Uncategorized1"]);
    const security = slot.getByRole("region", { name: "Security" });
    expect(headings(security, "h4")).toEqual(["Ready for you3", "Being worked on1"]);
    const rows = within(security).getAllByRole("link");
    expect(rows.map((r) => r.querySelector(".cr-mq-stack")?.textContent)).toEqual(["1 of 4", "2 of 4 · on #1", "4 of 4 · on #3", "3 of 4 · on #2"]);
    expect(rows.map((r) => r.querySelector(".cr-mq-available, .cr-mq-waits")?.textContent ?? null)).toEqual(["review now", "review now", "waits on #3", null]);
    const next = slot.getByRole("region", { name: "Next up" });
    expect(within(next).getAllByRole("link").map((a) => a.textContent)).toEqual(["#1PR 1Security · 1 of 4", "#2PR 2Security · 2 of 4 · on #1"]);
  });

  it("regroups by stage and filters by category, stage and availability", () => {
    const slot = view();
    fireEvent.click(slot.getByRole("button", { name: "by stage" }));
    expect(headings(slot.container, ".cr-mq-group > h3")).toEqual(["Ready for you3", "In review1", "Ready for review1", "Being worked on1"]);
    expect(headings(slot.getByRole("region", { name: "Ready for you" }), "h4")).toEqual(["Security3"]);

    fireEvent.change(slot.getByRole("combobox", { name: "Category" }), { target: { value: "0" } });
    expect(headings(slot.container, ".cr-mq-group > h3")).toEqual(["In review1"]);
    // Stage chips count within the picked category; Next up follows it too.
    expect(within(slot.getByRole("group", { name: "Filter by stage" })).getAllByRole("button").map((b) => b.textContent)).toEqual(["In review1", "Review now0", "Clear"]);
    expect(slot.queryByRole("region", { name: "Next up" })).toBeNull();

    fireEvent.click(slot.getByRole("button", { name: "Clear" }));
    fireEvent.click(slot.getByRole("button", { name: /^Being worked on/ }));
    expect(slot.getAllByRole("link").map((a) => a.textContent!.slice(0, 4))).toEqual(["#1PR", "#2PR", "PR 3"]);
    fireEvent.click(slot.getByRole("button", { name: /^Being worked on/ }));
    fireEvent.click(slot.getByRole("button", { name: /^Review now/ }));
    expect(headings(slot.container, ".cr-mq-group > h3")).toEqual(["Ready for you2"]);
  });

  it("draws the graph: a lane per category, stacks with edges, available nodes marked, clicks open the PR", () => {
    const openUrl = vi.fn(() => true);
    const slot = view(openUrl);
    fireEvent.click(slot.getByRole("button", { name: "graph" }));
    expect(slot.queryByRole("button", { name: "by stage" })).toBeNull();
    const lanes = slot.container.querySelectorAll<HTMLElement>(".cr-pm-lane");
    expect(Array.from(lanes).map((l) => l.getAttribute("aria-label"))).toEqual(["CI", "Security", "Uncategorized"]);
    const stack = within(lanes[1]!).getByRole("list", { name: "Stack from #1" });
    const nodes = Array.from(stack.querySelectorAll<HTMLElement>(".cr-pm-node"));
    expect(nodes.map((n) => [n.querySelector(".cr-pm-num")!.textContent, n.dataset.stage, n.dataset.available ?? null])).toEqual([
      ["#1", "ready-for-erwin", "true"], ["#2", "ready-for-erwin", "true"], ["#3", "working", null], ["#4", "ready-for-erwin", null],
    ]);
    // A chain: three straight edges.
    expect(stack.querySelectorAll(".cr-pm-edges path")).toHaveLength(3);
    const tip = within(nodes[3]!).getByRole("tooltip");
    expect(tip.textContent).toContain("waits on #3");
    expect(within(nodes[0]!).getByRole("tooltip").textContent).toContain("Rebased, clean");
    expect(fireEvent.click(within(nodes[0]!).getByRole("link"))).toBe(false);
    expect(openUrl).toHaveBeenCalledWith("https://github.com/erwinkn/bb/pull/1");
    expect(within(lanes[0]!).getByRole("list", { name: "Not stacked" }).textContent).toContain("#5");
  });

  it("shows where a PR stands under its row and in the graph's hover card", () => {
    const base = queue();
    const question = { n: 1, at: NOW, author: "coordinator", kind: "question" as const, text: "Redis TTL?", link: null, answered: null };
    const pullRequests = base.pullRequests.map((pr) => pr.number === 4 ? {
      ...pr,
      waitingOn: "W188: move the lock to resume",
      notes: { count: 1, recent: [question], open: [question] },
      changes: ["drop the retry"],
      decision: { text: "Keep 5m", link: "thr_abc123", at: NOW },
      worker: { ref: "W188", threadId: "thr_w188", assignment: "A382", role: "work", source: "coordinator" as const },
    } : pr);
    const slot = renderSlot({ component: MergeQueueView }, { queue: { ...base, pullRequests }, error: null, refreshing: false, onRefresh: () => {} });
    slots.push(slot);
    const line = slot.container.querySelector<HTMLElement>(".cr-mq-state")!;
    expect(Array.from(line.children).map((c) => c.textContent)).toEqual([
      "waiting on W188: move the lock to resume", "coordinator asks: Redis TTL?", "change requested: drop the retry", "decided: Keep 5m thread",
    ]);
    // The state line sits beside the row's link, so its own link is legal and opens the thread.
    expect(line.closest("a")).toBeNull();
    fireEvent.click(within(line).getByRole("link", { name: "thread" }));
    expect(slot.inspection.navigateCalls).toContainEqual(expect.objectContaining({ method: "toThread" }));
    const worker = line.closest("li")!.querySelector(".cr-mq-worker")!;
    expect([worker.textContent, worker.getAttribute("title")]).toEqual(["W188 · A382", "W188 works on it, per the coordinator"]);

    fireEvent.click(slot.getByRole("button", { name: "graph" }));
    const node = Array.from(slot.container.querySelectorAll<HTMLElement>(".cr-pm-node")).find((n) => n.querySelector(".cr-pm-num")!.textContent === "#4")!;
    expect(node.querySelector(".cr-pm-ask")!.textContent).toBe("?");
    expect(within(node).getByRole("link").getAttribute("aria-label")).toMatch(/open questions$/);
    expect(Array.from(node.querySelectorAll(".cr-pm-tip-state")).map((n) => n.textContent)).toEqual([
      "waiting on W188: move the lock to resume", "coordinator asks: Redis TTL?", "change requested: drop the retry", "decided: Keep 5m",
    ]);
    expect(within(node).getByRole("tooltip").textContent).toContain("W188 · A382");
  });

  it("shows +/- lines, files, commits and reviewers on rows, nodes and hover cards", () => {
    const base = queue();
    const pullRequests = base.pullRequests.map((pr) => pr.number === 5 ? {
      ...pr, size: { additions: 1234, deletions: 56, files: 7, commits: 3 },
      reviewers: [{ login: "alice", state: "approved" as const }, { login: "coderabbitai", state: "commented" as const }, { login: "bob", state: "requested" as const }, { login: "carol", state: "changes_requested" as const }],
    } : pr);
    const slot = renderSlot({ component: MergeQueueView }, { queue: { ...base, pullRequests }, error: null, refreshing: false, onRefresh: () => {} });
    slots.push(slot);
    const row = within(slot.getByRole("region", { name: "CI" })).getByRole("link");
    expect(row.querySelector(".cr-mq-size")!.textContent).toBe("+1234−56 7 files · 3 commits");
    expect(row.querySelector(".cr-pr-delta")!.getAttribute("title")).toBe("1234 lines added, 56 removed · 7 files · 3 commits");
    const reviewers = row.querySelector(".cr-mq-reviewers")!;
    expect(Array.from(reviewers.children).map((r) => [r.textContent, r.getAttribute("data-state")])).toEqual([
      ["alice", "approved"], ["coderabbitai", "commented"], ["bob", "requested"], ["+1", null],
    ]);
    expect(reviewers.getAttribute("title")).toBe("alice approved\ncoderabbitai commented\nbob review requested\ncarol requested changes");
    // A PR whose details haven't loaded shows none.
    expect(within(slot.getByRole("region", { name: "Uncategorized" })).getByRole("link").querySelector(".cr-mq-size")).toBeNull();

    fireEvent.click(slot.getByRole("button", { name: "graph" }));
    const node = Array.from(slot.container.querySelectorAll<HTMLElement>(".cr-pm-node")).find((n) => n.querySelector(".cr-pm-num")!.textContent === "#5")!;
    expect(node.querySelector("a .cr-pr-delta")!.textContent).toBe("+1.2k−56");
    const tip = within(node).getByRole("tooltip").textContent!;
    expect(tip).toContain("+1234−56 · 7 files · 3 commits · updated 1m ago");
    expect(tip).toContain("alice approved · coderabbitai commented · bob review requested · carol requested changes");
  });

  it("remembers the PRs tab's view and filters per Initiative", () => {
    const first = view();
    fireEvent.click(first.getByRole("button", { name: "graph" }));
    fireEvent.click(first.getByRole("button", { name: /^Review now/ }));
    first.unmount();
    slots.splice(slots.indexOf(first), 1);
    const again = view();
    expect(again.getByRole("button", { name: "graph" }).getAttribute("aria-pressed")).toBe("true");
    expect(again.getByRole("button", { name: /^Review now/ }).getAttribute("aria-pressed")).toBe("true");
    // A stored value this version can't read falls back to the defaults.
    cleanup();
    localStorage.setItem("initiatives:prs:p", JSON.stringify({ mode: "map" }));
    expect(view().getByRole("button", { name: "list" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps the plain stage list when no PR has a category", () => {
    const plain = queue();
    const slot = renderSlot({ component: MergeQueueView }, { queue: { ...plain, pullRequests: plain.pullRequests.map((pr) => ({ ...pr, category: null })) }, error: null, refreshing: false, onRefresh: () => {} });
    slots.push(slot);
    expect(headings(slot.container, ".cr-mq-group > h3")).toEqual(["Ready for you3", "In review1", "Ready for review1", "Being worked on1"]);
    expect(slot.container.querySelector("h4")).toBeNull();
    expect(slot.queryByRole("combobox", { name: "Category" })).toBeNull();
    expect(slot.queryByRole("button", { name: "by stage" })).toBeNull();
  });
});

describe("W224 the dashboard remembers its tab", () => {
  const dashboard = async (props: Record<string, unknown>) => {
    const { f, project } = await projectFixture();
    const summary = await f.harness.callRpc("overview", { projectId: project.id, detail: "summary" });
    const rpc = { overview: async () => summary, mergeQueue: async () => ({ ...queue(), projectId: project.id }) };
    const mount = (extra: Record<string, unknown> = {}) => {
      const slot = renderSlot({ component: Dashboard }, { projectId: project.id, ...props, ...extra }, { rpc });
      slots.push(slot);
      return slot;
    };
    return { project, mount };
  };
  const selected = async (slot: ReturnType<typeof renderSlot>) =>
    (await slot.findAllByRole("tab")).find((t) => t.getAttribute("aria-selected") === "true")!.textContent;

  it("in a thread's panel: leaving and coming back reopens the last tab", async () => {
    const { mount } = await dashboard({ variant: "panel" });
    const first = mount();
    fireEvent.click(await first.findByRole("tab", { name: /PRs/ }));
    expect(await selected(first)).toMatch(/^PRs/);
    first.unmount();
    expect(await selected(mount())).toMatch(/^PRs/);
  });

  it("on the page: the tab is the route's last segment, replaced in place as tabs change", async () => {
    const { project, mount } = await dashboard({});
    const slot = mount({ routeTab: "tasks" });
    expect(await selected(slot)).toMatch(/^Tasks/);
    fireEvent.click(slot.getByRole("tab", { name: /PRs/ }));
    expect(slot.inspection.navigateCalls.at(-1)).toEqual({ method: "toPluginPanel", path: "initiatives", options: { subPath: `${project.id}/prs`, replace: true } });
    fireEvent.click(slot.getByRole("tab", { name: /Inbox/ }));
    expect(slot.inspection.navigateCalls.at(-1)).toEqual({ method: "toPluginPanel", path: "initiatives", options: { subPath: project.id, replace: true } });
    // Without a tab in the route, the remembered one opens and the route follows it.
    fireEvent.click(slot.getByRole("tab", { name: /Tasks/ }));
    slot.unmount();
    const again = mount();
    expect(await selected(again)).toMatch(/^Tasks/);
    expect(again.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "initiatives", options: { subPath: `${project.id}/tasks`, replace: true } });
  });
});
