// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { orderQueue, parsePullRequests, type MergeQueue, type QueuedPullRequest } from "../lib/merge-queue";
import { PR_STAGES } from "../lib/pr-stages";
import { linkStacks } from "../lib/pr-map";
import type { PrDetail } from "../lib/pr-detail";
import { rollup } from "./gh-fixtures";
await loadPluginApp(() => import("../app"));
const { MergeQueueView } = await import("../merge-queue-view");
const slots: ReturnType<typeof renderSlot>[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.unmount(); cleanup(); });

const NOW = Date.now();
const url = (n: number) => `https://github.com/erwinkn/bb/pull/${n}`;
const gh = (number: number, title: string, head: string, base: string) => ({
  number, title, url: url(number), isDraft: false, reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED",
  headRefName: head, baseRefName: base, createdAt: new Date(NOW - (3000 - number) * 60_000).toISOString(), updatedAt: new Date(NOW - 60_000).toISOString(),
  statusCheckRollup: rollup({ SUCCESS: 1 }),
});
const queue = (): MergeQueue => ({
  projectId: "p", login: "erwinkn", repos: [{ repo: "erwinkn/bb", fetchedAt: NOW - 60_000, error: null, fetching: false, detailsFetchedAt: null, detailsError: null }], skipped: [],
  stages: PR_STAGES.map((s) => ({ ...s })),
  // #2251 ← #2254: a stack.
  pullRequests: orderQueue(linkStacks(parsePullRequests("erwinkn/bb", [
    gh(2251, "SWC prep: circular imports", "chore/swc-prep", "dev"), gh(2254, "SWC: Swagger types", "chore/swagger", "chore/swc-prep"), gh(22, "Old docs", "docs", "dev"),
  ]).map((pr): QueuedPullRequest => pr.number === 2254
    ? { ...pr, stage: "in-review", stageSource: "coordinator", stageNote: "W12 reviewing", stageSetAt: NOW - 3_600_000, category: "SWC", links: { workers: ["W12"], assignments: ["A41"] } }
    : pr.number === 2251 ? { ...pr, category: "SWC", size: { additions: 908, deletions: 386, files: 48, commits: 5 }, reviewers: [{ login: "alice", state: "approved" }] } : pr))),
});
const detail = (n: number): PrDetail => ({
  url: url(n), record: null, stages: { items: [], total: 0 },
  notes: { items: [{ n: 1, at: NOW, author: "W217", kind: "note", text: "Pushed with the hook escape.", link: "A277", answered: null }], total: 1 },
  assignments: { items: [
    { ref: "A973", worker: "W833", role: "review", state: "running", via: ["mention"], threadId: "thr_w833", createdAt: NOW, reportedAt: null, outcome: null, summary: null },
    { ref: "A277", worker: "W217", role: "work", state: "reported", via: ["note", "report"], threadId: "thr_w217", createdAt: NOW - 9e6, reportedAt: NOW - 8e6, outcome: "succeeded", summary: "PR 1 pushed, waiting on the chain." },
  ], total: 2 },
  workers: [{ ref: "W833", label: "Review #2251", role: "review", state: "active", threadId: "thr_w833", model: "gpt" }, { ref: "W217", label: "SWC prep", role: "work", state: "retired", threadId: "thr_w217", model: null }],
  decisions: { items: [{ ref: "D624", title: "Chain order: dev ← #2294 ← #2251", status: "active", madeBy: "agent", description: "Chain order: dev ← #2294 ← #2251", createdAt: NOW, via: ["mention"] }], total: 1 },
  updates: { items: [], total: 0 },
});
const view = (loadDetail = vi.fn(async (u: string) => detail(Number(u.split("/").pop())))) => {
  const slot = renderSlot({ component: MergeQueueView }, { queue: queue(), error: null, refreshing: false, onRefresh: () => {}, loadDetail });
  slots.push(slot);
  return { slot, loadDetail };
};
const rows = (root: HTMLElement) => Array.from(root.querySelectorAll(".cr-mq-repo")).map((r) => r.textContent);
const search = (slot: ReturnType<typeof renderSlot>) => slot.getByRole("searchbox", { name: "Search pull requests" });
const settle = () => act(async () => { await Promise.resolve(); });

describe("T156 PR search and detail", () => {
  it("filters the list as the user types, alongside the stage filters", () => {
    const { slot } = view();
    expect(rows(slot.container)).toHaveLength(3);
    fireEvent.change(search(slot), { target: { value: "2251" } });
    expect(rows(slot.container)).toEqual(["bb #2251"]);
    expect(slot.getByRole("status").textContent).toBe("1 matchEnter opens #2251");
    fireEvent.change(search(slot), { target: { value: "W12" } });
    expect(rows(slot.container)).toEqual(["bb #2254"]);
    fireEvent.change(search(slot), { target: { value: "swc" } });
    expect(rows(slot.container)).toHaveLength(2);
    // Next up steps aside while searching; a stage filter narrows the matches and says what it hides.
    expect(slot.queryByRole("region", { name: "Next up" })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: /^In review/ }));
    expect(rows(slot.container)).toEqual(["bb #2254"]);
    expect(slot.getByRole("status").textContent).toMatch(/^1 match · 1 more behind the filters Show them/);
    fireEvent.click(within(slot.getByRole("status")).getByRole("button", { name: "Show them" }));
    expect(rows(slot.container)).toHaveLength(2);
    fireEvent.change(search(slot), { target: { value: "nothing like it" } });
    expect(slot.getByText("No pull requests match this search.")).toBeTruthy();
  });

  it("opens the PR an exact number names on Enter, shows a placeholder, then everything known; Esc closes", async () => {
    const { slot, loadDetail } = view();
    fireEvent.change(search(slot), { target: { value: "#2251" } });
    fireEvent.keyDown(search(slot), { key: "Enter" });
    const panel = slot.getByRole("complementary", { name: "Pull request #2251" });
    expect(loadDetail).toHaveBeenCalledWith(url(2251));
    expect(within(panel).getByRole("status", { name: "Loading the PR's history" })).toBeTruthy();
    // GitHub's side shows at once, from the queue.
    expect(within(panel).getByRole("heading", { name: "SWC prep: circular imports" })).toBeTruthy();
    const github = within(panel).getByRole("region", { name: "GitHub" });
    expect(github.textContent).toContain("chore/swc-prep→dev");
    expect(github.textContent).toContain("+908−386 · 48 files · 5 commits");
    expect(github.textContent).toContain("alice approved");
    expect(github.textContent).toContain("level 1 of 2 · 2 PRs");
    await settle();
    expect(within(panel).getByRole("region", { name: "Notes" }).textContent).toContain("Pushed with the hook escape.");
    expect(within(panel).queryByRole("region", { name: "Tasks" })).toBeNull();
    const work = within(panel).getByRole("region", { name: "Work" });
    expect(Array.from(work.querySelectorAll(".cr-pd-via")).map((v) => v.textContent)).toEqual(["mentions it", "note · report"]);
    fireEvent.click(within(work).getAllByRole("link")[1]!);
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr_w217" });
    expect(within(panel).getByRole("region", { name: "Decisions" }).textContent).toContain("D624");
    expect(within(panel).getByRole("region", { name: "Workers" }).textContent).toBe("Workers2W833W217");
    // The row says its panel is open; Esc in the search closes the panel first, then clears the search.
    expect(slot.getByRole("button", { name: "Details of #2251" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(search(slot), { key: "Escape" });
    expect(slot.queryByRole("complementary")).toBeNull();
    expect((search(slot) as HTMLInputElement).value).toBe("#2251");
    fireEvent.keyDown(search(slot), { key: "Escape" });
    expect((search(slot) as HTMLInputElement).value).toBe("");
  });

  it("opens from a row's button, moves along the stack, closes on Esc anywhere, and is remembered", async () => {
    const { slot } = view();
    fireEvent.click(slot.getByRole("button", { name: "Details of #2251" }));
    let panel = slot.getByRole("complementary", { name: "Pull request #2251" });
    await settle();
    expect(document.activeElement).toBe(within(panel).getByRole("heading", { level: 3 }));
    // #2254 sits on #2251: its chip opens #2254.
    fireEvent.click(within(panel).getByRole("button", { name: "#2254" }));
    panel = slot.getByRole("complementary", { name: "Pull request #2254" });
    await settle();
    expect(within(panel).getByText("W12 reviewing")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("initiatives:prs:p")!)).toMatchObject({ open: url(2254) });
    // Remembered: a remount opens it again.
    slots.splice(0).forEach((s) => s.unmount());
    const again = view().slot;
    expect(again.getByRole("complementary", { name: "Pull request #2254" })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(again.queryByRole("complementary")).toBeNull();
    expect(JSON.parse(localStorage.getItem("initiatives:prs:p")!)).toMatchObject({ open: null });
  });

  it("searches the graph too, and opens a node's detail from its button", async () => {
    const { slot } = view();
    fireEvent.click(slot.getByRole("button", { name: "graph" }));
    fireEvent.change(search(slot), { target: { value: "A41" } });
    expect(Array.from(slot.container.querySelectorAll(".cr-pm-node .cr-pm-num")).map((n) => n.textContent)).toEqual(["#2254"]);
    fireEvent.click(slot.getByRole("button", { name: "Details of #2254" }));
    expect(slot.getByRole("complementary", { name: "Pull request #2254" })).toBeTruthy();
    expect(slot.container.querySelector(".cr-pm-node")!.getAttribute("data-open")).toBe("true");
    await settle();
  });

  it("opens the PR a short repo ref names on Enter (W356 #4)", async () => {
    const { slot } = view();
    fireEvent.change(search(slot), { target: { value: "bb#2254" } });
    expect(rows(slot.container)).toEqual(["bb #2254"]);
    fireEvent.keyDown(search(slot), { key: "Enter" });
    expect(slot.getByRole("complementary", { name: "Pull request #2254" })).toBeTruthy();
    await settle();
  });

  it("finds a W/A ref only whole, so Enter opens nothing for a shorter one (W360 #1)", () => {
    const { slot } = view();
    // #2254 is linked to W12 and A41, and its stage note says "W12 reviewing".
    for (const ref of ["W1", "A4"]) {
      fireEvent.change(search(slot), { target: { value: ref } });
      expect(rows(slot.container)).toEqual([]);
      expect(slot.getByRole("status").textContent).toBe("0 matches");
      fireEvent.keyDown(search(slot), { key: "Enter" });
      expect(slot.queryByRole("complementary")).toBeNull();
    }
  });

  it("opens nothing on Enter for a ref two repositories share, even when a filter shows one (W358 #2)", () => {
    const forks = ["erwinkn/bb", "fork/bb"].map((repo, i): QueuedPullRequest => ({
      ...parsePullRequests(repo, [{ ...gh(2251, repo, "feature", "main"), url: `https://github.com/${repo}/pull/2251` }])[0]!,
      stage: i ? "in-review" : "working",
    }));
    const slot = renderSlot({ component: MergeQueueView }, { queue: { ...queue(), pullRequests: forks }, error: null, refreshing: false, onRefresh: () => {}, loadDetail: vi.fn(async () => detail(2251)) });
    slots.push(slot);
    fireEvent.change(search(slot), { target: { value: "bb#2251" } });
    fireEvent.click(slot.getByRole("button", { name: /^In review/ }));
    expect(rows(slot.container)).toHaveLength(1);
    expect(slot.getByRole("status").textContent).not.toContain("Enter");
    fireEvent.keyDown(search(slot), { key: "Enter" });
    expect(slot.queryByRole("complementary")).toBeNull();
    // A text search showing one PR still opens it.
    fireEvent.change(search(slot), { target: { value: "fork" } });
    expect(slot.getByRole("status").textContent).toContain("Enter opens #2251");
    fireEvent.keyDown(search(slot), { key: "Enter" });
    expect(slot.getByRole("complementary").querySelector(".cr-pd-ref")?.textContent).toBe("fork/bb #2251");
  });

  it("clamps long texts behind disclosure buttons, which the keyboard reaches (W356 #5)", async () => {
    const { slot } = view();
    fireEvent.click(slot.getByRole("button", { name: "Details of #2251" }));
    await settle();
    const work = within(slot.getByRole("complementary", { name: "Pull request #2251" })).getByRole("region", { name: "Work" });
    const progress = within(work).getByRole("button", { name: "PR 1 pushed, waiting on the chain." });
    expect([progress.tagName, progress.tabIndex, progress.getAttribute("aria-expanded")]).toEqual(["BUTTON", 0, "false"]);
    fireEvent.click(progress);
    expect(progress.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(progress);
    expect(progress.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the panel and its Close below the sticky header, its body scrolling inside (W356 #6, W360 #3, W362 #1)", async () => {
    const { slot } = view();
    fireEvent.click(slot.getByRole("button", { name: "Details of #22" }));
    await settle();
    const panel = slot.getByRole("complementary", { name: "Pull request #22" });
    // A panel as tall as its content beside a long list kept its lower sections out of sight
    // until the list's end: it fills what the header leaves, and its body scrolls instead.
    const css = readFileSync("pr-map.css", "utf8");
    const rule = (selector: string) => new RegExp(`\\n${selector.replace(".", "\\.")} \\{([^}]*)\\}`).exec(css)![1]!;
    expect(rule(".cr-pd")).toContain("position: sticky; top: var(--cr-pd-top); scroll-margin-top: var(--cr-pd-top);");
    expect(rule(".cr-pd")).toContain(" height: calc(var(--cr-pd-view, 100dvh) - var(--cr-pd-top) - 8px);");
    expect(rule(".cr-pd-body")).toContain("overflow-y: auto; overscroll-behavior: contain;");
    // Should the panel still be pushed up under the header, its head sticks (T157 keeps it from being pushed).
    expect(rule(".cr-pd-head")).toContain("position: sticky; top: var(--cr-pd-top);");
    expect(within(panel).getByRole("button", { name: "Close details" }).closest(".cr-pd-head")?.parentElement).toBe(panel);
    expect(within(panel).getByRole("heading", { name: "Old docs" }).closest(".cr-pd-body")?.parentElement).toBe(panel);
  });

  it("follows the sticky header's and the page's heights as they change, and opens on the title (W358 #5, W362 #2)", async () => {
    let height = 91;
    let resized = () => {};
    const observed: Element[] = [];
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resized = callback; } observe(element: Element) { observed.push(element); } disconnect() {} });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return { height: this.classList.contains("cr-sticky") ? height : 0 } as DOMRect;
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("project-page") ? 740 : 0;
    });
    // The margin the opening scroll leaves for the header is set by then.
    const scrolled: string[] = [];
    HTMLElement.prototype.scrollIntoView = vi.fn(function (this: HTMLElement) { scrolled.push(this.style.getPropertyValue("--cr-pd-top")); });
    const Dashboard = (props: Parameters<typeof MergeQueueView>[0]) => <div className="project-page"><div className="cr"><div className="cr-sticky" /><MergeQueueView {...props} /></div></div>;
    const slot = renderSlot({ component: Dashboard }, { queue: queue(), error: null, refreshing: false, onRefresh: () => {}, loadDetail: vi.fn(async (u: string) => detail(Number(u.split("/").pop()))) });
    slots.push(slot);
    fireEvent.click(slot.getByRole("button", { name: "Details of #22" }));
    await settle();
    const panel = slot.getByRole("complementary", { name: "Pull request #22" });
    expect([panel.style.getPropertyValue("--cr-pd-top"), panel.style.getPropertyValue("--cr-pd-view")]).toEqual(["91px", "740px"]);
    expect(observed.map((e) => e.className)).toEqual(["cr-sticky", "cr", "project-page"]);
    expect(scrolled).toEqual(["91px"]);
    // The coordinator's details open in the header.
    height = 239.6;
    act(() => resized());
    expect(panel.style.getPropertyValue("--cr-pd-top")).toBe("240px");
    // Another PR opens on its title, with the body back at its top.
    const body = panel.querySelector<HTMLElement>(".cr-pd-body")!;
    body.scrollTop = 500;
    fireEvent.click(slot.getByRole("button", { name: "Details of #2251" }));
    await settle();
    expect(slot.getByRole("complementary", { name: "Pull request #2251" })).toBe(panel);
    expect([body.scrollTop, scrolled]).toEqual([0, ["91px", "240px"]]);
    expect(document.activeElement?.textContent).toBe("SWC prep: circular imports");
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("says when the history can't be read, and keeps GitHub's side", async () => {
    const { slot } = view(vi.fn(async () => { throw new Error("relay down"); }));
    fireEvent.click(slot.getByRole("button", { name: "Details of #22" }));
    await settle();
    const panel = slot.getByRole("complementary", { name: "Pull request #22" });
    expect(within(panel).getByRole("status").textContent).toBe("Couldn't read the PR's history: relay down");
    expect(within(panel).getByRole("region", { name: "GitHub" })).toBeTruthy();
  });
});
