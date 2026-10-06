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

type HeaderRpc = ReturnType<typeof useRpc<typeof rpcContract>>;
/**
 * Header controls mounting together for one thread (a switch can mount more
 * than one) share their first read, for a moment only. A change signal for
 * the thread ends the sharing: later reads must start after the change.
 */
const MOUNT_SHARE_MS = 1000;
const mountReads = new Map<string, { read: Promise<HeaderState>; at: number }>();
function readOnMount(rpc: HeaderRpc, threadId: string): Promise<HeaderState> {
  const shared = mountReads.get(threadId);
  if (shared && Date.now() - shared.at < MOUNT_SHARE_MS) return shared.read;
  const entry = { read: rpc.call("questions_header", { threadId }), at: Date.now() };
  mountReads.set(threadId, entry);
  void entry.read.finally(() => { if (mountReads.get(threadId) === entry) mountReads.delete(threadId); }).catch(() => {});
  return entry.read;
}

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
  // The read effect follows the thread only: a renewed RPC client or
  // navigate callback must not read the header again.
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
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
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    // Each effect owns a generation. Cleanup invalidates even a reply for a
    // thread we have since left and returned to, without touching its RPC.
    let active = true;
    let inFlight = false;
    let invalidated = false;
    let createdRoundId: string | undefined;
    let mounting = true;
    const refresh = () => {
      if (!active) return;
      if (inFlight) { invalidated = true; return; }
      inFlight = true;
      const shared = mounting;
      mounting = false;
      void read(shared);
    };
    const read = async (shared: boolean) => {
      try {
        const state = shared
          ? await readOnMount(rpcRef.current, threadId)
          : await rpcRef.current.call("questions_header", { threadId });
        // A signal received during the read requires one trailing refresh.
        // Its earlier snapshot must not briefly reopen a closed prompt.
        if (!active || currentThread.current !== threadId || state.threadId !== threadId || invalidated) return;
        setHeader(state);
        const round = state.round;
        if (round && round.id === createdRoundId) {
          createdRoundId = undefined;
          if (round.mode === "panel" && rememberOpened(threadId, round.id)) openRef.current(round.id);
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
  }, [threadId]);
  useRealtime(REALTIME_CHANNEL, (payload) => {
    const signal = payload as Partial<ChangeSignal> | null;
    if (typeof signal?.threadId === "string") mountReads.delete(signal.threadId);
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
