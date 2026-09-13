import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { snoozeContract } from "./snooze-contract";
import {
  EMPTY_SNOOZE_PRESETS,
  SNOOZE_PRESETS_CHANNEL,
  snoozePresetsDocSchema,
  type SnoozePresetsDoc,
} from "./snooze-presets";
import {
  EMPTY_SNOOZES,
  SNOOZE_CHANNEL,
  snoozeDocSchema,
  type SnoozeDoc,
} from "./snooze-schema";

export interface SyncedDocState<Doc> {
  doc: Doc;
  /** `loading` and `error` only apply while no document is known at all. */
  status: "loading" | "ready" | "error";
  error: string | null;
  refresh: () => void;
}

interface SyncedDocSource<Doc extends { revision: number }> {
  method: "getSnoozes" | "getSnoozePresets";
  channel: string;
  /** Last document this client saw, applied before the server answers. */
  cacheKey: string;
  parse: (value: unknown) => Doc | null;
  empty: Doc;
}

function readCache<Doc>(source: SyncedDocSource<Doc & { revision: number }>) {
  try {
    return source.parse(
      JSON.parse(window.localStorage.getItem(source.cacheKey) ?? "null"),
    );
  } catch {
    return null;
  }
}
function writeCache(key: string, doc: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(doc));
  } catch {
    /* Memory-only mode. */
  }
}

// One revisioned KV document served over RPC and pushed over realtime, the
// same shape as the library hook. Callers pass a module-level source so the
// effect dependencies stay stable.
function useSyncedDoc<Doc extends { revision: number }>(
  source: SyncedDocSource<Doc>,
): SyncedDocState<Doc> {
  const rpc = useRpc<typeof snoozeContract>();
  const connection = useRealtimeConnectionState();
  const [doc, setDoc] = useState<Doc | null>(() => readCache(source));
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const refresh = useCallback(() => setAttempt((value) => value + 1), []);
  // The server's revision only grows within a session. A fetch answer that
  // was in flight while a signal landed a newer document is stale and must
  // not roll the UI or the cache back.
  const serverRevision = useRef<number | null>(null);
  const apply = useCallback(
    (next: Doc) => {
      if (
        serverRevision.current !== null &&
        next.revision < serverRevision.current
      )
        return;
      serverRevision.current = next.revision;
      setDoc(next);
      setError(null);
      writeCache(source.cacheKey, next);
    },
    [source],
  );
  useRealtime(source.channel, (payload) => {
    const parsed = source.parse(payload);
    if (parsed) apply(parsed);
  });
  // Signals are not replayed, so reconcile on every (re)connection.
  useEffect(() => {
    let cancelled = false;
    rpc
      .call(source.method, null)
      .then((next) => {
        const parsed = source.parse(next);
        if (!cancelled && parsed) apply(parsed);
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : "Cannot load.");
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, connection, attempt, apply, source]);
  return {
    doc: doc ?? source.empty,
    status: doc ? "ready" : error ? "error" : "loading",
    error,
    refresh,
  };
}

const SNOOZES: SyncedDocSource<SnoozeDoc> = {
  method: "getSnoozes",
  channel: SNOOZE_CHANNEL,
  cacheKey: "bb-plugin-sidebar:snooze-cache",
  parse: (value) => {
    const parsed = snoozeDocSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  },
  empty: EMPTY_SNOOZES,
};
const PRESETS: SyncedDocSource<SnoozePresetsDoc> = {
  method: "getSnoozePresets",
  channel: SNOOZE_PRESETS_CHANNEL,
  cacheKey: "bb-plugin-sidebar:snooze-presets-cache",
  parse: (value) => {
    const parsed = snoozePresetsDocSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  },
  empty: EMPTY_SNOOZE_PRESETS,
};

export function useSnooze(): SyncedDocState<SnoozeDoc> {
  return useSyncedDoc(SNOOZES);
}
export function useSnoozePresets(): SyncedDocState<SnoozePresetsDoc> {
  return useSyncedDoc(PRESETS);
}
