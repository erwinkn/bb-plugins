// @vitest-environment jsdom
// W527 (R2): a filter's chip counts include the unassigned PRs, so the filtered list must show them (it said
// "None of this Adventure's pull requests match" over a collapsed Unassigned 6 in a new Adventure).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { orderQueue, parsePullRequests, type MergeQueue } from "../lib/merge-queue";
import { PR_STAGES } from "../lib/pr-stages";
import { linkStacks } from "../lib/pr-map";
await loadPluginApp(() => import("../app"));
const { MergeQueueView } = await import("../merge-queue-view");
const slots: ReturnType<typeof renderSlot>[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.unmount(); cleanup(); vi.restoreAllMocks(); });

const url = (n: number) => `https://github.com/equisafe/equisafe-market/pull/${n}`;
const ghPr = (number: number, draft = false) => ({
  number, title: `PR ${number}`, url: url(number), isDraft: draft, reviewDecision: "APPROVED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
  headRefName: `feature-${number}`, baseRefName: "main", createdAt: new Date(Date.now() - number * 60_000).toISOString(), updatedAt: new Date().toISOString(),
});
/** A new Adventure: nothing is assigned to it yet, so every PR is unassigned (#1-#3 ready, #4-#5 drafts), plus one of its own when `own`. */
const queue = (own: boolean): MergeQueue => ({
  projectId: "rework",
  login: "erwinkn",
  repos: [{ repo: "equisafe/equisafe-market", fetchedAt: Date.now(), error: null, fetching: false, detailsFetchedAt: null, detailsError: null }],
  skipped: [],
  stages: PR_STAGES.map((stage) => ({ ...stage })),
  pullRequests: orderQueue(linkStacks(parsePullRequests("equisafe/equisafe-market", [ghPr(1), ghPr(2), ghPr(3), ghPr(4, true), ghPr(5, true), ghPr(6)])
    .map((pr) => ({ ...pr, unassigned: !(own && pr.number === 6) })))),
  initiatives: [{ id: "rework", name: "Backend Rework", repos: ["equisafe/equisafe-market"] }],
});
const view = (own: boolean) => {
  const slot = renderSlot({ component: MergeQueueView }, { queue: queue(own), error: null, refreshing: false, onRefresh: () => {} }, { openUrl: () => true });
  slots.push(slot);
  return slot;
};
/** The titles of the list rows (not Next up's). */
const rows = (root: HTMLElement) => Array.from(root.querySelectorAll(".cr-mq-row .cr-mq-title")).map((a) => a.textContent);
const chips = (root: HTMLElement) =>
  Array.from(root.querySelectorAll<HTMLButtonElement>(".cr-pm-chip")).map((b) => ({ button: b, label: b.textContent!.replace(/\d+$/, ""), count: Number(b.querySelector(".cr-pm-chip-count")!.textContent) }));
const empty = (root: HTMLElement) => root.querySelector(".cr-empty")?.textContent ?? null;

describe.each([["nothing assigned yet", false], ["one PR assigned", true]] as const)("W527 counts and rows agree (%s)", (_name, own) => {
  it("shows as many rows as a chip counts, for every chip", () => {
    const slot = view(own);
    const all = chips(slot.container);
    expect(all.length).toBeGreaterThan(2);
    for (const { button, label, count } of all) {
      fireEvent.click(button);
      expect(rows(slot.container), label).toHaveLength(count);
      expect(slot.getByRole("button", { name: /Unassigned/ }).getAttribute("aria-expanded"), label).toBe("true");
      expect(empty(slot.container) ?? "", label).not.toMatch(/^None of|^No pull requests? match/);
      fireEvent.click(button);
    }
  });

  it("keeps Unassigned folded without a filter or a search, and a click folds it under a filter", () => {
    const slot = view(own);
    const fold = () => slot.getByRole("button", { name: /Unassigned/ });
    expect(fold().getAttribute("aria-expanded")).toBe("false");
    expect(rows(slot.container)).toHaveLength(own ? 1 : 0);
    fireEvent.click(chips(slot.container)[0]!.button);
    expect(fold().getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(fold());
    expect(fold().getAttribute("aria-expanded")).toBe("false");
    // Clearing the filter returns to the folded default, whatever the click did.
    fireEvent.click(slot.getByRole("button", { name: "Clear" }));
    expect(fold().getAttribute("aria-expanded")).toBe("false");
    expect(rows(slot.container)).toHaveLength(own ? 1 : 0);
    // The override doesn't come back with the next filter or search.
    fireEvent.click(chips(slot.container)[0]!.button);
    expect(fold().getAttribute("aria-expanded")).toBe("true");
    expect(rows(slot.container)).toHaveLength(chips(slot.container)[0]!.count);
    // Same for a search: fold under it, clear it, search again.
    fireEvent.click(slot.getByRole("button", { name: "Clear" }));
    const search = slot.getByRole("searchbox", { name: "Search pull requests" });
    fireEvent.change(search, { target: { value: "PR" } });
    fireEvent.click(fold());
    expect(fold().getAttribute("aria-expanded")).toBe("false");
    fireEvent.change(search, { target: { value: "" } });
    fireEvent.change(search, { target: { value: "PR" } });
    expect(fold().getAttribute("aria-expanded")).toBe("true");
  });
});

describe("W527 the empty message", () => {
  it("doesn't say nothing matches while unassigned PRs do (the screenshot: Ready for you 6 over an empty list)", () => {
    const slot = view(false);
    fireEvent.click(slot.getByRole("button", { name: /Ready for you/ }));
    expect(rows(slot.container)).toHaveLength(4);
    expect(empty(slot.container)).toBe("No pull request assigned to this Adventure matches; the unassigned ones below do.");
    expect(slot.container.textContent).not.toContain("None of this Adventure's");
  });

  it("names the unassigned PRs when this Adventure's own PRs don't match", () => {
    const slot = view(true);
    fireEvent.click(slot.getByRole("button", { name: /Being worked on/ }));
    expect(rows(slot.container)).toHaveLength(2);
    expect(empty(slot.container)).toBe("No pull request assigned to this Adventure matches; the unassigned ones below do.");
  });

  it("keeps the plain empty states when nothing matches", () => {
    const slot = view(false);
    expect(empty(slot.container)).toBe("No pull request is this Adventure's yet.");
    fireEvent.change(slot.getByRole("searchbox", { name: "Search pull requests" }), { target: { value: "no such pr" } });
    expect(empty(slot.container)).toBe("No pull requests match this search.");
  });
});
