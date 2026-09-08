import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { spaceContract } from "./space-contract";
import { catalogSchema, type Space, type SpaceCatalog } from "./space-schema";
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
  /** False until the server (not just the local cache) has answered. */
  synced: boolean;
  /** The last load or save failure; a stale cached catalog can still render. */
  error: string | null;
  /**
   * Save an edit of the latest known catalog. Saves run one after another,
   * so an edit started while another is in flight builds on its result.
   */
  save: (change: (spaces: Space[]) => Space[]) => Promise<SpaceCatalog>;
  refresh: () => void;
}

export function useSpaces(): SpacesState {
  const rpc = useRpc<typeof spaceContract>();
  const connection = useRealtimeConnectionState();
  const [catalog, setCatalog] = useState<SpaceCatalog | null>(readSpacesCache);
  const [synced, setSynced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const refresh = useCallback(() => setAttempt((value) => value + 1), []);
  // Saves read the latest catalog from here, not from the render they
  // started in, so back-to-back edits carry the right revision.
  const latest = useRef(catalog);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  // The server's revision only grows within a session. A `getSpaces` answer
  // that was in flight while a save or signal landed a newer catalog is
  // stale and must not roll the UI, the cache, or the next save back.
  const serverRevision = useRef<number | null>(null);
  const apply = useCallback((next: SpaceCatalog) => {
    if (
      serverRevision.current !== null &&
      next.revision < serverRevision.current
    )
      return;
    serverRevision.current = next.revision;
    latest.current = next;
    setCatalog(next);
    setSynced(true);
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
  const save = useCallback(
    (change: (spaces: Space[]) => Space[]) => {
      const run = async () => {
        const current = latest.current ?? EMPTY_CATALOG;
        try {
          const next = await rpc.call("saveSpaces", {
            expectedRevision: current.revision,
            spaces: change(current.spaces),
          });
          apply(next);
          return next;
        } catch (cause) {
          // A conflict means another client saved first; pick up its version
          // before the next queued edit runs, so that one builds on it.
          // Other failures are cheap to reconcile the same way.
          try {
            apply(await rpc.call("getSpaces", null));
          } catch {
            refresh();
          }
          throw cause;
        }
      };
      const result = queue.current.then(run, run);
      queue.current = result.catch(() => undefined);
      return result;
    },
    [rpc, apply, refresh],
  );
  return {
    catalog: catalog ?? EMPTY_CATALOG,
    status: catalog ? "ready" : error ? "error" : "loading",
    synced,
    error,
    save,
    refresh,
  };
}
