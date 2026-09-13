import { useState } from "react";
import { useBbNavigate, type PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { usePlanList } from "../hooks/usePlanList";
import type { PlanStatus } from "../lib/plan-model";
import { STATUS_TINT, StatusChip } from "./StatusBadge";
import { REVIEW_ACTION_ID } from "./ThreadPlanHeaderButton";

interface PromptPayload {
  planId: string;
  versionId: string;
  title: string;
  versionNumber: number;
  reviewSummary: string | null;
}

function readPayload(payload: unknown): PromptPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  return typeof record.planId === "string" &&
    typeof record.versionId === "string" &&
    typeof record.title === "string" &&
    typeof record.versionNumber === "number"
    ? { planId: record.planId, versionId: record.versionId, title: record.title, versionNumber: record.versionNumber,
        reviewSummary: typeof record.reviewSummary === "string" && record.reviewSummary.trim() ? record.reviewSummary : null }
    : null;
}

/**
 * Sits with the usable composer while the plan waits for feedback. The decision
 * itself happens in the Plans panel; this only opens it or lets the
 * user release the agent without deciding.
 */
export function PlanReviewPrompt({ interaction, cancel }: PluginPendingInteractionProps) {
  const navigate = useBbNavigate();
  const [isReleasing, setReleasing] = useState(false);
  const payload = readPayload(interaction.payload);
  // The prompt outlives an approval made in the panel until the agent picks
  // it up, so the status follows the live list rather than the payload.
  const list = usePlanList(interaction.threadId);
  const status: PlanStatus = list.plans?.find((plan) => plan.id === payload?.planId)?.status ?? "open";

  const open = () => {
    if (payload === null) return;
    navigate.openThreadPanel({
      actionId: REVIEW_ACTION_ID,
      title: "Plan",
      params: { threadId: interaction.threadId, planId: payload.planId },
    });
  };

  // The host carries the review heading; the body explains the revision.
  // Inline-size containment keeps the host's min-content fieldset from growing
  // to the unbroken title's width before the ellipsis can take effect.
  // The status shares the action row so the prompt stays as short on phones.
  return (
    <div role="group" aria-label={payload ? `Review ${payload.title}` : "Review"} title={payload?.title}
      style={{ contain: "inline-size" }}
      className="flex min-w-0 flex-col gap-2">
      {payload?.reviewSummary && <p className="line-clamp-3 min-w-0 break-words text-sm text-foreground">{payload.reviewSummary}</p>}
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
        <span className="mr-auto inline-flex min-w-0 items-center gap-1.5">
          <Icon name="ListTodo" className="size-3.5 shrink-0" style={{ color: STATUS_TINT[status] }} aria-hidden />
          <StatusChip status={status} />
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-11 sm:h-8"
          disabled={isReleasing}
          onClick={() => {
            setReleasing(true);
            void cancel().finally(() => setReleasing(false));
          }}
        >
          Skip
        </Button>
        <Button type="button" size="sm" className="h-11 sm:h-8" onClick={open} disabled={payload === null}>
          Open
        </Button>
      </div>
    </div>
  );
}
