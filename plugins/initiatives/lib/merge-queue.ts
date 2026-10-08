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
  /** Its place in a stack of PRs (see linkStacks); null when nothing stacks on it or under it. */
  stack: PrStack | null;
  /** Ready for the user, and so is every PR it is stacked on: it can be reviewed now. */
  available: boolean;
  /** Its notes log (D442): how many, the last few and the open questions. */
  notes: PrNotesSummary;
}

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
   * The sizes and reviewers (the details query) fail apart from the list: when
   * they last loaded, and why the latest attempt failed. Sizes from an older
   * load stay shown; reviewer states are withheld until the details load again.
   */
  detailsFetchedAt: number | null;
  detailsError: string | null;
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
  /** Sorted: by stage, then oldest first within a stage. */
  pullRequests: QueuedPullRequest[];
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

/** The fields requested from `gh pr list --json`. */
export const GH_PR_FIELDS = [
  "number",
  "title",
  "url",
  "isDraft",
  "reviewDecision",
  "mergeable",
  "mergeStateStatus",
  "headRefName",
  "baseRefName",
  "createdAt",
  "updatedAt",
  "statusCheckRollup",
].join(",");

const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);

type CheckVerdict = "passed" | "failed" | "pending";

/** One `statusCheckRollup` entry: a CheckRun (status + conclusion) or a StatusContext (state). */
function checkVerdict(entry: Record<string, unknown>): CheckVerdict {
  const upper = (value: unknown) => (typeof value === "string" ? value.toUpperCase() : "");
  if (entry.__typename === "StatusContext" || ("state" in entry && !("status" in entry))) {
    const state = upper(entry.state);
    return PASSED.has(state) ? "passed" : FAILED.has(state) ? "failed" : "pending";
  }
  if (upper(entry.status) !== "COMPLETED") return "pending";
  const conclusion = upper(entry.conclusion);
  return PASSED.has(conclusion) ? "passed" : FAILED.has(conclusion) ? "failed" : "pending";
}

export function summarizeChecks(rollup: unknown): QueuedPullRequest["checks"] {
  const counts = { passed: 0, failed: 0, pending: 0 };
  for (const entry of Array.isArray(rollup) ? rollup : []) {
    if (typeof entry !== "object" || entry === null) continue;
    counts[checkVerdict(entry as Record<string, unknown>)]++;
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

/**
 * Parse `gh pr list --json GH_PR_FIELDS` output for one repository. Malformed
 * entries drop out one by one; output that is not a JSON array throws.
 */
export function parsePullRequests(repo: string, raw: string): QueuedPullRequest[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("gh pr list returned something other than a list");
  const pullRequests: QueuedPullRequest[] = [];
  for (const entry of parsed) {
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
      discussionThreadId: null,
      stack: null,
      available: false,
      notes: NO_NOTES,
    });
  }
  return pullRequests.map((pr) => ({ ...pr, stage: githubStage(pr) }));
}

/**
 * Diff size and reviewers come from a second, lighter query: GitHub times out
 * (502) when `gh pr list` asks for additions and deletions beside the checks
 * rollup at 100 PRs a page. One `gh api graphql` per page of 50 (about 3 s
 * each), run beside the list, and never more pages than the list holds.
 */
export const DETAILS_PAGE = 50;
export const GH_DETAILS_QUERY = `query($q: String!, $endCursor: String) {
  search(query: $q, type: ISSUE, first: ${DETAILS_PAGE}, after: $endCursor) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      number additions deletions changedFiles commits { totalCount }
      latestReviews(first: 20) { nodes { author { login } state } }
      reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } ... on Bot { login } ... on Team { name } } } }
    } }
  }
}`;

/** The search the details query runs: the same PRs `gh pr list --author` lists. */
export const detailsSearch = (repo: string, login: string) => `repo:${repo} is:pr is:open author:${login}`;

const REVIEW_STATES: Record<string, Reviewer["state"]> = {
  APPROVED: "approved", CHANGES_REQUESTED: "changes_requested", COMMENTED: "commented", DISMISSED: "dismissed",
};

export type PrDetails = Map<number, { size: PrSize; reviewers: Reviewer[] }>;

/**
 * One page of the details query (`gh api graphql` output): each PR's size and
 * reviewers by number, and the cursor of the next page. A malformed PR drops
 * out alone; a response without search results throws.
 */
export function parseDetailsPage(raw: string): { details: PrDetails; next: string | null } {
  const page = (JSON.parse(raw) as { data?: { search?: { nodes?: unknown; pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } } } } | null)?.data?.search;
  if (!page || !Array.isArray(page.nodes)) throw new Error("the details query returned no search results");
  const details: PrDetails = new Map();
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
  const list = (value: unknown): unknown[] => {
    const nodes = (value as { nodes?: unknown } | null | undefined)?.nodes;
    return Array.isArray(nodes) ? nodes : [];
  };
  for (const node of page.nodes) {
    const e = node as Record<string, any> | null;
    if (!e || typeof e !== "object" || typeof e.number !== "number") continue;
    const reviewers: Reviewer[] = [];
    for (const review of list(e.latestReviews) as Record<string, any>[]) {
      const login = review?.author?.login;
      const state = REVIEW_STATES[review?.state];
      if (typeof login === "string" && state && !reviewers.some((r) => r.login === login)) reviewers.push({ login, state });
    }
    for (const request of list(e.reviewRequests) as Record<string, any>[]) {
      const login = request?.requestedReviewer?.login ?? request?.requestedReviewer?.name;
      if (typeof login === "string" && !reviewers.some((r) => r.login === login)) reviewers.push({ login, state: "requested" });
    }
    details.set(e.number, {
      size: { additions: count(e.additions), deletions: count(e.deletions), files: count(e.changedFiles), commits: count(e.commits?.totalCount) },
      reviewers,
    });
  }
  const info = page.pageInfo;
  return { details, next: info?.hasNextPage === true && typeof info.endCursor === "string" ? info.endCursor : null };
}

/** Each PR with its size and, unless withheld as stale, its reviewers, when the details query had it. */
export function attachDetails(
  pullRequests: readonly QueuedPullRequest[],
  details: ReadonlyMap<number, { size: PrSize; reviewers: Reviewer[] }> | null,
  { reviewers = true }: { reviewers?: boolean } = {},
): QueuedPullRequest[] {
  return pullRequests.map((pr) => {
    const d = details?.get(pr.number);
    return d ? { ...pr, size: d.size, reviewers: reviewers ? d.reviewers : [] } : pr;
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
    const { category, waitingOn, changes, decision, discussionThreadId } = r;
    return { ...pr, ...stage, category, waitingOn, changes, decision, discussionThreadId, worker };
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
