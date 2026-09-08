import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime } from "@get-bb/plugin-sdk/app";
import type { Plan } from "../contract";
import { describeError } from "../lib/errors";
import { PLANS_CHANGED, PLANS_PAGE_SIZE, usePlansApi } from "./usePlansApi";

export interface PlanListState {
  plans: Plan[] | null;
  error: string | null;
  isLoadingMore: boolean;
  hasMore: boolean;
  loadMore: () => void;
  refetch: () => void;
}

/**
 * Paged plan list (10 per page, latest version only) kept current by the
 * backend's `plans-changed` signal. A refresh re-reads every page that is
 * already open so a long list does not collapse back to the first page.
 */
export function usePlanList(threadId: string): PlanListState {
  const api = usePlansApi();
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const pagesRef = useRef(1);
  const requestRef = useRef(0);

  const fetchPages = useCallback(
    async (pageCount: number) => {
      const request = (requestRef.current += 1);
      const collected: Plan[] = [];
      let more = false;
      for (let page = 0; page < pageCount; page += 1) {
        const batch = await api.call("list", {
          threadId,
          offset: page * PLANS_PAGE_SIZE,
        });
        collected.push(...batch);
        more = batch.length === PLANS_PAGE_SIZE;
        if (!more) break;
      }
      if (request !== requestRef.current) return;
      setPlans(collected);
      setHasMore(more);
      setError(null);
    },
    [api, threadId],
  );

  const refetch = useCallback(() => {
    fetchPages(pagesRef.current).catch((cause: unknown) => setError(describeError(cause)));
  }, [fetchPages]);

  const loadMore = useCallback(() => {
    if (isLoadingMore) return;
    setLoadingMore(true);
    pagesRef.current += 1;
    fetchPages(pagesRef.current)
      .catch((cause: unknown) => setError(describeError(cause)))
      .finally(() => setLoadingMore(false));
  }, [fetchPages, isLoadingMore]);

  useEffect(() => {
    pagesRef.current = 1;
    refetch();
  }, [refetch]);
  useRealtime(PLANS_CHANGED, refetch);

  return { plans, error, isLoadingMore, hasMore, loadMore, refetch };
}
