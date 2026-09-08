import { cn } from "@/lib/utils";
import { STATUS_LABEL, type PlanStatus } from "../lib/plan-model";

const DOT_CLASS: Record<PlanStatus, string> = {
  review: "bg-warning",
  revising: "bg-muted-foreground",
  approved: "bg-success",
};

export function StatusDot({ status, className }: { status: PlanStatus; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-1.5 shrink-0 rounded-full", DOT_CLASS[status], className)}
    />
  );
}

/** Plan status as a quiet pill: a dot plus label, never a loud fill. */
export function StatusBadge({
  status,
  sample,
  className,
}: {
  status: PlanStatus;
  sample?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-full border border-border px-2 text-xs font-medium text-foreground",
        className,
      )}
    >
      <StatusDot status={status} />
      {STATUS_LABEL[status]}
      {sample ? <span className="text-muted-foreground">· Sample</span> : null}
    </span>
  );
}
