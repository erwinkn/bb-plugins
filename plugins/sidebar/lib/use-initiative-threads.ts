import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import {
  INITIATIVES_CHANGED,
  INITIATIVE_THREADS_CHANGED,
} from "./project-mode-names";
import { withReadTimeout } from "./read-timeout";
import type { projectModeContract } from "./project-mode-contract";

// The last answer this client saw. It hides Initiative threads on the next
// load before the server answers, so they never flash into the list.
const CACHE_KEY = "bb-plugin-sidebar:initiative-threads-cache";
const POLL_MS = 15_000;
const DEBOUNCE_MS = 200;
const EMPTY: ReadonlySet<string> = new Set();

// Null is a cache miss (unknown), distinct from a confirmed empty set.
function readCache(): ReadonlySet<string> | null {
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(CACHE_KEY) ?? "null",
    );
    return Array.isArray(parsed)
      ? new Set(parsed.filter((id): id is string => typeof id === "string"))
      : null;
  } catch {
    return null;
  }
}
function writeCache(ids: ReadonlySet<string>) {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify([...ids]));
  } catch {
    /* Memory-only mode. */
  }
}

/**
 * The ids of the threads Initiatives owns, kept fresh in the background.
 * Null means unknown: nothing cached and no answer yet, so the list waits
 * (the first answer, even a failed or timed-out read, ends the wait). With a
 * known set, a failed or slow read keeps it and its cache; only a confirmed
 * answer replaces it, an Initiatives plugin that is not running yielding an
 * empty set. A read is bounded by a deadline, so a stalled request cannot
 * block the refreshes after it.
 * `threadKey` changes when the host thread list gains or loses a thread: a
 * new worker thread is listed before the ledger records it, so the set is
 * read again.
 */
export function useInitiativeThreadIds(
  threadKey: string,
): ReadonlySet<string> | null {
  const rpc = useRpc<typeof projectModeContract>();
  const connection = useRealtimeConnectionState();
  const [ids, setIds] = useState(readCache);
  const idsRef = useRef(ids);
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const mounted = useRef(false);
  const pending = useRef(false);
  const again = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Without any known set, stop waiting on the placeholder (not cached).
  const settle = useCallback(() => {
    if (idsRef.current) return;
    idsRef.current = EMPTY;
    setIds(EMPTY);
  }, []);
  const refresh = useCallback(function read() {
    if (pending.current) {
      again.current = true;
      return;
    }
    pending.current = true;
    withReadTimeout(rpcRef.current.call("initiativeThreads", null))
      .then(
        (result) => {
          if (!mounted.current) return;
          // The server is still on its first read (its change signal
          // follows), or that read failed: neither is an answer, so the known
          // set and its cache stay; an unknown one ends the wait, uncached.
          if (result.status !== "ready") {
            if (result.status === "failed") settle();
            return;
          }
          const next = new Set(result.available ? result.threadIds : []);
          // Every confirmed answer is cached, even one equal to the set in
          // memory (which may itself have come from a failed read).
          writeCache(next);
          const current = idsRef.current;
          if (
            current &&
            current.size === next.size &&
            [...next].every((id) => current.has(id))
          )
            return;
          idsRef.current = next;
          setIds(next);
        },
        () => {
          if (mounted.current) settle();
        },
      )
      .finally(() => {
        pending.current = false;
        if (again.current && mounted.current) {
          again.current = false;
          read();
        }
      });
  }, [settle]);
  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (mounted.current) refresh();
    }, DEBOUNCE_MS);
  }, [refresh]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh, connection]);
  useEffect(() => {
    schedule();
  }, [schedule, threadKey]);
  useRealtime(INITIATIVES_CHANGED, schedule);
  useRealtime(INITIATIVE_THREADS_CHANGED, schedule);
  useEffect(() => {
    const poll = () => {
      if (document.visibilityState !== "hidden") schedule();
    };
    const interval = setInterval(poll, POLL_MS);
    document.addEventListener("visibilitychange", poll);
    window.addEventListener("online", schedule);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", poll);
      window.removeEventListener("online", schedule);
    };
  }, [schedule]);
  return ids;
}
