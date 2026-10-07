import { describe, expect, it, vi } from "vitest";
import {
  assignStages,
  attachWorkers,
  branchThreadId,
  classify,
  githubRepo,
  groupQueue,
  orderQueue,
  parsePullRequests,
  githubStage,
  summarizeChecks,
} from "../lib/merge-queue";
import { PR_STAGES, type PrStageRecord } from "../lib/pr-stages";
import { MergeQueueCache, REFRESH_MS, type GhRunner } from "../lib/merge-queue-server";

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
    const record = (n: number, stage: PrStageRecord["stage"], note: string | null = null): [string, PrStageRecord] =>
      [url(n), { url: url(n), stage, note, setAt: 1000 + n }];
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
    expect(groupQueue(orderQueue(staged)).map((g) => [g.label, g.pullRequests.map((pr) => pr.number)])).toEqual([
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
    expect(labelled.map((pr) => pr.worker)).toEqual([{ ref: "W198", threadId: "thr_5t6t6jjct3" }, null]);
  });
});

describe("MergeQueueCache", () => {
  const remotes: Record<string, { name: string; gitRemoteUrl: string | null }> = {
    "proj-plugins": { name: "bb-plugins", gitRemoteUrl: "https://github.com/erwinkn/bb-plugins.git" },
    "proj-fork": { name: "bb-fork", gitRemoteUrl: "git@github.com:erwinkn/bb.git" },
    "proj-local": { name: "scratch", gitRemoteUrl: null },
  };
  const setup = (gh: GhRunner, members = ["proj-plugins", "proj-fork", "proj-local"]) => {
    let now = 1_000_000;
    const project = vi.fn(async (id: string) => remotes[id]!);
    const cache = new MergeQueueCache(
      { memberProjectIds: () => members, project, workers: () => new Map([["thr_abc", "W7"]]), prStages: () => new Map() },
      gh,
      () => now,
    );
    return { cache, project, advance: (ms: number) => { now += ms; }, at: () => now };
  };
  const answers = (lists: Record<string, unknown[]>) =>
    vi.fn<GhRunner>(async (args) => {
      if (args[0] === "api") return "erwinkn\n";
      const repo = args[args.indexOf("--repo") + 1]!;
      return JSON.stringify(lists[repo] ?? []);
    });

  it("reads each member's GitHub repo once per two minutes with one gh call per repo", async () => {
    const gh = answers({
      "erwinkn/bb-plugins": [ghPr({ headRefName: "bb/w7-x-thr_abc" })],
      "erwinkn/bb": [ghPr({ number: 9, url: "https://github.com/erwinkn/bb/pull/9", isDraft: true })],
    });
    const { cache, advance, at } = setup(gh);
    const first = await cache.read("init-1");
    expect(first.login).toBe("erwinkn");
    expect(first.repos).toEqual([
      { repo: "erwinkn/bb-plugins", fetchedAt: at(), error: null },
      { repo: "erwinkn/bb", fetchedAt: at(), error: null },
    ]);
    expect(first.skipped).toEqual([{ project: "scratch", reason: "no GitHub origin remote" }]);
    expect(first.pullRequests.map((pr) => [pr.repo, pr.number, pr.stage, pr.worker?.ref ?? null])).toEqual([
      ["erwinkn/bb-plugins", 68, "ready-for-review", "W7"],
      ["erwinkn/bb", 9, "working", null],
    ]);
    // The account resolves once; each repo is one batched list call.
    expect(gh.mock.calls.filter(([args]) => args[0] === "api")).toHaveLength(1);
    const list = gh.mock.calls.find(([args]) => args[0] === "pr")![0];
    expect(list).toEqual(expect.arrayContaining(["--repo", "erwinkn/bb-plugins", "--author", "erwinkn", "--state", "open", "--json"]));
    expect(gh).toHaveBeenCalledTimes(3);

    // Within two minutes reads come from the cache.
    advance(REFRESH_MS - 1);
    await cache.read("init-1");
    expect(gh).toHaveBeenCalledTimes(3);
    advance(1);
    await cache.read("init-1");
    expect(gh).toHaveBeenCalledTimes(5);
  });

  it("treats owner/repo case variants as one repository, shown in the remote's casing", async () => {
    const gh = answers({ "ErwinKN/BB-Plugins": [ghPr({ url: "https://github.com/ErwinKN/BB-Plugins/pull/68" })] });
    const variants: Record<string, { name: string; gitRemoteUrl: string }> = {
      upper: { name: "bb-plugins", gitRemoteUrl: "https://github.com/ErwinKN/BB-Plugins.git" },
      lower: { name: "bb-plugins-mirror", gitRemoteUrl: "git@github.com:erwinkn/bb-plugins.git" },
    };
    const cache = new MergeQueueCache({ memberProjectIds: () => ["upper", "lower"], project: async (id) => variants[id]!, workers: () => new Map(), prStages: () => new Map() }, gh);
    const q = await cache.read("a");
    expect(q.repos.map((r) => r.repo)).toEqual(["ErwinKN/BB-Plugins"]);
    expect(q.pullRequests.map((pr) => [pr.repo, pr.number])).toEqual([["ErwinKN/BB-Plugins", 68]]);
    // One account lookup and one list call: the variants share a cache entry.
    expect(gh).toHaveBeenCalledTimes(2);
  });

  it("applies the coordinator's recorded stages on every read", async () => {
    const gh = answers({ "erwinkn/bb-plugins": [ghPr()] });
    const stages = new Map<string, PrStageRecord>();
    const cache = new MergeQueueCache({
      memberProjectIds: () => ["proj-plugins"],
      project: async (id) => remotes[id]!,
      workers: () => new Map(),
      prStages: () => stages,
    }, gh);
    expect((await cache.read("a")).pullRequests.map((pr) => [pr.stage, pr.stageSource])).toEqual([["ready-for-review", "github"]]);
    stages.set("https://github.com/erwinkn/bb-plugins/pull/68", { url: "https://github.com/erwinkn/bb-plugins/pull/68", stage: "in-review", note: null, setAt: 5 });
    // A stage change needs no GitHub fetch: the cached list is staged again.
    const q = await cache.read("a");
    expect(q.pullRequests.map((pr) => [pr.stage, pr.stageSource])).toEqual([["in-review", "coordinator"]]);
    expect(q.stages.map((s) => s.id)).toEqual(PR_STAGES.map((s) => s.id));
    expect(gh).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight fetch between concurrent reads and honors a manual refresh", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const gh = vi.fn<GhRunner>(async (args) => {
      if (args[0] === "api") return "erwinkn";
      await gate;
      return JSON.stringify([ghPr()]);
    });
    const { cache, advance } = setup(gh, ["proj-plugins"]);
    const reads = [cache.read("a"), cache.read("b")];
    release();
    const [a, b] = await Promise.all(reads);
    expect(a.pullRequests).toHaveLength(1);
    expect(b.pullRequests).toHaveLength(1);
    expect(gh).toHaveBeenCalledTimes(2);
    // A refresh right after a fetch reuses it; ten seconds later it reads again.
    await cache.read("a", { refresh: true });
    expect(gh).toHaveBeenCalledTimes(2);
    advance(10_000);
    await cache.read("a", { refresh: true });
    expect(gh).toHaveBeenCalledTimes(3);
  });

  it("keeps the last good list beside a failed refresh and retries on the next one", async () => {
    let failing = false;
    const gh = vi.fn<GhRunner>(async (args) => {
      if (args[0] === "api") return "erwinkn";
      if (failing) throw new Error("HTTP 502: Server Error");
      return JSON.stringify([ghPr()]);
    });
    const { cache, advance, at } = setup(gh, ["proj-plugins"]);
    await cache.read("a");
    const goodAt = at();
    failing = true;
    advance(REFRESH_MS);
    const stale = await cache.read("a");
    expect(stale.repos).toEqual([{ repo: "erwinkn/bb-plugins", fetchedAt: goodAt, error: "HTTP 502: Server Error" }]);
    expect(stale.pullRequests.map((pr) => pr.number)).toEqual([68]);
    failing = false;
    advance(REFRESH_MS);
    const fresh = await cache.read("a");
    expect(fresh.repos[0]).toEqual({ repo: "erwinkn/bb-plugins", fetchedAt: at(), error: null });
  });

  it("reports a gh that is not signed in, then resolves the account once it is", async () => {
    let signedIn = false;
    const gh = vi.fn<GhRunner>(async (args) => {
      if (args[0] === "api") {
        if (!signedIn) throw new Error("To get started with GitHub CLI, please run: gh auth login");
        return "erwinkn";
      }
      return "[]";
    });
    const { cache, advance } = setup(gh, ["proj-plugins"]);
    const first = await cache.read("a");
    expect(first.login).toBeNull();
    expect(first.repos[0]).toMatchObject({ fetchedAt: null, error: expect.stringContaining("gh auth login") });
    expect(first.pullRequests).toEqual([]);
    signedIn = true;
    advance(10_000);
    const second = await cache.read("a", { refresh: true });
    expect(second.login).toBe("erwinkn");
    expect(second.repos[0]!.error).toBeNull();
  });

  it("looks a member's remote up again after a failed project read", async () => {
    const gh = answers({});
    const { cache, project } = setup(gh, ["proj-plugins"]);
    project.mockRejectedValueOnce(new Error("BB busy"));
    const first = await cache.read("a");
    expect(first.repos).toEqual([]);
    expect(first.skipped).toEqual([{ project: "proj-plugins", reason: "no GitHub origin remote" }]);
    const second = await cache.read("a");
    expect(second.repos.map((r) => r.repo)).toEqual(["erwinkn/bb-plugins"]);
  });
});
