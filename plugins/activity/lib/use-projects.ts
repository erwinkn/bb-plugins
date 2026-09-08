import { useCallback, useEffect, useState } from "react";
import { useRpc, type PluginRpcClient } from "@get-bb/plugin-sdk/app";
import type { projectContract } from "./project-contract";
import type { ProjectInventory } from "./project-schema";

export interface ProjectsState {
  inventory: ProjectInventory | null;
  error: string | null;
  rpc: PluginRpcClient<typeof projectContract>;
  /** Re-fetch folders and hosts; the sidebar list itself is BB's. */
  refresh: () => void;
  /** Adopt an inventory a mutation returned instead of re-fetching. */
  apply: (inventory: ProjectInventory) => void;
}

// Folders and hosts are not in the sidebar data, so the Spaces page fetches
// them. `signature` changes whenever BB's own project list does, which keeps
// the inventory current after edits from any client.
export function useProjects(signature: string): ProjectsState {
  const rpc = useRpc<typeof projectContract>();
  const [inventory, setInventory] = useState<ProjectInventory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const refresh = useCallback(() => setAttempt((value) => value + 1), []);
  useEffect(() => {
    let cancelled = false;
    rpc
      .call("listProjects", null)
      .then((result) => {
        if (cancelled) return;
        setInventory(result);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, signature, attempt]);
  return { inventory, error, rpc, refresh, apply: setInventory };
}
