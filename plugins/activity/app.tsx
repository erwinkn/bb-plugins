import { useEffect, useState, type ReactNode } from "react";
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
import { projectLabel } from "./lib/project-schema";
import { STATUSES, STATUS_LABEL, statusOf, threadTitle } from "./lib/status";
import { toggleValue, updateState, useClientState } from "./lib/client-state";
import { useArchives } from "./lib/use-archives";
import { useSpaces } from "./lib/use-spaces";
import { inScope, newSpaceId, resolveScope } from "./lib/spaces";
import { DisplayMenu } from "./components/menus";
import { ProjectHeaderMenu } from "./components/project-header-menu";
import {
  ProjectRemoveForm,
  ProjectRenameForm,
} from "./components/project-forms";
import { ScopeMenu } from "./components/scope-menu";
import {
  ALL_PROJECTS_SUBPATH,
  NEW_SPACE_SUBPATH,
  SPACES_PANEL_PATH,
  SpacesPage,
} from "./components/spaces-page";
import { NewThreadButton } from "./components/new-thread-button";
import { ThreadRow, fadeClass } from "./components/thread-row";
import { ThreadChildren } from "./components/thread-children";
import { ThreadRoots } from "./components/thread-roots";
import { DraftObserver } from "./components/draft-observer";
import { StatusIcon } from "./components/status-icon";
import { MOBILE_SIDEBAR_SCROLL_CSS } from "./lib/mobile-sidebar-scroll";
import {
  buildThreadTree,
  familyStatus,
  pinnedThreadIds,
  type ThreadNode,
} from "./lib/thread-tree";

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
      <svg
        data-group-chevron=""
        aria-hidden="true"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`size-4 shrink-0 ${closed ? "-rotate-90" : ""}`}
      >
        <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
      </svg>
    </button>
  );
  return (
    <section aria-label={title} className="mt-5 first:mt-3">
      {wrapHeader(header)}
      {belowHeader}
      {!closed && children}
    </section>
  );
}

function ThreadsList(props: PluginThreadListProps) {
  const { status, threads, projects } = experimental_useSidebarThreads();
  const state = useClientState();
  const spaces = useSpaces();
  const scope = resolveScope(spaces.catalog, state.spaceId);
  const scopeKey = scope.kind === "all" ? "all" : `space:${scope.space.id}`;
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
  const archives = useArchives(threads, state.showArchives);
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
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const report = (cause: unknown) =>
    setError(cause instanceof Error ? cause.message : String(cause));
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
  // Scope membership applies before pins and families: a pinned thread or a
  // descendant outside the scope stays hidden, and an inside child whose
  // parent is outside becomes a root. Titles stay unfiltered for parent labels.
  const available = threads
    .filter((thread) => !thread.isArchived && inScope(scope, thread.projectId))
    .map((thread) => ({
      thread,
      status: statusOf(thread, knownDrafts.has(`thread:${thread.id}`)),
    }));
  const pinnedIds = pinnedThreadIds(available);
  const pinned = buildThreadTree(
    available.filter(({ thread }) => pinnedIds.has(thread.id)),
    state.sortBy,
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
  for (const { thread } of [...visible, ...archived]) {
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
  const newDrafts = [...displayProjects.values()].filter(
    (project) =>
      knownDrafts.has(`new:${project.id}`) && !state.hidden.includes("draft"),
  );
  const families = buildThreadTree(visible, state.sortBy).map((node) => ({
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
  const removeProject = async (projectId: string) => {
    await projectRpc.call("deleteProject", { projectId });
    const list = spaces.catalog.spaces;
    if (list.some((space) => space.projectIds.includes(projectId)))
      await spaces.save(
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
    scope.kind !== "all" &&
    activeThread !== undefined &&
    !inScope(scope, activeThread.projectId);
  const spaceMissing =
    state.spaceId !== null &&
    scope.kind !== "space" &&
    spaces.status === "ready";
  const scopePending = state.spaceId !== null && spaces.status === "loading";
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
        project={projectNames.get(thread.projectId) ?? "No project"}
        showProject={showProject}
        provider={providerNames.get(thread.providerId) ?? thread.providerId}
        parent={
          thread.parentThreadId ? titles.get(thread.parentThreadId) : undefined
        }
        active={props.activeThreadId === thread.id}
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
  const archiveGroup = (
    id: string,
    rows: typeof archived,
    renderRow: typeof row = row,
  ) =>
    rows.length > 0 ? (
      <Group id={id} title="Archived" archive>
        <ThreadRoots
          label="Archived"
          pageSize={10}
          nodes={buildThreadTree(rows, state.sortBy)}
          drafts={[]}
          activeThreadId={props.activeThreadId}
          renderRow={(node) => renderRow(node)}
          renderDraft={draftRow}
        />
      </Group>
    ) : null;
  const threadCounts = new Map<string, number>();
  for (const thread of threads)
    threadCounts.set(
      thread.projectId,
      (threadCounts.get(thread.projectId) ?? 0) + 1,
    );
  const shell = (content: ReactNode) => (
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
      {content}
    </div>
  );
  return shell(
    <>
      <div className="shrink-0 px-2 pt-2">
        <div className="flex items-center gap-1">
          <ScopeMenu
            scope={scope}
            catalog={spaces.catalog}
            onSelectAll={selectAll}
            onSelectSpace={selectSpace}
            onNew={() => openSpacesPage(NEW_SPACE_SUBPATH)}
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
        {spaces.status === "error" && state.spaceId !== null && (
          <div role="alert" className="mt-2 text-xs text-destructive">
            Cannot load spaces. Showing all projects.
            <button className="ml-2 underline" onClick={spaces.refresh}>
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
      <div
        // Remounting on a scope change resets every Show more limit.
        key={scopeKey}
        data-activity-thread-groups=""
        className={`px-2 pb-3 ${props.isCompactViewport ? "" : "min-h-0 flex-1 overflow-y-auto"}`}
      >
        {status === "loading" || scopePending ? (
          <p role="status" className="p-2 text-sm text-muted-foreground">
            {scopePending ? "Loading spaces…" : "Loading threads…"}
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
                    );
                    const drafts = newDrafts.filter(
                      (draft) => draft.id === project.id,
                    );
                    const projectArchives = archived.filter(
                      ({ thread }) => thread.projectId === project.id,
                    );
                    const toggleSpace = (spaceId: string) =>
                      spaces
                        .save(
                          spaces.catalog.spaces.map((space) =>
                            space.id === spaceId
                              ? {
                                  ...space,
                                  projectIds: toggleValue(
                                    space.projectIds,
                                    project.id,
                                  ),
                                }
                              : space,
                          ),
                        )
                        .catch(report);
                    return rows.length ||
                      drafts.length ||
                      projectArchives.length ? (
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
                              onToggleSpace={toggleSpace}
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
                        {archiveGroup(
                          `archive:project:${project.id}`,
                          projectArchives,
                          projectRow,
                        )}
                      </Group>
                    ) : null;
                  })}
            {state.groupBy === "status" &&
              archiveGroup("archive:status", archived)}
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
    </>,
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
    id: "activity",
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
