// Thread header control: shows how many questions are open and opens the
// Notebook panel. A new round opens the panel once; a reload never does.
import { useEffect, useRef, useState } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../server";
import { Icon } from "@/components/ui/icon";
import { type ChangeSignal, REALTIME_CHANNEL, answerStatus } from "@/lib/model";
import { cn } from "@/lib/utils";
import { requestRound, takeRequestedRound } from "@/lib/panel-navigation";
import { NOTEBOOK_ACTION_ID } from "./InlineRound";

const OPENED_KEY = "bb-questions-opened";

function rememberOpened(threadId: string, roundId: string): boolean {
  try {
    const key = `${OPENED_KEY}:${threadId}`;
    const seen = new Set<string>(JSON.parse(window.sessionStorage.getItem(key) ?? "[]") as string[]);
    if (seen.has(roundId)) return false;
    seen.add(roundId);
    window.sessionStorage.setItem(key, JSON.stringify([...seen].slice(-50)));
    return true;
  } catch {
    return true;
  }
}

export function HeaderControl({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [counts, setCounts] = useState<{ open: number; total: number } | null>(null);
  const mounted = useRef(true);
  const requestSeq = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Always open without params: the host keys the tab by action + params,
  // so params would open a second Questions tab. The round to show travels
  // through panel-navigation instead.
  const open = (roundId?: string) => {
    if (roundId) requestRound(threadId, roundId);
    const opened = navigate.openThreadPanel({ actionId: NOTEBOOK_ACTION_ID, title: "Questions" });
    if (!opened && roundId) takeRequestedRound(threadId);
    return opened;
  };
  /** Reload counts; a stale reply for an earlier thread or request is ignored. */
  const refresh = (openRoundId?: string) => {
    const seq = (requestSeq.current += 1);
    const forThread = threadId;
    rpc.call("questions_state", { threadId: forThread }).then(
      (state) => {
        if (!mounted.current || seq !== requestSeq.current || forThread !== threadId) return;
        const answers = new Map(state.answers.map((item) => [item.questionId, item]));
        let openCount = 0;
        let total = 0;
        for (const round of state.rounds) {
          for (const question of round.questions) {
            total += 1;
            if (answerStatus(answers.get(question.id)) !== "done") openCount += 1;
          }
        }
        setCounts({ open: openCount, total });
        // Only a notebook round opens the panel; inline rounds stay in the thread.
        const created = openRoundId ? state.rounds.find((round) => round.id === openRoundId) : undefined;
        if (created && created.mode === "notebook" && rememberOpened(forThread, created.id)) open(created.id);
      },
      () => {
        if (mounted.current && seq === requestSeq.current) setCounts(null);
      },
    );
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => refresh(), [threadId]);
  useRealtime(REALTIME_CHANNEL, (payload) => {
    const signal = payload as Partial<ChangeSignal> | null;
    if (!signal || signal.threadId !== threadId) return;
    refresh(signal.kind === "round-created" && typeof signal.roundId === "string" ? signal.roundId : undefined);
  });
  if (counts === null || counts.total === 0) return null;
  return (
    <button
      type="button"
      aria-label={`Questions, ${counts.open} open`}
      title={`Questions: ${counts.open} open`}
      className={cn(
        "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent px-2 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-[var(--state-hover)] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        isCompactViewport && "px-1.5",
      )}
      onClick={() => open()}
    >
      <Icon name="MessageQuestion" className="size-3.5" />
      {isCompactViewport ? null : <span>Questions</span>}
      {counts.open > 0 ? <span className="tabular-nums text-[var(--subtle-foreground)]">{counts.open}{isCompactViewport ? "" : " open"}</span> : null}
    </button>
  );
}
