import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc, type PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { archiveContract } from "./archive-contract";
import { archivesQuery, queryKeys } from "./queries";

const NONE: PluginSidebarThread[] = [];

/** The archived threads while `enabled` (the Archived list shows); none otherwise. */
export function useArchives(enabled: boolean) {
  const rpc = useRpc<typeof archiveContract>();
  const client = useQueryClient();
  const query = useQuery({ ...archivesQuery(rpc), enabled });
  // Closing the list stops its paging once no open list still wants it; the
  // last complete list stays cached.
  useEffect(() => {
    if (!enabled && !client.getQueryCache().find({ queryKey: queryKeys.archives })?.isActive())
      void client.cancelQueries({ queryKey: queryKeys.archives });
  }, [client, enabled]);
  return {
    threads: enabled ? (query.data ?? NONE) : NONE,
    error: enabled && query.error ? query.error.message || "Cannot load archived threads." : null,
    refresh: () => void query.refetch(),
  };
}
