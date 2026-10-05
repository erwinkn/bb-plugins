import {
  useCallback,
  useEffect,
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
  experimental_useProviders,
  experimental_useSidebarThreads,
  type PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import type { projectModeContract } from "../lib/project-mode-contract";
import type { ProjectTree } from "../lib/project-tree-schema";
import { updateState, useClientState } from "../lib/client-state";
import {
  currentProjectThreads,
  orderedProjects,
  projectStatus,
  projectThreads,
  selectedProject,
} from "../lib/project-mode-status";
import {
  PROJECT_ORDER_CHANNEL,
  projectOrderDocSchema,
} from "../lib/project-order-schema";
import { useProjectOrder } from "../lib/use-project-order";
import { useReorderDnd } from "../lib/use-reorder-dnd";
import { useLongPressMenu } from "../lib/use-long-press-menu";
import { usePortalScopeProps } from "../lib/portal-scope";
import { moveItem } from "../lib/spaces";
import { projectLabel } from "../lib/project-schema";
import { threadTitle } from "../lib/status";
import type { ThreadNode } from "../lib/thread-tree";
import { MOBILE_SIDEBAR_SCROLL_CSS } from "../lib/mobile-sidebar-scroll";
import { useLinkedPullRequests } from "../lib/use-linked-pull-requests";
import { StatusIcon } from "./status-icon";
import { ProjectHueStyle, projectHueStep } from "../lib/project-hue";
import { HostIcon } from "../lib/host-icon";
import { ThreadRow, type ProviderIconRecord } from "./thread-row";
import { ThreadChildren } from "./thread-children";
import { ThreadDragOverlay } from "./thread-drag-overlay";
import { menuItemClass } from "./menus";

export function ModeToggle() {
  const state = useClientState();
  return (
    <button
      type="button"
      className="inline-flex h-7 shrink-0 items-center justify-center rounded px-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      aria-label={
        state.mode === "projects"
          ? "Switch to Threads view"
          : "Switch to Initiatives view"
      }
      title={state.mode === "projects" ? "Threads view" : "Initiatives view"}
      onClick={() =>
        updateState((s) => ({
          ...s,
          mode: s.mode === "projects" ? "threads" : "projects",
        }))
      }
    >
      <HostIcon
        name={state.mode === "projects" ? "MessageSquare" : "Target"}
        fallback="Layers"
        className="size-4"
      />
    </button>
  );
}

type TreeProject = ProjectTree["projects"][number];

export function ProjectMode(props: PluginThreadListProps) {
  const navigate = useBbNavigate();
  const api = useRpc<typeof projectModeContract>();
  const native = experimental_useSidebarThreads();
  const connection = useRealtimeConnectionState();
  const [tree, setTree] = useState<ProjectTree | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const report = (cause: unknown) =>
    setError(cause instanceof Error ? cause.message : String(cause));
  const client = useClientState();
  const order = useProjectOrder(api);
  const { applySnapshot, commit } = order;
  const apiRef = useRef(api); apiRef.current = api;
  const applyRef = useRef(applySnapshot); applyRef.current = applySnapshot;
  const mounted = useRef(false);
  const pending = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(() => {
    if (pending.current) return pending.current;
    const read = apiRef.current.call("projectMode", null).then(result => {
      if (mounted.current) {
        setAvailable(result.available); setTree(result.tree);
        applyRef.current(result.order, result.orderError); setError(null);
      }
    }, error => { if (mounted.current) setError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (pending.current === read) pending.current = null; });
    pending.current = read;
    return read;
  }, []);
  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; if (mounted.current) void refresh(); }, 200);
  }, [refresh]);
  useEffect(() => {
    mounted.current = true; void refresh();
    return () => { mounted.current = false; if (timer.current) clearTimeout(timer.current); };
  }, [refresh]);
  useRealtime(PROJECT_ORDER_CHANNEL, payload => {
    const parsed = projectOrderDocSchema.safeParse(payload);
    if (parsed.success) applySnapshot(parsed.data);
  });
  useRealtime("projects-changed", schedule);
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
    return () => clearInterval(interval);
  }, [schedule]);
  const projects = tree?.projects ?? [];
  const displayed = useMemo(
    () => orderedProjects(projects, order.order),
    [projects, order.order],
  );
  const selected = useMemo(
    () =>
      selectedProject(
        displayed,
        native.threads,
        props.activeThreadId,
        props.activeProjectId,
      ),
    [displayed, native.threads, props.activeThreadId, props.activeProjectId],
  );

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

  return (
    <div
      data-activity-sidebar=""
      data-project-mode=""
      data-mobile-scroll={props.isCompactViewport ? "" : undefined}
      className={`flex flex-col text-foreground ${props.isCompactViewport ? "shrink-0" : "h-full min-h-0"}`}
    >
      {props.isCompactViewport && (
        <style data-activity-mobile-scroll="">
          {MOBILE_SIDEBAR_SCROLL_CSS}
        </style>
      )}
      <ProjectHueStyle />
      <div className="flex shrink-0 items-center gap-2 px-2 pt-2 pb-2">
        <ModeToggle />
        <span className="flex-1 text-xs font-medium">Initiatives</span>
        <a
          className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
          onClick={props.onNavigate}
          href="/plugins/projects/projects"
        >
          Overview
        </a>
      </div>
      <div
        className={`${props.isCompactViewport ? "" : "min-h-0 overflow-y-auto"} px-2 pb-4`}
      >
        {error && (
          <p role="alert" className="p-2 text-xs text-destructive">
            {error}{" "}
            <button className="underline" onClick={() => void refresh()}>
              Retry
            </button>
          </p>
        )}
        {order.error && (
          <p role="alert" className="p-2 text-xs text-destructive">
            Could not save the initiative order: {order.error}{" "}
            <button className="underline" onClick={order.dismissError}>
              Dismiss
            </button>
          </p>
        )}
        {available === false && (
          <p className="p-2 text-xs text-muted-foreground">
            Install or enable the Projects plugin to use this view. Threads
            remain available from the view switch.
          </p>
        )}
        {available === null && !error && (
          <p className="p-2 text-xs text-muted-foreground">Loading initiatives…</p>
        )}
        {available && !projects.length && (
          <p className="p-2 text-xs text-muted-foreground">
            No initiatives yet.{" "}
            <a
              className="underline"
              onClick={props.onNavigate}
              href="/plugins/projects/projects/new"
            >
              Start an initiative
            </a>
          </p>
        )}
        <DndContext {...dnd.dndContextProps}>
          <ul
            aria-label="Initiatives"
            className="m-0 list-none p-0"
            onClickCapture={dnd.onClickCapture}
            onKeyDown={dnd.onEscape}
          >
            {displayed.map((p, index) => {
              const threads = projectThreads(p, native.threads);
              const status = projectStatus(p, threads, client.drafts);
              const coordinator = p.nodes.find(
                (n) => n.role === "coordinator",
              );
              const active =
                threads.some((t) => t.id === props.activeThreadId) ||
                p.nodes.some((n) => n.threadId === props.activeThreadId);
              const metadata = [
                p.opinions ? `${p.opinions} need you` : null,
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
                      : `/plugins/projects/projects/${p.id}`
                  }
                  canReorder={displayed.length > 1}
                  active={active}
                  status={status}
                  metadata={metadata}
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
                    if (p.coordinatorThreadId) {
                      event.preventDefault();
                      navigate.toThread(p.coordinatorThreadId);
                    }
                    props.onNavigate();
                  }}
                  onOverview={props.onNavigate}
                  onRename={(name) => renameProject(p.id, name)}
                  onNewThread={props.onNavigate}
                  onMenuOpen={() => {
                    dnd.consumeClickSuppression();
                  }}
                  isCompactViewport={props.isCompactViewport}
                />
              );
            })}
          </ul>
          <DragOverlay dropAnimation={null}>
            {dragId ? (
              <ThreadDragOverlay
                title={
                  displayed.find((p) => p.id === dragId)?.name ?? "Initiative"
                }
              />
            ) : null}
          </DragOverlay>
        </DndContext>
        {selected && (
          <ProjectThreads
            project={selected}
            threads={native.threads}
            projects={native.projects}
            activeThreadId={props.activeThreadId}
            onNavigate={props.onNavigate}
            onError={report}
          />
        )}
      </div>
    </div>
  );
}

/**
 * One flat project row. The row itself is the drag handle (mouse drag after a
 * few pixels, touch after a short hold with movement — a flick still scrolls,
 * a stationary long press opens the context menu instead). Right-click, the
 * ContextMenu/Shift+F10 keys, or the long press offer New thread, Rename and
 * Project overview; keyboard reordering is the Space-lift drag.
 */
function ProjectRow({
  project,
  href,
  canReorder,
  active,
  status,
  metadata,
  dropTarget,
  onOpen,
  onOverview,
  onRename,
  onNewThread,
  onMenuOpen,
  isCompactViewport,
}: {
  project: TreeProject;
  href: string;
  canReorder: boolean;
  active: boolean;
  status: ReturnType<typeof projectStatus>;
  metadata: string;
  dropTarget: boolean;
  onOpen: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
  onOverview: () => void;
  onRename: (name: string) => Promise<void>;
  onNewThread: () => void;
  onMenuOpen: () => void;
  isCompactViewport: boolean;
}) {
  const scope = usePortalScopeProps();
  // toPluginPanel is scoped to Sidebar. A cross-plugin link opens the frozen
  // Projects composer route; BB/Projects own selection, creation and parenting.
  const composeHref = `/plugins/projects/projects/${encodeURIComponent(project.id)}/compose`;
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
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
      className={`relative mb-1 rounded-lg ${dropTarget ? "ring-1 ring-ring" : ""} ${draggable.isDragging ? "opacity-50" : ""}`}
    >
      <div className="group relative flex items-center gap-1">
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
              aria-label="Initiative name"
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
                  ? { "aria-roledescription": "draggable initiative" }
                  : {})}
                {...longPress}
                draggable={false}
                href={href}
                aria-label={`Open ${project.name}`}
                aria-haspopup="menu"
                aria-current={active ? "page" : undefined}
                data-project-status={status}
                title={project.objective}
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
                className={`relative flex min-w-0 flex-1 select-none items-center gap-3 rounded-lg px-3 py-3 no-underline outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"}`}
              >
                <span
                  aria-hidden="true"
                  data-project-hue={projectHueStep(project.name)}
                  className="absolute bottom-3 left-0 top-3 w-0.5 rounded-full bg-current opacity-70"
                />
                <span
                  aria-hidden="true"
                  data-project-hue={projectHueStep(project.name)}
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-current/10"
                >
                  <HostIcon
                    name="Target"
                    fallback="Folder"
                    className="size-4"
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium leading-5">
                    {project.name}
                  </span>
                  {metadata && (
                    <span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">
                      {metadata}
                    </span>
                  )}
                </span>
                {status !== "done" && (
                  <span
                    aria-label={
                      status === "unread"
                        ? "Unread"
                        : status === "working"
                          ? "Working"
                          : "Draft"
                    }
                  >
                    <StatusIcon status={status} size="small" />
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
                <ContextMenu.Item className={menuItemClass} asChild>
                  <a
                    href={`/plugins/projects/projects/${project.id}`}
                    onClick={onOverview}
                  >
                    Initiative overview
                  </a>
                </ContextMenu.Item>
              </ContextMenu.Content>
            </ContextMenu.Portal>
          </ContextMenu.Root>
        )}
        {!editing && (
          <UrlLink
            href={composeHref}
            data-initiative-new-thread={project.id}
            aria-label={`New thread in ${project.name}`}
            title="New thread"
            onClick={onNewThread}
            className={`flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring ${isCompactViewport ? "" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"}`}
          >
            <HostIcon name="Plus" fallback="FolderPlus" className="size-4" />
          </UrlLink>
        )}
      </div>
    </li>
  );
}

/**
 * The opened project's live worker threads, under the flat project list.
 * Native thread rows carry their real statuses and navigation; an empty
 * result renders nothing at all.
 */
function ProjectThreads({
  project,
  threads,
  projects,
  activeThreadId,
  onNavigate,
  onError,
}: {
  project: ProjectTree["projects"][number];
  threads: ReturnType<typeof experimental_useSidebarThreads>["threads"];
  projects: ReturnType<typeof experimental_useSidebarThreads>["projects"];
  activeThreadId: string | null;
  onNavigate: () => void;
  onError: (error: unknown) => void;
}) {
  const client = useClientState();
  const { providers } = experimental_useProviders();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const nodes = useMemo(
    () =>
      currentProjectThreads(
        project,
        threads,
        client.drafts,
        client.sortBy,
        client.sortDirection,
      ),
    [
      project,
      threads,
      client.drafts,
      client.sortBy,
      client.sortDirection,
    ],
  );
  const listedIds = useMemo(() => {
    const ids: string[] = [];
    const collect = (list: readonly ThreadNode[]) => {
      for (const node of list) {
        ids.push(node.thread.id);
        collect(node.children);
      }
    };
    collect(nodes);
    return ids;
  }, [nodes]);
  const { links, branchPrEligible } = useLinkedPullRequests(listedIds);
  const providerNames = new Map(
    providers.map((provider) => [provider.id, provider.displayName]),
  );
  const providerRecords = new Map<string, ProviderIconRecord>(
    providers.map((provider) => [provider.id, provider]),
  );
  const projectNames = new Map(
    projects.map((entry) => [entry.id, projectLabel(entry)]),
  );
  const titles = new Map(
    threads.map((thread) => [thread.id, threadTitle(thread)]),
  );
  if (!nodes.length) return null;
  const renderRow = (node: ThreadNode, depth = 0): ReactNode => (
    <ThreadRow
      key={node.thread.id}
      now={now}
      sortBy={client.sortBy}
      thread={node.thread}
      status={node.status}
      title={
        node.identity
          ? `${node.identity.worker} ${node.identity.label}`
          : undefined
      }
      depth={depth}
      project={
        projectNames.get(node.thread.projectId) ?? "Unknown project"
      }
      showProject
      provider={
        providerNames.get(node.thread.providerId) ?? node.thread.providerId
      }
      providerRecord={
        providerRecords.get(node.thread.providerId) ?? {
          id: node.thread.providerId,
        }
      }
      parent={
        node.thread.parentThreadId
          ? titles.get(node.thread.parentThreadId)
          : undefined
      }
      active={activeThreadId === node.thread.id}
      libraryAction={null}
      linkedPullRequests={links.get(node.thread.id)}
      branchPullRequestEligible={branchPrEligible.get(node.thread.id)}
      onNavigate={onNavigate}
      onError={onError}
    >
      {node.children.length > 0 && (
        <ThreadChildren
          nodes={node.children}
          parentTitle={threadTitle(node.thread)}
          depth={depth + 1}
          activeThreadId={activeThreadId}
          renderRow={renderRow}
        />
      )}
    </ThreadRow>
  );
  return (
    <section
      aria-label={`Threads in ${project.name}`}
      data-project-threads={project.id}
      className="mt-3 border-t border-border pt-2"
    >
      <p className="px-3 pb-1 text-xs font-medium text-[var(--subtle-foreground)]">
        {project.name}
      </p>
      <ul className="m-0 list-none p-0">
        {nodes.map((node) => renderRow(node))}
      </ul>
    </section>
  );
}
