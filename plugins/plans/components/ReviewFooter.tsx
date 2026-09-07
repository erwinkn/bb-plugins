import { useEffect, useRef, type KeyboardEvent } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { Plan } from "../contract";
import { pendingFeedbackComments, reviewGate } from "../lib/plan-model";
import { formatRelativeTime } from "../lib/time";

export type ReviewAction = "feedback" | "approve";

export interface SubmitFailure {
  message: string;
  requestId: string;
  action: ReviewAction;
}

interface ReviewFooterProps {
  plan: Plan;
  versionId: string;
  note: string;
  onNoteChange: (note: string) => void;
  persistFailed: boolean;
  submitting: ReviewAction | null;
  failure: SubmitFailure | null;
  onSubmit: (action: ReviewAction) => void;
  onDismissFailure: () => void;
  /** Confirmation for approval is shown as a dialog; this toggles it. */
  confirmOpen: boolean;
  onConfirmOpenChange: (open: boolean) => void;
  onRevise: () => void;
  className?: string;
}

const NOTE_MAX_ROWS = 6;

/**
 * The decision bar: a note for the agent plus the two explicit outcomes.
 * "Send feedback" keeps the plan in review; "Approve and start" hands it to
 * the agent. Both explain why they are unavailable instead of failing later.
 */
export function ReviewFooter({
  plan,
  versionId,
  note,
  onNoteChange,
  persistFailed,
  submitting,
  failure,
  onSubmit,
  onDismissFailure,
  confirmOpen,
  onConfirmOpenChange,
  onRevise,
  className,
}: ReviewFooterProps) {
  const gate = reviewGate(plan, versionId, note);
  const pending = pendingFeedbackComments(plan).length;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const busy = submitting !== null;

  useEffect(() => {
    const element = textareaRef.current;
    if (element === null) return;
    element.style.height = "auto";
    const lineHeight = 24;
    element.style.height = `${Math.min(element.scrollHeight + 2, lineHeight * NOTE_MAX_ROWS + 16)}px`;
  }, [note]);

  if (plan.status === "approved") {
    return (
      <div className={cn("flex items-center gap-3 border-t border-border bg-background px-4 py-3", className)}>
        <span className="flex size-7 items-center justify-center rounded-full bg-success/15 text-success">
          <Icon name="Check" className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium text-foreground">Approved</p>
          <p className="text-xs text-muted-foreground">
            {plan.sample
              ? "Sample plan: nothing was sent to an agent."
              : `Approval sent to the thread · ${formatRelativeTime(plan.updatedAt)}`}
          </p>
        </div>
      </div>
    );
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && gate.canSendFeedback && !busy) {
      event.preventDefault();
      onSubmit("feedback");
    }
  };

  const hint = failure
    ? null
    : gate.canApprove
      ? pending > 0
        ? plan.sample
          ? `${pending} draft ${pending === 1 ? "comment" : "comments"} will be marked as sent.`
          : `${pending} draft ${pending === 1 ? "comment" : "comments"} will be sent with feedback.`
        : plan.sample
          ? "No open comments. Approving only marks the sample as approved."
          : "No open comments. Approving sends the go-ahead to the thread."
      : gate.approveReason;

  return (
    <div className={cn("border-t border-border bg-background", className)}>
      {plan.status === "revising" ? (
        <div className="flex items-center gap-3 border-b border-border px-4 py-2 text-sm">
          <Icon name="Loading" className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
          <p className="min-w-0 flex-1 text-muted-foreground">
            Feedback sent.{" "}
            {plan.sample ? "Add a revision yourself to try the version diff." : "Waiting for the agent's revision."}
          </p>
          <Button type="button" variant={plan.sample ? "default" : "outline"} size="sm" onClick={onRevise}>
            {plan.sample ? "Add revision" : "Import revision"}
          </Button>
        </div>
      ) : null}
      <div className="space-y-2 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
        <Textarea
          ref={textareaRef}
          value={note}
          onChange={(event) => onNoteChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Note for the agent (optional)"
          aria-label="Note for the agent"
          rows={1}
          disabled={busy}
          className="min-h-9 resize-none leading-6 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        />
        {failure ? (
          <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
            <Icon name="AlertCircle" className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-foreground">{failure.message}</p>
              <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                Request {failure.requestId}
              </p>
            </div>
            <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onDismissFailure}>
              Dismiss
            </Button>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 basis-40 text-xs text-muted-foreground" aria-live="polite">
            {persistFailed ? "Draft not saved in this browser. " : null}
            {hint}
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={!gate.canSendFeedback || busy}
              onClick={() => onSubmit("feedback")}
            >
              {submitting === "feedback" ? (
                <Icon name="Loading" className="size-4 animate-spin" aria-hidden />
              ) : (
                <Icon name="Sent" className="size-4" aria-hidden />
              )}
              Send feedback
            </Button>
            <AlertDialog open={confirmOpen} onOpenChange={onConfirmOpenChange}>
              <Button
                type="button"
                disabled={!gate.canApprove || busy}
                onClick={() => (plan.sample ? onSubmit("approve") : onConfirmOpenChange(true))}
              >
                {submitting === "approve" ? (
                  <Icon name="Loading" className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Icon name="Play" className="size-4" aria-hidden />
                )}
                Approve and start
              </Button>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Approve this plan and start?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The approval{note.trim() ? " and your note are" : " is"} sent to the linked
                    thread, queued if the agent is busy. The agent starts from the plan when it
                    reads the message.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => {
                      onConfirmOpenChange(false);
                      onSubmit("approve");
                    }}
                  >
                    Approve and start
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </div>
    </div>
  );
}
