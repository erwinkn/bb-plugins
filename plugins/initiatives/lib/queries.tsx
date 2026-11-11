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
  /** W584: everything of one Adventure's drive; a drive-changed signal refreshes it whole. */
  drive: (projectId: string) => ["drive", projectId] as const,
  driveList: (projectId: string) => ["drive", projectId, "list"] as const,
  driveFile: (projectId: string, path: string) => ["drive", projectId, "file", path] as const,
};

type Api = PluginRpcClient<typeof projectsContract>;

/** W548: one PR's watch (who watches it, its latest wakes). */
export const prWatchQuery = (api: Api, projectId: string, url: string) =>
  queryOptions({
    queryKey: queryKeys.prWatch(projectId, url),
    queryFn: () => withReadTimeout(api.call("prWatch", { projectId, url })),
    refetchInterval: visiblePoll,
  });

const visiblePoll = () => (document.visibilityState === "visible" ? SAFETY_POLL_MS : false);

/** W584: the drive's entries; the server walks the folder on each read (a local readdir, no cache needed). */
export const driveListQuery = (api: Api, projectId: string) =>
  queryOptions({
    queryKey: queryKeys.driveList(projectId),
    queryFn: () => withReadTimeout(api.call("driveList", { projectId })),
    refetchInterval: visiblePoll,
  });

export const driveFileQuery = (api: Api, projectId: string, path: string) =>
  queryOptions({
    queryKey: queryKeys.driveFile(projectId, path),
    queryFn: () => withReadTimeout(api.call("driveRead", { projectId, path })),
    refetchInterval: visiblePoll,
  });

/** W584: the server's drive watcher announces each changed drive (coalesced) on drive-changed; reconnects read it again. */
export function useDriveSync(projectId: string) {
  const client = useQueryClient();
  useRealtime("drive-changed", (payload) => {
    if ((payload as { projectId?: unknown } | null)?.projectId === projectId) refresh(client, queryKeys.drive(projectId));
  });
  useReconnect(() => refresh(client, queryKeys.drive(projectId)));
}

function useReconnect(run: () => void) {
  const connection = useRealtimeConnectionState();
  const was = useRef(connection);
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => {
    if (was.current !== "connected" && connection === "connected") latest.current();
    was.current = connection;
  }, [connection]);
}

/**
 * Routes realtime signals to the keys they concern: a wake or a watch change is announced on
 * merge-queue-changed. Everything is read again on reconnect, when signals may have been missed.
 */
export function useQuerySync() {
  const client = useQueryClient();
  useRealtime("merge-queue-changed", () => refresh(client, queryKeys.prWatches));
  useReconnect(() => refresh(client, queryKeys.prWatches));
}
