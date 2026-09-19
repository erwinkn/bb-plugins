import { useEffect, useRef, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import type { archiveContract, ArchivedThread } from "./archive-contract";

function sidebarThread(thread: ArchivedThread): PluginSidebarThread {
  return {
    ...thread,
    sectionId: null,
    originKind: null,
    originPluginId: null,
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
    isArchived: true,
    host: null,
    lastReadAt: null,
    latestAttentionAt: thread.updatedAt,
    environment: thread.environmentId
      ? {
          id: thread.environmentId,
          name: thread.environmentName,
          branchName: thread.environmentBranchName,
          providerId: thread.environmentProviderId,
          workspaceDisplayKind: thread.environmentWorkspaceDisplayKind,
        }
      : null,
  };
}

// Archiving, restoring, or deleting a thread each publishes a signal; a
// burst restarts this timer so N signals become one pagination.
const REFETCH_DEBOUNCE_MS = 250;

export function useArchives(enabled: boolean) {
  const rpc = useRpc<typeof archiveContract>();
  const connection = useRealtimeConnectionState();
  const [revision, setRevision] = useState(0);
  const [threads, setThreads] = useState<PluginSidebarThread[]>([]);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => setRevision((value) => value + 1);
  // A hidden list skips the signal; it reloads when it opens anyway.
  useRealtime("archives-changed", () => {
    if (enabled) refresh();
  });
  // The first load is prompt; every later trigger restarts the debounce so
  // the burst becomes one reload with the latest state.
  const loaded = useRef(false);
  useEffect(() => {
    let cancelled = false;
    if (!enabled) {
      setThreads((current) => (current.length ? [] : current));
      setError(null);
      return;
    }
    const timer = setTimeout(
      () => {
        async function load() {
          const result: PluginSidebarThread[] = [];
          for (let offset = 0; ; offset += 200) {
            const page = await rpc.call("listArchived", { offset });
            if (cancelled) return;
            result.push(...page.map(sidebarThread));
            if (page.length < 200) break;
          }
          setThreads([
            ...new Map(result.map((thread) => [thread.id, thread])).values(),
          ]);
          setError(null);
        }
        void load().catch((cause: unknown) => {
          if (!cancelled)
            setError(
              cause instanceof Error
                ? cause.message
                : "Cannot load archived threads.",
            );
        });
      },
      loaded.current ? REFETCH_DEBOUNCE_MS : 0,
    );
    loaded.current = true;
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [rpc, connection, revision, enabled]);
  return { threads, error, refresh };
}
