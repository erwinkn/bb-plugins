import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { ProjectTree } from "./project-tree-schema";
import type { AdventureWorker, WorkerGroup } from "./adventure-workers";
import type { WorkerListing } from "./client-state";
import { activityAt, statusOf, type Status } from "./status";
import type { ThreadNode } from "./thread-tree";

type Project = ProjectTree["projects"][number];

/** One worker under its Adventure: its thread, with its BB descendants as children. */
export interface WorkerRow {
  node: ThreadNode;
  /** "W12". */
  ref: string;
  /** Null until the server has read it (or Initiatives does not know it). */
  profile: string | null;
  group: WorkerGroup;
}

const workerNumber = (ref: string) => Number(/\d+/.exec(ref)?.[0] ?? 0);

/**
 * What a selected Adventure lists: each current worker whose BB thread is
 * live, and its live member threads (discussions, threads attached by hand),
 * each with its live descendants. The coordinator is not listed (the
 * Adventure's own row opens it), nor are the threads it spawned that are not
 * workers. A worker's thread is listed once, as its own row, never again as
 * another thread's child. The group follows the
 * server's facts, except that BB's live status wins at once: a thread
 * waiting for input needs you, a running one is working, a quiet one
 * with a live descendant is waiting, and one the server still reads as
 * running that BB shows stopped, or with a new error, moves where the Workers
 * tab's derivation puts it (the facts carry both variants). A descendant
 * BB lists as quiet but Initiatives knows is queued shows through the facts.
 */
export function adventureRows(
  project: Project,
  native: readonly PluginSidebarThread[],
  drafts: readonly string[],
  facts: readonly AdventureWorker[] | undefined,
  sortBy: WorkerListing["sortBy"],
): { workers: WorkerRow[]; others: ThreadNode[] } {
  const draftKeys = new Set(drafts);
  const statusFor = (thread: PluginSidebarThread): Status =>
    statusOf(thread, draftKeys.has(`thread:${thread.id}`));
  const byId = new Map<string, PluginSidebarThread>();
  const children = new Map<string, PluginSidebarThread[]>();
  // Every parent link, archived threads included, so liveness is followed
  // through an archived thread in between.
  const allChildren = new Map<string, PluginSidebarThread[]>();
  const link = (map: typeof children, thread: PluginSidebarThread) => {
    if (!thread.parentThreadId) return;
    const siblings = map.get(thread.parentThreadId) ?? [];
    siblings.push(thread);
    map.set(thread.parentThreadId, siblings);
  };
  for (const thread of native) {
    link(allChildren, thread);
    if (thread.isArchived) continue;
    byId.set(thread.id, thread);
    link(children, thread);
  }
  const workerNodes = project.nodes.filter(
    (n) => n.role !== "coordinator" && n.worker && n.threadId && byId.has(n.threadId),
  );
  // Worker threads are rows of their own; walks skip them, and a thread seen
  // once is never listed again (a cycle in stale parent links stops too).
  const seen = new Set(workerNodes.map((n) => n.threadId!));
  if (project.coordinatorThreadId) seen.add(project.coordinatorThreadId);
  const subtree = (id: string): ThreadNode[] => {
    const list = (children.get(id) ?? []).filter((child) => !seen.has(child.id));
    for (const child of list) seen.add(child.id);
    return list
      .sort((a, b) => activityAt(b) - activityAt(a) || a.id.localeCompare(b.id))
      .map((child) => ({ thread: child, status: statusFor(child), children: subtree(child.id) }));
  };
  // Over every live descendant, listed under this worker or not (another
  // worker's thread nested under it is its own row, a thread under an
  // archived one is not listed). Live as Initiatives' running() counts it:
  // running, or asking for input.
  const liveBelow = (id: string): boolean => {
    const pending = [id];
    const visited = new Set(pending);
    while (pending.length)
      for (const child of allChildren.get(pending.pop()!) ?? []) {
        if (visited.has(child.id)) continue;
        if (
          !child.isArchived &&
          (statusFor(child) === "working" ||
            child.hasPendingInteraction ||
            child.indicator === "waiting-for-input")
        )
          return true;
        visited.add(child.id);
        pending.push(child.id);
      }
    return false;
  };
  const factsByRef = new Map(facts?.map((f) => [f.ref, f]));
  const workers = workerNodes.map((n): WorkerRow => {
    const thread = byId.get(n.threadId!)!;
    const status = statusFor(thread);
    const children = subtree(thread.id);
    const known = factsByRef.get(n.worker!);
    const waitsForInput = status === "attention" && thread.indicator !== "unread-error";
    // A quiet worker over a live review waits, whatever its last report said.
    const group: WorkerGroup =
      known?.group === "needs" || waitsForInput
        ? "needs"
        : status === "working"
          ? "working"
          : liveBelow(thread.id)
            ? "waiting"
            : thread.indicator === "unread-error"
              // BB shows a new error the server's group does not know of yet.
              ? (known?.errored ?? "stopped")
              : known?.group === "working"
                // The server still reads it as running; BB's live view says it is not.
                ? (known.quiet ?? known.group)
                : (known?.group ?? "idle");
    return {
      node: { thread, status, children },
      ref: n.worker!,
      profile: known?.profile ?? null,
      group,
    };
  });
  workers.sort((a, b) =>
    sortBy === "worker"
      ? workerNumber(b.ref) - workerNumber(a.ref)
      : activityAt(b.node.thread) - activityAt(a.node.thread) ||
        workerNumber(b.ref) - workerNumber(a.ref),
  );
  // Member threads (discussions, threads attached by hand) whose parent is
  // not listed elsewhere: the coordinator, nothing, or a thread BB no longer
  // lists. One under a former worker's thread belongs to that past work.
  const parentGone = (thread: PluginSidebarThread) =>
    !thread.parentThreadId ||
    thread.parentThreadId === project.coordinatorThreadId ||
    !byId.has(thread.parentThreadId);
  const members = project.nodes
    .filter((n) => n.role === "adhoc" && n.threadId)
    .map((n) => byId.get(n.threadId!))
    .filter((thread): thread is PluginSidebarThread => !!thread && !seen.has(thread.id) && parentGone(thread));
  for (const thread of members) seen.add(thread.id);
  const others = members
    .sort((a, b) => activityAt(b) - activityAt(a) || a.id.localeCompare(b.id))
    .map((thread) => ({ thread, status: statusFor(thread), children: subtree(thread.id) }));
  return { workers, others };
}

/** The thread title without the leading worker id BB titles start with: "W12 Fix login" → "Fix login". */
export function withoutRef(title: string, ref: string): string {
  const rest = title.startsWith(`${ref} `) ? title.slice(ref.length + 1).trimStart() : title;
  return rest || title;
}
