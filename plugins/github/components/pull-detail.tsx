// The pull request overview: title, state, checks, body, reviews, review
// threads with diff hunks, files, comments. Inherited from BB's official
// GitHub plugin; `readOnly` (the thread-panel viewer) hides the comment box
// and the spawn button.
import { useCallback, useEffect, useMemo, useState } from "react";
import { experimental_Diff as Diff, experimental_FileLink as FileLink, UrlLink, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { EXTERNAL_ATTRIBUTE } from "../lib/link-interception";
import { EmptyState } from "./empty-state";
import { GithubBody } from "./github-html";
import {
  Avatar,
  DetailSkeleton,
  LabelChips,
  SidebarHeading,
  ThreadPills,
  errorText,
  relativeTime,
  useLinks,
  useSpawn,
  type Contract,
  type PullCheck,
  type PullDetail,
  type PullFile,
  type ReviewThread,
} from "./shared";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

/** Anchors carrying this attribute are left alone by the link interception. */
const externalLink = { [EXTERNAL_ATTRIBUTE]: "" } as const;

function pullStateBadgeParts(state: string): { dot: string; label: string } {
  if (state === "DRAFT") return { dot: "bg-muted-foreground/60", label: "draft" };
  if (state === "OPEN") return { dot: "bg-green-500", label: "open" };
  if (state === "MERGED") return { dot: "bg-purple-500", label: "merged" };
  return { dot: "bg-red-500", label: "closed" };
}

export function PullStateBadge({ state }: { state: string }) {
  const { dot, label } = pullStateBadgeParts(state.toUpperCase());
  return (
    <Badge variant="outline" className="gap-1.5 font-normal">
      <span className={`size-2 shrink-0 rounded-full ${dot}`} />
      {label}
    </Badge>
  );
}

export const REVIEW_STATE_LABELS: Record<string, string> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "requested changes",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
  PENDING: "review requested",
};

export function reviewStateClass(state: string): string {
  if (state === "APPROVED") return "text-green-600 dark:text-green-400";
  if (state === "CHANGES_REQUESTED") return "text-red-600 dark:text-red-400";
  return "text-muted-foreground";
}

function ReviewDecisionBadge({ decision }: { decision: string }) {
  if (decision === "APPROVED") {
    return <Badge className="bg-green-600 text-white hover:bg-green-600">approved</Badge>;
  }
  if (decision === "CHANGES_REQUESTED") {
    return <Badge variant="destructive">changes requested</Badge>;
  }
  if (decision === "REVIEW_REQUIRED") {
    return <Badge variant="secondary">review required</Badge>;
  }
  return null;
}

function checkDotClass(status: PullCheck["status"]): string {
  if (status === "success") return "bg-green-500";
  if (status === "failure") return "bg-red-500";
  if (status === "pending") return "animate-pulse bg-yellow-500";
  return "bg-muted-foreground/50";
}

function ChecksSection({ checks }: { checks: PullCheck[] }) {
  const [open, setOpen] = useState(() => checks.some((check) => check.status === "failure"));
  if (checks.length === 0) return null;
  const passing = checks.filter((check) => check.status === "success").length;
  const failing = checks.filter((check) => check.status === "failure").length;
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <button className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent/50" onClick={() => setOpen((prev) => !prev)}>
        <span
          className={`size-2 shrink-0 rounded-full ${
            failing > 0 ? "bg-red-500" : passing === checks.length ? "bg-green-500" : "animate-pulse bg-yellow-500"
          }`}
        />
        <span className="font-medium text-foreground">Checks</span>
        <span className="text-xs text-muted-foreground">
          {passing}/{checks.length} passing
          {failing > 0 ? ` · ${failing} failing` : ""}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div className="divide-y divide-border border-t border-border">
          {checks.map((check, index) => (
            <div key={`${check.name}-${index}`} className="flex items-center gap-2 px-3 py-1.5 text-xs">
              <span className={`size-2 shrink-0 rounded-full ${checkDotClass(check.status)}`} />
              <span className="min-w-0 flex-1 truncate text-foreground">{check.name}</span>
              {check.url.length > 0 ? (
                <UrlLink href={check.url} className="shrink-0 text-muted-foreground underline hover:text-foreground">
                  details ↗
                </UrlLink>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FileDiffCard({ environmentId, file, url }: { environmentId: string | null; file: PullFile; url: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex w-full items-center gap-2 px-3 py-2 hover:bg-accent/50">
        <button
          type="button"
          className="shrink-0 text-xs text-muted-foreground"
          aria-label={`${open ? "Collapse" : "Expand"} ${file.path} diff`}
          onClick={() => setOpen((prev) => !prev)}
        >
          {open ? "▾" : "▸"}
        </button>
        {environmentId === null || file.status === "removed" ? (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{file.path}</span>
        ) : (
          <FileLink
            className="min-w-0 flex-1 truncate font-mono text-xs text-foreground hover:underline"
            target={{ kind: "workspace", environmentId, path: file.path }}
          >
            {file.path}
          </FileLink>
        )}
        {file.status !== "modified" ? (
          <Badge variant="secondary" className="shrink-0 font-normal text-muted-foreground">
            {file.status}
          </Badge>
        ) : null}
        <span className="shrink-0 text-xs text-green-600 dark:text-green-400">+{file.additions}</span>
        <span className="shrink-0 text-xs text-red-600 dark:text-red-400">−{file.deletions}</span>
      </div>
      {open ? (
        file.patch !== null ? (
          <div className="border-t border-border">
            <Diff patch={file.patch} path={file.path} />
          </div>
        ) : (
          <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
            Diff too large to inline —{" "}
            <UrlLink href={`${url}/files`} className="underline" {...externalLink}>
              view on GitHub ↗
            </UrlLink>
          </p>
        )
      ) : null}
    </div>
  );
}

export function ReviewThreadCard({ thread }: { thread: ReviewThread }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <p className="flex items-center gap-2 border-b border-border bg-muted/50 px-3 py-1.5 font-mono text-xs text-muted-foreground">
        <span className="min-w-0 truncate">{thread.path}</span>
        {thread.line !== null ? <span className="shrink-0">:{thread.line}</span> : null}
      </p>
      {thread.diffHunk.length > 0 ? (
        <div className="border-b border-border">
          <Diff patch={thread.diffHunk} path={thread.path} />
        </div>
      ) : null}
      <div className="flex flex-col gap-3 p-3">
        {thread.comments.map((entry, index) => (
          <div key={index}>
            <p className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
              <Avatar login={entry.author} size="size-4" />
              <span className="font-medium text-foreground">{entry.author}</span> · {relativeTime(entry.createdAt)}
            </p>
            <GithubBody body={entry.body} bodyHtml={entry.bodyHtml} className="text-sm" />
          </div>
        ))}
      </div>
    </div>
  );
}

type PullTimelineEntry =
  | { type: "comment"; author: string; body: string; bodyHtml: string | null; createdAt: string }
  | { type: "review"; author: string; state: string; body: string; bodyHtml: string | null; createdAt: string };

export function PullTimeline({ pull }: { pull: PullDetail }) {
  const entries = useMemo<PullTimelineEntry[]>(() => {
    const merged: PullTimelineEntry[] = [
      ...pull.comments.map((comment) => ({ type: "comment" as const, ...comment })),
      ...pull.reviews
        .filter((review) => review.body.length > 0 || review.state !== "COMMENTED")
        .map((review) => ({ type: "review" as const, ...review })),
    ];
    return merged.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [pull]);
  if (entries.length === 0 && pull.reviewThreads.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold text-muted-foreground">Activity · {entries.length + pull.reviewThreads.length}</h3>
      {entries.map((entry, index) => (
        <div key={index} className="rounded-lg border border-border bg-card p-3">
          <p className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
            <Avatar login={entry.author} />
            <span className="font-medium text-foreground">{entry.author}</span>
            {entry.type === "review" ? (
              <span className={`font-medium ${reviewStateClass(entry.state)}`}>{REVIEW_STATE_LABELS[entry.state] ?? entry.state.toLowerCase()}</span>
            ) : null}
            · {relativeTime(entry.createdAt)}
          </p>
          {entry.body.length > 0 || entry.bodyHtml !== null ? <GithubBody body={entry.body} bodyHtml={entry.bodyHtml} className="text-sm" /> : null}
        </div>
      ))}
      {pull.reviewThreads.map((thread, index) => (
        <ReviewThreadCard key={index} thread={thread} />
      ))}
    </div>
  );
}

function PullReviewersList({ pull }: { pull: PullDetail }) {
  const rows = useMemo(() => {
    const latest = new Map<string, { login: string; state: string }>();
    for (const review of pull.reviews) {
      if (review.author.length > 0) latest.set(review.author, { login: review.author, state: review.state });
    }
    for (const login of pull.reviewRequests) latest.set(login, { login, state: "PENDING" });
    return [...latest.values()];
  }, [pull]);
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No reviewers</p>;
  return (
    <>
      {rows.map((row) => (
        <p key={row.login} className="flex items-center gap-2 text-sm text-foreground">
          <Avatar login={row.login} />
          <span className="min-w-0 truncate">{row.login}</span>
          <span className={`ml-auto shrink-0 text-xs ${reviewStateClass(row.state)}`}>{REVIEW_STATE_LABELS[row.state] ?? row.state.toLowerCase()}</span>
        </p>
      ))}
    </>
  );
}

function PullCommentBox({ repo, number, onPosted }: { repo: string; number: number; onPosted: () => void }) {
  const rpc = useRpc<Contract>();
  const [comment, setComment] = useState("");
  const [posting, setPosting] = useState(false);
  const post = useCallback(() => {
    if (comment.trim().length === 0) return;
    setPosting(true);
    rpc
      .call("commentPull", { repo, number, body: comment })
      .then(() => {
        setComment("");
        onPosted();
      })
      .catch((error: unknown) => toast.error(errorText(error)))
      .finally(() => setPosting(false));
  }, [rpc, repo, number, comment, onPosted]);
  return (
    <div className="flex flex-col gap-2">
      <Textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Leave a comment…" rows={3} />
      <div className="flex justify-end">
        <Button size="sm" disabled={posting || comment.trim().length === 0} onClick={post}>
          {posting ? "Posting…" : "Comment"}
        </Button>
      </div>
    </div>
  );
}

export function PullDetailView({
  repo,
  number,
  onBack,
  backLabel = "Pull requests",
  compact = false,
  readOnly = false,
  workspaceEnvironmentId = null,
}: {
  repo: string;
  number: number;
  onBack?: () => void;
  backLabel?: string;
  compact?: boolean;
  /** Hide the comment box and the "Review with agent" button. */
  readOnly?: boolean;
  workspaceEnvironmentId?: string | null;
}) {
  const rpc = useRpc<Contract>();
  const links = useLinks();
  const { spawn, spawningKey } = useSpawn();
  const [pull, setPull] = useState<PullDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    rpc.call("getPull", { repo, number }).then(
      (result) => {
        setPull(result.pull);
        setError(null);
      },
      (err: unknown) => setError(errorText(err)),
    );
  }, [rpc, repo, number]);
  useEffect(() => {
    setPull(null);
    load();
  }, [load]);

  if (error !== null) return <EmptyState message={error} />;
  if (pull === null) return <DetailSkeleton />;

  const pullLinks = links[`pr:${repo}#${number}`];
  const mainColumn = (
    <div className="flex min-w-0 flex-1 flex-col gap-4">
      <ChecksSection checks={pull.checks} />

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
          <Avatar login={pull.author} />
          <span className="font-medium text-foreground">{pull.author}</span>
          opened this pull request · updated {relativeTime(pull.updatedAt)}
        </div>
        <div className="p-4">
          {pull.body.length > 0 || pull.bodyHtml !== null ? <GithubBody body={pull.body} bodyHtml={pull.bodyHtml} className="text-sm" /> : <p className="text-sm text-muted-foreground">(no description)</p>}
        </div>
      </div>

      <PullTimeline pull={pull} />

      {pull.files.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-muted-foreground">
            Files changed · {pull.files.length}
            <span className="ml-2 font-normal">
              <span className="text-green-600 dark:text-green-400">+{pull.additions}</span>{" "}
              <span className="text-red-600 dark:text-red-400">−{pull.deletions}</span>
            </span>
          </h3>
          {pull.files.map((file) => (
            <FileDiffCard key={file.path} environmentId={workspaceEnvironmentId} file={file} url={pull.url} />
          ))}
        </div>
      ) : null}

      {readOnly ? null : <PullCommentBox repo={repo} number={number} onPosted={load} />}
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        {onBack !== undefined ? (
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onBack}>
            ← {backLabel}
          </Button>
        ) : null}
        <span className="min-w-0 truncate">
          {repo} · #{number}
        </span>
        <span className="flex-1" />
        <UrlLink href={pull.url} className="shrink-0 underline hover:text-foreground" {...externalLink}>
          Open on GitHub ↗
        </UrlLink>
      </div>

      <div className="flex items-start gap-3">
        <h2 className={`min-w-0 flex-1 font-semibold text-foreground ${compact ? "text-base" : "text-xl"}`}>
          {pull.title} <span className="font-normal text-muted-foreground">#{pull.number}</span>
        </h2>
        {readOnly ? null : (
          <Button size="sm" disabled={spawningKey !== null} onClick={() => spawn("startReview", repo, number)}>
            {spawningKey !== null ? "Starting…" : "Review with agent"}
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <PullStateBadge state={pull.state} />
        <ReviewDecisionBadge decision={pull.reviewDecision} />
        <span className="font-mono">
          {pull.baseRefName} ← {pull.headRefName}
        </span>
        <span>
          <span className="text-green-600 dark:text-green-400">+{pull.additions}</span>{" "}
          <span className="text-red-600 dark:text-red-400">−{pull.deletions}</span> · {pull.changedFiles} file{pull.changedFiles === 1 ? "" : "s"}
        </span>
        <LabelChips labels={pull.labels} className="flex flex-wrap" />
        <ThreadPills links={pullLinks} />
      </div>

      {compact ? (
        mainColumn
      ) : (
        <div className="flex flex-col gap-6 lg:flex-row">
          {mainColumn}
          <aside className="flex w-full shrink-0 flex-col gap-5 lg:w-56">
            <div className="flex flex-col gap-1">
              <SidebarHeading>Reviewers</SidebarHeading>
              <PullReviewersList pull={pull} />
            </div>
            <div className="flex flex-col gap-1">
              <SidebarHeading>Assignees</SidebarHeading>
              {pull.assignees.length === 0 ? (
                <p className="text-sm text-muted-foreground">No one assigned</p>
              ) : (
                pull.assignees.map((login) => (
                  <p key={login} className="flex items-center gap-2 text-sm text-foreground">
                    <Avatar login={login} />
                    <span className="truncate">{login}</span>
                  </p>
                ))
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <SidebarHeading>Labels</SidebarHeading>
              {pull.labels.length === 0 ? <p className="text-sm text-muted-foreground">None yet</p> : <LabelChips labels={pull.labels} className="flex flex-wrap" />}
            </div>
            {pullLinks !== undefined && pullLinks.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <SidebarHeading>Agents</SidebarHeading>
                <ThreadPills links={pullLinks} />
              </div>
            ) : null}
          </aside>
        </div>
      )}
    </div>
  );
}
