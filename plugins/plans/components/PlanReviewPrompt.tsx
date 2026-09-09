import { useState } from "react";
import { useBbNavigate, type PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
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

  // The text keeps a real minimum width, so on a phone the actions wrap onto
  // their own row instead of squeezing the copy to one word per line.
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-background px-4 py-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-warning/15 text-warning">
        <Icon name="ListTodo" className="size-4" aria-hidden />
      </span>
      <p className="min-w-0 flex-[1_1_12rem] text-sm text-foreground">Plan ready for your review.</p>
      <div className="ml-auto flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isReleasing}
          onClick={() => {
            setReleasing(true);
            void cancel().finally(() => setReleasing(false));
          }}
        >
          Skip
        </Button>
        <Button type="button" size="sm" onClick={open} disabled={payload === null}>
          Open
          <Icon name="ArrowRight" className="size-3.5" aria-hidden />
        </Button>
      </div>
    </div>
  );
}
