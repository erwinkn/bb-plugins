import {
  QueryClient,
  hashKey,
  hydrate,
  type DehydratedState,
  type QueryKey,
} from "@tanstack/react-query";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { persistQueryClientSubscribe } from "@tanstack/react-query-persist-client";

/**
 * The sidebar's one QueryClient: every mounted slot shares its cache, so two
 * views of the same data read it once. Queries whose root key is listed in
 * `PERSISTED` (lib/queries.ts) are saved to localStorage and restored
 * synchronously when the client is first used, so a cold open draws from
 * them at once and refreshes in the background.
 */

/** Bump when a persisted query's data changes shape: an older cache is dropped whole. */
export const CACHE_VERSION = "1";
export const STORAGE_KEY = "bb-plugin-sidebar:query-cache";
/** A cache older than this is dropped instead of drawn. */
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** Entries of the hand-rolled caches this one replaced; deleted on first use. */
const RETIRED_KEYS = [
  "bb-plugin-sidebar:initiative-tree:v1",
  "bb-plugin-sidebar:adventure-workers:v1",
  "bb-plugin-sidebar:initiative-threads-cache",
  "bb-plugin-sidebar:snooze-cache",
  "bb-plugin-sidebar:snooze-presets-cache",
];
/** Change signals for one key within this window refetch it once. */
export const SIGNAL_DEBOUNCE_MS = 200;

/** What restored data must pass, by root query key: anything else is dropped. */
export type PersistedSchemas = Record<
  string,
  { safeParse(value: unknown): { success: boolean } }
>;

/**
 * A QueryClient restored from storage and saving to it. `dispose` stops the
 * saving, including a write still throttled.
 */
export function createQueryClient(persisted: PersistedSchemas): {
  queryClient: QueryClient;
  dispose: () => void;
} {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // Realtime signals mark data stale; this only spares a remount or a
        // tab coming back a read of something fetched moments ago.
        staleTime: 30_000,
        gcTime: 24 * 60 * 60_000,
        // One quiet retry, at once: a single miss is usually a tab or
        // device that slept. Errors show from the second miss in a row.
        retry: 1,
        retryDelay: 0,
        // Plugin RPCs reach the local BB server; the browser's online flag
        // says nothing about it.
        networkMode: "always",
      },
      mutations: { networkMode: "always" },
    },
  });
  let live = true;
  const storage = {
    getItem: (key: string) => window.localStorage.getItem(key),
    // A write still throttled when the client is dropped must not land.
    setItem: (key: string, value: string) => {
      if (live) window.localStorage.setItem(key, value);
    },
    removeItem: (key: string) => window.localStorage.removeItem(key),
  };
  // The async persister would restore after the first render, drawing a
  // loading frame on every cold open; this one restores synchronously.
  const persister = createSyncStoragePersister({ storage, key: STORAGE_KEY });
  const persistedRoot = (key: QueryKey) =>
    typeof key[0] === "string" && Object.hasOwn(persisted, key[0]);
  try {
    for (const key of RETIRED_KEYS) window.localStorage.removeItem(key);
    const saved = persister.restoreClient() as
      | { buster: string; timestamp: number; clientState: DehydratedState }
      | undefined;
    if (saved?.buster === CACHE_VERSION && Date.now() - saved.timestamp < MAX_AGE_MS)
      hydrate(queryClient, {
        mutations: [],
        queries: saved.clientState.queries
          .filter(
            (query) =>
              persistedRoot(query.queryKey) &&
              query.state.data !== undefined &&
              persisted[query.queryKey[0] as string]!.safeParse(query.state.data).success,
          )
          // Last-good data saved while a later read was failing.
          .map((query) => ({
            ...query,
            state: { ...query.state, status: "success" as const, error: null, fetchStatus: "idle" as const },
          })),
      });
    // Restored data draws at once but is always read again: signals sent
    // while the page was away were missed.
    void queryClient.invalidateQueries({ refetchType: "none" });
  } catch {
    // Unreadable or memory-only storage: start empty.
  }
  const unsubscribe = persistQueryClientSubscribe({
    queryClient,
    persister,
    buster: CACHE_VERSION,
    dehydrateOptions: {
      // A failed read keeps its last-good data, so a cold open while the
      // server struggles still draws it.
      shouldDehydrateQuery: (query) =>
        query.state.data !== undefined && persistedRoot(query.queryKey),
      shouldDehydrateMutation: () => false,
    },
  });
  const dispose = () => {
    live = false;
    unsubscribe();
  };
  return { queryClient, dispose };
}

let current: (ReturnType<typeof createQueryClient> & { createdAt: number }) | null = null;

export function sidebarQueryClient(persisted: PersistedSchemas): QueryClient {
  current ??= { ...createQueryClient(persisted), createdAt: Date.now() };
  return current.queryClient;
}

/**
 * Whether data was fetched or set since this page loaded, not restored from
 * storage. A revision restored from storage must never outrank the server's.
 */
export function isLive(dataUpdatedAt: number): boolean {
  return current !== null && dataUpdatedAt >= current.createdAt;
}

/** Tests only: drop the client as a reload would; the next use restores from storage. */
export function resetQueryClient() {
  current?.dispose();
  current?.queryClient.clear();
  current = null;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
/**
 * A change signal for the queries under `queryKey`: marks them stale and
 * refetches the ones on screen. Signals within SIGNAL_DEBOUNCE_MS coalesce.
 * A read already in flight may predate the change, so it finishes and one
 * more read follows it; cancelling it instead would restart the read on every
 * signal, and a steady stream of signals would starve it.
 */
export function refresh(queryClient: QueryClient, queryKey: QueryKey) {
  const hash = hashKey(queryKey);
  clearTimeout(timers.get(hash));
  timers.set(
    hash,
    setTimeout(() => {
      timers.delete(hash);
      const options = { cancelRefetch: false };
      for (const query of queryClient.getQueryCache().findAll({ queryKey })) {
        const inFlight = query.promise;
        if (inFlight && query.state.fetchStatus === "fetching")
          void inFlight
            .catch(() => {})
            .then(() =>
              queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true }, options),
            );
      }
      void queryClient.invalidateQueries({ queryKey }, options);
    }, SIGNAL_DEBOUNCE_MS),
  );
}
