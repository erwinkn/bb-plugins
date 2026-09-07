import { useEffect, useState } from "react";
import { type PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { Plan } from "../contract";
import { usePlanList } from "../hooks/usePlanList";
import { EmptyState, LoadingState } from "./EmptyState";
import { NewPlanForm } from "./NewPlanForm";
import { PlanList } from "./PlanList";
import { PlanReviewLoader } from "./PlanReviewLoader";

function paramPlanId(params: PluginThreadPanelProps["params"]): string | null {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return null;
  const value = (params as Record<string, unknown>).planId;
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The thread side-panel tab. One plan opens straight into review; several
 * show a picker; none shows the create form bound to this thread.
 */
export function ThreadPlanPanel({ threadId, params }: PluginThreadPanelProps) {
  const list = usePlanList(threadId);
  const requested = paramPlanId(params);
  const [chosenId, setChosenId] = useState<string | null>(requested);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (requested !== null) setChosenId(requested);
  }, [requested]);

  const plans = list.plans;
  const activeId =
    chosenId ?? (plans !== null && plans.length === 1 ? plans[0]!.id : null);

  if (plans === null) {
    if (list.error !== null) {
      return (
        <div className="p-4">
          <EmptyState
            icon="AlertCircle"
            title="Could not load plans"
            description={list.error}
            actions={
              <Button type="button" onClick={list.refetch}>
                Try again
              </Button>
            }
          />
        </div>
      );
    }
    return <LoadingState label="Loading plan…" />;
  }

  if (activeId !== null && !creating) {
    return (
      <PlanReviewLoader
        key={`${threadId}:${activeId}`}
        planId={activeId}
        threadId={threadId}
        onDeleted={() => {
          setChosenId(null);
          list.refetch();
        }}
        onBack={plans.length > 1 ? () => setChosenId(null) : undefined}
      />
    );
  }

  if (plans.length === 0 || creating) {
    return (
      <NewPlanForm
        threadId={threadId}
        onCreated={(plan: Plan) => {
          setCreating(false);
          setChosenId(plan.id);
          list.refetch();
        }}
        onCancel={creating ? () => setCreating(false) : undefined}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border pl-4 pr-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {plans.length} plans in this thread
        </span>
        <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => setCreating(true)}>
          <Icon name="Plus" className="size-3.5" aria-hidden />
          New
        </Button>
      </div>
      <PlanList
        list={list}
        onSelect={(plan) => setChosenId(plan.id)}
      />
    </div>
  );
}
