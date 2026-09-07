// The Questions side panel: one tab per round plus a global Summary, and one
// Submit answered (N) button that sends every changed answer across rounds.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import type { PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  type Question,
  type Round,
  type Submission,
  actionableFailures,
  answerText,
  hasContent,
} from "@/lib/model";
import { type QuestionsController, type SubmitOutcome, useQuestions } from "@/hooks/useQuestions";
import { subscribeRequestedRound, takeRequestedRound } from "@/lib/panel-navigation";
import { Hint, IconButton, PanelButton } from "./primitives";
import { QuestionEditor } from "./QuestionEditor";

type Tab = { kind: "round"; roundId: string } | { kind: "summary" };

function timeOf(timestamp: number | null): string {
  if (timestamp === null) return "";
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function statusText(controller: QuestionsController, questionId: string): string {
  const status = controller.statusOf(questionId);
  const state = controller.answers.get(questionId);
  if (status === "done") return `Submitted at ${timeOf(state?.submittedAt ?? null)}`;
  if (status === "draft") return state?.submitted ? "changed since submit" : "draft";
  return "";
}

/** Status glyph and clear button; width is reserved so answering never shifts the row. */
function TitleControls({ controller, questionId, label }: { controller: QuestionsController; questionId: string; label: string }) {
  const has = hasContent(controller.draftOf(questionId));
  const status = controller.statusOf(questionId);
  const text = statusText(controller, questionId);
  return (
    <span className={cn("inline-flex h-5 w-[42px] shrink-0 items-center gap-1 self-start", !has && "invisible")} data-controls={questionId}>
      <span role="img" aria-label={text || "Unanswered"} className="w-[18px] text-center text-[12px] text-[var(--subtle-foreground)]">
        {status === "done" ? "✓" : "•"}
      </span>
      <IconButton icon="X" label={`Clear answer to ${label}`} size={20} disabled={!has} tabIndex={has ? 0 : -1} onClick={() => controller.clear(questionId)} />
    </span>
  );
}

function RoundView({ controller, round, onJump, onError }: { controller: QuestionsController; round: Round; onJump: (id: string) => void; onError: (message: string) => void }) {
  const groups = useMemo(() => {
    const ordered: { title: string | null; questions: Question[] }[] = [];
    for (const question of round.questions) {
      const last = ordered[ordered.length - 1];
      if (last && last.title === question.group) last.questions.push(question);
      else ordered.push({ title: question.group, questions: [question] });
    }
    return ordered;
  }, [round]);
  let first = true;
  return (
    <div>
      {round.intro ? (
        <div className="mx-3 mb-1.5 mt-2.5 border-l-2 border-[var(--input)] pl-2.5 text-[12px] text-muted-foreground">{round.intro}</div>
      ) : null}
      {groups.map((group, groupIndex) => (
        <div key={`${group.title ?? ""}-${groupIndex}`}>
          {group.title ? (
            <h3 className="mx-3 mt-3 flex h-6 items-center text-[12px] font-medium text-[var(--subtle-foreground)]">{group.title}</h3>
          ) : null}
          {group.questions.map((question) => {
            const label = controller.labels.get(question.id) ?? question.id;
            const border = !first && !group.title;
            first = false;
            return (
              <div key={question.id} className={cn("pb-0.5 pt-1", border ? "border-t border-[var(--border-seam)]" : "")} data-q={question.id}>
                <div className="flex items-baseline gap-2 px-3 pt-1.5">
                  <span className="min-w-[26px] text-[12px] tabular-nums text-[var(--subtle-foreground)]">{label}</span>
                  <span className="min-w-0 flex-1 text-[13px] font-medium [overflow-wrap:anywhere]">{question.title}</span>
                  <TitleControls controller={controller} questionId={question.id} label={label} />
                </div>
                <QuestionEditor controller={controller} question={question} full onJump={onJump} onError={onError} />
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function SummaryView({ controller, onJump }: { controller: QuestionsController; onJump: (id: string) => void }) {
  const items: { round: Round; question: Question }[] = [];
  for (const round of controller.rounds) for (const question of round.questions) items.push({ round, question });
  const decided = items.filter((item) => controller.statusOf(item.question.id) === "done");
  const open = items.filter((item) => controller.statusOf(item.question.id) !== "done");
  const render = (item: { round: Round; question: Question }, draftLabel: boolean) => {
    const label = controller.labels.get(item.question.id) ?? item.question.id;
    const draft = controller.draftOf(item.question.id);
    const text = hasContent(draft) ? answerText(item.question, draft) : "";
    return (
      <div key={item.question.id} className="flex items-start gap-2 rounded-md border-t border-[var(--border-seam)] px-2 py-1.5 hover:bg-[var(--state-hover)]">
        <span className="min-w-[26px] pt-px text-[12px] tabular-nums text-[var(--subtle-foreground)]">{label}</span>
        <div className="min-w-0 flex-1">
          <button type="button" className="cursor-pointer rounded-sm border-0 bg-transparent p-0 text-left text-[13px] font-medium text-foreground hover:underline hover:underline-offset-2" onClick={() => onJump(item.question.id)}>
            {item.question.title}
          </button>
          <div className="text-[12px] text-[var(--subtle-foreground)]">
            Round {item.round.number}
            {text ? ` · ${draftLabel ? "draft: " : ""}${text}` : ""}
            {draft.confidence ? ` · confidence ${draft.confidence}` : ""}
          </div>
        </div>
      </div>
    );
  };
  return (
    <div className="flex flex-col gap-3.5 p-3">
      {controller.summary ? (
        <div className="border-l-2 border-[var(--input)] px-2.5 py-0.5 text-[13px] text-muted-foreground">
          <div className="mb-0.5 text-[12px] text-[var(--subtle-foreground)]">Agent summary · {timeOf(controller.summary.updatedAt)}</div>
          <Markdown content={controller.summary.markdown} />
        </div>
      ) : (
        <Hint>The agent has not written a summary yet.</Hint>
      )}
      <div>
        <h4 className="mb-1 text-[12px] font-medium text-[var(--subtle-foreground)]">Submitted · {decided.length}</h4>
        <div className="flex flex-col">{decided.length > 0 ? decided.map((item) => render(item, false)) : <Hint>Nothing submitted yet.</Hint>}</div>
      </div>
      <div>
        <h4 className="mb-1 text-[12px] font-medium text-[var(--subtle-foreground)]">Open · {open.length}</h4>
        <div className="flex flex-col">{open.length > 0 ? open.map((item) => render(item, true)) : <Hint>Everything is answered.</Hint>}</div>
      </div>
    </div>
  );
}

function SubmissionNotice({ controller, submission }: { controller: QuestionsController; submission: Submission }) {
  const [busy, setBusy] = useState(false);
  const labels = submission.questionIds.map((id) => controller.labels.get(id) ?? id).join(", ");
  const retry = async () => {
    setBusy(true);
    const outcome = await controller.retry(submission.id);
    setBusy(false);
    reportOutcome(outcome);
  };
  return (
    <div role="alert" className="mx-3 mt-2.5 rounded-md border border-[var(--surface-destructive-border)] bg-[var(--surface-destructive)] px-2.5 py-2 text-[12px] text-foreground">
      <div className="font-medium">
        {submission.state === "failed" ? `Sending ${labels} failed.` : `Delivery of ${labels} is uncertain.`}
      </div>
      <div className="mt-0.5 text-muted-foreground">
        {submission.state === "failed"
          ? `The server refused the message: ${submission.error ?? "unknown error"}. Your answers are kept as drafts.`
          : `The server did not confirm delivery${submission.error ? ` (${submission.error})` : ""}. Your answers are kept as drafts. Look in the thread for a user message mentioning submission ${submission.id.slice(0, 8)} before you retry; a retry sends the same frozen answers again and can duplicate them.`}
      </div>
      <div className="mt-1.5 flex gap-1.5">
        <PanelButton small disabled={busy || controller.submitting} onClick={() => void retry()}>
          Retry this submission
        </PanelButton>
      </div>
    </div>
  );
}

export function reportOutcome(outcome: SubmitOutcome) {
  switch (outcome.kind) {
    case "submitted": {
      const submission = outcome.submission;
      if (submission.state === "sent") toast.success(`Sent ${submission.questionIds.length} answer${submission.questionIds.length > 1 ? "s" : ""}.`);
      else if (submission.state === "queued") toast.success("Answers queued; the agent receives them after its current turn.");
      else if (submission.state === "failed") toast.error(`Sending failed: ${submission.error ?? "unknown error"}. Your drafts are kept.`);
      else toast.warning("Delivery is uncertain. Check the thread before you retry.");
      return;
    }
    case "conflict":
      toast.error(`${outcome.labels.join(", ")} changed in another window. Review and submit again.`);
      return;
    case "in-flight":
      toast.error(`${outcome.labels.join(", ")} are still being sent. Wait a moment.`);
      return;
    case "nothing":
      toast("No draft answers to send yet.");
      return;
    case "error":
      toast.error(outcome.message);
  }
}

export function QuestionsPanel({ threadId, params }: PluginThreadPanelProps) {
  const controller = useQuestions(threadId);
  // `params.roundId` only comes from tabs persisted by an earlier version;
  // new opens carry the round through panel-navigation instead.
  const requested = params && typeof params === "object" && !Array.isArray(params) && typeof params.roundId === "string" ? params.roundId : null;
  const [tab, setTab] = useState<Tab | null>(requested ? { kind: "round", roundId: requested } : null);
  const [wanted, setWanted] = useState<string | null>(null);
  const knownRounds = useRef<Set<string> | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Default to the newest round; switch to a round that arrives while open.
  useEffect(() => {
    if (controller.status !== "ready") return;
    const ids = new Set(controller.rounds.map((round) => round.id));
    const latest = controller.rounds[controller.rounds.length - 1];
    if (knownRounds.current === null) {
      knownRounds.current = ids;
      if (tab === null && latest) setTab({ kind: "round", roundId: latest.id });
      return;
    }
    const fresh = controller.rounds.filter((round) => !knownRounds.current?.has(round.id));
    knownRounds.current = ids;
    const newest = fresh[fresh.length - 1];
    if (newest) setTab({ kind: "round", roundId: newest.id });
  }, [controller.rounds, controller.status, tab]);

  // A round requested by the header or a message card, whether the request
  // arrived before this tab mounted or while it was already open. Declared
  // after the default-tab effect so its setTab is applied last and wins.
  useEffect(() => {
    const take = () => {
      const roundId = takeRequestedRound(threadId);
      if (roundId !== null) setWanted(roundId);
    };
    const unsubscribe = subscribeRequestedRound(threadId, take);
    take();
    return unsubscribe;
  }, [threadId]);
  useEffect(() => {
    if (wanted === null || controller.status !== "ready") return;
    // A round the panel does not know yet may arrive with the next refresh
    // (the card can render before this panel's state loads); keep waiting.
    if (!controller.rounds.some((round) => round.id === wanted)) return;
    setTab({ kind: "round", roundId: wanted });
    setWanted(null);
  }, [controller.rounds, controller.status, wanted]);

  const notices = controller.notices;
  useEffect(() => {
    for (const notice of notices) {
      toast.warning(notice.text);
      controller.dismissNotice(notice.id);
    }
    // Each notice is shown once; dismissing mutates the store, not React state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notices]);

  const jump = useCallback(
    (questionId: string) => {
      const round = controller.rounds.find((item) => item.questions.some((question) => question.id === questionId));
      if (!round) return;
      setTab({ kind: "round", roundId: round.id });
      requestAnimationFrame(() => {
        const element = bodyRef.current?.querySelector<HTMLElement>(`[data-q="${questionId}"]`);
        element?.scrollIntoView({ block: "nearest" });
        element?.querySelector<HTMLElement>("input, textarea, button")?.focus({ preventScroll: true });
      });
    },
    [controller.rounds],
  );

  const activeRound = tab?.kind === "round" ? controller.rounds.find((round) => round.id === tab.roundId) ?? null : null;
  const openCount = controller.rounds.reduce((count, round) => count + round.questions.filter((question) => controller.statusOf(question.id) !== "done").length, 0);
  const pending = controller.pendingIds.length;

  const onSubmit = async () => {
    const outcome = await controller.submit();
    reportOutcome(outcome);
  };

  return (
    <div className="@container flex h-full min-h-0 flex-col bg-background text-[13px] leading-[1.45] text-foreground">
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border pl-2 pr-1.5">
        <div role="tablist" aria-label="Rounds" className="flex h-full min-w-0 items-center gap-0.5 overflow-x-auto">
          {controller.rounds.map((round) => {
            const done = round.questions.filter((question) => controller.statusOf(question.id) === "done").length;
            const selected = tab?.kind === "round" && tab.roundId === round.id;
            return (
              <button
                key={round.id}
                type="button"
                role="tab"
                aria-selected={selected}
                className={cn(
                  "inline-flex h-[26px] shrink-0 cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent px-2 text-[12px] font-medium text-[var(--subtle-foreground)] hover:bg-[var(--state-hover)] hover:text-foreground",
                  selected && "bg-[var(--state-active)] text-foreground",
                )}
                onClick={() => setTab({ kind: "round", roundId: round.id })}
              >
                Round {round.number}
                <span className="font-normal tabular-nums text-[var(--subtle-foreground)]">
                  {done}/{round.questions.length}
                </span>
              </button>
            );
          })}
          <button
            type="button"
            role="tab"
            aria-selected={tab?.kind === "summary"}
            className={cn(
              "inline-flex h-[26px] shrink-0 cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent px-2 text-[12px] font-medium text-[var(--subtle-foreground)] hover:bg-[var(--state-hover)] hover:text-foreground",
              tab?.kind === "summary" && "bg-[var(--state-active)] text-foreground",
            )}
            onClick={() => setTab({ kind: "summary" })}
          >
            Summary
            <span className="font-normal tabular-nums text-[var(--subtle-foreground)]">{openCount} open</span>
          </button>
        </div>
      </div>
      <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col overflow-auto">
        {actionableFailures(controller.submissions).map((submission) => (
          <SubmissionNotice key={submission.id} controller={controller} submission={submission} />
        ))}
        {controller.status === "loading" ? (
          <div role="status" className="p-3 text-[12px] text-[var(--subtle-foreground)]">Loading questions…</div>
        ) : controller.status === "error" ? (
          <div role="alert" className="p-3 text-[12px] text-[var(--destructive-text)]">{controller.error}</div>
        ) : controller.rounds.length === 0 ? (
          <div role="status" className="p-3 text-[12px] text-[var(--subtle-foreground)]">
            No questions yet. When the agent calls <code>questions_ask</code>, the round appears here.
          </div>
        ) : tab?.kind === "summary" ? (
          <SummaryView controller={controller} onJump={jump} />
        ) : activeRound ? (
          <RoundView controller={controller} round={activeRound} onJump={jump} onError={(message) => toast.error(message)} />
        ) : null}
      </div>
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-t border-border py-1.5 pl-3 pr-2">
        <Hint>
          {pending > 0 ? `Sends ${pending} draft answer${pending > 1 ? "s" : ""} across all rounds.` : "No draft answers to send."}
        </Hint>
        <Hint>
          {controller.saving
            ? "Saving draft…"
            : controller.backupMode === "browser"
              ? "Drafts are saved on the server."
              : "Drafts are saved on the server. This browser cannot keep an offline copy."}
        </Hint>
        <span className="flex-1" />
        <PanelButton small primary disabled={pending === 0 || controller.submitting} aria-label="Submit every draft or changed answer in every round" onClick={() => void onSubmit()}>
          Submit answered ({pending})
        </PanelButton>
      </div>
    </div>
  );
}
