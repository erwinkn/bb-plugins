// W548, W554: PR watches. An agent watches a PR with initiative_pr_watch: when it changes on
// GitHub (checks fail, required checks pass, someone comments, it conflicts, or no check reports
// after a push), the plugin wakes the thread that watched it, so nobody has to notice a red check
// in the PRs tab. Watching has nothing to do with R2 ownership (W554: ownership resolves for few
// PRs, so watching by owner covered almost none).
//
// - The watch call reads the PR once and answers with its state: that is the baseline, and only
//   changes after it wake. A merge or a close ends the watch, waking nobody; so does an unwatch.
// - The merge queue's cache lists each repository's open PRs (merge-queue-server.ts). The list
//   only says when to read a watched PR (its head, updatedAt, check counts or a conflict moved);
//   one it doesn't list (another author, a repository no Adventure lists) is read every
//   UNLISTED_READ_MS. Every fact a wake carries comes from one watch read (the query below, in the
//   cache's details slots), diffed against the state the last read left. A list and a watch read
//   can see two heads; a wake never mixes them.
// - State and wakes are stored (pr_watches, pr_wakes), so a reload neither misses a change nor
//   repeats a wake.
// - A wake goes to its watcher: a worker as more work, or as a message when it is busy; the
//   coordinator as a message. To the coordinator, with why, when the worker is retired or stopped,
//   idle with a cold cache (cold-cache.ts), or the thread is no longer the Adventure's. Each
//   recipient gets one message a pass, whatever it covers.
// - Comments by the `gh` account never wake: agents and the user share it, and nothing in GitHub's
//   data tells them apart. Bots and other people do.
import type Database from "better-sqlite3";
import { BUSY_STATUSES, ProjectError, errorMessage, isDefiniteRejection, textInput, type Sdk, type ThreadDto } from "./bb";
import { FAILED, PASSED, mergeable as mergeableState, type MergeQueue, type MergeableState, type QueuedPullRequest } from "./merge-queue";
import { canonicalPrUrl } from "./pr-stages";
export { PR_WATCH_MIGRATIONS } from "./pr-watch-migrations";
import type { ProjectRecord, Store, WorkerRecord } from "./store";

/** A pass every this often: keeps the repositories of watched PRs on the 2-minute cadence. */
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
/** A watched PR no list shows (another author, merged or closed since, a capped list) is read this often. */
export const UNLISTED_READ_MS = 10 * 60_000;
/** Comments and reviews a watch read sees, newest; more since the last pass read as "20+". */
export const WATCH_COMMENTS = 20;
/** Wakes kept per PR, newest. */
export const WAKES_KEPT = 20;
/** A wake still unsent after this (a long pause, a PR no longer listed) is dropped as stale. */
export const WAKE_MAX_AGE_MS = 24 * 60 * 60_000;
/** Sends of a wake BB may refuse (a 4xx: nothing happened), each routed afresh, before it fails. */
export const WAKE_REFUSALS = 3;

/** What wakes a PR's watcher. A merge or a close only ends the watch (Erwin, 2026-10-28). */
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

/** A PR's node id by repository and number, for a watch on a PR no list shows. */
export const PR_ID_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } }
}`;

/**
 * The watch query for `count` PRs by node id, `p0` to `p<count-1>`: state, title, head,
 * mergeability, the head commit's checks with whether the base branch requires each (`isRequired`
 * needs the PR's id, so each PR is its own alias), and the latest comments and reviews.
 * `baseline`: also the review decision and unresolved review threads, which only the watch call's
 * answer shows. And the `gh` account's login, whose comments never wake: a watch whose repository
 * no Adventure lists learns it here.
 */
export function watchQuery(count: number, baseline = false): string {
  const indexes = Array.from({ length: count }, (_, i) => i);
  const review = baseline ? `
    reviewDecision reviewThreads(first: 100) { totalCount nodes { isResolved } }` : "";
  return `query(${indexes.map((i) => `$i${i}: ID!`).join(", ")}) {\n  viewer { login }\n${indexes.map((i) => `  p${i}: node(id: $i${i}) { ... on PullRequest {
    id number title state headRefOid mergeable createdAt${review}
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
  /** Absent in a node without it (older fixtures). */
  title?: string;
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
  /** A baseline read's review state (watchQuery's `baseline`): GitHub's decision, lower case, and the unresolved threads of the first 100. */
  review?: { decision: string | null; unresolved: number; more: boolean };
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
  const threads = n.reviewThreads as { totalCount?: unknown; nodes?: unknown } | null | undefined;
  const review = threads && typeof threads === "object"
    ? { review: {
      decision: typeof n.reviewDecision === "string" && n.reviewDecision ? n.reviewDecision.toLowerCase() : null,
      unresolved: nodes(threads).filter((t) => t.isResolved === false).length,
      more: typeof threads.totalCount === "number" && threads.totalCount > nodes(threads).length,
    } }
    : {};
  return {
    state, ...(typeof n.title === "string" ? { title: n.title } : {}), head: n.headRefOid, mergeable: mergeableState(n.mergeable), createdAt: time(n.createdAt) ?? 0,
    checks, ...more, ...(required ? { required } : {}), comments, ...review,
  };
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
  /** When `head` was pushed, as far as the watcher knows; null for a baseline's head that had checks. */
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
 * Whether a watched PR calls for a watch read. Listed (`pr`): its list facts moved, the list knows
 * a mergeability other than the stored one (a conflict starting or ending; GitHub's "unknown"
 * while it computes, which every PR shows after a push to its base, says nothing), or its last
 * read is WATCH_RESYNC_MS old. Unlisted (null): its last read is UNLISTED_READ_MS old. Either:
 * its no-checks wake is due (`repoHasChecks`, as in diffWatch).
 */
export function needsRead(state: WatchState, pr: (Parameters<typeof listFingerprint>[0] & Pick<QueuedPullRequest, "mergeable">) | null, now: number, repoHasChecks: boolean): boolean {
  if (pr ? state.fingerprint !== listFingerprint(pr) || now - state.readAt >= WATCH_RESYNC_MS : now - state.readAt >= UNLISTED_READ_MS) return true;
  if (pr && pr.mergeable !== "unknown" && pr.mergeable !== state.mergeable) return true;
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

/**
 * A baseline: the PR as the watch call read it, waking nobody. A head without any check yet counts
 * as pushed now, so no check NO_CHECKS_MS after the watch still wakes.
 */
export function baselineState(watch: WatchFacts, now: number, fingerprint: string): WatchState {
  const unchecked = watch.checks.length === 0 && !watch.more;
  return {
    ...EMPTY,
    head: watch.head,
    fingerprint,
    readAt: now,
    failing: failingNames(watch),
    passed: gate(watch).passed,
    mergeable: watch.mergeable,
    ...seen(null, watch.comments),
    pushedAt: unchecked ? now : null,
    noChecksDone: !unchecked,
    ended: watch.state === "OPEN" ? null : watch.state,
  };
}

/**
 * The changes from `prev` (the baseline, or the last read's state) to the PR as one watch read saw
 * it: every fact comes from that read, so none of a wake's can be of another head. `login` is the
 * `gh` account, whose comments never wake (null: comments are left for a pass that knows it).
 * `repoHasChecks`: some listed PR of its repository has checks, so a PR without any after a push
 * is news. `fingerprint`: the list facts the read was for (WatchState.fingerprint). `capped`:
 * comments that would have woken past COMMENT_WAKE_CAP.
 */
export function diffWatch(
  prev: WatchState,
  watch: WatchFacts,
  context: { now: number; login: string | null; repoHasChecks: boolean; fingerprint: string },
): { state: WatchState; changes: Change[]; capped: boolean } {
  const { now, fingerprint } = context;
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
  // A head is pushed when the watcher first sees it.
  const pushedAt = pushed ? now : prev.pushedAt;
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

/**
 * initiative_pr_watch's answer: the PR as the watch read it. That baseline wakes nobody, so what
 * needs action now (failing checks, a conflict, requested changes, unresolved threads) is named.
 * `who`: whom it wakes ("you", or a W#); `replaced`: who watched it before.
 */
export function watchAnswer(url: string, facts: WatchFacts, who: string, replaced: string | null) {
  const failing = failingNames(facts);
  const pending = [...new Set(facts.checks.filter((c) => c.outcome === "pending").map((c) => c.name))];
  const gating = gate(facts);
  const checks = !facts.checks.length && !facts.more
    ? "none reported yet"
    : gating.passed ? `${gating.required ? "required" : "all"} passed (${plural(gating.names.length, "check")})`
    : [failing.length ? `failing: ${failing.join(", ")}` : "", pending.length ? `${plural(pending.length, "check")} pending` : "", gating.required ? `required: ${gating.names.join(", ")}` : ""].filter(Boolean).join("; ") || "not all passed";
  const unresolved = facts.review ? `${facts.review.unresolved}${facts.review.more ? "+" : ""}` : null;
  const attention = [
    failing.length ? `Checks failing: ${failing.join(", ")}.` : "",
    facts.mergeable === "conflicting" ? "It conflicts with its base branch." : "",
    facts.review?.decision === "changes_requested" ? "Changes are requested." : "",
    facts.review?.unresolved ? `${unresolved} unresolved review thread${unresolved === "1" ? "" : "s"}.` : "",
    // Past the first 100 threads none was read, and an unresolved one there wakes nobody later.
    facts.review?.more ? "Only its first 100 review threads were read: check the rest on GitHub." : "",
  ].filter(Boolean);
  return {
    watching: url,
    ...(facts.title ? { title: facts.title } : {}),
    wakes: who,
    ...(replaced ? { replaced: `${replaced} watched it before; ${who === "you" ? "you do" : `${who} does`} now.` } : {}),
    now: {
      head: short(facts.head),
      checks,
      mergeable: facts.mergeable,
      review: facts.review?.decision ?? null,
      ...(unresolved !== null ? { unresolvedThreads: unresolved } : {}),
    },
    ...(attention.length ? { attention: `${attention.join(" ")} The watch wakes only on later changes: handle these now.` } : {}),
    note: `Wakes ${who === "you" ? "you" : who} on newly failing checks, required checks passing, new comments or reviews by others, a conflict, or no check ${NO_CHECKS_MS / 60_000} min after a push; ends when the PR merges or closes, or with initiative_pr_unwatch.`,
  };
}

export const NOT_A_MERGE = "A wake is not a merge decision: check the PR yourself before you act.";

// The ledger ---------------------------------------------------------------------

export interface WatchRow {
  url: string;
  /** The watcher's Adventure: its coordinator hears what the watcher can't take. */
  projectId: string;
  nodeId: string | null;
  /** The thread that watches the PR; null when nobody does. */
  watcher: string | null;
  /** The previous build's mute, which an unwatch sets so a rollback leaves the PR alone. */
  muted: boolean;
  state: WatchState | null;
  /** Moves on each watch and unwatch. */
  gen: number;
  updatedAt: number;
}

export interface WakeRow {
  id: number;
  projectId: string;
  url: string;
  /** The watcher's W# when the wake was found; null for the coordinator or another thread. */
  worker: string | null;
  /** The watcher the wake was found for (null in a W548 row). */
  threadId: string | null;
  head: string;
  pr: WakePr;
  changes: Change[];
  createdAt: number;
  gen: number;
  /** muted: a W548 wake skipped by a mute. */
  state: "pending" | "sending" | "sent" | "stale" | "muted" | "failed" | "uncertain";
  sentAt: number | null;
  routed: string | null;
  /** Sends BB refused (WAKE_REFUSALS). */
  refusals: number;
}

/** What one pass writes for a PR: its new state, and the wake it found, if any. */
export interface WatchWrite {
  url: string;
  /** The watch's generation the pass read: a watch or unwatch since makes the write a no-op. */
  gen: number;
  state: WatchState;
  wake: { projectId: string; threadId: string; worker: string | null; pr: WakePr; changes: Change[] } | null;
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

  private threadWorkerQuery?: Database.Statement;
  /** The W# whose current thread this is, by key. */
  threadWorker(projectId: string, threadId: string): string | null {
    this.threadWorkerQuery ??= this.db.prepare("SELECT num FROM workers WHERE project_id = ? AND thread_id = ? LIMIT 1").pluck();
    const num = this.threadWorkerQuery.get(projectId, threadId) as number | undefined;
    return num === undefined ? null : `W${num}`;
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

  /** The watches a pass reads: watched, not ended. */
  active(): Map<string, WatchRow> {
    const rows = (this.db.prepare("SELECT * FROM pr_watches WHERE watcher_thread_id IS NOT NULL AND state IS NOT NULL").all() as Record<string, unknown>[]).map(toWatch);
    return new Map(rows.filter((r) => !r.state!.ended).map((r) => [r.url, r]));
  }

  row(url: string): WatchRow | null {
    const r = this.db.prepare("SELECT * FROM pr_watches WHERE url = ?").get(url) as Record<string, unknown> | undefined;
    return r ? toWatch(r) : null;
  }

  /**
   * One pass's states and wakes, together: a wake is never stored without the state that found
   * it, nor the reverse. A PR watched again or unwatched since the pass read it (its generation
   * moved) is left as that left it. The URLs whose state was stored.
   */
  write(writes: readonly WatchWrite[]): Set<string> {
    const stored = new Set<string>();
    if (!writes.length) return stored;
    const at = this.now();
    const update = this.db.prepare(`UPDATE pr_watches SET state = ?, updated_at = ? WHERE url = ? AND gen = ? AND watcher_thread_id IS NOT NULL`);
    const wake = this.db.prepare(`INSERT INTO pr_wakes (project_id, url, worker, thread_id, head, pr, changes, created_at, gen, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`);
    const prune = this.db.prepare(`DELETE FROM pr_wakes WHERE url = ? AND state NOT IN ('pending', 'sending') AND id <= (SELECT id FROM pr_wakes WHERE url = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`);
    this.db.transaction(() => {
      for (const w of writes) {
        if (!update.run(JSON.stringify(w.state), at, w.url, w.gen).changes) continue;
        stored.add(w.url);
        if (!w.wake) continue;
        wake.run(w.wake.projectId, w.url, w.wake.worker, w.wake.threadId, w.state.head, JSON.stringify(w.wake.pr), JSON.stringify(w.wake.changes), at, w.gen);
        prune.run(w.url, w.url, WAKES_KEPT);
      }
    })();
    return stored;
  }

  /**
   * `threadId` watches the PR from `state` (the watch call's baseline), for `projectId`; it
   * replaces any earlier watcher. Moves the generation: a pass that read the PR before, and a wake
   * stored before, no longer apply. The row as it was.
   */
  watch(url: string, projectId: string, threadId: string, nodeId: string, state: WatchState): WatchRow | null {
    const at = this.now();
    return this.db.transaction(() => {
      const before = this.row(url);
      this.db.prepare(`INSERT INTO pr_watches (url, project_id, node_id, muted, since, state, gen, updated_at, watcher_thread_id) VALUES (?, ?, ?, 0, ?, ?, 1, ?, ?)
        ON CONFLICT (url) DO UPDATE SET project_id = excluded.project_id, node_id = excluded.node_id, muted = 0, since = excluded.since,
        state = excluded.state, gen = pr_watches.gen + 1, updated_at = excluded.updated_at, watcher_thread_id = excluded.watcher_thread_id`)
        .run(url, projectId, nodeId, at, JSON.stringify(state), at, threadId);
      return before;
    })();
  }

  /**
   * Nobody watches the PR any more (when `of` watches it, if given); its state and wakes stay to
   * read. A W548 row nobody watches is muted, so a rollback leaves it alone too. Whether it changed.
   */
  unwatch(url: string, of?: string): boolean {
    return this.db.prepare(`UPDATE pr_watches SET watcher_thread_id = NULL, muted = 1, gen = gen + 1, updated_at = ?
      WHERE url = ? AND (watcher_thread_id = ? OR (? IS NULL AND (watcher_thread_id IS NOT NULL OR muted = 0)))`)
      .run(this.now(), url, of ?? null, of ?? null).changes > 0;
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
   * The ids this failed.
   */
  refused(ids: readonly number[], note: string): number[] {
    const update = this.db.prepare(`UPDATE pr_wakes SET refusals = refusals + 1, routed = ?,
      state = CASE WHEN refusals + 1 >= ? THEN 'failed' ELSE 'pending' END WHERE id = ? RETURNING state`);
    return this.db.transaction(() => ids.filter((id) => (update.get(note, WAKE_REFUSALS, id) as { state: string } | undefined)?.state === "failed"))();
  }

  /** On load: sends a reload cut short are uncertain, never sent again. Their ids. */
  interrupted(): WakeRow[] {
    const rows = (this.db.prepare("SELECT * FROM pr_wakes WHERE state = 'sending' ORDER BY id").all() as Record<string, unknown>[]).map(toWake);
    this.mark(rows.map((r) => r.id), "uncertain");
    return rows;
  }
}

const toWatch = (r: Record<string, unknown>): WatchRow => ({
  url: String(r.url), projectId: String(r.project_id), nodeId: (r.node_id as string | null) ?? null, watcher: (r.watcher_thread_id as string | null) ?? null, muted: r.muted === 1,
  state: parse<WatchState>(r.state), gen: Number(r.gen), updatedAt: Number(r.updated_at),
});
const toWake = (r: Record<string, unknown>): WakeRow => ({
  id: Number(r.id), projectId: String(r.project_id), url: String(r.url), worker: (r.worker as string | null) ?? null, threadId: (r.thread_id as string | null) ?? null,
  head: String(r.head), pr: parse<WakePr>(r.pr) ?? { repo: "", number: 0, title: "" }, changes: parse<Change[]>(r.changes) ?? [], createdAt: Number(r.created_at),
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
  /** A wake was stored or sent, or a watch changed: the dashboards read again. */
  changed(projectId: string): void;
  warn(message: string): void;
}

/** A read saw checks (some past the first 100 included). */
const hasChecks = (facts: WatchFacts) => facts.checks.length > 0 || !!facts.more;

/** The repository of a canonical PR URL, lower case. */
const repoOf = (url: string) => /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(url)?.[1] ?? "";

/** Who a watcher thread is, in its Adventure: a W#, the coordinator, or (no longer either) the thread. */
export function watcherLabel(store: Pick<Store, "project">, ledger: Pick<WatchLedger, "threadWorker">, projectId: string, threadId: string): string {
  if (store.project(projectId)?.coordinatorThreadId === threadId) return "the coordinator";
  return ledger.threadWorker(projectId, threadId) ?? threadId;
}

/**
 * Why a worker can't take a wake itself, or null when it can. A Stop records a cancel request on
 * the work it stops (cancelAssignment), not `userStopped`: the worker stays stopped until its lead
 * gives it new work.
 */
function unavailable(store: Pick<Store, "latestAssignment" | "openAssignment">, worker: WorkerRecord): string | null {
  if (worker.role !== "work") return `${worker.ref} is a reviewer`;
  if (worker.state === "retired") return `${worker.ref} is retired`;
  if (worker.userStopped || [store.latestAssignment(worker.projectId, worker.num), store.openAssignment(worker.projectId, worker.num)].some((a) => a?.cancelRequested))
    return `${worker.ref} was stopped`;
  if (!worker.threadId) return `${worker.ref} has no thread`;
  return null;
}

/** What a coordinator may do with news its worker can't take: resume that worker, hand off to a fresh one, or leave it. */
const nextStep = (worker: WorkerRecord | null, resumable: boolean) =>
  resumable && worker
    ? `If it needs work, send it to ${worker.ref} (initiative_message work:true, resumeCold:true) or to a fresh worker with handoffs:["${worker.ref}"]; or leave it.`
    : worker && worker.role === "work" ? `If it needs work, give it to a fresh worker with handoffs:["${worker.ref}"]; or leave it.` : "If it needs work, give it to a worker; or leave it.";

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
  /** `why` null: the coordinator watches the PR itself. */
  | { to: "coordinator"; why: string | null; resumable: boolean; worker: WorkerRecord | null };

/**
 * Watches the PRs agents asked to watch. `watch()` starts one from the PR as it is. `check()` runs
 * one pass (or one more after the running one): read each Adventure's queue from the cache, read
 * the watched PRs whose list moved (those no list shows, now and then; those with a wake waiting
 * to go), diff each read, store states and wakes, then send the pending wakes whose head a read
 * of this pass confirmed. The server runs one every WATCH_TICK_MS and after each list lands;
 * reads never wait for it.
 */
export class PrWatcher {
  private running: Promise<void> | null = null;
  private again = false;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Failed watch reads, by URL: retried after `retryAt`, in requests of `among` PRs. */
  private failures = new Map<string, { tries: number; among: number; retryAt: number }>();
  /** Whether each Adventure listed a watched PR's repository at its last pass; unknown counts as yes. */
  private watching = new Map<string, boolean>();
  /** The `gh` account's login as a watch read last saw it, for when no list has run. */
  private viewer: string | null = null;

  constructor(private readonly deps: PrWatchDeps, private readonly now: () => number = Date.now) {}

  /**
   * initiative_pr_watch: `threadId` watches the PR at `url` (canonical) for its Adventure
   * `projectId`, from the PR as one read finds it now: that baseline wakes nobody, so the caller
   * acts on what it shows. Refuses a PR merged, closed or gone. The facts read, and the watch it
   * replaced.
   */
  async watch(url: string, projectId: string, threadId: string): Promise<{ facts: WatchFacts; replaced: WatchRow | null }> {
    const { cache, ledger } = this.deps;
    const listed = cache.cachedPr(url);
    const nodeId = listed?.nodeId ?? (await this.nodeId(url));
    const data = (await cache.watchQuery(watchQuery(1, true), { i0: nodeId })) as Record<string, unknown> | null;
    this.sawViewer(data);
    let facts = parseWatch(data?.p0);
    if (!facts) throw new ProjectError(`GitHub has no readable PR at ${url}.`);
    if (facts.more?.cursor) facts = await this.morePages(nodeId, facts);
    if (facts.state !== "OPEN") throw new ProjectError(`${url} is ${facts.state.toLowerCase()}: there is nothing to watch.`);
    if (hasChecks(facts)) ledger.markCi([repoOf(url)]);
    const replaced = ledger.watch(url, projectId, threadId, nodeId, baselineState(facts, this.now(), listed ? listFingerprint(listed) : ""));
    this.failures.delete(url);
    this.watching.delete(projectId);
    this.deps.changed(projectId);
    return { facts, replaced };
  }

  private sawViewer(data: unknown) {
    const login = (data as { viewer?: { login?: unknown } } | null)?.viewer?.login;
    if (typeof login === "string" && login) this.viewer = login;
  }

  /** A PR's node id from GitHub, for one no list shows. */
  private async nodeId(url: string): Promise<string> {
    const [, owner, name, number] = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url)!;
    const data = (await this.deps.cache.watchQuery(PR_ID_QUERY, { owner, name, number: Number(number) })) as { repository?: { pullRequest?: { id?: unknown } | null } | null } | null;
    const id = data?.repository?.pullRequest?.id;
    if (typeof id !== "string") throw new ProjectError(`GitHub has no PR at ${url} that the gh account can read.`);
    return id;
  }

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
    const now = this.now();
    const projects = store.projects();
    const open = new Set(projects.map((p) => p.id));
    const active = new Map([...ledger.active()].filter(([, row]) => open.has(row.projectId) && row.nodeId));
    const watchedRepos = new Set([...active.keys()].map(repoOf));
    /** The watched PRs a list shows, by URL, whichever Adventure lists them. */
    const listed = new Map<string, QueuedPullRequest>();
    const withChecks = new Set<string>();
    for (const project of projects) {
      let queue: MergeQueue;
      try {
        queue = await cache.read(project.id, { watch: this.watches(project.id) });
      } catch (error) {
        this.deps.warn(`PR watch could not read ${project.name}'s PRs: ${errorMessage(error)}`);
        continue;
      }
      this.watching.set(project.id, queue.repos.some((r) => watchedRepos.has(r.repo.toLowerCase())));
      for (const pr of queue.pullRequests) {
        if (pr.checks.total > 0) withChecks.add(pr.repo.toLowerCase());
        const url = canonicalPrUrl(pr.url);
        if (url && active.has(url) && pr.headOid) listed.set(url, pr);
      }
    }
    // A repository keeps its CI evidence once seen: a lone PR pushed without checks is news there.
    const known = ledger.ciRepos();
    const found = [...withChecks].filter((repo) => !known.has(repo));
    if (found.length) ledger.markCi(found);
    const ciRepos = new Set([...known, ...found]);

    // Watch reads: PRs whose list or last read calls for one (needsRead), and those with a wake
    // waiting for a read to confirm its head.
    const confirming = new Set<string>();
    for (const wake of ledger.pending()) if (this.verdict(wake, new Set()) === "read") confirming.add(wake.url);
    const asks: { url: string; nodeId: string; repo: string }[] = [];
    for (const row of active.values()) {
      const repo = repoOf(row.url);
      if ((confirming.has(row.url) || needsRead(row.state!, listed.get(row.url) ?? null, now, ciRepos.has(repo))) && this.retryDue(row.url, now))
        asks.push({ url: row.url, nodeId: row.nodeId!, repo });
    }
    const facts = await this.readWatches(asks, now);
    // A read's checks are CI evidence too, for a repository no Adventure lists.
    const read = [...new Set(asks.filter((a) => { const f = facts.get(a.url); return f && hasChecks(f); }).map((a) => a.repo))].filter((repo) => !ciRepos.has(repo));
    if (read.length) {
      ledger.markCi(read);
      for (const repo of read) ciRepos.add(repo);
    }

    const writes: WatchWrite[] = [];
    const login = cache.login ?? this.viewer;
    for (const { url, repo } of asks) {
      // null: its read failed and waits for its retry.
      const watch = facts.get(url);
      if (watch === null) continue;
      const row = active.get(url)!;
      const pr = listed.get(url);
      // Gone from GitHub: read as closed, which ends the watch.
      const { state, changes, capped } = watch
        ? diffWatch(row.state!, watch, { now, login, repoHasChecks: ciRepos.has(repo), fingerprint: pr ? listFingerprint(pr) : "" })
        : { state: { ...row.state!, readAt: now, ended: "CLOSED" as const }, changes: [], capped: false };
      const about: WakePr = { repo: pr?.repo ?? repo, number: Number(url.split("/").pop()), title: watch?.title ?? pr?.title ?? "" };
      writes.push({
        url, gen: row.gen, state,
        wake: changes.length ? { projectId: row.projectId, threadId: row.watcher!, worker: ledger.threadWorker(row.projectId, row.watcher!), pr: about, changes } : null,
      });
      if (capped)
        store.log(row.projectId, "pr-watch", `PR watch: new comments on ${about.repo}#${about.number} woke nobody after ${COMMENT_WAKE_CAP} comment-only wakes in a row; news about its checks, a conflict or a push wakes again.`, { url });
    }
    const stored = ledger.write(writes);
    const woken = new Set(writes.flatMap((w) => (w.wake ? [w.wake.projectId] : [])));
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
        this.sawViewer(data);
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
    const { ledger, store } = this.deps;
    const watch = ledger.row(wake.url);
    if (!watch?.watcher) return new NotNow("stale", "unwatched");
    if (!watch.state || watch.gen !== wake.gen || watch.watcher !== wake.threadId) return new NotNow("stale", "watched again since");
    const project = store.project(wake.projectId);
    if (!project || project.archivedAt !== null) return new NotNow("stale", "the Adventure is archived");
    if (watch.state.ended) return new NotNow("stale", watch.state.ended.toLowerCase());
    if (this.now() - wake.createdAt >= WAKE_MAX_AGE_MS) return new NotNow("stale", "too old");
    if (watch.state.head !== wake.head) return new NotNow("stale", `head moved to ${short(watch.state.head)}`);
    if (project.paused) return "hold";
    return confirmed.has(wake.url) ? "send" : "read";
  }

  /**
   * Sends the pending wakes. Each group (one watcher) is routed first; then every group a worker
   * takes gets its message, and each Adventure's coordinator gets one message for all the groups
   * that went to it.
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
      const key = `${wake.projectId}\n${wake.threadId}`;
      groups.set(key, [...(groups.get(key) ?? []), wake]);
    }
    /** What went to each Adventure's coordinator: each group with why. */
    const toCoordinator = new Map<string, { wakes: WakeRow[]; route: Extract<Route, { to: "coordinator" }> }[]>();
    for (const wakes of groups.values()) {
      const project = store.project(wakes[0]!.projectId)!;
      let route: Route;
      try {
        route = await this.route(project, wakes[0]!.threadId!);
      } catch (error) {
        this.deps.warn(`PR watch could not route ${wakes.map((w) => `${w.pr.repo}#${w.pr.number}`).join(", ")}: ${errorMessage(error)}`);
        continue;
      }
      const section = route.to === "worker" ? await this.toWorker(project, route, wakes, confirmed) : { wakes, route };
      if (section) toCoordinator.set(project.id, [...(toCoordinator.get(project.id) ?? []), section]);
    }
    for (const [projectId, sections] of toCoordinator) await this.toCoordinator(store.project(projectId)!, sections, confirmed);
  }

  /** Who hears of these wakes (one watcher's PRs); never sends. */
  private async route(project: ProjectRecord, threadId: string): Promise<Route> {
    const { store, sdk, ledger } = this.deps;
    if (threadId === project.coordinatorThreadId) return { to: "coordinator", why: null, resumable: false, worker: null };
    const ref = ledger.threadWorker(project.id, threadId);
    const worker = ref ? store.worker(project.id, Number(ref.slice(1))) : null;
    if (!worker) return { to: "coordinator", why: `the thread that watches it (${threadId}) is no longer this Adventure's coordinator or one of its workers`, resumable: false, worker: null };
    const why = unavailable(store, worker);
    if (why) return { to: "coordinator", why, resumable: false, worker };
    let thread: ThreadDto;
    try {
      thread = (await sdk.threads.get({ threadId: worker.threadId! })) as ThreadDto;
    } catch (error) {
      return { to: "coordinator", why: `${worker.ref}'s thread could not be read (${errorMessage(error).slice(0, 200)})`, resumable: false, worker };
    }
    if (thread.archivedAt !== null || thread.deletedAt !== null) return { to: "coordinator", why: `${worker.ref}'s thread is archived`, resumable: false, worker };
    // A Stop landing: BB refuses a steer now, and the turn it would join is ending.
    if (thread.status === "stopping") return { to: "coordinator", why: `${worker.ref}'s thread is stopping`, resumable: true, worker };
    const open = store.openAssignment(project.id, worker.num);
    if (BUSY_STATUSES.has(thread.status)) return { to: "worker", how: "message", worker, open: open?.ref ?? null, busy: true };
    const cold = await this.deps.coldCheck(worker);
    if (cold) return { to: "coordinator", why: cold.replace(/\.$/, ""), resumable: true, worker };
    return { to: "worker", how: open ? "message" : "work", worker, open: open?.ref ?? null, busy: false };
  }

  /**
   * Throws NotNow unless every wake still applies and the worker can still take it as routed (the
   * same thread, and the same open assignment: none for more work, the one a message names): run
   * just before a send, after routing's waits on BB.
   */
  private still(wakes: readonly WakeRow[], confirmed: ReadonlySet<string>, route?: Pick<Extract<Route, { to: "worker" }>, "worker" | "open">) {
    for (const wake of wakes) {
      const verdict = this.verdict(wake, confirmed);
      if (verdict instanceof NotNow) throw new NotNow(verdict.state, verdict.note, [wake.id]);
      // Held now (a pause): routed again on a later pass.
      if (verdict !== "send") throw new NotNow("pending", null);
    }
    if (!route) return;
    const { worker } = route;
    const current = this.deps.store.worker(worker.projectId, worker.num);
    const open = current ? this.deps.store.openAssignment(worker.projectId, worker.num) : null;
    if (!current || unavailable(this.deps.store, current) || current.threadId !== worker.threadId || (open?.ref ?? null) !== route.open)
      throw new NotNow("pending", null);
  }

  /** The wakes that still apply; each that doesn't is marked on its own (or left pending to route again). */
  private eligible(wakes: readonly WakeRow[], confirmed: ReadonlySet<string>): WakeRow[] {
    return wakes.filter((wake) => {
      try {
        this.still([wake], confirmed);
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
        this.deps.warn(`PR watch could not wake about ${wakes.map((w) => `${w.pr.repo}#${w.pr.number}`).join(", ")}: ${errorMessage(error)}`);
        if (!isDefiniteRejection(error)) this.deps.ledger.mark(ids, "failed", errorMessage(error).slice(0, 300));
        else {
          const failed = this.deps.ledger.refused(ids, `BB refused the send: ${errorMessage(error)}`.slice(0, 300));
          if (failed.length) await this.gaveUp(wakes.filter((w) => failed.includes(w.id)), errorMessage(error));
        }
      }
    } finally {
      this.deps.changed(wakes[0]!.projectId);
    }
  }

  /** Wakes BB refused WAKE_REFUSALS times are not sent again: their coordinator hears of them once, with BB's last answer. */
  private async gaveUp(wakes: readonly WakeRow[], error: string) {
    const last = error.replace(/\s+/gu, " ").slice(0, 300);
    await this.noteCoordinator(wakes, (prs, watchers) => `gave up on ${prs} (${watchers}): BB refused the send ${WAKE_REFUSALS} times, last: ${last}.`, (prs, watchers) => ({
      lead: `BB refused the plugin's wake about ${prs} (${watchers}) ${WAKE_REFUSALS} times, so the plugin stopped trying: its watcher has not heard of it. BB's last answer: ${last}`,
      next: "If it needs work, give it to a worker; or leave it.",
    }));
  }

  /**
   * A note about wakes already settled (given up, or sent to a worker a Stop reached; one
   * watcher's, so one Adventure's) to their Adventure's coordinator: one try, outside the ledger,
   * so a failed note never sends a wake again. The note follows a wait on BB, so each wake is
   * judged again first; one that no longer applies (unwatched, ended, pushed since, held) is only
   * logged.
   */
  private async noteCoordinator(wakes: readonly WakeRow[], summary: (prs: string, watchers: string) => string, note: (prs: string, watchers: string) => { lead: string; next: string }) {
    const { store, sdk } = this.deps;
    const prsOf = (group: readonly WakeRow[]) => group.map((w) => `${w.pr.repo}#${w.pr.number}`).join(", ");
    const watchersOf = (group: readonly WakeRow[]) => [...new Set(group.map((w) => w.worker ?? "the coordinator"))].join(", ");
    const live = wakes.filter((wake) => {
      const verdict = this.verdict(wake, new Set([wake.url]));
      if (verdict === "send") return true;
      store.log(wake.projectId, "pr-watch", `PR watch ${summary(prsOf([wake]), watchersOf([wake]))} Nobody is told: ${verdict instanceof NotNow ? (verdict.note ?? verdict.state) : "its Adventure holds its wakes"}.`, { url: wake.url });
      return false;
    });
    if (!live.length) return;
    const project = store.project(live[0]!.projectId)!;
    const [prs, watchers] = [prsOf(live), watchersOf(live)];
    store.log(project.id, "pr-watch", `PR watch ${summary(prs, watchers)} The coordinator is told.`, { urls: live.map((w) => w.url) });
    const { lead, next } = note(prs, watchers);
    try {
      if (!project.coordinatorThreadId) throw new Error("the Adventure has no coordinator thread");
      await sdk.threads.send({
        threadId: project.coordinatorThreadId, mode: "queue-if-active",
        input: textInput(`Adventures · ${project.name} · PR watch\n\n${lead}\n\n${wakeBody(live)}\n\n${NOT_A_MERGE} ${next}`),
      });
    } catch (cause) {
      this.deps.warn(`PR watch could not tell ${project.name}'s coordinator about ${prs}: ${errorMessage(cause)}`);
    }
  }

  /**
   * One worker's wakes, as more work or a message. A route to the coordinator instead when giving
   * the work failed; a note to it as well when a Stop landed with the message.
   */
  private async toWorker(project: ProjectRecord, route: Extract<Route, { to: "worker" }>, routed: WakeRow[], confirmed: ReadonlySet<string>): Promise<{ wakes: WakeRow[]; route: Extract<Route, { to: "coordinator" }> } | null> {
    const { store, sdk } = this.deps;
    const { worker, open } = route;
    // Routing waited on BB: the message names only the wakes that still apply.
    const wakes = this.eligible(routed, confirmed);
    if (!wakes.length) return null;
    const body = wakeBody(wakes);
    const prs = wakes.map((w) => `${w.pr.repo}#${w.pr.number}`).join(", ");
    const kinds = [...new Set(wakes.flatMap((w) => w.changes.map((c) => c.kind)))].join(", ");
    const yours = `GitHub news on the PR${wakes.length === 1 ? "" : "s"} you watch`;
    let failure = null as string | null;
    /** Why a worker a Stop reached may not act on the message it was sent; `uncertain`: whether it has it is unknown. */
    let stopped = null as { why: string; resumable: boolean; uncertain?: boolean } | null;
    await this.sending(wakes, async () => {
      if (route.how === "message") {
        this.still(wakes, confirmed, route);
        const answer = (await sdk.threads.send({
          threadId: worker.threadId!, mode: "steer-if-active",
          input: textInput(`Adventures · ${project.name} · PR watch\n\n${yours} (from the plugin, not your lead):\n\n${body}\n\n${NOT_A_MERGE} Handle what needs it (a fix, a reply, or nothing) within ${open ? `your ${open}` : "your current work"}; its report covers it.`),
        })) as { delivery?: string; queuedMessage?: { id?: string } } | undefined;
        let how = `${route.busy ? "while it works" : `during ${open}`}${answer?.delivery === "queued" ? ", queued by BB" : ""}`;
        // A Stop that landed as the message went out.
        const after = (await sdk.threads.get({ threadId: worker.threadId! }).catch(() => null)) as ThreadDto | null;
        const current = store.worker(worker.projectId, worker.num);
        const why = after?.status === "stopping" ? `${worker.ref}'s thread was stopping` : current ? unavailable(store, current) : `${worker.ref} is gone`;
        const queued = answer?.delivery === "queued" ? answer.queuedMessage?.id : undefined;
        if (why && queued) {
          // BB queued it behind the stop and would start a turn with it once the thread is idle.
          // Taken back, nothing was delivered: routed afresh next pass. A row BB refuses to delete
          // is gone, sent to the worker as a turn of its own: sent. Any other answer may have
          // deleted it or not: uncertain, never sent again, and the coordinator checks.
          const taken = await sdk.threads.queuedMessages.delete({ threadId: worker.threadId!, queuedMessageId: queued })
            .then(() => "taken" as const, (error: unknown) => (isDefiniteRejection(error) ? "gone" as const : errorMessage(error).slice(0, 200)));
          if (taken === "taken") throw new NotNow("pending", null);
          if (taken !== "gone") {
            stopped = { why: `the plugin's message to ${worker.ref}, queued behind a Stop, may or may not have been taken back (${taken})`, resumable: false, uncertain: true };
            throw new NotNow("uncertain", `queued behind a Stop; taking it back failed: ${taken}`);
          }
          how += " behind a Stop";
        } else if (why) {
          // The steer joined a turn being torn down, so the worker may never act on it. BB took it:
          // the wake is sent, never again, and the coordinator gets a note too.
          stopped = { why: `${why} as the plugin's message reached it, so it may not act on it`, resumable: after?.status === "stopping" };
          how += "; a Stop landed with it";
        }
        store.log(project.id, "pr-watch", `PR watch: woke ${worker.ref} about ${prs} (${kinds}) ${how}.`, { urls: wakes.map((w) => w.url) });
        return `${worker.ref}: message (${how})`;
      }
      this.still(wakes, confirmed, route);
      let assignment: string;
      try {
        assignment = await this.deps.giveWork(project.id, worker.ref, `PR watch (sent by the Adventures plugin, not your lead): ${yours}.\n\n${body}\n\n${NOT_A_MERGE} Handle what needs it (a fix, a reply to a comment, or nothing), keep the PR's stage and notes current, then report.`,
          () => this.still(wakes, confirmed, route));
      } catch (error) {
        if (error instanceof NotNow) throw error;
        failure = errorMessage(error).slice(0, 200);
        // Back to pending: the coordinator's message carries them now.
        throw new NotNow("pending", null);
      }
      store.log(project.id, "pr-watch", `PR watch: woke ${worker.ref} about ${prs} (${kinds}) with ${assignment}.`, { urls: wakes.map((w) => w.url) });
      return `${worker.ref}: ${assignment}`;
    });
    if (stopped) {
      const { why, resumable, uncertain } = stopped;
      const check = `Check ${worker.ref}'s thread and its queue for it: if it never arrived, give the work to a worker; or leave it.`;
      await this.noteCoordinator(wakes, (prs) => `woke ${worker.ref} about ${prs}, but ${why}.`, () =>
        ({ lead: `${why[0]!.toUpperCase()}${why.slice(1)}:`, next: uncertain ? check : nextStep(worker, resumable) }));
    }
    return failure ? { wakes, route: { to: "coordinator", why: `the plugin could not give ${worker.ref} the work (${failure})`, resumable: true, worker } } : null;
  }

  /** One message to an Adventure's coordinator for every group of wakes routed to it, each with why (none for its own watches). */
  private async toCoordinator(project: ProjectRecord, sections: { wakes: WakeRow[]; route: Extract<Route, { to: "coordinator" }> }[], confirmed: ReadonlySet<string>) {
    const { store, sdk } = this.deps;
    // Each section as it stands now: a wake that no longer applies leaves its message.
    const live: typeof sections = [];
    for (const section of sections) {
      const wakes = this.eligible(section.wakes, confirmed);
      if (wakes.length) live.push({ wakes, route: section.route });
    }
    if (!live.length) return;
    const all = live.flatMap((s) => s.wakes);
    const text = live.map(({ wakes, route }) => route.why === null
      ? `PRs you watch:\n\n${wakeBody(wakes)}`
      : `${route.why[0]!.toUpperCase()}${route.why.slice(1)}:\n\n${wakeBody(wakes)}\n\n${nextStep(route.worker, route.resumable)}`).join("\n\n---\n\n");
    const about = live.every((s) => s.route.why === null) ? "PRs you watch" : "watched PRs whose watchers can't take it themselves, so it comes to you";
    await this.sending(all, async () => {
      if (!project.coordinatorThreadId) throw new Error("the Adventure has no coordinator thread");
      await sdk.threads.send({
        threadId: project.coordinatorThreadId, mode: "queue-if-active",
        input: textInput(`Adventures · ${project.name} · PR watch\n\nGitHub news on ${about}. ${NOT_A_MERGE}\n\n${text}`),
      });
      for (const { wakes, route } of live)
        store.log(project.id, "pr-watch", `PR watch: ${wakes.map((w) => `${w.pr.repo}#${w.pr.number}`).join(", ")} (${[...new Set(wakes.flatMap((w) => w.changes.map((c) => c.kind)))].join(", ")}) went to the coordinator${route.why === null ? ", which watches it" : `: ${route.why}`}.`, { urls: wakes.map((w) => w.url) });
      return `coordinator: ${live.map((s) => s.route.why ?? "its own watch").join("; ")}`.slice(0, 500);
    });
  }
}

/** The PR detail view's watch: who watches it, and its latest wakes. */
export interface PrWatchView {
  url: string;
  /** Who watches it (a W#, "the coordinator", or a thread no longer either) and in which Adventure; null when nobody does. */
  watcher: { label: string; projectId: string; adventure: string } | null;
  /** Comment-only wakes in a row; at COMMENT_WAKE_CAP comments stop waking. */
  commentWakes: number;
  commentCap: number;
  /** Merged or closed while watched: the watch ended. */
  ended: "MERGED" | "CLOSED" | null;
  wakes: { at: number; head: string; changes: string[]; state: WakeRow["state"]; routed: string | null }[];
}

export function readPrWatch(store: Pick<Store, "project">, ledger: WatchLedger, url: string): PrWatchView {
  const row = ledger.row(url);
  const watching = row?.watcher ? row : null;
  return {
    url,
    watcher: watching
      ? { label: watcherLabel(store, ledger, watching.projectId, watching.watcher!), projectId: watching.projectId, adventure: store.project(watching.projectId)?.name ?? watching.projectId }
      : null,
    commentWakes: watching?.state?.commentWakes ?? 0,
    commentCap: COMMENT_WAKE_CAP,
    ended: watching?.state?.ended ?? null,
    wakes: ledger.wakes(url, 5).map((w) => ({ at: w.createdAt, head: w.head, changes: w.changes.map((c) => changeLine(c, w.head).split("\n")[0]!), state: w.state, routed: w.routed })),
  };
}
