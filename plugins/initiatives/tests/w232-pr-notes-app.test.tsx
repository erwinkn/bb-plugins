// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { orderQueue, parsePullRequests, type MergeQueue, type MergeQueueRepo, type QueuedPullRequest } from "../lib/merge-queue";
import { PR_STAGES } from "../lib/pr-stages";
import type { PrNote } from "../lib/pr-notes";
import { linkStacks } from "../lib/pr-map";
import { projectFixture } from "./fake-native";
await loadPluginApp(() => import("../app"));
const { MergeQueueView } = await import("../merge-queue-view");
const { ProjectsPage } = await import("../app");
const slots: ReturnType<typeof renderSlot>[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.unmount(); cleanup(); });

const NOW = Date.now();
const url = (n: number) => `https://github.com/erwinkn/bb/pull/${n}`;
const note = (n: number, extra: Partial<PrNote> = {}): PrNote => ({ n, at: NOW - (10 - n) * 60_000, author: "W4", kind: "note", text: `Note ${n}`, link: "A12", answered: null, ...extra });
const repo = (extra: Partial<MergeQueueRepo> = {}): MergeQueueRepo => ({
  repo: "erwinkn/bb", fetchedAt: NOW - 60_000, error: null, fetching: false, detailsFetchedAt: NOW - 60_000, detailsError: null, ...extra,
});
const queue = (patch: (pr: QueuedPullRequest) => QueuedPullRequest = (pr) => pr, repos = [repo()]): MergeQueue => ({
  projectId: "p", login: "erwinkn", repos, skipped: [], stages: PR_STAGES.map((s) => ({ ...s })),
  pullRequests: orderQueue(linkStacks(parsePullRequests("erwinkn/bb", JSON.stringify([1, 2].map((number) => ({
    number, title: `PR ${number}`, url: url(number), headRefName: `h${number}`, baseRefName: "main", createdAt: new Date(NOW - number * 3_600_000).toISOString(),
  })))).map((pr) => patch({ ...pr, stage: "ready-for-erwin", stageSource: "coordinator" })))),
});
const view = (props: Partial<Parameters<typeof MergeQueueView>[0]> = {}) => {
  const slot = renderSlot({ component: MergeQueueView }, { queue: queue(), error: null, refreshing: false, onRefresh: () => {}, ...props });
  slots.push(slot);
  return slot;
};
const question = note(5, { author: "coordinator", kind: "question", text: "Keep the 5m TTL?", link: null });

describe("W232 PR notes (D442)", () => {
  it("shows the latest note under its row, and every note in a panel that reads the whole log", async () => {
    let answer!: (notes: PrNote[]) => void;
    const loadNotes = vi.fn(() => new Promise<PrNote[]>((resolve) => { answer = resolve; }));
    const recent = [note(3), note(4), note(5, { text: "Rebased on main; checks green" })];
    const slot = view({ loadNotes, queue: queue((pr) => pr.number === 1 ? { ...pr, notes: { count: 5, recent, open: [] } } : pr) });
    const line = slot.container.querySelector<HTMLElement>(".cr-pr-notes-line")!;
    expect(line.closest("a")).toBeNull();
    expect(line.querySelector(".cr-pr-note-latest")!.textContent).toMatch(/^W4A12.*Rebased on main; checks green$/);
    fireEvent.click(within(line).getByRole("button", { name: "5 notes" }));
    // The last three show at once; the earlier two load.
    const panel = slot.getByRole("region", { name: "Notes on #1" });
    expect(within(panel).getAllByRole("listitem")).toHaveLength(3);
    expect(within(panel).getByRole("status").textContent).toBe("Loading 2 earlier notes…");
    expect(loadNotes).toHaveBeenCalledWith(url(1));
    answer([note(1), note(2, { kind: "question", text: "Squash?", answered: { at: NOW, by: "coordinator", text: "Yes" } }), ...recent]);
    await waitFor(() => expect(within(panel).getAllByRole("listitem")).toHaveLength(5));
    expect(within(panel).queryByRole("status")).toBeNull();
    expect(within(panel).getAllByRole("listitem")[1]!.textContent).toContain("answered by coordinator: Yes");
    fireEvent.click(within(line).getByRole("button", { name: "hide" }));
    expect(slot.queryByRole("region", { name: "Notes on #1" })).toBeNull();
  });

  it("reads an open log again when a question is answered, though no note was added (W229)", async () => {
    let log = [note(1), note(2), question];
    const loadNotes = vi.fn(async () => log);
    const withNotes = (q: PrNote) => queue((pr) => pr.number === 1 ? { ...pr, notes: { count: 3, recent: [note(1), note(2), q], open: q.answered ? [] : [q] } } : pr);
    const slot = view({ loadNotes, queue: withNotes(question) });
    fireEvent.click(slot.getByRole("button", { name: "3 notes" }));
    await waitFor(() => expect(loadNotes).toHaveBeenCalledTimes(1));
    const answered = { ...question, answered: { at: NOW, by: "coordinator", text: "Yes" } };
    log = [note(1), note(2), answered];
    slot.rerender(createElement(MergeQueueView, { queue: withNotes(answered), error: null, refreshing: false, onRefresh: () => {}, loadNotes }));
    await waitFor(() => expect(slot.getByRole("region", { name: "Notes on #1" }).textContent).toContain("answered by coordinator: Yes"));
    expect(loadNotes).toHaveBeenCalledTimes(2);
  });

  it("puts open questions in the state line, Next up and the graph's \"?\", and the last notes in the hover card", () => {
    const slot = view({ queue: queue((pr) => pr.number === 2 ? { ...pr, notes: { count: 2, recent: [note(4), question], open: [question] } } : pr) });
    const row = slot.container.querySelector<HTMLElement>(`.cr-mq-pr[href="${url(2)}"]`)!.closest("li")!;
    expect(row.querySelector(".cr-mq-state")!.textContent).toBe("coordinator asks: Keep the 5m TTL?");
    // The open question is already on the state line; the notes line keeps only its toggle.
    expect(row.querySelector(".cr-pr-note-latest")).toBeNull();
    const next = slot.getByRole("region", { name: "Next up" });
    expect(within(next).getAllByTitle("1 open question")).toHaveLength(1);
    fireEvent.click(slot.getByRole("button", { name: "graph" }));
    const node = slot.getByRole("link", { name: /^#2 PR 2, Ready for you, review now, open questions$/ }).closest("li")!;
    expect(node.querySelector(".cr-pm-ask")).toBeTruthy();
    const tip = within(node).getByRole("tooltip").textContent!;
    expect(tip).toContain("coordinator asks: Keep the 5m TTL?");
    expect(tip).toContain("Note 4");
  });

  it("shows a skeleton while the first read from GitHub runs, and why reviewers are hidden after a failed details read (D441)", () => {
    const first = view({ queue: { ...queue(), pullRequests: [], repos: [repo({ fetchedAt: null, fetching: true, detailsFetchedAt: null })] } });
    expect(first.getByRole("status").textContent).toBe("Loading pull requests from GitHub…");
    expect(first.container.querySelector(".cr-mq-skeleton li")).toBeTruthy();
    expect(first.getByText("Refreshing…")).toBeTruthy();
    expect(first.getByRole("button", { name: "Refresh merge queue" }).hasAttribute("disabled")).toBe(true);
    cleanup();
    const stale = view({ queue: queue(undefined, [repo({ detailsError: "HTTP 502" })]) });
    expect(stale.getByRole("status").textContent).toBe("erwinkn/bb: sizes and reviewers didn't refresh (HTTP 502). Sizes are from an earlier read; reviewers are hidden until they load.");
  });
});

describe("W229 P2: the page route selects the tab", () => {
  it("follows a same-initiative route change, loading that tab's data", async () => {
    const { f, project } = await projectFixture();
    const summary = await f.harness.callRpc("overview", { projectId: project.id, detail: "summary" });
    const overview = vi.fn(async (input: unknown) => ((input as { detail: string }).detail === "summary" ? summary : f.harness.callRpc("overview", { projectId: project.id, detail: (input as { detail: string }).detail })));
    const slot = renderSlot({ component: ProjectsPage }, { subPath: `${project.id}/tasks` }, { rpc: { overview, mergeQueue: async () => queue() } });
    slots.push(slot);
    const selected = () => Array.from(slot.container.querySelectorAll("[role=tab]")).find((t) => t.getAttribute("aria-selected") === "true")!.textContent;
    await waitFor(() => expect(selected()).toMatch(/^Tasks/));
    slot.rerender(createElement(ProjectsPage, { subPath: `${project.id}/prs` }));
    await waitFor(() => expect(selected()).toMatch(/^PRs/));
    expect(overview).not.toHaveBeenCalledWith(expect.objectContaining({ detail: "history" }));
    slot.rerender(createElement(ProjectsPage, { subPath: `${project.id}/decisions` }));
    await waitFor(() => expect(selected()).toMatch(/^Decisions/));
    await waitFor(() => expect(overview).toHaveBeenCalledWith(expect.objectContaining({ detail: "history" })));
  });
});
