import { useEffect, useState } from "react";
import { useRemembered } from "./ui-memory";
import {
  type MergeQueue,
  type QueueGroup,
  type QueuedPullRequest,
} from "./lib/merge-queue";
import type { PrNote } from "./lib/pr-notes";
import { categoriesOf, filterPrs, groupPrs, nextUp, sizeDetail, stackLabel, stateItems, workerLabel, type GroupBy, type PrFilter } from "./lib/pr-map";
import { compactAge } from "./control-room";
import { NoteMeta, PrGraph, SizeDelta, SourceLink, StateLine, numberIndex, reviewerText, usePrLink, waitsOn, workerTitle } from "./pr-graph";
import "./pr-map.css";

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

const REVIEWERS_SHOWN = 3;

/** One PR's whole notes log, read when its panel opens (the queue carries the last few). */
export type LoadNotes = (url: string) => Promise<PrNote[]>;

/** D442: the latest note under a row (an open question already shows in the state line), and the whole log on demand. */
function NotesLine({ pr, loadNotes }: { pr: QueuedPullRequest; loadNotes?: LoadNotes }) {
  const [open, setOpen] = useState(false);
  const latest = pr.notes.recent.at(-1);
  if (!latest) return null;
  const shown = latest.kind === "question" && !latest.answered ? null : latest;
  return (
    <div className="cr-pr-notes">
      <p className="cr-pr-notes-line">
        {shown ? <span className="cr-pr-note-latest"><NoteMeta note={shown} /> <span className="cr-pr-note-text">{shown.text}</span></span> : null}
        <button type="button" className="cr-pr-notes-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "hide" : pr.notes.count === 1 ? "1 note" : `${pr.notes.count} notes`}
        </button>
      </p>
      {open ? <NotesPanel pr={pr} load={loadNotes} /> : null}
    </div>
  );
}

/** Every note on a PR, oldest first: the PR's detail panel (and later its "Discuss" action). */
function NotesPanel({ pr, load }: { pr: QueuedPullRequest; load?: LoadNotes }) {
  const [read, setRead] = useState<{ url: string; count: number; notes: PrNote[] | null; error: string | null } | null>(null);
  // Notes are only ever appended, and a question answered once (it leaves `open`): these two say when the log changed.
  const revision = `${pr.notes.count}:${pr.notes.open.map((note) => note.n).join(",")}`;
  useEffect(() => {
    if (!load) return;
    let live = true;
    load(pr.url).then(
      (notes) => { if (live) setRead({ url: pr.url, count: pr.notes.count, notes, error: null }); },
      (error: unknown) => { if (live) setRead({ url: pr.url, count: pr.notes.count, notes: null, error: error instanceof Error ? error.message : String(error) }); },
    );
    return () => { live = false; };
    // Read again when a note lands or a question is answered; `load` is a fresh closure per render.
  }, [pr.url, revision]);
  const current = read?.url === pr.url ? read : null;
  // The last few show at once; the earlier ones join them once read.
  const notes = current?.notes ?? pr.notes.recent;
  const missing = pr.notes.count - notes.length;
  return (
    <section className="cr-pr-notes-panel" aria-label={`Notes on #${pr.number}`}>
      <ol>
        {notes.map((note) => (
          <li key={note.n} data-kind={note.kind} data-open={note.kind === "question" && !note.answered ? true : undefined}>
            <span className="cr-pr-notes-head">
              <span className="cr-pr-note-n">{note.n}</span>
              <NoteMeta note={note} />
              {note.link && !/^A\d+$/.test(note.link) ? <SourceLink link={note.link} /> : null}
            </span>
            <p className="cr-pr-note-body">{note.text}</p>
            {note.answered ? (
              <p className="cr-pr-note-answer">
                answered by {note.answered.by === "user" ? "you" : note.answered.by}{note.answered.text ? `: ${note.answered.text}` : ""}
              </p>
            ) : null}
          </li>
        ))}
      </ol>
      {current?.error ? <p className="cr-mq-note" role="status">Couldn't read the earlier notes: {current.error}</p>
        : missing > 0 ? <p className="cr-pr-notes-loading" role="status">Loading {missing} earlier note{missing === 1 ? "" : "s"}…</p> : null}
    </section>
  );
}

function Row({ pr, login, blocker, loadNotes }: { pr: QueuedPullRequest; login: string | null; blocker: QueuedPullRequest | null; loadNotes?: LoadNotes }) {
  const link = usePrLink(pr.url);
  const checks = CHECKS[pr.checks.state](pr.checks);
  const review = REVIEW[pr.review];
  const mergeable = MERGEABLE[pr.mergeable];
  const icon = pr.checks.state === "none" ? null : CHECK_ICONS[pr.checks.state];
  const signals = [checks, ...(review ? [review] : []), mergeable];
  return (
    <li>
      <a className="cr-mq-pr" data-group={pr.group} {...link}
        title={pr.reasons.length ? `${pr.title}\n${pr.reasons.join(", ")}` : pr.title}>
        <PullRequestGlyph group={pr.group} />
        <span className="cr-mq-main">
          <span className="cr-mq-line">
            <span className="cr-mq-title">{pr.title}</span>
            <span className="cr-mq-updated"><Age at={pr.updatedAt} label="Updated" /></span>
          </span>
          <span className="cr-mq-line cr-mq-meta">
            <span className="cr-mq-repo">{repoLabel(pr.repo, login)} #{pr.number}</span>
            {pr.size ? <span className="cr-mq-size"><SizeDelta size={pr.size} /> <span className="cr-mq-files">{sizeDetail(pr.size)}</span></span> : null}
            {pr.stack ? (
              <span className="cr-mq-stack" title={`Stacked: level ${pr.stack.level} of ${pr.stack.levels} in a stack of ${pr.stack.size} PRs`}>
                {stackLabel(pr.stack)}
              </span>
            ) : null}
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
            {pr.reviewers.length ? (
              <span className="cr-mq-reviewers" title={pr.reviewers.map(reviewerText).join("\n")}>
                {pr.reviewers.slice(0, REVIEWERS_SHOWN).map((r) => <span key={r.login} data-state={r.state}>{r.login}</span>)}
                {pr.reviewers.length > REVIEWERS_SHOWN ? <span>+{pr.reviewers.length - REVIEWERS_SHOWN}</span> : null}
              </span>
            ) : null}
            {pr.available ? <span className="cr-mq-available">review now</span> : null}
            {blocker ? <span className="cr-mq-waits" title={`#${blocker.number}, beneath it in its stack, is not ready for you yet`}>waits on #{blocker.number}</span> : null}
            {pr.worker ? <span className="cr-mq-worker" title={workerTitle(pr.worker)}>{workerLabel(pr.worker)}</span> : null}
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
      <StateLine pr={pr} />
      <NotesLine pr={pr} loadNotes={loadNotes} />
    </li>
  );
}

/** "Updated 2m ago", or why the data may be old. */
function Status({ queue, refreshing }: { queue: MergeQueue; refreshing: boolean }) {
  if (refreshing || queue.repos.some((r) => r.fetching)) return <span className="cr-mq-status">Refreshing…</span>;
  const failed = queue.repos.filter((r) => r.error);
  const times = queue.repos.flatMap((r) => (r.fetchedAt ? [r.fetchedAt] : []));
  const oldest = times.length ? Math.min(...times) : null;
  if (failed.length)
    return <span className="cr-mq-status" data-tone="wait">Couldn't refresh{oldest ? <> · from {compactAge(oldest)} ago</> : null}</span>;
  return oldest ? <span className="cr-mq-status">Updated {compactAge(oldest) === "now" ? "just now" : `${compactAge(oldest)} ago`}</span> : null;
}

function NextUp({ prs, repoOf }: { prs: readonly QueuedPullRequest[]; repoOf: (pr: QueuedPullRequest) => string | null }) {
  const [expanded, setExpanded] = useState(false);
  if (!prs.length) return null;
  const shown = expanded ? prs : prs.slice(0, NEXT_SHOWN);
  return (
    <section className="cr-pm-next" aria-label="Next up">
      <h3>
        Next up<span className="cr-count">{prs.length}</span>
        <span className="cr-pm-hint">ready for you, stack bottoms first</span>
      </h3>
      <ol>{shown.map((pr) => <NextItem key={pr.url} pr={pr} repo={repoOf(pr)} />)}</ol>
      {prs.length > NEXT_SHOWN ? (
        <button type="button" className="cr-pm-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show fewer" : `Show all ${prs.length}`}
        </button>
      ) : null}
    </section>
  );
}
const NEXT_SHOWN = 5;

function NextItem({ pr, repo }: { pr: QueuedPullRequest; repo: string | null }) {
  const link = usePrLink(pr.url);
  return (
    <li>
      <a className="cr-pm-next-pr" {...link} title={[pr.title, pr.stageNote, ...stateItems(pr).map((item) => item.text)].filter(Boolean).join("\n")}>
        <span className="cr-pm-num">#{pr.number}</span>
        <span className="cr-pm-title">{pr.title}</span>
        {pr.notes.open.length ? <span className="cr-pm-ask" title={`${pr.notes.open.length} open question${pr.notes.open.length === 1 ? "" : "s"}`}>?</span> : null}
        <span className="cr-pm-next-meta">
          {[repo, pr.category, pr.stack ? stackLabel(pr.stack) : null].filter(Boolean).join(" · ")}
        </span>
      </a>
    </li>
  );
}

const NO_FILTER: PrFilter = { stages: [], availableOnly: false };

/** How the PRs tab is set up, remembered per Initiative. */
interface PrView {
  mode: "list" | "graph";
  by: GroupBy;
  filter: PrFilter;
}
const DEFAULT_VIEW: PrView = { mode: "list", by: "category", filter: NO_FILTER };
const isPrView = (v: unknown): v is PrView => {
  const view = v as PrView | null;
  return !!view && ["list", "graph"].includes(view.mode) && ["category", "stage"].includes(view.by) && !!view.filter
    && Array.isArray(view.filter.stages) && view.filter.stages.every((s) => typeof s === "string")
    && typeof view.filter.availableOnly === "boolean"
    && (view.filter.category === undefined || view.filter.category === null || typeof view.filter.category === "string");
};

/** The toolbar (view, grouping, filters), Next up, and the list or the graph. */
function PrMap({ queue, loadNotes }: { queue: MergeQueue; loadNotes?: LoadNotes }) {
  const [view, setView] = useRemembered<PrView>(`initiatives:prs:${queue.projectId}`, DEFAULT_VIEW, isPrView);
  const { mode, by, filter } = view;
  const setMode = (mode: PrView["mode"]) => setView({ ...view, mode });
  const setBy = (by: GroupBy) => setView({ ...view, by });
  const setFilter = (filter: PrFilter) => setView({ ...view, filter });
  const all = queue.pullRequests;
  const categories = categoriesOf(all);
  const categorized = categories.some((c) => c.category !== null);
  // A category renamed or merged away since it was picked shows every category again.
  const category = categories.some((c) => c.category === filter.category) ? filter.category : undefined;
  const inCategory = filterPrs(all, { ...NO_FILTER, category });
  const shown = filterPrs(inCategory, { ...filter, category: undefined });
  const byNumber = numberIndex(all);
  const stageCounts = new Map(queue.stages.map((s) => [s.id, inCategory.filter((pr) => pr.stage === s.id).length]));
  const toggleStage = (id: string) =>
    setFilter({ ...filter, stages: filter.stages.includes(id) ? filter.stages.filter((s) => s !== id) : [...filter.stages, id] });
  const filtered = category !== undefined || filter.stages.length > 0 || filter.availableOnly;
  const row = (pr: QueuedPullRequest) => <Row key={pr.url} pr={pr} login={queue.login} blocker={waitsOn(pr, byNumber)} loadNotes={loadNotes} />;
  return (
    <>
      <div className="cr-pm-bar">
        <div className="project-usage-filter" role="group" aria-label="Show as">
          {(["list", "graph"] as const).map((value) => (
            <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)}>{value}</button>
          ))}
        </div>
        {categorized && mode === "list" ? (
          <div className="project-usage-filter" role="group" aria-label="Group by">
            {(["category", "stage"] as const).map((value) => (
              <button key={value} type="button" aria-pressed={by === value} onClick={() => setBy(value)}>by {value}</button>
            ))}
          </div>
        ) : null}
        {categorized ? (
          <select className="cr-pm-select" aria-label="Category" value={category === undefined ? -1 : categories.findIndex((c) => c.category === category)}
            onChange={(event) => {
              const index = Number(event.target.value);
              setFilter({ ...filter, category: index < 0 ? undefined : categories[index]!.category });
            }}>
            <option value={-1}>All categories</option>
            {categories.map((c, index) => <option key={c.label} value={index}>{c.label} ({c.count})</option>)}
          </select>
        ) : null}
      </div>
      <div className="cr-pm-chips" role="group" aria-label="Filter by stage">
        {queue.stages.filter((s) => stageCounts.get(s.id)).map((s) => (
          <button key={s.id} type="button" className="cr-pm-chip" aria-pressed={filter.stages.includes(s.id)} onClick={() => toggleStage(s.id)}>
            <span className="cr-pm-dot" data-stage={s.id} aria-hidden="true" />
            {s.label}
            <span className="cr-pm-chip-count">{stageCounts.get(s.id)}</span>
          </button>
        ))}
        <button type="button" className="cr-pm-chip" data-kind="available" aria-pressed={filter.availableOnly}
          onClick={() => setFilter({ ...filter, availableOnly: !filter.availableOnly })}>
          <span className="cr-pm-dot" data-available="true" aria-hidden="true" />
          Review now
          <span className="cr-pm-chip-count">{inCategory.filter((pr) => pr.available).length}</span>
        </button>
        {filtered ? <button type="button" className="cr-pm-clear" onClick={() => setFilter(NO_FILTER)}>Clear</button> : null}
      </div>
      {filter.availableOnly ? null : <NextUp prs={nextUp(inCategory)} repoOf={(pr) => (queue.repos.length > 1 ? repoLabel(pr.repo, queue.login) : null)} />}
      {!shown.length ? (
        <p className="cr-empty">No pull requests match these filters.</p>
      ) : mode === "graph" ? (
        <PrGraph pullRequests={shown} all={all} stages={queue.stages} />
      ) : (
        groupPrs(shown, categorized ? by : "stage", queue.stages, all).map((g) => (
          <section key={g.label} className="cr-mq-group" {...(categorized && by === "category" ? { "data-category": g.label } : { "data-stage": g.key! })} aria-label={g.label}>
            <h3>
              {g.label}
              <span className="cr-count">{g.count}</span>
            </h3>
            {categorized ? (
              g.groups.map((sub) => (
                <div key={sub.label} className="cr-mq-sub" data-stage={by === "category" ? sub.key! : undefined}>
                  <h4>{by === "category" ? <span className="cr-pm-dot" data-stage={sub.key!} aria-hidden="true" /> : null}{sub.label}<span className="cr-mq-sub-count">{sub.pullRequests.length}</span></h4>
                  <ul>{sub.pullRequests.map(row)}</ul>
                </div>
              ))
            ) : (
              <ul>{g.groups.flatMap((sub) => sub.pullRequests).map(row)}</ul>
            )}
          </section>
        ))
      )}
    </>
  );
}

/** Rows shaped like the list while the first read from GitHub runs. */
function QueueSkeleton() {
  return (
    <div className="cr-mq-skeleton">
      <p className="cr-mq-status" role="status">Loading pull requests from GitHub…</p>
      <ul aria-hidden="true">
        {[62, 48, 70, 54].map((width) => (
          <li key={width}><span style={{ width: `${width}%` }} /><span /></li>
        ))}
      </ul>
    </div>
  );
}

export function MergeQueueView({
  queue,
  error,
  refreshing,
  onRefresh,
  loadNotes,
}: {
  queue: MergeQueue | null;
  /** The read itself failed (not a `gh` fetch, which comes back per repository). */
  error: string | null;
  refreshing: boolean;
  onRefresh: () => void;
  loadNotes?: LoadNotes;
}) {
  const failed = queue?.repos.filter((r) => r.error) ?? [];
  const neverLoaded = !!queue && queue.repos.length > 0 && queue.repos.every((r) => r.fetchedAt === null);
  const fetching = refreshing || !!queue?.repos.some((r) => r.fetching);
  // Sizes kept from an older read; reviewer states are withheld until the details load again.
  const staleDetails = queue?.repos.filter((r) => r.fetchedAt !== null && !r.error && r.detailsError) ?? [];
  return (
    <section className="cr-mq" aria-label="Merge queue" aria-busy={fetching}>
      <div className="cr-mq-head">
        <h2 className="cr-section-heading">Merge queue</h2>
        {queue ? <Status queue={queue} refreshing={refreshing} /> : null}
        <button type="button" className="cr-iconbtn cr-mq-refresh" aria-label="Refresh merge queue" disabled={fetching} onClick={onRefresh}>
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
      {staleDetails.length ? (
        <p className="cr-mq-note" role="status">
          {staleDetails.map((r) => `${r.repo}: sizes and reviewers didn't refresh (${r.detailsError})`).join(" · ")}.
          {" "}Sizes are from {staleDetails.some((r) => r.detailsFetchedAt) ? "an earlier read" : "no read yet"}; reviewers are hidden until they load.
        </p>
      ) : null}
      {neverLoaded && failed.length && !fetching ? (
        <div role="alert" className="project-error">
          Couldn't read pull requests. {failed[0]!.error}
          <button onClick={onRefresh} disabled={refreshing}>Retry</button>
        </div>
      ) : null}
      {!queue ? (
        error ? null : <QueueSkeleton />
      ) : !queue.repos.length ? (
        <p className="cr-empty">No member project has a GitHub origin remote.</p>
      ) : neverLoaded ? (
        fetching ? <QueueSkeleton /> : null
      ) : !queue.pullRequests.length ? (
        <p className="cr-empty">No open pull requests{queue.login ? ` by ${queue.login}` : ""}.</p>
      ) : (
        <PrMap queue={queue} loadNotes={loadNotes} />
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
