// The `::questions{round="…"}` directive. An inline round renders its
// questions right here; a notebook round renders a compact card that opens
// the side panel. Attributes are untrusted: the round is fetched by id.
import { useCallback, useEffect, useState } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../../server";
import { type AnswerState, type ChangeSignal, type Round, REALTIME_CHANNEL, hasContent } from "@/lib/model";
import { useNotebook } from "@/hooks/useNotebook";
import { requestRound, takeRequestedRound } from "@/lib/panel-navigation";
import { cn } from "@/lib/utils";
import { Hint, PanelButton } from "./primitives";
import { QuestionEditor } from "./QuestionEditor";
import { reportOutcome } from "./NotebookPanel";

export const NOTEBOOK_ACTION_ID = "notebook";

function NotebookCard({ threadId, round, answers, labels }: { threadId: string; round: Round; answers: AnswerState[]; labels: Record<string, string> }) {
  const navigate = useBbNavigate();
  const submitted = round.questions.filter((question) => {
    const state = answers.find((item) => item.questionId === question.id);
    return state?.submitted !== null && state?.submitted !== undefined && hasContent(state.submitted);
  }).length;
  const first = round.questions[0];
  const range = first ? `${labels[first.id] ?? ""}${round.questions.length > 1 ? `–${labels[round.questions[round.questions.length - 1]!.id] ?? ""}` : ""}` : "";
  return (
    <div className="my-1 flex max-w-[720px] flex-wrap items-center gap-2 rounded-md border border-border bg-[var(--surface-raised)] px-2.5 py-1.5 text-[12px] text-muted-foreground">
      <span className="font-medium text-foreground">Questions · round {round.number}</span>
      <span>
        {round.questions.length} question{round.questions.length === 1 ? "" : "s"}
        {range ? ` (${range})` : ""} · {submitted} of {round.questions.length} submitted
      </span>
      <span className="flex-1" />
      <PanelButton
        small
        primary={submitted < round.questions.length}
        onClick={() => {
          // No params: the host would open a second tab for a new params value.
          requestRound(threadId, round.id);
          const opened = navigate.openThreadPanel({ actionId: NOTEBOOK_ACTION_ID, title: "Questions" });
          if (!opened) {
            takeRequestedRound(threadId);
            toast.error("Open the Questions notebook from the panel launcher; this view has no side panel.");
          }
        }}
      >
        Open notebook
      </PanelButton>
    </div>
  );
}

function InlineEditor({ threadId, round }: { threadId: string; round: Round }) {
  const notebook = useNotebook(threadId);
  const notices = notebook.notices;
  useEffect(() => {
    for (const notice of notices) {
      toast.warning(notice.text);
      notebook.dismissNotice(notice.id);
    }
    // Each notice is shown once; dismissing mutates the store, not React state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notices]);
  const ids = round.questions.map((question) => question.id);
  const pending = notebook.pendingIds.filter((id) => ids.includes(id)).length;
  const submitted = ids.filter((id) => notebook.statusOf(id) === "done").length;
  const submit = async () => {
    const outcome = await notebook.submit(ids);
    reportOutcome(outcome);
  };
  if (notebook.status === "loading") {
    return <Hint className="my-1 block" role="status">Loading your answers…</Hint>;
  }
  if (notebook.status === "error") {
    return (
      <div role="alert" className="my-1 max-w-[720px] rounded-md border border-[var(--surface-destructive-border)] bg-[var(--surface-destructive)] px-2.5 py-2 text-[12px]">
        <span className="text-foreground">Your answers could not be loaded: {notebook.error}</span>
        <PanelButton small className="ml-2" onClick={() => notebook.refetch()}>Try again</PanelButton>
      </div>
    );
  }
  return (
    <div className="my-1 max-w-[720px] overflow-hidden rounded-md border border-border bg-background text-[13px] leading-[1.45] text-foreground">
      {round.intro ? <div className="border-b border-[var(--border-seam)] px-3 py-2 text-[12px] text-muted-foreground">{round.intro}</div> : null}
      {round.questions.map((question, index) => {
        const label = notebook.labels.get(question.id) ?? `Q${index + 1}`;
        const status = notebook.statusOf(question.id);
        return (
          <div key={question.id} className={cn(index > 0 && "border-t border-[var(--border-seam)]")}>
            <QuestionEditor
              notebook={notebook}
              question={question}
              full={false}
              onError={(message) => toast.error(message)}
              header={
                <div className="flex items-baseline gap-2 pt-1.5">
                  <span className="min-w-[26px] text-[12px] tabular-nums text-[var(--subtle-foreground)]">{label}</span>
                  <span className="min-w-0 flex-1 font-medium [overflow-wrap:anywhere]">{question.title}</span>
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
            : pending > 0
              ? `Sends ${pending} answer${pending > 1 ? "s" : ""} from this round.`
              : "Choose or type an answer."}
        </Hint>
        <span className="flex-1" />
        <PanelButton small primary disabled={pending === 0 || notebook.submitting} onClick={() => void submit()}>
          Submit answered ({pending})
        </PanelButton>
      </div>
    </div>
  );
}

export function QuestionsDirective({ attributes, message }: PluginMessageDirectiveProps) {
  const rpc = useRpc<typeof rpcContract>();
  const roundId = typeof attributes.round === "string" ? attributes.round.trim() : "";
  const threadId = message.threadId;
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
  return <NotebookCard threadId={threadId} round={state.round} answers={state.answers} labels={state.labels} />;
}
