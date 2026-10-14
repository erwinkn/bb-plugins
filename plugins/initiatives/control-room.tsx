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
import type { BlockerItem, Overview, OpinionItem, TaskItem, WorkerChild, WorkerItem, WorkerWaiting } from "./lib/overview";
import { needsYouCount } from "./lib/blockers";
import { MAX_RULES, RULE_MAX_CHARACTERS } from "./lib/rules";
import type { Command } from "./lib/commands";
import type { Cached, ChildPage, projectsContract } from "./lib/contract";
import { useData } from "./use-data";
import { appReads } from "./lib/dashboard-data";
import { UsagePage } from "./usage-view";
import { useWrite } from "./write-status";
import { WRITE_SLOW_MESSAGE } from "./lib/write-timeout";
import "./control-room.css";

/** Five tabs, then the three views behind ⋯ (D512, v9 §10). */
export type Tab = "inbox" | "workers" | "prs" | "tasks" | "rules" | "activity" | "usage" | "archive";
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
  open: "M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4",
  up: "M6 15l6-6 6 6",
  edit: "M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16zM13.5 6.5l4 4",
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
  const write = useWrite();
  return (
    <>
      <button
        className={className}
        title={title}
        disabled={write.busy}
        onClick={async () => {
          const done = await write.run(() => run(command));
          const refused = done.ok ? refusal?.(done.value) ?? null : null;
          if (refused) write.setError(refused);
        }}
      >
        {write.busy ? "Saving…" : children}
      </button>
      {write.slow ? <p role="status" className="project-muted">{WRITE_SLOW_MESSAGE}</p> : null}
      {write.error ? (
        <p role="alert" className="project-error">
          {write.error}
        </p>
      ) : null}
    </>
  );
}
/**
 * What a Stop or a task cancel left running: the threads BB refused to stop and any it could not
 * check (`notStopped`, `unverified` in the result). The Stop or cancel itself stands.
 */
export function stillRunning(result: unknown): string | null {
  const { notStopped, unverified } = (result ?? {}) as { notStopped?: string[]; unverified?: string };
  const parts = [notStopped?.length ? `not stopped: ${notStopped.join(", ")}` : null, unverified ? `not checked: ${unverified}` : null].filter(Boolean);
  return parts.length ? `Some work may still run: ${parts.join("; ")}.` : null;
}
function ReasonAction({
  label,
  make,
  run,
  needsReason = true,
  refusal,
}: {
  label: string;
  make: (reason: string) => Command;
  run: Run;
  needsReason?: boolean;
  refusal?: (result: unknown) => string | null;
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
              <Action command={make(reason.trim())} run={run} refusal={refusal}>
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
type TabSpec = readonly [Tab, string, keyof typeof glyphs | null];
const mainTabs: readonly TabSpec[] = [
  ["inbox", "Inbox", null],
  ["workers", "Workers", null],
  ["prs", "PRs", "pr"],
  ["tasks", "Tasks", null],
  ["rules", "Rules", null],
];
/** Behind ⋯; the open one joins the strip so the reader sees where they are. */
const moreTabs: readonly TabSpec[] = [
  ["activity", "Activity", "log"],
  ["usage", "Usage", "usage"],
  ["archive", "Archive", "context"],
];
/** Views a remembered tab or an old route may still name, before v9's five tabs. */
const formerTabs: Record<string, Tab> = { threads: "workers", decisions: "archive", context: "rules", log: "activity" };
export const isTab = (value: unknown): value is Tab => [...mainTabs, ...moreTabs].some(([id]) => id === value);
/** A tab from a stored or routed value, mapping the views v9 renamed; null when it names none. */
export const toTab = (value: unknown): Tab | null =>
  isTab(value) ? value : typeof value === "string" && Object.hasOwn(formerTabs, value) ? formerTabs[value]! : null;
const TAB_LEVELS = 3;

function Tabs({
  tab,
  change,
  counts,
  urgent,
  prefix,
  specs,
}: {
  specs: readonly TabSpec[];
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

/**
 * A button that opens a small panel of controls below it. Escape and a press
 * outside close it; `children` gets `close` for controls that finish at once.
 */
function Menu({
  label,
  trigger,
  className,
  align = "start",
  children,
}: {
  label: string;
  trigger: ReactNode;
  className?: string;
  align?: "start" | "end";
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const keys = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    const outside = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", keys);
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("keydown", keys);
      document.removeEventListener("pointerdown", outside);
    };
  }, [open]);
  return (
    <div className="cr-menu-wrap" ref={wrap}>
      <button ref={button} type="button" className={className} aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)}>
        {trigger}
      </button>
      {open ? (
        <div className={`cr-menu cr-menu--${align}`} role="group" aria-label={label}>
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

const FAILED_STATUSES = ["error", "failed", "missing", "deleted"];

export function ControlRoom({
  overview: o,
  inventory,
  run,
  openThread,
  refresh,
  notice,
  renderOpinion,
  renderReplacement,
  renderContext,
  newTask,
  onTab,
  initialTab = "inbox",
  detailNotice,
  readHandoff,
  loadChildren,
  mergeQueue,
}: {
  /** The merge queue tab: its open PR count and its view. */
  mergeQueue?: { count: number; view: ReactNode };
  /** The standard handoff text of a reported assignment, rendered from its stored report. */
  readHandoff?: (ref: string) => Promise<string | null>;
  /** v9: one page of a thread's BB children, read live (childPage). */
  loadChildren?: LoadChildren;
  onTab?: (tab: Tab) => void;
  /** The tab to open on (a route's or the remembered one); onTab hears it on mount. */
  initialTab?: Tab;
  detailNotice?: string | null;
  overview: Overview;
  inventory: Inventory;
  run: Run;
  openThread: (threadId: string) => void;
  refresh: () => Promise<void>;
  notice?: ReactNode;
  renderOpinion: (item: OpinionItem) => ReactNode;
  renderReplacement: (close: () => void) => ReactNode;
  renderContext: (close: () => void) => ReactNode;
  newTask: ReactNode;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const chooseTab = (value: Tab) => { setTab(value); onTab?.(value); };
  // Once, on mount: load what the opening tab needs.
  useEffect(() => { if (initialTab !== "inbox") onTab?.(initialTab); }, []);
  // A route change under a mounted dashboard (history, a deep link) opens its tab like a click.
  const routedTab = useRef(initialTab);
  useEffect(() => {
    if (initialTab === routedTab.current) return;
    routedTab.current = initialTab;
    if (initialTab !== tab) chooseTab(initialTab);
  }, [initialTab]);
  const [replace, setReplace] = useState(false);
  const [editing, setEditing] = useState(false);
  // The worker open in the Workers tab's detail; the Tasks tab opens one too.
  const [worker, setWorker] = useState<string | null>(null);
  const showWorker = (ref: string) => { setWorker(ref); chooseTab("workers"); };
  const repositories = useRef<HTMLElement>(null);
  useEffect(() => {
    const keys = (event: KeyboardEvent) => { if (event.key === "Escape") setReplace(false); };
    document.addEventListener("keydown", keys);
    return () => document.removeEventListener("keydown", keys);
  }, []);
  const prefix = useId();
  const p = o.project;
  const failed = FAILED_STATUSES.includes(p.coordinatorStatus);
  const active = ["active", "starting", "stopping"].includes(p.coordinatorStatus);
  const cState = `${p.coordinatorStatus}${p.paused ? "; Initiative paused" : ""}`;
  // Open questions and blocked reports wait on the user: shown before anything else.
  const needsYou = needsYouCount(o);
  // A dismissal leaves the Inbox, unless telling the coordinator did not go
  // through; so does an answered blocker once its card is gone (T132).
  const undeliveredState = (r: Receipt) => r?.state === "failed" || r?.state === "uncertain";
  const carded = new Set(o.blockers.flatMap(b => b.answer ? [b.answer.ref] : []));
  const undelivered = o.decisions.filter(d =>
    d.dismissal?.notify && !d.dismissal.undoneAt && undeliveredState(d.notification) ||
    d.blockerAnswer && !carded.has(d.ref) && (undeliveredState(d.notification) || undeliveredState(d.blockerAnswer.delivery)));
  // Messages BB is holding for members with nothing running to deliver them (T133).
  const held = o.notDelivered ?? [];
  const inboxCount = o.opinionNeeded.length + o.blockers.length + undelivered.length + held.length;
  const shownTabs = [
    ...(mergeQueue ? mainTabs : mainTabs.filter(([id]) => id !== "prs")),
    ...moreTabs.filter(([id]) => id === tab),
  ];
  return (
    <div className="cr" data-component="ControlRoom">
      <div className="cr-sticky">
        <div className="cr-head">
          <span className="cr-mark" aria-hidden="true">{p.name.slice(0, 2).toLowerCase()}</span>
          <Menu label={`${p.name}: Initiative menu`} className="cr-head-name" trigger={<><strong>{p.name}</strong><Glyph name="down" /></>}>
            {(close) => (
              <>
                <Action run={run} command={{ action: "pause", paused: !p.paused }}>
                  {p.paused ? "Resume" : "Pause"}
                </Action>
                <button onClick={() => { chooseTab("rules"); setEditing(true); close(); }}>Edit initiative</button>
                <button
                  onClick={() => {
                    chooseTab("rules");
                    close();
                    requestAnimationFrame(() => repositories.current?.scrollIntoView?.({ block: "start" }));
                  }}
                >
                  Repositories
                </button>
                <button onClick={() => { void refresh(); close(); }}>Refresh</button>
                <ReasonAction label="Stop initiative work" make={(reason) => ({ action: "stop-work", reason })} run={run} />
                <ReasonAction label="Archive initiative" needsReason={false} make={() => ({ action: "archive" })} run={run} />
              </>
            )}
          </Menu>
          <Menu
            label={`Coordinator · ${cState}`}
            className={`cr-chip${failed ? " cr-chip--error" : ""}`}
            trigger={
              <>
                <span className={`project-dot project-dot--${active ? "live" : failed ? "attention" : "muted"}`} />
                Coordinator<span className="cr-chip-status"> · {p.coordinatorStatus}</span>
                <Glyph name="down" />
              </>
            }
          >
            {(close) => (
              <>
                <p className="cr-menu-meta" title={p.coordinatorHome?.path ?? undefined}>
                  G{p.coordinatorGeneration} · {p.coordinatorProfile ?? "Profile unavailable"}
                  {p.coordinatorHome?.path ? ` · ${p.coordinatorHome.path.split("/").filter(Boolean).at(-1)}` : ""}
                </p>
                {p.coordinatorHome?.mismatch ? <p className="cr-menu-meta">{p.coordinatorHome.mismatch}</p> : null}
                {p.coordinatorThreadId ? (
                  <button onClick={() => { openThread(p.coordinatorThreadId!); close(); }}>Open coordinator thread</button>
                ) : null}
                <button onClick={() => { setReplace(true); close(); }}>Replace coordinator</button>
                <p className="cr-menu-meta">Stop a running turn with BB's native Stop control in its thread.</p>
              </>
            )}
          </Menu>
          {needsYou ? (
            <button type="button" className="cr-needs-you" onClick={() => chooseTab("inbox")}>
              Needs you · {needsYou}
            </button>
          ) : null}
        </div>
        <div className="cr-tabrow" hidden={replace}>
          <Tabs
            specs={shownTabs}
            tab={tab}
            change={chooseTab}
            prefix={prefix}
            counts={{ inbox: inboxCount, workers: o.workers.current.length, prs: mergeQueue?.count }}
            urgent={needsYou > 0}
          />
          <Menu label="More views" align="end" className="cr-iconbtn" trigger={<Glyph name="menu" />}>
            {(close) => moreTabs.map(([id, label]) => (
              <button key={id} aria-current={tab === id || undefined} onClick={() => { chooseTab(id); close(); }}>{label}</button>
            ))}
          </Menu>
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
              {o.opinionNeeded.length || o.blockers.length
                ? <DismissAll questions={o.opinionNeeded} blockers={o.blockers} left={undelivered.length + held.length} run={run} />
                : null}
              {o.opinionNeeded.length ? (
                <section aria-label="Questions" onKeyDown={moveBetweenFolds}>
                  <h2 className="cr-section-heading">Questions <span className="cr-count">{o.opinionNeeded.length}</span></h2>
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
                  <h2 className="cr-section-heading">Blocked workers <span className="cr-count">{o.blockers.length}</span></h2>
                  {o.blockers.map((item, index) => (
                    <Fold group={`${prefix}-inbox`}
                      key={item.assignment}
                      title={
                        <>
                          <span className="cr-kind cr-kind--blocked" aria-hidden="true">!</span>
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
                <h2 className="cr-section-heading">Not delivered <span className="cr-count">{undelivered.length + held.length}</span></h2>
                {undelivered.map(d => <DecisionItem key={d.ref} d={d} run={run} />)}
                {held.map(m => <HeldMessage key={m.id} m={m} run={run} openThread={openThread} />)}
              </section> : null}
              {!inboxCount ? <p className="cr-empty">You’re up to date.</p> : null}
            </div>
          </KeepTab>
          {detailNotice && ["workers", "usage", "activity"].includes(tab) ? <p role="status" className="project-muted">{detailNotice}</p> : null}
          <KeepTab current={tab} id="workers">
            <Workers o={o} run={run} openThread={openThread} readHandoff={readHandoff} loadChildren={loadChildren} selected={worker} select={setWorker} />
          </KeepTab>
          <KeepTab current={tab} id="tasks">
            <Tasks o={o} run={run} newTask={newTask} showWorker={showWorker} />
          </KeepTab>
          {mergeQueue ? <KeepTab current={tab} id="prs">{mergeQueue.view}</KeepTab> : null}
          <KeepTab current={tab} id="rules">
            <>
              <section className="cr-card cr-purpose" aria-label="Purpose and objectives">
                {editing ? (
                  renderContext(() => setEditing(false))
                ) : (
                  <>
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
                    <button className="cr-link" onClick={() => setEditing(true)}>
                      Edit purpose and objectives
                    </button>
                  </>
                )}
              </section>
              <Rules o={o} run={run} openArchive={() => chooseTab("archive")} />
              <section ref={repositories} className="cr-repositories">
                <Repositories o={o} inventory={inventory} run={run} />
              </section>
            </>
          </KeepTab>
          <KeepTab current={tab} id="usage">
            {o.detailsLoaded === false ? <p className="project-muted">Loading usage…</p> : <UsagePage usage={o.usage} openThread={openThread} />}
          </KeepTab>
          <KeepTab current={tab} id="activity">
            <Activity o={o} run={run} openThread={openThread} />
          </KeepTab>
          <KeepTab current={tab} id="archive">
            <Archive o={o} run={run} />
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

/** The old Log: updates, recent activity and every coordinator generation. */
function Activity({ o, run, openThread }: { o: Overview; run: Run; openThread: (threadId: string) => void }) {
  const p = o.project;
  return (
    <>
      <h2 className="cr-section-heading">Updates</h2>
      {o.updates.length ? (
        o.updates.map((u) => (
          <Fold key={u.ref} title={u.summary} meta={<Age at={u.createdAt} />}>
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
          <button onClick={() => openThread(g.threadId)}>Open coordinator generation</button>
          <p className="project-meta">
            {g.threadId === p.coordinatorThreadId ? "Current" : "Former"} · {g.runtime}
          </p>
          <p>{p.formerCoordinators.find((f) => f.threadId === g.threadId)?.reason}</p>
        </Fold>
      ))}
    </>
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

// ---- Workers (v9 §10.1): the one place every worker and its child threads are reached.

type WorkerGroup = "needs" | "working" | "waiting" | "done" | "earlier";
/** A worker as the Workers tab shows it: its group, and why, in words from its records. */
interface WorkerView {
  w: WorkerItem;
  group: WorkerGroup;
  /** Amber (warn) or red (error) rows say why from recorded text. */
  tone: "warn" | "error" | null;
  status: string;
  why: string;
  /** What its descendants are doing, as the server's cache knows it. */
  waiting: WorkerWaiting | null;
  /** When its open work started, or when it last reported. */
  since: number | null;
}
const BUSY_THREAD = new Set(["active", "starting", "stopping"]);
const FAILED_THREAD = new Set(["error", "failed"]);
const firstLine = (text: string) => text.trim().split("\n")[0]!.trim();
const childStatus = (status: string) => (status === "active" ? "running" : status);
/** Until the cache has listed its whole tree, a quiet-looking worker may still be waiting on a child. */
const UNCHECKED = " · child threads not checked yet";

function workerView(w: WorkerItem, waiting: WorkerWaiting | null, openSince: number | null): WorkerView {
  const report = w.latestReport;
  const live = waiting?.on ?? null;
  const unchecked = waiting && !waiting.checked ? UNCHECKED : "";
  const base = { w, waiting, since: openSince ?? w.since ?? report?.reportedAt ?? null, tone: null };
  if (w.state === "retired")
    return { ...base, group: "earlier", status: "Retired", why: report ? `Last report: ${report.outcome} · ${firstLine(report.summary)}` : "Retired" };
  if (FAILED_THREAD.has(w.runtime))
    return { ...base, group: "needs", tone: "error", status: "Thread failed", why: `Thread failed${w.stopReason ? `: ${w.stopReason}` : ""}` };
  if (BUSY_THREAD.has(w.runtime))
    return { ...base, group: "working", status: "Running", why: `Running · ${w.area}` };
  if (live) {
    const line = `Waiting on “${live.title}” (${childStatus(live.running)} ${compactAge(live.since)})`;
    return { ...base, group: "waiting", status: line, why: line };
  }
  if (!w.open && report?.outcome === "done")
    return { ...base, group: "done", status: "Reported done", why: `Reported done · ${firstLine(report.summary)}${unchecked}` };
  if (!w.open && report) {
    const word = report.outcome === "failed" ? "Failed" : "Blocked";
    return { ...base, group: "needs", tone: report.outcome === "failed" ? "error" : "warn", status: word, why: `${word}: ${firstLine(report.question ?? report.summary)}` };
  }
  const idle = w.stopReason ? `Stopped: ${w.stopReason}` : `Idle without a report${w.runtime === "idle" ? "" : ` · thread ${w.runtime}`}${unchecked}`;
  return { ...base, group: "needs", tone: "warn", status: idle, why: idle };
}

const prNumber = (url: string) => /\/pull\/(\d+)/.exec(url)?.[1] ?? null;
/** "anthropic / claude-opus-5-5 / high / …" → "Opus 5.5"; other models keep their id. */
export function modelName(profile: string | null) {
  if (!profile) return null;
  const parts = profile.split(" / ");
  const model = parts[1] ?? parts[0]!;
  const known = /^(?:claude-)?(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/i.exec(model);
  return known ? `${known[1]![0]!.toUpperCase()}${known[1]!.slice(1)} ${known[2]}${known[3] ? `.${known[3]}` : ""}` : model;
}
export const tokenCount = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);

const GROUPS: [WorkerGroup, string][] = [
  ["needs", "Needs you"],
  ["working", "Working"],
  ["waiting", "Waiting"],
  ["done", "Done · PR waiting"],
];

function Workers({
  o,
  run,
  openThread,
  readHandoff,
  loadChildren,
  selected,
  select,
}: {
  o: Overview;
  run: Run;
  openThread: (threadId: string) => void;
  readHandoff?: (ref: string) => Promise<string | null>;
  loadChildren?: LoadChildren;
  selected: string | null;
  select: (ref: string | null) => void;
}) {
  const since = new Map<string, number>();
  for (const a of o.inFlight) since.set(a.owner.worker, Math.min(since.get(a.owner.worker) ?? Infinity, a.since));
  const views = [...o.workers.current, ...o.workers.retired].map((w) =>
    workerView(w, o.workerWaiting?.[w.ref] ?? null, since.get(w.ref) ?? null));
  const by = (group: WorkerGroup) => views.filter((v) => v.group === group);
  const count = (group: WorkerGroup) => by(group).length;
  const tokens = o.workers.current.reduce((sum, w) => sum + (w.tokens ?? 0), 0);
  const summary = [
    count("working") ? `${count("working")} working` : null,
    count("waiting") ? `${count("waiting")} waiting on a child` : null,
    count("needs") ? `${count("needs")} need${count("needs") === 1 ? "s" : ""} you` : null,
    count("done") ? `${count("done")} done` : null,
    tokens ? `${tokenCount(tokens)} tokens` : null,
  ].filter(Boolean).join(" · ");
  const open = views.find((v) => v.w.ref === selected) ?? null;
  const row = (v: WorkerView) => (
    <WorkerRow key={v.w.ref} projectId={o.project.id} v={v} selected={v.w.ref === selected} select={() => select(v.w.ref)} openThread={openThread} loadChildren={loadChildren} />
  );
  return (
    <div className="cr-split-view" data-detail={open ? "open" : "closed"}>
      <div className="cr-w-list">
        {views.length ? <p className="cr-lede">{summary || "No current workers"}</p> : null}
        {GROUPS.map(([group, title]) =>
          count(group) ? (
            <section key={group} aria-label={title}>
              <h2 className="cr-section-heading">{title} <span className="cr-count">{count(group)}</span></h2>
              <ul className="cr-w-rows">{by(group).map(row)}</ul>
            </section>
          ) : null,
        )}
        {o.historyLoaded === false ? <p className="project-muted">Loading earlier workers…</p> : count("earlier") ? (
          <details className="cr-earlier">
            <summary>Earlier <span className="cr-count">{count("earlier")}</span></summary>
            <section aria-label="Earlier">
              <ul className="cr-w-rows">{by("earlier").map(row)}</ul>
            </section>
          </details>
        ) : null}
        {!views.length && o.historyLoaded !== false ? <p className="cr-empty">No workers yet.</p> : null}
      </div>
      {open ? (
        <WorkerDetail v={open} o={o} run={run} openThread={openThread} readHandoff={readHandoff} loadChildren={loadChildren} close={() => select(null)} />
      ) : null}
    </div>
  );
}

function WorkerRow({ projectId, v, selected, select, openThread, loadChildren }: {
  projectId: string;
  v: WorkerView;
  selected: boolean;
  select: () => void;
  openThread: (threadId: string) => void;
  loadChildren?: LoadChildren;
}) {
  const { w } = v;
  // Its child threads are one click away; a worker waiting on one shows them open.
  const [showChildren, setShowChildren] = useState(v.group === "waiting");
  const pr = w.prs[0];
  const number = pr ? prNumber(pr.url) : null;
  const model = modelName(w.profile);
  return (
    <li className="cr-w" data-group={v.group} data-tone={v.tone ?? undefined} aria-current={selected || undefined}>
      <div className="cr-w-line">
        <button type="button" className="cr-w-main" onClick={select} aria-label={`${w.ref} ${w.label}`} aria-pressed={selected}>
          <span className="cr-w-head">
            <span className="cr-w-dot" aria-hidden="true" />
            <span className="cr-ref">{w.ref}</span>
            <span className="cr-w-label">{w.label}</span>
            {w.kind ? <span className="cr-chip-tag">{w.kind}</span> : null}
            {w.lead ? <span className="cr-chip-tag cr-chip-tag--from">from {w.lead}</span> : null}
            <span className="cr-w-facts">
              {number ? <span className="cr-w-pr" title={pr!.stage ?? undefined}>#{number}</span> : null}
              {model ? <span title={w.profile ?? undefined}>{model}</span> : null}
              {v.since ? <Age at={v.since} /> : null}
              {w.tokens ? <span className="cr-w-tokens">{tokenCount(w.tokens)}</span> : null}
            </span>
          </span>
          <span className="cr-w-why">{v.why}</span>
        </button>
        {w.threadId ? (
          <button type="button" className="cr-iconbtn" aria-label={`Open ${w.ref}'s thread`} title={`Open ${w.ref}'s thread`} onClick={() => openThread(w.threadId!)}>
            <Glyph name="open" />
          </button>
        ) : null}
      </div>
      {w.threadId && loadChildren && w.state !== "retired" ? (
        <>
          <button type="button" className="cr-w-fold" aria-expanded={showChildren} onClick={() => setShowChildren(!showChildren)}>
            Child threads
          </button>
          {showChildren ? <ChildTree projectId={projectId} threadId={w.threadId} load={loadChildren} openThread={openThread} /> : null}
        </>
      ) : null}
    </li>
  );
}

/** One page of a thread's BB children, from the server's cache (childPage). */
export type LoadChildren = (threadId: string, offset: number) => Promise<Cached<ChildPage>>;

type ChildTreeData = { rows: WorkerChild[]; next: number | null; status: Cached<ChildPage>["status"]; error: string | null; pages: number };

/**
 * A thread's BB child threads (reviewers, helpers, theirs) a page at a time: title · provider ·
 * status and age. Each child opens its own children the same way, so every descendant is
 * reachable however many there are. It refreshes like the rest of the dashboard (useData) and
 * re-reads every page it opened, so new children show and statuses move while it is open; the
 * count of opened pages lives in the shared entry, so every tree of a thread shows the same.
 */
function ChildTree({ projectId, threadId, load, openThread }: { projectId: string; threadId: string; load: LoadChildren; openThread: (threadId: string) => void }) {
  const key = `children:${threadId}:${projectId}`;
  const read = (pages: number) => async (): Promise<ChildTreeData> => {
    const rows: WorkerChild[] = [];
    let next: number | null = 0;
    for (let n = 0; n < pages && next !== null; n++) {
      const page = await load(threadId, next);
      if (page.status !== "ready") return { rows, next, status: page.status, error: page.status === "failed" ? page.error : null, pages };
      rows.push(...page.value.rows);
      next = page.value.next;
    }
    return { rows, next, status: "ready", error: null, pages };
  };
  // Read at call time: a refresh started by an older render still reads every page opened since.
  const state = useData(key, () => read((appReads.entry(key).data as ChildTreeData | null)?.pages ?? 1)());
  const tree = state.data;
  // The new count is saved before the read, so every refresh from now on reads that page too,
  // a realtime one replacing this one within the debounce included.
  const more = () => {
    if (tree) appReads.seed(key, { ...tree, status: "loading", pages: tree.pages + 1 });
    state.schedule();
  };
  const error = tree?.status === "failed" ? tree.error : state.error;
  return (
    <>
      {tree?.rows.length ? (
        <ul className="cr-w-children" aria-label="Child threads">
          {tree.rows.map((c) => <ChildRow key={c.threadId} projectId={projectId} c={c} load={load} openThread={openThread} />)}
        </ul>
      ) : null}
      {!tree || tree.status === "loading" ? <p role="status" className="project-muted">Loading child threads…</p> : null}
      {error ? (
        <p role="alert" className="project-error">
          Couldn’t read child threads: {error}{tree?.rows.length ? " (more may exist)" : ""}.{" "}
          <button type="button" className="cr-link" onClick={() => void state.refresh()}>Retry</button>
        </p>
      ) : null}
      {tree?.status === "ready" && tree.next !== null ? (
        <button type="button" className="cr-w-fold" onClick={more}>More child threads</button>
      ) : null}
      {tree?.status === "ready" && !tree.rows.length ? <p className="project-muted">No child threads.</p> : null}
    </>
  );
}

function ChildRow({ projectId, c, load, openThread }: { projectId: string; c: WorkerChild; load: LoadChildren; openThread: (threadId: string) => void }) {
  const [open, setOpen] = useState(false);
  const status = c.archived ? "archived" : childStatus(c.running ?? c.status);
  return (
    <li>
      <button type="button" className="cr-w-child" data-live={c.running ? true : undefined} aria-label={`Open ${c.title}`} title={`Open ${c.title}`} onClick={() => openThread(c.threadId)}>
        <span className="cr-w-child-mark" aria-hidden="true" />
        <span className="cr-w-dot" aria-hidden="true" />
        <span className="cr-w-child-title">{c.title}</span>
        <span className="cr-w-child-meta">
          {c.providerId ? `${c.providerId} · ` : ""}{status} {compactAge(c.updatedAt)}
        </span>
      </button>
      <button type="button" className="cr-w-fold" aria-expanded={open} aria-label={`${c.title}'s child threads`} onClick={() => setOpen(!open)}>
        {open ? "Hide its child threads" : "Its child threads"}
      </button>
      {open ? <ChildTree projectId={projectId} threadId={c.threadId} load={load} openThread={openThread} /> : null}
    </li>
  );
}

function WorkerDetail({ v, o, run, openThread, readHandoff, loadChildren, close }: {
  v: WorkerView;
  o: Overview;
  run: Run;
  openThread: (threadId: string) => void;
  readHandoff?: (ref: string) => Promise<string | null>;
  loadChildren?: LoadChildren;
  close: () => void;
}) {
  const { w } = v;
  const report = w.latestReport;
  const tasks = o.tasks.filter((t) => t.workers.includes(w.ref));
  const retired = w.state === "retired";
  return (
    <section className="cr-w-detail" data-group={v.group} data-tone={v.tone ?? undefined} aria-label={`${w.ref} details`}>
      <button type="button" className="cr-back" onClick={close}>‹ Workers</button>
      <header className="cr-w-detail-head">
        <p className="cr-w-detail-status">
          <span className="cr-ref">{w.ref}</span>
          <span className="cr-w-dot" aria-hidden="true" />
          <span className="cr-w-detail-why">{v.group === "needs" ? v.why : v.status}</span>
          <span className="cr-w-from">from {w.lead ?? "Coordinator"}</span>
          <button type="button" className="cr-iconbtn cr-w-close" aria-label="Close details" onClick={close}><Glyph name="close" /></button>
        </p>
        <h2>{w.label}</h2>
        <p className="cr-w-detail-meta">
          {[modelName(w.profile), w.kind, w.role === "review" ? "reviewer" : null, w.tokens ? `${tokenCount(w.tokens)} tokens` : null].filter(Boolean).join(" · ")}
        </p>
        <div className="project-actions">
          {w.threadId ? <button className="project-primary" onClick={() => openThread(w.threadId!)}>Open thread</button> : null}
          {!retired ? (
            <ReasonAction label="Stop" run={run} make={(reason) => ({ action: "worker-stop", worker: w.ref, reason })} refusal={stillRunning} />
          ) : null}
          {!retired ? (
            <ReasonAction label="Retire" run={run} make={(reason) => ({ action: "worker-retire", worker: w.ref, reason })} />
          ) : null}
        </div>
      </header>
      {w.area ? (
        <div className="cr-card">
          <h3 className="cr-card-title">Purpose</h3>
          <p>{w.area}</p>
        </div>
      ) : null}
      {report ? (
        <div className="cr-card">
          <h3 className="cr-card-title">Latest report <span className="cr-ref">{report.ref}</span> {report.reportedAt ? <Age at={report.reportedAt} /> : null}</h3>
          <p className={`cr-report-outcome cr-report-outcome--${report.outcome}`}>{report.outcome === "done" ? "Done" : report.outcome === "failed" ? "Failed" : "Blocked"}</p>
          {report.question ? <p className="cr-report-question">{report.question}</p> : null}
          <FinalMessage text={report.summary} />
          {report.preSwitch ? <p className="project-meta">{report.preSwitch}</p> : null}
        </div>
      ) : null}
      {w.prs.length ? (
        <div className="cr-card">
          <h3 className="cr-card-title">Pull requests</h3>
          <ul className="cr-plain-list">
            {w.prs.map((pr) => (
              <li key={pr.url}>
                <a className="cr-worker-link" href={pr.url} target="_blank" rel="noreferrer">#{prNumber(pr.url) ?? pr.url}</a>
                {pr.stage ? <span className="project-meta"> · {pr.stage.replaceAll("-", " ")}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {tasks.length ? (
        <div className="cr-card">
          <h3 className="cr-card-title">Tasks</h3>
          <ul className="cr-plain-list">
            {tasks.map((t) => (
              <li key={t.ref}>
                <span className="cr-ref">{t.ref}</span> {t.title} <span className="project-meta">· {statusWord(t.status)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {w.threadId && loadChildren ? (
        <div className="cr-card">
          <h3 className="cr-card-title">Child threads</h3>
          <ChildTree projectId={o.project.id} threadId={w.threadId} load={loadChildren} openThread={openThread} />
        </div>
      ) : null}
      {w.lastHandoff ? <HandoffActions assignment={w.lastHandoff} readHandoff={readHandoff} /> : null}
    </section>
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
      main={<button type="button" disabled={!!busy} title="Leave the coordinator to settle it; nothing is sent. Undo from Archive."
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


const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/**
 * W460: Dismiss all, for an Inbox already settled elsewhere. Every question shown closes
 * quietly and every blocker is dismissed without a message, as their own buttons do. The
 * confirm counts what is on screen and only those items are sent; anything arriving
 * meanwhile stays. Not delivered items have no quiet close (each needs a send, a retry or
 * a removal), so they stay too.
 */
function DismissAll({ questions, blockers, left, run }: { questions: OpinionItem[]; blockers: BlockerItem[]; left: number; run: Run }) {
  const [seen, setSeen] = useState<Extract<Command, { action: "inbox-dismiss-all" }> | null>(null);
  const write = useWrite();
  if (!seen) return (
    <div className="cr-toolbar cr-inbox-tools">
      <button type="button" onClick={() => setSeen({
        action: "inbox-dismiss-all",
        questions: questions.map((q) => q.ref),
        blockers: blockers.map(({ assignment, question, context }) => ({ assignment, question, context })),
      })}>Dismiss all</button>
    </div>
  );
  const what = [
    seen.questions.length ? `close ${count(seen.questions.length, "question")} quietly` : null,
    seen.blockers.length ? `dismiss ${count(seen.blockers.length, "blocker")}` : null,
  ].filter(Boolean).join(" and ");
  return (
    <div className="project-card cr-dismiss-all" role="group" aria-label="Dismiss all">
      <p>{what[0]!.toUpperCase() + what.slice(1)}? No answers are recorded and nothing is sent.</p>
      <p className="project-hint">{[
        seen.questions.length ? "Closed questions cannot be reopened." : null,
        seen.blockers.length ? "A dismissed blocker comes back with Undo in Archive." : null,
        left ? `${count(left, "undelivered item")} ${left === 1 ? "stays" : "stay"}: each needs its own send, retry or removal.` : null,
      ].filter(Boolean).join(" ")}</p>
      <div className="project-actions">
        <button type="button" className="project-primary" disabled={write.busy}
          onClick={async () => { if ((await write.run(() => run(seen))).ok) setSeen(null); }}>
          {write.busy ? "Saving…" : "Dismiss all"}
        </button>
        <button type="button" disabled={write.busy} onClick={() => { write.setError(null); setSeen(null); }}>Cancel</button>
      </div>
      {write.slow ? <p role="status" className="project-muted">{WRITE_SLOW_MESSAGE}</p> : null}
      {write.error ? <p role="alert" className="project-error">{write.error}</p> : null}
    </div>
  );
}

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

// ---- Tasks (v9 §7, §10.3): status follows the work unless set by hand.

const statusWord = (status: string) =>
  status === "in_progress" || status === "awaiting_acceptance" ? "in progress" : status;
const TASK_SECTIONS: { title: string; statuses: string[]; folded: boolean }[] = [
  { title: "In progress", statuses: ["in_progress", "awaiting_acceptance"], folded: false },
  { title: "Blocked", statuses: ["blocked"], folded: false },
  { title: "Planned", statuses: ["planned"], folded: false },
  { title: "Done", statuses: ["done"], folded: true },
  { title: "Cancelled", statuses: ["cancelled"], folded: true },
];
const HAND_REASON = "Set from the Tasks tab.";

function Tasks({ o, run, newTask, showWorker }: {
  o: Overview;
  run: Run;
  newTask: ReactNode;
  showWorker: (ref: string) => void;
}) {
  return (
    <div className="cr-tasks">
      {newTask}
      {TASK_SECTIONS.map(({ title, statuses, folded }) => {
        const items = o.tasks.filter((t) => statuses.includes(t.status));
        if (!items.length) return null;
        const list = (
          <section aria-label={title}>
            {!folded ? <h2 className="cr-section-heading">{title} <span className="cr-count">{items.length}</span></h2> : null}
            {items.map((t) => <TaskRow key={t.ref} t={t} run={run} showWorker={showWorker} />)}
          </section>
        );
        return folded ? (
          <details key={title} className="cr-earlier">
            <summary>{title} <span className="cr-count">{items.length}</span></summary>
            {list}
          </details>
        ) : <div key={title}>{list}</div>;
      })}
      {o.historyLoaded === false ? <p role="status" className="project-muted">Loading done and cancelled tasks…</p> : null}
      {!o.tasks.length && o.historyLoaded !== false ? <p className="cr-empty">No tasks yet.</p> : null}
    </div>
  );
}

function TaskRow({ t, run, showWorker }: {
  t: TaskItem;
  run: Run;
  showWorker: (ref: string) => void;
}) {
  const set = (status: "planned" | "cancelled" | "done" | "auto"): Command => ({ action: "task-status", task: t.ref, status, reason: HAND_REASON });
  // A hand-set status says so, whatever the reason line already holds.
  const reason = t.setByHand && !/by hand/i.test(t.statusReason) ? [t.statusReason, "set by hand"].filter(Boolean).join(" · ") : t.statusReason;
  return (
    <details className="cr-task" data-status={t.status}>
      <summary>
        <span className="cr-ref">{t.ref}</span>
        <span className="cr-task-title">{t.title}</span>
        <span className="cr-pill" data-status={t.status}>{statusWord(t.status)}</span>
        <span className="cr-task-why">
          {reason || "—"}
          {t.workers.length ? <span className="cr-task-workers"> · {t.workers.join(", ")}</span> : null}
        </span>
      </summary>
      <div className="cr-task-detail">
        <p className="project-meta">Status follows its work and PRs, unless you set it by hand.</p>
        {t.workers.length ? (
          <p className="cr-task-links">
            {t.workers.map((ref) => (
              <button key={ref} type="button" className="cr-link" onClick={() => showWorker(ref)}>{ref}</button>
            ))}
          </p>
        ) : null}
        <div className="project-actions">
          {t.status !== "cancelled" ? <Action run={run} command={set("cancelled")} refusal={stillRunning}>Cancel task</Action> : null}
          {t.status !== "done" ? <Action run={run} command={set("done")}>Mark done</Action> : null}
          {t.status !== "planned" ? <Action run={run} command={set("planned")}>Mark planned</Action> : null}
          {t.setByHand ? (
            <Action run={run} command={set("auto")} title="Clear the hand-set status; it follows its work and PRs again.">Follow the work</Action>
          ) : null}
        </div>
        <TaskEdit task={{ ref: t.ref, title: t.title, summary: t.summary }} run={run} />
      </div>
    </details>
  );
}

// ---- Rules (D523): the standing rules every lead tab and worker gets.

function Rules({ o, run, openArchive }: { o: Overview; run: Run; openArchive: () => void }) {
  const [adding, setAdding] = useState(false);
  return (
    <section className="cr-rules" aria-label="Standing rules">
      <h2 className="cr-section-heading cr-rules-head">
        Standing rules <span className="cr-rules-count">{o.rules.length} / {MAX_RULES}</span>
      </h2>
      {o.rules.length ? (
        <ol className="cr-rule-list">
          {o.rules.map((rule, index) => (
            <RuleRow key={rule.ref} rule={rule} index={index} last={index === o.rules.length - 1} run={run} />
          ))}
        </ol>
      ) : (
        <p className="cr-lede">No standing rules yet.</p>
      )}
      {adding ? (
        <RuleForm label="New rule" initial="" save={(text) => run({ action: "rule-add", text })} close={() => setAdding(false)} />
      ) : o.rules.length < MAX_RULES ? (
        <button type="button" className="cr-add-box" onClick={() => setAdding(true)}>+ Add rule</button>
      ) : null}
      <p className="cr-lede">
        Every lead tab and worker gets these: in briefs, work messages and each coordinator’s first message; a change is
        announced to live lead tabs and workers with open work.
      </p>
      <button type="button" className="cr-link cr-archive-link" onClick={openArchive}>
        Archive{o.historyLoaded ? `: ${o.decisions.length} earlier decisions and closed questions` : ": earlier decisions and closed questions"} (read-only) →
      </button>
    </section>
  );
}

function RuleRow({ rule, index, last, run }: {
  rule: Overview["rules"][number];
  index: number;
  last: boolean;
  run: Run;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "delete">("view");
  const write = useWrite();
  const act = (command: Command) => void write.run(() => run(command));
  if (mode === "edit")
    return (
      <li className="cr-rule">
        <span className="cr-ref">{rule.ref}</span>
        <RuleForm label={`Edit ${rule.ref}`} initial={rule.text} save={(text) => run({ action: "rule-edit", rule: rule.ref, text })} close={() => setMode("view")} />
      </li>
    );
  return (
    <li className="cr-rule">
      <span className="cr-ref">{rule.ref}</span>
      <div className="cr-rule-text">
        <p>{rule.text}</p>
        {rule.sources.length ? <p className="cr-rule-sources">from {rule.sources.join(", ")}</p> : null}
        {mode === "delete" ? (
          <div className="project-actions">
            <span>Delete {rule.ref}?</span>
            <button type="button" disabled={write.busy} onClick={() => act({ action: "rule-remove", rule: rule.ref })}>{write.busy ? "Deleting…" : "Delete"}</button>
            <button type="button" onClick={() => setMode("view")}>Keep</button>
          </div>
        ) : null}
        {write.error ? <p role="alert" className="project-error">{write.error}</p> : null}
      </div>
      <div className="cr-rule-actions">
        <button type="button" className="cr-iconbtn" aria-label={`Move ${rule.ref} up`} disabled={index === 0 || write.busy} onClick={() => act({ action: "rule-move", rule: rule.ref, to: index })}><Glyph name="up" /></button>
        <button type="button" className="cr-iconbtn" aria-label={`Move ${rule.ref} down`} disabled={last || write.busy} onClick={() => act({ action: "rule-move", rule: rule.ref, to: index + 2 })}><Glyph name="down" /></button>
        <button type="button" className="cr-iconbtn" aria-label={`Edit ${rule.ref}`} onClick={() => setMode("edit")}><Glyph name="edit" /></button>
        <button type="button" className="cr-iconbtn" aria-label={`Delete ${rule.ref}`} onClick={() => setMode("delete")}><Glyph name="close" /></button>
      </div>
    </li>
  );
}

/** One line, one or two sentences: Enter saves, Escape cancels. */
function RuleForm({ label, initial, save, close }: {
  label: string;
  initial: string;
  save: (text: string) => Promise<unknown>;
  close: () => void;
}) {
  const [text, setText] = useState(initial);
  const write = useWrite();
  const clean = text.replace(/\s+/g, " ").trim();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!clean || write.busy) return;
    const done = await write.run(() => save(clean));
    if (done.ok) close();
  };
  return (
    <form className="cr-rule-form" onSubmit={submit}>
      <input
        aria-label={label}
        value={text}
        autoFocus
        maxLength={RULE_MAX_CHARACTERS}
        placeholder="One or two sentences."
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } }}
      />
      <div className="project-actions">
        <button className="project-primary" disabled={!clean || write.busy}>{write.busy ? "Saving…" : "Save rule"}</button>
        <button type="button" onClick={close}>Cancel</button>
        <span className="cr-rule-limit">{clean.length} / {RULE_MAX_CHARACTERS}</span>
      </div>
      {write.slow ? <p role="status" className="project-muted">{WRITE_SLOW_MESSAGE}</p> : null}
      {write.error ? <p role="alert" className="project-error">{write.error}</p> : null}
    </form>
  );
}

// ---- Archive: the decision record, read-only (v9 §6: no veto, no review).

type DecisionRow = Overview["decisions"][number];
const owner = (d: DecisionRow) =>
  d.madeBy === "user" ? "Yours" : d.recordedBy.author === "worker" ? "Worker" : "Coordinator";

/** One decision: its text first, then who made it and when, with any delivery that still needs a retry. */
function DecisionItem({ d, run, answer }: { d: DecisionRow; run: Run; answer?: Overview["answered"][number] }) {
  const [full, setFull] = useState(false);
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
        <button className="cr-iconbtn cr-caret" aria-label={`Show all of ${d.ref}`} aria-expanded={full} onClick={() => setFull(!full)}>
          <Glyph name="down" />
        </button>
      </div>
    </article>
  );
}

const decisionFilters = [["all", "All"], ["agent", "Agents"], ["user", "Yours"]] as const;
/** The full record of choices, newest first, separable by who made them; read-only. */
function Archive({ o, run }: { o: Overview; run: Run }) {
  const [filter, setFilter] = useState<(typeof decisionFilters)[number][0]>("all");
  const answers = new Map(o.answered.map(a => [a.ref, a]));
  const shown = [...o.decisions].reverse().filter(d => filter === "all" || d.madeBy === filter);
  return (
    <section className="cr-decisions" aria-label="Archive">
      <div className="cr-toolbar">
        <p className="cr-lede">Earlier decisions, facts and closed questions. Standing rules live on the Rules tab.</p>
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
    </section>
  );
}

function TaskEdit({ task, run }: { task: { ref: string; title: string; summary: string }; run: Run }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [summary, setSummary] = useState(task.summary);
  return open ? (
    <div>
      <label className="project-field">
        Task title
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
      </label>
      <label className="project-field">
        Task summary
        <AutoTextarea value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={2000} />
      </label>
      <div className="project-actions">
        {title.trim() ? (
          <Action
            run={run}
            command={{ action: "task-update", task: task.ref, title: title.trim(), ...(summary.trim() ? { summary: summary.trim() } : {}) }}
          >
            Save task
          </Action>
        ) : (
          <button disabled>Save task</button>
        )}
        <button onClick={() => setOpen(false)}>Done</button>
      </div>
    </div>
  ) : (
    <button className="cr-link" onClick={() => setOpen(true)}>Edit task</button>
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
