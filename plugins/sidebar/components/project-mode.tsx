import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  DndContext,
  DragOverlay,
  useDraggable,
  useDroppable,
} from "@dnd-kit/core";
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  useBbNavigate,
  UrlLink,
  useRpc,
  useRealtime,
  useRealtimeConnectionState,
  experimental_useSidebarThreads,
} from "@get-bb/plugin-sdk/app";
import type { projectModeContract } from "../lib/project-mode-contract";
import { INITIATIVES_CHANGED, INITIATIVES_PANEL } from "../lib/project-mode-names";
import type { ProjectTree } from "../lib/project-tree-schema";
import { OTHER_THREADS, updateState, useClientState } from "../lib/client-state";
import { STATUS_LABEL, type Status } from "../lib/status";
import {
  lastActivity,
  needsYou,
  orderedProjects,
  owningProject,
  projectStatus,
  projectThreads,
} from "../lib/project-mode-status";
import {
  PROJECT_ORDER_CHANNEL,
  projectOrderDocSchema,
} from "../lib/project-order-schema";
import { moveItem, useProjectOrder } from "../lib/use-project-order";
import { useReorderDnd } from "../lib/use-reorder-dnd";
import { useLongPressMenu } from "../lib/use-long-press-menu";
import { usePortalScopeProps } from "../lib/portal-scope";
import { relativeAge } from "../lib/time";
import { StatusIcon } from "./status-icon";
import { appearanceHueStep, appearanceIcon } from "../lib/project-hue";
import { ProjectAppearanceEditor, type AppearancePatch } from "./project-appearance";
import { HostIcon } from "../lib/host-icon";
import { ThreadDragOverlay } from "./thread-drag-overlay";
import { menuItemClass, WorkerListingMenu } from "./menus";
import { SectionHeader, sectionActionClass } from "./section-header";
import { CreateInitiativeDialog } from "./create-initiative";
import {
  dismissNotice,
  dismissSubmission,
  newDraft,
  resumeSubmissions,
  submitDraft,
  useSubmissions,
  type CreateInitiative,
  type InitiativeDraft,
} from "../lib/initiative-submissions";
import { projectLabel } from "../lib/project-schema";
import { AdventureWorkers } from "./adventure-workers";
import {
  cacheTree,
  cacheWorkers,
  cachedTree,
  cachedWorkers,
  type WorkerFacts,
} from "../lib/initiative-tree-cache";
import { ReadTimeoutError, claimReport, withReadTimeout } from "../lib/read-timeout";
import { askAncestry, useHostLinks } from "../lib/thread-ancestry";

type TreeProject = ProjectTree["projects"][number];

/** The Other threads list, built by the thread list, for the section below the picker. */
export interface OtherThreads {
  /** The most urgent status among its threads, or null. */
  status: Status | null;
  /** The list options and New thread, for the section header. */
  actions: ReactNode;
  list: ReactNode;
}

/**
 * A created Adventure, picked when its create answered, and the thread open
 * then. While that thread stays open, a later read (the tree, a thread's
 * ancestry) that finds where the thread belongs leaves the pick alone; opening
 * another thread, or another pick in any tab, ends it. The pick is stored
 * once, and the picker shows it as soon as the tree lists it.
 */
let createdPick: { projectId: string; openThread: string | null } | null = null;
const select = (selected: string) => {
  createdPick = null;
  updateState((current) => ({ ...current, selected }));
};

/**
 * The Adventures picker at the top of the sidebar, then what it selected.
 * The picker is one dense row per Adventure (icon, name, status, last
 * activity) with drag reordering, the Adventures being created, then an
 * Other threads entry; the header's + starts a new Adventure. Below it, one
 * section lists the selection: the Adventure's coordinator and workers, or
 * every thread outside the Adventures. Opening a thread of an Adventure
 * selects it; with nothing picked yet the first Adventure is. The last tree
 * and worker facts are cached, so both draw at once and refresh in the
 * background.
 */
export function AdventuresSection(props: {
  activeThreadId: string | null;
  activeProjectId: string | null;
  onNavigate: () => void;
  otherThreads: OtherThreads;
}) {
  const navigate = useBbNavigate();
  const api = useRpc<typeof projectModeContract>();
  const native = experimental_useSidebarThreads();
  const connection = useRealtimeConnectionState();
  // The cache stands in until the first read answers; only a read updates it.
  const [cached] = useState(cachedTree);
  const [tree, setTree] = useState<ProjectTree | null>(cached);
  const [fresh, setFresh] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(
    cached ? true : null,
  );
  const [error, setError] = useState<string | null>(null);
  const report = (cause: unknown) =>
    setError(cause instanceof Error ? cause.message : String(cause));
  // Each worker's model and group by Adventure, as the server last read them.
  const [facts, setFacts] = useState<WorkerFacts>(cachedWorkers);
  // The selected Adventure, whose worker facts each read asks for.
  const wanted = useRef<string | null>(null);
  const client = useClientState();
  const order = useProjectOrder(api);
  const { applySnapshot, commit } = order;
  const apiRef = useRef(api); apiRef.current = api;
  const applyRef = useRef(applySnapshot); applyRef.current = applySnapshot;
  const mounted = useRef(false);
  const pending = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Refreshes are conditional: an unchanged tree comes back as a few bytes
  // and keeps the current tree object, so nothing re-renders for it.
  const revision = useRef<string | null>(null);
  // A change announced while a read is in flight may postdate what that read
  // returns: BB lists a spawned worker's thread before Initiatives records it,
  // and the Initiatives signal can land during the read that listing started.
  // A scheduled refresh then runs once more after it instead of joining it.
  const again = useRef(false);
  // One missed read stays quiet and reads again at once: it is usually a tab
  // or device that slept, or a stale connection. The current tree stays up
  // either way; the banner shows from the second miss in a row.
  const misses = useRef(0);
  const refresh = useCallback(function read(): Promise<void> {
    if (pending.current) return pending.current;
    const call = withReadTimeout(apiRef.current.call("projectMode", { known: revision.current, ...(wanted.current ? { workersOf: [wanted.current] } : {}) })).then(result => {
      misses.current = 0;
      if (mounted.current) {
        setAvailable(result.available);
        setFresh(true);
        if (!result.unchanged) { setTree(result.tree); revision.current = result.revision ?? null; }
        const workers = result.workers;
        if (workers) setFacts(current => {
          const next = { ...current, ...workers };
          if (JSON.stringify(next) === JSON.stringify(current)) return current;
          cacheWorkers(next);
          return next;
        });
        applyRef.current(result.order, result.orderError); setError(null);
      }
    }, error => {
      if (error instanceof ReadTimeoutError && claimReport())
        void apiRef.current.call("reportReadTimeout", error.report).catch(() => {});
      if (!mounted.current) return;
      if (++misses.current === 1) again.current = true;
      else setError(error instanceof Error ? error.message : String(error));
    })
      .finally(() => {
        if (pending.current === call) pending.current = null;
        if (again.current && mounted.current) { again.current = false; void read(); }
      });
    pending.current = call;
    return call;
  }, []);
  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (!mounted.current) return;
      if (pending.current) again.current = true;
      else void refresh();
    }, 200);
  }, [refresh]);
  useEffect(() => {
    mounted.current = true; void refresh();
    return () => { mounted.current = false; if (timer.current) clearTimeout(timer.current); };
  }, [refresh]);
  useRealtime(PROJECT_ORDER_CHANNEL, payload => {
    const parsed = projectOrderDocSchema.safeParse(payload);
    if (parsed.success) applySnapshot(parsed.data);
  });
  useRealtime(INITIATIVES_CHANGED, schedule);
  const threadSignal = native.threads.map(t => `${t.id}:${t.indicator}:${t.isArchived}:${t.parentThreadId}`).join("|");
  const previousThreads = useRef(native.threads);
  const previousSignal = useRef(threadSignal);
  const previousConnection = useRef(connection);
  const connectedOnce = useRef(connection === "connected");
  useEffect(() => {
    if (previousSignal.current !== threadSignal) {
      const before = new Map(previousThreads.current.map(t => [t.id, t]));
      const after = new Map(native.threads.map(t => [t.id, t]));
      const members = new Set(tree?.projects.flatMap(p => p.nodes.map(n => n.threadId)) ?? []);
      const relevant = [...new Set([...before.keys(), ...after.keys()])].some(id => {
        const a = before.get(id), b = after.get(id);
        const changed = a?.indicator !== b?.indicator || a?.isArchived !== b?.isArchived || a?.parentThreadId !== b?.parentThreadId;
        return changed && (!tree || members.has(id) || !!a?.parentThreadId && members.has(a.parentThreadId) || !!b?.parentThreadId && members.has(b.parentThreadId));
      });
      if (relevant) schedule();
    }
    if (connection === "connected") {
      if (connectedOnce.current && previousConnection.current !== "connected") schedule();
      connectedOnce.current = true;
    }
    previousSignal.current = threadSignal; previousThreads.current = native.threads; previousConnection.current = connection;
  }, [threadSignal, connection, schedule, tree, native.threads]);
  useEffect(() => {
    const interval = setInterval(() => { if (document.visibilityState !== "hidden") schedule(); }, 15000);
    // A tab coming back or a network returning reads at once instead of on
    // the next poll, which a hidden tab skipped.
    const visible = () => { if (document.visibilityState !== "hidden") schedule(); };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("online", schedule);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("online", schedule);
    };
  }, [schedule]);
  const projects = tree?.projects ?? [];
  const displayed = useMemo(
    () => orderedProjects(projects, order.order),
    [projects, order.order],
  );
  // Cache what is on screen, in its displayed order, once a read confirmed it.
  useEffect(() => {
    if (!fresh) return;
    cacheTree(available && tree ? { ...tree, projects: displayed } : null);
  }, [fresh, available, tree, displayed]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  // Each Adventure's threads.
  const rows = useMemo(
    () => displayed.map((p) => ({ p, threads: projectThreads(p, native.threads) })),
    [displayed, native.threads],
  );
  // Opening a thread of an Adventure selects it, once per opening (or once
  // the tree shows where it belongs): a pick made while it stays open sticks.
  // Before paint, so a reload onto a worker never flashes the stored
  // selection first.
  const links = useHostLinks();
  const { owner: holder, unknown } = useMemo(
    () => owningProject(displayed, native.threads, props.activeThreadId, links),
    [displayed, native.threads, props.activeThreadId, links],
  );
  // A pick made since, here or in another tab, ends a created Adventure's.
  useLayoutEffect(() => {
    if (createdPick && client.selected !== createdPick.projectId) createdPick = null;
  }, [client.selected]);
  useLayoutEffect(() => {
    if (createdPick?.openThread === props.activeThreadId) return;
    createdPick = null;
    if (holder) select(holder);
  }, [props.activeThreadId, holder]);
  // A walk that stopped at a thread BB's list omits (an archived reviewer
  // between a worker and the open helper) asks the host for the rest of the
  // chain in the background; each opening asks again after a failed read.
  const missing = native.status === "ready" ? unknown : null;
  useEffect(() => {
    if (missing)
      askAncestry(missing, (threadId) =>
        withReadTimeout(apiRef.current.call("threadAncestry", { threadId })),
      );
  }, [missing, props.activeThreadId]);
  // A stored Adventure that left the tree falls back to the first one; with
  // none (or no Adventures plugin), to Other threads. Null while the first
  // read decides.
  const selection: TreeProject | typeof OTHER_THREADS | null =
    client.selected === OTHER_THREADS
      ? OTHER_THREADS
      : (displayed.find((p) => p.id === client.selected) ??
        displayed[0] ??
        (available === null && !error ? null : OTHER_THREADS));
  const selectedId =
    selection === null || selection === OTHER_THREADS ? null : selection.id;
  wanted.current = selectedId;
  // Selecting an Adventure reads its worker facts.
  const lastSelected = useRef(selectedId);
  useEffect(() => {
    if (selectedId === lastSelected.current) return;
    lastSelected.current = selectedId;
    if (selectedId) schedule();
  }, [selectedId, schedule]);

  const memberChoices = useMemo(
    () =>
      native.projects
        .filter((project) => !project.isPersonal)
        .map((project) => ({ id: project.id, name: projectLabel(project) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [native.projects],
  );
  const [editing, setEditing] = useState<InitiativeDraft | null>(null);
  const { submissions, notice } = useSubmissions();
  // A listed draft's dialog closes once it is created or dismissed, here or
  // in another tab: there is nothing left to send.
  const dialogDraft =
    editing && (editing.key === null || submissions.some((s) => s.key === editing.key))
      ? editing
      : null;
  const openCreate = () =>
    setEditing(
      newDraft(
        memberChoices.some((p) => p.id === props.activeProjectId)
          ? props.activeProjectId
          : null,
      ),
    );
  // The dialog closes at once; the draft shows in the picker while Adventures
  // creates it. A failed one stays there with its reason until sent again or
  // dismissed, and sending it again unchanged keeps its key, so it cannot
  // duplicate. Drafts a reload cut off are sent again once, without opening.
  const create: CreateInitiative = (input) =>
    apiRef.current.call("createInitiative", input);
  // A created Adventure becomes the pick; the picker shows it once the tree
  // lists it.
  const openThread = useRef(props.activeThreadId);
  openThread.current = props.activeThreadId;
  const created = (projectId: string) => {
    select(projectId);
    createdPick = { projectId, openThread: openThread.current };
    schedule();
  };
  useEffect(() => resumeSubmissions(create, (answer) => created(answer.projectId)), []);
  const submit = (draft: InitiativeDraft) => {
    setEditing(null);
    const from = window.location.pathname;
    submitDraft(draft, create, (answer) => {
      created(answer.projectId);
      // Open its coordinator unless the user has moved on to another page
      // meanwhile. Without one yet the new row and the note say what
      // happened.
      if (
        !answer.coordinatorThreadId ||
        !mounted.current ||
        window.location.pathname !== from
      )
        return;
      navigate.toThread(answer.coordinatorThreadId);
      props.onNavigate();
    });
  };

  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const displayIds = useMemo(
    () => displayed.map((project) => project.id),
    [displayed],
  );
  const commitMove = useCallback(
    (from: number, to: number) => {
      const ids = displayIds;
      const next = moveItem(ids, from, to);
      if (next.every((id, index) => id === ids[index])) return;
      commit(next);
    },
    [displayIds, commit],
  );
  const renameProject = useCallback(
    async (projectId: string, name: string) => {
      await api.call("renameTreeProject", { projectId, name });
      schedule();
    },
    [api, schedule],
  );
  const restyleProject = useCallback(
    async (projectId: string, patch: AppearancePatch) => {
      await api.call("setTreeProjectAppearance", { projectId, ...patch });
      schedule();
    },
    [api, schedule],
  );
  const dnd = useReorderDnd(
    {
      onDragStart: (event) => {
        setDragId(String(event.active.id));
      },
      onDragOver: (event) =>
        setOverId(event.over ? String(event.over.id) : null),
      onDragEnd: (event) => {
        setDragId(null);
        setOverId(null);
        const over = event.over ? String(event.over.id) : null;
        if (!over) return;
        commitMove(
          displayIds.indexOf(String(event.active.id)),
          displayIds.indexOf(over),
        );
      },
      onDragCancel: () => {
        setDragId(null);
        setOverId(null);
      },
    },
    { isActive: () => dragId != null, keyboardReorder: true },
  );

  const other = props.otherThreads;
  return (
    <>
      <section aria-label="Adventures" data-project-mode="" className="mt-2">
        <SectionHeader
          title="Adventures"
          trailing={
            available !== false && (
              <button
                type="button"
                aria-label="New Adventure"
                title="New Adventure"
                onClick={openCreate}
                className={sectionActionClass}
              >
                <HostIcon name="Plus" fallback="FolderPlus" className="size-3.5" />
              </button>
            )
          }
        />
        {error && (
          <p role="alert" className="px-2 py-1 text-xs text-destructive">
            {error}{" "}
            <button className="underline" onClick={() => void refresh()}>
              Retry
            </button>
          </p>
        )}
        {order.error && (
          <p role="alert" className="px-2 py-1 text-xs text-destructive">
            Could not save the Adventure order: {order.error}{" "}
            <button className="underline" onClick={order.dismissError}>
              Dismiss
            </button>
          </p>
        )}
        {notice && (
          <p role="status" className="px-2 py-1 text-xs text-muted-foreground">
            {notice}{" "}
            <button className="underline" onClick={dismissNotice}>
              Dismiss
            </button>
          </p>
        )}
        {available === false && (
          <p className="px-2 py-1 text-xs text-muted-foreground">
            Install or enable the Adventures plugin to list Adventures here.
          </p>
        )}
        {available === null && !error && (
          <p className="px-2 py-1 text-xs text-muted-foreground">Loading Adventures…</p>
        )}
        {available && !projects.length && !submissions.length && (
          <p className="px-2 py-1 text-xs text-muted-foreground">
            No Adventures yet.{" "}
            <button type="button" className="underline" onClick={openCreate}>
              Start one
            </button>
          </p>
        )}
        <DndContext {...dnd.dndContextProps}>
          <ul
            aria-label="Adventures"
            className="m-0 list-none p-0"
            onClickCapture={dnd.onClickCapture}
            onKeyDown={dnd.onEscape}
          >
            {rows.map(({ p, threads }) => {
              const status = projectStatus(p, threads, client.drafts);
              const coordinator = p.nodes.find(
                (n) => n.role === "coordinator",
              );
              const activity = lastActivity(threads);
              const summary = [
                needsYou(p) ? `${needsYou(p)} need${needsYou(p) === 1 ? "s" : ""} you` : null,
                p.inFlight ? `${p.inFlight} in flight` : null,
                p.remaining ? `${p.remaining} remaining` : null,
                p.revisit ? `${p.revisit} to revisit` : null,
                p.paused ? "Paused" : null,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <ProjectRow
                  key={p.id}
                  project={p}
                  href={
                    p.coordinatorThreadId && coordinator
                      ? `/projects/${coordinator.bbProjectId}/threads/${p.coordinatorThreadId}`
                      : `${INITIATIVES_PANEL}/${p.id}`
                  }
                  canReorder={displayed.length > 1}
                  selected={p.id === selectedId}
                  status={status}
                  summary={summary}
                  age={activity === null ? null : relativeAge(activity, now)}
                  dropTarget={overId === p.id && dragId !== p.id}
                  onOpen={(event) => {
                    if (
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey ||
                      event.button !== 0
                    )
                      return;
                    if (dnd.consumeClickSuppression()) {
                      event.preventDefault();
                      return;
                    }
                    select(p.id);
                    if (p.coordinatorThreadId) {
                      event.preventDefault();
                      navigate.toThread(p.coordinatorThreadId);
                    }
                    props.onNavigate();
                  }}
                  onOverview={props.onNavigate}
                  onRename={(name) => renameProject(p.id, name)}
                  onAppearance={(patch) => restyleProject(p.id, patch)}
                  onNewThread={props.onNavigate}
                  onMenuOpen={() => {
                    dnd.consumeClickSuppression();
                  }}
                />
              );
            })}
            {submissions.map(({ key, draft, error: failure }) => (
              <li
                key={key}
                data-initiative-submission={failure ? "failed" : "pending"}
                className="flex min-h-7 items-center gap-2 rounded-md px-2 py-1 text-[13px] leading-5"
              >
                <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center text-[var(--subtle-foreground)]">
                  <HostIcon
                    name={failure ? "AlertCircle" : "Loading"}
                    fallback="Circle"
                    className={`size-3.5 ${failure ? "text-destructive" : "animate-spin"}`}
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-muted-foreground">
                    {draft.name}
                  </span>
                  {failure && (
                    <span role="alert" className="block text-xs text-destructive">
                      {failure}
                    </span>
                  )}
                </span>
                {failure ? (
                  <>
                    <button
                      type="button"
                      className="shrink-0 text-xs underline"
                      onClick={() => setEditing({ key, ...draft })}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      aria-label={`Dismiss ${draft.name}`}
                      className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => dismissSubmission(key)}
                    >
                      <HostIcon name="X" className="size-3.5" />
                    </button>
                  </>
                ) : (
                  <span className="shrink-0 text-xs text-[var(--subtle-foreground)]">
                    Creating…
                  </span>
                )}
              </li>
            ))}
          </ul>
          <DragOverlay dropAnimation={null}>
            {dragId ? (
              <ThreadDragOverlay
                title={
                  displayed.find((p) => p.id === dragId)?.name ?? "Adventure"
                }
              />
            ) : null}
          </DragOverlay>
        </DndContext>
        <OtherThreadsEntry
          selected={selection === OTHER_THREADS}
          status={other.status}
        />
        <CreateInitiativeDialog
          draft={dialogDraft}
          projects={memberChoices}
          onSubmit={submit}
          onClose={() => setEditing(null)}
        />
      </section>
      {selection === OTHER_THREADS ? (
        <section aria-label="Other threads" className="mt-2">
          <SectionHeader title="Other threads" trailing={other.actions} />
          {other.list}
        </section>
      ) : (
        selection && (
          <section aria-label={`${selection.name} workers`} className="mt-2">
            <SectionHeader title={selection.name} trailing={<WorkerListingMenu />} />
            <AdventureWorkers
              key={selection.id}
              project={selection}
              facts={facts[selection.id]}
              activeThreadId={props.activeThreadId}
              onNavigate={props.onNavigate}
              onError={report}
            />
          </section>
        )
      )}
    </>
  );
}

/**
 * The picker's last entry, below the Adventures: every thread outside them,
 * in their rows' style (icon, title, the most urgent status of its threads).
 */
function OtherThreadsEntry({
  selected,
  status,
}: {
  selected: boolean;
  status: Status | null;
}) {
  return (
    <button
      type="button"
      data-other-threads=""
      aria-current={selected ? "true" : undefined}
      onClick={() => select(OTHER_THREADS)}
      className={`flex min-h-7 w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] leading-5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-9 ${selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"}`}
    >
      <span
        aria-hidden="true"
        className="flex size-4 shrink-0 items-center justify-center text-[var(--subtle-foreground)]"
      >
        <HostIcon name="ListView" fallback="MessageSquare" className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1 truncate">Other threads</span>
      {status && (
        <span role="img" aria-label={STATUS_LABEL[status]} className="flex shrink-0 items-center">
          <StatusIcon status={status} size="small" />
        </span>
      )}
    </button>
  );
}

/**
 * One dense Adventure row: icon in its hue, name, status and the age of its
 * last activity. A click selects it and opens its coordinator. The row itself is
 * the drag handle (mouse drag after a few pixels, touch after a short hold
 * with movement — a flick still scrolls, a stationary long press opens the
 * context menu instead). Right-click, the ContextMenu/Shift+F10 keys, or the
 * long press offer New thread, Rename, Icon and color and Adventure overview;
 * keyboard reordering is the Space-lift drag.
 */
function ProjectRow({
  project,
  href,
  canReorder,
  selected,
  status,
  summary,
  age,
  dropTarget,
  onOpen,
  onOverview,
  onRename,
  onAppearance,
  onNewThread,
  onMenuOpen,
}: {
  project: TreeProject;
  href: string;
  canReorder: boolean;
  /** Its workers are the section below the picker. */
  selected: boolean;
  status: ReturnType<typeof projectStatus>;
  /** Counts for the tooltip: what needs you, what is in flight. */
  summary: string;
  /** Time since the Initiative's threads last changed, or null. */
  age: string | null;
  dropTarget: boolean;
  onOpen: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
  onOverview: () => void;
  onRename: (name: string) => Promise<void>;
  onAppearance: (patch: AppearancePatch) => Promise<void>;
  onNewThread: () => void;
  onMenuOpen: () => void;
}) {
  const scope = usePortalScopeProps();
  // toPluginPanel is scoped to Sidebar. A cross-plugin link opens the frozen
  // Initiatives composer route; BB/Initiatives own selection, creation and parenting.
  const composeHref = `${INITIATIVES_PANEL}/${encodeURIComponent(project.id)}/compose`;
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [styling, setStyling] = useState(false);
  const [draft, setDraft] = useState(project.name);
  const [saving, setSaving] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const anchorRef = useRef<HTMLAnchorElement | null>(null);
  // A long press or drop can produce a click on release; swallow only that
  // one (keyboard and programmatic clicks have detail 0 and stay live).
  const suppressClick = useRef(false);
  // Rename and composer navigation take focus elsewhere. Prevent Radix from
  // returning focus to the row when those actions close the menu.
  const focusEditor = useRef(false);
  const draggable = useDraggable({
    id: project.id,
    disabled: !canReorder,
  });
  const droppable = useDroppable({
    id: project.id,
    disabled: !canReorder,
  });
  const longPress = useLongPressMenu(menuOpen);
  const hue = appearanceHueStep(project.name, project.appearance?.color);
  const setAnchor = (node: HTMLAnchorElement | null) => {
    anchorRef.current = node;
    draggable.setNodeRef(node);
    draggable.setActivatorNodeRef(node);
  };
  const closeEditor = () => {
    setEditing(false);
    setRenameError(null);
    // Return focus to the row the form replaced.
    requestAnimationFrame(() => anchorRef.current?.focus());
  };
  const submitRename = async (event: FormEvent) => {
    event.preventDefault();
    const name = draft.trim();
    if (!name || saving) return;
    if (name === project.name) {
      closeEditor();
      return;
    }
    setSaving(true);
    setRenameError(null);
    try {
      await onRename(name);
      closeEditor();
    } catch (cause) {
      setRenameError(
        cause instanceof Error ? cause.message : String(cause),
      );
    } finally {
      setSaving(false);
    }
  };
  return (
    <li
      ref={droppable.setNodeRef}
      data-project-row={project.id}
      data-drop-target={dropTarget ? "" : undefined}
      className={`relative rounded-md ${dropTarget ? "ring-1 ring-ring" : ""} ${draggable.isDragging ? "opacity-50" : ""}`}
    >
      {editing ? (
        <form
          aria-label={`Rename ${project.name}`}
          className="flex min-w-0 flex-1 flex-wrap items-center gap-2 px-3 py-2"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              if (!saving) closeEditor();
            }
          }}
          onSubmit={submitRename}
        >
          <input
            aria-label="Adventure name"
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            value={draft}
            readOnly={saving}
            onChange={(event) => setDraft(event.target.value)}
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            type="submit"
            disabled={saving || !draft.trim()}
            className="rounded-md px-2 py-1.5 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={closeEditor}
            className="rounded-md px-2 py-1.5 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            Cancel
          </button>
          {renameError && (
            <p role="alert" className="w-full text-xs text-destructive">
              {renameError}
            </p>
          )}
        </form>
      ) : styling ? (
        <ProjectAppearanceEditor
          name={project.name}
          appearance={project.appearance}
          onChange={onAppearance}
          onClose={() => {
            setStyling(false);
            requestAnimationFrame(() => anchorRef.current?.focus());
          }}
        />
      ) : (
        <ContextMenu.Root
          onOpenChange={(open) => {
            setMenuOpen(open);
            if (open) {
              suppressClick.current = true;
              // Long press cancels an armed drag. The row guards its release
              // click; clear the global guard so menu actions work at once.
              onMenuOpen();
            }
          }}
        >
          <ContextMenu.Trigger asChild>
            <a
              ref={setAnchor}
              {...(canReorder ? draggable.listeners : {})}
              {...(canReorder
                ? { "aria-roledescription": "draggable Adventure" }
                : {})}
              {...longPress}
              draggable={false}
              href={href}
              aria-label={`Open ${project.name}`}
              aria-haspopup="menu"
              aria-current={selected ? "true" : undefined}
              data-project-status={status}
              title={[project.objective, summary].filter(Boolean).join("\n")}
              onPointerDown={(event) => {
                suppressClick.current = false;
                longPress.onPointerDown(event);
              }}
              onKeyDown={(event) => {
                suppressClick.current = false;
                if (canReorder)
                  draggable.listeners?.onKeyDown?.(event);
                if (event.defaultPrevented) return;
                if (
                  event.key === "ContextMenu" ||
                  (event.shiftKey && event.key === "F10")
                ) {
                  event.preventDefault();
                  const bounds =
                    event.currentTarget.getBoundingClientRect();
                  event.currentTarget.dispatchEvent(
                    new MouseEvent("contextmenu", {
                      bubbles: true,
                      cancelable: true,
                      clientX: bounds.left + 16,
                      clientY: bounds.bottom,
                    }),
                  );
                }
              }}
              onClick={(event) => {
                if (suppressClick.current && event.detail !== 0) {
                  // A long-press release still lands as a click after the
                  // timed drag window has expired; block the href too.
                  event.preventDefault();
                  return;
                }
                onOpen(event);
              }}
              // A held finger should start the drag, never the link callout
              // or a text selection.
              style={{ WebkitTouchCallout: "none" }}
              className={`flex min-h-7 min-w-0 flex-1 select-none items-center gap-2 rounded-md px-2 py-1 text-[13px] leading-5 no-underline outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-9 ${selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"}`}
            >
              <span
                aria-hidden="true"
                data-project-hue={hue}
                data-project-icon={appearanceIcon(project.appearance?.icon)}
                className="flex size-4 shrink-0 items-center justify-center"
              >
                <HostIcon
                  name={appearanceIcon(project.appearance?.icon)}
                  fallback="Folder"
                  className="size-3.5"
                />
              </span>
              <span
                className={`min-w-0 flex-1 truncate ${project.paused ? "text-muted-foreground" : ""}`}
              >
                {project.name}
              </span>
              {status !== "done" && (
                <span
                  role="img"
                  className="flex shrink-0 items-center"
                  aria-label={
                    status === "attention"
                      ? "Needs you"
                      : status === "unread"
                        ? "Unread"
                        : status === "working"
                          ? "Working"
                          : "Draft"
                  }
                >
                  <StatusIcon status={status} size="small" />
                </span>
              )}
              {age && (
                <span
                  data-initiative-age=""
                  className="w-7 shrink-0 text-right text-xs tabular-nums text-[var(--subtle-foreground)]"
                >
                  {age}
                </span>
              )}
            </a>
          </ContextMenu.Trigger>
          <ContextMenu.Portal>
            <ContextMenu.Content
              {...scope}
              aria-label={`Actions for ${project.name}`}
              onCloseAutoFocus={(event) => {
                if (!focusEditor.current) return;
                focusEditor.current = false;
                event.preventDefault();
              }}
              className="z-50 min-w-40 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
            >
              <ContextMenu.Item className={menuItemClass} asChild>
                <UrlLink
                  href={composeHref}
                  onClick={() => {
                    focusEditor.current = true;
                    onNewThread();
                  }}
                >
                  New thread
                </UrlLink>
              </ContextMenu.Item>
              <ContextMenu.Item
                className={menuItemClass}
                onSelect={() => {
                  focusEditor.current = true;
                  setDraft(project.name);
                  setRenameError(null);
                  setEditing(true);
                }}
              >
                Rename…
              </ContextMenu.Item>
              <ContextMenu.Item
                className={menuItemClass}
                onSelect={() => {
                  focusEditor.current = true;
                  setStyling(true);
                }}
              >
                Icon and color…
              </ContextMenu.Item>
              <ContextMenu.Item className={menuItemClass} asChild>
                <a
                  href={`${INITIATIVES_PANEL}/${project.id}`}
                  onClick={onOverview}
                >
                  Adventure overview
                </a>
              </ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Portal>
        </ContextMenu.Root>
      )}
    </li>
  );
}
