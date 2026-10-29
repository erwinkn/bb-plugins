// W548: PR watches. Every open PR an Adventure owns is diffed against the last state the watcher
// saw; a change wakes its owner (worker, or coordinator), once, across reloads too.
import { describe, expect, it, vi } from "vitest";
import { memoryStore } from "./helpers";
import { projectFixture } from "./fake-native";
import { rollup, searchPage, withId } from "./gh-fixtures";
import { GH_LIST_QUERY, parsePullRequests } from "../lib/merge-queue";
import { DETAILS_CONCURRENCY, IDLE_REFRESH_MS, MergeQueueCache, REFRESH_MS, type GraphQl } from "../lib/merge-queue-server";
import { PrOwners, ledgerThreads } from "../lib/pr-owners";
import { AssignedPrs } from "../lib/pr-records";
import {
  COMMENT_WAKE_CAP, NOT_A_MERGE, NO_CHECKS_MS, PrWatcher, WATCH_PAGE, WatchLedger, diffWatch, parseWatch, readPrWatch,
  type WatchFacts, type WatchState,
} from "../lib/pr-watch";
import type { Sdk } from "../lib/bb";
import { blankPrRecord } from "../lib/pr-stages";
import { WATCH_RESYNC_MS, CHECKS_PAST_100, CHECKS_PAGE_QUERY, WAKE_REFUSALS, ownerNow } from "../lib/pr-watch";
import { DEFAULT_WORKER_INSTRUCTIONS } from "../lib/guidance";
import { MAX_GUIDANCE_CHARACTERS } from "../lib/settings";

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 28, 12);

// The diff ------------------------------------------------------------------------

const facts = (over: Partial<WatchFacts> = {}): WatchFacts => ({
  state: "OPEN", head: "aaa", mergeable: "mergeable", createdAt: T0 - 60 * MINUTE,
  checks: [{ name: "tests", outcome: "passed", required: false }, { name: "lint", outcome: "pending", required: false }],
  comments: [], ...over,
});
const ctx = (over: Partial<Parameters<typeof diffWatch>[2]> = {}) => ({ now: T0, since: T0 - 10 * MINUTE, login: "erwinkn", repoHasChecks: true, fingerprint: "f1", ...over });
/** The state after a baseline of `f`. */
const base = (f = facts()) => diffWatch(null, f, ctx()).state;
const kinds = (r: { changes: { kind: string }[] }) => r.changes.map((c) => c.kind);

describe("W548 diffWatch", () => {
  it("takes a PR opened before the watches as a baseline: its old state wakes nobody", () => {
    const r = diffWatch(null, facts({ mergeable: "conflicting", checks: [{ name: "tests", outcome: "failed", required: false }], comments: [{ url: "u", at: T0 - 20 * MINUTE, author: "coderabbitai", bot: true, review: null }] }), ctx());
    expect(r.changes).toEqual([]);
    expect(r.state).toMatchObject({ head: "aaa", failing: ["tests"], mergeable: "conflicting", seenUntil: T0 - 20 * MINUTE, pushedAt: null, noChecksDone: true });
  });

  it("takes a PR opened since from nothing: its failing checks, conflict and comments are news", () => {
    const r = diffWatch(null, facts({
      createdAt: T0 - 5 * MINUTE, mergeable: "conflicting",
      checks: [{ name: "tests", outcome: "failed", required: false }],
      comments: [{ url: "c1", at: T0 - 4 * MINUTE, author: "coderabbitai", bot: true, review: "changes_requested" }],
    }), ctx());
    expect(kinds(r)).toEqual(["checks-failed", "new-comments", "conflicting"]);
    expect(r.state.pushedAt).toBe(T0 - 5 * MINUTE);
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
const watchNode = (pr: FakePr) => ({
  id: prUrl(pr.number), number: pr.number, state: pr.state, headRefOid: pr.head, mergeable: pr.mergeable, createdAt: iso(pr.createdAt),
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
  const requests: { kind: "list" | "watch" | "details"; count: number }[] = [];
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
        return searchPage([...prs.values()].filter((pr) => pr.state === "OPEN").map(listNode));
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
        return Object.fromEntries(ids.map((k) => {
          const number = Number(/pull\/(\d+)$/.exec(String(variables[k]))![1]);
          const pr = prs.get(number);
          return [`p${k.slice(1)}`, pr ? watchNode(pr) : null];
        }));
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
    const watcher = new PrWatcher({ store, ledger, cache, sdk, coldCheck, giveWork, changed, warn, ownerOf: (url) => ownerNow(url, {
      recorded: (key) => owners.recorded(key), cachedPr: (key) => cache.cachedPr(key), assignedWorker: (projectId, key) => assigned.naming(projectId, key)?.worker ?? null,
      recordWorker: (projectId, key) => ledger.recordWorker(projectId, key), threadWorker: (projectId, thread) => ledger.threadWorker(projectId, thread),
    }) }, () => clock.now);
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
  return {
    store, db, clock, prs, gh, requests, hooks, peak: () => peak, owners, assigned, sdk, send, deleteQueued, sent, threads, coldCheck, giveWork, changed, warn, listed, poll,
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
  it("takes the first pass as a baseline, then wakes the PR's idle worker once with more work naming the change and head", async () => {
    const t = setup({ prs: [fakePr(1, { checks: [{ name: "old", outcome: "failed" }] })] });
    await t.poll(0);
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
    await t.poll(0);
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
    await t.poll(0);
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
    await t.poll(0);
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
    await t.poll(0);
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    await t.poll();
    expect(t.giveWork).toHaveBeenCalledTimes(1);

    // Reload: the same failure is not news again.
    t.reload();
    await t.poll(0);
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

  it("sends a wake still pending at a reload once it is listed and a watch read confirms its head", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.poll(0);
    t.store.updateProject("eq", { paused: true });
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    await t.poll();
    t.reload();
    t.store.updateProject("eq", { paused: false });
    // The reloaded cache has no list yet: the wake waits for one.
    t.clock.now += MINUTE;
    await t.watcher.check();
    expect(wakeRows(t).map((w) => w.state)).toEqual(["pending"]);
    await t.cache.settled();
    await t.watcher.check();
    expect(wakeRows(t).map((w) => w.state)).toEqual(["sent"]);
    expect(t.giveWork).toHaveBeenCalledTimes(1);
  });

  it("wakes nobody while muted, and starts from the PR as it is when unmuted", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.poll(0);
    t.ledger.setMuted(prUrl(1), "eq", true);
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    await t.poll();
    expect(t.requests.filter((r) => r.kind === "watch")).toHaveLength(1);
    expect(readPrWatch(t.ledger, prUrl(1), true)).toMatchObject({ watched: true, muted: true });
    t.ledger.setMuted(prUrl(1), "eq", false);
    await t.poll();
    expect(t.giveWork).not.toHaveBeenCalled();
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }, { name: "lint", outcome: "failed" }];
    await t.poll();
    expect(t.giveWork).toHaveBeenCalledTimes(1);
    expect(t.giveWork.mock.calls[0]![2]).toContain("Checks failed: lint.");
  });

  it("ends a merged PR's watch without waking anyone", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.poll(0);
    t.prs.get(1)!.state = "MERGED";
    await t.poll();
    expect(t.ledger.row(prUrl(1))?.state?.ended).toBe("MERGED");
    expect(wakeRows(t)).toEqual([]);
    expect(t.sent()).toEqual([]);
    expect(readPrWatch(t.ledger, prUrl(1), false)).toMatchObject({ watched: false, ended: "MERGED" });
  });

  it("stops waking for comments after the cap and says so in the activity", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.poll(0);
    for (let i = 1; i <= COMMENT_WAKE_CAP + 1; i++) {
      t.prs.get(1)!.comments.push({ url: `https://c/${i}`, at: t.clock.now + 1, login: "coderabbitai", bot: true });
      t.prs.get(1)!.updatedAt = t.clock.now + 1;
      await t.poll();
    }
    expect(t.giveWork).toHaveBeenCalledTimes(COMMENT_WAKE_CAP);
    expect(t.store.activity("eq").some((a) => /woke nobody after 10 comment-only wakes/.test(a.summary))).toBe(true);
    expect(readPrWatch(t.ledger, prUrl(1), true).commentWakes).toBe(COMMENT_WAKE_CAP);
  });

  it(`reads changed PRs ${WATCH_PAGE} a request in the details slots, and keeps a watched Adventure on the 2-minute cadence`, async () => {
    const prs = Array.from({ length: 60 }, (_, i) => fakePr(i + 1, { head: `h${i + 1}` }));
    const t = setup({ prs });
    await t.poll(0);
    const watch = t.requests.filter((r) => r.kind === "watch");
    expect(watch.map((r) => r.count)).toEqual([25, 25, 10]);
    expect(t.peak()).toBeLessThanOrEqual(DETAILS_CONCURRENCY);
    // Watched: a list read every 2 minutes, a watch read only for what moved.
    const before = t.requests.length;
    await t.poll(REFRESH_MS);
    expect(t.requests.slice(before).filter((r) => r.kind !== "details").map((r) => r.kind)).toEqual(["list"]);
    // Every PR muted: back to the idle cadence (one more pass learns it).
    for (const pr of prs) t.ledger.setMuted(prUrl(pr.number), "eq", true);
    await t.poll(REFRESH_MS);
    const muted = t.requests.length;
    await t.poll(REFRESH_MS);
    expect(t.requests.length).toBe(muted);
    await t.poll(IDLE_REFRESH_MS - REFRESH_MS);
    expect(t.requests.slice(muted).filter((r) => r.kind !== "details").map((r) => r.kind)).toEqual(["list"]);
  });

  it("retries a failed watch read later, in smaller requests, without diffing on stale facts", async () => {
    const t = setup({ prs: [fakePr(1), fakePr(2, { head: "head2a" })] });
    const real = t.gh.getMockImplementation()!;
    t.gh.mockImplementation(async (query, variables, timeout) => {
      if (query.includes("isRequired(pullRequestId")) throw new Error("502 Bad Gateway");
      return real(query, variables, timeout);
    });
    await t.poll(0);
    expect(t.ledger.rows().size).toBe(0);
    expect(t.warn).toHaveBeenCalledWith(expect.stringContaining("PR watch read of 2 PRs failed: 502 Bad Gateway"));
    t.gh.mockImplementation(real);
    await t.poll();
    expect(t.requests.filter((r) => r.kind === "watch").map((r) => r.count)).toEqual([1, 1]);
    expect(t.ledger.rows().size).toBe(2);
    expect(t.giveWork).not.toHaveBeenCalled();
  });
});


describe("W548 review r1 regressions", () => {
  it("rechecks a wake just before it is sent: a mute, a pause or a retire while routing waits on BB holds it", async () => {
    for (const change of ["mute", "pause", "retire"] as const) {
      const t = setup({ prs: [fakePr(1)] });
      await t.poll(0);
      t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
      t.hooks.onThread = () => {
        if (change === "mute") t.ledger.setMuted(prUrl(1), "eq", true);
        if (change === "pause") t.store.updateProject("eq", { paused: true });
        if (change === "retire") t.store.updateWorker("eq", 1, { state: "retired" });
      };
      await t.poll();
      expect(t.giveWork, change).not.toHaveBeenCalled();
      expect(t.sent(), change).toEqual([]);
      expect(wakeRows(t).map((w) => w.state), change).toEqual([change === "mute" ? "muted" : "pending"]);
    }
  });

  it("rechecks inside the serialized work step too", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.poll(0);
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    t.giveWork.mockImplementation(async (_p, _r, _t, still) => {
      t.ledger.setMuted(prUrl(1), "eq", true);
      still();
      return "A7";
    });
    await t.poll();
    expect(wakeRows(t).map((w) => w.state)).toEqual(["muted"]);
  });

  it("drops a pass's write and a held wake from before a mute and unmute", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.poll(0);
    // Mute and unmute while the watch read is out: the pass's old snapshot doesn't land.
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    t.hooks.onWatch = () => {
      t.ledger.setMuted(prUrl(1), "eq", true);
      t.ledger.setMuted(prUrl(1), "eq", false);
    };
    await t.poll();
    expect(wakeRows(t)).toEqual([]);
    expect(t.ledger.row(prUrl(1))?.state).toBeNull();
    // The next pass is a baseline from the PR as it is.
    await t.poll();
    expect(t.giveWork).not.toHaveBeenCalled();

    // A wake held by a pause, then a mute and unmute: it no longer applies.
    t.store.updateProject("eq", { paused: true });
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }, { name: "lint", outcome: "failed" }];
    await t.poll();
    expect(wakeRows(t).map((w) => w.state)).toEqual(["pending"]);
    t.ledger.setMuted(prUrl(1), "eq", true);
    t.ledger.setMuted(prUrl(1), "eq", false);
    t.store.updateProject("eq", { paused: false });
    await t.poll();
    expect(wakeRows(t).map((w) => w.state)).toEqual(["stale"]);
    expect(t.giveWork).not.toHaveBeenCalled();
  });

  it("sends a wake on what its watch read saw, whatever a list landing meanwhile shows; that list only calls for the next read", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.poll(0);
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

  it("drops a held wake for a PR no Adventure owns any more", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.poll(0);
    t.store.updateProject("eq", { paused: true });
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    await t.poll();
    t.owners.move(prUrl(1), null, t.clock.now);
    t.store.updateProject("eq", { paused: false });
    await t.poll();
    expect(wakeRows(t)).toEqual([expect.objectContaining({ state: "stale", routed: "no Adventure owns it now" })]);
  });

  it("reads a PR again after WATCH_RESYNC_MS even when its list facts stay (two reruns that swap outcomes)", async () => {
    const t = setup({ prs: [fakePr(1, { checks: [{ name: "tests", outcome: "failed" }, { name: "lint", outcome: "passed" }] })] });
    await t.poll(0);
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "passed" }, { name: "lint", outcome: "failed" }];
    await t.poll();
    expect(t.giveWork).not.toHaveBeenCalled();
    await t.poll(WATCH_RESYNC_MS);
    expect(t.giveWork).toHaveBeenCalledTimes(1);
    expect(t.giveWork.mock.calls[0]![2]).toContain("Checks failed: lint.");
  });

  it("keeps a repository's CI evidence: its only PR pushed without checks wakes, across a reload too", async () => {
    const t = setup({ prs: [fakePr(1, { checks: [{ name: "tests", outcome: "passed" }] })] });
    await t.poll(0);
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
    await t.poll(0);
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
    await t.poll(0);
    for (const n of [1, 2]) t.prs.get(n)!.checks = [{ name: "tests", outcome: "failed" }];
    t.hooks.onThread = () => t.ledger.setMuted(prUrl(1), "eq", true);
    await t.poll();
    expect(wakeRows(t).map((w) => [w.url, w.state])).toEqual([[prUrl(1), "muted"], [prUrl(2), "sent"]]);
    expect(t.giveWork).toHaveBeenCalledTimes(1);
    expect(t.giveWork.mock.calls[0]![2]).toContain("#2");
    expect(t.giveWork.mock.calls[0]![2]).not.toContain("#1 ");
  });

  it("checks R2 ownership as it is when sending, not as the pass read it", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.poll(0);
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    t.hooks.onThread = () => t.owners.move(prUrl(1), null, t.clock.now);
    await t.poll();
    expect(wakeRows(t)).toEqual([expect.objectContaining({ state: "stale", routed: "no Adventure owns it now" })]);
    expect(t.giveWork).not.toHaveBeenCalled();
    expect(t.sent()).toEqual([]);
  });

  it("takes check presence from the watch read when a push landed after the list", async () => {
    const t = setup({ prs: [fakePr(1, { checks: [{ name: "tests", outcome: "passed" }] })] });
    await t.poll(0);
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
    await t.poll(0);
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
    await t.poll(0);
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

  it("sends to the PR's worker as it is when sending: a reassignment meanwhile retargets the wake", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.poll(0);
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    t.hooks.onThread = () => t.store.savePrRecord("eq", { ...blankPrRecord(prUrl(1), t.clock.now), worker: "W2" });
    await t.poll();
    // Routed to W1 first, then held: the next pass sends it to W2.
    expect(t.giveWork).not.toHaveBeenCalled();
    await t.poll();
    expect(t.giveWork).toHaveBeenCalledTimes(1);
    expect(t.giveWork.mock.calls[0]![1]).toBe("W2");
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
    const real = t.gh.getMockImplementation()!;
    t.gh.mockImplementation(async (query, variables, timeout) => {
      if (query === CHECKS_PAGE_QUERY) throw new Error("502 Bad Gateway");
      return real(query, variables, timeout);
    });
    const pageReads = () => t.gh.mock.calls.filter(([q]) => q === CHECKS_PAGE_QUERY).length;
    await t.poll(0);
    expect(pageReads()).toBe(1);
    expect(t.ledger.rows().size).toBe(0);
    // Retried after 2 minutes, then 4: not at the next 2-minute poll.
    await t.poll();
    expect(pageReads()).toBe(2);
    await t.poll();
    expect(pageReads()).toBe(2);
    await t.poll();
    expect(pageReads()).toBe(3);
  });
});


describe("W548 review r4 regressions", () => {
  it("retargets a held wake to the PR's new Adventure before looking at the old one, even archived", async () => {
    const t = setup({ prs: [fakePr(1)] });
    t.store.createProject({ id: "ui", name: "Equisafe UI", objective: "o", memberProjectIds: ["proj_eq"], coordinatorThreadId: "thr_c_ui" });
    await t.poll(0);
    t.store.updateProject("eq", { paused: true });
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    await t.poll();
    t.owners.move(prUrl(1), "ui", t.clock.now);
    t.store.updateProject("eq", { archivedAt: t.clock.now });
    // Equisafe UI had no watch, so its list refresh starts on the pass that finds the move: the wake goes on the next.
    await t.poll();
    await t.poll();
    expect(wakeRows(t)).toEqual([expect.objectContaining({ state: "sent", routed: "coordinator: no worker is linked to it" })]);
    expect(t.sent()).toEqual([expect.objectContaining({ to: "thr_c_ui" })]);
  });

  it("resolves owners by key: a burst of 300 wakes for one worker stays cheap", async () => {
    const prs = Array.from({ length: 300 }, (_, i) => fakePr(i + 1, { head: `h${i + 1}` }));
    const t = setup({ prs });
    for (let i = 3; i <= 300; i++) {
      const w = t.store.createWorker({ projectId: "eq", role: "work", label: `W${i}`, area: "a", bbProjectId: "proj_eq" });
      t.store.updateWorker("eq", w.num, { threadId: `thr_x${i}`, generation: 1 });
    }
    for (const pr of prs) t.store.savePrRecord("eq", { ...blankPrRecord(prUrl(pr.number), t.clock.now), worker: "W1" });
    await t.poll(0);
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
    await t.poll(0);
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
    await t.poll(0);
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
    await t.poll(0);
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
    await t.poll(0);
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
    await t.poll(0);
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
    await t.poll(0);
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

  it("judges a held wake by the PR's current Adventure after pause, move, archive and a reload with an empty cache", async () => {
    const t = setup({ prs: [fakePr(1)] });
    t.store.createProject({ id: "ui", name: "Equisafe UI", objective: "o", memberProjectIds: ["proj_eq"], coordinatorThreadId: "thr_c_ui" });
    await t.poll(0);
    t.store.updateProject("eq", { paused: true });
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    await t.poll();
    expect(wakeRows(t).map((w) => w.state)).toEqual(["pending"]);
    t.owners.move(prUrl(1), "ui", t.clock.now);
    t.store.updateProject("eq", { archivedAt: t.clock.now });
    t.reload();
    // Nothing listed yet: held for Equisafe UI, not dropped with archived Equisafe.
    t.clock.now += MINUTE;
    await t.watcher.check();
    expect(wakeRows(t).map((w) => w.state)).toEqual(["pending"]);
    expect(t.db.prepare("SELECT project_id FROM pr_wakes").pluck().get()).toBe("ui");
    await t.cache.settled();
    await t.watcher.check();
    await t.cache.settled();
    expect(wakeRows(t)).toEqual([expect.objectContaining({ state: "sent", routed: "coordinator: no worker is linked to it" })]);
    expect(t.sent()).toEqual([expect.objectContaining({ to: "thr_c_ui" })]);
  });

  it("keeps a PR's wake with its worker when a later brief only mentions it in passing; one that names its URL takes it", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.poll(0);
    assign(t, 2, `Write the docs; ${REPO}#1 changed the API.`);
    expect(t.assigned.referencing("eq", prUrl(1))?.worker).toBe("W2");
    expect(t.assigned.naming("eq", prUrl(1))).toBeNull();
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    await t.poll();
    expect(t.giveWork.mock.calls.map((c) => c[1])).toEqual(["W1"]);
    // The keyed lookup and the queue's own read agree.
    assign(t, 2, `Fix ${prUrl(1)}.`);
    expect(t.assigned.naming("eq", prUrl(1))).toEqual({ ...t.assigned.read("eq").get(prUrl(1)), links: undefined });
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }, { name: "lint", outcome: "failed" }];
    await t.poll();
    // W2 is on that open work: a message it covers.
    expect(t.giveWork.mock.calls.map((c) => c[1])).toEqual(["W1"]);
    expect(t.sent()).toEqual([expect.objectContaining({ to: "thr_w2" })]);
  });

  it("reads no PR for a wake a pause holds, and one read confirms it once resumed", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.poll(0);
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
    await t.poll(0);
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
    await t.poll(0);
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
    await t.poll(0);
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

  it("reads and wakes a PR once when it moves between two Adventures' list reads of one pass", async () => {
    const t = setup({ prs: [fakePr(1)] });
    t.store.createProject({ id: "ui", name: "Equisafe UI", objective: "o", memberProjectIds: ["proj_eq"], coordinatorThreadId: "thr_c_ui" });
    await t.poll(0);
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    t.clock.now += REFRESH_MS;
    await t.cache.read("eq", { watch: true });
    await t.cache.settled();
    // Equisafe's list is read, then the PR moves to Equisafe UI, whose list is read next.
    const read = t.cache.read.bind(t.cache);
    let moved = false;
    vi.spyOn(t.cache, "read").mockImplementation(async (projectId, options) => {
      const queue = await read(projectId, options);
      if (projectId === "eq" && !moved) {
        moved = true;
        t.owners.move(prUrl(1), "ui", t.clock.now);
      }
      return queue;
    });
    const before = t.requests.length;
    await t.watcher.check();
    expect(t.requests.slice(before).filter((r) => r.kind === "watch").reduce((sum, r) => sum + r.count, 0)).toBe(1);
    expect(wakeRows(t)).toHaveLength(1);
    expect(t.sent()).toEqual([expect.objectContaining({ to: "thr_c_ui" })]);
  });
});

describe("W551 PR watch P3s", () => {
  it("sends a wake to the coordinator while the worker's thread is stopping, not into the ending turn", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.poll(0);
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
    await t.poll(0);
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
    await t.poll(0);
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
    await t.poll(0);
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

  it("sends a Stop's note to the PR's Adventure as it is after the read, and none once it is muted", async () => {
    const t = setup({ prs: [fakePr(1), fakePr(2, { head: "head2a" })] });
    t.store.createProject({ id: "ui", name: "Equisafe UI", objective: "o", memberProjectIds: ["proj_eq"], coordinatorThreadId: "thr_c_ui" });
    await t.poll(0);
    t.threads.get("thr_w1")!.status = "active";
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    // The Stop lands with the steer; the PR moves to Equisafe UI while the plugin reads the thread again.
    t.send.mockImplementationOnce(async () => {
      t.threads.get("thr_w1")!.status = "stopping";
      t.hooks.onThread = () => t.owners.move(prUrl(1), "ui", t.clock.now);
      return { delivery: "sent" };
    });
    await t.poll();
    expect(t.sent().map((m) => m.to)).toEqual(["thr_w1", "thr_c_ui"]);
    expect(t.sent()[1]!.text).toContain("Adventures · Equisafe UI · PR watch");
    // Equisafe's W1 is no worker of Equisafe UI: the note names it with its Adventure, and suggests none.
    expect(t.sent()[1]!.text).toContain("(W1 of the Equisafe Adventure, which owned the PR then):");
    expect(t.sent()[1]!.text).toContain("If it needs work, give it to a worker; or leave it.");
    expect(t.sent()[1]!.text).not.toContain('handoffs:["W1"]');
    expect(wakeRows(t)[0]).toMatchObject({ state: "sent" });

    // PR 2: muted during that read: the wake stays sent, and nobody else is told.
    t.threads.get("thr_w1")!.status = "active";
    t.prs.get(2)!.checks = [{ name: "tests", outcome: "failed" }];
    t.send.mockImplementationOnce(async () => {
      t.threads.get("thr_w1")!.status = "stopping";
      t.hooks.onThread = () => t.ledger.setMuted(prUrl(2), "eq", true);
      return { delivery: "sent" };
    });
    await t.poll();
    expect(t.sent().map((m) => m.to)).toEqual(["thr_w1", "thr_c_ui", "thr_w1"]);
    expect(wakeRows(t).at(-1)).toMatchObject({ state: "sent" });
    expect(t.store.activity("eq").some((a) => /woke W1 about equisafe\/market#2, but .* Nobody is told/.test(a.summary))).toBe(true);
  });

  it("records a steer BB queued instead of sending", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.poll(0);
    t.threads.get("thr_w1")!.status = "active";
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    t.send.mockImplementationOnce(async () => ({ delivery: "queued" }));
    await t.poll();
    expect(t.sent().map((m) => m.to)).toEqual(["thr_w1"]);
    expect(wakeRows(t)).toEqual([expect.objectContaining({ state: "sent", routed: "W1: message (while it works, queued by BB)" })]);
  });

  it("tells the coordinator once, with BB's last answer, when it gives up on a wake BB keeps refusing", async () => {
    const t = setup({ prs: [fakePr(1)] });
    await t.poll(0);
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

  it("judges the wakes left again before each coordinator's note: a mute during the first note skips the second", async () => {
    const t = setup({ prs: [fakePr(1), fakePr(2, { head: "head2a" })] });
    t.store.createProject({ id: "ui", name: "Equisafe UI", objective: "o", memberProjectIds: ["proj_eq"], coordinatorThreadId: "thr_c_ui" });
    await t.poll(0);
    t.threads.get("thr_w1")!.status = "active";
    for (const n of [1, 2]) t.prs.get(n)!.checks = [{ name: "tests", outcome: "failed" }];
    let tries = 0;
    t.send.mockImplementation(async ({ threadId }) => {
      // Equisafe UI's note is sent first; PR 2 is muted while it waits on BB.
      if (threadId === "thr_c_ui") t.ledger.setMuted(prUrl(2), "eq", true);
      if (threadId !== "thr_w1") return { delivery: "sent" };
      // While the last refused send of both waits on BB, PR 1 moves to Equisafe UI.
      if (++tries === WAKE_REFUSALS) t.owners.move(prUrl(1), "ui", t.clock.now);
      throw Object.assign(new Error("Thread is not writable"), { status: 409 });
    });
    for (let i = 0; i < WAKE_REFUSALS; i++) await t.poll();
    expect(t.sent().map((m) => m.to)).toEqual([...Array(WAKE_REFUSALS).fill("thr_w1"), "thr_c_ui"]);
    expect(t.sent().at(-1)!.text).toContain("equisafe/market#1");
    expect(t.sent().at(-1)!.text).not.toContain("equisafe/market#2");
    expect(t.store.activity("eq").some((a) => /gave up on equisafe\/market#2 \(W1\).*Nobody is told/.test(a.summary))).toBe(true);
  });

  it("tells the PR's current Adventure when it gives up, and nobody when the PR was muted meanwhile", async () => {
    const t = setup({ prs: [fakePr(1), fakePr(2, { head: "head2a" })] });
    t.store.createProject({ id: "ui", name: "Equisafe UI", objective: "o", memberProjectIds: ["proj_eq"], coordinatorThreadId: "thr_c_ui" });
    await t.poll(0);
    t.threads.get("thr_w1")!.status = "active";
    t.prs.get(1)!.checks = [{ name: "tests", outcome: "failed" }];
    let tries = 0;
    t.send.mockImplementation(async ({ threadId }) => {
      if (threadId !== "thr_w1") return { delivery: "sent" };
      // While the last refused send waits on BB, the PR moves to Equisafe UI.
      if (++tries === WAKE_REFUSALS) t.owners.move(prUrl(1), "ui", t.clock.now);
      throw Object.assign(new Error("Thread is not writable"), { status: 409 });
    });
    for (let i = 0; i < WAKE_REFUSALS; i++) await t.poll();
    expect(t.sent().map((m) => m.to)).toEqual([...Array(WAKE_REFUSALS).fill("thr_w1"), "thr_c_ui"]);
    expect(t.sent().at(-1)!.text).toContain("Adventures · Equisafe UI · PR watch");
    expect(t.sent().at(-1)!.text).toContain("equisafe/market#1 (no worker)");

    // PR 2: muted while its last refused send waits on BB: logged, nobody told.
    tries = 0;
    t.send.mockImplementation(async ({ threadId }) => {
      if (threadId !== "thr_w1") return { delivery: "sent" };
      if (++tries === WAKE_REFUSALS) t.ledger.setMuted(prUrl(2), "eq", true);
      throw Object.assign(new Error("Thread is not writable"), { status: 409 });
    });
    const before = t.send.mock.calls.length;
    t.prs.get(2)!.checks = [{ name: "tests", outcome: "failed" }];
    for (let i = 0; i < WAKE_REFUSALS; i++) await t.poll();
    expect(t.sent().slice(before).map((m) => m.to)).toEqual(Array(WAKE_REFUSALS).fill("thr_w1"));
    expect(t.store.activity("eq").some((a) => /gave up on equisafe\/market#2 \(W1\).*Nobody is told/.test(a.summary))).toBe(true);
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
    expect(call.input[0]!.text).toContain("the plugin wakes you");
  });

  it("checks a wake once more just before the work is recorded, after the dispatch's reads", async () => {
    const { f, project } = await projectFixture();
    const [w] = JSON.parse(await f.harness.callAgentTool("initiative_spawn", { label: "Search", purpose: "search", text: "Do it." }, { threadId: "coordinator" }) as string);
    await f.harness.callAgentTool("initiative_report", { outcome: "done", summary: "Done.", report: "Done." }, { threadId: w.threadId });
    await f.runtime.onThreadIdle(f.idle(w.threadId));
    const before = f.store.assignments(project.id).length;
    const sends = f.send.mock.calls.length;
    let checks = 0;
    // Muted while the dispatch read BB: the first check passes, the last one doesn't.
    await expect(f.prWatchWork(project.id, "W1", "PR watch: checks failed.", () => {
      if (++checks > 1) throw new Error("muted meanwhile");
    })).rejects.toThrow("muted meanwhile");
    expect(checks).toBe(2);
    expect(f.store.assignments(project.id).length).toBe(before);
    expect(f.send.mock.calls.length).toBe(sends);
  });

  it("tells workers never to wait on CI, within the guidance cap", () => {
    expect(DEFAULT_WORKER_INSTRUCTIONS).toContain("Never wait on CI with sleep, loops, `gh pr checks --watch`, Monitor or ScheduleWakeup: the plugin wakes you when your PR changes.");
    expect(DEFAULT_WORKER_INSTRUCTIONS.length).toBeLessThanOrEqual(MAX_GUIDANCE_CHARACTERS);
  });
});
