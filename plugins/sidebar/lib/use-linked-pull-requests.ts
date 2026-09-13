import { useEffect, useMemo, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { pullRequestsContract } from "./pull-requests-contract";
import {
  LINKED_PULL_REQUESTS_CHANNEL,
  type LinkedPullRequest,
} from "./pull-requests-schema";

/** thread id → its github-prs links; threads without links are absent. */
export type LinkedPullRequests = ReadonlyMap<
  string,
  readonly LinkedPullRequest[]
>;
const EMPTY_LINKS: LinkedPullRequests = new Map();

/**
 * The github-prs links of the listed threads, loaded in one bulk RPC
 * instead of one call per row. The GitHub plugin bumps the
 * `pullRequestsChanged` RPC on every link change and the server republishes
 * it; the whole list is also reconciled on mount and on every realtime
 * (re)connection, since plugin signals are ephemeral.
 */
export function useLinkedPullRequests(
  threadIds: readonly string[],
): LinkedPullRequests {
  const rpc = useRpc<typeof pullRequestsContract>();
  const connection = useRealtimeConnectionState();
  const [links, setLinks] = useState<LinkedPullRequests>(EMPTY_LINKS);
  // The key covers the id set, not its order: a re-sorted list does not
  // refetch.
  const idsKey = useMemo(
    () => [...new Set(threadIds)].sort().join("\0"),
    [threadIds],
  );
  useRealtime(LINKED_PULL_REQUESTS_CHANNEL, (payload) => {
    const threadId = (payload as { threadId?: unknown } | null)?.threadId;
    if (typeof threadId !== "string" || threadId === "") return;
    void rpc
      .call("linkedPullRequests", { threadIds: [threadId] })
      .then(({ pullRequests }) => {
        setLinks((current) => {
          const next = new Map(current);
          const list = pullRequests[threadId];
          if (list !== undefined && list.length > 0)
            next.set(threadId, list);
          else next.delete(threadId);
          return next;
        });
      })
      .catch(() => {});
  });
  useEffect(() => {
    let cancelled = false;
    const ids = idsKey === "" ? [] : idsKey.split("\0");
    void rpc
      .call("linkedPullRequests", { threadIds: ids })
      .then(({ pullRequests }) => {
        if (!cancelled) setLinks(new Map(Object.entries(pullRequests)));
      })
      .catch(() => {
        // Chips are additive: a failed load simply shows none.
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, idsKey, connection]);
  return links;
}
