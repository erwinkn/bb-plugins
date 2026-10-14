import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { ProjectTree } from "./project-tree-schema";
import { statusOf } from "./status";

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

/** Open questions and blocked reports waiting on the user; older trees only count questions. */
export const needsYou = (project: Project) => project.needsYou ?? project.opinions;

/** The row's one status. Something waiting on the user outranks everything else. */
export function projectStatus(
  project: Project,
  threads: readonly PluginSidebarThread[],
  drafts: string[],
): "attention" | "unread" | "working" | "draft" | "done" {
  if (needsYou(project)) return "attention";
  const coordinator = threads.find((t) => t.id === project.coordinatorThreadId);
  if (
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

/** When the Initiative's threads last changed (newest `updatedAt`), or null without any. */
export function lastActivity(
  threads: readonly PluginSidebarThread[],
): number | null {
  let latest: number | null = null;
  for (const thread of threads)
    if (latest === null || thread.updatedAt > latest) latest = thread.updatedAt;
  return latest;
}
