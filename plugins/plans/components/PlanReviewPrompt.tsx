import { useState } from "react";
import { useBbNavigate, type PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { REVIEW_ACTION_ID } from "./ThreadPlanHeaderButton";

interface PromptPayload {
  planId: string;
  versionId: string;
  title: string;
  versionNumber: number;
}

function readPayload(payload: unknown): PromptPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  return typeof record.planId === "string" &&
    typeof record.versionId === "string" &&
    typeof record.title === "string" &&
    typeof record.versionNumber === "number"
    ? { planId: record.planId, versionId: record.versionId, title: record.title, versionNumber: record.versionNumber }
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

  // BB already renders the title, attribution and card. Only add actions here.
  return (
    <div role="group" aria-label={payload ? `Review ${payload.title}` : "Plan review"}
      className="flex flex-wrap items-center justify-end gap-2">
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
        Open review
      </Button>
    </div>
  );
}
