import { describe, expect, it, vi } from "vitest";
import {
  DETAILS_PAGE,
  LIST_PAGE,
  assignStages,
  attachWorkers,
  branchThreadId,
  classify,
  githubRepo,
  orderQueue,
  parseDetails,
  parsePrLookup,
  parseSearchPage,
  prLookupQuery,
  prSearch,
  parsePullRequests,
  githubStage,
  summarizeChecks,
} from "../lib/merge-queue";
import { PR_STAGES, blankPrRecord, type PrRecord } from "../lib/pr-stages";
import { groupPrs } from "../lib/pr-map";
import {
  DETAILS_CONCURRENCY, DETAILS_RESYNC_MS, DETAILS_RETRY_MS, IDLE_REFRESH_MS, MIN_FORCED_REFRESH_MS, LOOKUP_LIMIT, MergeQueueCache, PR_LIMIT, REFRESH_MS, REPOS_PER_SEARCH, VIEWER_MS,
  semaphore, type GraphQl, type MergeQueueSources,
} from "../lib/merge-queue-server";
import { cursorOf, detailsAnswer, queryKind, reposOf, rollup, searchPage, withId } from "./gh-fixtures";

/** One list query node, shaped like real output; its id is its URL (gh-fixtures' detailsAnswer). */
const ghPr = (overrides: Record<string, unknown> = {}) => withId({
  number: 68,
  title: "Questions: drop string maxLength from tool schemas",
  url: "https://github.com/erwinkn/bb-plugins/pull/68",
  isDraft: false,
  reviewDecision: "",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  headRefName: "fix/questions-tool-schema-grammar",
  baseRefName: "main",
  createdAt: "2026-09-18T18:31:58Z",
  updatedAt: "2026-09-18T18:41:56Z",
  statusCheckRollup: rollup({ SUCCESS: 1, SKIPPED: 1, FAILURE: 0 }, { SUCCESS: 1 }),
  ...overrides,
});
const parseOne = (overrides: Record<string, unknown> = {}) =>
  parsePullRequests("erwinkn/bb-plugins", [ghPr(overrides)])[0]!;

describe("githubRepo", () => {
  it("reads owner/repo from https, ssh and scp-like remotes only", () => {
    expect(githubRepo("https://github.com/erwinkn/bb-plugins.git")).toBe("erwinkn/bb-plugins");
    expect(githubRepo("https://github.com/brimstone-cement/engineering")).toBe("brimstone-cement/engineering");
    expect(githubRepo("git@github.com:equisafe/coffre.git")).toBe("equisafe/coffre");
    expect(githubRepo("ssh://git@github.com/erwinkn/bb.git")).toBe("erwinkn/bb");
    expect(githubRepo("https://token@github.com/erwinkn/erwinkn.com.git")).toBe("erwinkn/erwinkn.com");
    expect(githubRepo("https://gitlab.com/acme/widgets.git")).toBeNull();
    expect(githubRepo(null)).toBeNull();
  });
});

describe("parsing gh pr list", () => {
  it("keeps every field the queue shows", () => {
    expect(parseOne()).toEqual({
      repo: "erwinkn/bb-plugins",
      number: 68,
      title: "Questions: drop string maxLength from tool schemas",
      unassigned: false,
      url: "https://github.com/erwinkn/bb-plugins/pull/68",
      draft: false,
      review: "none",
      checks: { state: "pass", passed: 3, failed: 0, pending: 0, total: 3 },
      mergeable: "mergeable",
      mergeState: "clean",
      head: "fix/questions-tool-schema-grammar",
      base: "main",
      createdAt: Date.parse("2026-09-18T18:31:58Z"),
      updatedAt: Date.parse("2026-09-18T18:41:56Z"),
      group: "ready",
      // Not approved (the repo requires no review): a guess of ready for review.
      stage: "ready-for-review",
      stageSource: "github",
      stageNote: null,
      stageSetAt: null,
      reasons: [],
      worker: null,
      size: null,
      reviewers: [],
      category: null,
      waitingOn: null,
      changes: [],
      decision: null,
      stack: null,
      available: false,
      notes: { count: 0, recent: [], open: [] },
      links: { workers: [], assignments: [] },
    });
  });

  it("rolls up check runs and status contexts from their counts by state", () => {
    expect(summarizeChecks(rollup())).toEqual({ state: "none", passed: 0, failed: 0, pending: 0, total: 0 });
    // A check run counts by its conclusion once completed; one completed without a conclusion is pending.
    expect(summarizeChecks(rollup({ IN_PROGRESS: 1, SUCCESS: 1, COMPLETED: 1 }, { PENDING: 1 })))
      .toEqual({ state: "pending", passed: 1, failed: 0, pending: 3, total: 4 });
    // One failure outranks pending checks.
    expect(summarizeChecks(rollup({ QUEUED: 1, TIMED_OUT: 1 }, { ERROR: 1 }))).toMatchObject({ state: "fail", failed: 2, pending: 1 });
    // A commit without checks, a PR without commits, or a malformed count: nothing to count.
    expect(summarizeChecks({ nodes: [{ commit: { statusCheckRollup: null } }] }).state).toBe("none");
    expect(summarizeChecks({ nodes: [] }).state).toBe("none");
    expect(summarizeChecks(null).state).toBe("none");
    expect(summarizeChecks(rollup({ SUCCESS: -2, FAILURE: 1.5 })).state).toBe("none");
  });

  it("drops malformed entries one by one", () => {
    const parsed = parsePullRequests("erwinkn/bb-plugins", [ghPr(), null, {}, { number: "7" }, ghPr({ number: 0 }), ghPr({ number: 70, url: "javascript:alert(1)" }), ghPr({ number: 71, title: "" })]);
    expect(parsed.map((pr) => pr.number)).toEqual([68, 71]);
    expect(parsed[1]!.title).toBe("erwinkn/bb-plugins#71");
  });

  it("reads a search page with the account that searched; an answer without search results throws", () => {
    expect(parseSearchPage(searchPage([ghPr()], "c1", 209), "the PR list query")).toEqual({ nodes: [ghPr()], total: 209, next: "c1", login: "erwinkn" });
    expect(parseSearchPage({ search: { nodes: [] } }, "the PR list query")).toEqual({ nodes: [], total: 0, next: null, login: null });
    expect(() => parseSearchPage(null, "the PR list query")).toThrow("the PR list query returned no search results");
    expect(() => parseSearchPage({ search: null }, "the PR list query")).toThrow("the PR list query returned no search results");
  });

  it("searches several repositories in one query, ORing their qualifiers", () => {
    expect(prSearch(["erwinkn/bb-plugins", "equisafe/infra"])).toBe("is:pr is:open author:@me repo:erwinkn/bb-plugins repo:equisafe/infra");
  });

  it("asks for each PR's state by URL in one query, and reads each answer (W516)", () => {
    expect(prLookupQuery(2)).toBe([
      "query($u0: URI!, $u1: URI!) {",
      "  p0: resource(url: $u0) { ... on PullRequest { state mergedAt closedAt } }",
      "  p1: resource(url: $u1) { ... on PullRequest { state mergedAt closedAt } }",
      "}",
    ].join("\n"));
    expect(parsePrLookup({ state: "MERGED", mergedAt: "2026-10-01T00:00:00Z", closedAt: "2026-10-01T00:00:00Z" }))
      .toEqual({ state: "MERGED", mergedAt: Date.parse("2026-10-01T00:00:00Z"), closedAt: Date.parse("2026-10-01T00:00:00Z") });
    expect(parsePrLookup({ state: "OPEN", mergedAt: null, closedAt: null })).toEqual({ state: "OPEN", mergedAt: null, closedAt: null });
    expect(parsePrLookup(null)).toEqual({ error: "not found on GitHub" });
    // An issue's URL resolves to an Issue, which the fragment leaves empty.
    expect(parsePrLookup({})).toEqual({ error: "not a pull request" });
    expect(parsePrLookup({ state: "WEIRD" })).toEqual({ error: "unexpected state WEIRD" });
  });
});

describe("merge-queue order", () => {
  it("classifies ready, waiting, needs fixes and drafts, with reasons", () => {
    expect(parseOne({ reviewDecision: "APPROVED" })).toMatchObject({ group: "ready", review: "approved" });
    expect(parseOne({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" })).toMatchObject({ group: "waiting", reasons: ["mergeability unknown"] });
    expect(parseOne({ reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED" })).toMatchObject({ group: "waiting", reasons: ["review required"] });
    expect(parseOne({ mergeStateStatus: "BEHIND" })).toMatchObject({ group: "waiting", reasons: ["behind base"] });
    expect(parseOne({ statusCheckRollup: rollup({ IN_PROGRESS: 1 }) })).toMatchObject({ group: "waiting", reasons: ["1 check running"] });
    expect(parseOne({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" })).toMatchObject({ group: "fix", reasons: ["conflicts"] });
    expect(parseOne({
      reviewDecision: "CHANGES_REQUESTED",
      statusCheckRollup: rollup({ FAILURE: 2 }),
    })).toMatchObject({ group: "fix", reasons: ["2 checks failing", "changes requested"] });
    // A draft is a draft whatever else is true, and keeps its reasons.
    expect(parseOne({ isDraft: true, mergeable: "CONFLICTING" })).toMatchObject({ group: "draft", reasons: ["conflicts"] });
    expect(classify({ draft: false, review: "none", mergeable: "mergeable", mergeState: "blocked", checks: summarizeChecks(rollup()) }))
      .toEqual({ group: "waiting", reasons: ["blocked by branch rules"] });
  });

  it("guesses a stage from GitHub: drafts are worked on, approved green mergeable PRs are ready for the user", () => {
    expect(githubStage(parseOne({ isDraft: true, reviewDecision: "APPROVED" }))).toBe("working");
    expect(githubStage(parseOne({ reviewDecision: "APPROVED" }))).toBe("ready-for-erwin");
    expect(githubStage(parseOne({ reviewDecision: "APPROVED", statusCheckRollup: rollup() }))).toBe("ready-for-erwin");
    expect(githubStage(parseOne({ reviewDecision: "APPROVED", mergeable: "UNKNOWN" }))).toBe("ready-for-review");
    expect(githubStage(parseOne({ reviewDecision: "APPROVED", statusCheckRollup: rollup({ IN_PROGRESS: 1 }) }))).toBe("ready-for-review");
    expect(githubStage(parseOne({ reviewDecision: "" }))).toBe("ready-for-review");
    expect(githubStage(parseOne({ mergeable: "CONFLICTING" }))).toBe("ready-for-review");
  });

  it("groups by stage, the coordinator's where recorded, oldest first within a stage", () => {
    const at = (day: number) => `2026-09-${String(day).padStart(2, "0")}T10:00:00Z`;
    const url = (n: number) => `https://github.com/erwinkn/bb/pull/${n}`;
    const prs = parsePullRequests("erwinkn/bb", [
      ghPr({ number: 1, url: url(1), isDraft: true, createdAt: at(1) }),
      ghPr({ number: 2, url: url(2), mergeable: "CONFLICTING", createdAt: at(2) }),
      ghPr({ number: 3, url: url(3), reviewDecision: "APPROVED", createdAt: at(3) }),
      ghPr({ number: 4, url: url(4), createdAt: at(9) }),
      ghPr({ number: 5, url: url(5), createdAt: at(4) }),
      ghPr({ number: 6, url: url(6), isDraft: true, createdAt: at(5) }),
    ]);
    const record = (n: number, stage: PrRecord["stage"], note: string | null = null): [string, PrRecord] =>
      [url(n), { ...blankPrRecord(url(n), 1000 + n), stage, note, setAt: 1000 + n }];
    // Recorded keys are canonical (lower case); PR #4 matches whatever its case.
    const staged = assignStages(prs.map((pr) => pr.number === 4 ? { ...pr, url: "https://github.com/ErwinKN/bb/pull/4" } : pr), new Map([
      record(4, "in-review", "W14 reviewing"),
      record(6, "experiment"),
    ]));
    expect(staged.map((pr) => [pr.number, pr.stage, pr.stageSource, pr.stageNote])).toEqual([
      [1, "working", "github", null],
      [2, "ready-for-review", "github", null],
      [3, "ready-for-erwin", "github", null],
      [4, "in-review", "coordinator", "W14 reviewing"],
      [5, "ready-for-review", "github", null],
      [6, "experiment", "coordinator", null],
    ]);
    expect(groupPrs(orderQueue(staged), "stage", PR_STAGES).map((g) => [g.label, g.groups.flatMap((c) => c.pullRequests).map((pr) => pr.number)])).toEqual([
      ["Ready for you", [3]],
      ["In review", [4]],
      ["Ready for review", [2, 5]],
      ["Being worked on", [1]],
      ["Experiments", [6]],
    ]);
    expect(PR_STAGES.map((s) => s.id)).toEqual(["ready-for-erwin", "in-review", "ready-for-review", "working", "experiment"]);
  });

  it("labels a PR with the worker whose BB worktree branch opened it", () => {
    expect(branchThreadId("bb/w198-merge-queue-github-cleanup-initiative-dashb-thr_5t6t6jjct3")).toBe("thr_5t6t6jjct3");
    expect(branchThreadId("fix/questions-tool-schema-grammar")).toBeNull();
    const prs = parsePullRequests("erwinkn/bb-plugins", [
      ghPr({ number: 1, headRefName: "bb/w198-merge-queue-thr_5t6t6jjct3" }),
      ghPr({ number: 2, headRefName: "bb/w12-other-thr_unknown" }),
    ]);
    const labelled = attachWorkers(prs, new Map([["thr_5t6t6jjct3", "W198"]]));
    expect(labelled.map((pr) => pr.worker)).toEqual([{ ref: "W198", threadId: "thr_5t6t6jjct3", assignment: null, role: null, source: "branch" }, null]);
  });
});

describe("semaphore (W520)", () => {
  it("runs at most its limit at once, the rest in arrival order, and frees a failed task's slot", async () => {
    const slots = semaphore(2);
    const started: number[] = [];
    const finish = new Map<number, (fail: boolean) => void>();
    const tasks = [1, 2, 3, 4].map((n) => slots(() => new Promise<number>((resolve, reject) => {
      started.push(n);
      finish.set(n, (fail) => (fail ? reject(new Error(`task ${n}`)) : resolve(n)));
    })));
    await vi.waitFor(() => expect(started).toEqual([1, 2]));
    finish.get(2)!(true);
    await expect(tasks[1]).rejects.toThrow("task 2");
    await vi.waitFor(() => expect(started).toEqual([1, 2, 3]));
    finish.get(1)!(false);
    await vi.waitFor(() => expect(started).toEqual([1, 2, 3, 4]));
    finish.get(3)!(false);
    finish.get(4)!(false);
    expect(await Promise.all([tasks[0], tasks[2], tasks[3]])).toEqual([1, 3, 4]);
    // Every slot is free again.
    const again: number[] = [];
    await Promise.all([5, 6].map((n) => slots(async () => { again.push(n); })));
    expect(again).toEqual([5, 6]);
  });
});

describe("MergeQueueCache", () => {
  const remotes: Record<string, { name: string; gitRemoteUrl: string | null }> = {
    "proj-plugins": { name: "bb-plugins", gitRemoteUrl: "https://github.com/erwinkn/bb-plugins.git" },
    "proj-fork": { name: "bb-fork", gitRemoteUrl: "git@github.com:erwinkn/bb.git" },
    "proj-local": { name: "scratch", gitRemoteUrl: null },
  };
  const sources = (overrides: Partial<MergeQueueSources> = {}): MergeQueueSources => ({
    memberProjectIds: () => ["proj-plugins"], project: async (id) => remotes[id]!, workers: () => new Map(),
    prRecords: () => new Map(), assignedPrs: () => new Map(), notes: () => new Map(), ...overrides,
  });
  const setup = (github: GraphQl, members = ["proj-plugins", "proj-fork", "proj-local"], overrides: Partial<MergeQueueSources> = {}) => {
    let now = 1_000_000;
    const project = vi.fn(async (id: string) => remotes[id]!);
    const fetched = vi.fn();
    const cache = new MergeQueueCache(
      sources({ memberProjectIds: () => members, project, workers: () => new Map([["thr_abc", "W7"]]), ...overrides }),
      github,
      () => now,
      fetched,
    );
    return { cache, project, fetched, advance: (ms: number) => { now += ms; }, at: () => now };
  };
  /** A read, then the one after the fetch it started settles: what a client sees once told. */
  const settledRead = async (cache: MergeQueueCache, id: string, options: { refresh?: boolean; viewer?: boolean } = {}) => {
    await cache.read(id, options);
    await cache.settled();
    return cache.read(id);
  };
  const page = searchPage;
  const numberOf = (url: string) => Number(url.split("/").pop());
  /** Each PR's details by URL: one addition, unless `of` says otherwise. */
  const sized = (url: string): Record<string, unknown> | null => ({ number: numberOf(url), additions: 1 });
  /** A GitHub with these open PRs by repository (as the search names it), and these details. */
  const answers = (lists: Record<string, unknown[]>, details = sized) =>
    vi.fn<GraphQl>(async (query, variables) => {
      if (queryKind(query) === "details") return detailsAnswer(variables, details);
      return page(reposOf(variables).flatMap((repo) => lists[repo] ?? []));
    });
  const calls = (github: { mock: { calls: Parameters<GraphQl>[] } }, kind: ReturnType<typeof queryKind>) =>
    github.mock.calls.filter(([query]) => queryKind(query) === kind);
  const fresh = (at: number) => ({ fetchedAt: at, error: null, fetching: false, detailsFetchedAt: at, detailsError: null });

  it("answers at once from the cache and fetches behind it, never waiting on GitHub (D441)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const github = vi.fn<GraphQl>(async (query, variables) => {
      await gate;
      return queryKind(query) === "details" ? detailsAnswer(variables, sized) : page([ghPr()]);
    });
    const { cache, fetched } = setup(github, ["proj-plugins"]);
    // GitHub hangs: the read still answers, with the first fetch running.
    const first = await cache.read("a");
    expect(first.pullRequests).toEqual([]);
    expect(first.repos).toEqual([{ repo: "erwinkn/bb-plugins", fetchedAt: null, error: null, fetching: true, detailsFetchedAt: null, detailsError: null }]);
    expect(fetched).not.toHaveBeenCalled();
    release();
    await cache.settled();
    expect(fetched).toHaveBeenCalledWith("erwinkn/bb-plugins");
    const second = await cache.read("a");
    expect(second.repos[0]!.fetching).toBe(false);
    expect(second.pullRequests.map((pr) => pr.number)).toEqual([68]);
  });

  it("reads every member's repository in one search, again after two minutes while a dashboard shows them (W516)", async () => {
    const github = answers({
      "erwinkn/bb-plugins": [ghPr({ headRefName: "bb/w7-x-thr_abc" })],
      "erwinkn/bb": [ghPr({ number: 68, url: "https://github.com/erwinkn/bb/pull/68", isDraft: true })],
    });
    const { cache, advance, at } = setup(github);
    const first = await settledRead(cache, "init-1", { viewer: true });
    expect(first.login).toBe("erwinkn");
    expect(first.repos).toEqual([
      { repo: "erwinkn/bb-plugins", ...fresh(at()) },
      { repo: "erwinkn/bb", ...fresh(at()) },
    ]);
    expect(first.skipped).toEqual([{ project: "scratch", reason: "no GitHub origin remote" }]);
    // The same number in two repositories: each PR under its own, with its own details.
    expect(first.pullRequests.map((pr) => [pr.repo, pr.number, pr.stage, pr.worker?.ref ?? null, pr.size?.additions])).toEqual([
      ["erwinkn/bb-plugins", 68, "ready-for-review", "W7", 1],
      ["erwinkn/bb", 68, "working", null, 1],
    ]);
    // One search for both repositories, then one details request per repository (W520).
    expect(calls(github, "list").map(([, variables]) => variables)).toEqual([{ q: "is:pr is:open author:@me repo:erwinkn/bb-plugins repo:erwinkn/bb" }]);
    expect(calls(github, "details").map(([, variables]) => variables)).toEqual([
      { ids: ["https://github.com/erwinkn/bb-plugins/pull/68"] }, { ids: ["https://github.com/erwinkn/bb/pull/68"] },
    ]);
    expect(github).toHaveBeenCalledTimes(3);

    // Within two minutes reads come from the cache.
    advance(REFRESH_MS - 1);
    await settledRead(cache, "init-1", { viewer: true });
    expect(github).toHaveBeenCalledTimes(3);
    // Then the list again; no PR changed, so no details.
    advance(1);
    await settledRead(cache, "init-1", { viewer: true });
    expect(github).toHaveBeenCalledTimes(4);
    expect(calls(github, "list")).toHaveLength(2);
  });

  it("re-reads a repository no dashboard shows only every ten minutes (W516)", async () => {
    const github = answers({ "erwinkn/bb-plugins": [ghPr()] });
    const { cache, advance } = setup(github, ["proj-plugins"]);
    // An agent's read: the first one fetches, the next two minutes later doesn't.
    await settledRead(cache, "a");
    advance(REFRESH_MS);
    await settledRead(cache, "a");
    expect(calls(github, "list")).toHaveLength(1);
    advance(IDLE_REFRESH_MS - REFRESH_MS);
    await settledRead(cache, "a");
    expect(calls(github, "list")).toHaveLength(2);
    // A dashboard read brings the two-minute cadence back, for agents' reads beside it too…
    advance(REFRESH_MS);
    await settledRead(cache, "a", { viewer: true });
    expect(calls(github, "list")).toHaveLength(3);
    advance(REFRESH_MS);
    await settledRead(cache, "other-initiative");
    expect(calls(github, "list")).toHaveLength(3);
    // …while it is recent: the dashboard's read was two minutes ago, past VIEWER_MS.
    expect(REFRESH_MS).toBeGreaterThan(VIEWER_MS);
    advance(IDLE_REFRESH_MS - REFRESH_MS - 1);
    await settledRead(cache, "a");
    expect(calls(github, "list")).toHaveLength(3);
    advance(1);
    await settledRead(cache, "a");
    expect(calls(github, "list")).toHaveLength(4);
  });

  it("splits a read's repositories into searches of at most REPOS_PER_SEARCH (W516)", async () => {
    const ids = Array.from({ length: REPOS_PER_SEARCH + 2 }, (_, i) => `p${i}`);
    const lists = Object.fromEntries(ids.map((id) => [`o/r${id}`, [ghPr({ number: 1, url: `https://github.com/o/r${id}/pull/1` })]]));
    const github = answers(lists);
    const { cache } = setup(github, ids, { project: async (id) => ({ name: id, gitRemoteUrl: `https://github.com/o/r${id}` }) });
    const q = await settledRead(cache, "a");
    expect(calls(github, "list").map(([, variables]) => reposOf(variables).length)).toEqual([REPOS_PER_SEARCH, 2]);
    expect(q.pullRequests.map((pr) => pr.repo).sort()).toEqual(Object.keys(lists).sort());
    expect(q.repos.every((r) => r.error === null && r.fetching === false)).toBe(true);
  });

  it("treats owner/repo case variants as one repository, shown in the remote's casing", async () => {
    const github = answers({ "ErwinKN/BB-Plugins": [ghPr({ url: "https://github.com/ErwinKN/BB-Plugins/pull/68" })] });
    const variants: Record<string, { name: string; gitRemoteUrl: string }> = {
      upper: { name: "bb-plugins", gitRemoteUrl: "https://github.com/ErwinKN/BB-Plugins.git" },
      lower: { name: "bb-plugins-mirror", gitRemoteUrl: "git@github.com:erwinkn/bb-plugins.git" },
    };
    const cache = new MergeQueueCache(sources({ memberProjectIds: () => ["upper", "lower"], project: async (id) => variants[id]! }), github);
    const q = await settledRead(cache, "a");
    expect(q.repos.map((r) => r.repo)).toEqual(["ErwinKN/BB-Plugins"]);
    expect(q.pullRequests.map((pr) => [pr.repo, pr.number])).toEqual([["ErwinKN/BB-Plugins", 68]]);
    // One list and one details call: the variants share a cache entry.
    expect(github).toHaveBeenCalledTimes(2);
  });

  it("applies the coordinator's recorded stages and the notes on every read", async () => {
    const github = answers({ "erwinkn/bb-plugins": [ghPr()] });
    const stages = new Map<string, PrRecord>();
    const url = "https://github.com/erwinkn/bb-plugins/pull/68";
    const notes = new Map([[url, { count: 1, recent: [{ n: 1, at: 5, author: "W7", kind: "note" as const, text: "Rebased", link: "A3", answered: null }], open: [] }]]);
    const cache = new MergeQueueCache(sources({ prRecords: () => stages, notes: () => notes }), github);
    expect((await settledRead(cache, "a")).pullRequests.map((pr) => [pr.stage, pr.stageSource, pr.notes.count])).toEqual([["ready-for-review", "github", 1]]);
    stages.set(url, { ...blankPrRecord(url, 5), stage: "in-review", setAt: 5 });
    // A stage change needs no GitHub fetch: the cached list is staged again.
    const q = await cache.read("a");
    expect(q.pullRequests.map((pr) => [pr.stage, pr.stageSource])).toEqual([["in-review", "coordinator"]]);
    expect(q.stages.map((s) => s.id)).toEqual(PR_STAGES.map((s) => s.id));
    expect(github).toHaveBeenCalledTimes(2);
  });

  it("runs one fetch per repository for concurrent reads and honors a manual refresh", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const github = vi.fn<GraphQl>(async (query, variables) => {
      await gate;
      return queryKind(query) === "details" ? detailsAnswer(variables, sized) : page([ghPr()]);
    });
    const { cache, advance } = setup(github, ["proj-plugins"]);
    await Promise.all([cache.read("a"), cache.read("b"), cache.read("a", { refresh: true })]);
    release();
    await cache.settled();
    expect((await cache.read("b")).pullRequests).toHaveLength(1);
    expect(github).toHaveBeenCalledTimes(2);
    // A refresh right after a fetch reuses it; ten seconds later it reads the list again.
    await settledRead(cache, "a", { refresh: true });
    expect(github).toHaveBeenCalledTimes(2);
    advance(10_000);
    await settledRead(cache, "a", { refresh: true });
    expect(calls(github, "list")).toHaveLength(2);
  });

  it("shows the list before its details land; a refresh meanwhile reads the list again, never the same details (W229, W520)", async () => {
    let releaseDetails!: () => void;
    const detailsGate = new Promise<void>((resolve) => { releaseDetails = resolve; });
    const github = vi.fn<GraphQl>(async (query, variables) => {
      if (queryKind(query) === "details") {
        await detailsGate;
        return detailsAnswer(variables, sized);
      }
      return page([ghPr()]);
    });
    const { cache, advance, fetched } = setup(github, ["proj-plugins"]);
    await cache.read("a");
    await vi.waitFor(() => expect(calls(github, "details")).toHaveLength(1));
    // The list landed and was announced; its details still run, and the repository says so.
    expect(fetched).toHaveBeenCalledTimes(1);
    advance(10_000);
    const during = await cache.read("a", { refresh: true });
    expect(during.repos[0]!.fetching).toBe(true);
    expect(during.pullRequests.map((pr) => [pr.number, pr.size])).toEqual([[68, null]]);
    // The forced refresh read the list again; #68's details, still asked, aren't asked twice.
    await vi.waitFor(() => expect(calls(github, "list")).toHaveLength(2));
    releaseDetails();
    await cache.settled();
    expect(calls(github, "details")).toHaveLength(1);
    expect(fetched).toHaveBeenCalledTimes(3);
    const done = await cache.read("a");
    expect(done.pullRequests[0]!.size).toMatchObject({ additions: 1 });
    expect(done.repos[0]!.fetching).toBe(false);
  });

  it("adds each PR's size and reviewers; a failed details read keeps its size, withholds its reviewers and says so, PR by PR (W229, W520)", async () => {
    let details: Error | null = null;
    let updatedAt = "2026-09-18T18:41:56Z";
    const github = vi.fn<GraphQl>(async (query, variables) => {
      if (queryKind(query) !== "details") return page([ghPr({ updatedAt }), ghPr({ number: 69, url: "https://github.com/erwinkn/bb-plugins/pull/69" })]);
      if (details) throw details;
      return detailsAnswer(variables, (url) => numberOf(url) !== 68 ? null : {
        number: 68, additions: 908, deletions: 386, changedFiles: 48, commits: { totalCount: 5 },
        latestReviews: { nodes: [{ author: { login: "coderabbitai" }, state: "COMMENTED" }, { author: { login: "alice" }, state: "APPROVED" }] },
        reviewRequests: { nodes: [{ requestedReviewer: { login: "bob" } }, { requestedReviewer: { name: "core" } }, { requestedReviewer: { login: "alice" } }] },
      });
    });
    const { cache, advance, at } = setup(github, ["proj-plugins"]);
    const first = await settledRead(cache, "a");
    const loadedAt = at();
    expect(first.pullRequests.map((pr) => [pr.number, pr.size, pr.reviewers, pr.detailsError])).toEqual([
      [68, { additions: 908, deletions: 386, files: 48, commits: 5 }, [
        { login: "coderabbitai", state: "commented" }, { login: "alice", state: "approved" }, { login: "bob", state: "requested" }, { login: "core", state: "requested" },
      ], undefined],
      // GitHub didn't answer for #69 (gone since the list): no details, and no error.
      [69, null, [], undefined],
    ]);
    expect(first.repos[0]).toMatchObject({ detailsFetchedAt: loadedAt, detailsError: null });
    // #68 moved: its details are asked again with #69's, and fail: the batch splits down to each PR alone.
    details = new Error("HTTP 502");
    updatedAt = "2026-09-19T00:00:00Z";
    advance(IDLE_REFRESH_MS);
    const second = await settledRead(cache, "a");
    const asked = () => calls(github, "details").map(([, variables]) => (variables.ids as string[]).map(numberOf));
    expect(asked().slice(1)).toEqual([[69, 68], [69], [68]]);
    expect(second.repos[0]).toMatchObject({ fetchedAt: at(), error: null, detailsFetchedAt: loadedAt, detailsError: "HTTP 502 (2 PRs)" });
    // GitHub may have a newer review than the cached "approved": #68 keeps its size, without reviewer states.
    expect(second.pullRequests.map((pr) => [pr.number, pr.size?.additions ?? null, pr.reviewers, pr.detailsError])).toEqual([
      [68, 908, [], "HTTP 502"], [69, null, [], "HTTP 502"],
    ]);
    // The next refresh asks for each alone again (it failed alone), and heals.
    details = null;
    advance(IDLE_REFRESH_MS);
    const third = await settledRead(cache, "a");
    expect(asked().slice(4)).toEqual([[68], [69]]);
    expect(third.repos[0]).toMatchObject({ detailsFetchedAt: at(), detailsError: null });
    expect(third.pullRequests[0]!.reviewers).toHaveLength(4);
    expect(third.pullRequests[0]!.detailsError).toBeUndefined();
  });

  it("reads details only for PRs whose updatedAt moved, every PR's every half hour, and drops a closed PR's (W516)", async () => {
    let open = [ghPr(), ghPr({ number: 69, url: "https://github.com/erwinkn/bb-plugins/pull/69" })];
    const github = vi.fn<GraphQl>(async (query, variables) =>
      queryKind(query) === "details" ? detailsAnswer(variables, sized) : page(open));
    const { cache, advance } = setup(github, ["proj-plugins"]);
    const asked = () => calls(github, "details").map(([, variables]) => (variables.ids as string[]).map(numberOf));
    await settledRead(cache, "a");
    expect(asked()).toEqual([[68, 69]]);
    // Nothing moved: no details request at all.
    advance(IDLE_REFRESH_MS);
    const same = await settledRead(cache, "a");
    expect(asked()).toHaveLength(1);
    expect(same.repos[0]!.detailsError).toBeNull();
    expect(same.pullRequests.map((pr) => pr.size?.additions)).toEqual([1, 1]);
    // #69 got a push (updatedAt moved) and #70 opened: those two only, the one without details first.
    open = [ghPr(), ghPr({ number: 69, url: "https://github.com/erwinkn/bb-plugins/pull/69", updatedAt: "2026-09-20T00:00:00Z" }),
      ghPr({ number: 70, url: "https://github.com/erwinkn/bb-plugins/pull/70" })];
    advance(IDLE_REFRESH_MS);
    await settledRead(cache, "a");
    expect(asked().at(-1)).toEqual([70, 69]);
    // Half an hour after the first read, #68's details are due again; #69 and #70's, read since, aren't.
    advance(DETAILS_RESYNC_MS - 2 * IDLE_REFRESH_MS);
    await settledRead(cache, "a");
    expect(asked().at(-1)).toEqual([68]);
    // #68 closed: it leaves the list and its details are dropped; nothing else is due.
    open = open.slice(1);
    advance(IDLE_REFRESH_MS);
    const closed = await settledRead(cache, "a");
    expect(closed.pullRequests.map((pr) => pr.number)).toEqual([69, 70]);
    expect(asked()).toHaveLength(3);
  });

  /** `count` PRs of `repo`, numbered from 1. */
  const prsOf = (repo: string, count: number) => Array.from({ length: count }, (_, i) => ghPr({ number: i + 1, url: `https://github.com/${repo}/pull/${i + 1}` }));
  const askedIds = (github: { mock: { calls: Parameters<GraphQl>[] } }) => calls(github, "details").map(([, variables]) => variables.ids as string[]);

  it("splits a PR that always fails out of its batch, so every other PR loads, in its repository and the next (W520)", async () => {
    // erwinkn/bb-plugins has 100 PRs (two batches), erwinkn/bb one; erwinkn/bb-plugins#51 always fails.
    const lists = { "erwinkn/bb-plugins": prsOf("erwinkn/bb-plugins", 100), "erwinkn/bb": prsOf("erwinkn/bb", 1) };
    const bad = "https://github.com/erwinkn/bb-plugins/pull/51";
    const github = vi.fn<GraphQl>(async (query, variables) => {
      if (queryKind(query) !== "details") return page(reposOf(variables).flatMap((repo) => lists[repo as keyof typeof lists] ?? []));
      if ((variables.ids as string[]).includes(bad)) throw new Error("GitHub: Something went wrong while executing your query");
      return detailsAnswer(variables, sized);
    });
    const s = setup(github, ["proj-plugins", "proj-fork"]);
    const q = await settledRead(s.cache, "a", { viewer: true });
    expect(q.pullRequests.filter((pr) => pr.size?.additions === 1)).toHaveLength(100);
    expect(q.pullRequests.filter((pr) => pr.detailsError).map((pr) => [pr.repo, pr.number, pr.detailsError])).toEqual([
      ["erwinkn/bb-plugins", 51, "GitHub: Something went wrong while executing your query"],
    ]);
    expect(q.repos.map((r) => [r.repo, r.detailsError])).toEqual([
      ["erwinkn/bb-plugins", "GitHub: Something went wrong while executing your query (1 PR)"], ["erwinkn/bb", null],
    ]);
    // Each failing request halves, down to #51 alone: 7 requests name it, 15 in all.
    expect(askedIds(github).filter((ids) => ids.includes(bad)).map((ids) => ids.length)).toEqual([50, 25, 13, 7, 4, 2, 1]);
    expect(askedIds(github)).toHaveLength(15);
    // The next refreshes ask for #51 alone (and once more, quietly), after 2, then 4 minutes; nothing else is due.
    const later = async (ms: number) => {
      s.advance(ms);
      await settledRead(s.cache, "a", { viewer: true });
      return askedIds(github).slice(15).map((ids) => ids.map(numberOf));
    };
    expect(await later(DETAILS_RETRY_MS)).toEqual([[51], [51]]);
    expect(await later(DETAILS_RETRY_MS)).toEqual([[51], [51]]);
    expect(await later(2 * DETAILS_RETRY_MS)).toEqual([[51], [51], [51], [51]]);
  });

  it("never waits on a PR whose details hang: the other batches and repositories load first (W520)", async () => {
    const lists = { "erwinkn/bb-plugins": prsOf("erwinkn/bb-plugins", 100), "erwinkn/bb": prsOf("erwinkn/bb", 1) };
    const bad = "https://github.com/erwinkn/bb-plugins/pull/1";
    const settledOrder: string[] = [];
    let timeOut!: () => void;
    const timedOut = new Promise<void>((resolve) => { timeOut = resolve; });
    const github = vi.fn<GraphQl>(async (query, variables) => {
      if (queryKind(query) !== "details") return page(reposOf(variables).flatMap((repo) => lists[repo as keyof typeof lists] ?? []));
      const ids = variables.ids as string[];
      if (ids.includes(bad)) {
        // Hangs until its 20 s are up (here, until the test says so).
        await timedOut;
        settledOrder.push(`hung ${ids.length}`);
        throw new Error("GitHub didn't answer within 20 s");
      }
      settledOrder.push(`${ids.length}`);
      return detailsAnswer(variables, sized);
    });
    const s = setup(github, ["proj-plugins", "proj-fork"]);
    await s.cache.read("a");
    // The second batch of erwinkn/bb-plugins and erwinkn/bb's PR land while the first batch hangs.
    await vi.waitFor(() => expect(settledOrder).toEqual(["50", "1"]));
    const meanwhile = await s.cache.read("a");
    expect(meanwhile.pullRequests.filter((pr) => pr.size)).toHaveLength(51);
    expect(meanwhile.repos.map((r) => r.fetching)).toEqual([true, false]);
    timeOut();
    await s.cache.settled();
    const q = await s.cache.read("a");
    expect(q.pullRequests.filter((pr) => pr.size)).toHaveLength(100);
    expect(q.pullRequests.filter((pr) => pr.detailsError).map((pr) => pr.number)).toEqual([1]);
  });

  it("runs at most DETAILS_CONCURRENCY details requests at once, across repositories and fetches (W520)", async () => {
    // Four repositories of 125 PRs: 12 batches, and a second search's repositories beside them.
    const repos = ["o/a", "o/b", "o/c", "o/d"];
    const more = Array.from({ length: REPOS_PER_SEARCH }, (_, i) => `o/x${i}`);
    const lists: Record<string, unknown[]> = Object.fromEntries([...repos.map((repo) => [repo, prsOf(repo, 125)]), ...more.map((repo) => [repo, prsOf(repo, 3)])]);
    let running = 0;
    let most = 0;
    const github = vi.fn<GraphQl>(async (query, variables) => {
      if (queryKind(query) !== "details") return page(reposOf(variables).flatMap((repo) => lists[repo] ?? []));
      most = Math.max(most, ++running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running--;
      return detailsAnswer(variables, sized);
    });
    const s = setup(github, [...repos, ...more], { project: async (id) => ({ name: id, gitRemoteUrl: `https://github.com/${id}` }) });
    const q = await settledRead(s.cache, "a");
    expect(calls(github, "list")).toHaveLength(2);
    expect(askedIds(github)).toHaveLength(12 + REPOS_PER_SEARCH);
    expect(most).toBe(DETAILS_CONCURRENCY);
    expect(q.pullRequests.filter((pr) => pr.size)).toHaveLength(500 + 3 * REPOS_PER_SEARCH);
  });

  it("when GitHub fails every details request, asks at most three times per batch and blames no PR (W520)", async () => {
    const lists = { "erwinkn/bb-plugins": prsOf("erwinkn/bb-plugins", 100), "erwinkn/bb": prsOf("erwinkn/bb", 1) };
    let down = true;
    const github = vi.fn<GraphQl>(async (query, variables) => {
      if (queryKind(query) !== "details") return page(reposOf(variables).flatMap((repo) => lists[repo as keyof typeof lists] ?? []));
      if (down) throw new Error("GitHub answered HTTP 502");
      return detailsAnswer(variables, sized);
    });
    const s = setup(github, ["proj-plugins", "proj-fork"]);
    const q = await settledRead(s.cache, "a", { viewer: true });
    // Each batch of 50 once and its two halves; erwinkn/bb's one PR alone, and its retry.
    expect(askedIds(github).map((ids) => ids.length)).toEqual([50, 50, 1, 25, 25, 25, 25, 1]);
    expect(q.pullRequests.filter((pr) => pr.detailsError)).toHaveLength(101);
    // GitHub is back: erwinkn/bb-plugins' PRs go on from the split, in batches of 13, not one by one.
    down = false;
    s.advance(DETAILS_RETRY_MS);
    const healed = await settledRead(s.cache, "a", { viewer: true });
    expect(askedIds(github).slice(8).map((ids) => ids.length)).toEqual([13, 13, 13, 13, 13, 13, 13, 9, 1]);
    expect(healed.pullRequests.filter((pr) => pr.detailsError)).toHaveLength(0);
    expect(healed.pullRequests.filter((pr) => pr.size)).toHaveLength(101);
  });

  it("goes on with a split across fetches: two failing PRs in a lone batch never hold up the others for good (W520 r1)", async () => {
    // One batch of 50, nothing else to read: #1 and #26 always fail, one in each half, so no request succeeds.
    const lists = { "erwinkn/bb-plugins": prsOf("erwinkn/bb-plugins", 50) };
    const bad = new Set([1, 26].map((n) => `https://github.com/erwinkn/bb-plugins/pull/${n}`));
    const github = vi.fn<GraphQl>(async (query, variables) => {
      if (queryKind(query) !== "details") return page(reposOf(variables).flatMap((repo) => lists[repo as keyof typeof lists] ?? []));
      if ((variables.ids as string[]).some((id) => bad.has(id))) throw new Error("GitHub answered HTTP 502");
      return detailsAnswer(variables, sized);
    });
    const s = setup(github, ["proj-plugins"]);
    const first = await settledRead(s.cache, "a", { viewer: true });
    expect(askedIds(github).map((ids) => ids.length)).toEqual([50, 25, 25]);
    expect(first.pullRequests.filter((pr) => pr.size)).toHaveLength(0);
    // The next fetch asks in halves of those halves; the healthy ones load, and the split goes on to #1 and #26.
    s.advance(REFRESH_MS);
    const second = await settledRead(s.cache, "a", { viewer: true });
    expect(second.pullRequests.filter((pr) => pr.size)).toHaveLength(48);
    expect(second.pullRequests.filter((pr) => pr.detailsError).map((pr) => pr.number)).toEqual([1, 26]);
    // Four batches of at most 13, then a binary search down to each bad PR: two halves a step, 4 steps at most.
    const requests = askedIds(github).slice(3).map((ids) => ids.length);
    expect(requests.slice(0, 4)).toEqual([13, 13, 13, 11]);
    expect(requests.length).toBeLessThanOrEqual(4 + 2 * 2 * 4);
  });

  it("fails a request whose answer can't be read, rather than leave its PRs asked (W520 r1)", async () => {
    let broken = true;
    const github = vi.fn<GraphQl>(async (query, variables) => {
      if (queryKind(query) !== "details") return page([ghPr(), ghPr({ number: 69, url: "https://github.com/erwinkn/bb-plugins/pull/69" })]);
      const answer = detailsAnswer(variables, sized);
      // #69's node throws when read.
      const node = answer.nodes.find((n) => n && numberOf(n.id as string) === 69);
      if (broken && node) Object.defineProperty(node, "additions", { get: () => { throw new Error("unreadable node"); }, enumerable: true });
      return answer;
    });
    const s = setup(github, ["proj-plugins"]);
    const q = await settledRead(s.cache, "a", { viewer: true });
    expect(q.repos[0]!.fetching).toBe(false);
    expect(q.pullRequests.map((pr) => [pr.number, pr.detailsError])).toEqual([[68, undefined], [69, "unreadable node"]]);
    broken = false;
    s.advance(REFRESH_MS);
    const healed = await settledRead(s.cache, "a", { viewer: true });
    expect(healed.pullRequests.map((pr) => [pr.number, pr.size?.additions, pr.detailsError])).toEqual([[68, 1, undefined], [69, 1, undefined]]);
  });

  it("asks once for a PR that leaves the list and comes back while its details are read (W520 r1)", async () => {
    let open = [ghPr()];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const github = vi.fn<GraphQl>(async (query, variables) => {
      if (queryKind(query) !== "details") return page(open);
      await held;
      return detailsAnswer(variables, sized);
    });
    const s = setup(github, ["proj-plugins"]);
    await s.cache.read("a");
    await vi.waitFor(() => expect(calls(github, "details")).toHaveLength(1));
    // Forced refreshes: #68 leaves the list, then comes back, while its first request still runs.
    for (const list of [[], [ghPr()]]) {
      open = list;
      s.advance(MIN_FORCED_REFRESH_MS);
      await s.cache.read("a", { refresh: true });
      await vi.waitFor(() => expect(calls(github, "list")).toHaveLength(list.length ? 3 : 2));
      await vi.waitFor(async () => expect((await s.cache.read("a")).repos[0]!.fetching).toBe(true));
    }
    release();
    await s.cache.settled();
    expect(calls(github, "details")).toHaveLength(1);
    expect((await s.cache.read("a")).pullRequests.map((pr) => pr.size?.additions)).toEqual([1]);
  });

  it("keeps a successful list when the details answer has a malformed shape (W229)", async () => {
    const github = vi.fn<GraphQl>(async (query) => (queryKind(query) === "details" ? {} : page([ghPr()])));
    const { cache } = setup(github, ["proj-plugins"]);
    const q = await settledRead(cache, "a");
    expect(q.pullRequests.map((pr) => [pr.number, pr.detailsError])).toEqual([[68, "the details query returned no nodes"]]);
    expect(q.repos[0]).toMatchObject({ error: null, detailsError: "the details query returned no nodes (1 PR)" });
    expect(parseDetails([{ number: 68, additions: 3, latestReviews: { nodes: {} } }]).get(68)).toEqual({
      size: { additions: 3, deletions: 0, files: 0, commits: 0 }, reviewers: [],
    });
    // W520 r1: a review state that isn't one of GitHub's names counts as none, whatever it is.
    const odd = [{ toString: null, valueOf: null }, "constructor", "__proto__"].map((state) => ({ author: { login: "x" }, state }));
    expect(parseDetails([{ number: 68, latestReviews: { nodes: odd } }]).get(68)!.reviewers).toEqual([]);
  });

  /** A GitHub with `open` PRs by number, the list paging through them; like GitHub's search, it returns 1000 at most. */
  const github = (open: number) => vi.fn<GraphQl>(async (query, variables) => {
    if (queryKind(query) === "details") return detailsAnswer(variables, sized);
    const from = Number(cursorOf(variables) ?? 0);
    const to = Math.min(from + LIST_PAGE, open, 1000);
    const nodes = Array.from({ length: to - from }, (_, k) => ghPr({ number: from + k + 1, url: `https://github.com/erwinkn/bb-plugins/pull/${from + k + 1}` }));
    return page(nodes, to < Math.min(open, 1000) ? String(to) : null, open);
  });

  it("lists every open PR past the old cap of 200, with the details of each (W490)", async () => {
    const gh = github(209);
    const { cache } = setup(gh, ["proj-plugins"]);
    const q = await settledRead(cache, "a");
    expect(q.pullRequests).toHaveLength(209);
    expect(q.pullRequests.every((pr) => pr.size?.additions === 1)).toBe(true);
    expect(q.repos[0]).toMatchObject({ error: null, detailsError: null });
    expect(q.repos[0]!.capped).toBeUndefined();
    // The list pages to the end of the search, 100 a page; the details go DETAILS_PAGE ids a request.
    expect(calls(gh, "list").map(([, variables]) => cursorOf(variables))).toEqual([null, "100", "200"]);
    expect(calls(gh, "details").map(([, variables]) => (variables.ids as string[]).length)).toEqual([DETAILS_PAGE, DETAILS_PAGE, DETAILS_PAGE, DETAILS_PAGE, 9]);
  });

  it("stops at GitHub search's 1000 results and says how many it listed of how many (W490)", async () => {
    const gh = github(1012);
    const { cache } = setup(gh, ["proj-plugins"]);
    const q = await settledRead(cache, "a");
    expect(q.pullRequests).toHaveLength(PR_LIMIT);
    expect(q.repos[0]).toMatchObject({ error: null, capped: { listed: PR_LIMIT, total: 1012 } });
    expect(calls(gh, "list")).toHaveLength(PR_LIMIT / LIST_PAGE);
    expect(calls(gh, "details")).toHaveLength(PR_LIMIT / DETAILS_PAGE);
  });

  it("counts GitHub's 1000 results with their repeats: one PR shifted onto two pages still reads as capped", async () => {
    const pr = (n: number) => ghPr({ number: n, url: `https://github.com/erwinkn/bb-plugins/pull/${n}` });
    const gh = vi.fn<GraphQl>(async (query, variables) => {
      if (queryKind(query) === "details") return detailsAnswer(variables, sized);
      // Page k > 0 starts with the last PR of page k - 1: ten pages, 1000 results, 999 PRs.
      const k = Number(cursorOf(variables) ?? 0);
      const first = k === 0 ? 1 : k * LIST_PAGE;
      return page(Array.from({ length: LIST_PAGE }, (_, i) => pr(first + i)), k < 9 ? String(k + 1) : null, 1012);
    });
    const { cache } = setup(gh, ["proj-plugins"]);
    const q = await settledRead(cache, "a");
    expect(q.pullRequests).toHaveLength(999);
    expect(q.repos[0]).toMatchObject({ error: null, capped: { listed: 999, total: 1012 } });
  });

  it("fails a query whose page is empty yet promises more, rather than paging on or calling it GitHub's limit", async () => {
    const gh = vi.fn<GraphQl>(async (query, variables) => (cursorOf(variables) ? page([], "c2", 5) : page([ghPr()], "c1", 5)));
    const { cache } = setup(gh, ["proj-plugins"]);
    const q = await settledRead(cache, "a");
    expect(q.repos[0]).toMatchObject({ error: "the PR list query returned an empty page before the last (read 1 of 5 PRs)", detailsError: null });
    expect(q.repos[0]!.capped).toBeUndefined();
    expect(gh).toHaveBeenCalledTimes(2);
  });

  it("lists a PR once when the search shifts it onto the next page as well", async () => {
    const gh = vi.fn<GraphQl>(async (query, variables) => {
      const second = ghPr({ number: 69, url: "https://github.com/erwinkn/bb-plugins/pull/69" });
      if (queryKind(query) === "details") return detailsAnswer(variables, sized);
      return cursorOf(variables) ? page([second, ghPr({ number: 70, url: "https://github.com/erwinkn/bb-plugins/pull/70" })]) : page([ghPr(), second], "c1");
    });
    const { cache } = setup(gh, ["proj-plugins"]);
    expect((await settledRead(cache, "a")).pullRequests.map((pr) => pr.number).sort()).toEqual([68, 69, 70]);
  });

  it("retries a failed page once, quietly; two failures keep the last good list and say why (W490)", async () => {
    let failures = 1;
    const gh = vi.fn<GraphQl>(async (query, variables) => {
      if (queryKind(query) === "details") return detailsAnswer(variables, sized);
      if (failures-- > 0) throw new Error("GitHub answered HTTP 502");
      return page([ghPr()]);
    });
    const { cache, advance, at } = setup(gh, ["proj-plugins"]);
    const first = await settledRead(cache, "a");
    const goodAt = at();
    expect(first.repos[0]).toMatchObject({ fetchedAt: goodAt, error: null });
    expect(first.pullRequests.map((pr) => pr.number)).toEqual([68]);
    expect(calls(gh, "list")).toHaveLength(2);
    failures = 2;
    advance(IDLE_REFRESH_MS);
    const failed = await settledRead(cache, "a");
    expect(failed.repos[0]).toMatchObject({ fetchedAt: goodAt, error: "GitHub answered HTTP 502" });
    expect(failed.pullRequests.map((pr) => pr.number)).toEqual([68]);
    expect(calls(gh, "list")).toHaveLength(4);
  });

  it("keeps the last good list beside a failed refresh and retries on the next one", async () => {
    let failing = false;
    const gh = vi.fn<GraphQl>(async (query, variables) => {
      if (failing) throw new Error("GitHub answered HTTP 502");
      return queryKind(query) === "details" ? detailsAnswer(variables, sized) : page([ghPr()]);
    });
    const { cache, advance, at } = setup(gh, ["proj-plugins"]);
    await settledRead(cache, "a");
    const goodAt = at();
    failing = true;
    advance(IDLE_REFRESH_MS);
    const stale = await settledRead(cache, "a");
    // The details of a failed list aren't asked for: those of the last good one stand.
    expect(stale.repos).toEqual([{ repo: "erwinkn/bb-plugins", fetchedAt: goodAt, error: "GitHub answered HTTP 502", fetching: false, detailsFetchedAt: goodAt, detailsError: null }]);
    expect(stale.pullRequests.map((pr) => pr.number)).toEqual([68]);
    failing = false;
    advance(IDLE_REFRESH_MS);
    const again = await settledRead(cache, "a");
    // Nothing moved: the details read at goodAt stand.
    expect(again.repos[0]).toEqual({ repo: "erwinkn/bb-plugins", ...fresh(at()), detailsFetchedAt: goodAt });
  });

  it("reports a gh that is not signed in, then reads the account once it is", async () => {
    let signedIn = false;
    const gh = vi.fn<GraphQl>(async (query, variables) => {
      if (!signedIn) throw new Error("To get started with GitHub CLI, please run: gh auth login");
      return queryKind(query) === "details" ? detailsAnswer(variables, sized) : page([]);
    });
    const { cache, advance } = setup(gh, ["proj-plugins"]);
    const first = await settledRead(cache, "a");
    expect(first.login).toBeNull();
    expect(first.repos[0]).toMatchObject({ fetchedAt: null, error: expect.stringContaining("gh auth login") });
    expect(first.pullRequests).toEqual([]);
    signedIn = true;
    advance(10_000);
    const second = await settledRead(cache, "a", { refresh: true });
    expect(second.login).toBe("erwinkn");
    expect(second.repos[0]!.error).toBeNull();
  });

  it("looks up tracked PRs the open lists don't name, LOOKUP_LIMIT in one request, one pass at a time (W516)", async () => {
    const saved: [string, unknown][] = [];
    const tracked = Array.from({ length: LOOKUP_LIMIT + 5 }, (_, i) => `https://github.com/o/r/pull/${i + 1}`);
    let lookup: () => Promise<Record<string, unknown>> = async () => ({});
    const gh = vi.fn<GraphQl>(async (query, variables) => {
      const kind = queryKind(query);
      if (kind === "lookup") return lookup();
      return kind === "details" ? detailsAnswer(variables, sized) : page([ghPr()]);
    });
    const toLookUp = vi.fn((listed: ReadonlySet<string>, _at: number, limit: number) =>
      tracked.filter((url) => !listed.has(url) && !saved.some(([u]) => u === url)).slice(0, limit));
    const markOpen = vi.fn();
    const { cache, advance } = setup(gh, ["proj-plugins"], { prStates: { markOpen, toLookUp, save: (url, _at, result) => { saved.push([url, result]); } } });
    lookup = async () => ({
      p0: { state: "MERGED", mergedAt: "2026-10-01T00:00:00Z", closedAt: "2026-10-01T00:00:00Z" },
      p1: { state: "CLOSED", mergedAt: null, closedAt: "2026-10-02T00:00:00Z" },
      p2: null,
      p3: {},
    });
    await settledRead(cache, "a");
    await cache.lookupsSettled();
    expect(markOpen).toHaveBeenCalledWith(["https://github.com/erwinkn/bb-plugins/pull/68"], expect.any(Number));
    const [query, variables] = calls(gh, "lookup")[0]!;
    expect(query).toBe(prLookupQuery(LOOKUP_LIMIT));
    expect(Object.keys(variables)).toHaveLength(LOOKUP_LIMIT);
    expect(variables.u0).toBe(tracked[0]);
    expect(saved.slice(0, 4)).toEqual([
      [tracked[0], { state: "MERGED", mergedAt: Date.parse("2026-10-01T00:00:00Z"), closedAt: Date.parse("2026-10-01T00:00:00Z") }],
      [tracked[1], { state: "CLOSED", mergedAt: null, closedAt: Date.parse("2026-10-02T00:00:00Z") }],
      [tracked[2], { error: "not found on GitHub" }],
      [tracked[3], { error: "not a pull request" }],
    ]);
    expect(saved).toHaveLength(LOOKUP_LIMIT);
    // A failed request stamps each PR it asked for with the error; a pass runs one at a time.
    let release!: () => void;
    lookup = () => new Promise((_, reject) => { release = () => reject(new Error("GitHub answered HTTP 502")); });
    advance(IDLE_REFRESH_MS);
    await settledRead(cache, "a");
    advance(10_000);
    await settledRead(cache, "a", { refresh: true });
    expect(calls(gh, "lookup")).toHaveLength(2);
    release();
    await cache.lookupsSettled();
    expect(saved.slice(LOOKUP_LIMIT)).toEqual(tracked.slice(LOOKUP_LIMIT).map((url) => [url, { error: "GitHub answered HTTP 502" }]));
  });

  it("looks a member's remote up again after a failed project read, and serves the last one while it does", async () => {
    const gh = answers({});
    const { cache, project, advance } = setup(gh, ["proj-plugins"]);
    project.mockRejectedValueOnce(new Error("BB busy"));
    const first = await cache.read("a");
    expect(first.repos).toEqual([]);
    expect(first.skipped).toEqual([{ project: "proj-plugins", reason: "no GitHub origin remote" }]);
    const second = await cache.read("a");
    expect(second.repos.map((r) => r.repo)).toEqual(["erwinkn/bb-plugins"]);
    // Past its five minutes the last answer serves at once while BB is asked again.
    let answer!: (value: { name: string; gitRemoteUrl: string | null }) => void;
    project.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    advance(5 * 60_000);
    expect((await cache.read("a")).repos.map((r) => r.repo)).toEqual(["erwinkn/bb-plugins"]);
    answer({ name: "bb-plugins", gitRemoteUrl: "https://github.com/erwinkn/bb.git" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await cache.read("a")).repos.map((r) => r.repo)).toEqual(["erwinkn/bb"]);
  });
});
