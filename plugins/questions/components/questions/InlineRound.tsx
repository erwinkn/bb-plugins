// The `::questions{round="…"}` directive. An inline round renders its
// questions right here; a panel round renders a compact card that opens
// the side panel. Attributes are untrusted: the round is fetched by id.
import { useCallback, useEffect, useState } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginMessageDirectiveProps, PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../../server";
import { type AnswerState, type ChangeSignal, type Round, REALTIME_CHANNEL, canSubmitRound } from "@/lib/model";
import { useQuestions } from "@/hooks/useQuestions";
import { requestRound, takeRequestedRound } from "@/lib/panel-navigation";
import { cn } from "@/lib/utils";
import { Hint, PanelButton } from "./primitives";
import { QuestionEditor } from "./QuestionEditor";
import { reportOutcome } from "./QuestionsPanel";

export const QUESTIONS_ACTION_ID = "questions";

function RoundCard({ threadId, round, answers }: { threadId: string; round: Round; answers: AnswerState[] }) {
  const navigate = useBbNavigate();
  const submitted = round.questions.filter((question) => {
    const state = answers.find((item) => item.questionId === question.id);
    return state?.submitted !== null && state?.submitted !== undefined;
  }).length;
  return (
    <div className="my-1 flex max-w-[720px] flex-wrap items-center gap-2 rounded-md border border-border bg-[var(--surface-raised)] px-2.5 py-1.5 text-[12px] text-muted-foreground">
      <span className="text-foreground">
        Round {round.number}: {round.questions.length} question{round.questions.length === 1 ? "" : "s"} ({submitted}/{round.questions.length})
      </span>
      <span className="flex-1" />
      <PanelButton
        small
        primary={submitted < round.questions.length}
        onClick={() => {
          // No params: the host would open a second tab for a new params value.
          requestRound(threadId, round.id);
          const opened = navigate.openThreadPanel({ actionId: QUESTIONS_ACTION_ID, title: "Questions" });
          if (!opened) {
            takeRequestedRound(threadId);
            toast.error("Open Questions from the panel launcher; this view has no side panel.");
          }
        }}
      >
        Open
      </PanelButton>
    </div>
  );
}

export function InlineEditor({ threadId, round }: { threadId: string; round: Round }) {
  const controller = useQuestions(threadId);
  const notices = controller.notices;
  useEffect(() => {
    for (const notice of notices) {
      toast.warning(notice.text);
      controller.dismissNotice(notice.id);
    }
    // Each notice is shown once; dismissing mutates the store, not React state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notices]);
  const ids = round.questions.map((question) => question.id);
  const ready = canSubmitRound(round, controller.answers);
  const submitted = ids.filter((id) => controller.statusOf(id) === "done").length;
  const submit = async () => {
    const outcome = await controller.submit(round.id);
    reportOutcome(outcome);
  };
  if (controller.status === "loading") {
    return <Hint className="my-1 block" role="status">Loading your answers…</Hint>;
  }
  if (controller.status === "error") {
    return (
      <div role="alert" className="my-1 max-w-[720px] rounded-md border border-[var(--surface-destructive-border)] bg-[var(--surface-destructive)] px-2.5 py-2 text-[12px]">
        <span className="text-foreground">Your answers could not be loaded: {controller.error}</span>
        <PanelButton small className="ml-2" onClick={() => controller.refetch()}>Try again</PanelButton>
      </div>
    );
  }
  return (
    <div className="my-1 max-w-[720px] overflow-hidden rounded-md border border-border bg-background text-[13px] leading-[1.45] text-foreground">
      {round.intro ? <div className="border-b border-[var(--border-seam)] px-3 py-2 text-[12px] text-muted-foreground">{round.intro}</div> : null}
      {round.questions.map((question, index) => {
        const label = controller.labels.get(question.id) ?? `Q${index + 1}`;
        const status = controller.statusOf(question.id);
        return (
          <div key={question.id} className={cn(index > 0 && "border-t border-[var(--border-seam)]")}>
            <QuestionEditor
              controller={controller}
              question={question}
              full={false}
              onError={(message) => toast.error(message)}
              header={
                <div className="flex items-baseline gap-2 pt-1.5">
                  <span className="min-w-[26px] text-[12px] tabular-nums text-[var(--subtle-foreground)]">{label}</span>
                  <span className="min-w-0 flex-1 font-medium [overflow-wrap:anywhere]">{question.title}{question.optional && <span className="ml-2 text-[12px] font-normal text-muted-foreground">Optional</span>}</span>
                  <span className="w-[18px] text-center text-[12px] text-[var(--subtle-foreground)]" aria-label={status === "done" ? "Submitted" : status === "draft" ? "Draft" : "Unanswered"}>
                    {status === "done" ? "✓" : status === "draft" ? "•" : ""}
                  </span>
                </div>
              }
            />
          </div>
        );
      })}
      <div className="flex min-h-10 flex-wrap items-center gap-2 border-t border-border py-1.5 pl-3 pr-2">
        <Hint>
          {submitted === ids.length
            ? "All answered. Edit an answer and submit again to update it."
            : "Answer all required questions. Optional questions can be skipped."}
        </Hint>
        <span className="flex-1" />
        <PanelButton small primary disabled={!ready || controller.submitting} onClick={() => void submit()}>
          Submit
        </PanelButton>
      </div>
    </div>
  );
}

function RoundDisplay({ threadId, roundId }: { threadId: string; roundId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<{ round: Round | null; answers: AnswerState[]; labels: Record<string, string> } | null | "error">(null);
  const load = useCallback(() => {
    if (roundId === "") return;
    rpc.call("questions_round", { threadId, roundId }).then(setState, () => setState("error"));
  }, [roundId, rpc, threadId]);
  useEffect(() => load(), [load]);
  useRealtime(REALTIME_CHANNEL, (payload) => {
    const signal = payload as Partial<ChangeSignal> | null;
    if (signal && signal.threadId === threadId && state !== null && state !== "error" && state.round?.mode !== "inline") load();
  });
  if (roundId === "") return <Hint>Questions round missing.</Hint>;
  if (state === null) return <Hint>Loading questions…</Hint>;
  if (state === "error") return <Hint>Questions could not be loaded.</Hint>;
  if (state.round === null) return <Hint>This questions round no longer exists.</Hint>;
  if (state.round.mode === "inline") return <InlineEditor threadId={threadId} round={state.round} />;
  return <RoundCard threadId={threadId} round={state.round} answers={state.answers} />;
}

export function QuestionsDirective({ attributes, message }: PluginMessageDirectiveProps) {
  return <RoundDisplay threadId={message.threadId} roundId={typeof attributes.round === "string" ? attributes.round.trim() : ""} />;
}

export function QuestionsInteraction({ interaction, cancel }: PluginPendingInteractionProps) {
  const payload = interaction.payload;
  const roundId = payload && typeof payload === "object" && !Array.isArray(payload) && typeof payload.roundId === "string" ? payload.roundId : "";
  return <div>
    <RoundDisplay threadId={interaction.threadId} roundId={roundId} />
    <PanelButton small onClick={() => void cancel().catch((error) => toast.error(String(error)))}>Cancel</PanelButton>
  </div>;
}
