import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { usePlan } from "../hooks/usePlan";
import { EmptyState, LoadingState } from "./EmptyState";
import { PlanReview } from "./PlanReview";

interface PlanReviewLoaderProps {
  planId: string;
  onDeleted: () => void;
  onBack?: () => void;
}

/** Fetches the full plan (versions and comments) and hands it to the review. */
export function PlanReviewLoader({ planId, onDeleted, onBack }: PlanReviewLoaderProps) {
  const { plan, error, isMissing, refetch, apply } = usePlan(planId);
  if (plan === null) {
    if (error !== null) {
      return (
        <div className="p-4">
          <EmptyState
            icon="AlertCircle"
            title={isMissing ? "This plan no longer exists" : "Could not load the plan"}
            description={isMissing ? "It may have been deleted." : error}
            actions={
              <>
                {onBack ? (
                  <Button type="button" variant="outline" onClick={onBack}>
                    Back to plans
                  </Button>
                ) : null}
                {!isMissing ? (
                  <Button type="button" onClick={refetch}>
                    Try again
                  </Button>
                ) : null}
              </>
            }
          />
        </div>
      );
    }
    return <LoadingState label="Loading plan…" />;
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      {error !== null ? (
        <div role="alert" className="flex items-center gap-2 border-b border-border bg-destructive/10 px-4 py-1.5 text-xs">
          <Icon name="AlertCircle" className="size-3.5 shrink-0 text-destructive" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-foreground">
            {isMissing ? "This plan was deleted; showing the last loaded copy." : `Could not refresh: ${error}`}
          </span>
          {!isMissing ? (
            <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={refetch}>
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}
      <PlanReview
        plan={plan}
        onPlanChange={apply}
        onDeleted={onDeleted}
        onBack={onBack}
        className="min-h-0 flex-1"
      />
    </div>
  );
}
