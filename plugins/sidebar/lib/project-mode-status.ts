import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { ProjectTree } from "./project-tree-schema";
import type { ThreadNode } from "./thread-tree";
import { compareThreads, statusOf, type SortBy, type SortDirection, type Status } from "./status";

type Project = ProjectTree["projects"][number];

/** Includes legacy native descendants without displaying them in project mode. */
export function projectThreads(
  project: Project,
  native: readonly PluginSidebarThread[],
) {
  const children = new Map<string, PluginSidebarThread[]>();
  for (const thread of native) {
    if (thread.isArchived || !thread.parentThreadId) continue;
    const siblings = children.get(thread.parentThreadId) ?? [];
    siblings.push(thread);
    children.set(thread.parentThreadId, siblings);
  }
  const ids = new Set(
    project.nodes.flatMap((n) => (n.threadId ? [n.threadId] : [])),
  );
  if (project.coordinatorThreadId) ids.add(project.coordinatorThreadId);
  const pending = [...ids];
  while (pending.length) {
    for (const child of children.get(pending.pop()!) ?? []) {
      if (ids.has(child.id)) continue;
      ids.add(child.id);
      pending.push(child.id);
    }
  }
  return native.filter((thread) => ids.has(thread.id) && !thread.isArchived);
}

export function projectStatus(
  project: Project,
  threads: readonly PluginSidebarThread[],
  drafts: string[],
): "unread" | "working" | "draft" | "done" {
  const coordinator = threads.find((t) => t.id === project.coordinatorThreadId);
  if (
    project.opinions ||
    coordinator?.isUnread ||
    coordinator?.indicator === "unread-success" ||
    threads.some((t) => statusOf(t) === "attention")
  )
    return "unread";
  if (
    threads.some((t) => statusOf(t) === "working") ||
    project.nodes.some(
      (n) =>
        n.threadId &&
        !threads.some((t) => t.id === n.threadId) &&
        n.state === "active",
    )
  )
    return "working";
  const draftKeys = new Set(drafts);
  if (
    threads.some(
      (t) => draftKeys.has(`thread:${t.id}`) || t.indicator === "draft",
    ) ||
    project.nodes.some(
      (n) => n.threadId && draftKeys.has(`thread:${n.threadId}`),
    ) ||
    project.memberProjectIds.some((id) => draftKeys.has(`new:${id}`))
  )
    return "draft";
  return "done";
}

/**
 * The displayed flat order: stored ids first, filtered to projects the tree
 * still lists, then projects the stored order does not know yet in tree order.
 * A null order (nothing persisted or read yet) passes the tree through.
 */
export function orderedProjects(
  projects: readonly Project[],
  order: readonly string[] | null,
): Project[] {
  if (!order?.length) return [...projects];
  const byId = new Map(projects.map((project) => [project.id, project]));
  const listed = new Set<string>();
  const out: Project[] = [];
  for (const id of order) {
    const project = byId.get(id);
    if (project && !listed.has(id)) {
      listed.add(id);
      out.push(project);
    }
  }
  for (const project of projects) {
    if (!listed.has(project.id)) out.push(project);
  }
  return out;
}

/**
 * The durable project the user is looking at: an exact coordinator or worker
 * thread match wins over the thread's native project membership, which wins
 * over the route's project context. Membership can overlap between durable
 * projects, so the first project in the given order takes a tie.
 */
export function selectedProject(
  projects: readonly Project[],
  threads: readonly PluginSidebarThread[],
  activeThreadId: string | null,
  activeProjectId: string | null,
): Project | null {
  const active = threads.find((t) => t.id === activeThreadId);
  const nativeProjectId = active?.projectId ?? activeProjectId;
  return (
    projects.find(
      (p) =>
        p.coordinatorThreadId !== null &&
        p.coordinatorThreadId === activeThreadId,
    ) ??
    projects.find((p) =>
      p.nodes.some((n) => n.threadId !== null && n.threadId === activeThreadId),
    ) ??
    projects.find(
      (p) =>
        nativeProjectId !== null &&
        nativeProjectId !== undefined &&
        p.memberProjectIds.includes(nativeProjectId),
    ) ??
    null
  );
}

/**
 * The selected project's current non-coordinator threads: every live worker
 * node is a root in the tree's own order, followed by its native descendants
 * while they still carry a live status. Settled descendants hide but their
 * own live children still surface under the nearest listed ancestor. The
 * coordinator is never a row (its project row already opens it), archived
 * threads and their subtrees are skipped, and retired workers and former
 * generations are absent because the tree only names current threads and the
 * walk never descends from the coordinator.
 */
export function currentProjectThreads(
  project: Project,
  native: readonly PluginSidebarThread[],
  drafts: readonly string[],
  sortBy: SortBy,
  direction: SortDirection,
): ThreadNode[] {
  const draftKeys = new Set(drafts);
  const statusFor = (thread: PluginSidebarThread): Status =>
    statusOf(thread, draftKeys.has(`thread:${thread.id}`));
  const byId = new Map(native.map((thread) => [thread.id, thread]));
  const children = new Map<string, PluginSidebarThread[]>();
  for (const thread of native) {
    if (thread.isArchived || !thread.parentThreadId) continue;
    const siblings = children.get(thread.parentThreadId) ?? [];
    siblings.push(thread);
    children.set(thread.parentThreadId, siblings);
  }
  const nodeByThread = new Map(
    project.nodes
      .filter((node) => node.threadId !== null)
      .map((node) => [node.threadId!, node] as const),
  );
  const seen = new Set<string>();
  const roots: ThreadNode[] = [];
  for (const node of project.nodes) {
    if (node.role === "coordinator" || !node.threadId) continue;
    const thread = byId.get(node.threadId);
    if (!thread || thread.isArchived || seen.has(thread.id)) continue;
    seen.add(thread.id);
    roots.push({
      thread,
      status: statusFor(thread),
      children: [],
      identity: node.worker ? { worker: node.worker, label: node.label } : null,
    });
  }
  const walk = (id: string, attachTo: ThreadNode) => {
    for (const child of children.get(id) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      if (statusFor(child) === "done") {
        walk(child.id, attachTo);
        continue;
      }
      const ledger = nodeByThread.get(child.id);
      const node: ThreadNode = {
        thread: child,
        status: statusFor(child),
        children: [],
        identity: ledger?.worker
          ? { worker: ledger.worker, label: ledger.label }
          : null,
      };
      attachTo.children.push(node);
      walk(child.id, node);
    }
  };
  const sort = (list: ThreadNode[]) => {
    list.sort((a, b) =>
      compareThreads(a.thread, b.thread, sortBy, direction),
    );
    for (const node of list) sort(node.children);
  };
  for (const root of roots) {
    walk(root.thread.id, root);
    sort(root.children);
  }
  return roots;
}
