import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { projectFixture } from "./fake-native";
import { MIGRATIONS, Store } from "../lib/store";
import { assignStages, attachWorkers, parsePullRequests, type MergeQueue, type QueuedPullRequest } from "../lib/merge-queue";
import { PR_STAGES, blankPrRecord, type PrStage } from "../lib/pr-stages";
import { AssignedPrs } from "../lib/pr-records";
import { categoriesOf, filterPrs, groupPrs, laneLayout, linkStacks, nextUp, prSummary, stackLabel, stateItems } from "../lib/pr-map";

const call = async (f: Awaited<ReturnType<typeof projectFixture>>["f"], tool: string, input: unknown, threadId = "coordinator") =>
  JSON.parse(await f.harness.callAgentTool(tool, input, { threadId }) as string);
const url = (n: number, repo = "erwinkn/bb") => `https://github.com/${repo}/pull/${n}`;

describe("W224 PR categories", () => {
  it("sets categories with or without a stage, reusing an existing one's spelling", async () => {
    const { f, project } = await projectFixture();
    const first = await call(f, "initiative_pr", { prs: [
      { url: url(1), stage: "in-review", note: "W3 reviewing", category: "Security" },
      { url: url(2), category: "  CI  " },
    ] });
    expect(first).toEqual({
      prs: [{ url: url(1), stage: "in-review", category: "Security" }, { url: url(2), category: "CI" }],
      categories: { CI: 1, Security: 1 },
    });
    // "security" joins "Security"; a category-only entry leaves the stage and its note alone.
    const second = await call(f, "initiative_pr", { prs: [{ url: url(1), category: "ci" }, { url: url(3), stage: "working", category: "security" }] });
    expect(second.prs).toEqual([{ url: url(1), category: "CI" }, { url: url(3), stage: "working", category: "Security" }]);
    expect(second.categories).toEqual({ CI: 2, Security: 1 });
    expect(f.store.prRecords(project.id).get(url(1))).toMatchObject({ stage: "in-review", note: "W3 reviewing" });
    // Clearing the stage keeps the category; null removes the category.
    await call(f, "initiative_pr", { prs: [{ url: url(1), stage: "clear" }, { url: url(2), category: null }] });
    const records = f.store.prRecords(project.id);
    expect(records.get(url(1))).toMatchObject({ stage: null, note: null, category: "CI" });
    expect([...records].map(([key, r]) => [key, r.category])).toEqual([[url(1), "CI"], [url(3), "Security"]]);
  });

  it("renames and merges categories in one call", async () => {
    const { f, project } = await projectFixture();
    await call(f, "initiative_pr", { prs: [
      { url: url(1), category: "Sec" }, { url: url(2), category: "Security fixes" }, { url: url(3), category: "Security" },
    ] });
    const result = await call(f, "initiative_pr", { rename: [{ from: "sec", to: "security" }, { from: "Security fixes", to: "Security" }] });
    expect(result).toEqual({
      prs: [],
      renamed: [{ from: "Sec", to: "Security", prs: 1 }, { from: "Security fixes", to: "Security", prs: 1 }],
      categories: { Security: 3 },
    });
    expect(new Set([...f.store.prRecords(project.id).values()].map((r) => r.category))).toEqual(new Set(["Security"]));
    // A case-only rename respells the category.
    expect((await call(f, "initiative_pr", { rename: [{ from: "security", to: "SECURITY" }] })).categories).toEqual({ SECURITY: 3 });
    // An unknown category fails the whole call and says what exists.
    await expect(call(f, "initiative_pr", { rename: [{ from: "SECURITY", to: "Auth" }, { from: "Tooling", to: "Dev" }] })).rejects.toThrow(/No PR has the category "Tooling"\. Categories: SECURITY\./);
    expect(new Set([...f.store.prRecords(project.id).values()].map((r) => r.category))).toEqual(new Set(["SECURITY"]));
  });

  it("validates entries: a stage or a category, a note only with a stage", async () => {
    const { f } = await projectFixture();
    await expect(call(f, "initiative_pr", { prs: [{ url: url(1) }] })).rejects.toThrow(/Give a stage or one of category, waitingOn/);
    await expect(call(f, "initiative_pr", { prs: [{ url: url(1), category: "CI", note: "x" }] })).rejects.toThrow(/note goes with a stage/);
    await expect(call(f, "initiative_pr", { prs: [{ url: url(1), category: "" }] })).rejects.toThrow(/category/);
    await expect(call(f, "initiative_pr", {})).rejects.toThrow(/prs, rename or both/);
    // The batch path takes categories too.
    const batch = await call(f, "initiative_batch", { actions: [{ tool: "pr", prs: [{ url: url(4), category: "Docs" }] }] });
    expect(batch.results[0]).toEqual({ tool: "pr", ok: true, prs: [{ url: url(4), category: "Docs" }], categories: { Docs: 1 } });
  });

  it("is stored by additive migrations, appended after the deployed memory ones (72–76)", () => {
    const index = MIGRATIONS.findIndex(migration => /^CREATE TABLE pr_records/.test(migration));
    expect(index).toBe(77);
    expect(MIGRATIONS[76]).toMatch(/^CREATE TABLE memory_trees/);
    expect(MIGRATIONS[index + 1]).toMatch(/^INSERT INTO pr_records .* FROM pr_stages$/s);
    const store = new Store((() => { const db = new Database(":memory:"); for (const m of MIGRATIONS) db.exec(m); return db; })());
    const record = { ...blankPrRecord(url(1), 3), stage: "working" as const, note: "kept", setAt: 3, category: "CI",
      changes: ["drop the retry"], decision: { text: "Keep 5m", link: "D437", at: 3 } };
    store.savePrRecord("p1", record);
    expect(store.prRecords("p1").get(url(1))).toEqual(record);
    // Nothing left in it: the record goes.
    store.savePrRecord("p1", blankPrRecord(url(1), 4));
    expect(store.prRecords("p1").size).toBe(0);
  });

  it("initiative_read {view:prs} answers from the merge queue", async () => {
    const { f } = await projectFixture();
    expect(await call(f, "initiative_read", { view: "prs" })).toEqual({ repos: [], open: 0, next: [], byCategory: {}, stacks: [], state: {} });
  });
});

/** A parsed PR with the given branches, stage and category. */
function pr(number: number, head: string, base: string, stage: PrStage = "ready-for-review", extra: Partial<QueuedPullRequest> = {}): QueuedPullRequest {
  const [parsed] = parsePullRequests("erwinkn/bb", JSON.stringify([{ number, url: url(number), title: `PR ${number}`, headRefName: head, baseRefName: base, createdAt: new Date(Date.UTC(2026, 9, 1) + number * 60_000).toISOString() }]));
  return { ...parsed!, stage, stageSource: "coordinator", ...extra };
}

describe("W224 where each PR stands (D438)", () => {
  it("patches only the fields given, clears with null, and names the worker of an assignment", async () => {
    const { f, project } = await projectFixture();
    await call(f, "initiative_spawn", { label: "Lock", purpose: "lock", text: "Do it." });
    const assignment = f.store.assignments(project.id).at(-1)!;
    const w = { ref: `W${assignment.workerNum}` };
    const result = await call(f, "initiative_pr", { prs: [{
      url: url(1), stage: "working", note: "W1 on it", waitingOn: "W1: move the lock to resume",
      changes: ["drop the retry"], decision: { text: "Keep 5m TTL", link: "D437" },
      assignment: assignment.ref,
    }] });
    expect(result.prs).toEqual([{ url: url(1), stage: "working", worker: w.ref, assignment: assignment.ref, updated: ["waitingOn", "changes", "decision"] }]);
    expect(f.store.prRecords(project.id).get(url(1))).toMatchObject({
      stage: "working", note: "W1 on it", waitingOn: "W1: move the lock to resume",
      changes: ["drop the retry"], decision: { text: "Keep 5m TTL", link: "D437" }, worker: w.ref, assignment: assignment.ref,
    });
    // A later patch touches only its fields.
    await call(f, "initiative_pr", { prs: [{ url: url(1), decision: null, waitingOn: "Erwin's review" }] });
    expect(f.store.prRecords(project.id).get(url(1))).toMatchObject({ stage: "working", note: "W1 on it", waitingOn: "Erwin's review", decision: null, changes: ["drop the retry"], worker: w.ref });
    await expect(call(f, "initiative_pr", { prs: [{ url: url(1), worker: "W99" }] })).rejects.toThrow(/Unknown worker W99/);
    await expect(call(f, "initiative_pr", { prs: [{ url: url(1), assignment: "A999" }] })).rejects.toThrow(/Unknown assignment A999/);
    await expect(call(f, "initiative_pr", { prs: [{ url: url(1), worker: "12" }] })).rejects.toThrow(/worker ref like W12/);
    // Everything cleared: the record goes.
    await call(f, "initiative_pr", { prs: [{ url: url(1), stage: "clear", waitingOn: null, changes: null, decision: null, worker: null, assignment: null }] });
    expect(f.store.prRecords(project.id).has(url(1))).toBe(false);
  });

  it("finds each PR's latest assignment from its brief and its report", () => {
    const rows = [
      { num: 3, workerNum: 2, role: "work", brief: "Fix https://github.com/ErwinKN/bb/pull/7 and erwinkn/bb#8", report: JSON.stringify({ summary: "Opened https://github.com/erwinkn/bb/pull/9" }) },
      { num: 4, workerNum: 5, role: "review", brief: "Review https://github.com/erwinkn/bb/pull/9/files", report: null },
    ];
    let stamp = "1";
    const store = { assignmentsStamp: () => stamp, prMentions: vi.fn(() => rows) };
    const assigned = new AssignedPrs(store);
    // A3's brief keeps #7 after its report; A4's brief gives it #9, which A3's report opened.
    expect([...assigned.read("p")]).toEqual([
      [url(7), { worker: "W2", assignment: "A3", role: "work" }],
      [url(9), { worker: "W5", assignment: "A4", role: "review" }],
    ]);
    // Unchanged assignments: no rescan.
    assigned.read("p");
    expect(store.prMentions).toHaveBeenCalledTimes(1);
    rows[0]!.brief = "Nothing named";
    stamp = "2";
    expect(assigned.read("p").has(url(7))).toBe(false);
  });

  it("picks the coordinator's worker, else the latest assignment, else the branch", () => {
    const prs = [pr(1, "bb/w1-x-thr_aaa", "main"), pr(2, "bb/w1-y-thr_aaa", "main"), pr(3, "bb/w1-z-thr_aaa", "main")];
    const records = new Map([[url(1), { ...blankPrRecord(url(1), 1), worker: "W2", assignment: "A9" }]]);
    const workers = new Map([["thr_aaa", "W1"], ["thr_bbb", "W2"]]);
    const out = attachWorkers(assignStages(prs, records), workers, new Map([[url(1), { worker: "W1", assignment: "A1", role: "work" }], [url(2), { worker: "W2", assignment: "A5", role: "review" }]]));
    expect(out.map((p) => p.worker)).toEqual([
      { ref: "W2", threadId: "thr_bbb", assignment: "A9", role: null, source: "coordinator" },
      { ref: "W2", threadId: "thr_bbb", assignment: "A5", role: "review", source: "assignment" },
      { ref: "W1", threadId: "thr_aaa", assignment: null, role: null, source: "branch" },
    ]);
  });

  it("reads as one line of parts, and the coordinator's summary carries them", () => {
    const [one] = linkStacks([pr(1, "a", "main", "working", {
      waitingOn: "W188: move the lock to resume", changes: ["a", "b"],
      notes: { count: 2, recent: [
        { n: 1, at: 1, author: "W188", kind: "note", text: "Rebased on main", link: "A382", answered: null },
        { n: 2, at: 2, author: "coordinator", kind: "question", text: "Redis TTL?", link: null, answered: null },
      ], open: [{ n: 2, at: 2, author: "coordinator", kind: "question", text: "Redis TTL?", link: null, answered: null }] },
      decision: { text: "Keep 5m", link: "https://github.com/erwinkn/bb/pull/1#issuecomment-1", at: 1 },
      worker: { ref: "W188", threadId: null, assignment: "A382", role: "work", source: "coordinator" },
    })]);
    expect(stateItems(one!).map((item) => item.text)).toEqual([
      "waiting on W188: move the lock to resume", "coordinator asks: Redis TTL?", "2 changes requested: a; b", "decided: Keep 5m",
    ]);
    const queue: MergeQueue = { projectId: "p", login: null, repos: [], skipped: [], stages: PR_STAGES.map((s) => ({ ...s })), pullRequests: [one!] };
    expect(prSummary(queue).state).toEqual({ "#1": {
      worker: "W188 · A382", waitingOn: "W188: move the lock to resume", questions: ["n2 coordinator: Redis TTL?"], notes: 2, latestNote: "coordinator question: Redis TTL?", changes: ["a", "b"],
      decision: "Keep 5m (https://github.com/erwinkn/bb/pull/1#issuecomment-1)",
    } });
  });
});

describe("W224 stacks", () => {
  it("links PRs whose base is another open PR's head, as trees, per repository", () => {
    const prs = linkStacks([
      pr(10, "a", "main"),
      pr(11, "b", "a"),
      pr(12, "c", "b"),
      pr(13, "d", "a"),
      pr(20, "solo", "main"),
      pr(30, "x", "gone-branch"),
      // Same branch names in another repository never link across.
      { ...pr(40, "b2", "a"), repo: "erwinkn/other", url: url(40, "erwinkn/other") },
    ]);
    const stack = (n: number) => prs.find((p) => p.number === n)!.stack;
    expect(stack(10)).toEqual({ root: 10, on: null, level: 1, levels: 3, size: 4 });
    expect(stack(11)).toEqual({ root: 10, on: 10, level: 2, levels: 3, size: 4 });
    expect(stack(12)).toEqual({ root: 10, on: 11, level: 3, levels: 3, size: 4 });
    expect(stack(13)).toEqual({ root: 10, on: 10, level: 2, levels: 3, size: 4 });
    expect([stack(20), stack(30), stack(40)]).toEqual([null, null, null]);
    expect(stackLabel(stack(12)!)).toBe("3 of 3 · on #11");
    expect(stackLabel(stack(10)!)).toBe("1 of 3");
  });

  it("breaks a cycle of branches instead of looping", () => {
    const prs = linkStacks([pr(1, "a", "b"), pr(2, "b", "a")]);
    expect(prs.filter((p) => p.stack?.on === null)).toHaveLength(1);
    expect(prs.every((p) => p.stack?.size === 2)).toBe(true);
  });

  it("is available when ready for the user and every PR beneath is too", () => {
    const prs = linkStacks([
      pr(10, "a", "main", "ready-for-erwin"),
      pr(11, "b", "a", "ready-for-erwin"),
      pr(12, "c", "b", "ready-for-erwin"),
      pr(20, "w", "main", "working"),
      pr(21, "r", "w", "ready-for-erwin"),
      pr(22, "q", "r", "ready-for-erwin"),
      pr(30, "solo", "main", "ready-for-erwin"),
      pr(31, "solo-review", "main", "in-review"),
    ]);
    expect(prs.filter((p) => p.available).map((p) => p.number)).toEqual([10, 11, 12, 30]);
  });

  it("orders Next up by when each stack's bottom opened, then bottom-up", () => {
    const prs = linkStacks([
      pr(30, "solo", "main", "ready-for-erwin"),
      pr(12, "c", "b", "ready-for-erwin", { createdAt: 1 }),
      pr(11, "b", "a", "ready-for-erwin"),
      pr(10, "a", "main", "ready-for-erwin"),
      pr(5, "old", "main", "ready-for-erwin"),
    ]);
    expect(nextUp(prs).map((p) => p.number)).toEqual([5, 10, 11, 12, 30]);
  });
});

describe("W224 grouped views", () => {
  const prs = linkStacks([
    pr(1, "a", "main", "ready-for-erwin", { category: "Security" }),
    pr(2, "b", "a", "working", { category: "Security" }),
    pr(3, "c", "b", "ready-for-erwin", { category: "CI" }),
    pr(4, "d", "main", "in-review", { category: "CI" }),
    pr(5, "e", "main", "ready-for-review"),
  ]);
  const shape = (by: "category" | "stage") =>
    groupPrs(prs, by, PR_STAGES).map((g) => [g.label, g.count, g.groups.map((s) => [s.label, s.pullRequests.map((p) => p.number)])]);

  it("groups by category then stage, or stage then category, uncategorized last", () => {
    expect(shape("category")).toEqual([
      ["CI", 2, [["Ready for you", [3]], ["In review", [4]]]],
      ["Security", 2, [["Ready for you", [1]], ["Being worked on", [2]]]],
      ["Uncategorized", 1, [["Ready for review", [5]]]],
    ]);
    expect(shape("stage")).toEqual([
      ["Ready for you", 2, [["CI", [3]], ["Security", [1]]]],
      ["In review", 1, [["CI", [4]]]],
      ["Ready for review", 1, [["Uncategorized", [5]]]],
      ["Being worked on", 1, [["Security", [2]]]],
    ]);
    expect(categoriesOf(prs)).toEqual([
      { category: "CI", label: "CI", count: 2 }, { category: "Security", label: "Security", count: 2 }, { category: null, label: "Uncategorized", count: 1 },
    ]);
  });

  it("filters by category, stages and availability", () => {
    const numbers = (filter: Parameters<typeof filterPrs>[1]) => filterPrs(prs, filter).map((p) => p.number);
    expect(numbers({ category: "CI", stages: [], availableOnly: false })).toEqual([3, 4]);
    expect(numbers({ category: null, stages: [], availableOnly: false })).toEqual([5]);
    expect(numbers({ stages: ["ready-for-erwin", "working"], availableOnly: false })).toEqual([1, 2, 3]);
    // #3 is ready, but #2 beneath it is being worked on.
    expect(numbers({ stages: [], availableOnly: true })).toEqual([1]);
  });

  it("lays a lane's stacks out as trees, indented where they branch, each piece saying what it sits on", () => {
    const tree = linkStacks([
      pr(1, "a", "main"), pr(2, "b", "a"), pr(3, "c", "b"), pr(4, "d", "b"), pr(5, "e", "d"), pr(9, "solo", "main"),
    ]);
    const lane = laneLayout(tree);
    expect(lane.singles.map((p) => p.number)).toEqual([9]);
    expect(lane.stacks.map((s) => [s.on, s.rows.map((r) => [r.pr.number, r.col, r.parentRow])])).toEqual([
      [null, [[1, 0, null], [2, 0, 0], [3, 1, 1], [4, 1, 1], [5, 1, 3]]],
    ]);
    // Without #2 (another category, or filtered out), #1 and #3-#5 draw apart.
    const split = laneLayout(tree.filter((p) => p.number !== 2), tree);
    expect(split.stacks.map((s) => [s.on, s.rows.map((r) => [r.pr.number, r.col])])).toEqual([
      [null, [[1, 0]]],
      [2, [[3, 0]]],
      [2, [[4, 0], [5, 0]]],
    ]);
  });

  it("summarizes the queue for the coordinator in a few lines", () => {
    const queue: MergeQueue = {
      projectId: "p", login: "erwinkn", repos: [{ repo: "erwinkn/bb", fetchedAt: 5, error: null, fetching: false, detailsFetchedAt: null, detailsError: null }], skipped: [],
      stages: PR_STAGES.map((s) => ({ ...s })), pullRequests: prs,
    };
    expect(prSummary(queue)).toEqual({
      repos: [{ repo: "erwinkn/bb", fetchedAt: 5 }],
      open: 5,
      next: [{ pr: "#1", title: "PR 1", category: "Security", stack: "1 of 3" }],
      byCategory: {
        CI: { "ready-for-erwin": ["#3 (3 of 3 · on #2)"], "in-review": ["#4"] },
        Security: { "ready-for-erwin": ["#1 (1 of 3)"], working: ["#2 (2 of 3 · on #1)"] },
        Uncategorized: { "ready-for-review": ["#5"] },
      },
      stacks: ["#1 → #2 → #3"],
      state: {},
    });
    const guessed = prSummary({ ...queue, pullRequests: prs.map((p) => ({ ...p, stageSource: "github" as const })) });
    expect(guessed.note).toMatch(/guessed from GitHub/);
  });

  it("carries the coordinator's categories onto the fetched PRs by canonical URL", () => {
    const records = new Map([[url(1), { ...blankPrRecord(url(1), 1), category: "CI", waitingOn: "W3: rebase" }]]);
    const [one] = assignStages([pr(1, "a", "main")].map((p) => ({ ...p, url: "https://github.com/ErwinKN/bb/pull/1" })), records);
    expect(one).toMatchObject({ category: "CI", waitingOn: "W3: rebase", stageSource: "github" });
  });
});
