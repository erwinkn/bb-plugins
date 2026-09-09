import { useLiveStatus } from "../hooks/useLiveStatus";
import { toast } from "sonner";
import { useBbNavigate, useRealtime, type PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { COARSE_POINTER_HEADER_ICON_BUTTON_CLASS } from "@/components/ui/coarse-pointer-sizing";
import { cn } from "@/lib/utils";
import { usePlanList } from "../hooks/usePlanList";
import { STATUS_LABEL } from "../lib/plan-model";
import { StatusDot } from "./StatusBadge";

export const REVIEW_ACTION_ID = "review-plan";
export const PLAN_SUBMITTED = "plan-submitted";

function submittedPayload(payload: unknown): { id: string; threadId: string } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.threadId === "string"
    ? { id: record.id, threadId: record.threadId }
    : null;
}

/**
 * Thread header control: opens the review tab for this thread's plan and,
 * when an agent submits or revises a plan for the thread currently in view,
 * opens it without being asked. Other threads are never navigated.
 */
export function ThreadPlanHeaderButton({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const liveStatus = useLiveStatus(threadId);
  const navigate = useBbNavigate();
  const list = usePlanList(threadId);
  const plan = list.plans?.[0] ?? null;

  const open = (planId: string) =>
    navigate.openThreadPanel({
      actionId: REVIEW_ACTION_ID,
      title: "Plan",
      params: { threadId, planId },
    });

  // The host deduplicates identical action+params opens, so every signal for
  // this thread may pass through: a rapid revision refocuses the same tab.
  useRealtime(PLAN_SUBMITTED, (payload) => {
    const submitted = submittedPayload(payload);
    if (submitted === null || submitted.threadId !== threadId) return;
    if (open(submitted.id)) toast("A plan is ready for review");
  });

  if (plan === null) return null;
  const label = `Plan: ${plan.status === "approved" ? "Approved" : liveStatus ?? STATUS_LABEL[plan.status]}`;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={label}
      onClick={() => open(plan.id)}
      className={cn(
        isCompactViewport ? COARSE_POINTER_HEADER_ICON_BUTTON_CLASS : "h-7 gap-1.5 px-2 text-xs",
      )}
    >
      {isCompactViewport ? (
        <span className="relative inline-flex">
          <Icon name="ListTodo" aria-hidden />
          <StatusDot status={plan.status} className="absolute -right-0.5 -top-0.5" />
        </span>
      ) : (
        <>
          <StatusDot status={plan.status} />
          Plan · {plan.status === "approved" ? "Approved" : liveStatus ?? "Open"}
        </>
      )}
    </Button>
  );
}
