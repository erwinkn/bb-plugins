// W548: PR watches. Every open PR an Adventure owns (R2) is watched: when it changes on GitHub
// (checks fail, required checks pass, someone comments, it conflicts, or no check reports after a
// push), the plugin wakes whoever owns it, so nobody has to notice a red check in the PRs tab.
//
// - The merge queue's cache lists each repository's open PRs (merge-queue-server.ts). The list
//   only says when to read a PR (its head, updatedAt, check counts or a conflict moved): every
//   fact a wake carries comes from one watch read (the query below, in the cache's details
//   slots), diffed against the state the last read left. A list and a watch read can see two
//   heads; a wake never mixes them.
// - State and wakes are stored (pr_watches, pr_wakes), so a reload neither misses a change nor
//   repeats a wake. The first snapshot of a PR opened before the watches existed, or unmuted, is a
//   baseline: old state wakes nobody.
// - A wake goes to the PR's worker as more work, or as a message when it is busy; to the
//   coordinator when that worker is retired or stopped, or idle with a cold cache (cold-cache.ts).
//   Each recipient gets one message a pass, whatever it covers.
// - Comments by the `gh` account never wake: agents and the user share it, and nothing in GitHub's
//   data tells them apart. Bots and other people do.
import type Database from "better-sqlite3";
import { BUSY_STATUSES, errorMessage, isDefiniteRejection, textInput, type Sdk, type ThreadDto } from "./bb";
import { FAILED, PASSED, branchThreadId, mergeable as mergeableState, type MergeQueue, type MergeableState, type QueuedPullRequest } from "./merge-queue";
import { canonicalPrUrl } from "./pr-stages";
export { PR_WATCH_MIGRATIONS } from "./pr-watch-migrations";
import type { ProjectRecord, Store, WorkerRecord } from "./store";

/** A pass every this often: lists Adventures with an unmuted watch on the 2-minute cadence. */
export const WATCH_TICK_MS = 2 * 60_000;
/** A pass after a list lands waits this long for the other lists of the same fetch. */
export const WATCH_SETTLE_MS = 2_000;
/** No check this long after a push wakes once (in a repository whose PRs have checks). */
export const NO_CHECKS_MS = 15 * 60_000;
/** Comment-only wakes in a row before comments stop waking; news about checks, conflicts or a push resets it. */
export const COMMENT_WAKE_CAP = 10;
/** PRs a watch request asks for: 25 took ~2.5 s and 1 point on Equisafe (live, 2026-10-28). */
export const WATCH_PAGE = 25;
/** A failed watch read is retried after this, doubling with each failure, up to WATCH_RETRY_MAX_MS. */
export const WATCH_RETRY_MS = 2 * 60_000;
export const WATCH_RETRY_MAX_MS = 30 * 60_000;
/** A watched PR is read again this often even when its list facts stay, which bounds what they can't tell (listFingerprint). */
export const WATCH_RESYNC_MS = 30 * 60_000;
/** A PR gone from the open list but still open on GitHub (another author, a capped list) is read again after this. */
export const LEFT_RECHECK_MS = 30 * 60_000;
/** Comments and reviews a watch read sees, newest; more since the last pass read as "20+". */
export const WATCH_COMMENTS = 20;
/** Wakes kept per PR, newest. */
export const WAKES_KEPT = 20;
/** A wake still unsent after this (a long pause, a PR no longer listed) is dropped as stale. */
export const WAKE_MAX_AGE_MS = 24 * 60 * 60_000;
/** Sends of a wake BB may refuse (a 4xx: nothing happened), each routed afresh, before it fails. */
export const WAKE_REFUSALS = 3;

/** What wakes a PR's owner. A merge or a close only ends the watch (Erwin, 2026-10-28). */
export type ChangeKind = "checks-failed" | "checks-passed" | "new-comments" | "conflicting" | "no-checks";

// GitHub ---------------------------------------------------------------------

/** The fields of a page of check contexts; `id` is the variable holding the PR's id, which `isRequired` needs. */
const contextFields = (id: string) => `pageInfo { hasNextPage endCursor } nodes { __typename
      ... on CheckRun { name status conclusion isRequired(pullRequestId: ${id}) }
      ... on StatusContext { context state isRequired(pullRequestId: ${id}) }
    }`;

/** One more page of a PR's checks, after `$after`; `headRefOid` tells whether it is still the head read before. */
export const CHECKS_PAGE_QUERY = `query($id: ID!, $after: String!) {
  node(id: $id) { ... on PullRequest { headRefOid
    commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100, after: $after) { ${contextFields("$id")} } } } } }
  } }
}`;
/** Pages of checks a watch read takes at most (1,000 checks); past them, the rollup's state speaks for the rest. */
export const CHECK_PAGES = 10;

/**
 * The watch query for `count` PRs by node id, `p0` to `p<count-1>`: state, head, mergeability,
 * the head commit's checks with whether the base branch requires each (`isRequired` needs the PR's
 * id, so each PR is its own alias), and the latest comments and reviews.
 */
export function watchQuery(count: number): string {
  const indexes = Array.from({ length: count }, (_, i) => i);
  return `query(${indexes.map((i) => `$i${i}: ID!`).join(", ")}) {\n${indexes.map((i) => `  p${i}: node(id: $i${i}) { ... on PullRequest {
    id number state headRefOid mergeable createdAt
    baseRef { branchProtectionRule { requiredStatusCheckContexts }
      rules(first: 50) { pageInfo { hasNextPage } nodes { type parameters { ... on RequiredStatusChecksParameters { requiredStatusChecks { context } } } } } }
    commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { ${contextFields(`$i${i}`)} } } } } }
    comments(last: ${WATCH_COMMENTS}) { nodes { url createdAt author { __typename login } } }
    reviews(last: ${WATCH_COMMENTS}) { nodes { url submittedAt state author { __typename login } } }
  } }`).join("\n")}\n}`;
}

export interface WatchCheck {
  name: string;
  outcome: "passed" | "failed" | "pending";
  required: boolean;
}

export interface WatchComment {
  url: string;
  at: number;
  author: string;
  bot: boolean;
  /** A review's state, lower case (commented, approved, changes_requested…); null for a comment. */
  review: string | null;
}

/** What a watch read says of one PR. */
export interface WatchFacts {
  state: "OPEN" | "MERGED" | "CLOSED";
  head: string;
  /** GitHub's "unknown" while it computes. */
  mergeable: MergeableState;
  /** When the PR was opened. */
  createdAt: number;
  checks: WatchCheck[];
  /**
   * More checks than were read: `checks` is only part of them, and the rollup's overall state
   * (SUCCESS, FAILURE, ERROR, PENDING, EXPECTED) speaks for the rest; `cursor` reads the next
   * page. Absent when complete.
   */
  more?: { rollup: string; cursor: string | null };
  /**
   * The check names the base branch requires (classic protection and rulesets), whether they
   * reported or not; empty when none; absent when unknown (no base branch, too many rules).
   */
  required?: string[];
  comments: WatchComment[];
}

/** The failing check's name when only checks past the first 100 fail. */
export const CHECKS_PAST_100 = "a check past the first 100";

const time = (value: unknown) => (typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null);
const nodes = (value: unknown): Record<string, any>[] => {
  const list = (value as { nodes?: unknown } | null | undefined)?.nodes;
  return Array.isArray(list) ? list.filter((n): n is Record<string, any> => typeof n === "object" && n !== null) : [];
};

/** One PR's watch facts from its node; null for a PR gone or malformed. */
export function parseWatch(node: unknown): WatchFacts | null {
  const n = node as Record<string, any> | null;
  if (!n || typeof n !== "object" || typeof n.headRefOid !== "string") return null;
  const state = n.state === "OPEN" || n.state === "MERGED" || n.state === "CLOSED" ? n.state : null;
  if (!state) return null;
  const rollup = nodes(n.commits)[0]?.commit?.statusCheckRollup;
  const checks = parseChecks(rollup?.contexts);
  const comments: WatchComment[] = [];
  for (const [list, field] of [[n.comments, "createdAt"], [n.reviews, "submittedAt"]] as const)
    for (const c of nodes(list)) {
      const at = time(c[field]);
      if (at === null || typeof c.url !== "string") continue;
      comments.push({
        url: c.url, at,
        author: typeof c.author?.login === "string" ? c.author.login : "ghost",
        bot: c.author?.__typename === "Bot",
        review: list === n.reviews && typeof c.state === "string" ? c.state.toLowerCase() : null,
      });
    }
  comments.sort((a, b) => a.at - b.at);
  const more = rollup?.contexts?.pageInfo?.hasNextPage === true ? { more: { rollup: String(rollup.state ?? ""), cursor: nextCursor(rollup.contexts) } } : {};
  const required = requiredNames(n.baseRef);
  return { state, head: n.headRefOid, mergeable: mergeableState(n.mergeable), createdAt: time(n.createdAt) ?? 0, checks, ...more, ...(required ? { required } : {}), comments };
}

/** The checks a base branch requires, from classic protection and rulesets; null when its rules can't all be read. */
function requiredNames(baseRef: Record<string, any> | null | undefined): string[] | null {
  if (!baseRef || typeof baseRef !== "object" || baseRef.rules?.pageInfo?.hasNextPage !== false) return null;
  const names = new Set<string>();
  for (const name of Array.isArray(baseRef.branchProtectionRule?.requiredStatusCheckContexts) ? baseRef.branchProtectionRule.requiredStatusCheckContexts : [])
    if (typeof name === "string") names.add(name);
  for (const rule of nodes(baseRef.rules))
    if (rule.type === "REQUIRED_STATUS_CHECKS")
      for (const check of Array.isArray(rule.parameters?.requiredStatusChecks) ? rule.parameters.requiredStatusChecks : [])
        if (typeof check?.context === "string") names.add(check.context);
  return [...names].sort();
}

/** One page of check contexts. */
export function parseChecks(contexts: unknown): WatchCheck[] {
  const checks: WatchCheck[] = [];
  for (const context of nodes(contexts)) {
    const name = context.__typename === "CheckRun" ? context.name : context.context;
    if (typeof name !== "string" || !name) continue;
    // A check run's conclusion once completed, a status context's state.
    const value = String(context.__typename === "CheckRun" ? (context.status === "COMPLETED" ? context.conclusion : "") : context.state).toUpperCase();
    checks.push({ name, outcome: PASSED.has(value) ? "passed" : FAILED.has(value) ? "failed" : "pending", required: context.isRequired === true });
  }
  return checks;
}

const nextCursor = (contexts: unknown): string | null => {
  const info = (contexts as { pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } } | null)?.pageInfo;
  return info?.hasNextPage === true && typeof info.endCursor === "string" ? info.endCursor : null;
};

// The diff ---------------------------------------------------------------------

/** What the watcher last saw of a PR. */
export interface WatchState {
  /** The head SHA it describes. */
  head: string;
  /** The list facts its last watch read was for (listFingerprint); a different one calls for a read. Never a wake's fact. */
  fingerprint: string;
  /** Failing check names at `head`. */
  failing: string[];
  /** Every required check (every check, where none is required) passed at `head`. */
  passed: boolean;
  /** The last known mergeability; GitHub's "unknown" while it computes doesn't replace it. */
  mergeable: MergeableState;
  /** The newest comment or review seen: later ones are news, and so are others at that time not in `seenAt`. */
  seenUntil: number;
  /** The URLs of those seen at `seenUntil`. */
  seenAt?: string[];
  /** When `head` was pushed, as far as the watcher knows; null for a baseline's head. */
  pushedAt: number | null;
  /** No-checks woke (or can no longer wake) for `head`. */
  noChecksDone: boolean;
  /** Comment-only wakes in a row. */
  commentWakes: number;
  /** Merged or closed: no longer listed or diffed. */
  ended: "MERGED" | "CLOSED" | null;
  /** When its last watch read ran: one older than WATCH_RESYNC_MS is read again. */
  readAt: number;
}

export interface Change {
  kind: ChangeKind;
  /** checks-failed: the newly failing names; checks-passed: the checks that passed. */
  checks?: string[];
  /** checks-passed: whether those are the required ones (else every check, none being required). */
  required?: boolean;
  /** new-comments: the new comments and reviews, oldest first. */
  comments?: WatchComment[];
}

/**
 * The list facts that, when they move, call for a watch read: a push, a comment or review
 * (updatedAt), a check's progress (counts by raw state). Two reruns that swap outcomes between two
 * lists leave it as it was: WATCH_RESYNC_MS bounds that.
 */
export const listFingerprint = (pr: Pick<QueuedPullRequest, "headOid" | "updatedAt" | "checks" | "checkStates">) =>
  `${pr.headOid ?? ""}|${pr.updatedAt}|${pr.checkStates ?? `${pr.checks.passed}/${pr.checks.failed}/${pr.checks.pending}`}`;

/**
 * Whether a listed PR calls for a watch read: none yet, its list facts moved, the list knows a
 * mergeability other than the stored one (a conflict starting or ending; GitHub's "unknown" while
 * it computes, which every PR shows after a push to its base, says nothing), its last read is
 * WATCH_RESYNC_MS old, or its no-checks wake is due (`repoHasChecks`, as in diffWatch).
 */
export function needsRead(state: WatchState | null | undefined, pr: Parameters<typeof listFingerprint>[0] & Pick<QueuedPullRequest, "mergeable">, now: number, repoHasChecks: boolean): boolean {
  if (!state || state.ended !== null || state.fingerprint !== listFingerprint(pr) || now - state.readAt >= WATCH_RESYNC_MS) return true;
  if (pr.mergeable !== "unknown" && pr.mergeable !== state.mergeable) return true;
  return repoHasChecks && !state.noChecksDone && state.pushedAt !== null && now - state.pushedAt >= NO_CHECKS_MS;
}

const EMPTY: Omit<WatchState, "seenUntil" | "fingerprint" | "readAt"> = {
  head: "", failing: [], passed: false, mergeable: "unknown", pushedAt: null, noChecksDone: false, commentWakes: 0, ended: null,
};

/** Failing check names; past 100 checks, the rollup tells of a failure the first 100 don't show. */
const failingNames = (watch: WatchFacts) => {
  const names = [...new Set(watch.checks.filter((c) => c.outcome === "failed").map((c) => c.name))].sort();
  return !names.length && (watch.more?.rollup === "FAILURE" || watch.more?.rollup === "ERROR") ? [CHECKS_PAST_100] : names;
};
/**
 * The checks that gate the PR and whether they all passed: every check the base branch requires
 * (or GitHub marks required), each of which must have reported and passed; else every check.
 */
const gate = (watch: WatchFacts) => {
  const names = new Set([...(watch.required ?? []), ...watch.checks.filter((c) => c.required).map((c) => c.name)]);
  if (names.size) {
    // A required check that never reported (a workflow skipped by its path filter) blocks the merge.
    const passed = [...names].every((name) => {
      const runs = watch.checks.filter((c) => c.name === name);
      return runs.length > 0 && runs.every((c) => c.outcome === "passed");
    });
    return { names: [...names].sort(), required: true, passed: passed && (!watch.more || watch.more.rollup === "SUCCESS" || !!watch.required) };
  }
  // Past 100 checks, a failing one may be among the unread: only the whole rollup's success says they passed.
  const passed = watch.checks.length > 0 && watch.checks.every((c) => c.outcome === "passed") && (!watch.more || watch.more.rollup === "SUCCESS");
  return { names: [...new Set(watch.checks.map((c) => c.name))].sort(), required: false, passed };
};

/** The comment cursor after seeing `comments`: the newest time, and every URL seen at it. */
function seen(prev: Pick<WatchState, "seenUntil" | "seenAt"> | null, comments: readonly WatchComment[]): { seenUntil: number; seenAt: string[] } {
  const until = Math.max(prev?.seenUntil ?? 0, ...comments.map((c) => c.at));
  const at = comments.filter((c) => c.at === until).map((c) => c.url);
  return { seenUntil: until, seenAt: [...new Set([...(prev && prev.seenUntil === until ? prev.seenAt ?? [] : []), ...at])] };
}

/** A baseline: the PR as it is, waking nobody. */
function baselineState(watch: WatchFacts, now: number, fingerprint: string): WatchState {
  return {
    ...EMPTY,
    head: watch.head,
    fingerprint,
    readAt: now,
    failing: failingNames(watch),
    passed: gate(watch).passed,
    mergeable: watch.mergeable,
    ...seen(null, watch.comments),
    // Checks reported or not, a baseline's head is no push the watcher saw.
    noChecksDone: true,
    ended: watch.state === "OPEN" ? null : watch.state,
  };
}

/**
 * The changes from `prev` to the PR as one watch read saw it: every fact comes from that read, so
 * none of a wake's can be of another head. `prev` null: a PR opened after `since` starts from
 * nothing (all of it is news), one opened before is a baseline. `login` is the `gh` account, whose
 * comments never wake (null: comments are left for a pass that knows it). `repoHasChecks`: some
 * listed PR of its repository has checks, so a PR without any after a push is news. `fingerprint`:
 * the list facts the read was for (WatchState.fingerprint). `capped`: comments that would have
 * woken past COMMENT_WAKE_CAP.
 */
export function diffWatch(
  prev: WatchState | null,
  watch: WatchFacts,
  context: { now: number; since: number; login: string | null; repoHasChecks: boolean; fingerprint: string },
): { state: WatchState; changes: Change[]; capped: boolean } {
  const { now, fingerprint } = context;
  if (!prev && watch.createdAt <= context.since) return { state: baselineState(watch, now, fingerprint), changes: [], capped: false };
  prev ??= { ...EMPTY, fingerprint: "", seenUntil: context.since, readAt: 0 };
  if (watch.state !== "OPEN") return { state: { ...prev, fingerprint, readAt: now, ended: watch.state }, changes: [], capped: false };
  const pushed = watch.head !== prev.head;
  let changes: Change[] = [];
  const was = pushed ? [] : prev.failing;
  const failing = failingNames(watch);
  const fresh = failing.filter((name) => !was.includes(name));
  if (fresh.length) changes.push({ kind: "checks-failed", checks: fresh });
  const gating = gate(watch);
  if (gating.passed && (pushed || !prev.passed)) changes.push({ kind: "checks-passed", checks: gating.names, required: gating.required });
  let cursor = { seenUntil: prev.seenUntil, seenAt: prev.seenAt ?? [] };
  if (context.login) {
    const own = context.login.toLowerCase();
    const edge = new Set(cursor.seenAt);
    const news = watch.comments.filter((c) => (c.at > cursor.seenUntil || (c.at === cursor.seenUntil && !edge.has(c.url))) && c.author.toLowerCase() !== own);
    if (news.length) changes.push({ kind: "new-comments", comments: news });
    cursor = seen(prev, watch.comments);
  }
  if (watch.mergeable === "conflicting" && prev.mergeable !== "conflicting") changes.push({ kind: "conflicting" });
  const mergeable = watch.mergeable === "unknown" ? prev.mergeable : watch.mergeable;
  // A new PR's first head was pushed when it opened; a later one when the watcher first saw it.
  const pushedAt = pushed ? (prev.head === "" ? watch.createdAt : now) : prev.pushedAt;
  let noChecksDone = (pushed ? false : prev.noChecksDone) || watch.checks.length > 0 || !!watch.more;
  if (!noChecksDone && pushedAt !== null && now - pushedAt >= NO_CHECKS_MS && context.repoHasChecks) {
    changes.push({ kind: "no-checks" });
    noChecksDone = true;
  }
  let commentWakes = pushed || changes.some((c) => c.kind !== "new-comments") ? 0 : prev.commentWakes;
  let capped = false;
  if (changes.length && changes.every((c) => c.kind === "new-comments")) {
    if (commentWakes >= COMMENT_WAKE_CAP) {
      capped = true;
      changes = [];
    } else commentWakes++;
  }
  return {
    state: { head: watch.head, fingerprint, failing, passed: gating.passed, mergeable, ...cursor, pushedAt, noChecksDone, commentWakes, ended: null, readAt: now },
    changes,
    capped,
  };
}

// Messages ---------------------------------------------------------------------

export interface WakePr {
  repo: string;
  number: number;
  title: string;
}

const short = (head: string) => head.slice(0, 10);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const COMMENTS_SHOWN = 5;

/** One change as a line of a wake. */
export function changeLine(change: Change, head: string): string {
  switch (change.kind) {
    case "checks-failed":
      return `Checks failed: ${change.checks!.join(", ")}.`;
    case "checks-passed":
      return `${change.required ? "Required checks" : "All checks"} passed (${plural(change.checks!.length, "check")}).`;
    case "new-comments": {
      const comments = change.comments!;
      const shown = comments.slice(-COMMENTS_SHOWN).map((c) => `${c.author}${c.bot ? " (bot)" : ""}${c.review ? ` (review, ${c.review.replace(/_/g, " ")})` : ""}: ${c.url}`);
      const more = comments.length >= WATCH_COMMENTS ? `${WATCH_COMMENTS}+` : String(comments.length);
      return `${more} new comment${comments.length === 1 ? "" : "s"} or review${comments.length === 1 ? "" : "s"}${comments.length > COMMENTS_SHOWN ? ` (the last ${COMMENTS_SHOWN})` : ""}:\n${shown.map((line) => `  - ${line}`).join("\n")}`;
    }
    case "conflicting":
      return "It conflicts with its base branch.";
    case "no-checks":
      return `No check has reported ${NO_CHECKS_MS / 60_000} min after the push of ${short(head)}.`;
  }
}

/** The PRs and changes of one wake. */
export function wakeBody(wakes: readonly { url: string; head: string; pr: WakePr; changes: Change[] }[]): string {
  return wakes.map((w) => `${w.pr.repo}#${w.pr.number} "${w.pr.title}" at head ${short(w.head)} (${w.url})\n${w.changes.map((c) => `- ${changeLine(c, w.head)}`).join("\n")}`).join("\n\n");
}

export const NOT_A_MERGE = "A wake is not a merge decision: check the PR yourself before you act.";

// The ledger ---------------------------------------------------------------------

export interface WatchRow {
  url: string;
  projectId: string;
  nodeId: string | null;
  muted: boolean;
  since: number;
  state: WatchState | null;
  /** Moves on each mute and unmute. */
  gen: number;
  updatedAt: number;
}

export interface WakeRow {
  id: number;
  projectId: string;
  url: string;
  worker: string | null;
  head: string;
  pr: WakePr;
  changes: Change[];
  createdAt: number;
  gen: number;
  state: "pending" | "sending" | "sent" | "stale" | "muted" | "failed" | "uncertain";
  sentAt: number | null;
  routed: string | null;
  /** Sends BB refused (WAKE_REFUSALS). */
  refusals: number;
}

/** What one pass writes for a PR: its new state, and the wake it found, if any. */
export interface WatchWrite {
  url: string;
  projectId: string;
  nodeId: string | null;
  since: number;
  /** The watch's generation the pass read: a mute or unmute since makes the write a no-op. */
  gen: number;
  /** The row existed when the pass read it. */
  existed: boolean;
  state: WatchState;
  wake: { worker: string | null; pr: WakePr; changes: Change[] } | null;
}

const parse = <T,>(text: unknown): T | null => {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

const CI_FLAG = "pr-watch-ci:";

/** The pr_watches and pr_wakes tables, on the plugin's one connection. */
export class WatchLedger {
  constructor(private readonly db: Database.Database, private readonly now: () => number) {}

  private recordWorkerQuery?: Database.Statement;
  private threadWorkerQuery?: Database.Statement;
  /** ownerNow's lookups by key, prepared once: the coordinator's record of a PR names this worker. */
  recordWorker(projectId: string, url: string): string | null {
    this.recordWorkerQuery ??= this.db.prepare("SELECT worker FROM pr_records WHERE project_id = ? AND url = ?").pluck();
    return (this.recordWorkerQuery.get(projectId, url) as string | null | undefined) ?? null;
  }

  /** The W# whose current thread this is. */
  threadWorker(projectId: string, threadId: string): string | null {
    this.threadWorkerQuery ??= this.db.prepare("SELECT num FROM workers WHERE project_id = ? AND thread_id = ? LIMIT 1").pluck();
    const num = this.threadWorkerQuery.get(projectId, threadId) as number | undefined;
    return num === undefined ? null : `W${num}`;
  }

  /**
   * When the watches started: a PR opened before is watched from a baseline, one opened since from
   * nothing. Set on the first call, kept in plugin_flags.
   */
  since(): number {
    this.db.prepare("INSERT OR IGNORE INTO plugin_flags(key, set_at) VALUES('pr-watch-since', ?)").run(this.now());
    return Number((this.db.prepare("SELECT set_at FROM plugin_flags WHERE key = 'pr-watch-since'").get() as { set_at: number }).set_at);
  }

  /** Repositories (lower case) where some PR ever reported checks: a PR there without any after a push is news. */
  ciRepos(): Set<string> {
    return new Set((this.db.prepare("SELECT substr(key, ?) FROM plugin_flags WHERE substr(key, 1, ?) = ?").pluck().all(CI_FLAG.length + 1, CI_FLAG.length, CI_FLAG) as string[]));
  }

  markCi(repos: Iterable<string>) {
    const insert = this.db.prepare("INSERT OR IGNORE INTO plugin_flags(key, set_at) VALUES(?, ?)");
    const at = this.now();
    this.db.transaction(() => { for (const repo of repos) insert.run(`${CI_FLAG}${repo}`, at); })();
  }

  rows(): Map<string, WatchRow> {
    return new Map((this.db.prepare("SELECT * FROM pr_watches").all() as Record<string, unknown>[]).map((r) => [String(r.url), toWatch(r)]));
  }

  row(url: string): WatchRow | null {
    const r = this.db.prepare("SELECT * FROM pr_watches WHERE url = ?").get(url) as Record<string, unknown> | undefined;
    return r ? toWatch(r) : null;
  }

  /**
   * One pass's states and wakes, together: a wake is never stored without the state that found
   * it, nor the reverse. A PR muted or unmuted since the pass read it (its generation moved, or a
   * row appeared) is left as the mute left it. The URLs whose state was stored.
   */
  write(writes: readonly WatchWrite[]): Set<string> {
    const stored = new Set<string>();
    if (!writes.length) return stored;
    const at = this.now();
    const insert = this.db.prepare(`INSERT OR IGNORE INTO pr_watches (url, project_id, node_id, muted, since, state, gen, updated_at) VALUES (?, ?, ?, 0, ?, ?, 0, ?)`);
    const update = this.db.prepare(`UPDATE pr_watches SET project_id = ?, node_id = COALESCE(?, node_id), state = ?, updated_at = ? WHERE url = ? AND gen = ? AND muted = 0`);
    const wake = this.db.prepare(`INSERT INTO pr_wakes (project_id, url, worker, head, pr, changes, created_at, gen, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`);
    const prune = this.db.prepare(`DELETE FROM pr_wakes WHERE url = ? AND state NOT IN ('pending', 'sending') AND id <= (SELECT id FROM pr_wakes WHERE url = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`);
    this.db.transaction(() => {
      for (const w of writes) {
        const state = JSON.stringify(w.state);
        const applied = w.existed
          ? update.run(w.projectId, w.nodeId, state, at, w.url, w.gen).changes
          : insert.run(w.url, w.projectId, w.nodeId, w.since, state, at).changes;
        if (!applied) continue;
        stored.add(w.url);
        if (!w.wake) continue;
        wake.run(w.projectId, w.url, w.wake.worker, w.state.head, JSON.stringify(w.wake.pr), JSON.stringify(w.wake.changes), at, w.gen);
        prune.run(w.url, w.url, WAKES_KEPT);
      }
    })();
    return stored;
  }

  /**
   * A mute keeps the state; an unmute drops it, so the next pass is a baseline from now. Either
   * moves the generation: a pass that read the PR before, and a wake stored before, no longer apply.
   */
  setMuted(url: string, projectId: string, muted: boolean) {
    const at = this.now();
    this.db.prepare(`INSERT INTO pr_watches (url, project_id, muted, since, state, gen, updated_at) VALUES (?, ?, ?, ?, NULL, 1, ?)
      ON CONFLICT (url) DO UPDATE SET muted = excluded.muted, project_id = excluded.project_id,
      state = CASE WHEN excluded.muted = 0 AND pr_watches.muted = 1 THEN NULL ELSE pr_watches.state END,
      since = CASE WHEN excluded.muted = 0 AND pr_watches.muted = 1 THEN excluded.since ELSE pr_watches.since END,
      gen = CASE WHEN excluded.muted <> pr_watches.muted THEN pr_watches.gen + 1 ELSE pr_watches.gen END,
      updated_at = excluded.updated_at`).run(url, projectId, muted ? 1 : 0, at, at);
  }

  pending(): WakeRow[] {
    return (this.db.prepare("SELECT * FROM pr_wakes WHERE state = 'pending' ORDER BY id").all() as Record<string, unknown>[]).map(toWake);
  }

  wakes(url: string, limit: number): WakeRow[] {
    return (this.db.prepare("SELECT * FROM pr_wakes WHERE url = ? ORDER BY id DESC LIMIT ?").all(url, limit) as Record<string, unknown>[]).map(toWake);
  }

  mark(ids: readonly number[], state: WakeRow["state"], routed: string | null = null) {
    const update = this.db.prepare(`UPDATE pr_wakes SET state = ?, routed = COALESCE(?, routed), sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END WHERE id = ?`);
    const at = this.now();
    this.db.transaction(() => { for (const id of ids) update.run(state, routed, state, at, id); })();
  }

  /**
   * Sends BB refused: nothing happened, so each goes back to pending, routed afresh next pass (a
   * thread archived meanwhile routes it to the coordinator), until its WAKE_REFUSALS-th fails it.
   */
  refused(ids: readonly number[], note: string) {
    const update = this.db.prepare(`UPDATE pr_wakes SET refusals = refusals + 1, routed = ?,
      state = CASE WHEN refusals + 1 >= ? THEN 'failed' ELSE 'pending' END WHERE id = ?`);
    this.db.transaction(() => { for (const id of ids) update.run(note, WAKE_REFUSALS, id); })();
  }

  /** A pending wake whose PR moved to another Adventure, or to another worker, goes to its owner now. */
  retarget(id: number, projectId: string, worker: string | null) {
    this.db.prepare("UPDATE pr_wakes SET project_id = ?, worker = ? WHERE id = ? AND state = 'pending'").run(projectId, worker, id);
  }

  /** On load: sends a reload cut short are uncertain, never sent again. Their ids. */
  interrupted(): WakeRow[] {
    const rows = (this.db.prepare("SELECT * FROM pr_wakes WHERE state = 'sending' ORDER BY id").all() as Record<string, unknown>[]).map(toWake);
    this.mark(rows.map((r) => r.id), "uncertain");
    return rows;
  }
}

const toWatch = (r: Record<string, unknown>): WatchRow => ({
  url: String(r.url), projectId: String(r.project_id), nodeId: (r.node_id as string | null) ?? null, muted: r.muted === 1,
  since: Number(r.since), state: parse<WatchState>(r.state), gen: Number(r.gen), updatedAt: Number(r.updated_at),
});
const toWake = (r: Record<string, unknown>): WakeRow => ({
  id: Number(r.id), projectId: String(r.project_id), url: String(r.url), worker: (r.worker as string | null) ?? null, head: String(r.head),
  pr: parse<WakePr>(r.pr) ?? { repo: "", number: 0, title: "" }, changes: parse<Change[]>(r.changes) ?? [], createdAt: Number(r.created_at),
  gen: Number(r.gen),
  state: r.state as WakeRow["state"], sentAt: (r.sent_at as number | null) ?? null, routed: (r.routed as string | null) ?? null,
  refusals: Number(r.refusals ?? 0),
});

// The watcher ---------------------------------------------------------------------

export interface PrWatchDeps {
  store: Store;
  ledger: WatchLedger;
  cache: {
    read(projectId: string, options: { watch: boolean }): Promise<MergeQueue>;
    cachedPr(url: string): QueuedPullRequest | null;
    watchQuery(query: string, variables: Record<string, unknown>): Promise<unknown>;
    readonly login: string | null;
  };
  sdk: Sdk;
  /** What resuming this worker would rewrite when its cache is large and cold (cold-cache.ts); null to go ahead. */
  coldCheck(worker: WorkerRecord): Promise<string | null>;
  /**
   * More work for an idle worker, as a lead's work message (initiative_message work:true); its A#.
   * `still` runs in the same serialized step, just before: it throws when the wake no longer applies.
   */
  giveWork(projectId: string, workerRef: string, text: string, still: () => void): Promise<string>;
  /** A wake was stored or sent, or a mute changed: the dashboards read again. */
  changed(projectId: string): void;
  warn(message: string): void;
  /** R2: the open Adventure that owns a PR now and its worker (ownerNow); null for none. */
  ownerOf(url: string): { projectId: string; worker: string | null } | null;
}

/**
 * R2: the open Adventure that owns a PR now, and its worker by the queue's own rules (the
 * coordinator's record, else the latest assignment naming it, else the worker whose branch opened
 * it; assignStages and attachWorkers), from the ledger as it is: a move, an unassign or a new record
 * since the pass counts, listed or not. The branch needs the PR listed. Every lookup is by key: it
 * runs for each wake, up to three times a send.
 */
export function ownerNow(url: string, sources: {
  recorded(url: string): string | null;
  cachedPr(url: string): Pick<QueuedPullRequest, "head"> | null;
  /** The worker the coordinator's PR record names. */
  recordWorker(projectId: string, url: string): string | null;
  /** The worker of the latest assignment naming the PR (named, as the queue reads them, not merely mentioned). */
  assignedWorker(projectId: string, url: string): string | null;
  /** The W# whose current thread this is. */
  threadWorker(projectId: string, threadId: string): string | null;
}): { projectId: string; worker: string | null } | null {
  const projectId = sources.recorded(url);
  if (!projectId) return null;
  const pr = sources.cachedPr(url);
  const thread = pr ? branchThreadId(pr.head) : null;
  const worker = sources.recordWorker(projectId, url) ?? sources.assignedWorker(projectId, url) ?? (thread ? sources.threadWorker(projectId, thread) : null);
  return { projectId, worker };
}

/**
 * Why a worker can't take a wake itself, or null when it can. A Stop records a cancel request on
 * the work it stops (cancelAssignment), not `userStopped`: the worker stays stopped until its lead
 * gives it new work.
 */
function unavailable(store: Pick<Store, "latestAssignment" | "openAssignment">, worker: WorkerRecord | null): string | null {
  if (!worker) return "no worker is linked to it";
  if (worker.role !== "work") return `${worker.ref} is a reviewer`;
  if (worker.state === "retired") return `${worker.ref} is retired`;
  if (worker.userStopped || [store.latestAssignment(worker.projectId, worker.num), store.openAssignment(worker.projectId, worker.num)].some((a) => a?.cancelRequested))
    return `${worker.ref} was stopped`;
  if (!worker.threadId) return `${worker.ref} has no thread`;
  return null;
}

/** A wake that no longer applies as it was routed: `state` to leave it in (pending: decided again next pass). */
class NotNow extends Error {
  /** `ids`: the wakes it is about; the others of the send go back to pending. Absent: all of them. */
  constructor(readonly state: WakeRow["state"], readonly note: string | null, readonly ids?: readonly number[]) {
    super(note ?? state);
  }
}

/** Who a group of wakes goes to. */
type Route =
  | { to: "worker"; how: "work" | "message"; worker: WorkerRecord; open: string | null; busy: boolean }
  | { to: "coordinator"; why: string; resumable: boolean; worker: WorkerRecord | null };

/**
 * Watches the PRs of every open Adventure. `check()` runs one pass (or one more after the running
 * one): read each Adventure's queue from the cache, read the PRs whose list moved (and those with
 * a wake waiting to go), diff each read, store states and wakes, then send the pending wakes whose
 * head a read of this pass confirmed. The server runs one every WATCH_TICK_MS and after each list
 * lands; reads never wait for it.
 */
export class PrWatcher {
  private running: Promise<void> | null = null;
  private again = false;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Failed watch reads, by URL: retried after `retryAt`, in requests of `among` PRs. */
  private failures = new Map<string, { tries: number; among: number; retryAt: number }>();
  /** PRs gone from the open list but open on GitHub, and when that was read. */
  private leftChecked = new Map<string, number>();
  /** Whether each Adventure had an unmuted watch at its last pass; unknown counts as yes. */
  private watching = new Map<string, boolean>();

  constructor(private readonly deps: PrWatchDeps, private readonly now: () => number = Date.now) {}

  /** One pass, or one more after the running one. */
  check(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        try {
          await this.pass();
        } catch (error) {
          this.deps.warn(`PR watch pass failed: ${errorMessage(error)}`);
        }
      } while (this.again);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** A list landed: a pass once the fetch's other lists have had WATCH_SETTLE_MS to land too. */
  poke() {
    if (this.settleTimer) return;
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      void this.check();
    }, WATCH_SETTLE_MS);
  }

  stop() {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }

  /** On load: a send the last load cut short is never repeated; the activity says so. */
  recover() {
    for (const wake of this.deps.ledger.interrupted())
      this.deps.store.log(wake.projectId, "pr-watch", `PR watch: the plugin restarted while waking ${wake.worker ?? "the coordinator"} about ${wake.pr.repo}#${wake.pr.number}; it may not have arrived, and is not sent again.`, { url: wake.url, wake: wake.id });
  }

  /** Whether an Adventure keeps its repositories on the 2-minute cadence. */
  watches(projectId: string): boolean {
    return this.watching.get(projectId) ?? true;
  }

  private async pass() {
    const { ledger, cache, store } = this.deps;
    const since = ledger.since();
    const rows = ledger.rows();
    const now = this.now();
    /**
     * The listed PRs open Adventures own, unmuted, by URL: one a move lands between two
     * Adventures' list reads is in both, and is read, diffed and woken once, as the later one lists it.
     */
    const listed = new Map<string, { projectId: string; pr: QueuedPullRequest; url: string }>();
    const listedRepos = new Map<string, boolean>();
    const withChecks = new Set<string>();
    for (const project of store.projects()) {
      let queue: MergeQueue;
      try {
        queue = await cache.read(project.id, { watch: this.watches(project.id) });
      } catch (error) {
        this.deps.warn(`PR watch could not read ${project.name}'s PRs: ${errorMessage(error)}`);
        continue;
      }
      for (const pr of queue.pullRequests) if (pr.checks.total > 0) withChecks.add(pr.repo.toLowerCase());
      for (const r of queue.repos) listedRepos.set(r.repo.toLowerCase(), r.fetchedAt !== null && !r.error && !r.capped);
      let unmuted = false;
      for (const pr of queue.pullRequests) {
        const url = canonicalPrUrl(pr.url);
        if (pr.unassigned || !url) continue;
        if (!pr.headOid || !pr.nodeId || rows.get(url)?.muted) continue;
        unmuted = true;
        listed.set(url, { projectId: project.id, pr, url });
      }
      this.watching.set(project.id, unmuted);
    }
    // A repository keeps its CI evidence once seen: a lone PR pushed without checks is news there.
    const known = ledger.ciRepos();
    const found = [...withChecks].filter((repo) => !known.has(repo));
    if (found.length) ledger.markCi(found);
    const ciRepos = new Set([...known, ...found]);

    // Watch reads: PRs whose list calls for one (needsRead), those with a wake waiting for a read
    // to confirm its head, and watched PRs gone from the list.
    const confirming = new Set<string>();
    for (const wake of ledger.pending()) if (this.verdict(wake, new Set()) === "read") confirming.add(wake.url);
    const open = new Set(store.projects().map((p) => p.id));
    const asks: { url: string; nodeId: string; repo: string }[] = [];
    for (const d of listed.values())
      if ((confirming.has(d.url) || needsRead(rows.get(d.url)?.state, d.pr, now, ciRepos.has(d.pr.repo.toLowerCase()))) && this.retryDue(d.url, now))
        asks.push({ url: d.url, nodeId: d.pr.nodeId!, repo: d.pr.repo.toLowerCase() });
    const left: WatchRow[] = [];
    for (const row of rows.values()) {
      if (row.muted || !row.state || row.state.ended || !row.nodeId || !open.has(row.projectId) || cache.cachedPr(row.url)) continue;
      const repo = /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(row.url)?.[1] ?? "";
      if (listedRepos.get(repo) !== true || now - (this.leftChecked.get(row.url) ?? -Infinity) < LEFT_RECHECK_MS || !this.retryDue(row.url, now)) continue;
      left.push(row);
      asks.push({ url: row.url, nodeId: row.nodeId, repo });
    }
    const facts = await this.readWatches(asks, now);

    const writes: WatchWrite[] = [];
    const login = cache.login;
    for (const d of listed.values()) {
      // Not read this pass (nothing moved, or its read failed and waits for its retry), or gone from GitHub (see `left`, once unlisted).
      const watch = facts.get(d.url);
      if (!watch) continue;
      const row = rows.get(d.url);
      const rowSince = row?.since ?? since;
      const prev = row?.state?.ended ? null : (row?.state ?? null);
      const { state, changes, capped } = diffWatch(prev, watch, { now, since: rowSince, login, repoHasChecks: ciRepos.has(d.pr.repo.toLowerCase()), fingerprint: listFingerprint(d.pr) });
      writes.push({
        url: d.url, projectId: d.projectId, nodeId: d.pr.nodeId ?? null, since: rowSince, gen: row?.gen ?? 0, existed: !!row, state,
        wake: changes.length ? { worker: d.pr.worker?.ref ?? null, pr: { repo: d.pr.repo, number: d.pr.number, title: d.pr.title }, changes } : null,
      });
      if (capped)
        store.log(d.projectId, "pr-watch", `PR watch: new comments on ${d.pr.repo}#${d.pr.number} woke nobody after ${COMMENT_WAKE_CAP} comment-only wakes in a row; news about its checks, a conflict or a push wakes again.`, { url: d.url });
    }
    for (const row of left) {
      const watch = facts.get(row.url);
      if (watch === null) continue;
      this.leftChecked.set(row.url, now);
      // Still open (another author, a capped list): nothing to do. Merged, closed, or gone from GitHub (read as closed): its watch ends, waking nobody.
      if (watch?.state === "OPEN") continue;
      writes.push({ url: row.url, projectId: row.projectId, nodeId: row.nodeId, since: row.since, gen: row.gen, existed: true, state: { ...row.state!, readAt: now, ended: watch?.state ?? "CLOSED" }, wake: null });
    }
    const stored = ledger.write(writes);
    const woken = new Set(writes.filter((w) => w.wake).map((w) => w.projectId));
    for (const projectId of woken) this.deps.changed(projectId);
    await this.deliver(stored);
  }

  private retryDue(url: string, now: number) {
    const failed = this.failures.get(url);
    return !failed || failed.retryAt <= now;
  }

  /**
   * Each asked PR's watch facts: undefined for a PR GitHub no longer has, null for one whose read
   * failed (retried after WATCH_RETRY_MS, doubling, in requests half the size of the one that
   * failed, so one PR's fault ends up in a request of its own).
   */
  private async readWatches(asks: readonly { url: string; nodeId: string; repo: string }[], now: number): Promise<Map<string, WatchFacts | null | undefined>> {
    const out = new Map<string, WatchFacts | null | undefined>();
    const batches = new Map<string, (typeof asks)[number][]>();
    for (const ask of asks) {
      const size = Math.min(WATCH_PAGE, this.failures.get(ask.url)?.among ?? WATCH_PAGE);
      const key = `${ask.repo} ${size}`;
      batches.set(key, [...(batches.get(key) ?? []), ask]);
    }
    const requests: (typeof asks)[number][][] = [];
    for (const [key, list] of batches) {
      const size = Number(key.split(" ").pop());
      for (let i = 0; i < list.length; i += size) requests.push(list.slice(i, i + size));
    }
    await Promise.all(requests.map(async (prs) => {
      try {
        const data = (await this.deps.cache.watchQuery(watchQuery(prs.length), Object.fromEntries(prs.map((pr, i) => [`i${i}`, pr.nodeId])))) as Record<string, unknown> | null;
        if (!data || typeof data !== "object") throw new Error("the watch query returned no data");
        await Promise.all(prs.map(async (pr, i) => {
          const node = data[`p${i}`];
          let facts = node === null || node === undefined ? undefined : (parseWatch(node) ?? null);
          // Past 100 checks: the rest, page by page, so a newly failing one past the first page has its name.
          try {
            if (facts?.more?.cursor) facts = await this.morePages(pr.nodeId, facts);
          } catch (error) {
            this.failed(out, [pr], 1, now, error);
            return;
          }
          // A read clears its PR's failures only once whole.
          this.failures.delete(pr.url);
          out.set(pr.url, facts);
        }));
      } catch (error) {
        this.failed(out, prs, prs.length, now, error);
      }
    }));
    return out;
  }

  /** Failed reads of `prs`, in a request of `among`: each is retried later, doubling, in requests half that size. */
  private failed(out: Map<string, WatchFacts | null | undefined>, prs: readonly { url: string }[], among: number, at: number, error: unknown) {
    for (const pr of prs) {
      const tries = (this.failures.get(pr.url)?.tries ?? 0) + 1;
      this.failures.set(pr.url, { tries, among: Math.max(1, Math.ceil(among / 2)), retryAt: at + Math.min(WATCH_RETRY_MS * 2 ** (tries - 1), WATCH_RETRY_MAX_MS) });
      out.set(pr.url, null);
    }
    this.deps.warn(`PR watch read of ${prs.length} PR${prs.length === 1 ? "" : "s"} failed: ${errorMessage(error)}`);
  }

  /** A watch read's remaining check pages, up to CHECK_PAGES in all (then the rollup speaks for the rest); throws on a push meanwhile. */
  private async morePages(nodeId: string, facts: WatchFacts): Promise<WatchFacts> {
    let { checks, more } = facts;
    for (let page = 1; more?.cursor && page < CHECK_PAGES; page++) {
      const data = (await this.deps.cache.watchQuery(CHECKS_PAGE_QUERY, { id: nodeId, after: more.cursor })) as { node?: Record<string, any> | null } | null;
      const node = data?.node;
      // A push between pages: these facts mix two heads, so the whole read fails and is retried
      // (against the new head) rather than waking anyone about the old one.
      if (!node || node.headRefOid !== facts.head) throw new Error(`its head moved from ${short(facts.head)} while its checks were read`);
      const contexts = nodes(node.commits)[0]?.commit?.statusCheckRollup?.contexts;
      checks = [...checks, ...parseChecks(contexts)];
      const cursor = nextCursor(contexts);
      more = cursor ? { rollup: more.rollup, cursor } : undefined;
    }
    const { more: _, ...rest } = facts;
    return more ? { ...rest, checks, more } : { ...rest, checks };
  }

  /**
   * Whether a pending wake still applies, as things are now: "send"; "read", when it goes once a
   * watch read of this pass confirms its head (`confirmed`: the PRs whose read this pass stored,
   * which a wake found this pass has by construction); "hold" (decided again on a later pass); or a
   * final state with why. Only watch reads move a PR's stored head, so no list decides it. Run
   * before routing and again just before each send, since routing waits on BB.
   */
  private verdict(wake: WakeRow, confirmed: ReadonlySet<string>): "send" | "read" | "hold" | NotNow {
    const { ledger, store, cache } = this.deps;
    // R2 and the worker as they are now, before anything about the Adventure the wake names.
    const owner = this.deps.ownerOf(wake.url);
    if (!owner) return new NotNow("stale", "no Adventure owns it now");
    if (owner.projectId !== wake.projectId || owner.worker !== wake.worker) {
      ledger.retarget(wake.id, owner.projectId, owner.worker);
      wake.projectId = owner.projectId;
      wake.worker = owner.worker;
    }
    const project = store.project(wake.projectId);
    if (!project || project.archivedAt !== null) return new NotNow("stale", "the Adventure is archived");
    const watch = ledger.row(wake.url);
    if (watch?.muted) return new NotNow("muted", null);
    if (!watch?.state || watch.gen !== wake.gen) return new NotNow("stale", "its watch restarted (muted and unmuted)");
    if (watch.state.ended) return new NotNow("stale", watch.state.ended.toLowerCase());
    if (this.now() - wake.createdAt >= WAKE_MAX_AGE_MS) return new NotNow("stale", "too old");
    if (watch.state.head !== wake.head) return new NotNow("stale", `head moved to ${short(watch.state.head)}`);
    if (project.paused) return "hold";
    // Unlisted (a reload's cache is empty): its branch's worker is unknown, and it can't be read.
    if (!cache.cachedPr(wake.url)) return "hold";
    return confirmed.has(wake.url) ? "send" : "read";
  }

  /**
   * Sends the pending wakes. Each group (one Adventure, one worker) is routed first; then every
   * group a worker takes gets its message, and each Adventure's coordinator gets one message for
   * all the groups that went to it.
   */
  private async deliver(confirmed: ReadonlySet<string>) {
    const { ledger, store } = this.deps;
    const groups = new Map<string, WakeRow[]>();
    for (const wake of ledger.pending()) {
      const verdict = this.verdict(wake, confirmed);
      if (verdict instanceof NotNow) {
        ledger.mark([wake.id], verdict.state, verdict.note);
        continue;
      }
      if (verdict !== "send") continue;
      const key = `${wake.projectId}\n${wake.worker ?? ""}`;
      groups.set(key, [...(groups.get(key) ?? []), wake]);
    }
    /** What went to each Adventure's coordinator: each group with why. */
    const toCoordinator = new Map<string, { wakes: WakeRow[]; route: Extract<Route, { to: "coordinator" }> }[]>();
    for (const wakes of groups.values()) {
      const project = store.project(wakes[0]!.projectId)!;
      let route: Route;
      try {
        route = await this.route(project, wakes[0]!.worker);
      } catch (error) {
        this.deps.warn(`PR watch could not route ${wakes.map((w) => `${w.pr.repo}#${w.pr.number}`).join(", ")}: ${errorMessage(error)}`);
        continue;
      }
      const section = route.to === "worker" ? await this.toWorker(project, route, wakes, confirmed) : { wakes, route };
      if (section) toCoordinator.set(project.id, [...(toCoordinator.get(project.id) ?? []), section]);
    }
    for (const [projectId, sections] of toCoordinator) await this.toCoordinator(store.project(projectId)!, sections, confirmed);
  }

  /** Who hears of these wakes (one worker's PRs); never sends. */
  private async route(project: ProjectRecord, ref: string | null): Promise<Route> {
    const { store, sdk } = this.deps;
    const worker = ref ? store.worker(project.id, Number(ref.slice(1))) : null;
    const why = unavailable(store, worker);
    if (why) return { to: "coordinator", why, resumable: false, worker };
    let thread: ThreadDto;
    try {
      thread = (await sdk.threads.get({ threadId: worker!.threadId! })) as ThreadDto;
    } catch (error) {
      return { to: "coordinator", why: `${worker!.ref}'s thread could not be read (${errorMessage(error).slice(0, 200)})`, resumable: false, worker };
    }
    if (thread.archivedAt !== null || thread.deletedAt !== null) return { to: "coordinator", why: `${worker!.ref}'s thread is archived`, resumable: false, worker };
    const open = store.openAssignment(project.id, worker!.num);
    if (BUSY_STATUSES.has(thread.status)) return { to: "worker", how: "message", worker: worker!, open: open?.ref ?? null, busy: true };
    const cold = await this.deps.coldCheck(worker!);
    if (cold) return { to: "coordinator", why: cold.replace(/\.$/, ""), resumable: true, worker };
    return { to: "worker", how: open ? "message" : "work", worker: worker!, open: open?.ref ?? null, busy: false };
  }

  /**
   * Throws NotNow unless every wake still applies and the worker can still take it as routed (the
   * same thread, and the same open assignment: none for more work, the one a message names): run
   * just before a send, after routing's waits on BB.
   */
  private still(wakes: readonly WakeRow[], confirmed: ReadonlySet<string>, to: { projectId: string; worker: string | null }, route?: Pick<Extract<Route, { to: "worker" }>, "worker" | "open">) {
    for (const wake of wakes) {
      const verdict = this.verdict(wake, confirmed);
      if (verdict instanceof NotNow) throw new NotNow(verdict.state, verdict.note, [wake.id]);
      // Held now (a pause), or moved to another Adventure or worker: routed again on a later pass.
      if (verdict !== "send" || wake.projectId !== to.projectId || wake.worker !== to.worker) throw new NotNow("pending", null);
    }
    if (!route) return;
    const { worker } = route;
    const current = this.deps.store.worker(worker.projectId, worker.num);
    const open = current ? this.deps.store.openAssignment(worker.projectId, worker.num) : null;
    if (!current || unavailable(this.deps.store, current) || current.threadId !== worker.threadId || (open?.ref ?? null) !== route.open)
      throw new NotNow("pending", null);
  }

  /** The wakes that still apply as routed; each that doesn't is marked on its own (or left pending to route again). */
  private eligible(wakes: readonly WakeRow[], confirmed: ReadonlySet<string>, to: { projectId: string; worker: string | null }): WakeRow[] {
    return wakes.filter((wake) => {
      try {
        this.still([wake], confirmed, to);
        return true;
      } catch (error) {
        if (error instanceof NotNow) this.deps.ledger.mark([wake.id], error.state, error.note);
        else throw error;
        return false;
      }
    });
  }

  /** Marks the wakes sending, runs `send` (its answer says where they went) and marks what came of it. */
  private async sending(wakes: readonly WakeRow[], send: () => Promise<string>) {
    const ids = wakes.map((w) => w.id);
    this.deps.ledger.mark(ids, "sending");
    try {
      this.deps.ledger.mark(ids, "sent", await send());
    } catch (error) {
      if (error instanceof NotNow) {
        // The wake that stopped applying gets its state; the others go back to pending, and the
        // next pass sends them on their own.
        const about = error.ids ?? ids;
        this.deps.ledger.mark(about, error.state, error.note);
        this.deps.ledger.mark(ids.filter((id) => !about.includes(id)), "pending");
      } else {
        if (isDefiniteRejection(error)) this.deps.ledger.refused(ids, `BB refused the send: ${errorMessage(error)}`.slice(0, 300));
        else this.deps.ledger.mark(ids, "failed", errorMessage(error).slice(0, 300));
        this.deps.warn(`PR watch could not wake about ${wakes.map((w) => `${w.pr.repo}#${w.pr.number}`).join(", ")}: ${errorMessage(error)}`);
      }
    } finally {
      this.deps.changed(wakes[0]!.projectId);
    }
  }

  /** One worker's wakes, as more work or a message. A route to the coordinator instead when giving the work failed. */
  private async toWorker(project: ProjectRecord, route: Extract<Route, { to: "worker" }>, routed: WakeRow[], confirmed: ReadonlySet<string>): Promise<{ wakes: WakeRow[]; route: Extract<Route, { to: "coordinator" }> } | null> {
    const { store, sdk } = this.deps;
    const { worker, open } = route;
    // Routing waited on BB: the message names only the wakes that still apply.
    const wakes = this.eligible(routed, confirmed, { projectId: project.id, worker: worker.ref });
    if (!wakes.length) return null;
    const body = wakeBody(wakes);
    const prs = wakes.map((w) => `${w.pr.repo}#${w.pr.number}`).join(", ");
    const kinds = [...new Set(wakes.flatMap((w) => w.changes.map((c) => c.kind)))].join(", ");
    let failure: string | null = null;
    await this.sending(wakes, async () => {
      if (route.how === "message") {
        this.still(wakes, confirmed, { projectId: project.id, worker: worker.ref }, route);
        await sdk.threads.send({
          threadId: worker.threadId!, mode: "steer-if-active",
          input: textInput(`Adventures · ${project.name} · PR watch\n\nGitHub news on your PR${wakes.length === 1 ? "" : "s"} (from the plugin, not your lead):\n\n${body}\n\n${NOT_A_MERGE} Handle what needs it (a fix, a reply, or nothing) within ${open ? `your ${open}` : "your current work"}; its report covers it.`),
        });
        const how = route.busy ? "while it works" : `during ${open}`;
        store.log(project.id, "pr-watch", `PR watch: woke ${worker.ref} about ${prs} (${kinds}) ${how}.`, { urls: wakes.map((w) => w.url) });
        return `${worker.ref}: message (${how})`;
      }
      const to = { projectId: project.id, worker: worker.ref };
      this.still(wakes, confirmed, to, route);
      let assignment: string;
      try {
        assignment = await this.deps.giveWork(project.id, worker.ref, `PR watch (sent by the Adventures plugin, not your lead): GitHub news on your PR${wakes.length === 1 ? "" : "s"}.\n\n${body}\n\n${NOT_A_MERGE} Handle what needs it (a fix, a reply to a comment, or nothing), keep the PR's stage and notes current, then report.`,
          () => this.still(wakes, confirmed, to, route));
      } catch (error) {
        if (error instanceof NotNow) throw error;
        failure = errorMessage(error).slice(0, 200);
        // Back to pending: the coordinator's message carries them now.
        throw new NotNow("pending", null);
      }
      store.log(project.id, "pr-watch", `PR watch: woke ${worker.ref} about ${prs} (${kinds}) with ${assignment}.`, { urls: wakes.map((w) => w.url) });
      return `${worker.ref}: ${assignment}`;
    });
    return failure ? { wakes, route: { to: "coordinator", why: `the plugin could not give ${worker.ref} the work (${failure})`, resumable: true, worker } } : null;
  }

  /** One message to an Adventure's coordinator for every group of wakes routed to it, each with why. */
  private async toCoordinator(project: ProjectRecord, sections: { wakes: WakeRow[]; route: Extract<Route, { to: "coordinator" }> }[], confirmed: ReadonlySet<string>) {
    const { store, sdk } = this.deps;
    // Each section as it stands now: a wake that no longer applies leaves its message.
    const live: typeof sections = [];
    for (const section of sections) {
      const wakes = this.eligible(section.wakes, confirmed, { projectId: project.id, worker: section.wakes[0]!.worker });
      if (wakes.length) live.push({ wakes, route: section.route });
    }
    if (!live.length) return;
    const all = live.flatMap((s) => s.wakes);
    const text = live.map(({ wakes, route }) => {
      const { worker } = route;
      const next = route.resumable
        ? `If it needs work, send it to ${worker!.ref} (initiative_message work:true, resumeCold:true) or to a fresh worker with handoffs:["${worker!.ref}"]; or leave it.`
        : worker && worker.role === "work" ? `If it needs work, give it to a fresh worker with handoffs:["${worker.ref}"]; or leave it.` : "If it needs work, give it to a worker; or leave it.";
      return `${route.why[0]!.toUpperCase()}${route.why.slice(1)}:\n\n${wakeBody(wakes)}\n\n${next}`;
    }).join("\n\n---\n\n");
    await this.sending(all, async () => {
      if (!project.coordinatorThreadId) throw new Error("the Adventure has no coordinator thread");
      await sdk.threads.send({
        threadId: project.coordinatorThreadId, mode: "queue-if-active",
        input: textInput(`Adventures · ${project.name} · PR watch\n\nGitHub news on PRs of this Adventure whose workers can't take it themselves, so it comes to you. ${NOT_A_MERGE}\n\n${text}`),
      });
      for (const { wakes, route } of live)
        store.log(project.id, "pr-watch", `PR watch: ${wakes.map((w) => `${w.pr.repo}#${w.pr.number}`).join(", ")} (${[...new Set(wakes.flatMap((w) => w.changes.map((c) => c.kind)))].join(", ")}) went to the coordinator: ${route.why}.`, { urls: wakes.map((w) => w.url) });
      return `coordinator: ${live.map((s) => s.route.why).join("; ")}`.slice(0, 500);
    });
  }
}

/** The PR detail view's watch: whether it is on, muted, and its latest wakes. */
export interface PrWatchView {
  url: string;
  /** Owned by this Adventure and open: watched unless muted. */
  watched: boolean;
  muted: boolean;
  /** Comment-only wakes in a row; at COMMENT_WAKE_CAP comments stop waking. */
  commentWakes: number;
  commentCap: number;
  ended: "MERGED" | "CLOSED" | null;
  wakes: { at: number; head: string; changes: string[]; state: WakeRow["state"]; routed: string | null }[];
}

export function readPrWatch(ledger: WatchLedger, url: string, owned: boolean): PrWatchView {
  const row = ledger.row(url);
  return {
    url,
    watched: owned && !row?.state?.ended,
    muted: row?.muted ?? false,
    commentWakes: row?.state?.commentWakes ?? 0,
    commentCap: COMMENT_WAKE_CAP,
    ended: row?.state?.ended ?? null,
    wakes: ledger.wakes(url, 5).map((w) => ({ at: w.createdAt, head: w.head, changes: w.changes.map((c) => changeLine(c, w.head).split("\n")[0]!), state: w.state, routed: w.routed })),
  };
}
