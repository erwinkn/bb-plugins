import { useEffect, useRef, type ComponentType } from "react";
import {
  QueryClientProvider,
  queryOptions,
  replaceEqualDeep,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useRealtime, useRealtimeConnectionState, type PluginRpcClient } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { listResultSchema, SERVERS_CHANGED, type ListResult } from "../src/schemas";
import { pluginQueryClient, refresh } from "./query";

/**
 * Every query the settings page makes, its key, and how a change reaches
 * it: the server pushes the whole list on `servers-changed` (straight into
 * the cache), a reconnect reads it again, and a slow poll covers a signal
 * lost while the tab was away.
 */
export const SAFETY_POLL_MS = 60_000;
export const READ_TIMEOUT_MS = 15_000;

export const queryKeys = {
  servers: ["servers"] as const,
};

const PERSISTED = { [queryKeys.servers[0]]: listResultSchema };

export const queryClient = () => pluginQueryClient(PERSISTED);

export type Api = PluginRpcClient<typeof rpcContract>;

/** A read that has not answered by then fails, so a stuck RPC cannot hold later refreshes. */
export function withReadTimeout<T>(read: Promise<T>, ms = READ_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("The MCP servers plugin did not answer in time.")), ms);
  });
  return Promise.race([read, late]).finally(() => clearTimeout(timer));
}

/** The newer of two lists by revision: a slow read never rolls a pushed list back. */
function newer(old: ListResult | undefined, next: ListResult): ListResult {
  return old && old.revision > next.revision ? old : next;
}

export function applyList(client: QueryClient, list: ListResult) {
  client.setQueryData<ListResult>(queryKeys.servers, (old) => newer(old, list));
}

export const serversQuery = (api: Api) =>
  queryOptions({
    queryKey: queryKeys.servers,
    queryFn: () => withReadTimeout(api.call("list", null)),
    structuralSharing: (old, next) =>
      replaceEqualDeep(old, newer(old as ListResult | undefined, next as ListResult)) as ListResult,
    refetchInterval: () => (document.visibilityState === "visible" ? SAFETY_POLL_MS : false),
  });

/** Routes the realtime channel and reconnects to the query. */
function QuerySync() {
  const client = useQueryClient();
  useRealtime(SERVERS_CHANGED, (payload) => {
    const parsed = listResultSchema.safeParse(payload);
    if (parsed.success) applyList(client, parsed.data);
    else refresh(client, queryKeys.servers);
  });
  const connection = useRealtimeConnectionState();
  const wasConnected = useRef(connection === "connected");
  useEffect(() => {
    const connected = connection === "connected";
    if (connected && !wasConnected.current) refresh(client, queryKeys.servers);
    wasConnected.current = connected;
  }, [client, connection]);
  return null;
}

/** Wrap a slot component in the plugin's query client and realtime sync. */
export function withQueries<P extends object>(Component: ComponentType<P>): ComponentType<P> {
  function WithQueries(props: P) {
    return (
      <QueryClientProvider client={queryClient()}>
        <QuerySync />
        <Component {...props} />
      </QueryClientProvider>
    );
  }
  WithQueries.displayName = `WithQueries(${Component.displayName ?? Component.name})`;
  return WithQueries;
}
