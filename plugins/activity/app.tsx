import { useEffect, useState, type ReactNode } from "react";
import {
  definePluginApp,
  experimental_useSidebarThreads,
  experimental_useSidebarThreadActions,
  experimental_useProviders,
  useRealtimeConnectionState,
  type PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import {
  compareThreads,
  STATUSES,
  STATUS_LABEL,
  statusOf,
  threadTitle,
} from "./lib/status";
import { toggleValue, updateState, useClientState } from "./lib/client-state";
import { useArchives } from "./lib/use-archives";
import { DisplayMenu } from "./components/menus";
import { ThreadRow, fadeClass } from "./components/thread-row";
import { ThreadChildren } from "./components/thread-children";
import { ThreadRoots } from "./components/thread-roots";
import { DraftObserver } from "./components/draft-observer";
import { StatusIcon } from "./components/status-icon";
import { MOBILE_SIDEBAR_SCROLL_CSS } from "./lib/mobile-sidebar-scroll";
import {
  buildThreadTree,
  familyStatus,
  type ThreadNode,
} from "./lib/thread-tree";

function Group({
  id,
  title,
  children,
  archive = false,
}: {
  id: string;
  title: string;
  archive?: boolean;
  children: ReactNode;
}) {
  const { collapsed, expandedArchives } = useClientState();
  const closed = archive
    ? !expandedArchives.includes(id)
    : collapsed.includes(id);
  return (
    <section aria-label={title} className="mt-5 first:mt-3">
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
      {!closed && children}
    </section>
  );
}

function ThreadsList(props: PluginThreadListProps) {
  const { status, threads, projects } = experimental_useSidebarThreads();
  const archives = useArchives(threads);
  const archived = archives.threads.map((thread) => ({
    thread,
    status: "done" as const,
  }));
  const { providers } = experimental_useProviders();
  const actions = experimental_useSidebarThreadActions();
  const connection = useRealtimeConnectionState();
  const state = useClientState();
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const report = (cause: unknown) =>
    setError(cause instanceof Error ? cause.message : String(cause));
  const projectNames = new Map(
    projects.map((project) => [project.id, project.name]),
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
  const available = threads
    .filter((thread) => !thread.isArchived)
    .map((thread) => ({
      thread,
      status: statusOf(thread, knownDrafts.has(`thread:${thread.id}`)),
    }));
  // Pins are direct entries, including pinned children. Keep them outside
  // status filters and family trees so each pin is visible exactly once.
  const pinned = available
    .filter(({ thread }) => thread.isPinned)
    .sort((a, b) => compareThreads(a.thread, b.thread, state.sortBy));
  const visible = available.filter(
    ({ thread, status }) => !thread.isPinned && !state.hidden.includes(status),
  );
  // Thread and project snapshots can arrive separately. Keep unmatched
  // threads and new drafts navigable until project metadata is available.
  const displayProjects = new Map(
    projects.map((project) => [
      project.id,
      { id: project.id, name: project.name },
    ]),
  );
  for (const { thread } of [...visible, ...archived]) {
    if (!displayProjects.has(thread.projectId)) {
      displayProjects.set(thread.projectId, {
        id: thread.projectId,
        name: "No project",
      });
    }
  }
  for (const key of knownDrafts) {
    if (!key.startsWith("new:")) continue;
    const projectId = key.slice(4);
    if (projectId && !displayProjects.has(projectId)) {
      displayProjects.set(projectId, { id: projectId, name: "No project" });
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
          thread.parentThreadId
            ? (titles.get(thread.parentThreadId) ?? thread.parentThreadId)
            : undefined
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
          <h2 className="flex-1 px-2 text-sm font-medium">Threads</h2>
          <DisplayMenu />
          <button
            type="button"
            aria-label="New thread"
            onClick={() => openNew(props.activeProjectId || undefined)}
            className="rounded px-2 py-1 text-lg leading-none text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            +
          </button>
        </div>
        {connection !== "connected" && (
          <p role="status" className="mt-2 px-2 text-xs text-muted-foreground">
            Reconnecting… Statuses can be out of date.
          </p>
        )}
        {archives.error && (
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
        data-activity-thread-groups=""
        className={`px-2 pb-3 ${props.isCompactViewport ? "" : "min-h-0 flex-1 overflow-y-auto"}`}
      >
        {status === "loading" ? (
          <p role="status" className="p-2 text-sm text-muted-foreground">
            Loading threads…
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
                  {pinned.map((entry) => row({ ...entry, children: [] }))}
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
                    return rows.length ||
                      drafts.length ||
                      projectArchives.length ? (
                      <Group
                        key={project.id}
                        id={`project:${project.id}`}
                        title={project.name}
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
                  No matching threads.
                </p>
              )}
          </>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
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
