import { useEffect, useMemo, useRef, useState } from "react";
import { useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { branchPullRequestContract } from "./branch-pull-request-contract";

/**
 * thread id → whether BB's environment branch PR may appear as the row's PR.
 * Threads absent from the map (no environment, evaluation failure) keep
 * showing it.
 */
export type BranchPullRequestEligibility = ReadonlyMap<string, boolean>;
const EMPTY: BranchPullRequestEligibility = new Map();

// A burst of thread-list updates or a reconnect flap would each send the
// full id set; restarting this timer turns the burst into one bulk call.
const RECONCILE_DEBOUNCE_MS = 250;

/**
 * Each listed thread's branch-PR eligibility (a shared checkout's PR is not
 * the thread's own), loaded in one bulk RPC instead of one call per row. The
 * list is re-read on mount, when its id set changes, and on every realtime
 * (re)connection. The first load is prompt; later triggers share a debounce
 * timer so a burst issues a single call with the latest ids.
 */
export function useBranchPullRequestEligibility(
  threadIds: readonly string[],
): BranchPullRequestEligibility {
  const rpc = useRpc<typeof branchPullRequestContract>();
  const connection = useRealtimeConnectionState();
  const [eligibility, setEligibility] = useState(EMPTY);
  // The key covers the id set, not its order: a re-sorted list does not
  // refetch.
  const idsKey = useMemo(
    () => [...new Set(threadIds)].sort().join("\0"),
    [threadIds],
  );
  const loaded = useRef(false);
  useEffect(() => {
    let cancelled = false;
    const ids = idsKey === "" ? [] : idsKey.split("\0");
    const load = () => {
      void rpc
        .call("branchPullRequestEligibility", { threadIds: ids })
        .then(({ eligible }) => {
          if (!cancelled) setEligibility(new Map(Object.entries(eligible)));
        })
        .catch(() => {
          // Keep the last answer; unevaluated rows show the branch PR.
        });
    };
    const timer = setTimeout(load, loaded.current ? RECONCILE_DEBOUNCE_MS : 0);
    loaded.current = true;
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [rpc, idsKey, connection]);
  return eligibility;
}
