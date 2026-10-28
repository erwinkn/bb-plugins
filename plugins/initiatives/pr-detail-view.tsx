import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { QueuedPullRequest, StageDefinition } from "./lib/merge-queue";
import type { PrDetail, PrVia } from "./lib/pr-detail";
import { noteAuthor, sizeDetail, workerLabel } from "./lib/pr-map";
import { compactAge } from "./control-room";
import { NotesList, Signals, SizeDelta, StateLine, numberIndex, reviewerText, usePrLink, waitsOn, workerTitle } from "./pr-graph";

/** Everything the Initiative knows about one PR (prDetail), read when its panel opens. */
export type LoadDetail = (url: string) => Promise<PrDetail>;

const VIA: Record<PrVia, string> = {
  record: "coordinator's record", brief: "its brief names the PR", report: "its report names the PR", note: "a note on the PR",
  branch: "the worker whose branch opened the PR", assignment: "a linked assignment", mention: "mentions the PR's number",
};
/** "via report · note": how an item is tied to the PR, the mention-only ones faint. */
function Via({ via }: { via: readonly PrVia[] }) {
  const mention = via.length === 1 && via[0] === "mention";
  return <span className="cr-pd-via" data-mention={mention || undefined} title={via.map((v) => VIA[v]).join("\n")}>{mention ? "mentions it" : via.join(" · ")}</span>;
}

function Ago({ at, label }: { at: number | null; label: string }) {
  return at ? <time dateTime={new Date(at).toISOString()} title={`${label} ${new Date(at).toLocaleString()}`}>{compactAge(at)}</time> : null;
}

/** A thread link, or nothing when the thread is unknown. */
function ThreadLink({ threadId, children }: { threadId: string | null; children: ReactNode }) {
  const navigate = useBbNavigate();
  if (!threadId) return <>{children}</>;
  return <a href="#" className="cr-pd-thread" title="Open the thread" onClick={(event) => { event.preventDefault(); navigate.toThread(threadId); }}>{children}</a>;
}

/** A titled section whose list shows its first `shown` items and a "Show all" toggle; `total` counts what the server clipped too. */
function Section<T>({ title, items, total, shown = 5, empty, render }: {
  title: string; items: readonly T[]; total: number; shown?: number; empty?: string; render: (item: T) => ReactNode;
}) {
  const [all, setAll] = useState(false);
  if (!items.length && !empty) return null;
  const visible = all ? items : items.slice(0, shown);
  return (
    <section className="cr-pd-section" aria-label={title}>
      <h4>{title}{total ? <span className="cr-count">{total}</span> : null}</h4>
      {items.length ? <ul>{visible.map(render)}</ul> : <p className="cr-pd-empty">{empty}</p>}
      {items.length > shown ? (
        <button type="button" className="cr-pm-more" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${items.length}`}
        </button>
      ) : null}
      {all && total > items.length ? <p className="cr-pd-empty">The newest {items.length} of {total}; initiative_read has the rest.</p> : null}
    </section>
  );
}

/** A long text clamped to three lines, a disclosure that shows it whole. */
function Clamp({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return <button type="button" className="cr-pd-text" aria-expanded={open} onClick={() => setOpen(!open)} title={open ? undefined : "Show all"}>{text}</button>;
}

/** The PRs a stack puts beside this one: a chip that opens its detail. */
/** A PR in the stack; another Initiative's (R2) only names itself, since it has no panel here. */
function PrChip({ pr, onOpen }: { pr: QueuedPullRequest; onOpen: ((pr: QueuedPullRequest) => void) | null }) {
  if (!onOpen)
    return (
      <span className="cr-pd-chip" title={`${pr.title} (another Adventure's)`}>
        <span className="cr-pm-dot" data-stage={pr.stage} aria-hidden="true" />#{pr.number}
      </span>
    );
  return (
    <button type="button" className="cr-pd-chip" title={pr.title} onClick={() => onOpen(pr)}>
      <span className="cr-pm-dot" data-stage={pr.stage} aria-hidden="true" />#{pr.number}
    </button>
  );
}

function useDetail(load: LoadDetail | undefined, url: string, revision: unknown) {
  const [read, setRead] = useState<{ url: string; detail: PrDetail | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!load) return;
    let live = true;
    load(url).then(
      (detail) => { if (live) setRead({ url, detail, error: null }); },
      // A failed re-read keeps what the last one showed.
      (error: unknown) => { if (live) setRead((last) => ({ url, detail: last?.url === url ? last.detail : null, error: error instanceof Error ? error.message : String(error) })); },
    );
    return () => { live = false; };
    // Read again on each queue read (every poll), so a report or a decision shows up; `load` is a fresh closure per render.
  }, [url, revision]);
  return read?.url === url ? read : null;
}

/** Placeholder lines while the first read runs. */
function Bones() {
  return (
    <div className="cr-mq-skeleton cr-pd-bones" role="status" aria-label="Loading the PR's history">
      <ul aria-hidden="true">{[70, 52, 64].map((width) => <li key={width}><span style={{ width: `${width}%` }} /><span /></li>)}</ul>
    </div>
  );
}

/**
 * One PR, everything known about it: GitHub's side from the queue, the
 * Initiative's (record, stage history, notes, work, decisions, updates) from prDetail.
 * Esc closes it, wherever focus is in the PRs tab.
 */
export function PrDetailPanel({ pr, all, beneath = [], stages, login, load, revision, watch, onOpen, onClose }: {
  pr: QueuedPullRequest;
  /** Every PR, for its stack. */
  all: readonly QueuedPullRequest[];
  /** R2: other Initiatives' PRs this one's stack sits on. */
  beneath?: readonly QueuedPullRequest[];
  /** The queue's stages, for their labels. */
  stages: readonly StageDefinition[];
  login: string | null;
  load?: LoadDetail;
  /** Changes when the queue is read again. */
  revision: unknown;
  /** W548: the PR's watch control; this Adventure's PRs only, not the unassigned ones. */
  watch?: (pr: QueuedPullRequest) => ReactNode;
  onOpen: (pr: QueuedPullRequest) => void;
  onClose: () => void;
}) {
  const link = usePrLink(pr.url);
  const read = useDetail(load, pr.url, revision);
  const detail = read?.detail ?? null;
  const panel = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // Below the dashboard's sticky header and as tall as the page's scroller leaves, measured as they
  // resize: the tabs wrap, its details open. Set on the element, not in state, so that the opening
  // scroll below already lands below the header. And how far the page goes on below the list (its
  // footer, the page's padding), which the panel's containing block reaches over (pr-map.css).
  useLayoutEffect(() => {
    const aside = panel.current;
    const root = aside?.closest(".cr");
    const header = root?.querySelector(".cr-sticky");
    const grid = aside?.parentElement;
    if (!aside || !root || !header || !grid) return;
    const page = aside.closest(".project-page");
    const measure = () => {
      aside.style.setProperty("--cr-pd-top", `${Math.ceil(header.getBoundingClientRect().height)}px`);
      if (!page) return;
      aside.style.setProperty("--cr-pd-view", `${page.clientHeight}px`);
      const reach = parseFloat(grid.style.getPropertyValue("--cr-pd-below")) || 0;
      const end = page.getBoundingClientRect().top + page.clientTop - page.scrollTop + page.scrollHeight;
      grid.style.setProperty("--cr-pd-below", `${Math.max(0, Math.floor(end - grid.getBoundingClientRect().bottom + reach))}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    // The dashboard: its footer wraps or another line shows below the list.
    observer.observe(root);
    if (page) observer.observe(page);
    return () => {
      observer.disconnect();
      grid.style.removeProperty("--cr-pd-below");
    };
  }, []);
  // Focus moves in when a PR opens and back to where it came from on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    return () => { if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    // Its title first, the whole panel in sight.
    if (body.current) body.current.scrollTop = 0;
    panel.current?.scrollIntoView?.({ block: "nearest" });
  }, [pr.url]);
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      // Only while the PRs tab shows (a hidden tab stays mounted), and after inputs had their say.
      if (event.key !== "Escape" || event.defaultPrevented || !panel.current || panel.current.closest("[hidden]")) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", keys);
    return () => document.removeEventListener("keydown", keys);
  });

  const byNumber = numberIndex([...all, ...beneath]);
  const below = pr.stack?.on != null ? byNumber.get(`${pr.repo}#${pr.stack.on}`) ?? null : null;
  const above = all.filter((p) => p.repo === pr.repo && p.stack?.on === pr.number);
  const blocker = waitsOn(pr, byNumber);
  const stageLabel = (id: string) => stages.find((s) => s.id === id)?.label ?? id;
  return (
    <aside ref={panel} className="cr-pd" aria-label={`Pull request #${pr.number}`}>
      <header className="cr-pd-head">
        <span className="cr-pd-ref">{pr.repo} #{pr.number}</span>
        <a className="cr-pd-gh" {...link}>
          GitHub
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M6 3.5h6.5V10M12.5 3.5l-9 9" /></svg>
        </a>
        <button type="button" className="cr-iconbtn cr-pd-close" aria-label="Close details" title="Close (Esc)" onClick={onClose}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" focusable="false"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      </header>
      <div ref={body} className="cr-pd-body">
        <h3 ref={heading} tabIndex={-1} className="cr-pd-title">{pr.title}</h3>
        <p className="cr-pd-stage">
          <span className="cr-pm-dot" data-stage={pr.stage} data-available={pr.available || undefined} aria-hidden="true" />
          <strong>{stageLabel(pr.stage)}</strong>
          {pr.stageSource === "github" ? <em>guessed from GitHub</em> : pr.stageSetAt ? <span>set <Ago at={pr.stageSetAt} label="Stage set" /> ago</span> : null}
          {pr.category ? <span className="cr-pd-category">{pr.category}</span> : null}
          {pr.available ? <span className="cr-mq-available">review now</span> : blocker ? <span className="cr-mq-waits">waits on #{blocker.number}</span> : null}
        </p>
        {pr.stageNote ? <p className="cr-mq-stage-note">{pr.stageNote}</p> : null}
        <StateLine pr={pr} />

        <section className="cr-pd-section cr-pd-github" aria-label="GitHub">
          <h4>GitHub</h4>
          <dl>
            <dt>State</dt>
            <dd className="cr-mq-signals">open<Signals pr={pr} />{pr.mergeState !== "unknown" && pr.mergeState !== "clean" ? <span className="cr-mq-signal" data-tone="faint">{pr.mergeState}</span> : null}</dd>
            {pr.reasons.length ? <><dt>Why</dt><dd>{pr.reasons.join(", ")}</dd></> : null}
            <dt>Branch</dt>
            <dd className="cr-mq-branch"><code>{pr.head}</code><span aria-label="into">→</span><code>{pr.base}</code></dd>
            {pr.size ? <><dt>Size</dt><dd><span><SizeDelta size={pr.size} /> · {sizeDetail(pr.size)}</span></dd></> : null}
            <dt>Opened</dt>
            <dd><span><Ago at={pr.createdAt} label="Opened" /> ago{login ? <> by {login}</> : null} · updated <Ago at={pr.updatedAt} label="Updated" /> ago</span></dd>
            {pr.reviewers.length ? <><dt>Reviews</dt><dd className="cr-mq-reviewers cr-pd-reviewers">{pr.reviewers.map((r) => <span key={r.login} data-state={r.state} title={reviewerText(r)}>{reviewerText(r)}</span>)}</dd></> : null}
            {pr.stack ? (
              <>
                <dt>Stack</dt>
                <dd className="cr-pd-stack">
                  level {pr.stack.level} of {pr.stack.levels} · {pr.stack.size} PRs
                  {below ? <><span className="cr-pd-label">on</span><PrChip pr={below} onOpen={all.includes(below) ? onOpen : null} /></> : null}
                  {above.length ? <><span className="cr-pd-label">under</span>{above.map((p) => <PrChip key={p.url} pr={p} onOpen={onOpen} />)}</> : null}
                </dd>
              </>
            ) : null}
            {pr.worker ? <><dt>Worker</dt><dd title={workerTitle(pr.worker)}><ThreadLink threadId={pr.worker.threadId}><span className="cr-mq-worker">{workerLabel(pr.worker)}</span></ThreadLink> <span className="cr-pd-label">{workerTitle(pr.worker)}</span></dd></> : null}
          </dl>
        </section>
        {watch && !pr.unassigned ? watch(pr) : null}

        {!load ? null : !read ? <Bones /> : !detail ? (
          <p className="cr-mq-note" role="status">Couldn't read the PR's history: {read.error}</p>
        ) : (
          <>
            {read.error ? <p className="cr-mq-note" role="status">Couldn't refresh: {read.error}</p> : null}
            <StageHistory detail={detail} label={stageLabel} />
            {detail.notes.items.length ? (
              <section className="cr-pd-section cr-pr-notes-panel" aria-label="Notes">
                <h4>Notes<span className="cr-count">{detail.notes.total}</span></h4>
                <LatestNotes detail={detail} />
              </section>
            ) : null}
            <Section title="Work" items={detail.assignments.items} total={detail.assignments.total} empty="No assignment names this PR." render={(a) => (
              <li key={a.ref} className="cr-pd-item">
                <span className="cr-pd-line">
                  <ThreadLink threadId={a.threadId}><span className="cr-ref">{a.ref}</span> <span className="cr-mq-worker">{a.worker}</span></ThreadLink>
                  <span className="cr-pd-status" data-status={a.outcome ?? a.state}>{a.role === "work" ? "" : `${a.role} · `}{a.outcome ?? a.state}</span>
                  <span className="cr-pd-when"><Ago at={a.reportedAt ?? a.createdAt} label={a.reportedAt ? "Reported" : "Assigned"} /></span>
                  <Via via={a.via} />
                </span>
                {a.summary ? <Clamp text={a.summary} /> : null}
              </li>
            )} />
            <Section title="Decisions" items={detail.decisions.items} total={detail.decisions.total} render={(d) => {
              // A title is often the description's first words: then the description alone says it.
              const titled = !d.description.startsWith(d.title.replace(/[…\s]+$/, ""));
              return (
                <li key={d.ref} className="cr-pd-item">
                  <span className="cr-pd-line">
                    <span className="cr-ref">{d.ref}</span>
                    <span className="cr-pd-status" data-status={d.status}>{d.status}{d.madeBy ? ` · ${d.madeBy === "user" ? "you" : "agent"}` : ""}</span>
                    {titled ? <span className="cr-pd-name">{d.title}</span> : null}
                    <span className="cr-pd-when"><Ago at={d.createdAt} label="Recorded" /></span>
                    <Via via={d.via} />
                  </span>
                  {d.description ? <Clamp text={d.description} /> : null}
                </li>
              );
            }} />
            <Section title="Updates" items={detail.updates.items} total={detail.updates.total} shown={3} render={(u) => (
              <li key={u.ref} className="cr-pd-item">
                <span className="cr-pd-line"><span className="cr-ref">{u.ref}</span><span className="cr-pd-when"><Ago at={u.createdAt} label="Posted" /></span></span>
                <Clamp text={u.summary} />
              </li>
            )} />
            {detail.workers.length ? (
              <section className="cr-pd-section" aria-label="Workers">
                <h4>Workers<span className="cr-count">{detail.workers.length}</span></h4>
                <p className="cr-pd-workers">
                  {detail.workers.map((w) => (
                    <ThreadLink key={w.ref} threadId={w.threadId}>
                      <span className="cr-mq-worker" data-state={w.state} title={[w.label, `${w.role} · ${w.state}`, w.model].filter(Boolean).join("\n")}>{w.ref}</span>
                    </ThreadLink>
                  ))}
                </p>
              </section>
            ) : null}
          </>
        )}
      </div>
    </aside>
  );
}

/** A stage's dot and label; `id` null is a cleared stage. */
function StageName({ id, label }: { id: string | null; label: (id: string) => string }) {
  if (!id) return <em className="cr-pd-cleared">no stage</em>;
  return <span className="cr-pd-stage-name"><span className="cr-pm-dot" data-stage={id} aria-hidden="true" />{label(id)}</span>;
}

/**
 * T157: who moved the PR between stages and when, oldest first, the last few
 * shown. A PR staged before the history was kept shows its stage as it stands.
 */
function StageHistory({ detail, label }: { detail: PrDetail; label: (id: string) => string }) {
  const [all, setAll] = useState(false);
  const { items, total } = detail.stages;
  const record = detail.record;
  if (!items.length && !record?.stage) return null;
  const shown = all ? items : items.slice(-STAGES_SHOWN);
  return (
    <section className="cr-pd-section cr-pd-stages" aria-label="Stage history">
      <h4>Stage history{total ? <span className="cr-count">{total}</span> : null}</h4>
      <ol>
        {items.length ? shown.map((change) => (
          <li key={change.n} className="cr-pd-item">
            <span className="cr-pd-line">
              {change.from && change.from !== change.to ? <StageName id={change.from} label={label} /> : null}
              {change.from === change.to ? null : <span className="cr-pd-arrow" aria-label={change.from ? "to" : "set to"}>→</span>}
              <StageName id={change.to} label={label} />
              {change.from === change.to ? <span className="cr-pd-label">new note</span> : null}
              <span className="cr-pd-by">{noteAuthor(change.author)}</span>
              <span className="cr-pd-when"><Ago at={change.at} label="Changed" /></span>
            </span>
            {change.note ? <p className="cr-pd-stage-note">{change.note}</p> : null}
          </li>
        )) : (
          <li className="cr-pd-item" data-current>
            <span className="cr-pd-line">
              <StageName id={record!.stage} label={label} />
              <span className="cr-pd-label">current, set before stage history was kept</span>
              <span className="cr-pd-when"><Ago at={record!.setAt} label="Set" /></span>
            </span>
          </li>
        )}
      </ol>
      {items.length > STAGES_SHOWN ? (
        <button type="button" className="cr-pm-more" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? "Show the latest" : `Show all ${items.length}`}
        </button>
      ) : null}
      {all && total > items.length ? <p className="cr-pd-empty">The newest {items.length} of {total}.</p> : null}
    </section>
  );
}
const STAGES_SHOWN = 5;

/** The last few notes, all of them on demand. */
function LatestNotes({ detail }: { detail: PrDetail }) {
  const [all, setAll] = useState(false);
  const { items, total } = detail.notes;
  const shown = all ? items : items.slice(-NOTES_SHOWN);
  return (
    <>
      <NotesList notes={shown} />
      {items.length > NOTES_SHOWN ? (
        <button type="button" className="cr-pm-more" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? "Show the latest" : `Show all ${items.length}`}
        </button>
      ) : null}
      {all && total > items.length ? <p className="cr-pd-empty">The newest {items.length} of {total}.</p> : null}
    </>
  );
}
const NOTES_SHOWN = 3;
