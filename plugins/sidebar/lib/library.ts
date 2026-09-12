import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

// A thread counts as saved when it is a member or any ancestor is: children
// created after a save stay with their family instead of leaking into the
// active view. Missing or archived ancestors end the walk.
export function savedThreadIds(
  threads: readonly PluginSidebarThread[],
  memberIds: ReadonlySet<string>,
): Set<string> {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const memo = new Map<string, boolean>();
  const visit = (thread: PluginSidebarThread): boolean => {
    const cached = memo.get(thread.id);
    if (cached !== undefined) return cached;
    memo.set(thread.id, false); // Cycle guard.
    const parent = thread.parentThreadId
      ? byId.get(thread.parentThreadId)
      : undefined;
    const saved = memberIds.has(thread.id) || (parent ? visit(parent) : false);
    memo.set(thread.id, saved);
    return saved;
  };
  const saved = new Set<string>();
  for (const thread of threads) if (visit(thread)) saved.add(thread.id);
  return saved;
}
