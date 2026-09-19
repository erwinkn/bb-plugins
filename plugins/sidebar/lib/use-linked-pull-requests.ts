import { useEffect, useMemo, useRef, useState } from "react";
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

// A burst of thread-list updates or a reconnect flap would each send the
// full id set; restarting this timer turns the burst into one bulk call.
const RECONCILE_DEBOUNCE_MS = 250;

/**
 * The github-prs links of the listed threads, loaded in one bulk RPC
 * instead of one call per row, plus each thread's branch-PR eligibility (a
 * shared checkout's PR is not the thread's own). The GitHub plugin bumps the
 * `pullRequestsChanged` RPC on every link change and the server republishes
 * it; the whole list is also reconciled on mount and on every realtime
 * (re)connection, since plugin signals are ephemeral. Reconcile triggers are
 * debounced so a burst issues a single bulk call with the latest ids.
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
  // Stamps order per-thread answers against bulk reconciles: a bulk answer
  // requested before a signal landed must not roll that thread's chips back.
  const clock = useRef(0);
  const refreshedAt = useRef(new Map<string, number>());
  useRealtime(LINKED_PULL_REQUESTS_CHANNEL, (payload) => {
    const threadId = (payload as { threadId?: unknown } | null)?.threadId;
    if (typeof threadId !== "string" || threadId === "") return;
    void rpc
      .call("linkedPullRequests", { threadIds: [threadId] })
      .then(({ pullRequests, branchPrEligible }) => {
        refreshedAt.current.set(threadId, ++clock.current);
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
  // The first reconcile is prompt; later triggers share the debounce timer.
  const loaded = useRef(false);
  useEffect(() => {
    let cancelled = false;
    const ids = idsKey === "" ? [] : idsKey.split("\0");
    const load = () => {
      const startedAt = ++clock.current;
      void rpc
        .call("linkedPullRequests", { threadIds: ids })
        .then(({ pullRequests, branchPrEligible }) => {
          if (cancelled) return;
          setResult((current) => {
            const links = new Map<string, readonly LinkedPullRequest[]>(
              Object.entries(pullRequests),
            );
            const eligibility = new Map<string, boolean>(
              Object.entries(branchPrEligible),
            );
            for (const [id, stamp] of refreshedAt.current) {
              if (stamp <= startedAt) continue;
              const linked = current.links.get(id);
              if (linked) links.set(id, linked);
              else links.delete(id);
              const eligible = current.branchPrEligible.get(id);
              if (eligible === undefined) eligibility.delete(id);
              else eligibility.set(id, eligible);
            }
            return { links, branchPrEligible: eligibility };
          });
        })
        .catch(() => {
          // Chips are additive: a failed load simply shows none.
        });
    };
    const timer = setTimeout(load, loaded.current ? RECONCILE_DEBOUNCE_MS : 0);
    loaded.current = true;
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [rpc, idsKey, connection]);
  return result;
}
