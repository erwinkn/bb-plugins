import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime } from "@get-bb/plugin-sdk/app";
import type { Plan } from "../contract";
import { describeError } from "../lib/errors";
import { PLANS_CHANGED, usePlansApi } from "./usePlansApi";

export interface PlanState {
  plan: Plan | null;
  error: string | null;
  isMissing: boolean;
  refetch: () => void;
  /** Replace the cached plan with a mutation result. */
  apply: (plan: Plan) => void;
}

/**
 * One plan with its full version and comment history. `list` only carries the
 * latest version, so the review surface always reads from `get` and from what
 * mutations return.
 */
export function usePlan(planId: string | null): PlanState {
  const api = usePlansApi();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isMissing, setMissing] = useState(false);
  const requestRef = useRef(0);
  const planRef = useRef<Plan | null>(null);
  const mountedRef = useRef(false);

  const refetch = useCallback(() => {
    if (planId === null) return;
    const request = (requestRef.current += 1);
    api.call("get", { id: planId }).then(
      (result) => {
        if (request !== requestRef.current) return;
        planRef.current = result;
        setPlan(result);
        setError(null);
        setMissing(false);
      },
      (cause: unknown) => {
        if (request !== requestRef.current) return;
        const message = describeError(cause);
        setMissing(/not found|no such|unknown plan|missing/i.test(message));
        setError(message);
      },
    );
  }, [api, planId]);

  useEffect(() => {
    mountedRef.current = true;
    planRef.current = null;
    setPlan(null);
    setError(null);
    setMissing(false);
    refetch();
    return () => { mountedRef.current = false; requestRef.current += 1; };
  }, [refetch]);
  useRealtime(PLANS_CHANGED, refetch);

  const apply = useCallback((next: Plan) => {
    if (!mountedRef.current || next.id !== planId) return;
    if (planRef.current && next.revision < planRef.current.revision) {
      refetch();
      return;
    }
    requestRef.current += 1;
    planRef.current = next;
    setPlan(next);
    setError(null);
  }, [planId, refetch]);

  return { plan, error, isMissing, refetch, apply };
}
