import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  experimental_useProviders,
  experimental_useSidebarThreads,
} from "@get-bb/plugin-sdk/app";
import type { ProjectTree } from "../lib/project-tree-schema";
import { useClientState } from "../lib/client-state";
import { adventureRows, type WorkerRow } from "../lib/adventure-rows";
import {
  modelLabel,
  WORKER_GROUPS,
  type AdventureWorker,
  type WorkerGroup,
} from "../lib/adventure-workers";
import { projectLabel } from "../lib/project-schema";
import { threadTitle } from "../lib/status";
import { containsThread, type ThreadNode } from "../lib/thread-tree";
import { useBranchPullRequestEligibility } from "../lib/use-branch-pull-request-eligibility";
import { HostIcon } from "../lib/host-icon";
import { GroupCount } from "./group-count";
import { ThreadChildren } from "./thread-children";
import { ThreadRoots } from "./thread-roots";
import { ThreadRow, type ProviderIconRecord } from "./thread-row";

const GROUP_LABEL: Record<WorkerGroup, string> = {
  needs: "Needs you",
  working: "Working",
  done: "Done",
  stopped: "Stopped",
  idle: "Idle",
};
/** Rows a group shows before Show more: what needs you or runs shows whole. */
const GROUP_PAGE: Record<WorkerGroup, number> = {
  needs: 50,
  working: 50,
  done: 5,
  stopped: 5,
  idle: 5,
};

/**
 * The selected Adventure's rows below the Adventures: its workers, grouped by state or in one list as this client chose, then its
 * member threads. Every row is the usual thread row; a worker's adds its id
 * and model. Child threads stay folded under a toggle that shows only when
 * there are some.
 */
export function AdventureWorkers({
  project,
  facts,
  activeThreadId,
  onNavigate,
  onError,
}: {
  project: ProjectTree["projects"][number];
  /** The server's facts about the workers, or undefined before the first read. */
  facts: readonly AdventureWorker[] | undefined;
  activeThreadId: string | null;
  onNavigate: () => void;
  onError: (error: unknown) => void;
}) {
  const native = experimental_useSidebarThreads();
  const { providers } = experimental_useProviders();
  const client = useClientState();
  const listing = client.workerListing;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const { workers, others } = useMemo(
    () => adventureRows(project, native.threads, client.drafts, facts, listing.sortBy),
    [project, native.threads, client.drafts, facts, listing.sortBy],
  );
  const listedIds = useMemo(() => {
    const ids: string[] = [];
    const collect = (nodes: readonly ThreadNode[]) => {
      for (const node of nodes) {
        ids.push(node.thread.id);
        collect(node.children);
      }
    };
    collect(workers.map((w) => w.node));
    collect(others);
    return ids;
  }, [workers, others]);
  const branchPrEligible = useBranchPullRequestEligibility(listedIds);
  const byThread = new Map(workers.map((w) => [w.node.thread.id, w]));
  const providerNames = new Map(providers.map((p) => [p.id, p.displayName]));
  const providerRecords = new Map<string, ProviderIconRecord>(
    providers.map((p) => [p.id, p]),
  );
  const projectNames = new Map(native.projects.map((p) => [p.id, projectLabel(p)]));
  const row = (node: ThreadNode, depth = 0): ReactNode => {
    const { thread } = node;
    const worker = depth === 0 ? byThread.get(thread.id) : undefined;
    return (
      <ThreadRow
        key={thread.id}
        now={now}
        sortBy="updated"
        thread={thread}
        status={node.status}
        depth={depth}
        project={projectNames.get(thread.projectId) ?? "Unknown project"}
        showProject={!worker}
        provider={providerNames.get(thread.providerId) ?? thread.providerId}
        providerRecord={providerRecords.get(thread.providerId) ?? { id: thread.providerId }}
        active={activeThreadId === thread.id}
        branchPullRequestEligible={branchPrEligible.get(thread.id)}
        worker={
          worker && {
            ref: worker.ref,
            model: modelLabel(worker.profile),
            profile: worker.profile,
          }
        }
        onNavigate={onNavigate}
        onError={onError}
      >
        {node.children.length > 0 && (
          <ChildThreads
            nodes={node.children}
            parentTitle={threadTitle(thread)}
            depth={depth + 1}
            activeThreadId={activeThreadId}
            renderRow={row}
          />
        )}
      </ThreadRow>
    );
  };
  const list = (label: string, rows: readonly WorkerRow[], pageSize: number) => (
    <ThreadRoots
      label={label}
      pageSize={pageSize}
      nodes={rows.map((w) => w.node)}
      drafts={[]}
      activeThreadId={activeThreadId}
      renderRow={(node) => row(node)}
      renderDraft={() => null}
    />
  );
  // Before the first read nothing says which group a quiet worker is in, so
  // the rows show in one list until it lands.
  const grouped = listing.groupBy === "state" && facts !== undefined;
  return (
    <div data-adventure-workers={project.id} className="pb-3">
      {native.status === "loading" ? (
        <p role="status" className="p-2 text-sm text-muted-foreground">
          Loading workers…
        </p>
      ) : native.status === "error" ? (
        <div role="alert" className="p-2 text-sm">
          Cannot load threads.
        </div>
      ) : (
        !workers.length &&
        !others.length && (
          <p className="px-2 py-1 text-xs text-muted-foreground">No live workers.</p>
        )
      )}
      {grouped
        ? WORKER_GROUPS.map((group) => {
            const rows = workers.filter((w) => w.group === group);
            if (!rows.length) return null;
            return (
              <section key={group} aria-label={GROUP_LABEL[group]} data-worker-group={group}>
                <h3 className="m-0 flex items-center gap-2 px-2 pb-0.5 pt-1.5 text-[11px] font-medium text-[var(--subtle-foreground)]">
                  <span className="min-w-0 flex-1 truncate">{GROUP_LABEL[group]}</span>
                  <GroupCount count={rows.length} attention={group === "needs"} />
                </h3>
                {list(`${project.name} ${GROUP_LABEL[group]}`, rows, GROUP_PAGE[group])}
              </section>
            );
          })
        : workers.length > 0 && list(`${project.name} workers`, workers, 15)}
      {others.length > 0 && (
        <ChildThreads
          nodes={others}
          parentTitle={project.name}
          noun="member thread"
          depth={1}
          activeThreadId={activeThreadId}
          renderRow={row}
        />
      )}
    </div>
  );
}

/**
 * A folded list of child threads: a toggle naming how many, closed until
 * opened, or while it holds the open thread. Rows paginate and nest as
 * anywhere else in the sidebar.
 */
function ChildThreads({
  nodes,
  parentTitle,
  noun = "child thread",
  depth,
  activeThreadId,
  renderRow,
}: {
  nodes: ThreadNode[];
  parentTitle: string;
  noun?: string;
  /** The depth of the listed rows. */
  depth: number;
  activeThreadId: string | null;
  renderRow: (node: ThreadNode, depth: number) => ReactNode;
}) {
  const holdsActive = nodes.some((node) => containsThread(node, activeThreadId));
  const [open, setOpen] = useState(holdsActive);
  useEffect(() => {
    if (holdsActive) setOpen(true);
  }, [holdsActive]);
  const count = nodes.length;
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${open ? "Hide" : "Show"} ${count} ${noun}${count === 1 ? "" : "s"} of ${parentTitle}`}
        data-child-toggle=""
        onClick={() => setOpen(!open)}
        style={{ paddingLeft: `${0.5 + (depth - 1) * 1.5}rem` }}
        className="flex min-h-6 w-full items-center gap-1 rounded pr-2 text-left text-xs text-[var(--subtle-foreground)] outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-9"
      >
        <HostIcon
          name="ChevronRight"
          className={`size-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        />
        {count} {noun}
        {count === 1 ? "" : "s"}
      </button>
      {open && (
        <ThreadChildren
          nodes={nodes}
          parentTitle={parentTitle}
          depth={depth}
          activeThreadId={activeThreadId}
          renderRow={renderRow}
        />
      )}
    </>
  );
}
