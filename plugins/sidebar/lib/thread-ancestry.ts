import { useSyncExternalStore } from "react";

type Links = ReadonlyMap<string, string | null>;
type Read = (threadId: string) => Promise<{ links: { id: string; parentThreadId: string | null }[] }>;

/**
 * Parent links read from the host for threads BB's sidebar list omits (an
 * archived reviewer between a worker and a live helper), kept for the session
 * since they seldom change. Every mounted sidebar sees an answer whenever it
 * lands, including one asked for before it mounted.
 */
let links: Links = new Map();
const pending = new Set<string>();
const listeners = new Set<() => void>();

export function useHostLinks(): Links {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => links,
    () => links,
  );
}

/**
 * Reads the chain above `threadId` in the background unless it is known or
 * already being read. A failed read is forgotten, so the next ask retries.
 */
export function askAncestry(threadId: string, read: Read) {
  if (links.has(threadId) || pending.has(threadId)) return;
  pending.add(threadId);
  read(threadId)
    .then(({ links: found }) => {
      const next = new Map(links);
      for (const link of found) next.set(link.id, link.parentThreadId);
      links = next;
      listeners.forEach((listener) => listener());
    }, () => {})
    .finally(() => pending.delete(threadId));
}
