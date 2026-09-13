import { useState } from "react";
import { useBbNavigate, type PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
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
  return (
    <div role="group" aria-label={payload ? `Review ${payload.title}` : "Review"} title={payload?.title}
      style={{ contain: "inline-size" }}
      className="flex min-w-0 flex-col gap-2">
      {payload?.reviewSummary && <p className="line-clamp-3 min-w-0 break-words text-sm text-foreground">{payload.reviewSummary}</p>}
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
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
