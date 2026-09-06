import { useEffect, useState } from "react";
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
          workspaceDisplayKind: thread.environmentWorkspaceDisplayKind,
        }
      : null,
  };
}

export function useArchives(activeThreads: readonly PluginSidebarThread[]) {
  const rpc = useRpc<typeof archiveContract>();
  const connection = useRealtimeConnectionState();
  const [revision, setRevision] = useState(0);
  const [threads, setThreads] = useState<PluginSidebarThread[]>([]);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => setRevision((value) => value + 1);
  useRealtime("archives-changed", refresh);
  // Refresh after native restore/archive operations, including other clients.
  const membership = activeThreads
    .map((thread) => `${thread.id}:${thread.isArchived}`)
    .sort()
    .join(",");
  useEffect(() => {
    let cancelled = false;
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
    return () => {
      cancelled = true;
    };
  }, [rpc, connection, revision, membership]);
  return { threads, error, refresh };
}
