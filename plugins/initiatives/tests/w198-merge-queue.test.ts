import { describe, expect, it, vi } from "vitest";
import {
  assignStages,
  attachWorkers,
  branchThreadId,
  classify,
  githubRepo,
  orderQueue,
  parseDetailsPage,
  parsePullRequests,
  githubStage,
  summarizeChecks,
} from "../lib/merge-queue";
import { PR_STAGES, blankPrRecord, type PrRecord } from "../lib/pr-stages";
import { groupPrs } from "../lib/pr-map";
import { MergeQueueCache, REFRESH_MS, type GhRunner, type MergeQueueSources } from "../lib/merge-queue-server";

/** One `gh pr list --json` entry, shaped like real output. */
const ghPr = (overrides: Record<string, unknown> = {}) => ({
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
  statusCheckRollup: [
    { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SKIPPED" },
    { __typename: "StatusContext", context: "ci/legacy", state: "SUCCESS" },
  ],
  ...overrides,
});
const parseOne = (overrides: Record<string, unknown> = {}) =>
  parsePullRequests("erwinkn/bb-plugins", JSON.stringify([ghPr(overrides)]))[0]!;

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
      discussionThreadId: null,
      stack: null,
      available: false,
      notes: { count: 0, recent: [], open: [] },
    });
  });

  it("rolls up check runs and status contexts", () => {
    expect(summarizeChecks([])).toEqual({ state: "none", passed: 0, failed: 0, pending: 0, total: 0 });
    expect(summarizeChecks([
      { __typename: "CheckRun", status: "IN_PROGRESS", conclusion: "" },
      { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "StatusContext", state: "PENDING" },
    ])).toEqual({ state: "pending", passed: 1, failed: 0, pending: 2, total: 3 });
    // One failure outranks pending checks.
    expect(summarizeChecks([
      { __typename: "CheckRun", status: "QUEUED", conclusion: "" },
      { __typename: "CheckRun", status: "COMPLETED", conclusion: "TIMED_OUT" },
      { __typename: "StatusContext", state: "ERROR" },
    ]).state).toBe("fail");
    expect(summarizeChecks(null).state).toBe("none");
  });

  it("drops malformed entries one by one and throws on non-list output", () => {
    const raw = JSON.stringify([ghPr(), null, { number: "7" }, ghPr({ number: 0 }), ghPr({ number: 70, url: "javascript:alert(1)" }), ghPr({ number: 71, title: "" })]);
    const parsed = parsePullRequests("erwinkn/bb-plugins", raw);
    expect(parsed.map((pr) => pr.number)).toEqual([68, 71]);
    expect(parsed[1]!.title).toBe("erwinkn/bb-plugins#71");
    expect(() => parsePullRequests("erwinkn/bb-plugins", '{"message":"Not Found"}')).toThrow(/list/);
    expect(() => parsePullRequests("erwinkn/bb-plugins", "not json")).toThrow();
  });
});

describe("merge-queue order", () => {
  it("classifies ready, waiting, needs fixes and drafts, with reasons", () => {
    expect(parseOne({ reviewDecision: "APPROVED" })).toMatchObject({ group: "ready", review: "approved" });
    expect(parseOne({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" })).toMatchObject({ group: "waiting", reasons: ["mergeability unknown"] });
    expect(parseOne({ reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED" })).toMatchObject({ group: "waiting", reasons: ["review required"] });
    expect(parseOne({ mergeStateStatus: "BEHIND" })).toMatchObject({ group: "waiting", reasons: ["behind base"] });
    expect(parseOne({ statusCheckRollup: [{ __typename: "CheckRun", status: "IN_PROGRESS" }] })).toMatchObject({ group: "waiting", reasons: ["1 check running"] });
    expect(parseOne({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" })).toMatchObject({ group: "fix", reasons: ["conflicts"] });
    expect(parseOne({
      reviewDecision: "CHANGES_REQUESTED",
      statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }, { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }],
    })).toMatchObject({ group: "fix", reasons: ["2 checks failing", "changes requested"] });
    // A draft is a draft whatever else is true, and keeps its reasons.
    expect(parseOne({ isDraft: true, mergeable: "CONFLICTING" })).toMatchObject({ group: "draft", reasons: ["conflicts"] });
    expect(classify({ draft: false, review: "none", mergeable: "mergeable", mergeState: "blocked", checks: summarizeChecks([]) }))
      .toEqual({ group: "waiting", reasons: ["blocked by branch rules"] });
  });

  it("guesses a stage from GitHub: drafts are worked on, approved green mergeable PRs are ready for the user", () => {
    expect(githubStage(parseOne({ isDraft: true, reviewDecision: "APPROVED" }))).toBe("working");
    expect(githubStage(parseOne({ reviewDecision: "APPROVED" }))).toBe("ready-for-erwin");
    expect(githubStage(parseOne({ reviewDecision: "APPROVED", statusCheckRollup: [] }))).toBe("ready-for-erwin");
    expect(githubStage(parseOne({ reviewDecision: "APPROVED", mergeable: "UNKNOWN" }))).toBe("ready-for-review");
    expect(githubStage(parseOne({ reviewDecision: "APPROVED", statusCheckRollup: [{ __typename: "CheckRun", status: "IN_PROGRESS" }] }))).toBe("ready-for-review");
    expect(githubStage(parseOne({ reviewDecision: "" }))).toBe("ready-for-review");
    expect(githubStage(parseOne({ mergeable: "CONFLICTING" }))).toBe("ready-for-review");
  });

  it("groups by stage, the coordinator's where recorded, oldest first within a stage", () => {
    const at = (day: number) => `2026-09-${String(day).padStart(2, "0")}T10:00:00Z`;
    const url = (n: number) => `https://github.com/erwinkn/bb/pull/${n}`;
    const prs = parsePullRequests("erwinkn/bb", JSON.stringify([
      ghPr({ number: 1, url: url(1), isDraft: true, createdAt: at(1) }),
      ghPr({ number: 2, url: url(2), mergeable: "CONFLICTING", createdAt: at(2) }),
      ghPr({ number: 3, url: url(3), reviewDecision: "APPROVED", createdAt: at(3) }),
      ghPr({ number: 4, url: url(4), createdAt: at(9) }),
      ghPr({ number: 5, url: url(5), createdAt: at(4) }),
      ghPr({ number: 6, url: url(6), isDraft: true, createdAt: at(5) }),
    ]));
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
    const prs = parsePullRequests("erwinkn/bb-plugins", JSON.stringify([
      ghPr({ number: 1, headRefName: "bb/w198-merge-queue-thr_5t6t6jjct3" }),
      ghPr({ number: 2, headRefName: "bb/w12-other-thr_unknown" }),
    ]));
    const labelled = attachWorkers(prs, new Map([["thr_5t6t6jjct3", "W198"]]));
    expect(labelled.map((pr) => pr.worker)).toEqual([{ ref: "W198", threadId: "thr_5t6t6jjct3", assignment: null, role: null, source: "branch" }, null]);
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
  const setup = (gh: GhRunner, members = ["proj-plugins", "proj-fork", "proj-local"]) => {
    let now = 1_000_000;
    const project = vi.fn(async (id: string) => remotes[id]!);
    const fetched = vi.fn();
    const cache = new MergeQueueCache(
      sources({ memberProjectIds: () => members, project, workers: () => new Map([["thr_abc", "W7"]]) }),
      gh,
      () => now,
      fetched,
    );
    return { cache, project, fetched, advance: (ms: number) => { now += ms; }, at: () => now };
  };
  /** A read, then the one after the fetch it started settles: what a client sees once told. */
  const settledRead = async (cache: MergeQueueCache, id: string, options: { refresh?: boolean } = {}) => {
    await cache.read(id, options);
    await cache.settled();
    return cache.read(id);
  };
  const page = (nodes: unknown[], next: string | null = null) =>
    JSON.stringify({ data: { search: { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes } } });
  const answers = (lists: Record<string, unknown[]>) =>
    vi.fn<GhRunner>(async (args) => {
      if (args[1] === "user") return "erwinkn\n";
      if (args[1] === "graphql") return page([]);
      const repo = args[args.indexOf("--repo") + 1]!;
      return JSON.stringify(lists[repo] ?? []);
    });
  const fresh = (at: number) => ({ fetchedAt: at, error: null, fetching: false, detailsFetchedAt: at, detailsError: null });

  it("answers at once from the cache and fetches behind it, never waiting on gh (D441)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const gh = vi.fn<GhRunner>(async (args) => {
      await gate;
      if (args[1] === "user") return "erwinkn";
      return args[1] === "graphql" ? page([]) : JSON.stringify([ghPr()]);
    });
    const { cache, fetched } = setup(gh, ["proj-plugins"]);
    // gh hangs: the read still answers, with the first fetch running.
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

  it("reads each member's GitHub repo once per two minutes with one gh list per repo", async () => {
    const gh = answers({
      "erwinkn/bb-plugins": [ghPr({ headRefName: "bb/w7-x-thr_abc" })],
      "erwinkn/bb": [ghPr({ number: 9, url: "https://github.com/erwinkn/bb/pull/9", isDraft: true })],
    });
    const { cache, advance, at } = setup(gh);
    const first = await settledRead(cache, "init-1");
    expect(first.login).toBe("erwinkn");
    expect(first.repos).toEqual([
      { repo: "erwinkn/bb-plugins", ...fresh(at()) },
      { repo: "erwinkn/bb", ...fresh(at()) },
    ]);
    expect(first.skipped).toEqual([{ project: "scratch", reason: "no GitHub origin remote" }]);
    expect(first.pullRequests.map((pr) => [pr.repo, pr.number, pr.stage, pr.worker?.ref ?? null])).toEqual([
      ["erwinkn/bb-plugins", 68, "ready-for-review", "W7"],
      ["erwinkn/bb", 9, "working", null],
    ]);
    // The account resolves once; each repo is one batched list call, with its details query beside it.
    expect(gh.mock.calls.filter(([args]) => args[0] === "api" && args[1] === "user")).toHaveLength(1);
    const list = gh.mock.calls.find(([args]) => args[0] === "pr")![0];
    expect(list).toEqual(expect.arrayContaining(["--repo", "erwinkn/bb-plugins", "--author", "erwinkn", "--state", "open", "--json"]));
    const details = gh.mock.calls.find(([args]) => args[1] === "graphql")![0];
    expect(details).toEqual(expect.arrayContaining(["q=repo:erwinkn/bb-plugins is:pr is:open author:erwinkn"]));
    expect(details).not.toContain("--paginate");
    expect(gh).toHaveBeenCalledTimes(5);

    // Within two minutes reads come from the cache.
    advance(REFRESH_MS - 1);
    await settledRead(cache, "init-1");
    expect(gh).toHaveBeenCalledTimes(5);
    advance(1);
    await settledRead(cache, "init-1");
    expect(gh).toHaveBeenCalledTimes(9);
  });

  it("treats owner/repo case variants as one repository, shown in the remote's casing", async () => {
    const gh = answers({ "ErwinKN/BB-Plugins": [ghPr({ url: "https://github.com/ErwinKN/BB-Plugins/pull/68" })] });
    const variants: Record<string, { name: string; gitRemoteUrl: string }> = {
      upper: { name: "bb-plugins", gitRemoteUrl: "https://github.com/ErwinKN/BB-Plugins.git" },
      lower: { name: "bb-plugins-mirror", gitRemoteUrl: "git@github.com:erwinkn/bb-plugins.git" },
    };
    const cache = new MergeQueueCache(sources({ memberProjectIds: () => ["upper", "lower"], project: async (id) => variants[id]! }), gh);
    const q = await settledRead(cache, "a");
    expect(q.repos.map((r) => r.repo)).toEqual(["ErwinKN/BB-Plugins"]);
    expect(q.pullRequests.map((pr) => [pr.repo, pr.number])).toEqual([["ErwinKN/BB-Plugins", 68]]);
    // One account lookup and one list (and details) call: the variants share a cache entry.
    expect(gh).toHaveBeenCalledTimes(3);
  });

  it("applies the coordinator's recorded stages and the notes on every read", async () => {
    const gh = answers({ "erwinkn/bb-plugins": [ghPr()] });
    const stages = new Map<string, PrRecord>();
    const url = "https://github.com/erwinkn/bb-plugins/pull/68";
    const notes = new Map([[url, { count: 1, recent: [{ n: 1, at: 5, author: "W7", kind: "note" as const, text: "Rebased", link: "A3", answered: null }], open: [] }]]);
    const cache = new MergeQueueCache(sources({ prRecords: () => stages, notes: () => notes }), gh);
    expect((await settledRead(cache, "a")).pullRequests.map((pr) => [pr.stage, pr.stageSource, pr.notes.count])).toEqual([["ready-for-review", "github", 1]]);
    stages.set(url, { ...blankPrRecord(url, 5), stage: "in-review", setAt: 5 });
    // A stage change needs no GitHub fetch: the cached list is staged again.
    const q = await cache.read("a");
    expect(q.pullRequests.map((pr) => [pr.stage, pr.stageSource])).toEqual([["in-review", "coordinator"]]);
    expect(q.stages.map((s) => s.id)).toEqual(PR_STAGES.map((s) => s.id));
    expect(gh).toHaveBeenCalledTimes(3);
  });

  it("runs one fetch per repository for concurrent reads and honors a manual refresh", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const gh = vi.fn<GhRunner>(async (args) => {
      if (args[1] === "user") return "erwinkn";
      await gate;
      return args[1] === "graphql" ? page([]) : JSON.stringify([ghPr()]);
    });
    const { cache, advance } = setup(gh, ["proj-plugins"]);
    await Promise.all([cache.read("a"), cache.read("b"), cache.read("a", { refresh: true })]);
    release();
    await cache.settled();
    expect((await cache.read("b")).pullRequests).toHaveLength(1);
    expect(gh).toHaveBeenCalledTimes(3);
    // A refresh right after a fetch reuses it; ten seconds later it reads again.
    await settledRead(cache, "a", { refresh: true });
    expect(gh).toHaveBeenCalledTimes(3);
    advance(10_000);
    await settledRead(cache, "a", { refresh: true });
    expect(gh).toHaveBeenCalledTimes(5);
  });

  it("keeps the repository's fetch in flight until both calls settle, so no second details query overlaps (W229)", async () => {
    let releaseDetails!: () => void;
    const detailsGate = new Promise<void>((resolve) => { releaseDetails = resolve; });
    let detailsRunning = 0;
    let most = 0;
    const gh = vi.fn<GhRunner>(async (args) => {
      if (args[1] === "user") return "erwinkn";
      if (args[1] === "graphql") {
        most = Math.max(most, ++detailsRunning);
        await detailsGate;
        detailsRunning--;
        return page([]);
      }
      throw new Error("HTTP 502");
    });
    const { cache, advance } = setup(gh, ["proj-plugins"]);
    await cache.read("a");
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The list failed at once; the details still run, so a forced refresh starts nothing.
    advance(10_000);
    const during = await cache.read("a", { refresh: true });
    expect(during.repos[0]!.fetching).toBe(true);
    releaseDetails();
    await cache.settled();
    expect(most).toBe(1);
    expect(gh.mock.calls.filter(([args]) => args[1] === "graphql")).toHaveLength(1);
  });

  it("adds each PR's size and reviewers; a failed details query keeps sizes, withholds reviewers and says so (W229)", async () => {
    let details: string | Error = page([
      { number: 68, additions: 908, deletions: 386, changedFiles: 48, commits: { totalCount: 5 },
        latestReviews: { nodes: [{ author: { login: "coderabbitai" }, state: "COMMENTED" }, { author: { login: "alice" }, state: "APPROVED" }] },
        reviewRequests: { nodes: [{ requestedReviewer: { login: "bob" } }, { requestedReviewer: { name: "core" } }, { requestedReviewer: { login: "alice" } }] } },
      "not a PR",
    ]);
    const gh = vi.fn<GhRunner>(async (args) => {
      if (args[1] === "user") return "erwinkn";
      if (args[1] === "graphql") { if (details instanceof Error) throw details; return details; }
      return JSON.stringify([ghPr(), ghPr({ number: 69, url: "https://github.com/erwinkn/bb-plugins/pull/69" })]);
    });
    const { cache, advance, at } = setup(gh, ["proj-plugins"]);
    const first = await settledRead(cache, "a");
    const loadedAt = at();
    expect(first.pullRequests.map((pr) => [pr.number, pr.size, pr.reviewers])).toEqual([
      [68, { additions: 908, deletions: 386, files: 48, commits: 5 }, [
        { login: "coderabbitai", state: "commented" }, { login: "alice", state: "approved" }, { login: "bob", state: "requested" }, { login: "core", state: "requested" },
      ]],
      [69, null, []],
    ]);
    details = new Error("HTTP 502");
    advance(REFRESH_MS);
    const second = await settledRead(cache, "a");
    expect(second.repos[0]).toMatchObject({ fetchedAt: at(), error: null, detailsFetchedAt: loadedAt, detailsError: "HTTP 502" });
    expect(second.pullRequests[0]!.size).toEqual({ additions: 908, deletions: 386, files: 48, commits: 5 });
    // GitHub may have a newer review than the cached "approved": no reviewer states until they load again.
    expect(second.pullRequests[0]!.reviewers).toEqual([]);
  });

  it("keeps a successful list when the details answer has a malformed shape (W229)", async () => {
    const gh = vi.fn<GhRunner>(async (args) => {
      if (args[1] === "user") return "erwinkn";
      if (args[1] === "graphql") return args.some((a) => a.startsWith("endCursor=")) ? "{}" : page([{ number: 68, latestReviews: { nodes: {} }, reviewRequests: null }], "c1");
      return JSON.stringify([ghPr()]);
    });
    const { cache } = setup(gh, ["proj-plugins"]);
    const q = await settledRead(cache, "a");
    expect(q.pullRequests.map((pr) => pr.number)).toEqual([68]);
    expect(q.repos[0]).toMatchObject({ error: null, detailsError: "the details query returned no search results" });
    expect(parseDetailsPage(page([{ number: 68, additions: 3, latestReviews: { nodes: {} } }])).details.get(68)).toEqual({
      size: { additions: 3, deletions: 0, files: 0, commits: 0 }, reviewers: [],
    });
  });

  it("pages the details query no further than the list's 200 PRs (W229)", async () => {
    let pages = 0;
    const gh = vi.fn<GhRunner>(async (args) => {
      if (args[1] === "user") return "erwinkn";
      if (args[1] === "graphql") return page([{ number: ++pages }], `cursor-${pages}`);
      return "[]";
    });
    const { cache } = setup(gh, ["proj-plugins"]);
    await settledRead(cache, "a");
    expect(pages).toBe(4);
    const cursors = gh.mock.calls.filter(([args]) => args[1] === "graphql").map(([args]) => args.find((a) => a.startsWith("endCursor=")) ?? null);
    expect(cursors).toEqual([null, "endCursor=cursor-1", "endCursor=cursor-2", "endCursor=cursor-3"]);
  });

  it("keeps the last good list beside a failed refresh and retries on the next one", async () => {
    let failing = false;
    const gh = vi.fn<GhRunner>(async (args) => {
      if (args[1] === "user") return "erwinkn";
      if (failing) throw new Error("HTTP 502: Server Error");
      return args[1] === "graphql" ? page([]) : JSON.stringify([ghPr()]);
    });
    const { cache, advance, at } = setup(gh, ["proj-plugins"]);
    await settledRead(cache, "a");
    const goodAt = at();
    failing = true;
    advance(REFRESH_MS);
    const stale = await settledRead(cache, "a");
    expect(stale.repos).toEqual([{ repo: "erwinkn/bb-plugins", fetchedAt: goodAt, error: "HTTP 502: Server Error", fetching: false, detailsFetchedAt: goodAt, detailsError: "HTTP 502: Server Error" }]);
    expect(stale.pullRequests.map((pr) => pr.number)).toEqual([68]);
    failing = false;
    advance(REFRESH_MS);
    const again = await settledRead(cache, "a");
    expect(again.repos[0]).toEqual({ repo: "erwinkn/bb-plugins", ...fresh(at()) });
  });

  it("reports a gh that is not signed in, then resolves the account once it is", async () => {
    let signedIn = false;
    const gh = vi.fn<GhRunner>(async (args) => {
      if (args[1] === "user") {
        if (!signedIn) throw new Error("To get started with GitHub CLI, please run: gh auth login");
        return "erwinkn";
      }
      return args[1] === "graphql" ? page([]) : "[]";
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
