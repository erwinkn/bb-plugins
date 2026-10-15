import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { branchPullRequestContract } from "./branch-pull-request-contract";
import { branchPullRequestsQuery } from "./queries";

/**
 * thread id → whether BB's environment branch PR may appear as the row's PR.
 * Threads absent from the map (no environment, evaluation failure) keep
 * showing it.
 */
export type BranchPullRequestEligibility = ReadonlyMap<string, boolean>;
const EMPTY: BranchPullRequestEligibility = new Map();

// A burst of thread-list updates would each ask for a new id set; the set
// settles this long before it is read.
const RECONCILE_DEBOUNCE_MS = 250;

/**
 * Each listed thread's branch-PR eligibility (a shared checkout's PR is not
 * the thread's own), loaded in one bulk RPC instead of one call per row. The
 * first id set reads at once; later ones settle first, so a burst issues a
 * single call with the latest ids.
 */
export function useBranchPullRequestEligibility(
  threadIds: readonly string[],
): BranchPullRequestEligibility {
  const rpc = useRpc<typeof branchPullRequestContract>();
  // The key covers the id set, not its order: a re-sorted list does not
  // refetch.
  const idsKey = useMemo(
    () => [...new Set(threadIds)].sort().join("\0"),
    [threadIds],
  );
  const [settledKey, setSettledKey] = useState(idsKey);
  useEffect(() => {
    const timer = setTimeout(() => setSettledKey(idsKey), RECONCILE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [idsKey]);
  const { data, dataUpdatedAt, isPlaceholderData } = useQuery(
    branchPullRequestsQuery(rpc, settledKey),
  );
  // The most recent answer for any set shows until a newer one lands, so a
  // set whose read failed, or a returning set's older cached answer, never
  // replaces it. Unevaluated rows show the branch PR.
  const latest = useRef<{ answer: NonNullable<typeof data>; at: number } | null>(null);
  if (data && !isPlaceholderData && dataUpdatedAt > (latest.current?.at ?? -1))
    latest.current = { answer: data, at: dataUpdatedAt };
  const shown = latest.current?.answer;
  return useMemo(() => (shown ? new Map(Object.entries(shown)) : EMPTY), [shown]);
}
