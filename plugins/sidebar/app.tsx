import { DndContext, DragOverlay, useDroppable } from "@dnd-kit/core";
import { AdventuresSection } from "./components/project-mode";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
} from "react";
import {
  definePluginApp,
  experimental_useSidebarThreads,
  experimental_useSidebarThreadActions,
  experimental_useProviders,
  useRealtimeConnectionState,
  useRpc,
  type PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import type { projectContract } from "./lib/project-contract";
import type { nestingContract } from "./lib/nesting-contract";
import { projectLabel } from "./lib/project-schema";
import {
  STATUSES,
  STATUS_LABEL,
  statusOf,
  threadTitle,
  type Status,
} from "./lib/status";
import {
  toggleValue,
  updateState,
  useClientState,
} from "./lib/client-state";
import { useArchives } from "./lib/use-archives";
import { useSnooze, useSnoozePresets } from "./lib/use-snooze";
import type { snoozeContract } from "./lib/snooze-contract";
import { isSleeping, isWoke, type SnoozeEntry } from "./lib/snooze-schema";
import { SnoozeSettings } from "./components/snooze-settings";
import { useUiPreferences } from "./lib/use-ui-preferences";
import { useBranchPullRequestEligibility } from "./lib/use-branch-pull-request-eligibility";
import { ListingMenu } from "./components/menus";
import { sectionActionClass } from "./components/section-header";
import { ProjectHeaderMenu } from "./components/project-header-menu";
import {
  ProjectRemoveForm,
  ProjectRenameForm,
} from "./components/project-forms";
import {
  ThreadRow,
  fadeClass,
  type ProviderIconRecord,
} from "./components/thread-row";
import { ProjectGlyph } from "./components/project-glyph";
import { ProjectHueStyle } from "./lib/project-hue";
import { ThreadChildren } from "./components/thread-children";
import { ThreadRoots } from "./components/thread-roots";
import { ThreadDragOverlay } from "./components/thread-drag-overlay";
import { DraftObserver } from "./components/draft-observer";
import { HostIcon } from "./lib/host-icon";
import { StatusIcon } from "./components/status-icon";
import { GroupCount } from "./components/group-count";
import { ArchiveIcon } from "./components/archive-icon";
import { MOBILE_SIDEBAR_SCROLL_CSS } from "./lib/mobile-sidebar-scroll";
import { useFinePointer } from "./lib/use-fine-pointer";
import { hiddenInitiativeThreads } from "./lib/initiative-threads";
import { useInitiativeThreadIds } from "./lib/use-initiative-threads";
import {
  buildThreadTree,
  familyMemberIds,
  familyStatus,
  pinnedThreadIds,
  type ThreadNode,
} from "./lib/thread-tree";
import {
  applyDetachDecision,
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
  icon,
  count,
  attention = false,
  trailing,
  children,
  archive = false,
  defaultClosed = false,
  dropTarget = true,
  wrapHeader = (header) => header,
  belowHeader,
}: {
  id: string;
  title: string;
  /** Tinted glyph before the title. */
  icon?: ReactNode;
  /** Rows in the group; shown as a chip before the chevron. */
  count?: number;
  /** Colors the count chip while it is non-zero. */
  attention?: boolean;
  /**
   * A control in the chip's place before the chevron. On a mouse or trackpad
   * it appears while the header line is hovered or focused; touch viewports
   * always show it.
   */
  trailing?: ReactNode;
  archive?: boolean;
  /** Closed until opened, like Archived; the open state persists per client. */
  defaultClosed?: boolean;
  /** False keeps drags from landing on the group. */
  dropTarget?: boolean;
  children: ReactNode;
  /** Wraps the header button, e.g. in a context menu. */
  wrapHeader?: (header: ReactNode) => ReactNode;
  /** Shown between the header and the rows, even while collapsed. */
  belowHeader?: ReactNode;
}) {
  const { collapsed, expandedArchives } = useClientState();
  const finePointer = useFinePointer();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const showTrailing =
    trailing !== undefined && (!finePointer || hovered || focused);
  const dnd = useThreadDndState();
  const { setNodeRef } = useDroppable({
    id: getThreadGroupDroppableId(id),
    disabled: !dnd || archive || !dropTarget,
  });
  const closed =
    archive || defaultClosed
      ? !expandedArchives.includes(id)
      : collapsed.includes(id);
  const header = (
    <button
      type="button"
      aria-expanded={!closed}
      onClick={() =>
        updateState((current) => ({
          ...current,
          ...(archive || defaultClosed
            ? { expandedArchives: toggleValue(current.expandedArchives, id) }
            : { collapsed: toggleValue(current.collapsed, id) }),
        }))
      }
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-[var(--subtle-foreground)] outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
    >
      {icon && (
        <span
          aria-hidden="true"
          data-group-icon=""
          className="flex size-3.5 shrink-0 items-center justify-center"
        >
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-left font-medium">
        {title}
      </span>
      {count !== undefined && (
        <GroupCount count={count} attention={attention} />
      )}
      {trailing !== undefined && (
        // Reserves the trailing control's slot: a button cannot nest another
        // button, so the control itself sits over this gap.
        <span aria-hidden="true" className="size-4 shrink-0" />
      )}
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
      <div
        data-group-header={id}
        className="relative mb-1"
        // Only a header with a trailing control tracks hover and focus.
        {...(trailing !== undefined && {
          onPointerEnter: () => setHovered(true),
          onPointerLeave: () => setHovered(false),
          onFocus: () => setFocused(true),
          onBlur: (event: FocusEvent<HTMLDivElement>) => {
            if (
              !event.currentTarget.contains(event.relatedTarget as Node | null)
            )
              setFocused(false);
          },
        })}
      >
        {wrapHeader(header)}
        {showTrailing && (
          <span
            data-group-trailing=""
            className="absolute right-8 top-1/2 flex -translate-y-1/2 items-center"
          >
            {trailing}
          </span>
        )}
      </div>
      {belowHeader}
      {!closed && children}
    </section>
  );
}

// Thread arrays arrive with a fresh identity per host update, but a
// content-checked snapshot keeps memoized derivations stable across unrelated
// re-renders and still notices in-place edits (the test harness mutates the
// same array to model an update).
function useStableArray<T>(value: readonly T[]): readonly T[] {
  const ref = useRef<{ snapshot: readonly T[]; result: readonly T[] } | null>(
    null,
  );
  const prev = ref.current;
  if (
    prev &&
    prev.snapshot.length === value.length &&
    prev.snapshot.every((item, index) => item === value[index])
  )
    return prev.result;
  const result = [...value];
  ref.current = { snapshot: result, result };
  return result;
}

/** The client-state key of the closed Other threads entry. */
const OTHER_THREADS = "other-threads";

/**
 * The entry below the Adventures that folds every other thread: a row in the
 * Adventures' style (icon, title, the most urgent status of its threads, a
 * chevron), with the list options and New thread over its right end.
 */
function OtherThreadsEntry({
  open,
  status,
  trailing,
}: {
  open: boolean;
  status: Status | null;
  trailing: ReactNode;
}) {
  return (
    <div data-other-threads="" className="relative">
      <button
        type="button"
        aria-expanded={open}
        onClick={() =>
          updateState((current) => ({
            ...current,
            collapsed: toggleValue(current.collapsed, OTHER_THREADS),
          }))
        }
        className="flex min-h-7 w-full items-center gap-2 rounded-md pl-2 text-left text-[13px] leading-5 outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-9"
      >
        <span
          aria-hidden="true"
          className="flex size-4 shrink-0 items-center justify-center text-[var(--subtle-foreground)]"
        >
          <HostIcon name="MessageSquare" fallback="Folder" className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate">Other threads</span>
        {status && (
          <span role="img" aria-label={STATUS_LABEL[status]} className="flex shrink-0 items-center">
            <StatusIcon status={status} size="small" />
          </span>
        )}
        {/* The slot the list options and New thread sit over. */}
        <span aria-hidden="true" className="w-9 shrink-0" />
        <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center text-[var(--subtle-foreground)] max-md:size-9">
          <HostIcon
            name="ChevronDown"
            fallback="ArrowDown"
            className={`size-3.5 transition-transform ${open ? "" : "-rotate-90"}`}
          />
        </span>
      </button>
      <span className="absolute right-7 top-1/2 flex -translate-y-1/2 items-center gap-2.5 max-md:right-10">
        {trailing}
      </span>
    </div>
  );
}

/**
 * The Adventures list first, then the Other threads entry: every thread
 * outside the Adventures, grouped and sorted by this client's choices (no
 * grouping, most recent first by default); the open Adventure never changes
 * that list.
 */
function ThreadsList(props: PluginThreadListProps) {
  const { status, threads: rawThreads, projects } =
    experimental_useSidebarThreads();
  const hostThreads = useStableArray(rawThreads);
  const state = useClientState();
  const { listing } = state;
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
  // Adventure threads and everything they spawned are listed under their
  // Adventure, not here. Ids come from the server's complete snapshot (cached,
  // refreshed in the background).
  const threadKey = useMemo(
    () => threads.map((thread) => thread.id).join("|"),
    [threads],
  );
  const initiativeIds = useInitiativeThreadIds(threadKey);
  const snoozes = useSnooze();
  const snoozePresets = useSnoozePresets();
  const snoozeRpc = useRpc<typeof snoozeContract>();
  const [projectEdit, setProjectEdit] = useState<{
    kind: "rename" | "remove";
    id: string;
  } | null>(null);
  const projectRpc = useRpc<typeof projectContract>();
  const archives = useArchives(state.showArchives);
  // Archived rows (when loaded) supply parent links the active list lacks;
  // live rows come last so they win.
  const initiativeHidden = useMemo(
    () =>
      hiddenInitiativeThreads(
        archives.threads.length ? [...archives.threads, ...threads] : threads,
        initiativeIds ?? new Set(),
      ),
    [threads, archives.threads, initiativeIds],
  );
  const archived = useMemo(
    () =>
      state.showArchives
        ? archives.threads
            .filter((thread) => !initiativeHidden.has(thread.id))
            .map((thread) => ({
              thread,
              status: "done" as const,
            }))
        : [],
    [state.showArchives, archives.threads, initiativeHidden],
  );
  // Branch-PR eligibility for every listed thread in one bulk call; archived
  // rows get the same chip when the archive list is open.
  const branchPrEligible = useBranchPullRequestEligibility(
    useMemo(
      () => [...archives.threads, ...threads].map((thread) => thread.id),
      [threads, archives.threads],
    ),
  );
  const { providers } = experimental_useProviders();
  const actions = experimental_useSidebarThreadActions();
  const connection = useRealtimeConnectionState();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  // Opening a woke thread ends its attention signal. Once per document, so a
  // failed call does not repeat on every render.
  const acknowledged = useRef<string | null>(null);
  useEffect(() => {
    const id = props.activeThreadId;
    if (!id) return;
    const key = `${id}@${snoozes.doc.revision}`;
    if (acknowledged.current === key) return;
    if (
      !snoozes.doc.entries.some(
        (entry) => entry.threadId === id && isWoke(entry),
      )
    )
      return;
    acknowledged.current = key;
    void snoozeRpc.call("acknowledge", { threadId: id }).catch(report);
  });
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
            if (current.get(threadId) !== parentThreadId) return current;
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
          applyDetachDecision(
            decision,
            reparent,
            (threadId, pinned) => actions.setPinned(threadId, pinned),
            report,
            () => {
              let superseded = false;
              setParentOverrides((current) => {
                superseded = current.has(decision.activeId);
                return current;
              });
              return superseded;
            },
          );
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
            !initiativeHidden.has(candidate.id) &&
            candidate.id !== threadId &&
            candidate.id !== source.parentThreadId &&
            !isThreadWithinSubtree(dndLookup, threadId, candidate.id),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((candidate) => ({
          id: candidate.id,
          title: threadTitle(candidate),
        }));
    },
    [threads, dndLookup, initiativeHidden],
  );
  const projectNames = new Map(
    projects.map((project) => [project.id, projectLabel(project)]),
  );
  const providerNames = new Map(
    providers.map((provider) => [provider.id, provider.displayName]),
  );
  const providerRecords = new Map<string, ProviderIconRecord>(
    providers.map((provider) => [provider.id, provider]),
  );
  const titles = new Map(
    [...archives.threads, ...threads].map((thread) => [
      thread.id,
      threadTitle(thread),
    ]),
  );
  const knownDrafts = useMemo(() => new Set(state.drafts), [state.drafts]);
  // A sleeping snooze hides the thread and its descendants; a woke one keeps
  // the thread in Needs Attention until it is opened. The 60 s tick only
  // matters while entries exist, so an empty document does not rebuild the
  // trees below on every tick.
  const snoozeTick = snoozes.doc.entries.length ? now : 0;
  const { sleeping, wokeIds } = useMemo(() => {
    const sleeping = new Map<string, SnoozeEntry>();
    const wokeIds = new Set<string>();
    for (const entry of snoozes.doc.entries) {
      if (isSleeping(entry, snoozeTick)) sleeping.set(entry.threadId, entry);
      else if (isWoke(entry)) wokeIds.add(entry.threadId);
    }
    return { sleeping, wokeIds };
  }, [snoozes.doc, snoozeTick]);
  const snoozedIds = useMemo(
    () => familyMemberIds(threads, new Set(sleeping.keys())),
    [threads, sleeping],
  );
  const inView = useCallback(
    (thread: (typeof threads)[number]) =>
      !thread.isArchived && !initiativeHidden.has(thread.id),
    [initiativeHidden],
  );
  const withStatus = useCallback(
    (thread: (typeof threads)[number]) => ({
      thread,
      status: statusOf(
        thread,
        knownDrafts.has(`thread:${thread.id}`),
        wokeIds.has(thread.id),
      ),
    }),
    [knownDrafts, wokeIds],
  );
  // Archived and Initiative threads leave before pins and families; titles
  // stay unfiltered for parent labels.
  const available = useMemo(
    () =>
      threads
        .filter((thread) => inView(thread) && !snoozedIds.has(thread.id))
        .map(withStatus),
    [threads, inView, snoozedIds, withStatus],
  );
  // Snoozed families sort by wake time, soonest first.
  const snoozed = useMemo(
    () =>
      buildThreadTree(
        threads
          .filter((thread) => inView(thread) && snoozedIds.has(thread.id))
          .map(withStatus),
        listing.sortBy,
        listing.sortDirection,
      ).sort(
        (a, b) =>
          (sleeping.get(a.thread.id)?.until ?? 0) -
          (sleeping.get(b.thread.id)?.until ?? 0),
      ),
    [
      threads,
      inView,
      snoozedIds,
      withStatus,
      sleeping,
      listing.sortBy,
      listing.sortDirection,
    ],
  );
  const pinnedIds = useMemo(() => pinnedThreadIds(available), [available]);
  const pinned = useMemo(
    () =>
      buildThreadTree(
        available.filter(({ thread }) => pinnedIds.has(thread.id)),
        listing.sortBy,
        listing.sortDirection,
      ),
    [available, pinnedIds, listing.sortBy, listing.sortDirection],
  );
  const visible = useMemo(
    () =>
      available.filter(
        ({ thread, status }) =>
          !pinnedIds.has(thread.id) && !state.hidden.includes(status),
      ),
    [available, pinnedIds, state.hidden],
  );
  // Thread and project snapshots can arrive separately. Keep unmatched
  // threads and new drafts navigable until project metadata is available.
  const displayProjects = useMemo(() => {
    const display = new Map(
      projects.map((project) => [
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
      if (!display.has(thread.projectId)) {
        display.set(thread.projectId, {
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
      if (projectId && !display.has(projectId)) {
        display.set(projectId, {
          id: projectId,
          name: "Unknown project",
          isPersonal: false,
          known: false,
        });
      }
    }
    return display;
  }, [projects, visible, knownDrafts]);
  const newDrafts = useMemo(
    () =>
      [...displayProjects.values()].filter(
        (project) =>
          knownDrafts.has(`new:${project.id}`) &&
          !state.hidden.includes("draft"),
      ),
    [displayProjects, knownDrafts, state.hidden],
  );
  const families = useMemo(
    () =>
      buildThreadTree(visible, listing.sortBy, listing.sortDirection).map(
        (node) => ({
          node,
          status: familyStatus(node),
        }),
      ),
    [visible, listing.sortBy, listing.sortDirection],
  );
  // Project grouping builds one tree per project, only in that view.
  const projectTrees = useMemo(() => {
    const trees = new Map<string, ThreadNode[]>();
    if (listing.groupBy !== "project") return trees;
    const byProject = new Map<string, typeof visible>();
    for (const row of visible) {
      const rows = byProject.get(row.thread.projectId);
      if (rows) rows.push(row);
      else byProject.set(row.thread.projectId, [row]);
    }
    for (const [id, rows] of byProject)
      trees.set(
        id,
        buildThreadTree(rows, listing.sortBy, listing.sortDirection),
      );
    return trees;
  }, [listing.groupBy, visible, listing.sortBy, listing.sortDirection]);
  const archivedTree = useMemo(
    () => buildThreadTree(archived, listing.sortBy, listing.sortDirection),
    [archived, listing.sortBy, listing.sortDirection],
  );
  const openNew = (id?: string) => {
    actions.openNewThread({ projectId: id, focusPrompt: true });
    props.onNavigate();
  };
  const removeProject = async (projectId: string) => {
    await projectRpc.call("deleteProject", { projectId });
  };
  // Rows under a project header omit the project name, which would repeat it.
  const makeRow = (showProject: boolean, singleLine = false) => {
    const row = (
      { thread, status, children }: ThreadNode,
      depth = 0,
    ): ReactNode => (
      <ThreadRow
        key={thread.id}
        now={now}
        sortBy={listing.sortBy}
        thread={thread}
        status={status}
        depth={depth}
        project={projectNames.get(thread.projectId) ?? "Unknown project"}
        showProject={showProject}
        singleLine={singleLine}
        provider={providerNames.get(thread.providerId) ?? thread.providerId}
        providerRecord={
          providerRecords.get(thread.providerId) ?? { id: thread.providerId }
        }
        parent={
          thread.parentThreadId ? titles.get(thread.parentThreadId) : undefined
        }
        active={props.activeThreadId === thread.id}
        nesting={{
          candidates: nestCandidatesFor(thread.id),
          onSetParent: (parentThreadId) =>
            reparent(thread.id, parentThreadId),
        }}
        branchPullRequestEligible={branchPrEligible.get(thread.id)}
        snooze={{
          until: sleeping.get(thread.id)?.until ?? null,
          woke: wokeIds.has(thread.id),
          presets: snoozePresets.doc.presets,
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
  // No project has no folder, branch, or pull request to list; its threads
  // get a single-line row.
  const personalRow = makeRow(false, true);
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
  // No grouping: one list, newest drafts first.
  const recentRoots = (
    <ThreadRoots
      label="Recent"
      pageSize={25}
      nodes={families.map(({ node }) => node)}
      drafts={newDrafts}
      draftsFirst
      activeThreadId={props.activeThreadId}
      renderRow={(node) => row(node)}
      renderDraft={draftRow}
    />
  );
  const otherOpen = !state.collapsed.includes(OTHER_THREADS);
  const otherStatuses = new Set([
    ...families.map((family) => family.status),
    ...pinned.map(familyStatus),
  ]);
  const otherStatus =
    (["attention", "unread", "working"] as const).find((s) =>
      otherStatuses.has(s),
    ) ?? null;
  const threadSection = (
    <DndContext {...dnd.dndContextProps}>
      <ThreadDndContext.Provider value={status === "ready" ? dnd.state : null}>
        <div className="px-2">
          <OtherThreadsEntry
            open={otherOpen}
            status={otherStatus}
            trailing={
              <>
                <ListingMenu />
                <button
                  type="button"
                  aria-label="New thread"
                  title="New thread"
                  onClick={() => openNew(props.activeProjectId || undefined)}
                  className={sectionActionClass}
                >
                  <HostIcon name="Plus" fallback="FolderPlus" className="size-3.5" />
                </button>
              </>
            }
          />
        </div>
        {otherOpen && (
        <div
          data-activity-thread-groups=""
          onClickCapture={dnd.onClickCapture}
          onKeyDown={dnd.onEscape}
          className="px-2 pb-3"
        >
          {status === "loading" || initiativeIds === null ? (
            <p role="status" className="p-2 text-sm text-muted-foreground">
              Loading threads…
            </p>
          ) : status === "error" ? (
            // BB 0.45 no longer passes `Original` to thread lists, so the
            // error branch stands alone on every version.
            <div role="alert" className="p-2 text-sm">
              Cannot load threads.
            </div>
          ) : (
            <>
              {pinned.length > 0 && (
                <Group
                  id="pinned"
                  title="Pinned"
                  count={pinned.length}
                  icon={
                    <HostIcon
                      name="Pin"
                      fallback="Star"
                      className="size-3.5 text-[var(--bbp-file,var(--timeline-accent))]"
                    />
                  }
                >
                  <ul aria-label="Pinned threads" className="m-0 list-none p-0">
                    {pinned.map((entry) => row(entry))}
                  </ul>
                </Group>
              )}
              {state.hidden.length === STATUSES.length && (
                <p className="p-2 text-xs text-muted-foreground">
                  All statuses are hidden. Use the thread list options to show
                  them.
                </p>
              )}
              {listing.groupBy === "none" ? (
                pinned.length > 0 ? (
                  // Under Pinned, a title keeps the rest from reading as pinned.
                  <Group
                    id="recent"
                    title="Recent"
                    count={families.length + newDrafts.length}
                  >
                    {recentRoots}
                  </Group>
                ) : (
                  recentRoots
                )
              ) : listing.groupBy === "status"
                ? STATUSES.filter((s) => !state.hidden.includes(s)).map((s) => {
                    const rows = families.filter((family) => family.status === s);
                    const count =
                      rows.length + (s === "draft" ? newDrafts.length : 0);
                    if (!count) return null;
                    return (
                      <Group
                        key={s}
                        id={`status:${s}`}
                        title={STATUS_LABEL[s]}
                        count={count}
                        attention={s === "attention"}
                        icon={<StatusIcon status={s} size="small" />}
                      >
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
                : // No project closes the list, right above Archived.
                  [...displayProjects.values()]
                    .sort((a, b) =>
                      a.isPersonal === b.isPersonal
                        ? a.name.localeCompare(b.name)
                        : a.isPersonal
                          ? 1
                          : -1,
                    )
                    .map((project) => {
                      const rows = projectTrees.get(project.id) ?? [];
                      const drafts = newDrafts.filter(
                        (draft) => draft.id === project.id,
                      );
                      return rows.length || drafts.length ? (
                        <Group
                          key={project.id}
                          id={`project:${project.id}`}
                          title={project.name}
                          icon={
                            <ProjectGlyph
                              name={project.name}
                              neutral={project.isPersonal}
                            />
                          }
                          trailing={
                            project.known ? (
                              <button
                                type="button"
                                data-project-new-thread={project.id}
                                aria-label={`New thread in ${project.name}`}
                                title="New thread"
                                // Keep the press away from the header's long press.
                                onPointerDown={(event) =>
                                  event.stopPropagation()
                                }
                                onClick={(event) => {
                                  event.stopPropagation();
                                  openNew(project.id);
                                }}
                                // ::before widens the tap target to 28x28
                                // while the painted box stays 16x16; it
                                // stops 2px short of the chevron's slot.
                                className="relative flex size-4 items-center justify-center rounded text-[var(--subtle-foreground)] outline-none before:absolute before:-inset-1.5 before:content-[''] hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                              >
                                <HostIcon
                                  name="Plus"
                                  fallback="FolderPlus"
                                  className="size-3.5"
                                />
                              </button>
                            ) : undefined
                          }
                          wrapHeader={(header) =>
                            !project.known ? (
                              header
                            ) : (
                              <ProjectHeaderMenu
                                projectId={project.id}
                                projectName={project.name}
                                isPersonal={project.isPersonal}
                                onAction={(action) => {
                                  if (action === "new-thread")
                                    openNew(project.id);
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
                            renderRow={(node) =>
                              (project.isPersonal ? personalRow : projectRow)(
                                node,
                              )
                            }
                            renderDraft={draftRow}
                          />
                        </Group>
                      ) : null;
                    })}
              {state.showSnoozed && snoozed.length > 0 && (
                <Group
                  id="snoozed"
                  title="Snoozed"
                  defaultClosed
                  dropTarget={false}
                  count={snoozed.length}
                  icon={
                    <HostIcon
                      name="Clock"
                      fallback="Circle"
                      className="size-3.5 text-[var(--subtle-foreground)]"
                    />
                  }
                >
                  <ul aria-label="Snoozed threads" className="m-0 list-none p-0">
                    {snoozed.map((entry) => row(entry))}
                  </ul>
                </Group>
              )}
              {archived.length > 0 && (
                <Group
                  id="archive"
                  title="Archived"
                  archive
                  count={archived.length}
                  icon={<ArchiveIcon />}
                >
                  <ThreadRoots
                    label="Archived"
                    pageSize={10}
                    nodes={archivedTree}
                    drafts={[]}
                    activeThreadId={props.activeThreadId}
                    renderRow={(node) => row(node)}
                    renderDraft={draftRow}
                  />
                </Group>
              )}
              {state.hidden.length < STATUSES.length &&
                !archived.length &&
                (!state.showSnoozed || !snoozed.length) &&
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
        )}
      </ThreadDndContext.Provider>
      <DragOverlay dropAnimation={null}>
        {dnd.activeThreadId && dnd.state.dragMoved ? (
          <ThreadDragOverlay
            title={titles.get(dnd.activeThreadId) ?? "Thread"}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
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
      <ProjectHueStyle />
      <div className="shrink-0 px-2">
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
        data-sidebar-view=""
        className={
          props.isCompactViewport ? "" : "min-h-0 flex-1 overflow-y-auto"
        }
      >
        <div className="px-2">
          <AdventuresSection
            activeThreadId={props.activeThreadId}
            activeProjectId={props.activeProjectId || null}
            onNavigate={props.onNavigate}
          />
        </div>
        {threadSection}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "snooze",
    title: "Snooze presets",
    component: SnoozeSettings,
  });
  app.slots.experimental_threadList({
    id: "sidebar",
    title: "Threads",
    description:
      "Adventures with their workers first, then every other thread, recent first or grouped by status or project.",
    component: ThreadsList,
  });
  app.composer.customize({
    id: "draft-tracking",
    scopes: ["thread", "new-thread"],
    banners: [{ id: "observe", chrome: "bare", component: DraftObserver }],
  });
});
