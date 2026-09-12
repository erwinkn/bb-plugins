import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { libraryContract } from "./library-contract";
import {
  EMPTY_LIBRARY,
  LIBRARY_CHANNEL,
  libraryDocSchema,
  type LibraryDoc,
} from "./library-schema";

// The last document this client saw. It filters the active view immediately
// on the next load, before the server answers.
const CACHE_KEY = "bb-plugin-sidebar:library-cache";

function readLibraryCache(): LibraryDoc | null {
  try {
    const parsed = libraryDocSchema.safeParse(
      JSON.parse(window.localStorage.getItem(CACHE_KEY) ?? "null"),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
function writeLibraryCache(doc: LibraryDoc) {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(doc));
  } catch {
    /* Memory-only mode. */
  }
}

export interface LibraryState {
  doc: LibraryDoc;
  /** Direct member ids. Descendants of members are covered by `savedThreadIds`. */
  memberIds: Set<string>;
  /** `loading` and `error` only apply while no document is known at all. */
  status: "loading" | "ready" | "error";
  error: string | null;
  refresh: () => void;
}

export function useLibrary(): LibraryState {
  const rpc = useRpc<typeof libraryContract>();
  const connection = useRealtimeConnectionState();
  const [doc, setDoc] = useState<LibraryDoc | null>(readLibraryCache);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const refresh = useCallback(() => setAttempt((value) => value + 1), []);
  // The server's revision only grows within a session. A `getLibrary` answer
  // that was in flight while a signal landed a newer document is stale and
  // must not roll the UI or the cache back.
  const serverRevision = useRef<number | null>(null);
  const apply = useCallback((next: LibraryDoc) => {
    if (
      serverRevision.current !== null &&
      next.revision < serverRevision.current
    )
      return;
    serverRevision.current = next.revision;
    setDoc(next);
    setError(null);
    writeLibraryCache(next);
  }, []);
  useRealtime(LIBRARY_CHANNEL, (payload) => {
    const parsed = libraryDocSchema.safeParse(payload);
    if (parsed.success) apply(parsed.data);
  });
  // Signals are not replayed, so reconcile on every (re)connection.
  useEffect(() => {
    let cancelled = false;
    rpc
      .call("getLibrary", null)
      .then((next) => {
        if (!cancelled) apply(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setError(
            cause instanceof Error ? cause.message : "Cannot load the library.",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, connection, attempt, apply]);
  return {
    doc: doc ?? EMPTY_LIBRARY,
    memberIds: new Set((doc ?? EMPTY_LIBRARY).ids),
    status: doc ? "ready" : error ? "error" : "loading",
    error,
    refresh,
  };
}
