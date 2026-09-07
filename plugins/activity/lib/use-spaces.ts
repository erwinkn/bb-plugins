import { useCallback, useEffect, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import {
  catalogSchema,
  type Space,
  type SpaceCatalog,
  type spaceContract,
} from "./space-contract";
import { EMPTY_CATALOG } from "./spaces";

// The last catalog this client saw. It renders immediately on the next load
// and keeps a selected space usable while the server is unreachable.
const CACHE_KEY = "bb-plugin-erwin-activity:spaces-cache";

export function readSpacesCache(): SpaceCatalog | null {
  try {
    const parsed = catalogSchema.safeParse(
      JSON.parse(window.localStorage.getItem(CACHE_KEY) ?? "null"),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
function writeSpacesCache(catalog: SpaceCatalog) {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(catalog));
  } catch {
    /* Memory-only mode. */
  }
}

export interface SpacesState {
  catalog: SpaceCatalog;
  /** `loading` and `error` only apply while no catalog is known at all. */
  status: "loading" | "ready" | "error";
  /** The last load or save failure; a stale cached catalog can still render. */
  error: string | null;
  save: (spaces: Space[]) => Promise<SpaceCatalog>;
  refresh: () => void;
}

export function useSpaces(): SpacesState {
  const rpc = useRpc<typeof spaceContract>();
  const connection = useRealtimeConnectionState();
  const [catalog, setCatalog] = useState<SpaceCatalog | null>(readSpacesCache);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const refresh = useCallback(() => setAttempt((value) => value + 1), []);
  const apply = useCallback((next: SpaceCatalog) => {
    setCatalog(next);
    setError(null);
    writeSpacesCache(next);
  }, []);
  useRealtime("spaces-changed", (payload) => {
    const parsed = catalogSchema.safeParse(payload);
    if (parsed.success) apply(parsed.data);
  });
  // Signals are not replayed, so reconcile on every (re)connection.
  useEffect(() => {
    let cancelled = false;
    rpc
      .call("getSpaces", null)
      .then((next) => {
        if (!cancelled) apply(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setError(
            cause instanceof Error ? cause.message : "Cannot load spaces.",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, connection, attempt, apply]);
  const revision = catalog?.revision ?? 0;
  const save = useCallback(
    async (spaces: Space[]) => {
      try {
        const next = await rpc.call("saveSpaces", {
          expectedRevision: revision,
          spaces,
        });
        apply(next);
        return next;
      } catch (cause) {
        // A conflict means another client saved first; pick up its version.
        // Other failures are cheap to reconcile the same way.
        refresh();
        throw cause;
      }
    },
    [rpc, revision, apply, refresh],
  );
  return {
    catalog: catalog ?? EMPTY_CATALOG,
    status: catalog ? "ready" : error ? "error" : "loading",
    error,
    save,
    refresh,
  };
}
