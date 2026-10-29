// W548, W554: PR watches. Each PR an agent watches (initiative_pr_watch) is diffed against the
// last state the watcher saw, from the baseline its watch call read; a change wakes the thread that
// watched it (or its coordinator when that thread can't take it), once, across reloads too.
import { describe, expect, it, vi } from "vitest";
import { memoryStore } from "./helpers";
import { projectFixture } from "./fake-native";
import { rollup, searchPage, withId } from "./gh-fixtures";
import { GH_LIST_QUERY, parsePullRequests } from "../lib/merge-queue";
import { DETAILS_CONCURRENCY, IDLE_REFRESH_MS, MergeQueueCache, REFRESH_MS, type GraphQl } from "../lib/merge-queue-server";
import { PrOwners, ledgerThreads } from "../lib/pr-owners";
import { AssignedPrs } from "../lib/pr-records";
import {
  COMMENT_WAKE_CAP, NOT_A_MERGE, NO_CHECKS_MS, PR_ID_QUERY, PrWatcher, UNLISTED_READ_MS, WATCH_PAGE, WatchLedger, baselineState, diffWatch, parseWatch, readPrWatch,
  watchAnswer, type WatchFacts, type WatchState,
} from "../lib/pr-watch";
import type { Sdk } from "../lib/bb";
import { WATCH_RESYNC_MS, CHECKS_PAST_100, CHECKS_PAGE_QUERY, WAKE_REFUSALS } from "../lib/pr-watch";
import { DEFAULT_WORKER_INSTRUCTIONS, PREVIOUS_DEFAULTS } from "../lib/guidance";
import { MAX_GUIDANCE_CHARACTERS } from "../lib/settings";

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 28, 12);

// The diff ------------------------------------------------------------------------

const facts = (over: Partial<WatchFacts> = {}): WatchFacts => ({
  state: "OPEN", head: "aaa", mergeable: "mergeable", createdAt: T0 - 60 * MINUTE,
  checks: [{ name: "tests", outcome: "passed", required: false }, { name: "lint", outcome: "pending", required: false }],
  comments: [], ...over,
});
const ctx = (over: Partial<Parameters<typeof diffWatch>[2]> = {}) => ({ now: T0, login: "erwinkn", repoHasChecks: true, fingerprint: "f1", ...over });
/** The state a watch call leaves for `f`. */
const base = (f = facts()) => baselineState(f, T0, "f1");
const kinds = (r: { changes: { kind: string }[] }) => r.changes.map((c) => c.kind);

describe("W548 diffWatch", () => {
  it("takes the PR as the watch call read it as a baseline: its state then wakes nobody", () => {
    const failing = facts({ mergeable: "conflicting", checks: [{ name: "tests", outcome: "failed", required: false }], comments: [{ url: "u", at: T0 - 20 * MINUTE, author: "coderabbitai", bot: true, review: null }] });
    const state = baselineState(failing, T0, "f1");
    expect(state).toMatchObject({ head: "aaa", failing: ["tests"], mergeable: "conflicting", seenUntil: T0 - 20 * MINUTE, pushedAt: null, noChecksDone: true, readAt: T0, ended: null });
    expect(diffWatch(state, failing, ctx({ now: T0 + MINUTE })).changes).toEqual([]);
  });

  it("counts a head without any check at the watch as pushed then: no check 15 min later wakes", () => {
    const state = baselineState(facts({ checks: [] }), T0, "f1");
    expect(state).toMatchObject({ pushedAt: T0, noChecksDone: false });
    expect(kinds(diffWatch(state, facts({ checks: [] }), ctx({ now: T0 + NO_CHECKS_MS })))).toEqual(["no-checks"]);
  });

  it("names only newly failing checks on the same head, and every failing one after a push", () => {
    const prev = base(facts({ checks: [{ name: "tests", outcome: "failed", required: false }, { name: "lint", outcome: "pending", required: false }] }));
    const both = facts({ checks: [{ name: "tests", outcome: "failed", required: false }, { name: "lint", outcome: "failed", required: false }] });
    const same = diffWatch(prev, both, ctx());
    expect(same.changes).toEqual([{ kind: "checks-failed", checks: ["lint"] }]);
    // Read again unchanged: nothing.
    expect(diffWatch(same.state, both, ctx()).changes).toEqual([]);
    // A push that still fails both: both are news on the new head.
    const pushed = diffWatch(same.state, { ...both, head: "bbb" }, ctx());
    expect(pushed.changes).toEqual([{ kind: "checks-failed", checks: ["lint", "tests"] }]);
  });

  it("wakes once when the required checks pass, or every check where none is required", () => {
    const prev = base(facts({ checks: [{ name: "tests", outcome: "pending", required: true }, { name: "e2e", outcome: "pending", required: false }] }));
    const r = diffWatch(prev, facts({ checks: [{ name: "tests", outcome: "passed", required: true }, { name: "e2e", outcome: "failed", required: false }] }), ctx());
    expect(r.changes).toEqual([{ kind: "checks-failed", checks: ["e2e"] }, { kind: "checks-passed", checks: ["tests"], required: true }]);
    expect(diffWatch(r.state, facts({ checks: [{ name: "tests", outcome: "passed", required: true }, { name: "e2e", outcome: "failed", required: false }] }), ctx()).changes).toEqual([]);
    // No required check: every check gates.
    const all = diffWatch(base(), facts({ checks: [{ name: "tests", outcome: "passed", required: false }, { name: "lint", outcome: "passed", required: false }] }), ctx());
    expect(all.changes).toEqual([{ kind: "checks-passed", checks: ["lint", "tests"], required: false }]);
  });

  it("wakes on comments and reviews by bots and other people since the last pass, never the gh account's own", () => {
    const prev = base(facts({ comments: [{ url: "old", at: T0 - 30 * MINUTE, author: "YoungMoh", bot: false, review: null }] }));
    const comments = [
      { url: "old", at: T0 - 30 * MINUTE, author: "YoungMoh", bot: false, review: null },
      { url: "mine", at: T0 - 2 * MINUTE, author: "ErwinKN", bot: false, review: "commented" },
      { url: "bot", at: T0 - MINUTE, author: "coderabbitai", bot: true, review: "changes_requested" },
    ];
    const r = diffWatch(prev, facts({ comments }), ctx());
    expect(r.changes).toEqual([{ kind: "new-comments", comments: [comments[2]] }]);
    expect(r.state.seenUntil).toBe(T0 - MINUTE);
    // The account not known yet: comments wait for a pass that knows it.
    const unknown = diffWatch(prev, facts({ comments }), ctx({ login: null }));
    expect(unknown.changes).toEqual([]);
    expect(unknown.state.seenUntil).toBe(prev.seenUntil);
  });

  it(`stops comment wakes after ${COMMENT_WAKE_CAP} comment-only wakes in a row; checks, conflict or push news resets it`, () => {
    let state = base();
    let at = T0 - 9 * MINUTE;
    const comment = () => facts({ comments: [{ url: `c${at}`, at: ++at, author: "coderabbitai", bot: true, review: null }] });
    for (let i = 1; i <= COMMENT_WAKE_CAP; i++) {
      const r = diffWatch(state, comment(), ctx());
      expect(kinds(r)).toEqual(["new-comments"]);
      state = r.state;
    }
    expect(state.commentWakes).toBe(COMMENT_WAKE_CAP);
    const capped = diffWatch(state, comment(), ctx());
    expect(capped).toMatchObject({ changes: [], capped: true });
    // A failing check resets the count and wakes with the comment.
    const reset = diffWatch(capped.state, { ...comment(), checks: [{ name: "tests", outcome: "failed", required: false }] }, ctx());
    expect(kinds(reset)).toEqual(["checks-failed", "new-comments"]);
    expect(reset.state.commentWakes).toBe(0);
    // A push resets it too.
    const pushedState = { ...capped.state, commentWakes: COMMENT_WAKE_CAP };
    const pushed = diffWatch(pushedState, { ...comment(), head: "bbb" }, ctx());
    expect(kinds(pushed)).toContain("new-comments");
    expect(pushed.state.commentWakes).toBe(1);
  });

  it("wakes once on a conflict, not again while it stays, nor for GitHub's unknown", () => {
    const prev = base();
    const r = diffWatch(prev, facts({ mergeable: "conflicting" }), ctx());
    expect(kinds(r)).toEqual(["conflicting"]);
    expect(diffWatch(r.state, facts({ mergeable: "unknown" }), ctx()).changes).toEqual([]);
    expect(diffWatch(r.state, facts({ mergeable: "conflicting" }), ctx()).changes).toEqual([]);
    const fixed = diffWatch(r.state, facts({ mergeable: "mergeable" }), ctx()).state;
    expect(kinds(diffWatch(fixed, facts({ mergeable: "conflicting" }), ctx()))).toEqual(["conflicting"]);
  });

  it(`wakes when no check reported ${NO_CHECKS_MS / MINUTE} min after a push, once, only where the repository has checks`, () => {
    const prev = base();
    const quiet = facts({ head: "bbb", checks: [] });
    const pushed = diffWatch(prev, quiet, ctx());
    expect(pushed.changes).toEqual([]);
    expect(pushed.state.pushedAt).toBe(T0);
    expect(diffWatch(pushed.state, quiet, ctx({ now: T0 + NO_CHECKS_MS - 1 })).changes).toEqual([]);
    const late = diffWatch(pushed.state, quiet, ctx({ now: T0 + NO_CHECKS_MS }));
    expect(kinds(late)).toEqual(["no-checks"]);
    expect(diffWatch(late.state, quiet, ctx({ now: T0 + 2 * NO_CHECKS_MS })).changes).toEqual([]);
    // A repository without CI never wakes; checks that report in time never do either.
    expect(diffWatch(pushed.state, quiet, ctx({ now: T0 + NO_CHECKS_MS, repoHasChecks: false })).changes).toEqual([]);
    const reported = diffWatch(pushed.state, facts({ head: "bbb", checks: [{ name: "tests", outcome: "pending", required: false }] }), ctx({ now: T0 + MINUTE })).state;
    expect(diffWatch(reported, quiet, ctx({ now: T0 + NO_CHECKS_MS })).changes).toEqual([]);
  });

  it("ends a merged or closed PR's watch; neither wakes", () => {
    for (const state of ["MERGED", "CLOSED"] as const) {
      const ended = diffWatch(base(), facts({ state, checks: [{ name: "tests", outcome: "failed", required: false }] }), ctx());
      expect(ended).toMatchObject({ changes: [], state: { ended: state } });
    }
  });

  it("takes every fact of a wake from its one watch read: a conflict the list saw on another head is no news", () => {
    // The watch read sees head B, mergeable, with its own failing check; nothing of the list's head A (conflicting) enters.
    const r = diffWatch(base(), facts({ head: "bbb", mergeable: "mergeable", checks: [{ name: "b-only", outcome: "failed", required: false }] }), ctx({ fingerprint: "aaa|conflicting" }));
    expect(r.changes).toEqual([{ kind: "checks-failed", checks: ["b-only"] }]);
    expect(r.state).toMatchObject({ head: "bbb", mergeable: "mergeable", failing: ["b-only"] });
  });
});

describe("W548 parseWatch", () => {
  it("reads checks (required or not), comments and reviews as GitHub answers them", () => {
    const parsed = parseWatch({
      id: "PR_1", number: 4824, state: "OPEN", headRefOid: "abc",
      commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
        { __typename: "CheckRun", name: "tests", status: "COMPLETED", conclusion: "FAILURE", isRequired: true },
        { __typename: "CheckRun", name: "check", status: "IN_PROGRESS", conclusion: null, isRequired: false },
        { __typename: "StatusContext", context: "CodeRabbit", state: "SUCCESS", isRequired: false },
      ] } } } }] },
      comments: { nodes: [{ url: "https://c/1", createdAt: "2026-10-28T12:45:54Z", author: { __typename: "Bot", login: "coderabbitai" } }] },
      reviews: { nodes: [{ url: "https://r/1", submittedAt: "2026-10-28T12:40:00Z", state: "CHANGES_REQUESTED", author: { __typename: "User", login: "YoungMoh" } }, { url: "https://r/2", submittedAt: null, state: "PENDING", author: null }] },
    });
    expect(parsed).toEqual({
      state: "OPEN", head: "abc", mergeable: "unknown", createdAt: 0,
      checks: [{ name: "tests", outcome: "failed", required: true }, { name: "check", outcome: "pending", required: false }, { name: "CodeRabbit", outcome: "passed", required: false }],
      comments: [
        { url: "https://r/1", at: Date.parse("2026-10-28T12:40:00Z"), author: "YoungMoh", bot: false, review: "changes_requested" },
        { url: "https://c/1", at: Date.parse("2026-10-28T12:45:54Z"), author: "coderabbitai", bot: true, review: null },
      ],
    });
    expect(parseWatch(null)).toBeNull();
    expect(parseWatch({ state: "OPEN" })).toBeNull();
  });

  it("reads the list's head SHA and node id", () => {
    const [pr] = parsePullRequests("eq/market", [{ id: "PR_9", number: 9, url: "https://github.com/eq/market/pull/9", headRefName: "x", headRefOid: "deadbeef" }]);
    expect(pr).toMatchObject({ headOid: "deadbeef", nodeId: "PR_9" });
    expect(GH_LIST_QUERY).toContain("headRefOid");
  });
});

// The watcher, over the real cache and a fake GitHub ---------------------------------------

const REPO = "equisafe/market";
const prUrl = (n: number) => `https://github.com/${REPO}/pull/${n}`;
interface FakePr {
  number: number;
  head: string;
  branch: string;
  createdAt: number;
  updatedAt: number;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  state: "OPEN" | "MERGED" | "CLOSED";
  checks: { name: string; outcome: "passed" | "failed" | "pending"; required?: boolean }[];
  comments: { url: string; at: number; login: string; bot?: boolean; review?: string }[];
  /** GitHub's review decision, and whether each review thread is resolved: only a watch call reads them. */
  decision?: string;
  threads?: boolean[];
  /** By another author: no list shows it. */
  unlisted?: boolean;
}
const iso = (at: number) => new Date(at).toISOString();
const listNode = (pr: FakePr) => withId({
  number: pr.number, title: `PR ${pr.number}`, url: prUrl(pr.number), isDraft: false, reviewDecision: "", mergeable: pr.mergeable,
  mergeStateStatus: "CLEAN", headRefName: pr.branch, headRefOid: pr.head, baseRefName: "main", createdAt: iso(pr.createdAt), updatedAt: iso(pr.updatedAt),
  statusCheckRollup: rollup({
    SUCCESS: pr.checks.filter((c) => c.outcome === "passed").length,
    FAILURE: pr.checks.filter((c) => c.outcome === "failed").length,
    IN_PROGRESS: pr.checks.filter((c) => c.outcome === "pending").length,
  }),
});
/** 100 checks from `start`, with GitHub's cursor to the next page ("c<index>"). */
const contextPage = (pr: FakePr, start: number) => ({
  pageInfo: { hasNextPage: pr.checks.length > start + 100, endCursor: `c${start + 100}` },
  nodes: pr.checks.slice(start, start + 100).map((c) => ({
    __typename: "CheckRun", name: c.name, status: c.outcome === "pending" ? "IN_PROGRESS" : "COMPLETED",
    conclusion: c.outcome === "passed" ? "SUCCESS" : c.outcome === "failed" ? "FAILURE" : null, isRequired: c.required ?? false,
  })),
});
const watchNode = (pr: FakePr, baseline: boolean) => ({
  id: prUrl(pr.number), number: pr.number, title: `PR ${pr.number}`, state: pr.state, headRefOid: pr.head, mergeable: pr.mergeable, createdAt: iso(pr.createdAt),
  ...(baseline ? { reviewDecision: pr.decision ?? null, reviewThreads: { totalCount: pr.threads?.length ?? 0, nodes: (pr.threads ?? []).map((isResolved) => ({ isResolved })) } } : {}),
  commits: { nodes: [{ commit: { statusCheckRollup: {
    state: pr.checks.some((c) => c.outcome === "failed") ? "FAILURE" : pr.checks.some((c) => c.outcome === "pending") ? "PENDING" : "SUCCESS",
    contexts: contextPage(pr, 0),
  } } }] },
  comments: { nodes: pr.comments.filter((c) => !c.review).map((c) => ({ url: c.url, createdAt: iso(c.at), author: { __typename: c.bot ? "Bot" : "User", login: c.login } })) },
  reviews: { nodes: pr.comments.filter((c) => c.review).map((c) => ({ url: c.url, submittedAt: iso(c.at), state: c.review, author: { __typename: c.bot ? "Bot" : "User", login: c.login } })) },
});

interface Thread { id: string; status: string; archivedAt: number | null; deletedAt: number | null }

/** An Adventure over equisafe/market with W1 (thread thr_w1, whose branches end in thr_w1) and W2. */
function setup(options: { prs?: FakePr[]; since?: number } = {}) {
  const { store, db, clock } = memoryStore(options.since ?? T0);
  store.createProject({ id: "eq", name: "Equisafe", objective: "o", memberProjectIds: ["proj_eq"], coordinatorThreadId: "thr_c" });
  for (const [num, thread] of [[1, "thr_w1"], [2, "thr_w2"]] as const) {
    const w = store.createWorker({ projectId: "eq", role: "work", label: `W${num}`, area: "a", bbProjectId: "proj_eq" });
    expect(w.num).toBe(num);
    store.updateWorker("eq", num, { threadId: thread, generation: 1 });
    store.openGeneration("eq", num, 1, thread);
  }
  const prs = new Map<number, FakePr>();
  for (const pr of options.prs ?? []) prs.set(pr.number, pr);
  const requests: { kind: "list" | "watch" | "id" | "details"; count: number }[] = [];
  /** Runs as a watch query arrives, before it answers. */
  const hooks: { onWatch?: () => Promise<void> | void; onThread?: () => void; onPage?: () => void } = {};
  let inFlight = 0;
  let peak = 0;
  const gh = vi.fn<GraphQl>(async (query, variables) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (query === GH_LIST_QUERY) {
        requests.push({ kind: "list", count: 1 });
        return searchPage([...prs.values()].filter((pr) => pr.state === "OPEN" && !pr.unlisted).map(listNode));
      }
      if (query === CHECKS_PAGE_QUERY) {
        requests.push({ kind: "watch", count: 1 });
        const hook = hooks.onPage;
        hooks.onPage = undefined;
        hook?.();
        const pr = prs.get(Number(/pull\/(\d+)$/.exec(String(variables.id))![1]))!;
        const start = Number(String(variables.after).slice(1));
        return { node: { headRefOid: pr.head, commits: { nodes: [{ commit: { statusCheckRollup: { contexts: contextPage(pr, start) } } }] } } };
      }
      if (query.includes("isRequired(pullRequestId")) {
        const ids = Object.keys(variables).filter((k) => /^i\d+$/.test(k));
        requests.push({ kind: "watch", count: ids.length });
        const hook = hooks.onWatch;
        hooks.onWatch = undefined;
        await hook?.();
        return Object.fromEntries([["viewer", { login: "erwinkn" }], ...ids.map((k) => {
          const number = Number(/pull\/(\d+)$/.exec(String(variables[k]))![1]);
          const pr = prs.get(number);
          return [`p${k.slice(1)}`, pr ? watchNode(pr, query.includes("reviewThreads")) : null];
        })]);
      }
      if (query === PR_ID_QUERY) {
        requests.push({ kind: "id", count: 1 });
        const pr = prs.get(Number(variables.number));
        return { repository: { pullRequest: pr ? { id: prUrl(pr.number) } : null } };
      }
      requests.push({ kind: "details", count: 1 });
      return { nodes: [] };
    } finally {
      inFlight--;
    }
  });
  const owners = new PrOwners(db, ledgerThreads(store, async () => null), () => {}, () => clock.now);
  const assigned = new AssignedPrs(store);
  const listed = vi.fn();
  const makeCache = () => new MergeQueueCache({
    memberProjectIds: (id) => store.project(id)!.memberProjectIds,
    project: async () => ({ name: "market", gitRemoteUrl: `git@github.com:${REPO}.git` }),
    workers: (projectId) => new Map(store.workers(projectId).flatMap((w) => (w.threadId ? [[w.threadId, w.ref] as const] : []))),
    prRecords: (projectId) => store.prRecords(projectId),
    assignedPrs: (projectId) => assigned.read(projectId),
    notes: () => new Map(),
    owners: (pullRequests) => owners.owners(pullRequests),
  }, gh, () => clock.now, () => {}, listed);
  const threads = new Map<string, Thread>(["thr_w1", "thr_w2", "thr_c"].map((id) => [id, { id, status: "idle", archivedAt: null, deletedAt: null }]));
  const send = vi.fn(async (_args: { threadId: string; mode: string; input: { text: string }[] }): Promise<{ delivery: string; queuedMessage?: { id: string } }> => ({ delivery: "sent" }));
  const deleteQueued = vi.fn(async (_args: { threadId: string; queuedMessageId: string }) => ({ ok: true }));
  const sdk = { threads: { get: vi.fn(async ({ threadId }: { threadId: string }) => {
    const hook = hooks.onThread;
    hooks.onThread = undefined;
    hook?.();
    return threads.get(threadId);
  }), send, queuedMessages: { delete: deleteQueued } } } as unknown as Sdk;
  const coldCheck = vi.fn(async (): Promise<string | null> => null);
  const giveWork = vi.fn(async (_projectId: string, _ref: string, _text: string, _still: () => void) => "A7");
  const changed = vi.fn();
  const warn = vi.fn();
  const make = () => {
    const cache = makeCache();
    const ledger = new WatchLedger(db, () => clock.now);
    const watcher = new PrWatcher({ store, ledger, cache, sdk, coldCheck, giveWork, changed, warn }, () => clock.now);
    return { cache, ledger, watcher };
  };
  let live = make();
  /** One poll: the pass starts the due fetch, and the pass after it lands diffs it. */
  const poll = async (advance = REFRESH_MS) => {
    clock.now += advance;
    await live.watcher.check();
    await live.cache.settled();
    await live.watcher.check();
    await live.cache.settled();
  };
  const sent = () => send.mock.calls.map(([args]) => ({ to: args.threadId, mode: args.mode, text: args.input[0]!.text }));
  /** initiative_pr_watch: `thread` (by default the one its branch names) watches PR `n` for `projectId`. */
  const watch = (n: number, thread = /(thr_\w+)$/.exec(prs.get(n)!.branch)![1]!, projectId = "eq") => live.watcher.watch(prUrl(n), projectId, thread);
  /** The list, then every PR watched from it, as workers do after they push. */
  const start = async () => {
    await poll(0);
    for (const n of prs.keys()) await watch(n);
  };
  /** A watch again from the state stored (no read): its generation moves, as a watch call's does. */
  const rewatch = (n: number, thread: string, projectId = "eq") => {
    const row = live.ledger.row(prUrl(n))!;
    live.ledger.watch(prUrl(n), projectId, thread, row.nodeId!, row.state!);
  };
  return {
    store, db, clock, prs, gh, requests, hooks, peak: () => peak, owners, assigned, sdk, send, deleteQueued, sent, threads, coldCheck, giveWork, changed, warn, listed, poll,
    watch, start, rewatch,
    get cache() { return live.cache; }, get ledger() { return live.ledger; }, get watcher() { return live.watcher; },
    /** A plugin reload: a new cache and watcher over the same database. */
    reload: () => { live = make(); live.watcher.recover(); },
  };
}

const fakePr = (number: number, over: Partial<FakePr> = {}): FakePr => ({
  number, head: `head${number}a`, branch: `bb/w1-pr-thr_w1`, createdAt: T0 - 3 * 24 * 60 * MINUTE, updatedAt: T0 - 60 * MINUTE,
  mergeable: "MERGEABLE", state: "OPEN", checks: [{ name: "tests", outcome: "pending" }], comments: [], ...over,
});
const wakeRows = (t: ReturnType<typeof setup>) => t.db.prepare("SELECT url, state, routed, changes FROM pr_wakes ORDER BY id").all() as { url: string; state: string; routed: string; changes: string }[];

describe("W548 PrWatcher", () => {
  it("takes the watch call's read as a baseline, then wakes the watching worker, idle, once with more work naming the change and head", async () => {
    const t = setup({ prs: [fakePr(1, { checks: [{ name: "old", outcome: "failed" }] })] });
    await t.start();
    // The size and reviewers (details) are the cache's own, read beside.
    expect(t.requests.filter((r) => r.kind !== "details").map((r) => r.kind)).toEqual(["list", "watch"]);
    expect(t.giveWork).not.toHaveBeenCalled();
    expect(t.ledger.row(prUrl(1))?.state).toMatchObject({ head: "head1a", failing: ["old"] });

    // A check fails: the list's counts move, the watch read names it.
    t.prs.get(1)!.checks = [{ name: "old", outcome: "failed" }, { name: "tests", outcome: "failed" }];
    await t.poll();
    expect(t.giveWork).toHaveBeenCalledTimes(1);
    const [projectId, ref, text] = t.giveWork.mock.calls[0]!;
    expect([projectId, ref]).toEqual(["eq", "W1"]);
    expect(text).toContain(`${REPO}#1 "PR 1" at head head1a`);
    expect(text).toContain("Checks failed: tests.");
    expect(text).not.toContain("old");
    expect(text).toContain(NOT_A_MERGE);
    expect(wakeRows(t)).toEqual([expect.objectContaining({ url: prUrl(1), state: "sent", routed: "W1: A7" })]);
    expect(t.store.activity("eq").some((a) => a.kind === "pr-watch" && /woke W1 about equisafe\/market#1 \(checks-failed\) with A7/.test(a.summary))).toBe(true);

    // Nothing moved: no watch read, no wake.
    const reads = t.requests.length;
    await t.poll();
    expect(t.requests.slice(reads).filter((r) => r.kind !== "details").map((r) => r.kind)).toEqual(["list"]);
    expect(t.giveWork).toHaveBeenCalledTimes(1);
  });

  it("coalesces one worker's PRs into one wake a pass, and messages a busy worker instead of giving it work", async () => {
    const t = setup({ prs: [fakePr(1), fakePr(2, { head: "head2a" })] });
    await t.start();
    t.threads.get("thr_w1")!.status = "active";
    for (const n of [1, 2]) t.prs.get(n)!.checks = [{ name: "tests", outcome: "failed" }];
    await t.poll();
    expect(t.giveWork).not.toHaveBeenCalled();
    expect(t.sent()).toHaveLength(1);
    expect(t.sent()[0]).toMatchObject({ to: "thr_w1", mode: "steer-if-active" });
    expect(t.sent()[0]!.text).toMatch(/#1 "PR 1"[\s\S]*#2 "PR 2"/);
    expect(t.sent()[0]!.text).toContain(NOT_A_MERGE);
  });

  it("sends to the coordinator, in one message a pass, when the worker is retired, or idle with a cold cache", async () => {
    const t = setup({ prs: [fakePr(1), fakePr(2, { branch: "bb/w2-thr_w2" })] });
    await t.start();
    t.store.updateWorker("eq", 1, { state: "retired" });
    t.coldCheck.mockImplementation(async () => "W2's cache is cold (last request 40 min ago) and its context is ~300k tokens: resuming it costs ~375k tokens of cache rewrite.");
    for (const n of [1, 2]) t.prs.get(n)!.mergeable = "CONFLICTING";
    await t.poll();
    expect(t.giveWork).not.toHaveBeenCalled();
    expect(t.sent()).toHaveLength(1);
    const [message] = t.sent();
    expect(message).toMatchObject({ to: "thr_c", mode: "queue-if-active" });
    expect(message!.text).toContain("W1 is retired:");
    expect(message!.text).toContain('a fresh worker with handoffs:["W1"]');
    expect(message!.text).toContain("It conflicts with its base branch.");
    expect(message!.text).toContain("W2's cache is cold");
    expect(message!.text).toContain("resumeCold:true");
    expect(wakeRows(t).map((w) => w.state)).toEqual(["sent", "sent"]);
  });

  it("skips a wake whose head moved before it could be sent", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.start();
    // Paused: the wake is stored and held.
    t.store.updateProject("eq", { paused: true });
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    await t.poll();
    expect(wakeRows(t).map((w) => w.state)).toEqual(["pending"]);
    // A push lands meanwhile; the Adventure resumes: the old wake is stale, the new head is diffed.
    t.prs.get(1)!.head = "head1b";
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "pending" }];
    t.store.updateProject("eq", { paused: false });
    await t.poll();
    expect(wakeRows(t)).toEqual([expect.objectContaining({ state: "stale", routed: "head moved to head1b" })]);
    expect(t.giveWork).not.toHaveBeenCalled();
    expect(t.sent()).toEqual([]);
  });

  it("neither repeats nor misses a wake across a reload; a send a reload cut short is never repeated", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.start();
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    await t.poll();
    expect(t.giveWork).toHaveBeenCalledTimes(1);

    // Reload: the same failure is not news again.
    t.reload();
    await t.start();
    expect(t.giveWork).toHaveBeenCalledTimes(1);

    // A comment while the plugin is down is news after the next reload.
    t.prs.get(1)!.comments = [{ url: "https://c/1", at: t.clock.now + MINUTE, login: "coderabbitai", bot: true }];
    t.prs.get(1)!.updatedAt = t.clock.now + MINUTE;
    t.reload();
    await t.poll();
    expect(t.giveWork).toHaveBeenCalledTimes(2);
    expect(t.giveWork.mock.calls[1]![2]).toContain("coderabbitai (bot): https://c/1");

    // A send in flight when the plugin stopped is marked uncertain, not sent again.
    t.db.prepare("UPDATE pr_wakes SET state = 'sending' WHERE id = (SELECT MAX(id) FROM pr_wakes)").run();
    t.reload();
    expect(wakeRows(t).at(-1)!.state).toBe("uncertain");
    expect(t.store.activity("eq").some((a) => /may not have arrived, and is not sent again/.test(a.summary))).toBe(true);
    await t.poll();
    expect(t.giveWork).toHaveBeenCalledTimes(2);
  });

  it("sends a wake still pending at a reload once a watch read confirms its head, listed yet or not", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.start();
    t.store.updateProject("eq", { paused: true });
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    await t.poll();
    t.reload();
    t.store.updateProject("eq", { paused: false });
    // The reloaded cache has no list yet: the pass reads the PR itself.
    t.clock.now += MINUTE;
    await t.watcher.check();
    expect(wakeRows(t).map((w) => w.state)).toEqual(["sent"]);
    expect(t.giveWork).toHaveBeenCalledTimes(1);
  });
  it("wakes nobody once unwatched, and starts from the PR as it is when watched again", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.start();
    t.ledger.unwatch(prUrl(1));
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    await t.poll();
    expect(t.requests.filter((r) => r.kind === "watch")).toHaveLength(1);
    expect(readPrWatch(t.store, t.ledger, prUrl(1))).toMatchObject({ watcher: null, ended: null });
    // Watched again: the answer shows the failure, which wakes nobody later.
    const { facts } = await t.watch(1);
    expect(watchAnswer(prUrl(1), facts, "you", null)).toMatchObject({ now: { checks: "failing: tests" }, attention: expect.stringContaining("Checks failing: tests.") });
    await t.poll();
    expect(t.giveWork).not.toHaveBeenCalled();
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }, { name: "lint", outcome: "failed" }];
    await t.poll();
    expect(t.giveWork).toHaveBeenCalledTimes(1);
    expect(t.giveWork.mock.calls[0]![2]).toContain("Checks failed: lint.");
  });
  it("ends a merged PR's watch without waking anyone, once a read finds it gone from the list", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.start();
    t.prs.get(1)!.state = "MERGED";
    await t.poll();
    expect(t.ledger.row(prUrl(1))?.state?.ended).toBeNull();
    await t.poll(UNLISTED_READ_MS);
    expect(t.ledger.row(prUrl(1))?.state?.ended).toBe("MERGED");
    expect(wakeRows(t)).toEqual([]);
    expect(t.sent()).toEqual([]);
    expect(readPrWatch(t.store, t.ledger, prUrl(1))).toMatchObject({ watcher: { label: "W1" }, ended: "MERGED" });
    // An ended watch is read no more.
    const reads = t.requests.filter((r) => r.kind === "watch").length;
    await t.poll(UNLISTED_READ_MS);
    expect(t.requests.filter((r) => r.kind === "watch").length).toBe(reads);
  });
  it("stops waking for comments after the cap and says so in the activity", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.start();
    for (let i = 1; i <= COMMENT_WAKE_CAP + 1; i++) {
      t.prs.get(1)!.comments.push({ url: `https://c/${i}`, at: t.clock.now + 1, login: "coderabbitai", bot: true });
      t.prs.get(1)!.updatedAt = t.clock.now + 1;
      await t.poll();
    }
    expect(t.giveWork).toHaveBeenCalledTimes(COMMENT_WAKE_CAP);
    expect(t.store.activity("eq").some((a) => /woke nobody after 10 comment-only wakes/.test(a.summary))).toBe(true);
    expect(readPrWatch(t.store, t.ledger, prUrl(1)).commentWakes).toBe(COMMENT_WAKE_CAP);
  });

  it(`reads changed PRs ${WATCH_PAGE} a request in the details slots, and keeps a watched repository on the 2-minute cadence`, async () => {
    const prs = Array.from({ length: 60 }, (_, i) => fakePr(i + 1, { head: `h${i + 1}` }));
    const t = setup({ prs });
    await t.start();
    const started = t.requests.length;
    for (const pr of prs) pr.checks = [{ name: "tests", outcome: "failed" }];
    await t.poll();
    expect(t.requests.slice(started).filter((r) => r.kind === "watch").map((r) => r.count)).toEqual([25, 25, 10]);
    expect(t.peak()).toBeLessThanOrEqual(DETAILS_CONCURRENCY);
    // Watched: a list read every 2 minutes, a watch read only for what moved.
    const before = t.requests.length;
    await t.poll(REFRESH_MS);
    expect(t.requests.slice(before).filter((r) => r.kind !== "details").map((r) => r.kind)).toEqual(["list"]);
    // Every PR unwatched: back to the idle cadence (one more pass learns it).
    for (const pr of prs) t.ledger.unwatch(prUrl(pr.number));
    await t.poll(REFRESH_MS);
    const unwatched = t.requests.length;
    await t.poll(REFRESH_MS);
    expect(t.requests.length).toBe(unwatched);
    await t.poll(IDLE_REFRESH_MS - REFRESH_MS);
    expect(t.requests.slice(unwatched).filter((r) => r.kind !== "details").map((r) => r.kind)).toEqual(["list"]);
  });
  it("retries a failed watch read later, in smaller requests, without diffing on stale facts", async () => {
    const t = setup({ prs: [fakePr(1), fakePr(2, { head: "head2a" })] });
    await t.start();
    const real = t.gh.getMockImplementation()!;
    t.gh.mockImplementation(async (query, variables, timeout) => {
      if (query.includes("isRequired(pullRequestId")) throw new Error("502 Bad Gateway");
      return real(query, variables, timeout);
    });
    for (const n of [1, 2]) t.prs.get(n)!.checks = [{ name: "tests", outcome: "failed" }];
    const before = t.requests.length;
    await t.poll();
    expect(t.warn).toHaveBeenCalledWith(expect.stringContaining("PR watch read of 2 PRs failed: 502 Bad Gateway"));
    expect(wakeRows(t)).toEqual([]);
    t.gh.mockImplementation(real);
    await t.poll();
    expect(t.requests.slice(before).filter((r) => r.kind === "watch").map((r) => r.count)).toEqual([1, 1]);
    expect(t.giveWork).toHaveBeenCalledTimes(1);
  });
});


describe("W548 review r1 regressions", () => {
  it("rechecks a wake just before it is sent: an unwatch drops it, a pause or a retire while routing waits on BB holds it", async () => {
    for (const change of ["unwatch", "pause", "retire"] as const) {
      const t = setup({ prs: [fakePr(1)] });
      await t.start();
      t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
      t.hooks.onThread = () => {
        if (change === "unwatch") t.ledger.unwatch(prUrl(1));
        if (change === "pause") t.store.updateProject("eq", { paused: true });
        if (change === "retire") t.store.updateWorker("eq", 1, { state: "retired" });
      };
      await t.poll();
      expect(t.giveWork, change).not.toHaveBeenCalled();
      expect(t.sent(), change).toEqual([]);
      expect(wakeRows(t).map((w) => w.state), change).toEqual([change === "unwatch" ? "stale" : "pending"]);
    }
  });

  it("rechecks inside the serialized work step too", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.start();
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    t.giveWork.mockImplementation(async (_p, _r, _t, still) => {
      t.ledger.unwatch(prUrl(1));
      still();
      return "A7";
    });
    await t.poll();
    expect(wakeRows(t)).toEqual([expect.objectContaining({ state: "stale", routed: "unwatched" })]);
  });

  it("drops a pass's write and a held wake from before a watch again", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.start();
    // Watched again while the pass's read is out: the pass's write doesn't land; the new baseline holds the failure.
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    t.hooks.onWatch = async () => {
      await t.watch(1);
    };
    await t.poll();
    expect(wakeRows(t)).toEqual([]);
    expect(t.ledger.row(prUrl(1))?.state).toMatchObject({ failing: ["tests"] });
    await t.poll();
    expect(t.giveWork).not.toHaveBeenCalled();

    // A wake held by a pause, then a watch again: it no longer applies.
    t.store.updateProject("eq", { paused: true });
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }, { name: "lint", outcome: "failed" }];
    await t.poll();
    expect(wakeRows(t).map((w) => w.state)).toEqual(["pending"]);
    await t.watch(1, "thr_w2");
    t.store.updateProject("eq", { paused: false });
    await t.poll();
    expect(wakeRows(t)).toEqual([expect.objectContaining({ state: "stale", routed: "watched again since" })]);
    expect(t.giveWork).not.toHaveBeenCalled();
    expect(t.sent()).toEqual([]);
  });
  it("sends a wake on what its watch read saw, whatever a list landing meanwhile shows; that list only calls for the next read", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.start();
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    // While the watch read (head A) is out, a list started meanwhile already shows B.
    t.hooks.onWatch = async () => {
      t.prs.get(1)!.head = "head1b";
      t.clock.now += REFRESH_MS;
      await t.cache.read("eq", { watch: true });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(t.cache.cachedPr(prUrl(1))?.headOid).toBe("head1b");
      t.prs.get(1)!.head = "head1a";
    };
    await t.poll();
    // The wake is all A's: its head and its failing check.
    expect(t.giveWork).toHaveBeenCalledTimes(1);
    expect(t.giveWork.mock.calls[0]![2]).toContain("at head head1a");
    // B is the head after all: the next pass reads it, and B's own facts wake.
    t.prs.get(1)!.head = "head1b";
    t.prs.get(1)!.checks = [{ name: "e2e", outcome: "failed" }];
    await t.poll();
    expect(t.giveWork).toHaveBeenCalledTimes(2);
    expect(t.giveWork.mock.calls[1]![2]).toMatch(/at head head1b[\s\S]*Checks failed: e2e\./);
    expect(t.giveWork.mock.calls[1]![2]).not.toContain("tests");
  });

  it("drops a held wake once its PR is unwatched", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.start();
    t.store.updateProject("eq", { paused: true });
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    await t.poll();
    t.ledger.unwatch(prUrl(1));
    t.store.updateProject("eq", { paused: false });
    await t.poll();
    expect(wakeRows(t)).toEqual([expect.objectContaining({ state: "stale", routed: "unwatched" })]);
  });
  it("reads a PR again after WATCH_RESYNC_MS even when its list facts stay (two reruns that swap outcomes)", async () => {
    const t = setup({ prs: [fakePr(1, { checks: [{ name: "tests", outcome: "failed" }, { name: "lint", outcome: "passed" }] })] });
    await t.start();
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "passed" }, { name: "lint", outcome: "failed" }];
    await t.poll();
    expect(t.giveWork).not.toHaveBeenCalled();
    await t.poll(WATCH_RESYNC_MS);
    expect(t.giveWork).toHaveBeenCalledTimes(1);
    expect(t.giveWork.mock.calls[0]![2]).toContain("Checks failed: lint.");
  });

  it("keeps a repository's CI evidence: its only PR pushed without checks wakes, across a reload too", async () => {
    const t = setup({ prs: [fakePr(1, { checks: [{ name: "tests", outcome: "passed" }] })] });
    await t.start();
    t.prs.get(1)!.head = "head1b";
    t.prs.get(1)!.checks = [];
    await t.poll();
    t.reload();
    await t.poll(NO_CHECKS_MS);
    expect(t.giveWork).toHaveBeenCalledTimes(1);
    expect(t.giveWork.mock.calls[0]![2]).toContain("No check has reported 15 min after the push of head1b.");
  });

  it("expires a held wake before a list with its head could send it", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.start();
    t.store.updateProject("eq", { paused: true });
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    await t.poll();
    t.store.updateProject("eq", { paused: false });
    await t.poll(24 * 60 * MINUTE + 1);
    expect(wakeRows(t)).toEqual([expect.objectContaining({ state: "stale", routed: "too old" })]);
  });

  it("doesn't take part of more than 100 checks for all of them", () => {
    const node = (rollup: string, conclusion: string) => ({
      id: "x", number: 1, state: "OPEN", headRefOid: "abc",
      commits: { nodes: [{ commit: { statusCheckRollup: { state: rollup, contexts: { pageInfo: { hasNextPage: true }, nodes: [
        { __typename: "CheckRun", name: "tests", status: "COMPLETED", conclusion, isRequired: true },
      ] } } } }] },
      comments: { nodes: [] }, reviews: { nodes: [] },
    });
    const prev = base();
    const failing = diffWatch(prev, parseWatch(node("FAILURE", "SUCCESS"))!, ctx());
    expect(failing.changes).toEqual([{ kind: "checks-failed", checks: [CHECKS_PAST_100] }]);
    expect(failing.state.passed).toBe(false);
    const pending = diffWatch(prev, parseWatch(node("PENDING", "SUCCESS"))!, ctx());
    expect(pending.changes).toEqual([]);
    const done = diffWatch(prev, parseWatch(node("SUCCESS", "SUCCESS"))!, ctx());
    expect(kinds(done)).toEqual(["checks-passed"]);
  });
});


describe("W548 review r2 regressions", () => {
  it("drops one wake that stopped applying and still sends the others of its message", async () => {
    const t = setup({ prs: [fakePr(1), fakePr(2, { head: "head2a" })] });
    await t.start();
    for (const n of [1, 2]) t.prs.get(n)!.checks = [{ name: "tests", outcome: "failed" }];
    t.hooks.onThread = () => t.ledger.unwatch(prUrl(1));
    await t.poll();
    expect(wakeRows(t).map((w) => [w.url, w.state])).toEqual([[prUrl(1), "stale"], [prUrl(2), "sent"]]);
    expect(t.giveWork).toHaveBeenCalledTimes(1);
    expect(t.giveWork.mock.calls[0]![2]).toContain("#2");
    expect(t.giveWork.mock.calls[0]![2]).not.toContain("#1 ");
  });

  it("checks the watch as it is when sending: one watched by another thread while routing waits on BB is dropped", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.start();
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    t.hooks.onThread = () => t.rewatch(1, "thr_w2");
    await t.poll();
    expect(wakeRows(t)).toEqual([expect.objectContaining({ state: "stale", routed: "watched again since" })]);
    expect(t.giveWork).not.toHaveBeenCalled();
    expect(t.sent()).toEqual([]);
  });
  it("takes check presence from the watch read when a push landed after the list", async () => {
    const t = setup({ prs: [fakePr(1, { checks: [{ name: "tests", outcome: "passed" }] })] });
    await t.start();
    t.prs.get(1)!.updatedAt += 1;
    // The list shows head A with its checks; the watch read already sees B, without any.
    t.hooks.onWatch = () => {
      t.prs.get(1)!.head = "head1b";
      t.prs.get(1)!.checks = [];
    };
    await t.poll();
    expect(t.ledger.row(prUrl(1))?.state).toMatchObject({ head: "head1b", noChecksDone: false });
    await t.poll(NO_CHECKS_MS);
    expect(t.giveWork).toHaveBeenCalledTimes(1);
    expect(t.giveWork.mock.calls[0]![2]).toContain("No check has reported 15 min after the push of head1b.");
  });

  it("reads checks past the first 100, so a newly failing one there is named", async () => {
    const checks = Array.from({ length: 150 }, (_, i) => ({ name: `c${i}`, outcome: i === 0 ? "failed" as const : "passed" as const }));
    const t = setup({ prs: [fakePr(1, { checks })] });
    await t.start();
    expect(t.ledger.row(prUrl(1))?.state?.failing).toEqual(["c0"]);
    t.prs.get(1)!.checks = checks.map((c, i) => (i === 140 ? { ...c, outcome: "failed" as const } : c));
    await t.poll();
    expect(t.giveWork).toHaveBeenCalledTimes(1);
    expect(t.giveWork.mock.calls[0]![2]).toContain("Checks failed: c140.");
  });

  it("wakes on a comment that shares its time with one seen before", () => {
    const at = T0 - MINUTE;
    const c1 = { url: "c1", at, author: "coderabbitai", bot: true, review: null };
    const c2 = { url: "c2", at, author: "YoungMoh", bot: false, review: null };
    const first = diffWatch(base(), facts({ comments: [c1] }), ctx());
    expect(kinds(first)).toEqual(["new-comments"]);
    const second = diffWatch(first.state, facts({ comments: [c1, c2] }), ctx());
    expect(second.changes).toEqual([{ kind: "new-comments", comments: [c2] }]);
    expect(diffWatch(second.state, facts({ comments: [c1, c2] }), ctx()).changes).toEqual([]);
  });
});


describe("W548 review r3 regressions", () => {
  it("drops a held wake once a later watch read saw a push the list hasn't shown yet", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.start();
    t.store.updateProject("eq", { paused: true });
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    await t.poll();
    expect(wakeRows(t).map((w) => w.state)).toEqual(["pending"]);
    t.store.updateProject("eq", { paused: false });
    // The list still shows A; the watch read the comment calls for already sees B.
    t.prs.get(1)!.updatedAt += 1;
    t.hooks.onWatch = () => {
      t.prs.get(1)!.head = "head1b";
      t.prs.get(1)!.checks = [{ name: "tests", outcome: "pending" }];
    };
    await t.poll();
    expect(wakeRows(t)).toEqual([expect.objectContaining({ state: "stale", routed: "head moved to head1b" })]);
    expect(t.giveWork).not.toHaveBeenCalled();
  });

  it("wakes the thread that watched the PR, not the worker whose branch opened it", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.poll(0);
    await t.watch(1, "thr_w2");
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    await t.poll();
    expect(t.giveWork.mock.calls.map((c) => c[1])).toEqual(["W2"]);
    expect(t.giveWork.mock.calls[0]![2]).toContain("GitHub news on the PR you watch.");
    expect(wakeRows(t)).toEqual([expect.objectContaining({ state: "sent", routed: "W2: A7" })]);
  });
  it("announces required checks only once every required one reported and passed", () => {
    const prev = base(facts({ checks: [{ name: "lint", outcome: "pending", required: false }] }));
    const lintOnly = facts({ required: ["lint", "test"], checks: [{ name: "lint", outcome: "passed", required: true }] });
    expect(diffWatch(prev, lintOnly, ctx()).changes).toEqual([]);
    const both = facts({ required: ["lint", "test"], checks: [{ name: "lint", outcome: "passed", required: true }, { name: "test", outcome: "passed", required: true }, { name: "e2e", outcome: "pending", required: false }] });
    expect(diffWatch(prev, both, ctx()).changes).toEqual([{ kind: "checks-passed", checks: ["lint", "test"], required: true }]);
    // Read from classic protection and rulesets alike.
    const parsed = parseWatch({ state: "OPEN", headRefOid: "a", baseRef: {
      branchProtectionRule: { requiredStatusCheckContexts: ["lint"] },
      rules: { pageInfo: { hasNextPage: false }, nodes: [{ type: "REQUIRED_STATUS_CHECKS", parameters: { requiredStatusChecks: [{ context: "test" }] } }, { type: "DELETION", parameters: null }] },
    } });
    expect(parsed?.required).toEqual(["lint", "test"]);
    expect(parseWatch({ state: "OPEN", headRefOid: "a", baseRef: null })?.required).toBeUndefined();
  });

  it("takes check presence from the watch read whenever one ran", () => {
    const pushed = diffWatch(base(), facts({ head: "bbb", checks: [] }), ctx()).state;
    // At 15 minutes the list shows none, but the watch read of the same head sees one that passed.
    const r = diffWatch(pushed, facts({ head: "bbb", checks: [{ name: "tests", outcome: "passed", required: false }] }), ctx({ now: T0 + NO_CHECKS_MS }));
    expect(kinds(r)).toEqual(["checks-passed"]);
  });

  it("backs off a PR whose later check pages keep failing", async () => {
    const checks = Array.from({ length: 150 }, (_, i) => ({ name: `c${i}`, outcome: "passed" as const }));
    const t = setup({ prs: [fakePr(1, { checks })] });
    await t.start();
    const real = t.gh.getMockImplementation()!;
    t.gh.mockImplementation(async (query, variables, timeout) => {
      if (query === CHECKS_PAGE_QUERY) throw new Error("502 Bad Gateway");
      return real(query, variables, timeout);
    });
    const pageReads = () => t.gh.mock.calls.filter(([q]) => q === CHECKS_PAGE_QUERY).length;
    const before = pageReads();
    t.prs.get(1)!.updatedAt += 1;
    await t.poll();
    expect(pageReads()).toBe(before + 1);
    // Retried after 2 minutes, then 4: not at the next 2-minute poll.
    await t.poll();
    expect(pageReads()).toBe(before + 2);
    await t.poll();
    expect(pageReads()).toBe(before + 2);
    await t.poll();
    expect(pageReads()).toBe(before + 3);
    expect(wakeRows(t)).toEqual([]);
  });
});


describe("W548 review r4 regressions", () => {
  it("drops a held wake once its watcher's Adventure is archived", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.start();
    t.store.updateProject("eq", { paused: true });
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    await t.poll();
    t.store.updateProject("eq", { archivedAt: t.clock.now, paused: false });
    await t.poll();
    expect(wakeRows(t)).toEqual([expect.objectContaining({ state: "stale", routed: "the Adventure is archived" })]);
    expect(t.sent()).toEqual([]);
  });
  it("routes by key: a burst of 300 wakes for one worker stays cheap", async () => {
    const prs = Array.from({ length: 300 }, (_, i) => fakePr(i + 1, { head: `h${i + 1}` }));
    const t = setup({ prs });
    for (let i = 3; i <= 300; i++) {
      const w = t.store.createWorker({ projectId: "eq", role: "work", label: `W${i}`, area: "a", bbProjectId: "proj_eq" });
      t.store.updateWorker("eq", w.num, { threadId: `thr_x${i}`, generation: 1 });
    }
    await t.start();
    for (const pr of prs) pr.checks = [{ name: "tests", outcome: "failed" }];
    const started = performance.now();
    await t.poll();
    const ms = performance.now() - started;
    expect(t.giveWork).toHaveBeenCalledTimes(1);
    // Was ~809 ms of blocked event loop with whole-table reads per check (review r4); generous for slow CI.
    expect(ms).toBeLessThan(400);
  });
});


describe("W548 review r4 stale-head cases (D551)", () => {
  it("keeps a wake on a fresh head, and its comment, when a dashboard list started earlier lands showing the old head", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.start();
    t.prs.get(1)!.updatedAt += 1;
    // The pass read list A. While its watch read is out, a dashboard refresh lists A again (it
    // started before the push showed), then the watch read sees pushed B and a new bot comment.
    t.hooks.onWatch = async () => {
      t.clock.now += 10_000;
      await t.cache.read("eq", { refresh: true, viewer: true } as never);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(t.cache.cachedPr(prUrl(1))?.headOid).toBe("head1a");
      t.prs.get(1)!.head = "head1b";
      t.prs.get(1)!.checks = [{ name: "tests", outcome: "pending" }];
      t.prs.get(1)!.comments = [{ url: "https://c/b1", at: t.clock.now, login: "coderabbitai", bot: true }];
    };
    await t.poll();
    // Sent at once: the list it overlapped shows A, but no list decides a wake.
    expect(wakeRows(t).map((w) => w.state)).toEqual(["sent"]);
    expect(t.giveWork).toHaveBeenCalledTimes(1);
    expect(t.giveWork.mock.calls[0]![2]).toContain("at head head1b");
    expect(t.giveWork.mock.calls[0]![2]).toContain("coderabbitai (bot): https://c/b1");
  });

  it("wakes nobody for the old head when a push lands between pages of over 100 checks; the new head is read next pass", async () => {
    const checks = Array.from({ length: 150 }, (_, i) => ({ name: `c${i}`, outcome: "passed" as const }));
    const t = setup({ prs: [fakePr(1, { checks })] });
    await t.start();
    // Page 1 of head A shows c0 newly failing; a push to B lands before page 2.
    t.prs.get(1)!.checks = checks.map((c, i) => (i === 0 ? { ...c, outcome: "failed" as const } : c));
    t.hooks.onPage = () => {
      t.prs.get(1)!.head = "head1b";
      t.prs.get(1)!.checks = checks.map((c, i) => (i === 140 ? { ...c, outcome: "failed" as const } : c));
    };
    await t.poll();
    expect(t.giveWork).not.toHaveBeenCalled();
    expect(wakeRows(t)).toEqual([]);
    expect(t.warn).toHaveBeenCalledWith(expect.stringContaining("its head moved from head1a while its checks were read"));
    await t.poll();
    expect(t.giveWork).toHaveBeenCalledTimes(1);
    expect(t.giveWork.mock.calls[0]![2]).toContain("at head head1b");
    expect(t.giveWork.mock.calls[0]![2]).toContain("Checks failed: c140.");
  });
});

/** An assignment for a worker of the setup's Adventure, as the service records one; its A#. */
const assign = (t: ReturnType<typeof setup>, workerNum: number, briefText: string, state: "running" | "cancelled" = "running") =>
  t.store.createAssignment({
    projectId: "eq", workerNum, taskNums: [], route: "continue", role: "work", workKind: "implementation", threadId: `thr_w${workerNum}`, generation: 1,
    profile: { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high", serviceTier: "default" } as never,
    bbProjectId: "proj_eq", environmentId: null, state, opId: `op_${workerNum}_${briefText.length}`, opState: "done", briefText, reviewOf: null, rationale: null,
  });

describe("W549 one source per wake (D552)", () => {
  it("never mixes a list on head A with a watch read on head B: A's conflict is no news for B", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.start();
    // The list shows head A conflicting (which calls for a read); the read already sees a push
    // to B, which merges cleanly and fails its own check.
    t.prs.get(1)!.mergeable = "CONFLICTING";
    t.hooks.onWatch = () => {
      Object.assign(t.prs.get(1)!, { head: "head1b", mergeable: "MERGEABLE", checks: [{ name: "e2e", outcome: "failed" }] });
    };
    await t.poll();
    expect(t.giveWork).toHaveBeenCalledTimes(1);
    const text = t.giveWork.mock.calls[0]![2];
    expect(text).toMatch(/at head head1b[\s\S]*Checks failed: e2e\./);
    expect(text).not.toContain("conflicts");
    expect(t.ledger.row(prUrl(1))?.state).toMatchObject({ head: "head1b", mergeable: "mergeable" });
    // B conflicting later is news, from B's own read.
    t.prs.get(1)!.mergeable = "CONFLICTING";
    await t.poll();
    expect(t.giveWork).toHaveBeenCalledTimes(2);
    expect(t.giveWork.mock.calls[1]![2]).toMatch(/at head head1b[\s\S]*It conflicts with its base branch\./);
  });

  it("reads a PR whose list starts or stops conflicting, not one GitHub only recomputes", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.start();
    const watchReads = () => t.requests.filter((r) => r.kind === "watch").length;
    const before = watchReads();
    t.prs.get(1)!.mergeable = "UNKNOWN";
    await t.poll();
    t.prs.get(1)!.mergeable = "MERGEABLE";
    await t.poll();
    expect(watchReads()).toBe(before);
    t.prs.get(1)!.mergeable = "CONFLICTING";
    await t.poll();
    expect(watchReads()).toBe(before + 1);
    expect(t.giveWork.mock.calls[0]![2]).toContain("It conflicts with its base branch.");
  });

  it("never resumes or gives work to a worker its user stopped: Stop cancels its work, which routes the wake to the coordinator", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.start();
    // What Stop leaves (cancelAssignment): the work cancelled with its cancel request; userStopped untouched.
    const stopped = assign(t, 1, "Do the thing.", "cancelled");
    t.store.updateAssignment("eq", stopped.num, { cancelRequested: true });
    expect(t.store.worker("eq", 1)?.userStopped).toBe(false);
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    await t.poll();
    expect(t.giveWork).not.toHaveBeenCalled();
    expect(t.sent()).toEqual([expect.objectContaining({ to: "thr_c" })]);
    expect(t.sent()[0]!.text).toContain("W1 was stopped:");
    // Its lead gives it new work: the next wake is its own again.
    assign(t, 1, "Carry on.");
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }, { name: "lint", outcome: "failed" }];
    await t.poll();
    expect(t.sent().at(-1)).toMatchObject({ to: "thr_w1", mode: "steer-if-active" });
  });

  it("holds a wake when a Stop lands while routing waits on BB", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.start();
    const running = assign(t, 1, "Do the thing.");
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    // Stop's first write, before BB stops the thread: the cancel request.
    t.hooks.onThread = () => t.store.updateAssignment("eq", running.num, { cancelRequested: true });
    await t.poll();
    expect(t.sent()).toEqual([]);
    expect(wakeRows(t).map((w) => w.state)).toEqual(["pending"]);
    // Routed again on the next pass: to the coordinator.
    await t.poll();
    expect(t.sent()).toEqual([expect.objectContaining({ to: "thr_c" })]);
    expect(t.giveWork).not.toHaveBeenCalled();
  });

  it("reroutes to the coordinator when the watching thread is no longer the Adventure's, and wakes a coordinator that watches", async () => {
    const t = setup({ prs: [fakePr(1), fakePr(2, { head: "head2a" })] });
    await t.poll(0);
    await t.watch(1, "thr_gone");
    await t.watch(2, "thr_c");
    for (const n of [1, 2]) t.prs.get(n)!.checks = [{ name: "tests", outcome: "failed" }];
    await t.poll();
    expect(t.giveWork).not.toHaveBeenCalled();
    expect(t.sent()).toHaveLength(1);
    const [message] = t.sent();
    expect(message).toMatchObject({ to: "thr_c", mode: "queue-if-active" });
    expect(message!.text).toContain("The thread that watches it (thr_gone) is no longer this Adventure's coordinator or one of its workers:");
    expect(message!.text).toMatch(/PRs you watch:\n\nequisafe\/market#2/);
    expect(wakeRows(t).map((w) => w.routed)).toEqual([
      "coordinator: the thread that watches it (thr_gone) is no longer this Adventure's coordinator or one of its workers; its own watch",
      "coordinator: the thread that watches it (thr_gone) is no longer this Adventure's coordinator or one of its workers; its own watch",
    ]);
  });
  it("never watches a PR by ownership: an owned PR nobody watched is never read and wakes nobody", async () => {
    const t = setup({ prs: [fakePr(1)] });
    t.owners.move(prUrl(1), "eq", t.clock.now);
    await t.poll(0);
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    t.prs.get(1)!.mergeable = "CONFLICTING";
    await t.poll();
    await t.poll(UNLISTED_READ_MS);
    expect(t.requests.filter((r) => r.kind === "watch")).toEqual([]);
    expect(t.ledger.row(prUrl(1))).toBeNull();
    expect(wakeRows(t)).toEqual([]);
    expect(t.sent()).toEqual([]);
    expect(t.giveWork).not.toHaveBeenCalled();
  });
  it("reads no PR for a wake a pause holds, and one read confirms it once resumed", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.start();
    t.store.updateProject("eq", { paused: true });
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    await t.poll();
    const watchReads = () => t.requests.filter((r) => r.kind === "watch").length;
    const held = watchReads();
    await t.poll();
    await t.poll();
    expect(watchReads()).toBe(held);
    t.store.updateProject("eq", { paused: false });
    await t.poll();
    expect(watchReads()).toBe(held + 1);
    expect(t.giveWork).toHaveBeenCalledTimes(1);
  });
});

describe("W549 review r1 regressions", () => {
  it("holds a message wake when the worker's open assignment closed while routing waited on BB", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.start();
    const open = assign(t, 1, "Do it.");
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    // Routed as a message within A1; A1 is accepted during the cold-cache check.
    t.coldCheck.mockImplementationOnce(async () => {
      t.store.updateAssignment("eq", open.num, { state: "accepted" });
      return null;
    });
    await t.poll();
    expect(t.sent()).toEqual([]);
    expect(wakeRows(t).map((w) => w.state)).toEqual(["pending"]);
    // Routed again: W1 has no open work now, so it gets the wake as new work.
    await t.poll();
    expect(t.giveWork).toHaveBeenCalledOnce();
    expect(t.giveWork.mock.calls[0]![1]).toBe("W1");
  });

  it("keeps a wake BB refused pending, so the next pass routes it again; gives up after a few refusals", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.start();
    t.threads.get("thr_w1")!.status = "active";
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    // Busy W1's thread is archived between routing and the send: BB answers 409.
    t.send.mockImplementationOnce(async () => {
      t.threads.get("thr_w1")!.archivedAt = t.clock.now;
      throw Object.assign(new Error("thread is archived"), { status: 409 });
    });
    await t.poll();
    expect(wakeRows(t).map((w) => w.state)).toEqual(["pending"]);
    await t.poll();
    expect(t.sent().map((m) => m.to)).toEqual(["thr_w1", "thr_c"]);
    expect(wakeRows(t)).toEqual([expect.objectContaining({ state: "sent", routed: "coordinator: W1's thread is archived" })]);

    // A send BB keeps refusing fails after WAKE_REFUSALS tries; an error that may have landed fails at once.
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }, { name: "lint", outcome: "failed" }];
    t.send.mockImplementation(async () => { throw Object.assign(new Error("no such thread"), { status: 404 }); });
    for (let i = 0; i < WAKE_REFUSALS; i++) await t.poll();
    // The last refusal tries one notice to the coordinator (refused here too: only a warning then).
    expect(t.send).toHaveBeenCalledTimes(3 + WAKE_REFUSALS);
    expect(t.sent().at(-1)!.text).toContain("so the plugin stopped trying");
    expect(t.warn.mock.calls.at(-1)![0]).toContain("could not tell Equisafe's coordinator about equisafe/market#1");
    expect(wakeRows(t).at(-1)).toMatchObject({ state: "failed", routed: "BB refused the send: no such thread" });
    await t.poll();
    expect(t.send).toHaveBeenCalledTimes(3 + WAKE_REFUSALS);
    t.prs.get(1)!.checks = [{ name: "e2e", outcome: "failed" }];
    t.send.mockImplementation(async () => { throw new Error("socket hang up"); });
    await t.poll();
    expect(wakeRows(t).at(-1)).toMatchObject({ state: "failed", routed: "socket hang up" });
  });

  it("wakes for a second conflict on one head after GitHub's recomputation resolved the first", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.start();
    t.prs.get(1)!.mergeable = "CONFLICTING";
    await t.poll();
    expect(t.giveWork).toHaveBeenCalledTimes(1);
    const watchReads = () => t.requests.filter((r) => r.kind === "watch").length;
    const before = watchReads();
    // Recomputing: no read, and the stored conflict stands.
    t.prs.get(1)!.mergeable = "UNKNOWN";
    await t.poll();
    expect(watchReads()).toBe(before);
    // Resolved: a read, which stores it; then the second conflict is news.
    t.prs.get(1)!.mergeable = "MERGEABLE";
    await t.poll();
    expect(watchReads()).toBe(before + 1);
    expect(t.ledger.row(prUrl(1))?.state?.mergeable).toBe("mergeable");
    t.prs.get(1)!.mergeable = "CONFLICTING";
    await t.poll();
    expect(t.giveWork).toHaveBeenCalledTimes(2);
    expect(t.giveWork.mock.calls[1]![2]).toContain("It conflicts with its base branch.");
  });

  it("reads and wakes a PR once when two Adventures list it", async () => {
    const t = setup({ prs: [fakePr(1)] });
    t.store.createProject({ id: "ui", name: "Equisafe UI", objective: "o", memberProjectIds: ["proj_eq"], coordinatorThreadId: "thr_c_ui" });
    await t.start();
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    const before = t.requests.length;
    await t.poll();
    expect(t.requests.slice(before).filter((r) => r.kind === "watch").reduce((sum, r) => sum + r.count, 0)).toBe(1);
    expect(wakeRows(t)).toHaveLength(1);
    expect(t.giveWork).toHaveBeenCalledOnce();
  });
});

describe("W551 PR watch P3s", () => {
  it("sends a wake to the coordinator while the worker's thread is stopping, not into the ending turn", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.start();
    assign(t, 1, "Do it.");
    t.threads.get("thr_w1")!.status = "stopping";
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    await t.poll();
    expect(t.sent()).toEqual([expect.objectContaining({ to: "thr_c", mode: "queue-if-active" })]);
    expect(t.sent()[0]!.text).toContain("W1's thread is stopping:");
    expect(t.sent()[0]!.text).toContain("send it to W1 (initiative_message work:true");
    expect(wakeRows(t)).toEqual([expect.objectContaining({ state: "sent", routed: "coordinator: W1's thread is stopping" })]);
  });

  it("tells the coordinator too when a Stop lands as the steer goes out", async () => {
    const t = setup({ prs: [fakePr(1), fakePr(2, { head: "head2a", branch: "bb/w2-thr_w2" })] });
    await t.start();
    assign(t, 1, "Do it.");
    t.threads.get("thr_w1")!.status = "active";
    t.threads.get("thr_w2")!.status = "active";
    for (const n of [1, 2]) t.prs.get(n)!.checks = [{ name: "tests", outcome: "failed" }];
    // W1: BB's Stop lands during the steer. W2: an Adventures Stop (its cancel request) during the steer.
    t.send.mockImplementation(async ({ threadId }) => {
      if (threadId === "thr_w1") t.threads.get("thr_w1")!.status = "stopping";
      if (threadId === "thr_w2") {
        t.store.updateAssignment("eq", assign(t, 2, "Other.").num, { cancelRequested: true });
        t.threads.get("thr_w2")!.status = "idle";
      }
      return { delivery: "sent" };
    });
    await t.poll();
    expect(t.sent().map((m) => m.to)).toEqual(["thr_w1", "thr_c", "thr_w2", "thr_c"]);
    expect(t.sent()[1]!.text).toContain("W1's thread was stopping as the plugin's message reached it, so it may not act on it:");
    expect(t.sent()[1]!.text).toContain('#1 "PR 1"');
    expect(t.sent()[1]!.text).toContain("send it to W1 (initiative_message work:true");
    expect(t.sent()[3]!.text).toContain("W2 was stopped as the plugin's message reached it, so it may not act on it:");
    expect(t.sent()[3]!.text).toContain('a fresh worker with handoffs:["W2"]');
    // BB took both messages: the wakes are sent to their workers, never again.
    expect(wakeRows(t).map((w) => [w.state, w.routed])).toEqual([
      ["sent", "W1: message (while it works; a Stop landed with it)"],
      ["sent", "W2: message (while it works; a Stop landed with it)"],
    ]);
  });

  it("never sends a wake BB took again when the coordinator's note about the Stop is refused", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.start();
    t.threads.get("thr_w1")!.status = "active";
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    t.send.mockImplementation(async ({ threadId }) => {
      if (threadId === "thr_c") throw Object.assign(new Error("Thread is not writable"), { status: 409 });
      t.threads.get("thr_w1")!.status = "stopping";
      return { delivery: "sent" };
    });
    await t.poll();
    expect(t.sent().map((m) => m.to)).toEqual(["thr_w1", "thr_c"]);
    expect(t.warn.mock.calls.at(-1)![0]).toContain("could not tell Equisafe's coordinator about equisafe/market#1");
    // W1 is back and idle: nothing is sent again.
    t.threads.get("thr_w1")!.status = "idle";
    await t.poll();
    await t.poll();
    expect(t.sent().map((m) => m.to)).toEqual(["thr_w1", "thr_c"]);
    expect(t.giveWork).not.toHaveBeenCalled();
    expect(wakeRows(t).map((w) => w.state)).toEqual(["sent"]);
  });

  it("takes back a message BB queued behind a Stop, so nothing reached the worker and it is routed afresh", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.start();
    t.threads.get("thr_w1")!.status = "active";
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    // The Stop lands between routing and the send: BB queues the message on its stopping wait.
    t.send.mockImplementationOnce(async () => {
      t.threads.get("thr_w1")!.status = "stopping";
      return { delivery: "queued", queuedMessage: { id: "q1" } };
    });
    await t.poll();
    expect(t.deleteQueued).toHaveBeenCalledWith({ threadId: "thr_w1", queuedMessageId: "q1" });
    expect(t.sent().map((m) => m.to)).toEqual(["thr_w1"]);
    expect(wakeRows(t).map((w) => w.state)).toEqual(["pending"]);
    // Still stopping next pass: the coordinator takes it, once.
    await t.poll();
    expect(t.sent().map((m) => m.to)).toEqual(["thr_w1", "thr_c"]);
    expect(t.sent()[1]!.text).toContain("W1's thread is stopping:");
    expect(wakeRows(t)).toEqual([expect.objectContaining({ state: "sent", routed: "coordinator: W1's thread is stopping" })]);

    // A queued row BB already sent can't be taken back: it reaches the worker, so the wake is sent and nobody else is told.
    t.threads.get("thr_w1")!.status = "active";
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }, { name: "lint", outcome: "failed" }];
    t.send.mockImplementationOnce(async () => {
      t.threads.get("thr_w1")!.status = "stopping";
      return { delivery: "queued", queuedMessage: { id: "q2" } };
    });
    t.deleteQueued.mockImplementationOnce(async () => { throw Object.assign(new Error("not found"), { status: 404 }); });
    await t.poll();
    expect(t.sent().map((m) => m.to)).toEqual(["thr_w1", "thr_c", "thr_w1"]);
    expect(wakeRows(t).at(-1)).toMatchObject({ state: "sent", routed: "W1: message (while it works, queued by BB behind a Stop)" });

    // A delete whose answer is lost may have taken it back or not: uncertain, never sent again, and the coordinator checks.
    t.threads.get("thr_w1")!.status = "active";
    t.prs.get(1)!.checks = [{ name: "e2e", outcome: "failed" }];
    t.send.mockImplementationOnce(async () => {
      t.threads.get("thr_w1")!.status = "stopping";
      return { delivery: "queued", queuedMessage: { id: "q3" } };
    });
    t.deleteQueued.mockImplementationOnce(async () => { throw new Error("socket hang up"); });
    await t.poll();
    expect(t.sent().map((m) => m.to)).toEqual(["thr_w1", "thr_c", "thr_w1", "thr_w1", "thr_c"]);
    expect(t.sent().at(-1)!.text).toContain("The plugin's message to W1, queued behind a Stop, may or may not have been taken back (socket hang up):");
    expect(t.sent().at(-1)!.text).toContain("Check W1's thread and its queue for it");
    expect(wakeRows(t).at(-1)).toMatchObject({ state: "uncertain", routed: "queued behind a Stop; taking it back failed: socket hang up" });
    t.threads.get("thr_w1")!.status = "idle";
    await t.poll();
    expect(t.send).toHaveBeenCalledTimes(5);
    expect(t.giveWork).not.toHaveBeenCalled();
  });

  it("sends no Stop's note for a PR unwatched while the plugin read the thread again", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.start();
    t.threads.get("thr_w1")!.status = "active";
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    t.send.mockImplementationOnce(async () => {
      t.threads.get("thr_w1")!.status = "stopping";
      t.hooks.onThread = () => t.ledger.unwatch(prUrl(1));
      return { delivery: "sent" };
    });
    await t.poll();
    expect(t.sent().map((m) => m.to)).toEqual(["thr_w1"]);
    expect(wakeRows(t).at(-1)).toMatchObject({ state: "sent" });
    expect(t.store.activity("eq").some((a) => /woke W1 about equisafe\/market#1, but .* Nobody is told: unwatched/.test(a.summary))).toBe(true);
  });
  it("records a steer BB queued instead of sending", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.start();
    t.threads.get("thr_w1")!.status = "active";
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    t.send.mockImplementationOnce(async () => ({ delivery: "queued" }));
    await t.poll();
    expect(t.sent().map((m) => m.to)).toEqual(["thr_w1"]);
    expect(wakeRows(t)).toEqual([expect.objectContaining({ state: "sent", routed: "W1: message (while it works, queued by BB)" })]);
  });

  it("tells the coordinator once, with BB's last answer, when it gives up on a wake BB keeps refusing", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.start();
    t.threads.get("thr_w1")!.status = "active";
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    t.send.mockImplementation(async ({ threadId }) => {
      if (threadId === "thr_w1") throw Object.assign(new Error("Thread is not writable"), { status: 409 });
      return { delivery: "sent" };
    });
    for (let i = 0; i < WAKE_REFUSALS; i++) await t.poll();
    expect(t.sent().map((m) => m.to)).toEqual([...Array(WAKE_REFUSALS).fill("thr_w1"), "thr_c"]);
    const notice = t.sent().at(-1)!;
    expect(notice.mode).toBe("queue-if-active");
    expect(notice.text).toContain(`BB refused the plugin's wake about equisafe/market#1 (W1) ${WAKE_REFUSALS} times, so the plugin stopped trying`);
    expect(notice.text).toContain("BB's last answer: Thread is not writable");
    expect(notice.text).toContain("Checks failed: tests.");
    expect(wakeRows(t)).toEqual([expect.objectContaining({ state: "failed", routed: "BB refused the send: Thread is not writable" })]);
    expect(t.store.activity("eq").some((a) => a.kind === "pr-watch" && /gave up on equisafe\/market#1 \(W1\)/.test(a.summary))).toBe(true);
    // No more tries, and no second notice.
    await t.poll();
    expect(t.send).toHaveBeenCalledTimes(WAKE_REFUSALS + 1);
  });

  it("judges each wake again before the coordinator's note: one unwatched meanwhile is left out", async () => {
    const t = setup({ prs: [fakePr(1), fakePr(2, { head: "head2a" })] });
    await t.start();
    t.threads.get("thr_w1")!.status = "active";
    for (const n of [1, 2]) t.prs.get(n)!.checks = [{ name: "tests", outcome: "failed" }];
    let tries = 0;
    t.send.mockImplementation(async ({ threadId }) => {
      if (threadId !== "thr_w1") return { delivery: "sent" };
      // While the last refused send of both waits on BB, PR 2 is unwatched.
      if (++tries === WAKE_REFUSALS) t.ledger.unwatch(prUrl(2));
      throw Object.assign(new Error("Thread is not writable"), { status: 409 });
    });
    for (let i = 0; i < WAKE_REFUSALS; i++) await t.poll();
    expect(t.sent().map((m) => m.to)).toEqual([...Array(WAKE_REFUSALS).fill("thr_w1"), "thr_c"]);
    expect(t.sent().at(-1)!.text).toContain("equisafe/market#1");
    expect(t.sent().at(-1)!.text).not.toContain("equisafe/market#2");
    expect(t.store.activity("eq").some((a) => /gave up on equisafe\/market#2 \(W1\).*Nobody is told: unwatched/.test(a.summary))).toBe(true);
  });
  it("gives up on a coordinator's own watch like any other: logged, told once", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.poll(0);
    await t.watch(1, "thr_c");
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    t.send.mockImplementation(async () => { throw Object.assign(new Error("Thread is not writable"), { status: 409 }); });
    for (let i = 0; i < WAKE_REFUSALS; i++) await t.poll();
    expect(t.sent().map((m) => m.to)).toEqual(Array(WAKE_REFUSALS + 1).fill("thr_c"));
    expect(t.sent().at(-1)!.text).toContain("equisafe/market#1 (the coordinator)");
    expect(wakeRows(t)).toEqual([expect.objectContaining({ state: "failed" })]);
    await t.poll();
    expect(t.send).toHaveBeenCalledTimes(WAKE_REFUSALS + 1);
  });
});

describe("W554 explicit watches", () => {
  it("answers a watch with the PR as it is (checks, conflict, review), which wakes nobody later", async () => {
    const t = setup({ prs: [fakePr(1, {
      checks: [{ name: "tests", outcome: "failed" }, { name: "lint", outcome: "pending" }], mergeable: "CONFLICTING",
      decision: "CHANGES_REQUESTED", threads: [false, false, true],
    })] });
    await t.poll(0);
    const before = t.requests.length;
    const { facts, replaced } = await t.watch(1);
    expect(t.requests.slice(before).map((r) => r.kind)).toEqual(["watch"]);
    expect(replaced).toBeNull();
    expect(watchAnswer(prUrl(1), facts, "you", null)).toEqual({
      watching: prUrl(1), title: "PR 1", wakes: "you",
      now: { head: "head1a", checks: "failing: tests; 1 check pending", mergeable: "conflicting", review: "changes_requested", unresolvedThreads: "2" },
      attention: "Checks failing: tests. It conflicts with its base branch. Changes are requested. 2 unresolved review threads. The watch wakes only on later changes: handle these now.",
      note: "Wakes you on newly failing checks, required checks passing, new comments or reviews by others, a conflict, or no check 15 min after a push; ends when the PR merges or closes, or with initiative_pr_unwatch.",
    });
    expect(t.ledger.row(prUrl(1))).toMatchObject({ watcher: "thr_w1", projectId: "eq", state: { failing: ["tests"], mergeable: "conflicting" } });
    await t.poll();
    await t.poll(WATCH_RESYNC_MS);
    expect(wakeRows(t)).toEqual([]);
    // A clean PR needs nothing now.
    const clean = watchAnswer(prUrl(1), { ...facts, checks: [{ name: "tests", outcome: "passed", required: false }], mergeable: "mergeable", review: { decision: "approved", unresolved: 0, more: false } }, "W2", "W1");
    expect(clean).toMatchObject({ wakes: "W2", replaced: "W1 watched it before; W2 does now.", now: { checks: "all passed (1 check)", review: "approved", unresolvedThreads: "0" } });
    expect(clean).not.toHaveProperty("attention");
    // Past 100 review threads, all resolved as far as read: the rest may not be, so it says to look.
    const many = watchAnswer(prUrl(1), { ...facts, checks: [{ name: "tests", outcome: "passed", required: false }], mergeable: "mergeable", review: { decision: "approved", unresolved: 0, more: true } }, "you", null);
    expect(many).toMatchObject({ now: { unresolvedThreads: "0+" }, attention: "Only its first 100 review threads were read: check the rest on GitHub. The watch wakes only on later changes: handle these now." });
  });

  it("watches a PR no list shows: finds its node id, reads it every UNLISTED_READ_MS, and wakes its watcher", async () => {
    const t = setup({ prs: [fakePr(1), fakePr(7, { unlisted: true })] });
    await t.poll(0);
    expect(t.cache.cachedPr(prUrl(7))).toBeNull();
    const before = t.requests.length;
    await t.watch(7, "thr_w2");
    expect(t.requests.slice(before).map((r) => r.kind)).toEqual(["id", "watch"]);
    t.prs.get(7)!.checks = [{ name: "tests", outcome: "failed" }];
    await t.poll();
    expect(t.giveWork).not.toHaveBeenCalled();
    await t.poll(UNLISTED_READ_MS);
    expect(t.giveWork).toHaveBeenCalledOnce();
    expect(t.giveWork.mock.calls[0]![1]).toBe("W2");
    expect(t.giveWork.mock.calls[0]![2]).toMatch(/equisafe\/market#7 "PR 7" at head head7a[\s\S]*Checks failed: tests\./);
  });

  it("refuses to watch a PR merged, closed or unknown to GitHub", async () => {
    const t = setup({ prs: [fakePr(1, { state: "MERGED" }), fakePr(2, { state: "CLOSED" })] });
    await t.poll(0);
    await expect(t.watch(1)).rejects.toThrow(`${prUrl(1)} is merged: there is nothing to watch.`);
    await expect(t.watch(2)).rejects.toThrow(`${prUrl(2)} is closed: there is nothing to watch.`);
    await expect(t.watcher.watch(prUrl(99), "eq", "thr_w1")).rejects.toThrow(`GitHub has no PR at ${prUrl(99)}`);
    expect(t.ledger.row(prUrl(1))).toBeNull();
  });

  it("takes one watcher per PR: a new watch replaces the old one, and unwatch only clears the watcher it names", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.start();
    const { replaced } = await t.watch(1, "thr_w2");
    expect(replaced).toMatchObject({ watcher: "thr_w1" });
    expect(readPrWatch(t.store, t.ledger, prUrl(1)).watcher).toEqual({ label: "W2", projectId: "eq", adventure: "Equisafe" });
    expect(t.ledger.unwatch(prUrl(1), "thr_w1")).toBe(false);
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    await t.poll();
    expect(t.giveWork.mock.calls.map((c) => c[1])).toEqual(["W2"]);
    expect(t.ledger.unwatch(prUrl(1), "thr_w2")).toBe(true);
    expect(readPrWatch(t.store, t.ledger, prUrl(1)).watcher).toBeNull();
    // The previous build reads an unwatched PR as muted.
    expect(t.db.prepare("SELECT muted FROM pr_watches WHERE url = ?").pluck().get(prUrl(1))).toBe(1);
  });

  it("leaves a W548 watch made from ownership unwatched: never read, no wake", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.poll(0);
    // As the previous build left it: a state, no watcher.
    t.db.prepare("INSERT INTO pr_watches (url, project_id, node_id, muted, since, state, gen, updated_at) VALUES (?, 'eq', ?, 0, ?, ?, 0, ?)")
      .run(prUrl(1), prUrl(1), T0, JSON.stringify(baselineState(parseWatch({ state: "OPEN", headRefOid: "head1a" })!, T0, "")), T0);
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    await t.poll();
    await t.poll(UNLISTED_READ_MS);
    expect(t.requests.filter((r) => r.kind === "watch")).toEqual([]);
    expect(wakeRows(t)).toEqual([]);
    expect(readPrWatch(t.store, t.ledger, prUrl(1)).watcher).toBeNull();
  });
});

describe("W554 review r1 regressions", () => {
  it("learns a repository's CI from watch reads: a watched PR no list shows wakes when a push reports no check", async () => {
    const t = setup({ prs: [fakePr(7, { unlisted: true, checks: [{ name: "tests", outcome: "passed" }] })] });
    await t.poll(0);
    await t.watch(7, "thr_w1");
    t.prs.get(7)!.head = "head7b";
    t.prs.get(7)!.checks = [];
    await t.poll(UNLISTED_READ_MS);
    expect(t.ledger.row(prUrl(7))?.state).toMatchObject({ head: "head7b", noChecksDone: false });
    await t.poll(NO_CHECKS_MS);
    expect(t.giveWork).toHaveBeenCalledOnce();
    expect(t.giveWork.mock.calls[0]![2]).toContain("No check has reported 15 min after the push of head7b.");
  });

  it("learns the gh account from watch reads when no list has: others' comments wake, its own never do", async () => {
    const t = setup({ prs: [fakePr(7, { unlisted: true })] });
    await t.poll(0);
    vi.spyOn(t.cache, "login", "get").mockReturnValue(null);
    await t.watch(7, "thr_w1");
    t.prs.get(7)!.comments = [
      { url: "https://c/mine", at: t.clock.now + 1, login: "erwinkn" },
      { url: "https://c/bot", at: t.clock.now + 2, login: "coderabbitai", bot: true },
    ];
    await t.poll(UNLISTED_READ_MS);
    expect(t.giveWork).toHaveBeenCalledOnce();
    expect(t.giveWork.mock.calls[0]![2]).toContain("coderabbitai (bot): https://c/bot");
    expect(t.giveWork.mock.calls[0]![2]).not.toContain("https://c/mine");
  });

  it("mutes a W548 row on an unwatch without a watcher named, so a rollback leaves it alone; a named one leaves it", async () => {
    const t = setup({ prs: [fakePr(1)] });
    t.db.prepare("INSERT INTO pr_watches (url, project_id, node_id, muted, since, state, gen, updated_at) VALUES (?, 'eq', ?, 0, ?, NULL, 0, ?)").run(prUrl(1), prUrl(1), T0, T0);
    expect(t.ledger.unwatch(prUrl(1), "thr_w1")).toBe(false);
    expect(t.ledger.row(prUrl(1))?.muted).toBe(false);
    expect(t.ledger.unwatch(prUrl(1))).toBe(true);
    expect(t.ledger.row(prUrl(1))?.muted).toBe(true);
    expect(t.ledger.unwatch(prUrl(1))).toBe(false);
  });
});

describe("W548 wiring", () => {
  it("gives the wake to an idle worker as a lead's work message, from the coordinator", async () => {
    const { f, project } = await projectFixture();
    const [w] = JSON.parse(await f.harness.callAgentTool("initiative_spawn", { label: "Search", purpose: "search", text: "Do it." }, { threadId: "coordinator" }) as string);
    await f.harness.callAgentTool("initiative_report", { outcome: "done", summary: "Done.", report: "Done." }, { threadId: w.threadId });
    await f.runtime.onThreadIdle(f.idle(w.threadId));
    const before = f.store.assignments(project.id).length;
    const ref = await f.prWatchWork(project.id, "W1", "PR watch (sent by the Adventures plugin, not your lead): checks failed.");
    expect(ref).toMatch(/^A\d+$/);
    expect(f.store.assignments(project.id).length).toBe(before + 1);
    const call = f.send.mock.calls.at(-1)![0] as { threadId: string; senderThreadId?: string; input: { text: string }[] };
    expect(call.threadId).toBe(w.threadId);
    expect(call.senderThreadId).toBe("coordinator");
    expect(call.input[0]!.text).toContain("PR watch (sent by the Adventures plugin, not your lead): checks failed.");
    expect(call.input[0]!.text).toContain("watch it with initiative_pr_watch");
  });

  it("checks a wake once more just before the work is recorded, after the dispatch's reads", async () => {
    const { f, project } = await projectFixture();
    const [w] = JSON.parse(await f.harness.callAgentTool("initiative_spawn", { label: "Search", purpose: "search", text: "Do it." }, { threadId: "coordinator" }) as string);
    await f.harness.callAgentTool("initiative_report", { outcome: "done", summary: "Done.", report: "Done." }, { threadId: w.threadId });
    await f.runtime.onThreadIdle(f.idle(w.threadId));
    const before = f.store.assignments(project.id).length;
    const sends = f.send.mock.calls.length;
    let checks = 0;
    // Unwatched while the dispatch read BB: the first check passes, the last one doesn't.
    await expect(f.prWatchWork(project.id, "W1", "PR watch: checks failed.", () => {
      if (++checks > 1) throw new Error("unwatched meanwhile");
    })).rejects.toThrow("unwatched meanwhile");
    expect(checks).toBe(2);
    expect(f.store.assignments(project.id).length).toBe(before);
    expect(f.send.mock.calls.length).toBe(sends);
  });

  it("tells workers to watch their PRs and never to wait on CI, within the guidance cap", () => {
    expect(DEFAULT_WORKER_INSTRUCTIONS).toContain("After you open or push a PR, watch it with initiative_pr_watch; unwatch it (initiative_pr_unwatch) once you hand it off or stop caring.");
    expect(DEFAULT_WORKER_INSTRUCTIONS).toContain("Never wait on CI with sleep, loops, `gh pr checks --watch`, Monitor or ScheduleWakeup: the watch wakes you when your PR changes.");
    expect(DEFAULT_WORKER_INSTRUCTIONS.length).toBeLessThanOrEqual(MAX_GUIDANCE_CHARACTERS);
    // W548's text is a legacy default: saved unedited, it upgrades to this one.
    expect(PREVIOUS_DEFAULTS.worker[0]).toContain("the plugin wakes you when your PR changes.");
  });
});
