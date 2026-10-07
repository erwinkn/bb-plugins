// The Initiative's merge queue: open pull requests authored by the user in
// the GitHub repositories of its member projects. Pure parsing, ordering and
// grouping, shared by the server and (as types) the dashboard.
import { PR_STAGES, canonicalPrUrl, type PrStage, type PrStageRecord } from "./pr-stages";

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

export interface QueuedPullRequest {
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
  /** The Initiative worker whose BB worktree branch opened it, when known. */
  worker: { ref: string; threadId: string } | null;
}

export interface MergeQueueRepo {
  repo: string;
  /** Last successful fetch; null before the first one. */
  fetchedAt: number | null;
  /** The latest attempt's failure; null once a fetch succeeds. */
  error: string | null;
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
    });
  }
  return pullRequests.map((pr) => ({ ...pr, stage: githubStage(pr) }));
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

/** Each PR's stage: the coordinator's when recorded for its URL, else the GitHub guess. */
export function assignStages(
  pullRequests: readonly QueuedPullRequest[],
  recorded: ReadonlyMap<string, PrStageRecord>,
): QueuedPullRequest[] {
  return pullRequests.map((pr) => {
    const set = recorded.get(canonicalPrUrl(pr.url) ?? pr.url.toLowerCase());
    return set
      ? { ...pr, stage: set.stage, stageSource: "coordinator" as const, stageNote: set.note, stageSetAt: set.setAt }
      : { ...pr, stage: githubStage(pr), stageSource: "github" as const, stageNote: null, stageSetAt: null };
  });
}

/** Label each PR with the worker whose thread's worktree branch it came from. */
export function attachWorkers(
  pullRequests: readonly QueuedPullRequest[],
  workers: ReadonlyMap<string, string>,
): QueuedPullRequest[] {
  return pullRequests.map((pr) => {
    const threadId = branchThreadId(pr.head);
    const ref = threadId ? workers.get(threadId) : undefined;
    return { ...pr, worker: ref && threadId ? { ref, threadId } : null };
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

/** One run per non-empty stage, in stage order. */
export function groupQueue(
  pullRequests: readonly QueuedPullRequest[],
  stages: readonly StageDefinition[] = PR_STAGES,
): { stage: string; label: string; pullRequests: QueuedPullRequest[] }[] {
  return stages
    .map((stage) => ({
      stage: stage.id,
      label: stage.label,
      pullRequests: pullRequests.filter((pr) => pr.stage === stage.id),
    }))
    .filter((entry) => entry.pullRequests.length > 0);
}
