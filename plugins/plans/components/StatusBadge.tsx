import { cn } from "@/lib/utils";
import { type PlanStatus } from "../lib/plan-model";

const DOT_CLASS: Record<PlanStatus, string> = {
  open: "bg-warning",
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
