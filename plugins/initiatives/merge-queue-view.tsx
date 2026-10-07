import type { MouseEvent } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import {
  groupQueue,
  type MergeQueue,
  type QueueGroup,
  type QueuedPullRequest,
} from "./lib/merge-queue";
import { compactAge } from "./control-room";

function Age({ at, label }: { at: number; label: string }) {
  return at ? (
    <time dateTime={new Date(at).toISOString()} title={`${label} ${new Date(at).toLocaleString()}`}>
      {compactAge(at)}
    </time>
  ) : null;
}

/** The PR glyph: a dashed head branch for drafts, colored by group in CSS. */
function PullRequestGlyph({ group }: { group: QueueGroup }) {
  return (
    <svg className="cr-mq-glyph" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="4" cy="3.5" r="1.75" />
      <circle cx="4" cy="12.5" r="1.75" />
      <path d="M4 5.25v5.5" />
      <circle cx="12" cy="12.5" r="1.75" />
      <path d="M12 10.75V6a2.5 2.5 0 0 0-2.5-2.5H8m2-2-2 2 2 2" strokeDasharray={group === "draft" ? "2 2" : undefined} />
    </svg>
  );
}

// Drawn rather than typed: ✓ ✕ ◷ depend on the client's fonts.
const CHECK_ICONS = {
  pass: "M3.5 8.5l3 3 6-7",
  fail: "M4.5 4.5l7 7M11.5 4.5l-7 7",
  pending: "M8 2.75a5.25 5.25 0 1 0 0 10.5 5.25 5.25 0 1 0 0-10.5zM8 5.5V8l1.75 1.25",
} as const;
const CHECKS: Record<QueuedPullRequest["checks"]["state"], (c: QueuedPullRequest["checks"]) => [string, string]> = {
  pass: (c) => ["good", `${c.passed}/${c.total} checks`],
  fail: (c) => ["bad", `${c.failed} of ${c.total} failing`],
  pending: (c) => ["wait", `${c.pending} of ${c.total} running`],
  none: () => ["faint", "no checks"],
};
const REVIEW: Record<QueuedPullRequest["review"], [string, string] | null> = {
  approved: ["good", "approved"],
  changes_requested: ["bad", "changes requested"],
  review_required: ["wait", "review required"],
  none: null,
};
const MERGEABLE: Record<QueuedPullRequest["mergeable"], [string, string]> = {
  mergeable: ["quiet", "mergeable"],
  conflicting: ["bad", "conflicts"],
  unknown: ["faint", "checking mergeability"],
};

/** `bb-plugins` for the user's own repositories, `owner/repo` otherwise. */
const repoLabel = (repo: string, login: string | null) =>
  login && repo.toLowerCase().startsWith(`${login.toLowerCase()}/`) ? repo.slice(login.length + 1) : repo;

function Row({ pr, login }: { pr: QueuedPullRequest; login: string | null }) {
  const navigate = useBbNavigate();
  // A plain click opens a tab of BB's built-in browser (or the external
  // browser, per the client's preference); modifier clicks keep the
  // anchor's own behavior.
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (!navigate.openUrl(pr.url)) window.open(pr.url, "_blank", "noopener,noreferrer");
  };
  const checks = CHECKS[pr.checks.state](pr.checks);
  const review = REVIEW[pr.review];
  const mergeable = MERGEABLE[pr.mergeable];
  const icon = pr.checks.state === "none" ? null : CHECK_ICONS[pr.checks.state];
  const signals = [checks, ...(review ? [review] : []), mergeable];
  return (
    <li>
      <a className="cr-mq-pr" data-group={pr.group} href={pr.url} target="_blank" rel="noopener noreferrer" onClick={open}
        title={pr.reasons.length ? `${pr.title}\n${pr.reasons.join(", ")}` : pr.title}>
        <PullRequestGlyph group={pr.group} />
        <span className="cr-mq-main">
          <span className="cr-mq-line">
            <span className="cr-mq-title">{pr.title}</span>
            <span className="cr-mq-updated"><Age at={pr.updatedAt} label="Updated" /></span>
          </span>
          <span className="cr-mq-line cr-mq-meta">
            <span className="cr-mq-repo">{repoLabel(pr.repo, login)} #{pr.number}</span>
            <span className="cr-mq-branch" title={`${pr.head} → ${pr.base}`}>
              <code className="cr-mq-headref">{pr.head}</code>
              <span aria-label="into">→</span>
              <code>{pr.base}</code>
            </span>
            <span className="cr-mq-opened">opened <Age at={pr.createdAt} label="Opened" /></span>
          </span>
          <span className="cr-mq-line cr-mq-signals">
            {signals.map(([tone, text], index) => (
              <span key={text} className="cr-mq-signal" data-tone={tone}>
                {index === 0 && icon ? (
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                    <path d={icon} />
                  </svg>
                ) : null}
                {text}
              </span>
            ))}
            {pr.draft ? <span className="cr-mq-signal" data-tone="faint">draft</span> : null}
            {pr.worker ? <span className="cr-mq-worker" title={`Branch of ${pr.worker.ref}'s thread`}>{pr.worker.ref}</span> : null}
            {pr.stageSource === "github" ? (
              <span className="cr-mq-guess" title="Stage guessed from GitHub: the coordinator hasn't set one">guessed</span>
            ) : null}
          </span>
          {pr.stageSource === "coordinator" && pr.stageNote ? (
            <span className="cr-mq-line cr-mq-stage-note" title={pr.stageSetAt ? `Set by the coordinator ${new Date(pr.stageSetAt).toLocaleString()}` : undefined}>
              {pr.stageNote}
            </span>
          ) : null}
        </span>
      </a>
    </li>
  );
}

/** "Updated 2m ago", or why the data may be old. */
function Status({ queue, refreshing }: { queue: MergeQueue; refreshing: boolean }) {
  if (refreshing) return <span className="cr-mq-status">Refreshing…</span>;
  const failed = queue.repos.filter((r) => r.error);
  const times = queue.repos.flatMap((r) => (r.fetchedAt ? [r.fetchedAt] : []));
  const oldest = times.length ? Math.min(...times) : null;
  if (failed.length)
    return <span className="cr-mq-status" data-tone="wait">Couldn't refresh{oldest ? <> · from {compactAge(oldest)} ago</> : null}</span>;
  return oldest ? <span className="cr-mq-status">Updated {compactAge(oldest) === "now" ? "just now" : `${compactAge(oldest)} ago`}</span> : null;
}

export function MergeQueueView({
  queue,
  error,
  refreshing,
  onRefresh,
}: {
  queue: MergeQueue | null;
  /** The read itself failed (not a `gh` fetch, which comes back per repository). */
  error: string | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const failed = queue?.repos.filter((r) => r.error) ?? [];
  const groups = queue ? groupQueue(queue.pullRequests, queue.stages) : [];
  const neverLoaded = !!queue && queue.repos.length > 0 && queue.repos.every((r) => r.fetchedAt === null);
  return (
    <section className="cr-mq" aria-label="Merge queue" aria-busy={refreshing}>
      <div className="cr-mq-head">
        <h2 className="cr-section-heading">Merge queue</h2>
        {queue ? <Status queue={queue} refreshing={refreshing} /> : null}
        <button type="button" className="cr-iconbtn cr-mq-refresh" aria-label="Refresh merge queue" disabled={refreshing} onClick={onRefresh}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" />
          </svg>
        </button>
      </div>
      {error ? (
        queue ? <p className="cr-mq-note" role="status">Couldn't refresh: {error}</p>
          : <div role="alert" className="project-error">Couldn't load the merge queue: {error}<button onClick={onRefresh} disabled={refreshing}>Retry</button></div>
      ) : null}
      {failed.length && !neverLoaded ? (
        <p className="cr-mq-note" role="status">
          {failed.map((r) => `${r.repo}: ${r.error}`).join(" · ")}. Showing the last data that loaded.
        </p>
      ) : null}
      {neverLoaded && failed.length ? (
        <div role="alert" className="project-error">
          Couldn't read pull requests. {failed[0]!.error}
          <button onClick={onRefresh} disabled={refreshing}>Retry</button>
        </div>
      ) : null}
      {!queue ? (
        error ? null : <p className="cr-empty">Loading pull requests…</p>
      ) : !queue.repos.length ? (
        <p className="cr-empty">No member project has a GitHub origin remote.</p>
      ) : neverLoaded ? null : !groups.length ? (
        <p className="cr-empty">No open pull requests{queue.login ? ` by ${queue.login}` : ""}.</p>
      ) : (
        groups.map((g) => (
          <section key={g.stage} className="cr-mq-group" data-stage={g.stage} aria-label={g.label}>
            <h3>
              {g.label}
              <span className="cr-count">{g.pullRequests.length}</span>
            </h3>
            <ul>
              {g.pullRequests.map((pr) => <Row key={pr.url} pr={pr} login={queue.login} />)}
            </ul>
          </section>
        ))
      )}
      {queue && queue.repos.length ? (
        <p className="cr-mq-foot">
          Open PRs{queue.login ? <> by <strong>{queue.login}</strong></> : null} in {queue.repos.map((r) => r.repo).join(", ")}
          {queue.skipped.length ? <> · {queue.skipped.map((s) => s.project).join(", ")}: {queue.skipped[0]!.reason}</> : null}
        </p>
      ) : null}
    </section>
  );
}
