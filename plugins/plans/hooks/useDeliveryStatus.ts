import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime } from "@get-bb/plugin-sdk/app";
import { PLANS_CHANGED, usePlansApi } from "./usePlansApi";

type ApprovalState = "pending" | "failed" | "dropped" | "sent";

export function useDeliveryStatus(planId: string, planStatus = "open") {
  const api = usePlansApi();
  const [status, setStatus] = useState({
    planId, planStatus, failedCount: 0,
    failedAnnotations: new Set<string>() as ReadonlySet<string>,
    approvalState: "pending" as ApprovalState,
  });
  const refreshRef = useRef<() => void>(() => {});
  const planStatusRef = useRef(planStatus);
  const requestedStatusRef = useRef(planStatus);
  planStatusRef.current = planStatus;
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let trailing = false;
    const refresh = () => {
      if (cancelled) return;
      if (inFlight) { trailing = true; return; }
      inFlight = true;
      const requestedStatus = planStatusRef.current;
      requestedStatusRef.current = requestedStatus;
      void Promise.allSettled([
        api.call("deliveryStatus", { id: planId }),
        api.call("annotationDeliveryStatus", { id: planId }),
      ]).then(([itemResult, annotationResult]) => {
        if (cancelled || itemResult.status === "rejected" || annotationResult.status === "rejected") return;
        const items = itemResult.value;
        const annotations = annotationResult.value;
        const approvals = items.filter((item) => item.kind === "approved");
        setStatus({
          planId, planStatus: requestedStatus,
          failedCount: items.filter((item) => item.state === "failed").length,
          failedAnnotations: new Set(annotations.filter((item) => item.state === "failed").map((item) => item.annotationId)),
          approvalState: approvals.some((item) => item.state === "dropped") ? "dropped"
            : approvals.some((item) => item.state === "failed") ? "failed"
            : approvals.some((item) => item.state === "delivered") ? "sent" : "pending",
        });
      }).catch(() => { /* Keep the last known delivery state during reconnects. */ })
        .finally(() => {
          inFlight = false;
          if (!cancelled && trailing) { trailing = false; refresh(); }
        });
    };
    refreshRef.current = refresh;
    refresh();
    // The SDK RPC client has no abort option. Cancel result application and
    // the trailing refresh so unmounted reviews cannot start more requests.
    return () => { cancelled = true; trailing = false; };
  }, [api, planId]);
  useEffect(() => {
    if (requestedStatusRef.current !== planStatus) refreshRef.current();
  }, [planStatus]);
  useRealtime(PLANS_CHANGED, useCallback((payload: unknown) => {
    if (typeof payload === "object" && payload !== null && "id" in payload && payload.id !== planId) return;
    refreshRef.current();
  }, [planId]));
  return {
    failedCount: status.planId === planId ? status.failedCount : 0,
    failedAnnotations: status.planId === planId ? status.failedAnnotations : new Set<string>(),
    approvalState: status.planId === planId && status.planStatus === planStatus ? status.approvalState : "pending" as const,
  };
}
