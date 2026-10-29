import { useEffect, useRef } from "react";
import { queryOptions, useQueryClient } from "@tanstack/react-query";
import { useRealtime, useRealtimeConnectionState, type PluginRpcClient } from "@get-bb/plugin-sdk/app";
import type { projectsContract } from "./contract";
import { withReadTimeout } from "./read-timeout";
import { refresh } from "./query";

/** Every query read through the plugin's QueryClient: its key and how it reads. */
export const SAFETY_POLL_MS = 60_000;

export const queryKeys = {
  prWatch: (projectId: string, url: string) => ["pr-watch", projectId, url] as const,
  prWatches: ["pr-watch"] as const,
};

type Api = PluginRpcClient<typeof projectsContract>;

/** W548: one PR's watch (who watches it, its latest wakes). */
export const prWatchQuery = (api: Api, projectId: string, url: string) =>
  queryOptions({
    queryKey: queryKeys.prWatch(projectId, url),
    queryFn: () => withReadTimeout(api.call("prWatch", { projectId, url })),
    refetchInterval: () => (document.visibilityState === "visible" ? SAFETY_POLL_MS : false),
  });

/**
 * Routes realtime signals to the keys they concern: a wake or a watch change is announced on
 * merge-queue-changed. Everything is read again on reconnect, when signals may have been missed.
 */
export function useQuerySync() {
  const client = useQueryClient();
  useRealtime("merge-queue-changed", () => refresh(client, queryKeys.prWatches));
  const connection = useRealtimeConnectionState();
  const was = useRef(connection);
  useEffect(() => {
    if (was.current !== "connected" && connection === "connected") refresh(client, queryKeys.prWatches);
    was.current = connection;
  }, [client, connection]);
}
