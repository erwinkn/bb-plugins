// Round selection for the Notebook panel, kept apart from the host tab
// identity. The host keys a panel tab by action id plus `params`, so opening
// with `{ roundId }` once and without params later creates two tabs. Every
// caller therefore opens the panel without params and, when it wants one
// round in view, records that wish here. The panel takes the wish once its
// rounds are loaded, whether it mounted for this open or was already open.
//
// One entry per thread: a split layout renders one panel per visible thread,
// so the map, not a single slot, is the plugin-local state.

const pending = new Map<string, string>();
const listeners = new Map<string, Set<() => void>>();

/** Ask the panel for `threadId` to show `roundId` next. */
export function requestRound(threadId: string, roundId: string): void {
  pending.set(threadId, roundId);
  for (const listener of listeners.get(threadId) ?? []) listener();
}

/** Return and forget the round requested for `threadId`, if any. */
export function takeRequestedRound(threadId: string): string | null {
  const roundId = pending.get(threadId) ?? null;
  pending.delete(threadId);
  return roundId;
}

/** Notified after every `requestRound` for `threadId`; returns the unsubscribe. */
export function subscribeRequestedRound(threadId: string, listener: () => void): () => void {
  let set = listeners.get(threadId);
  if (!set) {
    set = new Set();
    listeners.set(threadId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(threadId);
  };
}
