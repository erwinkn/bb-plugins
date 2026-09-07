import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { Plan } from "../contract";
import type { PlanListState } from "../hooks/usePlanList";
import { latestVersion, STATUS_LABEL } from "../lib/plan-model";
import { formatRelativeTime } from "../lib/time";
import { LoadingState } from "./EmptyState";
import { StatusDot } from "./StatusBadge";

interface PlanListProps {
  list: PlanListState;
  onSelect: (plan: Plan) => void;
  className?: string;
}

/** The plan index: rows sorted by the backend, ten at a time. */
export function PlanList({
  list,
  onSelect,
  className,
}: PlanListProps) {
  const { plans, error, hasMore, isLoadingMore, loadMore } = list;
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      {error ? (
        <p role="alert" className="border-b border-border px-4 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {plans === null ? (
          <LoadingState label="Loading plans…" />
        ) : (
          <ul role="list" className="py-1">
            {plans.map((plan) => (
              <li key={plan.id}>
                <PlanRow plan={plan} onSelect={() => onSelect(plan)} />
              </li>
            ))}
            {hasMore ? (
              <li className="px-3 py-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full text-muted-foreground"
                  onClick={loadMore}
                  disabled={isLoadingMore}
                >
                  {isLoadingMore ? (
                    <Icon name="Loading" className="size-3.5 animate-spin" aria-hidden />
                  ) : null}
                  Load older plans
                </Button>
              </li>
            ) : null}
          </ul>
        )}
      </div>
    </div>
  );
}

function PlanRow({ plan, onSelect }: { plan: Plan; onSelect: () => void }) {
  const latest = latestVersion(plan);
  const open = plan.comments.filter((comment) => !comment.resolved && comment.kind !== "looksGood").length;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full flex-col gap-0.5 px-4 py-2.5 text-left transition-colors duration-150 hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring max-md:pointer-coarse:py-3",
      )}
    >
      <span className="flex items-center gap-2">
        <StatusDot status={plan.status} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{plan.title}</span>
        {plan.sample ? (
          <span className="shrink-0 rounded border border-border px-1 text-[10px] uppercase leading-4 tracking-wide text-muted-foreground">
            Sample
          </span>
        ) : null}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 pl-3.5 text-xs text-muted-foreground">
        <span className="truncate">{plan.projectName ?? STATUS_LABEL[plan.status]}</span>
        <span aria-hidden>·</span>
        {latest ? <span className="shrink-0">v{latest.number}</span> : null}
        {open > 0 ? (
          <>
            <span aria-hidden>·</span>
            <span className="shrink-0">{open} open</span>
          </>
        ) : null}
        <span className="ml-auto shrink-0 pl-2">{formatRelativeTime(plan.updatedAt)}</span>
      </span>
    </button>
  );
}
