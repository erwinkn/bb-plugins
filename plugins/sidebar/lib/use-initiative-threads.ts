import { useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { projectModeContract } from "./project-mode-contract";
import { queryKeys, threadIdsQuery } from "./queries";
import { refresh } from "./query";

const EMPTY: ReadonlySet<string> = new Set();

/**
 * The ids of the threads Initiatives owns, kept fresh in the background.
 * Null means unknown: nothing cached and no answer yet, so the list waits
 * (the first answer, even a failed or timed-out read, ends the wait). With a
 * known set, a failed or slow read keeps it; only a confirmed answer replaces
 * it, an Initiatives plugin that is not running yielding an empty set.
 * `threadKey` changes when the host thread list gains or loses a thread: a
 * new worker thread is listed before the ledger records it, so the set is
 * read again.
 */
export function useInitiativeThreadIds(
  threadKey: string,
): ReadonlySet<string> | null {
  const rpc = useRpc<typeof projectModeContract>();
  const client = useQueryClient();
  const query = useQuery(threadIdsQuery(rpc));
  const first = useRef(true);
  useEffect(() => {
    if (first.current) first.current = false;
    else refresh(client, queryKeys.threadIds);
  }, [client, threadKey]);
  // A failed read without a known set ends the wait for the rest of the
  // session (a later read in flight does not bring it back), without caching.
  const failed = query.failureCount > 0 || query.errorUpdateCount > 0;
  const ids = query.data;
  return useMemo(() => (ids ? new Set(ids) : failed ? EMPTY : null), [ids, failed]);
}
