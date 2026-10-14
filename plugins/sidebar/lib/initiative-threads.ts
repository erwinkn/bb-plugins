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
const CONCURRENCY = 8;

// One page of a parent's children, active and archived in one read so a
// thread restored mid-walk cannot fall between two reads. Rejects at once on
// abort, even if the host ignores the signal, so a stuck call cannot hold the
// walk.
const childPage = (
  bb: BbPluginApi,
  signal: AbortSignal,
  parentThreadId: string,
  offset: number,
) =>
  new Promise<{ id: string }[]>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    bb.sdk.threads
      .list({ parentThreadId, includeHidden: true, limit: PAGE, offset, signal })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", stop));
  });

/**
 * The seeds plus every descendant of one, archived or not (reviewer and fixer
 * threads carry no ledger entry of their own). The host reads the complete
 * parent links, so a missing intermediate row in the client's bounded list
 * cannot leak a descendant. Aborting `signal`, or one failed read, stops every
 * reader; the walk settles only after they have all stopped.
 */
export async function withDescendants(
  bb: BbPluginApi,
  seeds: readonly string[],
  signal: AbortSignal,
): Promise<string[]> {
  const seen = new Set(seeds);
  const failure = new AbortController();
  const stop = AbortSignal.any([signal, failure.signal]);
  const errors: unknown[] = []; // The first is the failure; the rest are its aborts.
  const childrenOf = async (parentThreadId: string) => {
    const found: string[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await childPage(bb, stop, parentThreadId, offset);
      for (const child of page) found.push(child.id);
      if (page.length < PAGE) return found;
    }
  };
  let level = [...seen];
  while (level.length) {
    const next: string[] = [];
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, level.length) }, async () => {
        try {
          while (cursor < level.length && !stop.aborted)
            for (const id of await childrenOf(level[cursor++]!))
              if (!seen.has(id)) {
                seen.add(id);
                next.push(id);
              }
        } catch (cause) {
          errors.push(cause);
          failure.abort();
        }
      }),
    );
    if (errors.length) throw errors[0];
    signal.throwIfAborted();
    level = next;
  }
  return [...seen];
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
