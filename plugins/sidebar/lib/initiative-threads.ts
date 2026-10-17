import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { ProjectTree } from "./project-tree-schema";

/**
 * Every thread the Initiatives tree names: coordinators, workers, reviewers
 * and the Initiative's other member threads (discussions among them). The
 * Initiative panel owns these, so the Threads view leaves them out.
 */
export function initiativeThreadIds(tree: ProjectTree): string[] {
  const ids = new Set<string>();
  for (const project of tree.projects) {
    if (project.coordinatorThreadId) ids.add(project.coordinatorThreadId);
    for (const node of project.nodes) if (node.threadId) ids.add(node.threadId);
  }
  return [...ids];
}

const PAGE = 200;
/** How long the archived threads' parent links serve before they are read again. */
export const ARCHIVED_LINKS_MS = 6 * 60 * 60_000;

// Rejects at once on abort, even if the host ignores the signal, so a stuck
// call cannot hold the walk.
export const abortable = <T>(read: Promise<T>, signal: AbortSignal) =>
  new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    read.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });

/**
 * The thread forest's parent links, for the descendant closure of the
 * Initiative threads. Each walk reads the active threads (a couple of list
 * pages) and, one by one, their archived ancestors (archiving cascades, so
 * there are usually none). The archived threads, thousands that seldom
 * change, are read again only every ARCHIVED_LINKS_MS; in between, each
 * archive, restore or move made here records the thread's new link. Links
 * are added or updated, never dropped; a deleted thread's link is cut, so
 * its surviving children no longer reach its parent.
 */
export function createThreadForest(bb: BbPluginApi) {
  const links = new Map<string, string | null>();
  // An event's link wins over a read sent before it: the sequence number of
  // the last event about each thread.
  let sequence = 0;
  const changedAt = new Map<string, number>();
  const record = (since: number, id: string, parentId: string | null) => {
    if ((changedAt.get(id) ?? 0) <= since) links.set(id, parentId);
  };
  const changed = (id: string, parentId: string | null) => {
    changedAt.set(id, ++sequence);
    links.set(id, parentId);
  };
  let archivedReadAt = -Infinity;
  // Parents BB no longer has, skipped until the next archived read.
  let gone = new Set<string>();
  for (const event of ["thread.archived", "thread.unarchived"] as const)
    bb.events.on(event, ({ thread }) => changed(thread.id, thread.parentThreadId));
  // A deleted thread no longer links its surviving children to its parent.
  bb.events.on("thread.deleted", ({ thread }) => changed(thread.id, null));
  // The ids of the threads in one archive state, recording their links.
  const read = async (archived: boolean, signal: AbortSignal) => {
    const ids = new Set<string>();
    for (let offset = 0; ; offset += PAGE) {
      signal.throwIfAborted();
      const since = sequence;
      const page = await abortable(
        bb.sdk.threads.list({ archived, includeHidden: true, limit: PAGE, offset, signal }),
        signal,
      );
      for (const thread of page) {
        ids.add(thread.id);
        record(since, thread.id, thread.parentThreadId);
      }
      if (page.length < PAGE) return ids;
    }
  };
  // Reads on its own each parent outside `active` that is an ancestor of an
  // active thread (its link may have changed since it was archived), or that
  // has no link at all (a restore while the archived threads are paged can
  // shift a row past a page boundary). A failed read fails the walk.
  const readParents = async (active: ReadonlySet<string>, signal: AbortSignal) => {
    const fresh = new Set<string>();
    for (;;) {
      const due = new Set<string>();
      for (const [id, parentId] of links)
        if (
          parentId &&
          !active.has(parentId) &&
          !fresh.has(parentId) &&
          !gone.has(parentId) &&
          (active.has(id) || fresh.has(id) || !links.has(parentId))
        )
          due.add(parentId);
      if (!due.size) return;
      for (const threadId of due) {
        signal.throwIfAborted();
        const since = sequence;
        try {
          const thread = await abortable(bb.sdk.threads.get({ threadId, signal }), signal);
          record(since, threadId, thread.parentThreadId);
          fresh.add(threadId);
        } catch (cause) {
          if ((cause as { status?: number } | null)?.status !== 404) throw cause;
          record(since, threadId, null);
          gone.add(threadId);
        }
      }
    }
  };
  return {
    /** A thread moved to another parent (BB announces no such event). */
    moved: changed,
    /**
     * The seeds plus every descendant of one, archived or not (reviewer and
     * fixer threads carry no ledger entry of their own). The host's complete
     * parent links, hidden threads included, mean a row missing from the
     * client's own list cannot leak a descendant. Aborting `signal` stops it.
     */
    async withDescendants(seeds: readonly string[], signal: AbortSignal): Promise<string[]> {
      // Archived first: a thread restored between the two reads is in both,
      // and one archived meanwhile records its link through its event.
      const startedAt = Date.now();
      if (startedAt - archivedReadAt >= ARCHIVED_LINKS_MS) {
        await read(true, signal);
        archivedReadAt = startedAt;
        gone = new Set();
      }
      await readParents(await read(false, signal), signal);
      const children = new Map<string, string[]>();
      for (const [id, parentId] of links) {
        if (!parentId) continue;
        const siblings = children.get(parentId);
        if (siblings) siblings.push(id);
        else children.set(parentId, [id]);
      }
      const seen = new Set(seeds);
      const queue = [...seen];
      for (const id of queue)
        for (const child of children.get(id) ?? [])
          if (!seen.has(child)) {
            seen.add(child);
            queue.push(child);
          }
      return [...seen];
    },
  };
}

/**
 * The threads hidden from the Threads view: the ids the server named plus
 * every descendant of one found through the live parent links, which covers a
 * thread that appeared after the server's last snapshot. A named parent hides
 * its children even when its own row is missing from the list.
 */
export function hiddenInitiativeThreads(
  threads: readonly PluginSidebarThread[],
  initiativeIds: ReadonlySet<string>,
): Set<string> {
  if (!initiativeIds.size) return new Set();
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const memo = new Map<string, boolean>();
  const hidden = (id: string): boolean => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    memo.set(id, false); // Cycle guard.
    const parentId = byId.get(id)?.parentThreadId;
    const result = initiativeIds.has(id) || (!!parentId && hidden(parentId));
    memo.set(id, result);
    return result;
  };
  return new Set(threads.filter((thread) => hidden(thread.id)).map((t) => t.id));
}
