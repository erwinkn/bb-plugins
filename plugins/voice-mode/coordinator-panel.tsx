// Coordinator controls: the session-scoped Coordinator debug view (open the
// hidden coordinator, pending work, the current question, watched threads),
// the native pending-question form, and the settings section for the
// dedicated coordinator provider/model.
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ThreadChat, useRealtime, useRpc, type PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { Button } from "./components/ui/button";
import { viewWorkspace } from "./view-workspace";
import { voiceAgent } from "./voice-agent";
import { cn } from "@/lib/utils";

type Status = Awaited<ReturnType<ReturnType<typeof useRpc<typeof rpcContract>>["call"]>> & {
  enabled: boolean;
  conversation: { id: string; status: string; coordinatorThreadId: string | null; providerId: string | null; model: string | null; hostId: string | null; currentCallNonce: string | null; topic: string | null; discussedThreadId: string | null } | null;
  requests: { id: string; seq: number; status: string; text: string; delivery: string | null; error: string | null; createdAt: number }[];
  questions: { id: string; question: string; options: string[]; allowFreeText: boolean; status: string; createdAt: number }[];
  pendingInteractions: { id: string; threadId: string; title: string; kind: string }[];
  watch: { threadId: string; reason: string; addedAt: number }[];
  queuedUpdates: number;
  recentReplies: { id: string; kind: string; speech: string; delivery: string; createdAt: number; threadIds: string[] }[];
  conversations: { id: string; createdAt: number; updatedAt: number; status: string; coordinatorThreadId: string | null; current: boolean }[];
};

/**
 * Coordinator status for ONE logical session. Scoped by conversation id so the
 * debug view always describes the session being inspected, never the global
 * current conversation. A late result for a previous id is dropped.
 */
function useCoordinatorStatus(conversationId: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const refetch = useCallback(() => {
    const id = ++request.current;
    if (!conversationId) { setStatus(null); return; }
    rpc.call("getCoordinatorStatus", { conversationId }).then(
      (next) => { if (id !== request.current) return; setStatus(next as Status); setError(null); },
      (cause) => { if (id !== request.current) return; setError(cause instanceof Error ? cause.message : String(cause)); },
    );
  }, [rpc, conversationId]);
  useEffect(() => { setStatus(null); refetch(); return () => { request.current += 1; }; }, [refetch]);
  useRealtime("voice-coordinator", (payload) => {
    const changed = (payload as { conversationId?: unknown } | null)?.conversationId;
    if (!conversationId || typeof changed !== "string" || changed === conversationId) refetch();
  });
  useRealtime("config-changed", refetch);
  return { status, error, refetch, rpc };
}

const REQUEST_LABELS: Record<string, string> = {
  recorded: "Recorded",
  dispatching: "Sending",
  accepted: "In progress",
  dispatch_unknown: "Delivery unknown",
  failed: "Failed",
  settled: "Done",
};

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Answer form shared by the Voice page card and the native interaction renderer. */
export function QuestionForm({ question, options, allowFreeText, onSubmit, onCancel, busy }: {
  question: string;
  options: string[];
  allowFreeText: boolean;
  onSubmit: (value: string) => void;
  onCancel?: () => void;
  busy?: boolean;
}) {
  const [text, setText] = useState("");
  return (
    <div className="space-y-2">
      <p className="text-sm text-foreground">{question}</p>
      {options.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {options.map((option) => (
            <Button key={option} type="button" variant="outline" size="sm" disabled={busy} className="min-h-11 sm:min-h-8" onClick={() => onSubmit(option)}>
              {option}
            </Button>
          ))}
        </div>
      ) : null}
      {allowFreeText ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => { event.preventDefault(); if (text.trim()) onSubmit(text.trim()); }}
        >
          <input
            type="text"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Type an answer"
            aria-label="Answer"
            disabled={busy}
            className="min-h-11 min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring sm:min-h-8"
          />
          <Button type="submit" size="sm" disabled={busy || !text.trim()} className="min-h-11 sm:min-h-8">Answer</Button>
          {onCancel ? <Button type="button" variant="ghost" size="sm" disabled={busy} className="min-h-11 sm:min-h-8" onClick={onCancel}>Dismiss</Button> : null}
        </form>
      ) : onCancel ? (
        <Button type="button" variant="ghost" size="sm" disabled={busy} className="min-h-11 sm:min-h-8" onClick={onCancel}>Dismiss</Button>
      ) : null}
    </div>
  );
}

/** Host-rendered form for a `voice-question` pending interaction on the coordinator thread. */
export function VoiceQuestionInteraction({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const payload = (interaction.payload ?? {}) as { question?: string; options?: string[]; allowFreeText?: boolean };
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-2 rounded-md border border-border bg-card p-3">
      <div className="text-xs font-medium text-muted-foreground">Voice Mode question</div>
      <QuestionForm
        question={payload.question ?? interaction.title}
        options={Array.isArray(payload.options) ? payload.options : []}
        allowFreeText={payload.allowFreeText !== false}
        busy={busy}
        onSubmit={(value) => { setBusy(true); void submit(value).finally(() => setBusy(false)); }}
        onCancel={() => { setBusy(true); void cancel().finally(() => setBusy(false)); }}
      />
    </div>
  );
}

/**
 * The session-scoped Coordinator debug view: the hidden coordinator behind ONE
 * logical session, labelled for debugging. It never opens anything by itself.
 */
export function CoordinatorCard({ conversationId, legacy = false }: { conversationId: string | null; legacy?: boolean }) {
  const { status, error, refetch, rpc } = useCoordinatorStatus(conversationId);
  const bridge = useSyncExternalStore(voiceAgent.subscribe, voiceAgent.getBridgeSnapshot);
  const [busy, setBusy] = useState(false);
  if (!conversationId || legacy) {
    return (
      <section aria-label="Voice coordinator" className="rounded-lg border border-border bg-card px-3.5 py-3 text-sm text-muted-foreground">
        This session was recorded as a single call before coordinator mode. It has no coordinator thread.
      </section>
    );
  }
  if (error && !status) {
    return (
      <section aria-label="Voice coordinator" className="space-y-2 rounded-lg border border-destructive/30 bg-card px-3.5 py-3 text-sm">
        <p role="alert" className="text-destructive">Could not load the coordinator. {error}</p>
        <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={refetch}>Retry</Button>
      </section>
    );
  }
  if (!status) return <p role="status" className="py-3 text-center text-sm text-muted-foreground">Loading coordinator…</p>;
  const conversation = status.conversation;
  const working = bridge?.conversationId === conversationId && bridge.working;
  const run = async (action: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    try {
      await action();
      if (success) toast.success(success);
      refetch();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const inspect = (threadId: string) => void run(async () => {
    const { views, preference } = await rpc.call("resolveThreadViews", { threadIds: [threadId] });
    viewWorkspace.open(views, "auto", preference);
  });
  const openQuestion = status.questions.find((question) => question.status === "pending" || question.status === "unresolved");
  const activeRequests = status.requests.filter((request) => request.status !== "settled").slice(0, 6);
  return (
    <section aria-label="Voice coordinator" className="space-y-3 rounded-lg border border-border bg-card px-3.5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 leading-tight">
          <div className="text-sm font-medium text-foreground">Coordinator <span className="text-xs font-normal text-muted-foreground">debug view for this session</span></div>
          <div className="truncate text-xs text-muted-foreground">
            {conversation
              ? `${conversation.providerId ?? "provider pending"}${conversation.model ? ` · ${conversation.model}` : ""} · ${conversation.currentCallNonce ? "on a call" : conversation.status === "released" ? "runtime released" : "idle"}${working ? " · working" : ""}`
              : status.enabled ? "No coordinator thread yet. The next call on this session creates one." : "Coordinator mode is off; this session recorded no coordinator."}
          </div>
          {conversation?.topic ? <div className="truncate text-xs text-muted-foreground">Topic: {conversation.topic}</div> : null}
        </div>

      </div>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      {openQuestion ? (
        <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
          <div className="mb-1 text-xs font-medium text-muted-foreground">{openQuestion.status === "unresolved" ? "Unanswered question from an earlier call" : "The coordinator is waiting for your answer"}</div>
          <QuestionForm
            question={openQuestion.question}
            options={openQuestion.options}
            allowFreeText={openQuestion.allowFreeText}
            busy={busy}
            onSubmit={(value) => void run(() => rpc.call("answerQuestion", { questionId: openQuestion.id, value }), "Answer delivered.")}
          />
        </div>
      ) : null}
      {status.pendingInteractions.length > 0 ? (
        <div className="rounded-md border border-destructive/30 p-3 text-sm">
          <div className="mb-1 text-xs font-medium text-muted-foreground">Needs your decision. Open here to answer.</div>
          {status.pendingInteractions.map((interaction) => (
            <div key={interaction.id} className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 break-words">{interaction.title} <span className="text-xs text-muted-foreground">({interaction.kind})</span></span>
              <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={() => inspect(interaction.threadId)}>Open</Button>
            </div>
          ))}
        </div>
      ) : null}
      {activeRequests.length > 0 ? (
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">Pending work</div>
          <ul className="space-y-1">
            {activeRequests.map((request) => (
              <li key={request.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate" title={request.text}>{request.text}</span>
                <span className={cn("shrink-0 text-xs", request.status === "failed" || request.status === "dispatch_unknown" ? "text-destructive" : "text-muted-foreground")}>
                  {REQUEST_LABELS[request.status] ?? request.status}{request.delivery === "queued" ? " (queued)" : ""} · {fmtTime(request.createdAt)}
                </span>
                {request.status === "failed" || request.status === "dispatch_unknown" ? (
                  <Button type="button" variant="outline" size="sm" disabled={busy} className="min-h-11 sm:min-h-8" onClick={() => void run(() => rpc.call("retryRequest", { requestId: request.id }))}>Retry</Button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="text-xs text-muted-foreground">
        {status.queuedUpdates === 0 ? "No queued updates" : `${status.queuedUpdates} queued update${status.queuedUpdates === 1 ? "" : "s"} waiting for a quiet moment`}
      </div>
      {status.watch.length > 0 && conversation ? (
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">Watched threads</div>
          <ul className="flex flex-wrap gap-1.5">
            {status.watch.map((row) => (
              <li key={row.threadId} className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs">
                <button type="button" className="underline-offset-2 hover:underline" onClick={() => inspect(row.threadId)} title={`Watched because: ${row.reason}`}>{row.threadId}</button>
                <button
                  type="button"
                  aria-label={`Stop watching ${row.threadId}`}
                  className="text-muted-foreground hover:text-foreground"
                  disabled={busy}
                  onClick={() => void run(() => rpc.call("setWatch", { conversationId: conversation.id, threadId: row.threadId, watched: false }))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {conversation?.coordinatorThreadId ? (
        <div className="h-[65vh] min-h-80 overflow-hidden rounded-md border border-border" aria-label="Coordinator thread">
          <ThreadChat threadId={conversation.coordinatorThreadId} />
        </div>
      ) : null}
      {status.recentReplies.length > 0 ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Recent replies</summary>
          <ul className="mt-1 space-y-1">
            {status.recentReplies.slice().reverse().map((reply) => (
              <li key={reply.id} className="break-words"><span className="font-medium">{reply.kind}</span> · {reply.delivery} · {reply.speech || "(silent)"}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

type CoordinatorConfig = import("./coordinator/manager.ts").CoordinatorConfig;
type Catalog = {providers:{id:string;displayName:string;available:boolean;serviceTiers:{id:string;label:string}[]}[];models:{providerId:string;id:string;model:string;displayName:string;isDefault:boolean;reasoningLevels:{id:string;label:string}[];defaultReasoningLevel:string|null}[]};
const selectClass = "block w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground disabled:opacity-60";

export function CoordinatorSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [config,setConfig] = useState<CoordinatorConfig|null>(null);
  const [catalog,setCatalog] = useState<Catalog|null>(null);
  const [error,setError] = useState<string|null>(null);
  const [busy,setBusy] = useState(false);
  const revision = useRef(0);
  const refresh = useCallback(() => {
    const request = ++revision.current;
    Promise.all([rpc.call("getConfig",null),rpc.call("listCoordinatorProviders",null)]).then(([value,options]) => {
      if (request !== revision.current) return;
      setConfig(value.coordinator);setCatalog(options);setError(null);
    },cause=>{if(request === revision.current)setError(String(cause));});
  },[rpc]);
  useEffect(()=>{refresh();return()=>{revision.current++;};},[refresh]);
  useRealtime("config-changed",refresh);
  const update = async(patch:Partial<CoordinatorConfig>)=>{
    setBusy(true);
    try {const value=await rpc.call("setConfig",{coordinator:patch});setConfig(value.coordinator);setError(null);}
    catch(cause){setError(cause instanceof Error ? cause.message : String(cause));}
    finally{setBusy(false);}
  };
  const models=catalog?.models.filter(model=>model.providerId === config?.providerId) ?? [];
  const model=config?.model ? models.find(model=>model.model === config.model || model.id === config.model) : models.find(model=>model.isDefault) ?? models[0];
  const provider=catalog?.providers.find(provider=>provider.id === config?.providerId);
  const disabled=!config || !catalog || busy;
  return <div className="space-y-4">
    <p className="text-xs text-muted-foreground">Every voice session uses a coordinator. These choices apply to new sessions; existing sessions keep their coordinator.</p>
    {error ? <div role="alert" className="text-sm text-destructive">{error}<Button variant="outline" onClick={refresh}>Retry coordinator settings</Button></div> : null}
    <label className="block space-y-1 text-sm">Coordinator provider
      <select aria-label="Coordinator provider" className={selectClass} disabled={disabled} value={config?.providerId ?? ""} onChange={event=>void update({providerId:event.target.value,model:null,reasoningLevel:null,serviceTier:"default"})}>
        {!provider && config ? <option value={config.providerId}>{config.providerId} (unavailable)</option> : null}
        {catalog?.providers.map(provider=><option key={provider.id} value={provider.id} disabled={!provider.available}>{provider.displayName}{provider.available ? "" : " (unavailable)"}</option>)}
      </select>
    </label>
    <label className="block space-y-1 text-sm">Coordinator model
      <select aria-label="Coordinator model" className={selectClass} disabled={disabled} value={config?.model ?? ""} onChange={event=>void update({model:event.target.value || null,reasoningLevel:null})}>
        <option value="">Provider default model</option>
        {config?.model && !model ? <option value={config.model}>{config.model} (unavailable)</option> : null}
        {models.map(model=><option key={model.id} value={model.model}>{model.displayName}</option>)}
      </select>
    </label>
    {model && model.reasoningLevels.length>0 ? <label className="block space-y-1 text-sm">Reasoning effort
      <select aria-label="Coordinator reasoning effort" className={selectClass} disabled={disabled} value={config?.reasoningLevel ?? ""} onChange={event=>void update({reasoningLevel:event.target.value || null})}>
        <option value="">Model default{model.defaultReasoningLevel ? ` (${model.defaultReasoningLevel})` : ""}</option>
        {config?.reasoningLevel && !model.reasoningLevels.some(level=>level.id === config.reasoningLevel) ? <option value={config.reasoningLevel}>{config.reasoningLevel} (unsupported)</option> : null}
        {model.reasoningLevels.map(level=><option key={level.id} value={level.id}>{level.label}</option>)}
      </select>
    </label> : null}
    {provider?.serviceTiers.some(tier=>tier.id === "fast") ? <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" aria-label="Coordinator fast service" disabled={disabled} checked={config?.serviceTier === "fast"} onChange={event=>void update({serviceTier:event.target.checked ? "fast" : "default"})}/>Fast service
    </label> : null}
  </div>;
}
