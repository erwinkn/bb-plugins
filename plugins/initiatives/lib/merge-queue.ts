// The Initiative's merge queue: open pull requests authored by the user in
// the GitHub repositories of its member projects. Pure parsing, ordering and
// grouping, shared by the server and (as types) the dashboard.
import { PR_STAGES, canonicalPrUrl, type PrRecord, type PrStage, type PrState } from "./pr-stages";
import { NO_NOTES, type PrNotesSummary } from "./pr-notes";

/** GitHub health groups: they color a row and explain it, never group the queue. */
export type QueueGroup = "ready" | "waiting" | "fix" | "draft";

/** A queue stage with its label, as the dashboard lists them. */
export interface StageDefinition {
  id: string;
  label: string;
}

export type ReviewState = "approved" | "changes_requested" | "review_required" | "none";
export type ChecksState = "pass" | "fail" | "pending" | "none";
export type MergeableState = "mergeable" | "conflicting" | "unknown";

/** A queued PR, with where it stands as the coordinator recorded it (PrState: waiting on, changes…). */
export interface QueuedPullRequest extends PrState {
  /** `owner/repo`. */
  repo: string;
  number: number;
  title: string;
  url: string;
  draft: boolean;
  review: ReviewState;
  checks: { state: ChecksState; passed: number; failed: number; pending: number; total: number };
  mergeable: MergeableState;
  /** GitHub's mergeStateStatus, lower case: clean, behind, blocked, dirty, unstable, unknown… */
  mergeState: string;
  head: string;
  base: string;
  createdAt: number;
  updatedAt: number;
  /** GitHub health: colors the row; `reasons` explain it. */
  group: QueueGroup;
  /** The workflow stage the queue groups by. */
  stage: PrStage;
  /** "coordinator" when recorded with initiative_pr; "github" when guessed. */
  stageSource: "coordinator" | "github";
  /** The coordinator's note and when it set the stage; null when guessed. */
  stageNote: string | null;
  stageSetAt: number | null;
  /** Why it sits in its group, shortest first: ["2 checks failing", "conflicts"]. */
  reasons: string[];
  /** Who works on it: the coordinator's record, else the latest assignment naming the PR, else the worker whose BB worktree branch opened it. */
  worker: PrWorker | null;
  /** The coordinator's free-form category ("Security", "CI"); null when it set none. */
  category: string | null;
  /** Lines added and removed, files and commits; null until the details query answers. */
  size: PrSize | null;
  /** Each reviewer's latest review, then those asked who haven't reviewed yet. */
  reviewers: Reviewer[];
  /**
   * W520: why its latest details read failed. Its size stays from an earlier read, if any, and its
   * reviewers are withheld until a read succeeds. Absent when the details are current.
   */
  detailsError?: string;
  /** Its place in a stack of PRs (see linkStacks); null when nothing stacks on it or under it. */
  stack: PrStack | null;
  /** Ready for the user, and so is every PR it is stacked on: it can be reviewed now. */
  available: boolean;
  /** Its notes log (D442): how many, the last few and the open questions. */
  notes: PrNotesSummary;
  /** T156: the workers and assignments of every assignment naming it; search matches them. */
  links: PrLinks;
  /**
   * R2: no Initiative owns it yet, so every Initiative listing its repository shows it, apart,
   * under Unassigned. The others are this Initiative's: another Initiative's PRs aren't listed.
   */
  unassigned: boolean;
}

/** R2: an open Initiative a PR can move to, and its repositories, lower case; null while being looked up. */
export interface MoveTarget {
  id: string;
  name: string;
  repos: string[] | null;
}

/** Refs linked to a PR, each once: W3, A301. */
export interface PrLinks {
  workers: string[];
  assignments: string[];
}
export const NO_LINKS: PrLinks = { workers: [], assignments: [] };

export interface PrSize {
  additions: number;
  deletions: number;
  files: number;
  commits: number;
}

export interface Reviewer {
  login: string;
  state: "approved" | "changes_requested" | "commented" | "dismissed" | "requested";
}

export interface PrWorker {
  ref: string;
  threadId: string | null;
  assignment: string | null;
  /** The assignment's role (work, review…), when known. */
  role: string | null;
  source: "coordinator" | "assignment" | "branch";
}

/**
 * A PR's place in its stack. A PR whose base branch is another open PR's head
 * branch, in the same repository, is stacked on it. Stacks are trees: two PRs
 * may sit on the same one.
 */
export interface PrStack {
  /** The number of the stack's bottom PR, whose base is no open PR's head. */
  root: number;
  /** The PR this one sits on; null for the root. */
  on: number | null;
  /** 1 for the root, 2 for a PR on it… */
  level: number;
  /** The stack's height: its deepest level. */
  levels: number;
  /** When the root opened: review order keeps a stack together even when its root isn't listed (R2: another Initiative's). */
  rootCreatedAt: number;
  /** Every PR in the stack. */
  size: number;
}

export interface MergeQueueRepo {
  repo: string;
  /** Last successful fetch; null before the first one. */
  fetchedAt: number | null;
  /** The latest attempt's failure; null once a fetch succeeds. */
  error: string | null;
  /** A fetch is running now; reads never wait for it, and its end is announced (merge-queue-changed). */
  fetching: boolean;
  /**
   * The sizes and reviewers (the details query) fail apart from the list, PR by PR (W520): when
   * a details read of this repository last succeeded, and, while some listed PRs' latest read
   * failed, the latest error and how many PRs it holds back. Each such PR says so itself
   * (`detailsError`).
   */
  detailsFetchedAt: number | null;
  detailsError: string | null;
  /**
   * Set when the last list read stopped short of every open PR GitHub counts (PR_LIMIT): how many it
   * read of how many, over the repositories its search covered (W516: `search`, one search spans
   * several; absent from older servers).
   */
  capped?: { listed: number; total: number; search?: string[] };
}

export interface MergeQueue {
  projectId: string;
  /** The GitHub account whose PRs are listed; null until `gh` answers. */
  login: string | null;
  repos: MergeQueueRepo[];
  /** Member projects without a GitHub `origin`, by name. */
  skipped: { project: string; reason: string }[];
  /** Every stage a PR may sit in, in queue order; groups follow it. */
  stages: StageDefinition[];
  /** Sorted: by stage, then oldest first within a stage. This Initiative's PRs and the unassigned ones (R2). */
  pullRequests: QueuedPullRequest[];
  /**
   * R2: other Initiatives' PRs that listed ones are stacked on, never listed themselves: they
   * name what a listed PR waits on. Each at the stage its owner recorded.
   */
  beneath?: QueuedPullRequest[];
  /** R2: the dashboard's "Move to Initiative" choices; agent reads leave it out. */
  initiatives?: MoveTarget[];
}

/** `owner/repo` of a GitHub remote URL (https, ssh or scp-like), else null. */
export function githubRepo(remoteUrl: string | null | undefined): string | null {
  if (!remoteUrl) return null;
  const match =
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(
      remoteUrl.trim(),
    );
  return match ? `${match[1]}/${match[2]}` : null;
}

/**
 * The open PRs a search finds, one page of LIST_PAGE, with the account it searched as. The keys
 * are `gh pr list --json`'s, but the checks come as counts by state, every check of the last
 * commit: `gh pr list --json statusCheckRollup` reads the first 100 one by one, each with its
 * workflow's name. W490, 209 PRs in 3 pages: 11–12 s as counts, 11–13 s check by check, 6–7 s
 * without mergeability (which the queue needs). Details beside it on the same pages fail with a
 * 502 or 504 (GH_DETAILS_QUERY). `id` is what the details query asks for.
 *
 * W516: one search covers several repositories (prSearch): a page costs one GraphQL point
 * whatever it holds, and most repositories have a PR or none. The list is read whole every
 * time: half the PRs' checks finish after their `updatedAt` (live, 2026-10-19), so paging only
 * what changed since the last read would miss them.
 */
export const LIST_PAGE = 100;
export const GH_LIST_QUERY = `query($q: String!, $endCursor: String) {
  viewer { login }
  search(query: $q, type: ISSUE, first: ${LIST_PAGE}, after: $endCursor) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      id number title url isDraft reviewDecision mergeable mergeStateStatus headRefName baseRefName createdAt updatedAt
      statusCheckRollup: commits(last: 1) { nodes { commit { statusCheckRollup { contexts {
        checkRunCountsByState { state count } statusContextCountsByState { state count }
      } } } } }
    } }
  }
}`;

const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);

/**
 * The checks of the PR's last commit, from the list query's counts: check runs by CheckRunState
 * (their conclusion once completed), status contexts by StatusState. Any other state is pending.
 */
export function summarizeChecks(rollup: unknown): QueuedPullRequest["checks"] {
  const counts = { passed: 0, failed: 0, pending: 0 };
  const contexts = (rollup as { nodes?: { commit?: { statusCheckRollup?: { contexts?: Record<string, unknown> } | null } }[] } | null)
    ?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
  for (const byState of [contexts?.checkRunCountsByState, contexts?.statusContextCountsByState]) {
    for (const entry of Array.isArray(byState) ? (byState as { state?: unknown; count?: unknown }[]) : []) {
      const n = typeof entry?.count === "number" && Number.isInteger(entry.count) && entry.count > 0 ? entry.count : 0;
      const state = typeof entry?.state === "string" ? entry.state.toUpperCase() : "";
      counts[PASSED.has(state) ? "passed" : FAILED.has(state) ? "failed" : "pending"] += n;
    }
  }
  const total = counts.passed + counts.failed + counts.pending;
  const state: ChecksState = counts.failed ? "fail" : counts.pending ? "pending" : total ? "pass" : "none";
  return { state, ...counts, total };
}

function review(decision: unknown): ReviewState {
  switch (decision) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "REVIEW_REQUIRED":
      return "review_required";
    default:
      // Empty: the base branch requires no review.
      return "none";
  }
}

function mergeable(value: unknown): MergeableState {
  return value === "MERGEABLE" ? "mergeable" : value === "CONFLICTING" ? "conflicting" : "unknown";
}

const time = (value: unknown) => {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : 0;
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Group and reasons from the PR's draft flag, checks, review and mergeability. */
export function classify(pr: Pick<QueuedPullRequest, "draft" | "checks" | "review" | "mergeable" | "mergeState">): {
  group: QueueGroup;
  reasons: string[];
} {
  const fix: string[] = [];
  if (pr.checks.state === "fail") fix.push(`${plural(pr.checks.failed, "check")} failing`);
  if (pr.mergeable === "conflicting") fix.push("conflicts");
  if (pr.review === "changes_requested") fix.push("changes requested");
  const waiting: string[] = [];
  if (pr.checks.state === "pending") waiting.push(`${plural(pr.checks.pending, "check")} running`);
  if (pr.review === "review_required") waiting.push("review required");
  if (pr.mergeable === "unknown") waiting.push("mergeability unknown");
  if (pr.mergeState === "behind") waiting.push("behind base");
  else if (pr.mergeState === "blocked" && !waiting.length) waiting.push("blocked by branch rules");
  if (pr.draft) return { group: "draft", reasons: [...fix, ...waiting] };
  if (fix.length) return { group: "fix", reasons: [...fix, ...waiting] };
  if (waiting.length) return { group: "waiting", reasons: waiting };
  return { group: "ready", reasons: [] };
}

/** BB worktree branches end with their thread id: `bb/w198-…-thr_5t6t6jjct3`. */
export function branchThreadId(branch: string): string | null {
  return /(?:^|[-/])(thr_[a-z0-9]+)$/i.exec(branch)?.[1] ?? null;
}

/** One page of a search: its nodes, how many results GitHub counts in all, the next page's cursor, and who searched. */
export interface SearchPage {
  nodes: unknown[];
  total: number;
  next: string | null;
  login: string | null;
}

/** One page of GH_LIST_QUERY (its `data`); an answer without search results throws. */
export function parseSearchPage(data: unknown, what: string): SearchPage {
  const d = data as { viewer?: { login?: unknown }; search?: { nodes?: unknown; issueCount?: unknown; pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } } } | null;
  const page = d?.search;
  if (!page || !Array.isArray(page.nodes)) throw new Error(`${what} returned no search results`);
  const info = page.pageInfo;
  const login = d?.viewer?.login;
  return {
    nodes: page.nodes,
    total: typeof page.issueCount === "number" ? page.issueCount : page.nodes.length,
    next: info?.hasNextPage === true && typeof info.endCursor === "string" ? info.endCursor : null,
    login: typeof login === "string" && /^[\w-]+$/.test(login) ? login : null,
  };
}

/** One repository's open PRs from the list query's nodes; malformed entries drop out one by one. */
export function parsePullRequests(repo: string, nodes: readonly unknown[]): QueuedPullRequest[] {
  const pullRequests: QueuedPullRequest[] = [];
  for (const entry of nodes) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.number !== "number" || !Number.isInteger(e.number) || e.number <= 0) continue;
    if (typeof e.url !== "string" || !/^https:\/\//.test(e.url)) continue;
    const head = typeof e.headRefName === "string" ? e.headRefName : "";
    const base = {
      draft: e.isDraft === true,
      checks: summarizeChecks(e.statusCheckRollup),
      review: review(e.reviewDecision),
      mergeable: mergeable(e.mergeable),
      mergeState: typeof e.mergeStateStatus === "string" ? e.mergeStateStatus.toLowerCase() : "unknown",
    };
    pullRequests.push({
      repo,
      number: e.number,
      title: typeof e.title === "string" && e.title.trim() ? e.title : `${repo}#${e.number}`,
      url: e.url,
      ...base,
      head,
      base: typeof e.baseRefName === "string" ? e.baseRefName : "",
      createdAt: time(e.createdAt),
      updatedAt: time(e.updatedAt),
      ...classify(base),
      stage: "ready-for-review",
      stageSource: "github",
      stageNote: null,
      stageSetAt: null,
      worker: null,
      size: null,
      reviewers: [],
      category: null,
      waitingOn: null,
      changes: [],
      decision: null,
      stack: null,
      available: false,
      notes: NO_NOTES,
      links: NO_LINKS,
      unassigned: false,
    });
  }
  return pullRequests.map((pr) => ({ ...pr, stage: githubStage(pr) }));
}

/**
 * Diff size and reviewers come from a second, lighter query: GitHub times out
 * (502) when one query asks for additions and deletions beside the checks and
 * mergeability at 100 PRs a page. W516: by node id, for the PRs whose
 * `updatedAt` moved since their details were read (a push or a review moves
 * it), DETAILS_PAGE a request (about 3 s and one point).
 *
 * W520: a request costs one point whether it asks for 1 PR or 50 (live, 2026-10-19). Equisafe's
 * 227 open PRs cost 5 points in batches of 50 and 227 one by one, which also took 27 s against
 * 5–9 s, 4 requests at a time. So a request asks for up to 50 PRs of one repository, and only
 * a failing request is split (MergeQueueCache.loadDetails).
 */
export const DETAILS_PAGE = 50;
export const GH_DETAILS_QUERY = `query($ids: [ID!]!) {
  nodes(ids: $ids) { ... on PullRequest {
    id number additions deletions changedFiles commits { totalCount }
    latestReviews(first: 20) { nodes { author { login } state } }
    reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } ... on Bot { login } ... on Team { name } } } }
  } }
}`;

/** The details query's nodes (its `data`), one per id asked, null for one gone; an answer without them throws. */
export function parseDetailsNodes(data: unknown, what: string): unknown[] {
  const nodes = (data as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes)) throw new Error(`${what} returned no nodes`);
  return nodes;
}

/**
 * The search the list runs: the user's open PRs in these repositories. Repository qualifiers
 * are ORed and don't count toward search's 256-character limit (15 repositories, 353
 * characters, read fine on 2026-10-19).
 */
export const prSearch = (repos: readonly string[]) => `is:pr is:open author:@me ${repos.map((repo) => `repo:${repo}`).join(" ")}`;

/** The repository of a PR URL, lower case, as the cache keys it. */
export const prRepoKey = (url: string): string | null => /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/i.exec(url)?.[1]?.toLowerCase() ?? null;

/**
 * v9 (§7): the state of each PR URL, `p0` to `p<n-1>`, in one request (W516: one point for 50,
 * where each `gh pr view` was a spawn and a point). A URL GitHub can't resolve answers null.
 */
export function prLookupQuery(count: number): string {
  const indexes = Array.from({ length: count }, (_, i) => i);
  return `query(${indexes.map((i) => `$u${i}: URI!`).join(", ")}) {\n${indexes
    .map((i) => `  p${i}: resource(url: $u${i}) { ... on PullRequest { state mergedAt closedAt } }`)
    .join("\n")}\n}`;
}

/** One PR's looked-up state from its prLookupQuery node, or why there is none. */
export function parsePrLookup(node: unknown): { state: "OPEN" | "MERGED" | "CLOSED"; mergedAt: number | null; closedAt: number | null } | { error: string } {
  if (node === null || node === undefined) return { error: "not found on GitHub" };
  const n = node as { state?: unknown; mergedAt?: unknown; closedAt?: unknown };
  const state = n.state === "MERGED" || n.state === "CLOSED" || n.state === "OPEN" ? n.state : null;
  if (!state) return { error: n.state === undefined ? "not a pull request" : `unexpected state ${String(n.state)}` };
  const at = (value: unknown) => (typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null);
  return { state, mergedAt: at(n.mergedAt), closedAt: at(n.closedAt) };
}

const REVIEW_STATES: Record<string, Reviewer["state"]> = {
  APPROVED: "approved", CHANGES_REQUESTED: "changes_requested", COMMENTED: "commented", DISMISSED: "dismissed",
};

export type PrDetails = Map<number, { size: PrSize; reviewers: Reviewer[] }>;

/** One PR's number, size and reviewers from a details node; null for a malformed one. */
export function parseDetail(node: unknown): { number: number; size: PrSize; reviewers: Reviewer[] } | null {
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
  const list = (value: unknown): unknown[] => {
    const nodes = (value as { nodes?: unknown } | null | undefined)?.nodes;
    return Array.isArray(nodes) ? nodes : [];
  };
  const e = node as Record<string, any> | null;
  if (!e || typeof e !== "object" || typeof e.number !== "number") return null;
  const reviewers: Reviewer[] = [];
  for (const review of list(e.latestReviews) as Record<string, any>[]) {
    const login = review?.author?.login;
    const state = typeof review?.state === "string" && Object.hasOwn(REVIEW_STATES, review.state) ? REVIEW_STATES[review.state] : undefined;
    if (typeof login === "string" && state && !reviewers.some((r) => r.login === login)) reviewers.push({ login, state });
  }
  for (const request of list(e.reviewRequests) as Record<string, any>[]) {
    const login = request?.requestedReviewer?.login ?? request?.requestedReviewer?.name;
    if (typeof login === "string" && !reviewers.some((r) => r.login === login)) reviewers.push({ login, state: "requested" });
  }
  return {
    number: e.number,
    size: { additions: count(e.additions), deletions: count(e.deletions), files: count(e.changedFiles), commits: count(e.commits?.totalCount) },
    reviewers,
  };
}

/** Each PR's size and reviewers by number, from details nodes of one repository; a malformed PR drops out alone. */
export function parseDetails(nodes: readonly unknown[]): PrDetails {
  const details: PrDetails = new Map();
  for (const node of nodes) {
    const d = parseDetail(node);
    if (d) details.set(d.number, { size: d.size, reviewers: d.reviewers });
  }
  return details;
}

/**
 * Each PR with its size and reviewers, when a details read had them. W520: one whose latest read
 * failed (`error`) keeps its size and has its reviewers withheld, as they may be stale.
 */
export function attachDetails(
  pullRequests: readonly QueuedPullRequest[],
  details: ReadonlyMap<number, { size: PrSize | null; reviewers: Reviewer[]; error: string | null }>,
): QueuedPullRequest[] {
  return pullRequests.map((pr) => {
    const d = details.get(pr.number);
    if (!d) return pr;
    return d.error === null ? { ...pr, size: d.size, reviewers: d.reviewers } : { ...pr, size: d.size, reviewers: [], detailsError: d.error };
  });
}

/** Each PR's notes summary (D442), by canonical URL. */
export function attachNotes(
  pullRequests: readonly QueuedPullRequest[],
  notes: ReadonlyMap<string, PrNotesSummary>,
): QueuedPullRequest[] {
  return pullRequests.map((pr) => {
    const summary = notes.get(canonicalPrUrl(pr.url) ?? pr.url.toLowerCase());
    return summary ? { ...pr, notes: summary } : pr;
  });
}

/**
 * T156: each PR's linked refs, by canonical URL: the assignments naming it,
 * and the one the coordinator recorded, with or without its worker.
 */
export function attachLinks(
  pullRequests: readonly QueuedPullRequest[],
  assigned: ReadonlyMap<string, { links: PrLinks }>,
  records: ReadonlyMap<string, Pick<PrRecord, "assignment">>,
): QueuedPullRequest[] {
  return pullRequests.map((pr) => {
    const key = canonicalPrUrl(pr.url) ?? pr.url.toLowerCase();
    const links = assigned.get(key)?.links ?? NO_LINKS;
    const recorded = records.get(key)?.assignment;
    return { ...pr, links: recorded && !links.assignments.includes(recorded) ? { ...links, assignments: [...links.assignments, recorded] } : links };
  });
}

/**
 * The stage guessed from GitHub when the coordinator has set none: a draft is
 * being worked on; approved, green and mergeable is ready for the user;
 * anything else is ready for review.
 */
export function githubStage(pr: Pick<QueuedPullRequest, "draft" | "review" | "checks" | "mergeable">): PrStage {
  if (pr.draft) return "working";
  const green = pr.checks.state === "pass" || pr.checks.state === "none";
  return pr.review === "approved" && green && pr.mergeable === "mergeable" ? "ready-for-erwin" : "ready-for-review";
}

/**
 * Each PR's stage, the coordinator's when recorded for its URL, else the
 * GitHub guess; and the rest of its record: category, where it stands, and
 * the worker the coordinator named.
 */
export function assignStages(
  pullRequests: readonly QueuedPullRequest[],
  records: ReadonlyMap<string, PrRecord>,
): QueuedPullRequest[] {
  return pullRequests.map((pr) => {
    const r = records.get(canonicalPrUrl(pr.url) ?? pr.url.toLowerCase());
    const stage = r?.stage
      ? { stage: r.stage, stageSource: "coordinator" as const, stageNote: r.note, stageSetAt: r.setAt }
      : { stage: githubStage(pr), stageSource: "github" as const, stageNote: null, stageSetAt: null };
    if (!r) return { ...pr, ...stage };
    const worker = r.worker
      ? { ref: r.worker, threadId: null, assignment: r.assignment, role: null, source: "coordinator" as const }
      : pr.worker;
    const { category, waitingOn, changes, decision } = r;
    return { ...pr, ...stage, category, waitingOn, changes, decision, worker };
  });
}

/**
 * Fill in who works on each PR: the coordinator's worker gets its thread;
 * without one, the latest assignment naming the PR (by canonical URL), else
 * the worker whose BB worktree branch opened it.
 */
export function attachWorkers(
  pullRequests: readonly QueuedPullRequest[],
  workers: ReadonlyMap<string, string>,
  assigned: ReadonlyMap<string, { worker: string; assignment: string; role: string }> = new Map(),
): QueuedPullRequest[] {
  const threads = new Map([...workers].map(([threadId, ref]) => [ref, threadId]));
  return pullRequests.map((pr): QueuedPullRequest => {
    if (pr.worker?.source === "coordinator") return { ...pr, worker: { ...pr.worker, threadId: threads.get(pr.worker.ref) ?? null } };
    const work = assigned.get(canonicalPrUrl(pr.url) ?? pr.url.toLowerCase());
    if (work) return { ...pr, worker: { ref: work.worker, threadId: threads.get(work.worker) ?? null, assignment: work.assignment, role: work.role, source: "assignment" } };
    const threadId = branchThreadId(pr.head);
    const ref = threadId ? workers.get(threadId) : undefined;
    return { ...pr, worker: ref && threadId ? { ref, threadId, assignment: null, role: null, source: "branch" } : null };
  });
}

/** Merge-queue order: by stage, then oldest first, then repo and number. */
export function orderQueue(
  pullRequests: readonly QueuedPullRequest[],
  stages: readonly StageDefinition[] = PR_STAGES,
): QueuedPullRequest[] {
  const index = new Map(stages.map((stage, i) => [stage.id, i]));
  const rank = (pr: QueuedPullRequest) => index.get(pr.stage) ?? stages.length;
  return [...pullRequests].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.createdAt - b.createdAt ||
      a.repo.localeCompare(b.repo) ||
      a.number - b.number,
  );
}
