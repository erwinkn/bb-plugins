import { QueryClient, hashKey, hydrate, type DehydratedState, type QueryKey } from "@tanstack/react-query";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { persistQueryClientSubscribe } from "@tanstack/react-query-persist-client";

/**
 * The plugin's one QueryClient (the Sidebar's pattern, AGENTS.md "Data
 * fetching"). Queries whose root key is listed in `PERSISTED`
 * (lib/queries.tsx) are saved to localStorage and restored synchronously on
 * first use, so the settings page draws at once and refreshes behind.
 */

/** Bump when a persisted query's data changes shape: an older cache is dropped whole. */
export const CACHE_VERSION = "1";
export const STORAGE_KEY = "bb-plugin-mcp-servers:query-cache";
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** Change signals for one key within this window refetch it once. */
export const SIGNAL_DEBOUNCE_MS = 200;

export type PersistedSchemas = Record<string, { safeParse(value: unknown): { success: boolean } }>;

export function createQueryClient(persisted: PersistedSchemas): { queryClient: QueryClient; dispose: () => void } {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 24 * 60 * 60_000,
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
    setItem: (key: string, value: string) => {
      if (live) window.localStorage.setItem(key, value);
    },
    removeItem: (key: string) => window.localStorage.removeItem(key),
  };
  const persister = createSyncStoragePersister({ storage, key: STORAGE_KEY });
  const persistedRoot = (key: QueryKey) => typeof key[0] === "string" && Object.hasOwn(persisted, key[0]);
  try {
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
          .map((query) => ({
            ...query,
            state: { ...query.state, status: "success" as const, error: null, fetchStatus: "idle" as const },
          })),
      });
    // Restored data draws at once but is always read again.
    void queryClient.invalidateQueries({ refetchType: "none" });
  } catch {
    // Unreadable or memory-only storage: start empty.
  }
  const unsubscribe = persistQueryClientSubscribe({
    queryClient,
    persister,
    buster: CACHE_VERSION,
    dehydrateOptions: {
      shouldDehydrateQuery: (query) => query.state.data !== undefined && persistedRoot(query.queryKey),
      shouldDehydrateMutation: () => false,
    },
  });
  return {
    queryClient,
    dispose: () => {
      live = false;
      unsubscribe();
    },
  };
}

let current: ReturnType<typeof createQueryClient> | null = null;

export function pluginQueryClient(persisted: PersistedSchemas): QueryClient {
  current ??= createQueryClient(persisted);
  return current.queryClient;
}

/** Tests only: drop the client as a reload would. */
export function resetQueryClient() {
  current?.dispose();
  current?.queryClient.clear();
  current = null;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
/**
 * A change signal for the queries under `queryKey`: marks them stale and
 * refetches the ones on screen, coalescing a burst. A read in flight
 * finishes and one more follows it, instead of being cancelled.
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
            .then(() => queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true }, options));
      }
      void queryClient.invalidateQueries({ queryKey }, options);
    }, SIGNAL_DEBOUNCE_MS),
  );
}
