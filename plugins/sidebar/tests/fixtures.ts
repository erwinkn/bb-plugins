import { CACHE_VERSION, STORAGE_KEY } from "../lib/query";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

// dnd-kit mounts a visually-hidden aria-live="assertive" role="status" region
// for drag announcements; the sidebar's own status elements never set
// aria-live, so this picks the user-visible message.
export function visibleStatus(slot: {
  getAllByRole(role: string): HTMLElement[];
}): HTMLElement | undefined {
  return slot
    .getAllByRole("status")
    .find((element) => !element.hasAttribute("aria-live"));
}

export function thread(
  overrides: Partial<PluginSidebarThread> = {},
): PluginSidebarThread {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Test thread",
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    createdAt: 100,
    updatedAt: 100,
    lastReadAt: 100,
    // A turn finishing stamps both; a fixture's `updatedAt` is its activity.
    latestAttentionAt: overrides.updatedAt ?? 100,
    ...overrides,
  };
}

/**
 * Stores query data as a page would have persisted it, for the next mount to
 * restore: each entry is a query key and its data, read `ageMs` ago.
 */
export function seedQueryCache(entries: [readonly unknown[], unknown][], ageMs = 60_000) {
  const at = Date.now() - ageMs;
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      buster: CACHE_VERSION,
      timestamp: Date.now(),
      clientState: {
        mutations: [],
        queries: entries.map(([queryKey, data]) => ({
          queryKey,
          queryHash: JSON.stringify(queryKey),
          state: {
            data,
            dataUpdateCount: 1,
            dataUpdatedAt: at,
            error: null,
            errorUpdateCount: 0,
            errorUpdatedAt: 0,
            fetchFailureCount: 0,
            fetchFailureReason: null,
            fetchMeta: null,
            isInvalidated: false,
            status: "success",
            fetchStatus: "idle",
          },
        })),
      },
    }),
  );
}

/** The persisted query entries, by root key; empty without a stored cache. */
export function persistedQueries(): Record<string, unknown[]> {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  const out: Record<string, unknown[]> = {};
  if (!raw) return out;
  for (const query of JSON.parse(raw).clientState.queries as { queryKey: string[]; state: { data: unknown } }[])
    (out[query.queryKey[0]!] ??= []).push(query.state.data);
  return out;
}

/** A known Initiative thread set (empty by default), so the list renders at first paint. */
export function seedInitiativeCache(ids: string[] = []) {
  seedQueryCache([[["initiative-threads"], ids]]);
}

export type ThreadLink = { id: string; parent: string | null; archived?: boolean };
/** A host thread store: `threads.list` filters the links by parent and archive flag, when given. */
export const threadsList =
  (links: ThreadLink[]) =>
  async (
    q: { parentThreadId?: string; archived?: boolean; limit?: number; offset?: number } = {},
  ) =>
    links
      .filter(
        (link) =>
          (q.parentThreadId === undefined || link.parent === q.parentThreadId) &&
          (q.archived === undefined || !!link.archived === q.archived),
      )
      .slice(q.offset ?? 0, (q.offset ?? 0) + (q.limit ?? 200))
      .map((link) => ({ id: link.id, parentThreadId: link.parent }));
/** The same store's `threads.get`: a thread it does not hold is a 404, as BB's is. */
export const threadsGet =
  (links: ThreadLink[]) =>
  async ({ threadId }: { threadId: string }) => {
    const link = links.find((l) => l.id === threadId);
    if (!link) throw Object.assign(new Error(`Thread ${threadId} not found`), { status: 404 });
    return { id: link.id, parentThreadId: link.parent };
  };
