import { QueryClient, hashKey, type QueryKey } from "@tanstack/react-query";

/**
 * The plugin's one QueryClient (AGENTS.md, Data fetching). Only the PR watch control reads through
 * it so far (W548); nothing is persisted, since none of its reads is worth drawing on a cold open.
 */
let client: QueryClient | null = null;

export function adventuresQueryClient(): QueryClient {
  client ??= new QueryClient({
    defaultOptions: {
      queries: {
        // Realtime signals mark data stale; this only spares a remount a read of something just fetched.
        staleTime: 30_000,
        // One quiet retry, at once: a single miss is usually a tab or device that slept.
        retry: 1,
        retryDelay: 0,
        // Plugin RPCs reach the local BB server; the browser's online flag says nothing about it.
        networkMode: "always",
      },
      mutations: { networkMode: "always" },
    },
  });
  return client;
}

/** Change signals for one key within this window refetch it once. */
export const SIGNAL_DEBOUNCE_MS = 200;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * A change signal for the queries under `queryKey`: marks them stale and refetches those on
 * screen. Signals within SIGNAL_DEBOUNCE_MS coalesce, and a read in flight finishes before one
 * more follows it (cancelling it would starve it under a stream of signals).
 */
export function refresh(queryClient: QueryClient, queryKey: QueryKey) {
  const hash = hashKey(queryKey);
  clearTimeout(timers.get(hash));
  timers.set(hash, setTimeout(() => {
    timers.delete(hash);
    const options = { cancelRefetch: false };
    for (const query of queryClient.getQueryCache().findAll({ queryKey })) {
      const inFlight = query.promise;
      if (inFlight && query.state.fetchStatus === "fetching")
        void inFlight.catch(() => {}).then(() => queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true }, options));
    }
    void queryClient.invalidateQueries({ queryKey }, options);
  }, SIGNAL_DEBOUNCE_MS));
}
