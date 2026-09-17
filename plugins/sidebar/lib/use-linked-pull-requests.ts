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
/**
 * thread id → whether BB's environment branch PR may appear as the row's PR.
 * Threads absent from the map (no environment, evaluation failure) keep
 * showing it, matching the behavior before the shared-checkout guard.
 */
export type BranchPullRequestEligibility = ReadonlyMap<string, boolean>;
const EMPTY: { links: LinkedPullRequests; branchPrEligible: BranchPullRequestEligibility } = {
  links: new Map(),
  branchPrEligible: new Map(),
};

/**
 * The github-prs links of the listed threads, loaded in one bulk RPC
 * instead of one call per row, plus each thread's branch-PR eligibility (a
 * shared checkout's PR is not the thread's own). The GitHub plugin bumps the
 * `pullRequestsChanged` RPC on every link change and the server republishes
 * it; the whole list is also reconciled on mount and on every realtime
 * (re)connection, since plugin signals are ephemeral.
 */
export function useLinkedPullRequests(
  threadIds: readonly string[],
): { links: LinkedPullRequests; branchPrEligible: BranchPullRequestEligibility } {
  const rpc = useRpc<typeof pullRequestsContract>();
  const connection = useRealtimeConnectionState();
  const [result, setResult] = useState(EMPTY);
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
      .then(({ pullRequests, branchPrEligible }) => {
        setResult((current) => {
          const links = new Map(current.links);
          const list = pullRequests[threadId];
          if (list !== undefined && list.length > 0) links.set(threadId, list);
          else links.delete(threadId);
          const eligibility = new Map(current.branchPrEligible);
          const eligible = branchPrEligible[threadId];
          if (eligible !== undefined) eligibility.set(threadId, eligible);
          else eligibility.delete(threadId);
          return { links, branchPrEligible: eligibility };
        });
      })
      .catch(() => {});
  });
  useEffect(() => {
    let cancelled = false;
    const ids = idsKey === "" ? [] : idsKey.split("\0");
    void rpc
      .call("linkedPullRequests", { threadIds: ids })
      .then(({ pullRequests, branchPrEligible }) => {
        if (cancelled) return;
        setResult({
          links: new Map(Object.entries(pullRequests)),
          branchPrEligible: new Map(Object.entries(branchPrEligible)),
        });
      })
      .catch(() => {
        // Chips are additive: a failed load simply shows none.
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, idsKey, connection]);
  return result;
}
