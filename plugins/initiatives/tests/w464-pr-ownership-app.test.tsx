// @vitest-environment jsdom
// W464 (R2): the PRs tab folds the unassigned PRs under Unassigned, and a row's menu moves a PR.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { orderQueue, parsePullRequests, type MergeQueue } from "../lib/merge-queue";
import { PR_STAGES } from "../lib/pr-stages";
import { linkStacks } from "../lib/pr-map";
// jsdom has no PointerEvent; the long press reads its pointerType and isPrimary.
class TestPointerEvent extends MouseEvent {
  pointerType: string;
  isPrimary: boolean;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? "";
    this.isPrimary = init.isPrimary ?? false;
  }
}
(window as unknown as { PointerEvent: unknown }).PointerEvent ??= TestPointerEvent;
await loadPluginApp(() => import("../app"));
const { MergeQueueView } = await import("../merge-queue-view");
const slots: ReturnType<typeof renderSlot>[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.unmount(); cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

const url = (n: number) => `https://github.com/equisafe/infra/pull/${n}`;
const ghPr = (number: number) => ({
  number, title: `PR ${number}`, url: url(number), isDraft: false, reviewDecision: "APPROVED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
  headRefName: `feature-${number}`, baseRefName: "main", createdAt: new Date(Date.now() - number * 60_000).toISOString(), updatedAt: new Date().toISOString(),
  statusCheckRollup: [],
});
/** Equisafe's view: #1 is its own, #2 and #3 are unassigned. */
const queue = (): MergeQueue => ({
  projectId: "eq",
  login: "erwinkn",
  repos: [{ repo: "equisafe/infra", fetchedAt: Date.now(), error: null, fetching: false, detailsFetchedAt: null, detailsError: null }],
  skipped: [],
  stages: PR_STAGES.map((stage) => ({ ...stage })),
  pullRequests: orderQueue(linkStacks(parsePullRequests("equisafe/infra", JSON.stringify([ghPr(1), ghPr(2), ghPr(3)])).map((pr) => ({ ...pr, unassigned: pr.number !== 1 })))),
  initiatives: [
    { id: "eq", name: "Equisafe", repos: ["equisafe/infra"] },
    { id: "ui", name: "Equisafe UI", repos: ["equisafe/infra"] },
    { id: "bb", name: "bb-plugins", repos: ["erwinkn/bb-plugins"] },
  ],
});
const view = (onMove = vi.fn(async () => {}), openUrl = vi.fn(() => true)) => {
  const slot = renderSlot({ component: MergeQueueView }, { queue: queue(), error: null, refreshing: false, onRefresh: () => {}, onMove }, { openUrl });
  slots.push(slot);
  return { slot, onMove, openUrl };
};
/** A list row's link, not Next up's. */
const rowLink = (root: HTMLElement, title: string) =>
  Array.from(root.querySelectorAll<HTMLAnchorElement>(".cr-mq-pr")).find((a) => a.querySelector(".cr-mq-title")!.textContent === title)!;
const shown = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLAnchorElement>(".cr-mq-pr")).map((a) => a.querySelector(".cr-mq-title")!.textContent);

describe("W464 the PRs tab (R2)", () => {
  it("lists the Initiative's own PRs, then the unassigned ones folded at the bottom", () => {
    const { slot } = view();
    expect(shown(slot.container)).toEqual(["PR 1"]);
    const fold = slot.getByRole("button", { name: /Unassigned/ });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(fold.textContent).toBe("Unassigned2");
    // Next up is the Initiative's own: both unassigned PRs are ready too.
    expect(Array.from(slot.container.querySelectorAll(".cr-pm-next-pr .cr-pm-title")).map((a) => a.textContent)).toEqual(["PR 1"]);
    fireEvent.click(fold);
    expect(shown(slot.container)).toEqual(["PR 1", "PR 3", "PR 2"]);
    // A search looks through the fold.
    fireEvent.click(fold);
    fireEvent.change(slot.getByRole("searchbox", { name: "Search pull requests" }), { target: { value: "#3" } });
    expect(shown(slot.container)).toEqual(["PR 3"]);
  });

  it("moves an unassigned PR here or to another Initiative listing its repository", async () => {
    const { slot, onMove } = view();
    fireEvent.click(slot.getByRole("button", { name: /Unassigned/ }));
    const row = rowLink(slot.container, "PR 2");
    fireEvent.contextMenu(row, { clientX: 20, clientY: 10 });
    const menu = slot.getByRole("menu", { name: "Move #2 to an Adventure" });
    // This Initiative first; bb-plugins doesn't list equisafe/infra; no Unassign for an unassigned PR.
    expect(within(menu).getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Equisafe · this one", "Equisafe UI"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Equisafe UI" }));
    await waitFor(() => expect(slot.queryByRole("menu")).toBeNull());
    expect(onMove).toHaveBeenCalledWith(url(2), "ui");
  });

  it("offers Unassign and the other Initiatives for an owned PR, and says when a move fails", async () => {
    const onMove = vi.fn(async () => { throw new Error("No open Adventure is named \"ui\"."); });
    const { slot } = view(onMove);
    fireEvent.keyDown(rowLink(slot.container, "PR 1"), { key: "F10", shiftKey: true });
    const menu = slot.getByRole("menu", { name: "Move #1 to an Adventure" });
    expect(within(menu).getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Equisafe UI", "Unassign"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Unassign" }));
    expect(await within(menu).findByRole("alert")).toHaveProperty("textContent", "No open Adventure is named \"ui\".");
    expect(onMove).toHaveBeenCalledWith(url(1), null);
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(slot.queryByRole("menu")).toBeNull();
  });

  it("keeps the PR's click when no menu opened, and has no menu without a way to move", () => {
    const openUrl = vi.fn(() => true);
    const slot = renderSlot({ component: MergeQueueView }, { queue: queue(), error: null, refreshing: false, onRefresh: () => {} }, { openUrl });
    slots.push(slot);
    const row = rowLink(slot.container, "PR 1");
    expect(row.getAttribute("aria-haspopup")).toBeNull();
    fireEvent.click(row);
    expect(openUrl).toHaveBeenCalledWith(url(1));
  });

  it("opens the menu on a still touch held 450 ms, and its release opens no PR (r1)", () => {
    const { slot, openUrl } = view();
    const row = rowLink(slot.container, "PR 1");
    vi.useFakeTimers();
    const touch = { pointerType: "touch", isPrimary: true, clientX: 30, clientY: 12 };
    fireEvent.pointerDown(row, touch);
    act(() => { vi.advanceTimersByTime(449); });
    expect(slot.queryByRole("menu")).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(slot.getByRole("menu", { name: "Move #1 to an Adventure" })).toBeTruthy();
    fireEvent.pointerUp(row, touch);
    fireEvent.click(row, { detail: 1 });
    expect(openUrl).not.toHaveBeenCalled();
    // A tap opens the PR.
    fireEvent.keyDown(slot.getByRole("menu"), { key: "Escape" });
    fireEvent.pointerDown(row, touch);
    act(() => { vi.advanceTimersByTime(200); });
    fireEvent.pointerUp(row, touch);
    fireEvent.click(row, { detail: 1 });
    expect(openUrl).toHaveBeenCalledWith(url(1));
  });

  it("moves a PR from the graph's nodes too (r1 #6)", async () => {
    const { slot, onMove } = view();
    fireEvent.click(slot.getByRole("button", { name: "graph" }));
    const node = slot.container.querySelector<HTMLAnchorElement>(".cr-pm-node a")!;
    expect(node.getAttribute("aria-label")).toMatch(/^#1 PR 1/);
    expect(node.parentElement!.hasAttribute("data-menu")).toBe(false);
    fireEvent.contextMenu(node, { clientX: 10, clientY: 5 });
    const menu = slot.getByRole("menu", { name: "Move #1 to an Adventure" });
    // r5: the open menu hides the node's hover card (pr-map.css), which would cover its choices.
    expect(node.parentElement!.hasAttribute("data-menu")).toBe(true);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Equisafe UI" }));
    await waitFor(() => expect(slot.queryByRole("menu")).toBeNull());
    expect(onMove).toHaveBeenCalledWith(url(1), "ui");
    expect(node.parentElement!.hasAttribute("data-menu")).toBe(false);
    // The unassigned PRs stay below the graph, folded.
    expect(slot.getByRole("button", { name: /Unassigned/ }).getAttribute("aria-expanded")).toBe("false");
  });

  it("says while other Initiatives' repositories are being looked up, and Escape still closes the menu (r2 #1)", () => {
    const q = queue();
    q.initiatives = [{ id: "eq", name: "Equisafe", repos: ["equisafe/infra"] }, { id: "ui", name: "Equisafe UI", repos: null }];
    const slot = renderSlot({ component: MergeQueueView }, { queue: q, error: null, refreshing: false, onRefresh: () => {}, onMove: vi.fn(async () => {}) }, { openUrl: () => true });
    slots.push(slot);
    fireEvent.click(slot.getByRole("button", { name: /Unassigned/ }));
    fireEvent.contextMenu(rowLink(slot.container, "PR 2"), { clientX: 10, clientY: 5 });
    const menu = slot.getByRole("menu", { name: "Move #2 to an Adventure" });
    expect(within(menu).getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Equisafe · this one"]);
    expect(within(menu).getByRole("status").textContent).toBe("Looking up the other Adventures' repositories…");
    // The owned PR has Unassign only, and the same note.
    fireEvent.keyDown(menu, { key: "Escape" });
    fireEvent.contextMenu(rowLink(slot.container, "PR 1"), { clientX: 10, clientY: 5 });
    expect(within(slot.getByRole("menu")).getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Unassign"]);
  });

  it("says what a PR waits on when another Initiative owns the PR beneath it (r3 #2)", () => {
    const [five, six] = linkStacks(parsePullRequests("equisafe/infra", JSON.stringify([
      { ...ghPr(5), headRefName: "five", isDraft: true },
      { ...ghPr(6), headRefName: "six", baseRefName: "five" },
    ])));
    const q: MergeQueue = { ...queue(), pullRequests: [six!], beneath: [five!] };
    expect([five!.stage, six!.stage, six!.available]).toEqual(["working", "ready-for-erwin", false]);
    const slot = renderSlot({ component: MergeQueueView }, { queue: q, error: null, refreshing: false, onRefresh: () => {}, onMove: vi.fn(async () => {}) }, { openUrl: () => true });
    slots.push(slot);
    expect(slot.container.querySelector(".cr-mq-row .cr-mq-waits")!.textContent).toBe("waits on #5");
    fireEvent.click(slot.getByRole("button", { name: "Details of #6" }));
    const panel = slot.getByRole("complementary", { name: "Pull request #6" });
    expect(panel.querySelector(".cr-pd-stage .cr-mq-waits")!.textContent).toBe("waits on #5");
    // #5 has no panel here: its chip only names it.
    const chip = panel.querySelector(".cr-pd-stack .cr-pd-chip")!;
    expect([chip.tagName, chip.textContent, chip.getAttribute("title")]).toEqual(["SPAN", "#5", "PR 5 (another Adventure's)"]);
    fireEvent.click(slot.getByRole("button", { name: "graph" }));
    expect(slot.container.querySelector(".cr-pm-node .cr-pm-tip")!.textContent).toContain("waits on #5");
  });

  it("opens an unassigned parent from its chip: it is listed here (r4)", () => {
    const [five, six] = linkStacks(parsePullRequests("equisafe/infra", JSON.stringify([
      { ...ghPr(5), headRefName: "five", isDraft: true },
      { ...ghPr(6), headRefName: "six", baseRefName: "five" },
    ])));
    const q: MergeQueue = { ...queue(), pullRequests: [six!, { ...five!, unassigned: true }], beneath: [] };
    const slot = renderSlot({ component: MergeQueueView }, { queue: q, error: null, refreshing: false, onRefresh: () => {}, onMove: vi.fn(async () => {}) }, { openUrl: () => true });
    slots.push(slot);
    fireEvent.click(slot.getByRole("button", { name: "Details of #6" }));
    const chip = slot.getByRole("complementary", { name: "Pull request #6" }).querySelector(".cr-pd-stack .cr-pd-chip")!;
    expect(chip.tagName).toBe("BUTTON");
    fireEvent.click(chip);
    expect(slot.getByRole("complementary", { name: "Pull request #5" })).toBeTruthy();
  });
});
