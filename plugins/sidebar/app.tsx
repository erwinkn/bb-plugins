import { DndContext, DragOverlay, useDroppable } from "@dnd-kit/core";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  definePluginApp,
  experimental_useSidebarThreads,
  experimental_useSidebarThreadActions,
  experimental_useProviders,
  useBbNavigate,
  useRealtimeConnectionState,
  useRpc,
  type PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import type { projectContract } from "./lib/project-contract";
import type { nestingContract } from "./lib/nesting-contract";
import { projectLabel } from "./lib/project-schema";
import { STATUSES, STATUS_LABEL, statusOf, threadTitle } from "./lib/status";
import { toggleValue, updateState, useClientState } from "./lib/client-state";
import { useArchives } from "./lib/use-archives";
import { useLibrary } from "./lib/use-library";
import { useSpaces } from "./lib/use-spaces";
import { useUiPreferences } from "./lib/use-ui-preferences";
import { savedThreadIds } from "./lib/library";
import { inScope, LIBRARY_SCOPE_ID, resolveScope } from "./lib/spaces";
import { DisplayMenu } from "./components/menus";
import { ProjectHeaderMenu } from "./components/project-header-menu";
import {
  ProjectRemoveForm,
  ProjectRenameForm,
} from "./components/project-forms";
import { ScopeMenu } from "./components/scope-menu";
import {
  ALL_PROJECTS_SUBPATH,
  SPACES_PANEL_PATH,
  SpacesPage,
} from "./components/spaces-page";
import { NewThreadButton } from "./components/new-thread-button";
import { ThreadRow, fadeClass } from "./components/thread-row";
import { ThreadChildren } from "./components/thread-children";
import { ThreadRoots } from "./components/thread-roots";
import { ThreadDragOverlay } from "./components/thread-drag-overlay";
import { DraftObserver } from "./components/draft-observer";
import { HostIcon } from "./lib/host-icon";
import { StatusIcon } from "./components/status-icon";
import { MOBILE_SIDEBAR_SCROLL_CSS } from "./lib/mobile-sidebar-scroll";
import {
  buildThreadTree,
  familyStatus,
  pinnedThreadIds,
  type ThreadNode,
} from "./lib/thread-tree";
import {
  buildThreadDndLookup,
  getThreadGroupDroppableId,
  isThreadWithinSubtree,
} from "./lib/thread-dnd";
import type { ThreadDropDecision } from "./lib/thread-dnd";
import { useThreadDnd } from "./lib/use-thread-dnd";
import {
  ThreadDndContext,
  useThreadDndState,
} from "./lib/thread-dnd-context";

function Group({
  id,
  title,
  children,
  archive = false,
  wrapHeader = (header) => header,
  belowHeader,
}: {
  id: string;
  title: string;
  archive?: boolean;
  children: ReactNode;
  /** Wraps the header button, e.g. in a context menu. */
  wrapHeader?: (header: ReactNode) => ReactNode;
  /** Shown between the header and the rows, even while collapsed. */
  belowHeader?: ReactNode;
}) {
  const { collapsed, expandedArchives } = useClientState();
  const dnd = useThreadDndState();
  const { setNodeRef } = useDroppable({
    id: getThreadGroupDroppableId(id),
    disabled: !dnd || archive,
  });
  const closed = archive
    ? !expandedArchives.includes(id)
    : collapsed.includes(id);
  const header = (
    <button
      type="button"
      aria-expanded={!closed}
      onClick={() =>
        updateState((current) => ({
          ...current,
          ...(archive
            ? { expandedArchives: toggleValue(current.expandedArchives, id) }
            : { collapsed: toggleValue(current.collapsed, id) }),
        }))
      }
      className="mb-1 flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-[var(--subtle-foreground)] outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="min-w-0 flex-1 truncate text-left font-medium">
        {title}
      </span>
      <HostIcon
        name="ChevronDown"
        fallback="ArrowDown"
        className={`size-4 shrink-0 ${closed ? "-rotate-90" : ""}`}
      />
    </button>
  );
  return (
    <section
      ref={setNodeRef}
      aria-label={title}
      className={`mt-5 first:mt-3 ${dnd?.dragOverGroupKey === id ? "rounded-md bg-accent/40 ring-1 ring-inset ring-ring/40" : ""}`}
    >
      {wrapHeader(header)}
      {belowHeader}
      {!closed && children}
    </section>
  );
}

function ThreadsList(props: PluginThreadListProps) {
  const { status, threads: hostThreads, projects } =
    experimental_useSidebarThreads();
  const state = useClientState();
  const [error, setError] = useState<string | null>(null);
  const report = (cause: unknown) =>
    setError(cause instanceof Error ? cause.message : String(cause));
  // Reparented threads keep their displayed parent until the host list
  // catches up; a failed update rolls the entry back.
  const [parentOverrides, setParentOverrides] = useState<
    ReadonlyMap<string, string | null>
  >(() => new Map());
  useEffect(() => {
    setParentOverrides((current) => {
      if (!current.size) return current;
      const live = new Map(hostThreads.map((thread) => [thread.id, thread]));
      let changed = false;
      const next = new Map(current);
      for (const [id, parent] of next) {
        const thread = live.get(id);
        if (!thread || thread.parentThreadId === parent) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [hostThreads]);
  const threads = useMemo(
    () =>
      parentOverrides.size
        ? hostThreads.map((thread) =>
            parentOverrides.has(thread.id)
              ? {
                  ...thread,
                  parentThreadId: parentOverrides.get(thread.id) ?? null,
                }
              : thread,
          )
        : hostThreads,
    [hostThreads, parentOverrides],
  );
  const spaces = useSpaces();
  const library = useLibrary();
  const scope = resolveScope(spaces.catalog, state.spaceId);
  const scopeKey =
    scope.kind === "space" ? `space:${scope.space.id}` : scope.kind;
  // Space and project management lives on the Spaces page.
  const navigate = useBbNavigate();
  const openSpacesPage = (subPath: string) =>
    navigate.toPluginPanel(SPACES_PANEL_PATH, { subPath });
  const openManage = () =>
    openSpacesPage(
      scope.kind === "space"
        ? scope.space.id
        : spaces.catalog.spaces.length
          ? ""
          : ALL_PROJECTS_SUBPATH,
    );
  const [projectEdit, setProjectEdit] = useState<{
    kind: "rename" | "remove";
    id: string;
  } | null>(null);
  const projectRpc = useRpc<typeof projectContract>();
  // The library holds active threads only; archives never join it.
  const archives = useArchives(
    threads,
    state.showArchives && scope.kind !== "library",
  );
  const archived = state.showArchives
    ? archives.threads
        .filter((thread) => inScope(scope, thread.projectId))
        .map((thread) => ({
          thread,
          status: "done" as const,
        }))
    : [];
  const { providers } = experimental_useProviders();
  const actions = experimental_useSidebarThreadActions();
  const connection = useRealtimeConnectionState();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  // Grouping, sort, and collapsed Pinned/project groups follow BB's synced
  // sidebar preferences.
  useUiPreferences(report);
  const nestingRpc = useRpc<typeof nestingContract>();
  const reparent = useCallback(
    (threadId: string, parentThreadId: string | null) => {
      setParentOverrides(
        (current) => new Map(current).set(threadId, parentThreadId),
      );
      void nestingRpc
        .call("setParent", { threadId, parentThreadId })
        .catch((cause) => {
          setParentOverrides((current) => {
            if (!current.has(threadId)) return current;
            const next = new Map(current);
            next.delete(threadId);
            return next;
          });
          report(cause);
        });
    },
    [nestingRpc],
  );
  // Dwell expansion while dragging: bumping a thread's counter reveals its
  // children; dropping on a collapsed group opens it once.
  const [expandedChildren, setExpandedChildren] = useState<
    ReadonlyMap<string, number>
  >(() => new Map());
  const expandThread = useCallback(
    (threadId: string) =>
      setExpandedChildren((current) => {
        const next = new Map(current);
        next.set(threadId, (next.get(threadId) ?? 0) + 1);
        return next;
      }),
    [],
  );
  const expandGroup = useCallback(
    (groupKey: string) =>
      updateState((current) => ({
        ...current,
        collapsed: current.collapsed.filter((key) => key !== groupKey),
      })),
    [],
  );
  const dndLookup = useMemo(
    () =>
      buildThreadDndLookup([
        ...threads,
        ...archives.threads.map((thread) => ({
          ...thread,
          isPinned: false,
          isArchived: true,
        })),
      ]),
    [threads, archives.threads],
  );
  const handleDrop = useCallback(
    (decision: ThreadDropDecision) => {
      switch (decision.kind) {
        case "nest":
          // The server unpins a pinned source before reparenting it.
          reparent(decision.activeId, decision.parentThreadId);
          return;
        case "detach":
          reparent(decision.activeId, null);
          if (decision.unpin)
            void actions.setPinned(decision.activeId, false).catch(report);
          return;
        case "pin":
          void actions.setPinned(decision.activeId, true).catch(report);
          return;
        case "unpin":
          void actions.setPinned(decision.activeId, false).catch(report);
          return;
        case "rejected":
          return;
      }
    },
    [reparent, actions],
  );
  const dnd = useThreadDnd({
    enabled: status === "ready",
    lookup: dndLookup,
    onDrop: handleDrop,
    onExpandGroup: expandGroup,
    onExpandThread: expandThread,
  });
  const nestCandidatesFor = useCallback(
    (threadId: string) => {
      const source = dndLookup.threadById.get(threadId);
      if (!source) return [];
      return threads
        .filter(
          (candidate) =>
            !candidate.isArchived &&
            candidate.id !== threadId &&
            candidate.id !== source.parentThreadId &&
            !isThreadWithinSubtree(dndLookup, threadId, candidate.id),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 30)
        .map((candidate) => ({
          id: candidate.id,
          title: threadTitle(candidate),
        }));
    },
    [threads, dndLookup],
  );
  const projectNames = new Map(
    projects.map((project) => [project.id, projectLabel(project)]),
  );
  const providerNames = new Map(
    providers.map((provider) => [provider.id, provider.displayName]),
  );
  const titles = new Map(
    [...threads, ...archives.threads].map((thread) => [
      thread.id,
      threadTitle(thread),
    ]),
  );
  const knownDrafts = new Set(state.drafts);
  // Saved threads and every descendant of a member stay out of the active
  // view; the library scope inverts the same set to list saved families.
  const saved = savedThreadIds(threads, library.memberIds);
  // Scope membership applies before pins and families: a pinned thread or a
  // descendant outside the scope stays hidden, and an inside child whose
  // parent is outside becomes a root. Titles stay unfiltered for parent labels.
  const available = threads
    .filter((thread) =>
      thread.isArchived
        ? false
        : scope.kind === "library"
          ? saved.has(thread.id)
          : !saved.has(thread.id) && inScope(scope, thread.projectId),
    )
    .map((thread) => ({
      thread,
      status: statusOf(thread, knownDrafts.has(`thread:${thread.id}`)),
    }));
  const pinnedIds = pinnedThreadIds(available);
  const pinned = buildThreadTree(
    available.filter(({ thread }) => pinnedIds.has(thread.id)),
    state.sortBy,
    state.sortDirection,
  );
  const visible = available.filter(
    ({ thread, status }) =>
      !pinnedIds.has(thread.id) && !state.hidden.includes(status),
  );
  // Thread and project snapshots can arrive separately. Keep unmatched
  // threads and new drafts navigable until project metadata is available.
  const displayProjects = new Map(
    projects
      .filter((project) => inScope(scope, project.id))
      .map((project) => [
        project.id,
        {
          id: project.id,
          name: projectLabel(project),
          isPersonal: project.isPersonal,
          known: true,
        },
      ]),
  );
  for (const { thread } of visible) {
    if (!displayProjects.has(thread.projectId)) {
      displayProjects.set(thread.projectId, {
        id: thread.projectId,
        name: "Unknown project",
        isPersonal: false,
        known: false,
      });
    }
  }
  for (const key of knownDrafts) {
    if (!key.startsWith("new:")) continue;
    const projectId = key.slice(4);
    if (
      projectId &&
      inScope(scope, projectId) &&
      !displayProjects.has(projectId)
    ) {
      displayProjects.set(projectId, {
        id: projectId,
        name: "Unknown project",
        isPersonal: false,
        known: false,
      });
    }
  }
  const newDrafts =
    scope.kind === "library"
      ? []
      : [...displayProjects.values()].filter(
          (project) =>
            knownDrafts.has(`new:${project.id}`) &&
            !state.hidden.includes("draft"),
        );
  const families = buildThreadTree(
    visible,
    state.sortBy,
    state.sortDirection,
  ).map((node) => ({
    node,
    status: familyStatus(node),
  }));
  const openNew = (id?: string) => {
    actions.openNewThread({ projectId: id, focusPrompt: true });
    props.onNavigate();
  };
  const scopeProjects = projects
    .map((project) => ({ id: project.id, name: projectLabel(project) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const selectAll = () =>
    updateState((current) => ({ ...current, spaceId: null }));
  const selectSpace = (spaceId: string) =>
    updateState((current) => ({ ...current, spaceId }));
  const selectLibrary = () =>
    updateState((current) => ({ ...current, spaceId: LIBRARY_SCOPE_ID }));
  const removeProject = async (projectId: string) => {
    await projectRpc.call("deleteProject", { projectId });
    if (
      spaces.catalog.spaces.some((space) =>
        space.projectIds.includes(projectId),
      )
    )
      await spaces.save((list) =>
        list.map((space) => ({
          ...space,
          projectIds: space.projectIds.filter((id) => id !== projectId),
        })),
      );
  };
  const activeThread = threads.find(
    (thread) => thread.id === props.activeThreadId,
  );
  const activeOutside =
    scope.kind === "library"
      ? activeThread !== undefined && !saved.has(activeThread.id)
      : scope.kind === "space" &&
        activeThread !== undefined &&
        !inScope(scope, activeThread.projectId);
  // A saved family asking for input or holding an unread reply marks the
  // Library scope entry without leaving the library.
  let librarySignal: "attention" | "unread" | null = null;
  for (const thread of threads) {
    if (thread.isArchived || !saved.has(thread.id)) continue;
    const status = statusOf(thread, knownDrafts.has(`thread:${thread.id}`));
    if (status === "attention") {
      librarySignal = "attention";
      break;
    }
    if (status === "unread") librarySignal = "unread";
  }
  const spaceMissing =
    state.spaceId !== null &&
    state.spaceId !== LIBRARY_SCOPE_ID &&
    scope.kind !== "space" &&
    spaces.status === "ready";
  const scopePending =
    scope.kind === "library"
      ? library.status === "loading"
      : state.spaceId !== null && spaces.status === "loading";
  // Rows under a project header omit the project name, which would repeat it.
  const makeRow = (showProject: boolean) => {
    const row = (
      { thread, status, children }: ThreadNode,
      depth = 0,
    ): ReactNode => (
      <ThreadRow
        key={thread.id}
        now={now}
        sortBy={state.sortBy}
        thread={thread}
        status={status}
        depth={depth}
        project={projectNames.get(thread.projectId) ?? "Unknown project"}
        showProject={showProject}
        provider={providerNames.get(thread.providerId) ?? thread.providerId}
        parent={
          thread.parentThreadId ? titles.get(thread.parentThreadId) : undefined
        }
        active={props.activeThreadId === thread.id}
        libraryAction={
          library.memberIds.has(thread.id) &&
          !(thread.parentThreadId && saved.has(thread.parentThreadId))
            ? "remove"
            : scope.kind === "library"
              ? null
              : "save"
        }
        nesting={{
          candidates: nestCandidatesFor(thread.id),
          onSetParent: (parentThreadId) =>
            reparent(thread.id, parentThreadId),
        }}
        onNavigate={props.onNavigate}
        onError={report}
      >
        {children.length > 0 && (
          <ThreadChildren
            nodes={children}
            parentTitle={threadTitle(thread)}
            depth={depth + 1}
            activeThreadId={props.activeThreadId}
            renderRow={row}
            expandSignal={expandedChildren.get(thread.id) ?? 0}
          />
        )}
      </ThreadRow>
    );
    return row;
  };
  const row = makeRow(true);
  const projectRow = makeRow(false);
  const draftRow = (project: { id: string; name: string }) => (
    <li key={`new:${project.id}`}>
      <button
        type="button"
        onClick={() => openNew(project.id)}
        className="flex w-full flex-col rounded-md px-2 py-2 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex min-w-0 items-center gap-2 self-stretch">
          <span className={`min-w-0 flex-1 leading-5 ${fadeClass}`}>
            New thread draft
          </span>
          <span
            role="img"
            aria-label="Draft"
            className="flex size-4 shrink-0 items-center justify-center"
          >
            <StatusIcon status="draft" />
          </span>
        </span>
        <span
          className={`mt-0.5 block self-stretch text-xs leading-4 text-[var(--subtle-foreground)] ${fadeClass}`}
        >
          {project.name}
        </span>
      </button>
    </li>
  );
  const threadCounts = new Map<string, number>();
  for (const thread of threads)
    threadCounts.set(
      thread.projectId,
      (threadCounts.get(thread.projectId) ?? 0) + 1,
    );
  const toggleSpace = (spaceId: string, projectId: string) =>
    spaces
      .save((list) =>
        list.map((space) =>
          space.id === spaceId
            ? { ...space, projectIds: toggleValue(space.projectIds, projectId) }
            : space,
        ),
      )
      .catch(report);
  return (
    <div
      data-activity-sidebar=""
      data-mobile-scroll={props.isCompactViewport ? "" : undefined}
      className={`flex flex-col text-foreground ${props.isCompactViewport ? "shrink-0" : "h-full min-h-0"}`}
    >
      {props.isCompactViewport && (
        <style data-activity-mobile-scroll="">
          {MOBILE_SIDEBAR_SCROLL_CSS}
        </style>
      )}
      <div className="shrink-0 px-2 pt-2">
        <div className="flex items-center gap-1">
          <ScopeMenu
            scope={scope}
            catalog={spaces.catalog}
            librarySignal={librarySignal}
            onSelectAll={selectAll}
            onSelectSpace={selectSpace}
            onSelectLibrary={selectLibrary}
            onManage={openManage}
          />
          <DisplayMenu />
          <NewThreadButton
            scope={scope}
            activeProjectId={props.activeProjectId || null}
            projects={scopeProjects}
            onOpen={openNew}
          />
        </div>
        {spaceMissing && (
          <p role="status" className="mt-2 px-2 text-xs text-muted-foreground">
            This space no longer exists. Showing all projects.
            <button className="ml-2 underline" onClick={selectAll}>
              Dismiss
            </button>
          </p>
        )}
        {spaces.status === "error" &&
          state.spaceId !== null &&
          scope.kind !== "library" && (
            <div role="alert" className="mt-2 text-xs text-destructive">
              Cannot load spaces. Showing all projects.
              <button className="ml-2 underline" onClick={spaces.refresh}>
                Retry
              </button>
            </div>
          )}
        {library.status === "error" && (
          <div role="alert" className="mt-2 text-xs text-destructive">
            Cannot load the library. Saved threads stay in the active list.
            <button className="ml-2 underline" onClick={library.refresh}>
              Retry
            </button>
          </div>
        )}
        {activeOutside && (
          <p role="status" className="mt-2 px-2 text-xs text-muted-foreground">
            The current thread is outside this scope.
            <button className="ml-2 underline" onClick={selectAll}>
              Show all projects
            </button>
          </p>
        )}
        {connection !== "connected" && (
          <p role="status" className="mt-2 px-2 text-xs text-muted-foreground">
            Reconnecting… Statuses can be out of date.
          </p>
        )}
        {state.showArchives && archives.error && (
          <div role="alert" className="mt-2 text-xs text-destructive">
            Cannot load archived threads.
            <button className="ml-2 underline" onClick={archives.refresh}>
              Retry
            </button>
          </div>
        )}
        {error && (
          <div role="alert" className="mt-2 text-xs text-destructive">
            {error}
            <button className="ml-2 underline" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}
      </div>
      <DndContext {...dnd.dndContextProps}>
        <ThreadDndContext.Provider value={status === "ready" ? dnd.state : null}>
          <div
            // Remounting on a scope change resets every Show more limit.
            key={scopeKey}
            data-activity-thread-groups=""
            onClickCapture={dnd.onClickCapture}
            onKeyDown={dnd.onEscape}
            className={`px-2 pb-3 ${props.isCompactViewport ? "" : "min-h-0 flex-1 overflow-y-auto"}`}
          >
            {status === "loading" || scopePending ? (
              <p role="status" className="p-2 text-sm text-muted-foreground">
                {scopePending
                  ? scope.kind === "library"
                    ? "Loading the library…"
                    : "Loading spaces…"
                  : "Loading threads…"}
              </p>
            ) : status === "error" ? (
              <div role="alert" className="p-2 text-sm">
                Cannot load threads.
                <props.Original />
              </div>
            ) : (
              <>
                {pinned.length > 0 && (
                  <Group id="pinned" title="Pinned">
                    <ul aria-label="Pinned threads" className="m-0 list-none p-0">
                      {pinned.map((entry) => row(entry))}
                    </ul>
                  </Group>
                )}
                {state.hidden.length === STATUSES.length && (
                  <p className="p-2 text-xs text-muted-foreground">
                    All statuses are hidden. Use Threads display options to show
                    them.
                  </p>
                )}
                {state.groupBy === "status"
                  ? STATUSES.filter((s) => !state.hidden.includes(s)).map((s) => {
                      const rows = families.filter((family) => family.status === s);
                      const count =
                        rows.length + (s === "draft" ? newDrafts.length : 0);
                      if (!count) return null;
                      return (
                        <Group key={s} id={`status:${s}`} title={STATUS_LABEL[s]}>
                          <ThreadRoots
                            label={STATUS_LABEL[s]}
                            pageSize={s === "done" ? 10 : 5}
                            nodes={rows.map(({ node }) => node)}
                            drafts={s === "draft" ? newDrafts : []}
                            activeThreadId={props.activeThreadId}
                            renderRow={(node) => row(node)}
                            renderDraft={draftRow}
                          />
                        </Group>
                      );
                    })
                  : [...displayProjects.values()]
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .map((project) => {
                        const rows = buildThreadTree(
                          visible.filter(
                            (row) => row.thread.projectId === project.id,
                          ),
                          state.sortBy,
                          state.sortDirection,
                        );
                        const drafts = newDrafts.filter(
                          (draft) => draft.id === project.id,
                        );
                        return rows.length || drafts.length ? (
                          <Group
                            key={project.id}
                            id={`project:${project.id}`}
                            title={project.name}
                            wrapHeader={(header) =>
                              !project.known ? (
                                header
                              ) : (
                                <ProjectHeaderMenu
                                  projectId={project.id}
                                  projectName={project.name}
                                  isPersonal={project.isPersonal}
                                  spaces={spaces.catalog.spaces}
                                  onToggleSpace={(spaceId) =>
                                    toggleSpace(spaceId, project.id)
                                  }
                                  onAction={(action) => {
                                    if (action === "new-thread")
                                      openNew(project.id);
                                    else if (action === "manage") openManage();
                                    else
                                      setProjectEdit({
                                        kind: action,
                                        id: project.id,
                                      });
                                  }}
                                >
                                  {header}
                                </ProjectHeaderMenu>
                              )
                            }
                            belowHeader={
                              projectEdit?.id !==
                              project.id ? null : projectEdit.kind === "rename" ? (
                                <ProjectRenameForm
                                  project={project}
                                  onSubmit={async (name) => {
                                    await projectRpc.call("renameProject", {
                                      projectId: project.id,
                                      name,
                                    });
                                  }}
                                  onClose={() => setProjectEdit(null)}
                                />
                              ) : (
                                <ProjectRemoveForm
                                  project={project}
                                  threadCount={threadCounts.get(project.id) ?? 0}
                                  onSubmit={() => removeProject(project.id)}
                                  onClose={() => setProjectEdit(null)}
                                />
                              )
                            }
                          >
                            <ThreadRoots
                              label={project.name}
                              pageSize={10}
                              nodes={rows}
                              drafts={drafts}
                              activeThreadId={props.activeThreadId}
                              renderRow={(node) => projectRow(node)}
                              renderDraft={draftRow}
                            />
                          </Group>
                        ) : null;
                      })}
                {archived.length > 0 && (
                  <Group id="archive" title="Archived" archive>
                    <ThreadRoots
                      label="Archived"
                      pageSize={10}
                      nodes={buildThreadTree(
                        archived,
                        state.sortBy,
                        state.sortDirection,
                      )}
                      drafts={[]}
                      activeThreadId={props.activeThreadId}
                      renderRow={(node) => row(node)}
                      renderDraft={draftRow}
                    />
                  </Group>
                )}
                {state.hidden.length < STATUSES.length &&
                  !archived.length &&
                  !visible.length &&
                  !pinned.length &&
                  !newDrafts.length && (
                    <p className="p-2 text-xs text-muted-foreground">
                      {scope.kind === "space" && scope.projectIds.size === 0 ? (
                        <>
                          No projects in this space.{" "}
                          <button
                            type="button"
                            className="underline"
                            onClick={openManage}
                          >
                            Choose projects
                          </button>
                        </>
                      ) : scope.kind === "library" ? (
                        "No saved threads. Save one from a thread's actions to keep it here."
                      ) : scope.kind !== "all" ? (
                        "No matching threads in this space."
                      ) : (
                        "No matching threads."
                      )}
                    </p>
                  )}
              </>
            )}
          </div>
        </ThreadDndContext.Provider>
        <DragOverlay dropAnimation={null}>
          {dnd.activeThreadId && dnd.state.dragMoved ? (
            <ThreadDragOverlay
              title={titles.get(dnd.activeThreadId) ?? "Thread"}
            />
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "spaces",
    title: "Spaces",
    icon: "Layers",
    path: SPACES_PANEL_PATH,
    component: SpacesPage,
  });
  app.slots.experimental_threadList({
    id: "sidebar",
    title: "Threads",
    description:
      "Threads grouped by status: Needs Attention, Unread, Working, Draft, Done.",
    component: ThreadsList,
  });
  app.composer.customize({
    id: "draft-tracking",
    scopes: ["thread", "new-thread"],
    banners: [{ id: "observe", chrome: "bare", component: DraftObserver }],
  });
});
