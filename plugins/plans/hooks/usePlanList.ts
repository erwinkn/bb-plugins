import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime } from "@get-bb/plugin-sdk/app";
import type { Plan } from "../contract";
import { describeError } from "../lib/errors";
import { changesPlanList } from "../lib/change-signal";
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
 * Full plans, ten per page. Appending reads only the next page; a relevant
 * invalidation refreshes the opened range so moved or removed rows converge.
 */
export function usePlanList(threadId: string): PlanListState {
  const api = usePlansApi();
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const pagesRef = useRef(1);
  const requestRef = useRef(0);
  const plansRef = useRef<Plan[] | null>(null);
  const appendingRef = useRef(false);
  const refreshingRef = useRef(false);

  const fetchPages = useCallback(
    async (pageCount: number) => {
      const request = (requestRef.current += 1);
      refreshingRef.current = true;
      appendingRef.current = false;
      setLoadingMore(false);
      const collected: Plan[] = [];
      let more = false;
      let pagesRead = 0;
      try {
        for (let page = 0; page < pageCount; page += 1) {
          const batch = await api.call("list", {
            ...(threadId ? { threadId } : {}),
            offset: page * PLANS_PAGE_SIZE,
          });
          if (request !== requestRef.current) return;
          collected.push(...batch);
          pagesRead += 1;
          more = batch.length === PLANS_PAGE_SIZE;
          if (!more) break;
        }
        if (request !== requestRef.current) return;
        const unique = [...new Map(collected.map((plan) => [plan.id, plan])).values()]
          .sort((a, b) => b.updatedAt - a.updatedAt);
        pagesRef.current = pagesRead;
        plansRef.current = unique;
        setPlans(unique);
        setHasMore(more);
        setError(null);
      } catch (cause: unknown) {
        if (request === requestRef.current) setError(describeError(cause));
      } finally {
        if (request === requestRef.current) refreshingRef.current = false;
      }
    },
    [api, threadId],
  );

  const refetch = useCallback(() => {
    void fetchPages(pagesRef.current);
  }, [fetchPages]);

  const loadMore = useCallback(() => {
    if (appendingRef.current || refreshingRef.current || plansRef.current === null || !hasMore) return;
    appendingRef.current = true;
    setLoadingMore(true);
    const pageCount = pagesRef.current + 1;
    const request = ++requestRef.current;
    api.call("list", { ...(threadId ? { threadId } : {}), offset: (pageCount - 1) * PLANS_PAGE_SIZE })
      .then((batch) => {
        if (request !== requestRef.current) return;
        const current = plansRef.current!;
        const ids = new Set(current.map((plan) => plan.id));
        // An overlap means the offset shifted during the read. Refresh the
        // opened range rather than append a duplicate or keep stale ordering.
        if (batch.some((plan) => ids.has(plan.id)) || new Set(batch.map((plan) => plan.id)).size !== batch.length
          || batch[0] && current.at(-1) && batch[0].updatedAt > current.at(-1)!.updatedAt) return fetchPages(pageCount);
        const next = [...current, ...batch];
        pagesRef.current = pageCount;
        plansRef.current = next;
        setPlans(next);
        setHasMore(batch.length === PLANS_PAGE_SIZE);
        setError(null);
      })
      .catch((cause: unknown) => { if (request === requestRef.current) setError(describeError(cause)); })
      .finally(() => {
        if (request !== requestRef.current) return;
        appendingRef.current = false;
        setLoadingMore(false);
      });
  }, [api, threadId, fetchPages, hasMore]);

  useEffect(() => {
    pagesRef.current = 1;
    plansRef.current = null;
    setPlans(null);
    setError(null);
    setHasMore(false);
    refetch();
    return () => { requestRef.current += 1; appendingRef.current = false; };
  }, [refetch]);
  useRealtime(PLANS_CHANGED, useCallback((payload: unknown) => {
    if (changesPlanList(payload, threadId)) refetch();
  }, [threadId, refetch]));

  return { plans, error, isLoadingMore, hasMore, loadMore, refetch };
}
