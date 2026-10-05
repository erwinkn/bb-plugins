// Thread header control: while a round's native prompt is open, shows how
// many of its questions still need an answer and opens the Questions panel.
// Submitting, cancelling, or stopping the prompt removes the entry. A new
// round opens the panel once; a reload never does.
import { useCallback, useEffect, useRef, useState } from "react";
import { useBbNavigate, useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../server";
import { Icon } from "@/components/ui/icon";
import { ATTENTION_TINT } from "./primitives";
import { type ChangeSignal, type HeaderState, REALTIME_CHANNEL } from "@/lib/model";
import { cn } from "@/lib/utils";
import { requestRound, takeRequestedRound } from "@/lib/panel-navigation";
import { QUESTIONS_ACTION_ID } from "./InlineRound";

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
  const [header, setHeader] = useState<HeaderState | null>(null);
  const currentThread = useRef(threadId);
  currentThread.current = threadId;
  const reader = useRef<{
    threadId: string;
    refresh: () => void;
    signal: (signal: Partial<ChangeSignal>) => void;
  } | null>(null);
  // Always open without params: the host keys the tab by action + params,
  // so params would open a second Questions tab. The round to show travels
  // through panel-navigation instead.
  const open = useCallback((roundId?: string) => {
    if (roundId) requestRound(threadId, roundId);
    const opened = navigate.openThreadPanel({ actionId: QUESTIONS_ACTION_ID, title: "Questions" });
    if (!opened && roundId) takeRequestedRound(threadId);
    return opened;
  }, [navigate, threadId]);
  useEffect(() => {
    // Each effect owns a generation. Cleanup invalidates even a reply for a
    // thread we have since left and returned to, without touching its RPC.
    let active = true;
    let inFlight = false;
    let invalidated = false;
    let createdRoundId: string | undefined;
    const refresh = () => {
      if (!active) return;
      if (inFlight) { invalidated = true; return; }
      inFlight = true;
      void read();
    };
    const read = async () => {
      try {
        const state = await rpc.call("questions_header", { threadId });
        // A signal received during the read requires one trailing refresh.
        // Its earlier snapshot must not briefly reopen a closed prompt.
        if (!active || currentThread.current !== threadId || state.threadId !== threadId || invalidated) return;
        setHeader(state);
        const round = state.round;
        if (round && round.id === createdRoundId) {
          createdRoundId = undefined;
          if (round.mode === "panel" && rememberOpened(threadId, round.id)) open(round.id);
        }
      } catch {
        // Keep successful counts. A later signal or reconnect can refresh;
        // there is no automatic retry after a failed read.
      } finally {
        inFlight = false;
        if (active && invalidated) { invalidated = false; refresh(); }
      }
    };
    const currentReader = {
      threadId,
      refresh,
      signal: (signal: Partial<ChangeSignal>) => {
        if (signal.kind === "round-created" && typeof signal.roundId === "string") createdRoundId = signal.roundId;
        if (signal.kind === "prompt-closed" && signal.roundId === createdRoundId) createdRoundId = undefined;
        refresh();
      },
    };
    reader.current = currentReader;
    setHeader(null);
    refresh();
    return () => {
      active = false;
      if (reader.current === currentReader) reader.current = null;
    };
  }, [threadId, rpc, open]);
  useRealtime(REALTIME_CHANNEL, (payload) => {
    const signal = payload as Partial<ChangeSignal> | null;
    if (!signal || signal.threadId !== threadId || reader.current?.threadId !== threadId) return;
    if (!signal.kind || !["round-created", "answers", "submission", "prompt-opened", "prompt-closed"].includes(signal.kind)) return;
    reader.current.signal(signal);
  });
  const connection = useRealtimeConnectionState();
  const seenConnection = useRef(connection);
  useEffect(() => {
    if (connection === "connected" && seenConnection.current === "reconnecting" && reader.current?.threadId === threadId) reader.current.refresh();
    seenConnection.current = connection;
  }, [connection, threadId]);
  const counts = header?.threadId === threadId ? header.round : null;
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
      <Icon name="MessageQuestion" className="size-3.5" style={{ color: ATTENTION_TINT }} aria-hidden />
      {isCompactViewport ? null : <span>Questions</span>}
      {counts.open > 0 ? <span className="tabular-nums text-[var(--subtle-foreground)]">{counts.open}{isCompactViewport ? "" : " open"}</span> : null}
    </button>
  );
}
