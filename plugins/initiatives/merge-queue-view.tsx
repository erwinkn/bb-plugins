import { useEffect, useState, type KeyboardEvent } from "react";
import { useRemembered } from "./ui-memory";
import {
  type MergeQueue,
  type QueueGroup,
  type QueuedPullRequest,
} from "./lib/merge-queue";
import type { PrNote } from "./lib/pr-notes";
import { categoriesOf, filterPrs, groupPrs, nextUp, sizeDetail, stackLabel, stackOrder, stateItems, workerLabel, type GroupBy, type PrFilter } from "./lib/pr-map";
import { compactAge } from "./control-room";
import { moveTargets, useMoveMenu, type MoveMenu, type MovePr, type PrMenuAt } from "./pr-move-menu";
import { pickPr, searchPrs } from "./lib/pr-search";
import { DetailsButton, NoteMeta, NotesList, PrGraph, Signals, SizeDelta, StateLine, numberIndex, reviewerText, usePrLink, waitsOn, workerTitle } from "./pr-graph";
import { PrDetailPanel, type LoadDetail } from "./pr-detail-view";
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

/** Every note on a PR, oldest first: the PR's detail panel. */
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
      <NotesList notes={notes} />
      {current?.error ? <p className="cr-mq-note" role="status">Couldn't read the earlier notes: {current.error}</p>
        : missing > 0 ? <p className="cr-pr-notes-loading" role="status">Loading {missing} earlier note{missing === 1 ? "" : "s"}…</p> : null}
    </section>
  );
}

/**
 * A PR row. A click opens the PR; a right click, a long press, the context-menu key or
 * Shift+F10 open its "Move to Initiative" menu (R2).
 */
function Row({ pr, login, blocker, loadNotes, open, onOpen, menu }: {
  pr: QueuedPullRequest; login: string | null; blocker: QueuedPullRequest | null; loadNotes?: LoadNotes;
  open: boolean; onOpen: (pr: QueuedPullRequest) => void; menu: MoveMenu | null;
}) {
  const link = usePrLink(pr.url);
  const { item, anchor, handlers, element } = useMoveMenu(pr, menu, link.onClick);
  return (
    <li ref={item} className="cr-mq-row" data-open={open || undefined} data-unassigned={pr.unassigned || undefined}>
      <a ref={anchor} className="cr-mq-pr" data-group={pr.group} {...link} {...handlers}
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
            <Signals pr={pr} />
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
      <DetailsButton pr={pr} open={open} onOpen={onOpen} />
      <StateLine pr={pr} />
      <NotesLine pr={pr} loadNotes={loadNotes} />
      {element}
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

/** How the PRs tab is set up, remembered per Initiative: views from before T156 have no search and no open PR. */
interface PrView {
  mode: "list" | "graph";
  by: GroupBy;
  filter: PrFilter;
  query?: string;
  /** The URL of the PR whose detail panel is open. */
  open?: string | null;
}
const DEFAULT_VIEW: PrView = { mode: "list", by: "category", filter: NO_FILTER };
const isPrView = (v: unknown): v is PrView => {
  const view = v as PrView | null;
  return !!view && ["list", "graph"].includes(view.mode) && ["category", "stage"].includes(view.by) && !!view.filter
    && Array.isArray(view.filter.stages) && view.filter.stages.every((s) => typeof s === "string")
    && typeof view.filter.availableOnly === "boolean"
    && (view.filter.category === undefined || view.filter.category === null || typeof view.filter.category === "string")
    && (view.query === undefined || typeof view.query === "string")
    && (view.open === undefined || view.open === null || typeof view.open === "string");
};

/**
 * The toolbar (view, grouping, search, filters), Next up, the list or the graph, and the open
 * PR's detail. The Initiative's own PRs come first; the unassigned ones (R2) follow, folded
 * under Unassigned, unless a search is looking through them.
 */
function PrMap({ queue, loadNotes, loadDetail, onMove }: { queue: MergeQueue; loadNotes?: LoadNotes; loadDetail?: LoadDetail; onMove?: MovePr }) {
  const [view, setView] = useRemembered<PrView>(`initiatives:prs:${queue.projectId}`, DEFAULT_VIEW, isPrView);
  const { mode, by, filter, query = "" } = view;
  const setMode = (mode: PrView["mode"]) => setView({ ...view, mode });
  const setBy = (by: GroupBy) => setView({ ...view, by });
  const setFilter = (filter: PrFilter) => setView({ ...view, filter });
  const setOpen = (pr: QueuedPullRequest | null) => setView({ ...view, open: pr?.url ?? null });
  const all = queue.pullRequests;
  // A PR merged or closed since it was opened closes its panel.
  const openPr = all.find((pr) => pr.url === view.open) ?? null;
  const categories = categoriesOf(all);
  const categorized = categories.some((c) => c.category !== null);
  // A category renamed or merged away since it was picked shows every category again.
  const category = categories.some((c) => c.category === filter.category) ? filter.category : undefined;
  const found = searchPrs(all, query);
  const inCategory = filterPrs(found, { ...NO_FILTER, category });
  const shown = filterPrs(inCategory, { ...filter, category: undefined });
  const hidden = found.length - shown.length;
  const pick = pickPr(all, shown, query);
  // R2: another Initiative's PR beneath one of these still names what it waits on.
  const byNumber = numberIndex([...all, ...(queue.beneath ?? [])]);
  const stageCounts = new Map(queue.stages.map((s) => [s.id, inCategory.filter((pr) => pr.stage === s.id).length]));
  const toggleStage = (id: string) =>
    setFilter({ ...filter, stages: filter.stages.includes(id) ? filter.stages.filter((s) => s !== id) : [...filter.stages, id] });
  const filtered = category !== undefined || filter.stages.length > 0 || filter.availableOnly;
  const mine = shown.filter((pr) => !pr.unassigned);
  const unassigned = shown.filter((pr) => pr.unassigned).sort(stackOrder(all));
  const [unassignedOpen, setUnassignedOpen] = useState(false);
  const [menuAt, setMenuAt] = useState<PrMenuAt | null>(null);
  const menuOf = (pr: QueuedPullRequest): MoveMenu | null => {
    const { targets, pending } = moveTargets(pr, queue.projectId, queue.initiatives ?? []);
    if (!onMove || (!targets.length && pr.unassigned && !pending)) return null;
    return {
      at: menuAt?.url === pr.url ? menuAt : null, projectId: queue.projectId, targets, pending, move: onMove,
      open: (x, y) => setMenuAt({ url: pr.url, x, y }),
      close: () => setMenuAt((at) => (at?.url === pr.url ? null : at)),
    };
  };
  const row = (pr: QueuedPullRequest) => (
    <Row key={pr.url} pr={pr} login={queue.login} blocker={waitsOn(pr, byNumber)} loadNotes={loadNotes} open={pr === openPr} onOpen={setOpen} menu={menuOf(pr)} />
  );
  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      if (pick) setOpen(pick);
    } else if (event.key === "Escape" && (openPr || query)) {
      // The panel closes first, then the search clears.
      event.preventDefault();
      setView(openPr ? { ...view, open: null } : { ...view, query: "" });
    }
  };
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
        <input type="search" className="cr-pm-search" aria-label="Search pull requests" placeholder="#2251, title, branch, W12, A301…"
          value={query} onChange={(event) => setView({ ...view, query: event.target.value })} onKeyDown={onSearchKey} />
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
      {query.trim() ? (
        <p className="cr-pm-found" role="status">
          {shown.length === 1 ? "1 match" : `${shown.length} matches`}
          {hidden ? (
            <> · {hidden} more behind the filters <button type="button" className="cr-pm-clear" onClick={() => setFilter(NO_FILTER)}>Show them</button></>
          ) : null}
          {pick ? <span className="cr-pm-hint"><kbd>Enter</kbd> opens #{pick.number}</span> : null}
        </p>
      ) : null}
      <div className="cr-pm-body" data-open={openPr ? true : undefined}>
      <div className="cr-pm-results">
      {filter.availableOnly || query.trim() ? null : <NextUp prs={nextUp(inCategory).filter((pr) => !pr.unassigned)} repoOf={(pr) => (queue.repos.length > 1 ? repoLabel(pr.repo, queue.login) : null)} />}
      {!shown.length ? (
        <p className="cr-empty">No pull requests match {query.trim() ? "this search" : "these filters"}.</p>
      ) : !mine.length ? (
        <p className="cr-empty">{query.trim() || filtered ? "None of this Adventure's pull requests match." : "No pull request is this Adventure's yet."}</p>
      ) : mode === "graph" ? (
        <PrGraph pullRequests={mine} all={all} beneath={queue.beneath} stages={queue.stages} open={openPr} onOpen={setOpen} menuOf={menuOf} />
      ) : (
        groupPrs(mine, categorized ? by : "stage", queue.stages, all).map((g) => (
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
      {unassigned.length ? (
        <section className="cr-mq-group cr-mq-unassigned" aria-label="Unassigned">
          <h3>
            <button type="button" className="cr-mq-fold" aria-expanded={unassignedOpen || !!query.trim()} onClick={() => setUnassignedOpen(!unassignedOpen)}>
              Unassigned<span className="cr-count">{unassigned.length}</span>
            </button>
            <span className="cr-pm-hint">shown in every Adventure with their repository{onMove ? "; right-click or long-press one to move it" : ""}</span>
          </h3>
          {unassignedOpen || query.trim() ? <ul>{unassigned.map(row)}</ul> : null}
        </section>
      ) : null}
      </div>
      {openPr ? (
        <PrDetailPanel pr={openPr} all={all} beneath={queue.beneath} stages={queue.stages}
          login={queue.login} load={loadDetail} revision={queue} onOpen={setOpen} onClose={() => setOpen(null)} />
      ) : null}
      </div>
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
  loadDetail,
  onMove,
}: {
  queue: MergeQueue | null;
  /** The read itself failed (not a `gh` fetch, which comes back per repository). */
  error: string | null;
  refreshing: boolean;
  onRefresh: () => void;
  loadNotes?: LoadNotes;
  loadDetail?: LoadDetail;
  /** R2: the row menu's "Move to Initiative"; without it rows have no menu. */
  onMove?: MovePr;
}) {
  const failed = queue?.repos.filter((r) => r.error) ?? [];
  const neverLoaded = !!queue && queue.repos.length > 0 && queue.repos.every((r) => r.fetchedAt === null);
  const fetching = refreshing || !!queue?.repos.some((r) => r.fetching);
  // Sizes kept from an older read; reviewer states are withheld until the details load again.
  const staleDetails = queue?.repos.filter((r) => r.fetchedAt !== null && !r.error && r.detailsError) ?? [];
  const capped = queue?.repos.filter((r) => r.capped) ?? [];
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
      {capped.length ? (
        <p className="cr-mq-note" role="status">
          {capped.map((r) => `${r.repo}: read ${r.capped!.listed} of ${r.capped!.total} open PRs`).join(" · ")}, as many as GitHub's search returns.
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
        <PrMap queue={queue} loadNotes={loadNotes} loadDetail={loadDetail} onMove={onMove} />
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
