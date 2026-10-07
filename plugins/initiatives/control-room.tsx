import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import type { BlockerItem, Overview, OpinionItem } from "./lib/overview";
import { needsYouCount } from "./lib/blockers";
import type { DecisionRecord } from "./lib/store";
import type { Command } from "./lib/commands";
import type { projectsContract } from "./lib/contract";
import { UsagePage } from "./usage-view";
import "./control-room.css";

type Tab = "inbox" | "decisions" | "threads" | "tasks" | "prs" | "context" | "usage" | "log";
type Inventory = typeof projectsContract.inventory.output._output;
type Run = (command: Command) => Promise<unknown>;
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
export const compactAge = (at: number) => {
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 60000));
  return minutes < 1
    ? "now"
    : minutes < 60
      ? `${minutes}m`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h`
        : `${Math.floor(minutes / 1440)}d`;
};
function Age({ at }: { at: number | null | undefined }) {
  return at == null ? null : (
    <time
      className="cr-age"
      dateTime={new Date(at).toISOString()}
      title={new Date(at).toLocaleString()}
    >
      {compactAge(at)}
    </time>
  );
}
export const AutoTextarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function AutoTextarea(props, forwardedRef) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(forwardedRef, () => ref.current!, []);
  useLayoutEffect(() => {
    const el = ref.current!;
    const grow = () => {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight + 2}px`;
    };
    grow();
    if (typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (width !== el.clientWidth) {
        width = el.clientWidth;
        grow();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [props.value]);
  return <textarea {...props} ref={ref} />;
});
// Accepted prototype stroke shapes, with no prototype state or fixture imports.
const glyphs = {
  replace:
    "M4 12a8 8 0 0 1 13.7-5.6L20 8.7M20 4v4.7h-4.7M20 12a8 8 0 0 1-13.7 5.6L4 15.3M4 20v-4.7h4.7",
  menu: "M5 12h.01M12 12h.01M19 12h.01",
  down: "M6 9l6 6 6-6",
  close: "M6 6l12 12M18 6L6 18",
  context: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4",
  log: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  usage: "M5 20V11M12 20V4M19 20v-6",
  pr: "M6 3.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5zM6 15.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5zM6 8.5v7M18 15.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5zM18 15.5V9a3 3 0 0 0-3-3h-3M14.5 3.5 12 6l2.5 2.5",
};
function Glyph({ name }: { name: keyof typeof glyphs }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={glyphs[name]} />
    </svg>
  );
}
/** T136: a worker's final message is its report; long ones open on demand. */
function FinalMessage({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 600;
  return (
    <div className="cr-final-message">
      <p className="cr-final-message-text">{open || !long ? text : `${text.slice(0, 600).trimEnd()}…`}</p>
      {long ? <button type="button" className="cr-link" onClick={() => setOpen(!open)}>{open ? "Show less" : "Show the whole report"}</button> : null}
    </div>
  );
}

function Fold({
  title,
  meta,
  children,
  initial = false,
  group,
}: {
  title: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  initial?: boolean;
  group?: string;
}) {
  return (
    <details className="cr-fold" name={group} open={initial || undefined}>
      <summary>
        <span className="cr-fold-title">{title}</span>
        <span className="cr-fold-meta">{meta}</span>
      </summary>
      <div className="cr-detail">{children}</div>
    </details>
  );
}
function Action({
  run,
  command,
  children,
  className,
  title,
  refusal,
}: {
  run: Run;
  command: Command;
  children: ReactNode;
  className?: string;
  title?: string;
  /** Reads a refusal the service answers without throwing, shown like an error. */
  refusal?: (result: unknown) => string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        className={className}
        title={title}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const result = await run(command);
            const refused = refusal?.(result) ?? null;
            if (refused) setError(refused);
          } catch (e) {
            setError(message(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Saving…" : children}
      </button>
      {error ? (
        <p role="alert" className="project-error">
          {error}
        </p>
      ) : null}
    </>
  );
}
function ReasonAction({
  label,
  make,
  run,
  needsReason = true,
}: {
  label: string;
  make: (reason: string) => Command;
  run: Run;
  needsReason?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <div className="cr-reason">
      {open ? (
        <>
          {needsReason ? (
            <label className="project-field">
              Reason for {label.toLowerCase()}
              <AutoTextarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={2000}
              />
            </label>
          ) : (
            <p>Confirm {label.toLowerCase()}?</p>
          )}
          <div className="project-actions">
            {!needsReason || reason.trim() ? (
              <Action command={make(reason.trim())} run={run}>
                Confirm {label.toLowerCase()}
              </Action>
            ) : (
              <button disabled>Confirm {label.toLowerCase()}</button>
            )}
            <button onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </>
      ) : (
        <button onClick={() => setOpen(true)}>{label}</button>
      )}
    </div>
  );
}
// Secondary views carry a glyph used only once the narrowest strip needs room.
const tabSpecs = [
  ["inbox", "Inbox", null],
  ["decisions", "Decisions", null],
  ["threads", "Threads", null],
  ["tasks", "Tasks", null],
  ["prs", "PRs", "pr"],
  ["context", "Context", "context"],
  ["log", "Log", "log"],
  ["usage", "Usage", "usage"],
] as const;
const TAB_LEVELS = 3;
function Tabs({
  tab,
  change,
  counts,
  urgent,
  prefix,
  specs,
}: {
  specs: readonly (typeof tabSpecs)[number][];
  tab: Tab;
  change: (tab: Tab) => void;
  counts: Partial<Record<Tab, number>>;
  urgent: boolean;
  prefix: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(0);
  const [width, setWidth] = useState(0);
  const learned = useRef<number[]>([]);
  const content = JSON.stringify([counts, urgent]);
  useEffect(() => {
    learned.current = [];
    setFit(0);
  }, [content]);
  useLayoutEffect(() => {
    const el = ref.current!;
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const el = ref.current!;
    if (!el.clientWidth) return;
    const last = el.lastElementChild!;
    const used =
      last.getBoundingClientRect().right - el.getBoundingClientRect().left + 8;
    if (used + 8 > el.clientWidth) {
      learned.current[fit] = used;
      if (fit < TAB_LEVELS) setFit(fit + 1);
    } else if (
      fit > 0 &&
      (learned.current[fit - 1] ?? Infinity) + 8 <= el.clientWidth
    )
      setFit(fit - 1);
  }, [fit, width, content]);
  useEffect(() => {
    if (fit === TAB_LEVELS)
      ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [fit, tab]);
  return (
    <div
      ref={ref}
      className="cr-tabs"
      role="tablist"
      aria-label="Initiative views"
      data-fit={fit}
    >
      {specs.map(([id, label, icon], index) => (
        <button
          key={id}
          role="tab"
          id={`${prefix}-${id}`}
          aria-controls={`${prefix}-panel-${id}`}
          aria-selected={id === tab}
          tabIndex={id === tab ? 0 : -1}
          onClick={() => change(id)}
          onKeyDown={(e) => {
            const next =
              e.key === "ArrowRight"
                ? index + 1
                : e.key === "ArrowLeft"
                  ? index - 1
                  : e.key === "Home"
                    ? 0
                    : e.key === "End"
                      ? specs.length - 1
                      : null;
            if (next === null) return;
            e.preventDefault();
            const target = (next + specs.length) % specs.length;
            change(specs[target]![0]);
            (ref.current!.children[target] as HTMLButtonElement).focus();
          }}
        >
          {icon ? (
            <span className="cr-tab-icon" title={label}>
              <Glyph name={icon} />
            </span>
          ) : null}
          <span className="cr-tab-label">{label}</span>
          {counts[id] ? (
            <span
              className={`cr-count${id === "inbox" && urgent ? " cr-count--hot" : ""}`}
            >
              {counts[id]}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

export function ControlRoom({
  overview: o,
  inventory,
  run,
  openThread,
  newThread,
  refresh,
  notice,
  renderOpinion,
  renderReplacement,
  renderContext,
  newTask,
  onTab,
  detailNotice,
  readHandoff,
  mergeQueue,
}: {
  /** The merge queue tab: its open PR count and its view. */
  mergeQueue?: { count: number; view: ReactNode };
  /** The standard handoff text of a reported assignment, rendered from its stored report. */
  readHandoff?: (ref: string) => Promise<string | null>;
  onTab?: (tab: Tab) => void;
  detailNotice?: string | null;
  overview: Overview;
  inventory: Inventory;
  run: Run;
  openThread: (threadId: string) => void;
  newThread: () => void;
  refresh: () => Promise<void>;
  notice?: ReactNode;
  renderOpinion: (item: OpinionItem) => ReactNode;
  renderReplacement: (close: () => void) => ReactNode;
  renderContext: (close: () => void) => ReactNode;
  newTask: ReactNode;
}) {
  const [tab, setTab] = useState<Tab>("inbox");
  const acceptDecisions = useAcceptAgentDecisions(o, run);
  const chooseTab = (value: Tab) => { setTab(value); onTab?.(value); };
  const [replace, setReplace] = useState(false);
  const [menu, setMenu] = useState(false);
  const [coordinatorDetail, setCoordinatorDetail] = useState(false);
  const [editing, setEditing] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenu(false);
        setReplace(false);
      }
    };
    const outside = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node))
        setMenu(false);
    };
    document.addEventListener("keydown", keys);
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("keydown", keys);
      document.removeEventListener("pointerdown", outside);
    };
  }, []);
  const prefix = useId();
  const p = o.project;
  const active = ["active", "starting", "stopping"].includes(
    p.coordinatorStatus,
  );
  const cState = `${p.coordinatorStatus}${p.paused ? "; Initiative paused" : ""}`;
  // Open questions and blocked reports wait on the user: shown before anything else.
  const needsYou = needsYouCount(o);
  const unchecked = [...o.decisions].reverse().filter(pendingReview);
  // A dismissal leaves the Inbox, unless telling the coordinator did not go
  // through; so does an answered blocker once its card is gone (T132).
  const undeliveredState = (r: Receipt) => r?.state === "failed" || r?.state === "uncertain";
  const carded = new Set(o.blockers.flatMap(b => b.answer ? [b.answer.ref] : []));
  const undelivered = o.decisions.filter(d =>
    d.dismissal?.notify && !d.dismissal.undoneAt && undeliveredState(d.notification) ||
    d.blockerAnswer && !carded.has(d.ref) && (undeliveredState(d.notification) || undeliveredState(d.blockerAnswer.delivery)));
  // Messages BB is holding for members with nothing running to deliver them (T133).
  const held = o.notDelivered ?? [];
  // A report's own row replaces the remaining row of the task it awaits.
  const reported = new Set(o.awaitingAcceptance.flatMap((a) => a.tasks.map((t) => t.ref)));
  const remaining = o.remaining.filter((t) => !(t.status === "awaiting_acceptance" && reported.has(t.ref)));
  return (
    <div className="cr" data-component="ControlRoom">
      <div className="cr-sticky">
        <div className="cr-head">
          <span className="cr-mark" aria-hidden="true">{p.name.slice(0, 2).toLowerCase()}</span>
          <strong className="cr-head-name">{p.name}</strong>
          {needsYou ? (
            <button type="button" className="cr-needs-you" onClick={() => chooseTab("inbox")}>
              Needs you · {needsYou}
            </button>
          ) : null}
          <div className="cr-menu-wrap" ref={menuRef}>
            <button
              className="cr-iconbtn"
              aria-label="Initiative menu"
              aria-expanded={menu}
              onClick={() => setMenu(!menu)}
            >
              <Glyph name="menu" />
            </button>
            {menu ? (
              <div
                className="cr-menu"
                role="group"
                aria-label="Initiative controls"
              >
                <Action
                  run={run}
                  command={{ action: "pause", paused: !p.paused }}
                >
                  {p.paused ? "Resume" : "Pause"}
                </Action>
                <button
                  onClick={() => {
                    chooseTab("context");
                    setEditing(true);
                    setMenu(false);
                  }}
                >
                  Edit initiative
                </button>
                <button
                  onClick={() => {
                    chooseTab("context");
                    setMenu(false);
                  }}
                >
                  Repositories
                </button>
                <button
                  onClick={() => {
                    void refresh();
                    setMenu(false);
                  }}
                >
                  Refresh
                </button>
                <ReasonAction
                  label="Stop initiative work"
                  make={(reason) => ({ action: "stop-work", reason })}
                  run={run}
                />
                <ReasonAction
                  label="Archive initiative"
                  needsReason={false}
                  make={() => ({ action: "archive" })}
                  run={run}
                />
              </div>
            ) : null}
          </div>
        </div>
        <div className={`cr-coordinator${["error", "failed", "missing", "deleted"].includes(p.coordinatorStatus) ? " cr-coordinator--error" : ""}`}>
        <div className="cr-coordinator-row">
          <button
            className="cr-coordinator-title"
            aria-label={`Coordinator: ${cState}. Open thread`}
            title={`Coordinator ${cState}`}
            onClick={() => p.coordinatorThreadId && openThread(p.coordinatorThreadId)}
          >
            <span
              className={`project-dot project-dot--${active ? "live" : ["error", "failed", "missing", "deleted"].includes(p.coordinatorStatus) ? "attention" : "muted"}`}
            />
            <strong>Coordinator</strong>
          </button>
          <button className="cr-iconbtn cr-caret" aria-label="Coordinator details" aria-expanded={coordinatorDetail} onClick={() => setCoordinatorDetail(!coordinatorDetail)}><Glyph name="down" /></button>
          <button
            className={`cr-iconbtn cr-replace${["error", "failed"].includes(p.coordinatorStatus) ? " cr-replace--error" : ""}`}
            aria-label="Replace coordinator"
            title="Replace coordinator"
            aria-expanded={replace}
            onClick={() => {
              setReplace(!replace);
              setMenu(false);
            }}
          >
            <Glyph name="replace" />
          </button>

        </div>
        <p className="cr-coordinator-meta" title={p.coordinatorHome?.path ?? undefined}>
          {p.coordinatorProfile ?? "Profile unavailable"}{p.coordinatorHome?.path ? ` · ${p.coordinatorHome.path.split("/").filter(Boolean).at(-1)}` : ""}
        </p>
        </div>
        {coordinatorDetail ? (
          <div className="cr-coordinator-detail">
            <p>
              G{p.coordinatorGeneration} · {cState}
            </p>
            {p.coordinatorThreadId ? (
              <button onClick={() => openThread(p.coordinatorThreadId!)}>
                Open coordinator thread
              </button>
            ) : null}
            {p.coordinatorHome ? (
              <p className="project-meta">
                {p.coordinatorHome.name} ·{" "}
                {p.coordinatorHome.hostId ?? "host unknown"}
                <br />
                <code>{p.coordinatorHome.path ?? "Path unknown"}</code>
                {p.coordinatorHome.mismatch ? (
                  <>
                    <br />
                    {p.coordinatorHome.mismatch}
                  </>
                ) : null}
              </p>
            ) : null}
            <p className="project-meta">
              Stop a running turn with BB's native Stop control in its thread.
            </p>
          </div>
        ) : null}
        <div hidden={replace}>
          <Tabs
            specs={mergeQueue ? tabSpecs : tabSpecs.filter(([id]) => id !== "prs")}
            tab={tab}
            change={chooseTab}
            prefix={prefix}
            counts={{ inbox: o.opinionNeeded.length + o.blockers.length + unchecked.length, prs: mergeQueue?.count }}
            urgent={needsYou > 0}
          />
        </div>
      </div>
      <div className="cr-body">
        {notice}
        {p.paused ? (
          <p className="project-note">
            Paused. New assignments and queued handovers are held; running turns
            can finish.
          </p>
        ) : null}
        {p.handoverDraft?.startsReplacement && !p.coordinatorHandover ? (
          <div className="cr-handover" role="status">
            <p>
              {p.handoverDraft.state === "ready" ? "Handover ready" : "Writing the handover"} · GPT-6 Luna High{" "}
              <Age at={p.handoverDraft.updatedAt} />
            </p>
            <p className="project-muted">The new coordinator starts as soon as it is ready.</p>
            <div className="project-actions">
              <Action run={run} command={{ action: "handover-draft-discard" }}>
                Cancel
              </Action>
            </div>
          </div>
        ) : null}
        {p.coordinatorHandover ? (
          <div className="cr-handover" role="status">
            <p>
              {p.coordinatorHandover.state === "pending"
                ? "Queued handover"
                : "Handover failed"}{" "}
              · {p.coordinatorHandover.reason}{" "}
              <Age at={p.coordinatorHandover.requestedAt} />
            </p>
            <p className="project-muted">
              {p.coordinatorHandover.detail ??
                "Starts when the current coordinator's turn ends naturally."}
            </p>
            <div className="project-actions">
              <Action
                run={run}
                command={{ action: "coordinator-handover", cancel: true }}
                refusal={(result) => {
                  // A withdrawal that could not happen (spawn in flight, start unconfirmed) says why.
                  const r = result as { state?: string; note?: string } | null;
                  return r?.state === "pending" && r.note ? r.note : null;
                }}
              >
                {p.coordinatorHandover.state === "pending"
                  ? "Withdraw"
                  : "Dismiss"}
              </Action>
              {p.coordinatorHandover.state === "failed" ? (
                <button onClick={() => setReplace(true)}>
                  Retry replacement
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        {p.coordinatorStart &&
        ["pending", "uncertain", "failed"].includes(
          p.coordinatorStart.state,
        ) ? (
          <p className="project-note">
            {p.coordinatorStart.checkoutPending
              ? "New coordinator started. Confirming its checkout; this settles on its own."
              : <>
                  Coordinator start {p.coordinatorStart.state}.{" "}
                  {p.coordinatorStart.state === "failed"
                    ? "Use Replace to retry."
                    : "Inspect native threads before settling this start; do not duplicate it."}
                </>}
          </p>
        ) : null}
        {p.formerCoordinators.some((f) => f.live && !f.live.archived) ? (
          <Fold title="Coordinator transfer details">
            {p.formerCoordinators
              .filter((f) => f.live && !f.live.archived)
              .map((f) => (
                <p key={f.threadId}>
                  Predecessor remains {f.live!.status}; transfer/archive is not
                  yet confirmed.{" "}
                  {f.holdReason ? <>Stays live: {f.holdReason} </> : null}
                  <button onClick={() => openThread(f.threadId)}>
                    Inspect predecessor
                  </button>
                </p>
              ))}
            <p className="project-meta">
              BB confirms every member transfer before archiving a predecessor.
              Pending transfers retry through the existing reconciliation
              process.
            </p>
          </Fold>
        ) : null}
        {replace ? (
          <div className="cr-sheet">
            <div className="cr-sheet-head">
              <h2>
                Replace{" "}
                <span className="cr-gen">G{p.coordinatorGeneration}</span> →{" "}
                <span className="cr-gen">G{p.coordinatorGeneration + 1}</span>
              </h2>
              <button
                className="cr-iconbtn"
                aria-label="Close replacement"
                onClick={() => setReplace(false)}
              >
                <Glyph name="close" />
              </button>
            </div>
            {renderReplacement(() => setReplace(false))}
            <p className="project-meta">
              Every recorded member moves, including user-owned threads; nested
              threads keep their parent. Running turns continue. Archive is
              claimed only after BB confirms every transfer.
            </p>
          </div>
        ) : null}
        <div
          hidden={replace}
          role="tabpanel"
          id={`${prefix}-panel-${tab}`}
          aria-labelledby={`${prefix}-${tab}`}
        >
          <KeepTab current={tab} id="inbox">
            <div className="cr-inbox">
              {o.opinionNeeded.length ? (
                <section aria-label="Needs your input" onKeyDown={moveBetweenFolds}>
                  {o.opinionNeeded.map((item, index) => (
                    <Fold group={`${prefix}-inbox`}
                      key={item.ref}
                      title={
                        <>
                          <span className="cr-kind" aria-hidden="true">?</span>
                          {item.title}
                        </>
                      }
                      meta={<span className="cr-inbox-meta">{item.ref} · <Age at={item.askedAt} />{item.blocks.length ? ` · blocks ${item.blocks.map(t => t.ref).join(", ")}` : ""}</span>}
                      initial={index === 0}
                    >
                      {renderOpinion(item)}
                    </Fold>
                  ))}
                </section>
              ) : null}
              {o.blockers.length ? (
                <section aria-label="Blocked workers" onKeyDown={moveBetweenFolds}>
                  {o.blockers.map((item, index) => (
                    <Fold group={`${prefix}-inbox`}
                      key={item.assignment}
                      title={
                        <>
                          <span className="cr-kind" aria-hidden="true">!</span>
                          {item.owner.label} is blocked
                        </>
                      }
                      meta={<span className="cr-inbox-meta">{item.owner.threadId ? (
                        // A link inside the summary: it opens the worker without toggling the fold.
                        <a className="cr-worker-link" href="#" title={`Open ${item.owner.worker}'s thread`}
                          onClick={(event) => { event.preventDefault(); event.stopPropagation(); openThread(item.owner.threadId!); }}
                          onKeyDown={(event) => { if (event.key === " ") { event.preventDefault(); event.stopPropagation(); openThread(item.owner.threadId!); } }}>{item.owner.worker}</a>
                      ) : item.owner.worker} · {item.assignment}{item.tasks.length ? ` · ${item.tasks.map(t => t.ref).join(", ")}` : ""} · <Age at={item.reportedAt} />{item.answer ? " · answered" : ""}</span>}
                      initial={!o.opinionNeeded.length && index === 0}
                    >
                      <Blocker item={item} run={run} coordinatorThreadId={p.coordinatorThreadId} />
                    </Fold>
                  ))}
                </section>
              ) : null}
              {undelivered.length || held.length ? <section aria-label="Not delivered">
                <h2 className="cr-section-heading">Not delivered</h2>
                {undelivered.map(d => <DecisionItem key={d.ref} d={d} run={run} />)}
                {held.map(m => <HeldMessage key={m.id} m={m} run={run} openThread={openThread} />)}
              </section> : null}
              {unchecked.length || acceptDecisions.eligible ? <section aria-label="Agent decisions to check">
                <div className="cr-inbox-decision-head">
                  <h2 className="cr-section-heading">Agent decisions to check</h2>
                  <AcceptAgentDecisions state={acceptDecisions} />
                </div>
                {unchecked.map(d => <DecisionItem key={d.ref} d={d} run={run} />)}
              </section> : null}
              {!o.opinionNeeded.length && !o.blockers.length && !unchecked.length && !undelivered.length && !held.length ? (
                <p className="cr-empty">You’re up to date.</p>
              ) : null}
            </div>
          </KeepTab>
          <KeepTab current={tab} id="decisions">
            <Decisions o={o} run={run} acceptDecisions={acceptDecisions} />
          </KeepTab>
          {detailNotice && ["threads", "usage", "log"].includes(tab) ? <p role="status" className="project-muted">{detailNotice}</p> : null}
          <KeepTab current={tab} id="threads">
            <Threads
              o={o}
              inventory={inventory}
              run={run}
              readHandoff={readHandoff}
              openThread={openThread}
              newThread={newThread}
            />
          </KeepTab>
          <KeepTab current={tab} id="tasks">
            <>
              {newTask}
              <section aria-label="In flight">
                {o.inFlight.map((a) => (
                  <Fold
                    key={a.assignment}
                    title={
                      <>
                        <span className="cr-ref">
                          {a.tasks.map((t) => t.ref).join(", ")}
                        </span>
                        {a.tasks.map((t) => t.title).join(" · ") || a.outcome}
                      </>
                    }
                    meta={
                      <span className="cr-row-meta">
                        <span className="cr-task-owner">{a.owner.worker}</span>
                        <Age at={a.since} />
                        <span
                          className="cr-task-state"
                          title={a.state.replaceAll("_", " ")}
                        >
                          {a.threadBusy
                            ? "working"
                            : a.state === "idle_no_report"
                              ? "idle"
                              : a.state}
                        </span>
                      </span>
                    }
                  >
                    <p>{a.outcome}</p>
                    <p className="project-muted">
                      {a.owner.worker} · {a.state.replaceAll("_", " ")}
                      {a.threadBusy ? " · working" : ""}
                    </p>
                    {a.checkpoint ? <p className="project-meta" title={`Recorded by the coordinator from ${a.owner.worker}`}>Coordinator checkpoint</p> : null}
                    <p>{a.progress}</p>
                    <p>Next: {a.nextCheckpoint}</p>
                    {a.warnings.map((w) => (
                      <p key={w} className="project-note">
                        {w}
                      </p>
                    ))}
                    {a.owner.threadId ? (
                      <button onClick={() => openThread(a.owner.threadId!)}>
                        Open work thread
                      </button>
                    ) : null}
                    <ReasonAction
                      label="Cancel assignment"
                      run={run}
                      make={(reason) => ({
                        action: "assignment-stop",
                        assignment: a.assignment,
                        reason,
                      })}
                    />
                  </Fold>
                ))}
              </section>
              <section aria-label="Reported">
                {o.awaitingAcceptance.map((a) => (
                  <Fold
                    key={a.assignment}
                    title={
                      <>
                        <span className="cr-ref">{a.tasks.map((t) => t.ref).join(", ")}</span>
                        {a.tasks.map((t) => t.title).join(" · ") || a.owner.label}
                      </>
                    }
                    meta={
                      <span className="cr-row-meta">
                        <span className="cr-task-owner">{a.owner.worker}</span>
                        <Age at={a.reportedAt} />
                        <span className={`cr-task-state${a.outcome === "succeeded" ? "" : " cr-task-state--warn"}`} title={`Report ${a.assignment} · ${a.outcome}`}>
                          {a.outcome === "succeeded" ? "reported" : a.outcome}
                        </span>
                      </span>
                    }
                  >
                    {a.checkpoint ? <p className="project-meta" title={`Recorded by the coordinator from ${a.owner.worker}`}>Coordinator checkpoint</p> : null}
                    <p>{a.summary}</p>
                    {a.finalMessage && a.finalMessage !== a.summary ? <FinalMessage text={a.finalMessage} /> : null}
                    <p className="project-meta">
                      {a.owner.worker} · {a.assignment} · {a.outcome === "succeeded" ? "done" : a.outcome}
                    </p>
                    {a.owner.threadId ? (
                      <button onClick={() => openThread(a.owner.threadId!)}>
                        Open report thread
                      </button>
                    ) : null}
                    <div className="project-actions">
                      {a.role === "work"
                        ? a.tasks.map((t) => (
                            <Action key={t.ref} run={run} command={{ action: "task-close", task: t.ref, outcome: "done" }}>
                              Close {t.ref}
                            </Action>
                          ))
                        : null}
                      <ReasonAction
                        label={`Retire ${a.owner.worker}`}
                        run={run}
                        make={(reason) => ({ action: "worker-retire", worker: a.owner.worker, reason })}
                      />
                    </div>
                  </Fold>
                ))}
              </section>
              <section aria-label="Remaining">
                {remaining.map((t) => (
                  <Fold
                    key={t.ref}
                    title={
                      <>
                        <span className="cr-ref">{t.ref}</span>
                        {t.title}
                      </>
                    }
                    meta={
                      <span className="cr-row-meta">
                        <Age at={t.updatedAt} />
                        <span
                          className="cr-task-state"
                          title={t.status.replaceAll("_", " ")}
                        >
                          {t.status === "awaiting_acceptance"
                            ? "reported"
                            : t.status === "in_progress"
                              ? "working"
                              : t.status}
                        </span>
                        <span
                          className="cr-priority"
                          title={`Priority ${t.priority}`}
                        >
                          P{t.priority}
                        </span>
                      </span>
                    }
                  >
                    <p className="project-meta">
                      {t.status.replaceAll("_", " ")}
                    </p>
                    <p>{t.summary}</p>
                    <p>{t.why}</p>
                    <TaskEdit task={t} run={run} />
                    <Action run={run} command={{ action: "task-close", task: t.ref, outcome: "done" }}>
                      Close as done
                    </Action>
                    <ReasonAction
                      label="Cancel task"
                      run={run}
                      make={(reason) => ({
                        action: "task-cancel",
                        task: t.ref,
                        reason,
                      })}
                    />
                  </Fold>
                ))}
              </section>
              {!remaining.length && !o.inFlight.length && !o.awaitingAcceptance.length ? (
                <p className="cr-empty">No remaining work.</p>
              ) : null}
            </>
          </KeepTab>
          {mergeQueue ? <KeepTab current={tab} id="prs">{mergeQueue.view}</KeepTab> : null}
          <KeepTab current={tab} id="context">
            <>
              <div className="cr-toolbar">
                <span className="cr-age" title="Initiative last updated"><Age at={p.updatedAt} /></span>
                <button
                  onClick={() => setEditing(!editing)}
                  aria-expanded={editing}
                >
                  Edit
                </button>
              </div>
              {editing ? (
                renderContext(() => setEditing(false))
              ) : (
                <div className="cr-context-notes">
                  <h3>Purpose</h3>
                  <Markdown content={p.objective} />
                  {p.context.vision ? (
                    <>
                      <h3>Vision</h3>
                      <Markdown content={p.context.vision} />
                    </>
                  ) : null}
                  {(["objectives", "ideas"] as const).map((key) =>
                    p.context[key].length ? (
                      <div key={key}>
                        <h3>{key === "ideas" ? "Ideas" : "Objectives"}</h3>
                        <ul>
                          {p.context[key].map((text, index) => (
                            <li key={index}>{text}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null,
                  )}
                </div>
              )}
              <Repositories o={o} inventory={inventory} run={run} />
            </>
          </KeepTab>
          <KeepTab current={tab} id="usage">
            {o.detailsLoaded === false ? <p className="project-muted">Loading usage…</p> : <UsagePage usage={o.usage} openThread={openThread} />}
          </KeepTab>
          <KeepTab current={tab} id="log">
            <>
              <h2 className="cr-section-heading">Updates</h2>
              {o.updates.length ? (
                o.updates.map((u) => (
                  <Fold
                    key={u.ref}
                    title={u.summary}
                    meta={<Age at={u.createdAt} />}
                  >
                    <Markdown content={u.body} />
                  </Fold>
                ))
              ) : (
                <p className="cr-empty">No explicit updates recorded.</p>
              )}
              <UpdateForm run={run} />
              <h2 className="cr-section-heading">Recent activity</h2>
              {o.activity.map((a, index) => (
                <div key={index} className="cr-activity">
                  <Age at={a.at} />
                  <span>{a.summary}</span>
                </div>
              ))}
              <h2 className="cr-section-heading">Coordinator history</h2>
              {o.usage.coordinator.generations.map((g) => (
                <Fold
                  key={g.threadId}
                  title={
                    <>
                      <span className="cr-gen">G{g.generation ?? "?"}</span>
                      Coordinator
                    </>
                  }
                >
                  <button onClick={() => openThread(g.threadId)}>
                    Open coordinator generation
                  </button>
                  <p className="project-meta">
                    {g.threadId === p.coordinatorThreadId
                      ? "Current"
                      : "Former"}{" "}
                    · {g.runtime}
                  </p>
                  <p>
                    {
                      p.formerCoordinators.find(
                        (f) => f.threadId === g.threadId,
                      )?.reason
                    }
                  </p>
                </Fold>
              ))}
              <h2 className="cr-section-heading">Completed tasks</h2>
              {o.historyLoaded === false ? <p className="project-muted">Loading completed tasks…</p> : null}
              {o.done.map((t) => (
                <Fold
                  key={t.ref}
                  title={
                    <>
                      <span className="cr-ref">{t.ref}</span>
                      {t.title}
                    </>
                  }
                  meta={<Age at={t.updatedAt} />}
                >
                  <p>{t.result ?? "Result not recorded."}</p>
                  <ReasonAction
                    label="Reopen task"
                    run={run}
                    make={(reason) => ({
                      action: "task-reopen",
                      task: t.ref,
                      reason,
                    })}
                  />
                </Fold>
              ))}
            </>
          </KeepTab>
        </div>
      </div>
    </div>
  );
}

/** Lazy tabs remain mounted once opened, preserving drafts and detail state. */
function KeepTab({
  current,
  id,
  children,
}: {
  current: Tab;
  id: Tab;
  children: ReactNode;
}) {
  const seen = useRef(false);
  if (current === id) seen.current = true;
  return seen.current ? <div hidden={current !== id}>{children}</div> : null;
}

// Presentation only: retained accounting records remain in Usage.
function currentThread(
  t: Overview["memberThreads"][number],
  coordinator: string | null,
) {
  return (
    t.nativeStatus !== "deleted" &&
    (t.threadId === coordinator ||
      (!t.retained && t.nativeStatus !== "archived"))
  );
}
function historicalThread(
  t: Overview["memberThreads"][number],
  coordinator: string | null,
) {
  return (
    t.threadId !== coordinator &&
    t.nativeStatus !== "deleted" &&
    (t.retained || t.nativeStatus === "archived")
  );
}

/**
 * A worker's latest report is its standard handoff. Copy the text to read or share it,
 * or the delegate field that embeds it in fresh work; neither changes any record.
 */
function HandoffActions({ assignment, readHandoff }: { assignment: string; readHandoff?: (ref: string) => Promise<string | null> }) {
  const [status, setStatus] = useState<string | null>(null);
  const copy = async (what: "text" | "field") => {
    try {
      const text = what === "field" ? `"handoffs":["${assignment}"]` : await readHandoff!(assignment);
      if (!text) { setStatus(`${assignment} has no stored report.`); return; }
      await navigator.clipboard.writeText(text);
      setStatus(what === "field" ? `Copied the delegate field for ${assignment}.` : `Copied ${assignment}'s handoff.`);
    } catch (error) {
      setStatus(`Could not copy: ${message(error)}`);
    }
  };
  return (
    <div className="cr-handoff">
      <p className="project-meta">Latest handoff: {assignment}. Later related work can start a fresh worker with it.</p>
      <div className="project-actions">
        {readHandoff ? <button onClick={() => void copy("text")}>Copy handoff</button> : null}
        <button onClick={() => void copy("field")}>Copy delegate field</button>
      </div>
      {status ? <p role="status" className="project-meta">{status}</p> : null}
    </div>
  );
}

function Threads({
  o,
  inventory,
  run,
  readHandoff,
  openThread,
  newThread,
}: {
  o: Overview;
  inventory: Inventory;
  run: Run;
  readHandoff?: (ref: string) => Promise<string | null>;
  openThread: (id: string) => void;
  newThread: () => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [retained, setRetained] = useState(false);
  const visible = o.memberThreads.filter((t) =>
    currentThread(t, o.project.coordinatorThreadId),
  );
  const knownIds = new Set(visible.map((t) => t.threadId));
  const root = o.project.coordinatorThreadId;
  const visited = new Set<string>();
  const rows: { thread: Overview["memberThreads"][number]; depth: number }[] =
    [];
  const walk = (thread: Overview["memberThreads"][number], depth: number) => {
    if (visited.has(thread.threadId)) return;
    visited.add(thread.threadId);
    rows.push({ thread, depth });
    visible
      .filter((t) => t.parentThreadId === thread.threadId)
      .forEach((t) => walk(t, depth + 1));
  };
  const coordinator = visible.find((t) => t.threadId === root);
  if (coordinator) walk(coordinator, 0);
  // Unknown/disconnected parents stay in the unified list, with honest details.
  visible
    .filter((t) => !knownIds.has(t.parentThreadId ?? ""))
    .forEach((t) => walk(t, t.threadId === root ? 0 : 1));
  visible.forEach((t) => walk(t, 1));
  const render = (t: Overview["memberThreads"][number], depth: number) => {
    const worker = [...o.workers.current, ...o.workers.retired].find(
      (w) => w.ref === `W${t.workerNum}`,
    );
    const label = t.ownership === "coordinator" ? "Coordinator" : t.label;
    const title = `${t.ownership === "worker" ? `W${t.workerNum} ` : ""}${label}`;
    const env = inventory
      .flatMap((p) => p.environments)
      .find((e) => e.id === t.environmentId);
    const work = o.inFlight.filter((a) => a.owner.threadId === t.threadId);
    return (
      <div
        key={t.threadId}
        className="cr-thread"
        style={{ "--depth": Math.min(depth, 5) } as React.CSSProperties}
      >
        <div className="cr-thread-line">
          <button
            className="cr-thread-main"
            title={`Open ${title}`}
            aria-label={`Open ${title}`}
            onClick={() => openThread(t.threadId)}
          >
            <span
              className={`project-dot project-dot--${["active", "starting", "stopping"].includes(t.runtime) ? "live" : ["failed", "error"].includes(t.runtime) ? "attention" : "muted"}`}
              title={t.runtime}
            />
            {t.ownership === "worker" ? (
              <span className="cr-ref">W{t.workerNum}</span>
            ) : null}
            <span className="cr-thread-name">
              <b>{label}</b>
              <small>
                {t.ownership === "user" ? "Yours · " : ""}
                {work
                  .map((a) => a.tasks.map((task) => task.ref).join(", "))
                  .join(" · ") || t.runtime}
              </small>
            </span>
            {t.ownership === "coordinator" && t.generation !== null ? (
              <span className="cr-gen">G{t.generation}</span>
            ) : null}
          </button>
          <button
            className="cr-iconbtn cr-caret"
            aria-label={`Details for ${title}`}
            aria-expanded={expanded === t.threadId}
            onClick={() =>
              setExpanded(expanded === t.threadId ? null : t.threadId)
            }
          >
            <Glyph name="down" />
          </button>
        </div>
        {expanded === t.threadId ? (
          <div className="cr-thread-detail">
            <p className="project-meta">
              {t.runtime} ·{" "}
              {t.ownership === "user"
                ? "User-owned conversation"
                : (worker?.role ?? "Coordinator")}
              {t.retained ? " · retained generation" : ""}
            </p>
            {!t.parentKnown ? (
              <p className="project-meta">Native parent unavailable.</p>
            ) : t.parentThreadId &&
              knownIds.has(t.parentThreadId) ? null : t.threadId !== root ? (
              <p className="project-note">
                Native parent is outside this visible current tree.
              </p>
            ) : null}
            {t.forkedFrom ? <p>Forked from {t.forkedFrom}</p> : null}
            {worker?.area ? <p>{worker.area}</p> : null}
            {worker?.profile ? (
              <p className="project-meta">
                Recorded worker profile: {worker.profile}
              </p>
            ) : null}
            {env ? (
              <p className="project-meta">
                {env.hostId} · <code>{env.path ?? "Path unknown"}</code>
                {env.isWorktree ? " · worktree" : ""}
              </p>
            ) : null}
            {work.map((a) => (
              <div key={a.assignment}>
                <p>{a.outcome}</p>
                <p>{a.progress}</p>
                <p>Next: {a.nextCheckpoint}</p>
              </div>
            ))}
            {worker?.lastHandoff ? <HandoffActions assignment={worker.lastHandoff} readHandoff={readHandoff} /> : null}
            {worker &&
            worker.state !== "retired" &&
            worker.threadId === t.threadId ? (
              <ReasonAction
                label="Retire worker"
                run={run}
                make={(reason) => ({
                  action: "worker-retire",
                  worker: worker.ref,
                  reason,
                })}
              />
            ) : null}
            <p className="project-meta">
              Use native Stop in this thread to interrupt a turn.
            </p>
          </div>
        ) : null}
      </div>
    );
  };
  return (
    <div className="cr-threads">
      <div aria-label="Coordinator and its threads">
        {rows.map(({ thread, depth }) => render(thread, depth))}
      </div>
      {o.threads
        .filter((t) => !t.threadId)
        .map((t) => (
          <p key={t.createdAt} className="cr-unconfirmed">
            {t.label} · {t.state}, native thread not confirmed.
          </p>
        ))}
      <button className="cr-add" onClick={newThread}>+ New thread</button>
      <button
        className="cr-retained"
        aria-expanded={retained}
        onClick={() => setRetained(!retained)}
      >
        Earlier threads{" "}
        <span className="cr-count">{o.memberThreads.filter((t) => historicalThread(t, root)).length}</span>
      </button>
      {retained
        ? o.memberThreads
            .filter((t) => historicalThread(t, root))
            .map((t) => render(t, 0))
        : null}
    </div>
  );
}
/**
 * T130: a primary action with a chevron menu of alternatives. The menu opens
 * from the chevron (click, Enter, Space or ↓), moves with ↑/↓, closes on
 * Escape, outside press or a choice, and returns focus to the chevron.
 */
function SplitButton({ label, main, items, align = "start", className }: {
  label: string;
  className?: string;
  main: ReactNode;
  items: { label: string; disabled?: boolean; onSelect: () => void }[];
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const close = (focus = true) => { setOpen(false); if (focus) toggle.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    wrap.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus();
    const outside = (event: PointerEvent) => { if (!wrap.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const keys = (event: React.KeyboardEvent) => {
    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    event.stopPropagation();
    if (!open) { setOpen(true); return; }
    const choices = Array.from(wrap.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") ?? []);
    const at = choices.indexOf(document.activeElement as HTMLButtonElement);
    choices[(at + (event.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length]?.focus();
  };
  return (
    <div className={`cr-split${className ? ` ${className}` : ""}`} role="group" aria-label={label} ref={wrap} onKeyDown={keys}>
      {main}
      {items.length ? (
        <>
          <button type="button" ref={toggle} className="cr-split-toggle" aria-label={`More ${label.toLowerCase()} options`}
            aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => setOpen(!open)}>
            <Glyph name="down" />
          </button>
          {open ? (
            <div role="menu" id={menuId} aria-label={label} className={`cr-split-menu cr-split-menu--${align}`}>
              {items.map((item) => (
                <button type="button" role="menuitem" key={item.label} disabled={item.disabled}
                  onClick={() => { close(false); item.onSelect(); }}>{item.label}</button>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * D386: a worker's blocker, answerable here. The answer goes to the
 * coordinator, who continues the worker; the item stays until it does.
 * T130: it can go straight to the worker instead, with an FYI to the
 * coordinator. The coordinator stays the default; the worker is the default
 * only when there is no coordinator to send to.
 */
function Blocker({ item, run, coordinatorThreadId }: { item: BlockerItem; run: Run; coordinatorThreadId: string | null }) {
  const [revising, setRevising] = useState(false);
  const [telling, setTelling] = useState(false);
  const [note, setNote] = useState(item.answer?.note ?? "");
  const [busy, setBusy] = useState<"answer" | "dismiss" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const worker = item.owner.worker;
  const fallback = !coordinatorThreadId && item.owner.threadId ? "worker" : "coordinator";
  const other = fallback === "coordinator" && item.owner.threadId ? "worker" : null;
  const sendTo = (to: "coordinator" | "worker") => to === "worker" ? `Send to ${worker}` : "Send to coordinator";
  const act = async (kind: "answer" | "dismiss", command: Command) => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      await run(command);
      if (kind === "answer") setRevising(false);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };
  const answer = (to: "coordinator" | "worker") => {
    if (note.trim()) void act("answer", { action: "blocker-answer", assignment: item.assignment, question: item.question, context: item.context, note, to });
  };
  const dismiss = telling ? null : (
    <SplitButton label="Dismiss" align="end" className="cr-split--quiet"
      main={<button type="button" disabled={!!busy} title="Leave the coordinator to settle it; nothing is sent. Undo from Decisions."
        onClick={() => void act("dismiss", { action: "blocker-dismiss", assignment: item.assignment, question: item.question, context: item.context, notify: false, note: "" })}>
        {busy === "dismiss" ? "Saving…" : "Dismiss"}
      </button>}
      items={coordinatorThreadId ? [{ label: "Dismiss and tell coordinator…", onSelect: () => setTelling(true) }] : []} />
  );
  return (
    <div className="project-card project-opinion cr-blocker">
      <Markdown className="project-question" content={item.question} />
      {item.context ? <Markdown className="project-context" content={item.context} /> : null}
      {item.tasks.length ? <p className="project-muted">Blocks {item.tasks.map((t) => `${t.ref} ${t.title}`).join(", ")}</p> : null}
      {item.answer && !revising ? (
        <>
          <div className="cr-blocker-answer">
            <span className="project-meta">Your answer · {item.answer.ref}{item.answer.to === "worker" ? ` · sent to ${worker}` : ""}</span>
            <Markdown content={item.answer.note} />
          </div>
          <AnswerReceipts receipts={answerReceipts(item.answer, worker)}
            settled={item.answer.to === "worker" ? `This stays here until ${worker} reports again.` : `This stays here until it continues ${worker} or settles ${item.assignment}.`} />
          {error ? <p role="alert" className="project-error">{error}</p> : null}
          <div className="project-actions cr-blocker-actions">
            {answerReceipts(item.answer, worker).retry ? (
              <button type="button" disabled={!!busy} onClick={() => void act("answer", { action: "blocker-answer", assignment: item.assignment, question: item.question, context: item.context, note: item.answer!.note, to: item.answer!.to })}>
                {busy === "answer" ? "Sending…" : answerReceipts(item.answer, worker).retry}
              </button>
            ) : null}
            <button type="button" onClick={() => { setNote(item.answer!.note); setRevising(true); }}>Change answer</button>
            {dismiss}
          </div>
        </>
      ) : (
        <form onSubmit={(event) => { event.preventDefault(); answer(fallback); }} onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.requestSubmit();
          }
        }}>
          <label className="project-field">
            Your answer
            <AutoTextarea rows={3} value={note} maxLength={4000} required placeholder="Write your answer." onChange={(e) => setNote(e.target.value)} />
          </label>
          {error ? <p role="alert" className="project-error">{error}</p> : null}
          <div className="project-actions cr-blocker-actions">
            <SplitButton label="Send"
              main={<button className="project-primary" disabled={!!busy || !note.trim()}
                title={fallback === "worker" ? `No current coordinator: ${worker} continues ${item.assignment} with your answer.` : `The coordinator continues ${worker} with your answer.`}>
                {busy === "answer" ? "Sending…" : sendTo(fallback)}
              </button>}
              items={other ? [{ label: sendTo(other), disabled: !!busy || !note.trim(), onSelect: () => answer(other) }] : []} />
            {revising ? <button type="button" onClick={() => setRevising(false)}>Cancel</button> : null}
            {dismiss}
          </div>
        </form>
      )}
      {telling ? <DismissNotify item={item} run={run} cancel={() => setTelling(false)} /> : null}
    </div>
  );
}

type Receipt = { state: string; detail?: string } | null;
/**
 * T132: what an Inbox blocker answer's receipts say, and the one retry they
 * allow. A worker answer has two: its delivery to the worker, then the
 * coordinator FYI; the FYI only goes out once the worker has the answer.
 */
function answerReceipts(answer: { to: "coordinator" | "worker"; delivery: Receipt; notification: Receipt }, worker: string) {
  const unsure = (r: Receipt) => r?.state === "pending" || r?.state === "uncertain";
  const sent = (r: Receipt, to: string) => `${r?.state === "queued" ? "Queued for" : "Sent to"} ${to}`;
  if (answer.to === "coordinator") {
    const n = answer.notification;
    if (!n) return { text: null, alert: false, retry: null, done: false };
    if (n.state === "failed") return { text: `Sending to the coordinator failed: ${n.detail ?? "Unknown error"}`, alert: true, retry: "Retry sending to the coordinator", done: false };
    if (unsure(n)) return { text: "Delivery to the coordinator unconfirmed; check its thread before sending again.", alert: n.state === "uncertain", retry: null, done: false };
    return { text: `${sent(n, "the coordinator")}.`, alert: false, retry: null, done: true };
  }
  const d = answer.delivery, fyi = answer.notification;
  if (d?.state === "failed") return { text: `Sending to ${worker} failed: ${d.detail ?? "Unknown error"}`, alert: true, retry: `Retry sending to ${worker}`, done: false };
  if (!d || unsure(d)) return { text: `Delivery to ${worker} unconfirmed; check its thread before sending again.`, alert: d?.state === "uncertain", retry: null, done: false };
  const reached = `${sent(d, worker)}, which continues with it`;
  if (fyi?.state === "failed") return { text: `${reached}, but the coordinator FYI failed: ${fyi.detail ?? "Unknown error"}`, alert: true, retry: "Retry coordinator FYI", done: false };
  if (fyi?.state === "uncertain") return { text: `${reached}. The coordinator FYI is unconfirmed; check its thread before sending again.`, alert: true, retry: null, done: false };
  return { text: `${reached}; the coordinator ${fyi?.state === "pending" || !fyi ? "is being told" : "got an FYI"}.`, alert: false, retry: null, done: fyi?.state === "sent" || fyi?.state === "queued" };
}
function AnswerReceipts({ receipts, settled }: { receipts: ReturnType<typeof answerReceipts>; settled?: string }) {
  if (!receipts.text) return null;
  return <p role={receipts.alert ? "alert" : "status"} className="project-muted">{receipts.text}{receipts.done && settled ? ` ${settled}` : ""}</p>;
}

/** T128: dismiss a blocker with one message to the coordinator and an optional note. */
function DismissNotify({ item, run, cancel }: { item: BlockerItem; run: Run; cancel: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await run({ action: "blocker-dismiss", assignment: item.assignment, question: item.question, context: item.context, notify: true, note });
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };
  return (
    <form className="cr-blocker-dismiss" onSubmit={submit}>
      <label className="project-field">
        Note for the coordinator (optional)
        <AutoTextarea rows={2} value={note} maxLength={4000} placeholder={`Why you are not answering, or how ${item.owner.worker} should proceed.`} onChange={(e) => setNote(e.target.value)} />
      </label>
      {error ? <p role="alert" className="project-error">{error}</p> : null}
      <div className="project-actions">
        <button className="project-primary" disabled={busy}>{busy ? "Sending…" : "Dismiss and send"}</button>
        <button type="button" onClick={cancel}>Cancel</button>
      </div>
    </form>
  );
}

type DecisionRow = Overview["decisions"][number];
const pendingReview = (d: DecisionRow) => d.madeBy === "agent" && d.review === "pending";
const owner = (d: DecisionRow) =>
  d.madeBy === "user" ? "Yours" : d.recordedBy.author === "worker" ? "Worker" : "Coordinator";

/** ↑/↓ moves between a list's folds, opening only the focused one. */
function moveBetweenFolds(event: React.KeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const summaries = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(".cr-fold > summary"));
  const index = summaries.indexOf(event.target as HTMLElement);
  if (index < 0 || summaries.length < 2) return;
  event.preventDefault();
  const next = summaries[(index + (event.key === "ArrowDown" ? 1 : -1) + summaries.length) % summaries.length]!;
  summaries.forEach(summary => { (summary.parentElement as HTMLDetailsElement).open = summary === next; });
  next.focus();
}

/** One decision: its text first, then who made it, when, and its review. */
/** One message BB still holds: what it says, why it is held, and the user's two ways out. */
function HeldMessage({ m, run, openThread }: { m: NonNullable<Overview["notDelivered"]>[number]; run: Run; openThread: (threadId: string) => void }) {
  return (
    <article className="cr-decision" aria-label={`Message held for ${m.target}`}>
      <p role="status">{m.reason}</p>
      <div className="cr-decision-text cr-clamp">{m.preview || "(no text)"}</div>
      <div className="cr-decision-meta">
        <a className="cr-worker-link" href="#" title={`Open ${m.target}'s thread`}
          onClick={(event) => { event.preventDefault(); openThread(m.threadId); }}>{m.target}</a>
        <Age at={m.queuedAt} />
        <Action run={run} command={{ action: "queued-message", thread: m.threadId, message: m.id, operation: "send" }}
          title={`Send it to ${m.target} now. BB starts a turn there.`}>Send now</Action>
        <Action run={run} command={{ action: "queued-message", thread: m.threadId, message: m.id, operation: "delete" }}
          title="Remove it from BB's queue. Nothing is sent.">Remove</Action>
      </div>
    </article>
  );
}

function DecisionItem({ d, run, answer }: { d: DecisionRow; run: Run; answer?: Overview["answered"][number] }) {
  const [full, setFull] = useState(false);
  const reviewable = d.madeBy === "agent" && (d.review === "pending" || d.notification?.state === "failed");
  return (
    <article className="cr-decision" aria-label={d.ref}>
      {answer && full ? (
        <p className="cr-decision-question">
          {answer.question}
          {answer.recordedBy ? ` · Answered in chat, recorded by ${answer.recordedBy === "coordinator" ? "the coordinator" : "a worker"}` : ""}
        </p>
      ) : null}
      <div className={`cr-decision-text${full ? "" : " cr-clamp"}`}>
        <Markdown content={d.description} />
      </div>
      {answer && d.notification ? (
        <div>
          <p role={d.notification.state === "failed" || d.notification.state === "uncertain" ? "alert" : "status"}>
            {d.notification.state === "failed" ? `Answer saved. Coordinator notification failed: ${d.notification.detail ?? "Unknown error"}`
              : d.notification.state === "pending" || d.notification.state === "uncertain" ? "Answer saved. Coordinator notification unconfirmed; inspect its native thread before another send."
              : d.notification.state === "queued" ? "Answer queued for the coordinator." : "Coordinator notified of your answer."}
          </p>
          {d.notification.state === "failed" ? <Action run={run} command={{ action: "answer", decision: d.ref, choice: answer.choice, note: answer.note }}>Retry coordinator notification</Action> : null}
        </div>
      ) : null}
      {d.dismissal ? <Dismissal d={d} dismissal={d.dismissal} run={run} /> : null}
      {d.blockerAnswer ? <BlockerAnswerStatus d={d} answer={d.blockerAnswer} run={run} /> : null}
      <div className="cr-decision-meta">
        <span className="cr-ref">{d.ref}</span>
        <span className={`cr-owner${d.madeBy === "user" ? " cr-owner--user" : ""}`}>{owner(d)}</span>
        <Age at={d.updatedAt} />
        {d.dismissal?.undoneAt ? <span className="cr-verdict">Undone</span> : null}
        {d.dismissal && !d.dismissal.undoneAt ? <Action run={run} command={{ action: "blocker-dismiss-undo", decision: d.ref }}
          title={`Bring ${d.dismissal.assignment}'s blocker back to the Inbox if it is still open. Nothing is sent.`}>Undo</Action> : null}
        {!reviewable && (d.review === "okay" || d.review === "not-okay") ? (
          <span className={`cr-verdict cr-verdict--${d.review}`}>{d.review === "okay" ? "Okay" : "Not okay"}</span>
        ) : null}
        {reviewable ? (
          <DecisionReview decision={d.ref} verdict={d.review} reviewMessage={d.reviewMessage} notification={d.notification} run={run} />
        ) : null}
        <button className="cr-iconbtn cr-caret" aria-label={`Show all of ${d.ref}`} aria-expanded={full} onClick={() => setFull(!full)}>
          <Glyph name="down" />
        </button>
      </div>
      {!reviewable && d.reviewMessage && full ? <p className="cr-review-message">{d.reviewMessage}</p> : null}
    </article>
  );
}

/** T128: how a dismissal reached the coordinator, with a retry when the notice failed. */
function Dismissal({ d, dismissal, run }: { d: DecisionRow; dismissal: NonNullable<DecisionRow["dismissal"]>; run: Run }) {
  const notice = d.notification;
  if (!dismissal.notify || !notice) return null;
  return (
    <div>
      <p role={notice.state === "failed" || notice.state === "uncertain" ? "alert" : "status"} className="project-muted">
        {notice.state === "failed" ? `Dismissal saved. Coordinator notification failed: ${notice.detail ?? "Unknown error"}`
          : notice.state === "pending" || notice.state === "uncertain" ? "Dismissal saved. Coordinator notification unconfirmed; check its thread before sending again."
          : notice.state === "queued" ? "Dismissal queued for the coordinator." : "Coordinator told of your dismissal."}
      </p>
      {notice.state === "failed" && !dismissal.undoneAt ? (
        <Action run={run} command={{ action: "blocker-dismiss", assignment: dismissal.assignment, question: dismissal.question, context: dismissal.context, notify: true, note: dismissal.note }}>
          Retry coordinator notification
        </Action>
      ) : null}
    </div>
  );
}

/** T132: an Inbox blocker answer whose delivery or coordinator notice did not go through, with its retry. */
function BlockerAnswerStatus({ d, answer, run }: { d: DecisionRow; answer: NonNullable<DecisionRow["blockerAnswer"]>; run: Run }) {
  const receipts = answerReceipts({ ...answer, notification: d.notification }, answer.worker ?? "the worker");
  if (receipts.done || !receipts.text) return null;
  return (
    <div>
      <AnswerReceipts receipts={receipts} />
      {receipts.retry ? (
        <Action run={run} command={{ action: "blocker-answer", assignment: answer.assignment, question: answer.question, context: answer.context, note: answer.note, to: answer.to }}>
          {receipts.retry}
        </Action>
      ) : null}
    </div>
  );
}

type AcceptDecisionsState = { eligible: boolean; busy: boolean; error: string | null; accept: () => Promise<void> };
function useAcceptAgentDecisions(o: Overview, run: Run): AcceptDecisionsState {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const eligible = o.decisions.some(d => d.acceptEligible);
  return { eligible, busy, error, accept: async () => {
    if (pending.current || !eligible) return;
    pending.current = true; setBusy(true); setError(null);
    try { await run({ action: "decision-accept-all" }); }
    catch (e) { setError(message(e)); }
    finally { pending.current = false; setBusy(false); }
  } };
}
function AcceptAgentDecisions({ state }: { state: AcceptDecisionsState }) {
  return <div className="cr-accept-decisions">
    <button disabled={state.busy || !state.eligible} onClick={() => void state.accept()}
      title="Mark unchecked agent choices Okay without messages. Records, history and existing verdicts stay intact.">{state.busy ? "Accepting…" : "Accept all unchecked agent decisions"}</button>
    {state.error ? <p role="alert" className="project-error">{state.error}</p> : null}
  </div>;
}

const decisionFilters = [["all", "All"], ["agent", "Agents"], ["user", "Yours"]] as const;
/** The full record of choices, newest first, separable by who made them. */
function Decisions({ o, run, acceptDecisions }: { o: Overview; run: Run; acceptDecisions: AcceptDecisionsState }) {
  const [filter, setFilter] = useState<(typeof decisionFilters)[number][0]>("all");
  const answers = new Map(o.answered.map(a => [a.ref, a]));
  const shown = [...o.decisions].reverse().filter(d => filter === "all" || d.madeBy === filter);
  return (
    <div className="cr-decisions">
      <div className="cr-toolbar">
        <AcceptAgentDecisions state={acceptDecisions} />
        <div className="project-usage-filter" role="group" aria-label="Who made the decision">
          {decisionFilters.map(([id, label]) => (
            <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>
          ))}
        </div>
      </div>
      {o.historyLoaded === false ? <p role="status" className="project-muted">Loading all decisions…</p> : null}
      {shown.length ? shown.map(d => <DecisionItem key={d.ref} d={d} run={run} answer={answers.get(d.ref)} />) : o.historyLoaded === false ? null : (
        <p className="cr-empty">{o.decisions.length ? "None in this view." : "No decisions recorded."}</p>
      )}
      {o.closedQuestions.length ? <details className="cr-fold">
        <summary>Closed questions · {o.closedQuestions.length}</summary>
        {o.closedQuestions.map(q => <article className="cr-decision" key={q.ref}>
          <p className="project-meta">{q.ref} · {q.withdrawn ? "Withdrawn by the coordinator" : "Closed quietly"} · No answer recorded</p>
          <Markdown content={q.question} />
          {q.note ? <Markdown content={q.note} /> : null}
          <Age at={q.closedAt} />
        </article>)}
      </details> : null}
    </div>
  );
}

function DecisionReview({ decision, verdict, reviewMessage, notification, run }: {
  decision: string; verdict: "pending" | "okay" | "not-okay" | null;
  reviewMessage?: string | null; notification?: DecisionRecord["notification"]; run: Run;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <div className="cr-decision-review" aria-label={`Review ${decision}`}>
    {reviewMessage ? <p className="cr-review-message">{reviewMessage}</p> : null}
    {notification?.state === "uncertain" || notification?.state === "pending" ? <p role="status">Review saved. Coordinator notification unconfirmed; inspect its native thread before another send.</p> : notification?.state === "failed" ? <p role="alert">Review saved. Coordinator notification failed: {notification.detail}. Submit the message again to retry.</p> : notification?.state === "queued" ? <p className="project-meta">Message queued for the coordinator.</p> : notification?.state === "sent" ? <p className="project-meta">Coordinator notified.</p> : null}
    {rejecting ? <form className="cr-decision-reject" onSubmit={async event => {
      event.preventDefault(); if (!note.trim() || busy) return;
      setBusy(true); setError(null);
      try { await run({ action: "decision-review", decision, verdict: "not-okay", message: note.trim() }); setRejecting(false); setNote(""); }
      catch (e) { setError(message(e)); } finally { setBusy(false); }
    }}>
      <label className="project-field">Message to coordinator<AutoTextarea value={note} onChange={e => setNote(e.target.value)} maxLength={2000} required autoFocus /></label>
      <div className="project-actions"><button disabled={busy || !note.trim()}>{busy ? "Sending…" : "Send and mark not okay"}</button><button type="button" disabled={busy} onClick={() => setRejecting(false)}>Cancel</button></div>
      {error ? <p role="alert" className="project-error">{error}</p> : null}
    </form> : <><button className="cr-not-okay" title="Tell the coordinator what to change" onClick={() => setRejecting(true)}>Not okay</button><Action className="cr-okay" title="Mark as checked. Nobody is notified." run={run} command={{ action: "decision-review", decision, verdict: "okay", message: "" }}>Okay</Action></>}
  </div>;
}

function Repositories({
  o,
  inventory,
  run,
}: {
  o: Overview;
  inventory: Inventory;
  run: Run;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <section aria-label="Repositories">
      <h2 className="cr-section-heading">Repositories</h2>
      {o.project.memberProjectIds.map((id, index) => {
        const repo = inventory.find((p) => p.id === id);
        const home = repo?.environments.find((e) => e.isDefaultHome);
        return (
          <div key={id} className="cr-repository">
            <div>
              <strong>{repo?.name ?? "Repository unavailable"}</strong>
              {index === 0 ? <span className="cr-gen">home</span> : null}
              <p className="project-meta">
                {home ? (
                  <>
                    <code>{home.path}</code> · {home.hostId}
                  </>
                ) : (
                  "Default checkout unavailable"
                )}
              </p>
            </div>
            {index > 0 ? (
              <ReasonAction
                label={`Remove ${repo?.name ?? "repository"}`}
                needsReason={false}
                run={run}
                make={() => ({
                  action: "edit",
                  memberProjectIds: o.project.memberProjectIds.filter(
                    (member) => member !== id,
                  ),
                })}
              />
            ) : null}
          </div>
        );
      })}
      <button aria-expanded={adding} onClick={() => setAdding(!adding)}>
        Add a BB project
      </button>
      {adding ? (
        <div className="project-actions">
          {inventory
            .filter((p) => !o.project.memberProjectIds.includes(p.id))
            .map((p) => (
              <Action
                key={p.id}
                run={run}
                command={{
                  action: "edit",
                  memberProjectIds: [...o.project.memberProjectIds, p.id],
                }}
              >
                {p.name}
              </Action>
            ))}
        </div>
      ) : null}
      <p className="project-meta">
        Open files through the Editor's project picker.
      </p>
    </section>
  );
}
function TaskEdit({
  task,
  run,
}: {
  task: Overview["remaining"][number];
  run: Run;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [summary, setSummary] = useState(task.summary);
  return open ? (
    <div>
      <label className="project-field">
        Task title
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
        />
      </label>
      <label className="project-field">
        Task summary
        <AutoTextarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          maxLength={2000}
        />
      </label>
      {title.trim() && summary.trim() ? (
        <Action
          run={run}
          command={{
            action: "task-update",
            task: task.ref,
            title: title.trim(),
            summary: summary.trim(),
          }}
        >
          Save task
        </Action>
      ) : (
        <button disabled>Save task</button>
      )}
      <button onClick={() => setOpen(false)}>Done</button>
    </div>
  ) : (
    <button onClick={() => setOpen(true)}>Edit task</button>
  );
}
function UpdateForm({ run }: { run: Run }) {
  const [summary, setSummary] = useState("");
  const [body, setBody] = useState("");
  return (
    <Fold title="Record an update">
      <label className="project-field">
        Update summary
        <input
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          maxLength={2000}
        />
      </label>
      <label className="project-field">
        Update details
        <AutoTextarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={20000}
        />
      </label>
      {summary.trim() && body.trim() ? (
        <Action
          run={run}
          command={{
            action: "update",
            summary: summary.trim(),
            body: body.trim(),
          }}
        >
          Record update
        </Action>
      ) : (
        <button disabled>Record update</button>
      )}
    </Fold>
  );
}
