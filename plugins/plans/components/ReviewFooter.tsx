import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { Plan } from "../contract";
import { openAnnotations } from "../lib/plan-model";
import { useLiveStatus } from "../hooks/useLiveStatus";

export type ReviewAction = "approve";
export interface SubmitFailure { message: string; requestId: string; action: ReviewAction }
interface ReviewFooterProps {
  plan: Plan;
  failedCount: number;
  approvalState?: "pending" | "failed" | "dropped" | "sent";
  submitting: ReviewAction | null;
  failure: SubmitFailure | null;
  onSubmit: (action: ReviewAction) => void;
  onDismissFailure: () => void;
  confirmOpen: boolean;
  onConfirmOpenChange: (open: boolean) => void;
  className?: string;
}

export function ReviewFooter({ plan, failedCount, approvalState = "pending", submitting, failure, onSubmit,
  onDismissFailure, confirmOpen, onConfirmOpenChange, className }: ReviewFooterProps) {
  const liveStatus = useLiveStatus(plan.threadId);
  const open = openAnnotations(plan).length;
  const busy = submitting !== null;
  if (plan.status === "approved") {
    return (
      <div className={cn("flex items-center gap-3 border-t border-border bg-background px-4 py-3", className)}>
        <span className="flex size-7 items-center justify-center rounded-full bg-success/15 text-success">
          <Icon name="Check" className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium text-foreground">Approved</p>
          <p role="status" className="text-xs text-muted-foreground">
            {plan.sample
              ? "Sample plan: nothing was sent to an agent."
              : approvalState === "dropped" ? "Approval not delivered. The linked thread is archived or deleted."
              : approvalState === "failed" ? "Approval not delivered · retrying"
              : approvalState === "sent" ? "Approval sent to the thread" : "Sending approval…"}
          </p>
          {failedCount > 0 ? <p className="text-xs text-muted-foreground">{failedCount} not delivered</p> : null}
        </div>
      </div>
    );
  }

  return (
    <div className={cn("border-t border-border bg-background px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]", className)}>
      {failure ? (
        <div role="alert" className="mb-2 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
          <div className="min-w-0 flex-1"><p>{failure.message}</p><p className="text-xs text-muted-foreground">Request {failure.requestId}</p></div>
          <Button variant="ghost" size="sm" onClick={onDismissFailure}>Dismiss</Button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <p role="status" className="min-w-0 flex-1 text-xs text-muted-foreground">
          {[liveStatus, !liveStatus && open === 0 ? "No open annotations" : `${open} open`, failedCount ? `${failedCount} not delivered` : null].filter(Boolean).join(" · ")}
        </p>
        <AlertDialog open={confirmOpen} onOpenChange={onConfirmOpenChange}>
          <AlertDialogTrigger asChild>
            <Button type="button" disabled={busy}>
              <Icon name={busy ? "Loading" : "Play"} className={cn("size-4", busy && "animate-spin")} aria-hidden />
              Approve
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Approve this plan?</AlertDialogTitle>
              <AlertDialogDescription>
                {open > 0 ? `${open} ${open === 1 ? "annotation is" : "annotations are"} still open. ` : ""}
                The agent implements the current version.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => { onConfirmOpenChange(false); onSubmit("approve"); }}>Approve</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
