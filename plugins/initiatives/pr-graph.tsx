import type { MouseEvent } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { QueuedPullRequest, StageDefinition } from "./lib/merge-queue";
import type { PrNote } from "./lib/pr-notes";
import { categoriesOf, compactCount, laneLayout, noteAuthor, sizeDetail, stackLabel, stateItems, workerLabel, type StackDrawing, type StateItem } from "./lib/pr-map";
import { compactAge } from "./control-room";
import { useMoveMenu, type MoveMenu } from "./pr-move-menu";

/**
 * A plain click opens the PR in a tab of BB's built-in browser (or the
 * external browser, per the client's preference); modifier clicks keep the
 * anchor's own behavior.
 */
export function usePrLink(url: string) {
  const navigate = useBbNavigate();
  return {
    href: url,
    target: "_blank",
    rel: "noopener noreferrer",
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (!navigate.openUrl(url)) window.open(url, "_blank", "noopener,noreferrer");
    },
  };
}

/** The nearest PR beneath a ready one that is not ready, which keeps it from being available. */
export function waitsOn(pr: QueuedPullRequest, byNumber: ReadonlyMap<string, QueuedPullRequest>): QueuedPullRequest | null {
  if (pr.available || pr.stage !== "ready-for-erwin") return null;
  for (let below = pr.stack?.on; below != null; ) {
    const next = byNumber.get(`${pr.repo}#${below}`);
    if (!next) return null;
    if (next.stage !== "ready-for-erwin") return next;
    below = next.stack?.on;
  }
  return null;
}

/** Who works on a PR and how we know. */
export function workerTitle(worker: NonNullable<QueuedPullRequest["worker"]>): string {
  if (worker.source === "coordinator") return `${worker.ref} works on it, per the coordinator`;
  if (worker.source === "assignment") return `${worker.assignment}, ${worker.ref}'s latest assignment naming this PR`;
  return `Branch of ${worker.ref}'s thread`;
}

/** A decision's or note's source: a URL or BB thread opens; a ref like D437 is shown as is. */
export function SourceLink({ link }: { link: string }) {
  const navigate = useBbNavigate();
  const url = usePrLink(link);
  if (/^https?:\/\//i.test(link)) return <a className="cr-mq-state-link" {...url}>source</a>;
  if (/^thr_[a-z0-9]+$/i.test(link))
    return <a className="cr-mq-state-link" href="#" onClick={(event) => { event.preventDefault(); navigate.toThread(link); }}>thread</a>;
  return <span className="cr-mq-state-ref">({link})</span>;
}

/** Where a PR stands, in one line under its row: "waiting on W188: … · Erwin asked: …". */
export function StateLine({ pr }: { pr: QueuedPullRequest }) {
  const items = stateItems(pr);
  if (!items.length) return null;
  return (
    <p className="cr-mq-state">
      {items.map((item: StateItem, index) => (
        <span key={index} data-kind={item.kind}>
          {item.text}
          {item.link ? <> <SourceLink link={item.link} /></> : null}
        </span>
      ))}
    </p>
  );
}

/** "W12 · A301 · 2h", what a note says about where it came from; `kind` names questions and comments. */
export function NoteMeta({ note }: { note: PrNote }) {
  return (
    <span className="cr-pr-note-meta">
      <span className="cr-pr-note-author">{noteAuthor(note.author)}</span>
      {note.kind !== "note" ? <span className="cr-pr-note-kind" data-kind={note.kind}>{note.kind}</span> : null}
      {note.link && /^A\d+$/.test(note.link) ? <span>{note.link}</span> : null}
      <time dateTime={new Date(note.at).toISOString()} title={new Date(note.at).toLocaleString()}>{compactAge(note.at)}</time>
    </span>
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


/** Checks, review and mergeability, as tinted words ("12/12 checks · review required · mergeable"), then "draft". */
export function Signals({ pr }: { pr: QueuedPullRequest }) {
  const review = REVIEW[pr.review];
  const icon = pr.checks.state === "none" ? null : CHECK_ICONS[pr.checks.state];
  const signals = [CHECKS[pr.checks.state](pr.checks), ...(review ? [review] : []), MERGEABLE[pr.mergeable]];
  return (
    <>
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
    </>
  );
}

/** Notes, oldest first, each with its number, author, source and any answer. */
export function NotesList({ notes }: { notes: readonly PrNote[] }) {
  return (
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
  );
}

/** "+908 −386", additions green and deletions red; `compact` abbreviates thousands. */
export function SizeDelta({ size, compact = false }: { size: NonNullable<QueuedPullRequest["size"]>; compact?: boolean }) {
  const n = compact ? compactCount : String;
  return (
    <span className="cr-pr-delta" title={`${size.additions} lines added, ${size.deletions} removed · ${sizeDetail(size)}`}>
      <span data-tone="add">+{n(size.additions)}</span>
      <span data-tone="del">−{n(size.deletions)}</span>
    </span>
  );
}

const REVIEWER_STATE: Record<QueuedPullRequest["reviewers"][number]["state"], string> = {
  approved: "approved", changes_requested: "requested changes", commented: "commented", dismissed: "dismissed", requested: "review requested",
};
export const reviewerText = (r: QueuedPullRequest["reviewers"][number]) => `${r.login} ${REVIEWER_STATE[r.state]}`;

export const numberIndex = (prs: readonly QueuedPullRequest[]) => new Map(prs.map((pr) => [`${pr.repo}#${pr.number}`, pr]));

/** Opens a PR's detail panel: on each row and graph node. */
export function DetailsButton({ pr, open, onOpen }: { pr: QueuedPullRequest; open: boolean; onOpen: (pr: QueuedPullRequest) => void }) {
  return (
    <button type="button" className="cr-iconbtn cr-pd-open" aria-label={`Details of #${pr.number}`} aria-pressed={open} title="Details"
      onClick={() => onOpen(pr)}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <rect x="2" y="2.75" width="12" height="10.5" rx="2" />
        <path d="M9.75 2.75v10.5" />
      </svg>
    </button>
  );
}

/** A node's hover card: what the row would say, for a graph that only shows the number and title. */
function Tip({ pr, stage, blocker }: { pr: QueuedPullRequest; stage: string; blocker: QueuedPullRequest | null }) {
  return (
    <div className="cr-pm-tip" role="tooltip">
      <strong>{pr.title}</strong>
      <span className="cr-pm-tip-line">
        <span className="cr-pm-dot" data-stage={pr.stage} aria-hidden="true" />
        {stage}
        {pr.stageSource === "github" ? <em> (guessed)</em> : null}
        {pr.available ? <span className="cr-pm-tip-good"> · review now</span> : blocker ? <> · waits on #{blocker.number}</> : null}
      </span>
      <span className="cr-pm-tip-line cr-pm-tip-meta">
        #{pr.number}
        {pr.stack ? <> · {stackLabel(pr.stack)}</> : null}
        {pr.worker ? <> · {workerLabel(pr.worker)}</> : null}
        {pr.createdAt ? <> · opened {compactAge(pr.createdAt)} ago</> : null}
      </span>
      {pr.size ? (
        <span className="cr-pm-tip-line cr-pm-tip-meta"><SizeDelta size={pr.size} /> · {sizeDetail(pr.size)}{pr.updatedAt ? <> · updated {compactAge(pr.updatedAt)} ago</> : null}</span>
      ) : null}
      <span className="cr-pm-tip-line cr-pm-tip-meta">{pr.reasons.length ? pr.reasons.join(", ") : pr.draft ? "draft" : "checks pass, mergeable"}</span>
      {pr.reviewers.length ? <span className="cr-pm-tip-line cr-pm-tip-meta">{pr.reviewers.map(reviewerText).join(" · ")}</span> : null}
      {pr.stageNote ? <span className="cr-pm-tip-note">{pr.stageNote}</span> : null}
      {stateItems(pr).map((item, index) => (
        <span key={index} className="cr-pm-tip-state" data-kind={item.kind}>
          {item.text}{item.link && !/^(https?:|thr_)/i.test(item.link) ? ` (${item.link})` : ""}
        </span>
      ))}
      {pr.notes.recent.length ? (
        <span className="cr-pm-tip-notes">
          {pr.notes.recent.map((note) => (
            <span key={note.n} className="cr-pm-tip-note-entry"><NoteMeta note={note} /> {note.text}</span>
          ))}
          {pr.notes.count > pr.notes.recent.length ? <span className="cr-pm-tip-meta">{pr.notes.count - pr.notes.recent.length} earlier in the list view</span> : null}
        </span>
      ) : null}
    </div>
  );
}

function Node({ pr, col, label, blocker, open, onOpen, menu }: {
  pr: QueuedPullRequest; col: number; label: string; blocker: QueuedPullRequest | null; open: boolean; onOpen?: (pr: QueuedPullRequest) => void;
  /** R2: its "Move to Initiative" menu, as on a list row. */
  menu: MoveMenu | null;
}) {
  const link = usePrLink(pr.url);
  const { item, anchor, handlers, element } = useMoveMenu(pr, menu, link.onClick);
  return (
    <li ref={item} className="cr-pm-node" data-stage={pr.stage} data-available={pr.available || undefined} data-open={open || undefined}
      data-menu={element ? true : undefined} style={{ paddingLeft: col * INDENT }}>
      <a ref={anchor} {...link} {...handlers} aria-label={`#${pr.number} ${pr.title}, ${label}${pr.available ? ", review now" : ""}${pr.notes.open.length ? ", open questions" : ""}`}>
        <span className="cr-pm-dot" data-stage={pr.stage} aria-hidden="true" />
        <span className="cr-pm-num">#{pr.number}</span>
        <span className="cr-pm-title">{pr.title}</span>
        {pr.notes.open.length ? <span className="cr-pm-ask" aria-hidden="true">?</span> : null}
        {pr.size ? <SizeDelta size={pr.size} compact /> : null}
      </a>
      <Tip pr={pr} stage={label} blocker={blocker} />
      {/* After the card: a focused link shows it as its next sibling. */}
      {onOpen ? <DetailsButton pr={pr} open={open} onOpen={onOpen} /> : null}
      {element}
    </li>
  );
}

// Fixed row geometry, shared by the CSS (.cr-pm-node) and the edges drawn under it.
const ROW = 26;
const INDENT = 14;
/** Center of a node's dot: the link's 6px padding plus half the 9px dot. */
const dotX = (col: number) => col * INDENT + 6 + 4.5;
const dotY = (row: number) => row * ROW + ROW / 2;

/** Base → head edges: straight up a chain, an elbow out where the stack branches. */
function Edges({ drawing }: { drawing: StackDrawing }) {
  const paths = drawing.rows.flatMap((row, index) => {
    if (row.parentRow === null) return [];
    const parent = drawing.rows[row.parentRow]!;
    const x = dotX(parent.col);
    const y0 = dotY(row.parentRow) + 6;
    const y1 = dotY(index);
    return [row.col === parent.col
      ? `M${x} ${y0}V${y1 - 6}`
      : `M${x} ${y0}V${y1 - 6}Q${x} ${y1} ${x + 6} ${y1}H${dotX(row.col) - 6}`];
  });
  return (
    <svg className="cr-pm-edges" width="100%" height={drawing.rows.length * ROW} aria-hidden="true" focusable="false">
      {paths.map((d) => <path key={d} d={d} />)}
    </svg>
  );
}

/**
 * The graph: one lane per category, each stack drawn as a tree from its
 * bottom PR up, the unstacked PRs after them; nodes colored by stage.
 */
export function PrGraph({ pullRequests, all, beneath = [], stages, open = null, onOpen, menuOf }: {
  pullRequests: readonly QueuedPullRequest[];
  /** Every PR, for stack roots and blockers the filters hide. */
  all: readonly QueuedPullRequest[];
  /** R2: other Initiatives' PRs these are stacked on, for the blockers they are. */
  beneath?: readonly QueuedPullRequest[];
  stages: readonly StageDefinition[];
  /** The PR whose detail panel is open, and how a node opens its own. */
  open?: QueuedPullRequest | null;
  onOpen?: (pr: QueuedPullRequest) => void;
  /** R2: each node's "Move to Initiative" menu; none without it. */
  menuOf?: (pr: QueuedPullRequest) => MoveMenu | null;
}) {
  const labels = new Map(stages.map((s) => [s.id, s.label]));
  const byNumber = numberIndex([...all, ...beneath]);
  const categorized = all.some((pr) => pr.category !== null);
  const node = (pr: QueuedPullRequest, col: number) => (
    <Node key={pr.url} pr={pr} col={col} label={labels.get(pr.stage) ?? pr.stage} blocker={waitsOn(pr, byNumber)} open={pr === open} onOpen={onOpen} menu={menuOf?.(pr) ?? null} />
  );
  return (
    <div className="cr-pm-graph">
      {categoriesOf(pullRequests).map(({ category, label, count }) => {
        const lane = laneLayout(pullRequests.filter((pr) => pr.category === category), all);
        return (
          <section key={label} className="cr-pm-lane" aria-label={categorized ? label : "Pull requests"}>
            {categorized ? <h3>{label}<span className="cr-count">{count}</span></h3> : null}
            <div className="cr-pm-stacks">
              {lane.stacks.map((drawing) => (
                <div key={drawing.rows[0]!.pr.url} className="cr-pm-stack">
                  {drawing.on !== null ? <p className="cr-pm-on">on #{drawing.on}</p> : null}
                  <ol aria-label={`Stack from #${drawing.rows[0]!.pr.number}`}>
                    <Edges drawing={drawing} />
                    {drawing.rows.map((row) => node(row.pr, row.col))}
                  </ol>
                </div>
              ))}
              {lane.singles.length ? (
                <ul className="cr-pm-singles" aria-label="Not stacked">{lane.singles.map((pr) => node(pr, 0))}</ul>
              ) : null}
            </div>
          </section>
        );
      })}
    </div>
  );
}
