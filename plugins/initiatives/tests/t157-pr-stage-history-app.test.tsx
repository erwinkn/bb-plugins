// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { parsePullRequests, type MergeQueue } from "../lib/merge-queue";
import { PR_STAGES, blankPrRecord, type PrStageChange } from "../lib/pr-stages";
import type { PrDetail } from "../lib/pr-detail";
await loadPluginApp(() => import("../app"));
const { MergeQueueView } = await import("../merge-queue-view");
const slots: ReturnType<typeof renderSlot>[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.unmount(); cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const NOW = Date.now();
const H = 3_600_000;
const url = (n: number) => `https://github.com/erwinkn/bb/pull/${n}`;
const queue = (): MergeQueue => ({
  projectId: "p", login: "erwinkn", repos: [{ repo: "erwinkn/bb", fetchedAt: NOW, error: null, fetching: false, detailsFetchedAt: null, detailsError: null }], skipped: [],
  stages: PR_STAGES.map((s) => ({ ...s })),
  pullRequests: parsePullRequests("erwinkn/bb", JSON.stringify([7, 8, 9].map((number) => ({
    number, title: `PR ${number}`, url: url(number), isDraft: false, reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED",
    headRefName: `feat/${number}`, baseRefName: "main", createdAt: new Date(NOW - 9 * H).toISOString(), updatedAt: new Date(NOW).toISOString(), statusCheckRollup: [],
  })))),
});
const change = (n: number, from: string | null, to: string | null, author = "coordinator", note: string | null = null): PrStageChange => ({ n, at: NOW - (10 - n) * H, author, from, to, note });
const changes = [
  change(1, null, "working"),
  change(2, "working", "ready-for-review", "coordinator", "Pushed at abc123"),
  change(3, "ready-for-review", "in-review"),
  change(4, "in-review", "in-review", "coordinator", "W364 reviewing v5"),
  change(5, "in-review", null, "user"),
  change(6, null, "ready-for-erwin", "coordinator", "Approved"),
];
const detail = (u: string): PrDetail => {
  const n = Number(u.split("/").pop());
  return {
    url: u,
    // #7 has a history; #8 a stage set before it was kept; #9 neither.
    record: n === 9 ? null : { ...blankPrRecord(u, NOW), stage: n === 7 ? "ready-for-erwin" : "in-review", setAt: NOW - 50 * H },
    stages: n === 7 ? { items: changes, total: 60 } : { items: [], total: 0 },
    notes: { items: [], total: 0 }, assignments: { items: [], total: 0 }, workers: [], decisions: { items: [], total: 0 }, updates: { items: [], total: 0 },
  };
};
const settle = () => act(async () => { await Promise.resolve(); });
const open = async (n: number, component: typeof MergeQueueView = MergeQueueView) => {
  const slot = renderSlot({ component }, { queue: queue(), error: null, refreshing: false, onRefresh: () => {}, loadDetail: vi.fn(async (u: string) => detail(u)) });
  slots.push(slot);
  fireEvent.click(slot.getByRole("button", { name: `Details of #${n}` }));
  await settle();
  return { slot, panel: slot.getByRole("complementary", { name: `Pull request #${n}` }) };
};
const lines = (section: HTMLElement) => Array.from(section.querySelectorAll("li")).map((li) => li.textContent);

describe("T157 stage history in the PR panel", () => {
  it("lists who moved the PR between stages, the latest first shown, all on demand", async () => {
    const { panel } = await open(7);
    const history = within(panel).getByRole("region", { name: "Stage history" });
    expect(history.querySelector("h4")!.textContent).toBe("Stage history60");
    expect(lines(history)).toEqual([
      "Being worked on→Ready for reviewcoordinator8hPushed at abc123",
      "Ready for review→In reviewcoordinator7h",
      "In reviewnew notecoordinator6hW364 reviewing v5",
      "In review→no stageyou5h",
      "→Ready for youcoordinator4hApproved",
    ]);
    expect(Array.from(history.querySelectorAll(".cr-pd-arrow")).map((a) => a.getAttribute("aria-label"))).toEqual(["to", "to", "to", "set to"]);
    fireEvent.click(within(history).getByRole("button", { name: "Show all 6" }));
    expect(lines(history)[0]).toBe("→Being worked oncoordinator9h");
    expect(history.textContent).toContain("The newest 6 of 60.");
    expect(Array.from(panel.querySelectorAll(".cr-pd-section h4")).map((h) => h.firstChild!.textContent)).toEqual(["GitHub", "Stage history", "Work"]);
  });

  it("shows a stage set before the history was kept as it stands, and nothing without a stage", async () => {
    const { panel } = await open(8);
    expect(lines(within(panel).getByRole("region", { name: "Stage history" }))).toEqual(["In reviewcurrent, set before stage history was kept2d"]);
    slots.splice(0).forEach((slot) => slot.unmount());
    const none = await open(9);
    expect(within(none.panel).queryByRole("region", { name: "Stage history" })).toBeNull();
  });
});

describe("T157 Close at the page's end (W364 P3)", () => {
  it("lets the panel's containing block reach over what lies below the list", () => {
    const css = readFileSync("pr-map.css", "utf8");
    expect(css).toContain(".cr-pm-body[data-open] { display: grid; grid-template-columns: minmax(0, 1fr) minmax(330px, 44%); column-gap: 16px; align-items: start; }");
    expect(css).toContain(".cr-pm-body[data-open] { margin-bottom: calc(-1 * var(--cr-pd-below, 0px)); }");
    expect(css).toContain(".cr-pm-body[data-open]::after { content: \"\"; display: block; grid-column: 1 / -1; height: var(--cr-pd-below, 0px); }");
  });

  it("measures how far the page goes on below the list, as the dashboard resizes", async () => {
    // The page scrolls 300 of its 1000 px from y44; the list ends at y652: 92 px of footer and padding below it.
    const page = { scrollHeight: 1000, gridBottom: 652 };
    let resized = () => {};
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resized = callback; } observe() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("project-page")) return { top: 44, height: 400 } as DOMRect;
      if (this.classList.contains("cr-pm-body")) return { bottom: page.gridBottom } as DOMRect;
      return { height: this.classList.contains("cr-sticky") ? 134 : 0 } as DOMRect;
    });
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("project-page") ? page.scrollHeight : 0;
    });
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const Dashboard = (props: Parameters<typeof MergeQueueView>[0]) =>
      <div className="project-page" ref={(el) => { if (el) el.scrollTop = 300; }}><div className="cr"><div className="cr-sticky" /><MergeQueueView {...props} /></div></div>;
    const { panel } = await open(7, Dashboard);
    const grid = panel.parentElement!;
    expect(grid.style.getPropertyValue("--cr-pd-below")).toBe("92px");
    // Measured again with the reach in place, it holds; a footer that wraps reaches further.
    page.gridBottom = 744;
    act(() => resized());
    expect(grid.style.getPropertyValue("--cr-pd-below")).toBe("92px");
    page.scrollHeight = 1020;
    act(() => resized());
    expect(grid.style.getPropertyValue("--cr-pd-below")).toBe("112px");
    // Closed, the list keeps no reach.
    fireEvent.click(within(panel).getByRole("button", { name: "Close details" }));
    expect(grid.style.getPropertyValue("--cr-pd-below")).toBe("");
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  });
});
