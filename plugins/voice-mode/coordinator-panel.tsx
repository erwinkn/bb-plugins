// Coordinator controls: the Voice page card (open the hidden coordinator,
// pending work, the current question, watched threads, New conversation), the
// native pending-question form, and the settings section for the dedicated
// coordinator provider/model.
import React, { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useBbNavigate, useRealtime, useRpc, type PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { Button } from "./components/ui/button";
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

function useCoordinatorStatus() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("getCoordinatorStatus", null).then(
      (next) => { setStatus(next as Status); setError(null); },
      (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("voice-coordinator", refetch);
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

/** The Voice page card: inspection and recovery for the hidden coordinator. */
export function CoordinatorCard() {
  const { status, error, refetch, rpc } = useCoordinatorStatus();
  const navigate = useBbNavigate();
  const callState = useSyncExternalStore(voiceAgent.subscribe, voiceAgent.getState);
  const bridge = useSyncExternalStore(voiceAgent.subscribe, voiceAgent.getBridgeSnapshot);
  const [busy, setBusy] = useState(false);
  const [showConversations, setShowConversations] = useState(false);
  if (!status || !status.enabled) return null;
  const conversation = status.conversation;
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
  const openQuestion = status.questions.find((question) => question.status === "pending" || question.status === "unresolved");
  const activeRequests = status.requests.filter((request) => request.status !== "settled").slice(0, 6);
  return (
    <section aria-label="Voice coordinator" className="space-y-3 rounded-lg border border-border bg-card px-3.5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 leading-tight">
          <div className="text-sm font-medium text-foreground">Coordinator</div>
          <div className="truncate text-xs text-muted-foreground">
            {conversation
              ? `${conversation.providerId ?? "provider pending"}${conversation.model ? ` · ${conversation.model}` : ""} · ${conversation.currentCallNonce ? "on a call" : conversation.status === "released" ? "released" : "idle"}${bridge?.working ? " · working" : ""}`
              : "No conversation yet. The first call creates one."}
          </div>
          {conversation?.topic ? <div className="truncate text-xs text-muted-foreground">Topic: {conversation.topic}</div> : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {conversation?.coordinatorThreadId ? (
            <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={() => navigate.toThread(conversation.coordinatorThreadId!)}>
              Open coordinator
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            className="min-h-11 sm:min-h-8"
            aria-label="Start a separate conversation with a fresh coordinator. The current one finishes its accepted work."
            onClick={() => {
              if (callState !== "idle") {
                voiceAgent.stopFromSurface();
                voiceAgent.startConversationFresh();
                return;
              }
              void run(() => rpc.call("newConversation", null), "New conversation ready for the next call.");
            }}
          >
            New conversation
          </Button>
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
          <div className="mb-1 text-xs font-medium text-muted-foreground">Needs your decision in the coordinator thread</div>
          {status.pendingInteractions.map((interaction) => (
            <div key={interaction.id} className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 break-words">{interaction.title} <span className="text-xs text-muted-foreground">({interaction.kind})</span></span>
              <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={() => navigate.toThread(interaction.threadId)}>Open</Button>
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
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{status.queuedUpdates === 0 ? "No queued updates" : `${status.queuedUpdates} queued update${status.queuedUpdates === 1 ? "" : "s"} waiting for a quiet moment`}</span>
        {status.conversations.length > 1 ? (
          <button type="button" className="underline-offset-2 hover:underline" onClick={() => setShowConversations((value) => !value)}>
            {showConversations ? "Hide conversations" : `${status.conversations.length} conversations`}
          </button>
        ) : null}
      </div>
      {showConversations ? (
        <ul className="space-y-1 text-xs">
          {status.conversations.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-2">
              <span className="truncate">{row.current ? "Current · " : ""}{new Date(row.updatedAt).toLocaleString()} · {row.status}</span>
              {row.coordinatorThreadId ? <button type="button" className="shrink-0 underline-offset-2 hover:underline" onClick={() => navigate.toThread(row.coordinatorThreadId!)}>Open</button> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {status.watch.length > 0 && conversation ? (
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">Watched threads</div>
          <ul className="flex flex-wrap gap-1.5">
            {status.watch.map((row) => (
              <li key={row.threadId} className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs">
                <button type="button" className="underline-offset-2 hover:underline" onClick={() => navigate.toThread(row.threadId)} title={`Watched because: ${row.reason}`}>{row.threadId}</button>
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

interface CoordinatorConfig {
  enabled: boolean;
  providerId: string;
  model: string | null;
  reasoningLevel: string | null;
  hostId: string | null;
}

const selectClass = "block w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground disabled:opacity-60";

/** Settings: opt-in switch plus the dedicated coordinator machine, provider, and model. */
export function CoordinatorSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [config, setConfig] = useState<CoordinatorConfig | null>(null);
  const [catalog, setCatalog] = useState<{ hosts: { id: string; name: string; connected: boolean }[]; providers: { id: string; displayName: string; available: boolean }[]; models: { providerId: string; id: string; model: string; displayName: string; isDefault: boolean }[] } | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("getConfig", null).then((next) => setConfig(next.coordinator), () => undefined);
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("config-changed", refetch);
  useEffect(() => {
    if (!config) return;
    let cancelled = false;
    rpc.call("listCoordinatorProviders", { hostId: config.hostId }).then(
      (next) => { if (!cancelled) { setCatalog(next); setCatalogError(null); } },
      (cause) => { if (!cancelled) setCatalogError(cause instanceof Error ? cause.message : String(cause)); },
    );
    return () => { cancelled = true; };
  }, [rpc, config?.hostId]);
  const update = async (patch: Partial<CoordinatorConfig>) => {
    setConfig((prev) => (prev ? { ...prev, ...patch } : prev));
    try {
      const next = await rpc.call("setConfig", { coordinator: patch });
      setConfig(next.coordinator);
    } catch (cause) {
      refetch();
      toast.error(`Could not save: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };
  const loading = config === null;
  const providers = catalog?.providers ?? [];
  const models = (catalog?.models ?? []).filter((model) => model.providerId === config?.providerId);
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <label className="flex items-center justify-between gap-3">
          <span>
            <span className="block text-sm font-medium text-foreground">Use the hidden coordinator</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              A hidden BB thread interprets requests and acts through BB's own tools. The voice session keeps no direct way to change threads. Applies to the next call.
            </span>
          </span>
          <input type="checkbox" checked={config?.enabled ?? false} disabled={loading} onChange={(event) => void update({ enabled: event.target.checked })} className="size-4 shrink-0 accent-primary" />
        </label>
      </div>
      <div className="space-y-2 border-t border-border/50 pt-4">
        <span className="block text-sm font-medium text-foreground">Coordinator machine</span>
        <select className={selectClass} disabled={loading} value={config?.hostId ?? ""} onChange={(event) => void update({ hostId: event.target.value || null })}>
          <option value="">Automatic (personal project's default machine)</option>
          {(catalog?.hosts ?? []).map((host) => (
            <option key={host.id} value={host.id}>{host.name}{host.connected ? "" : " (offline)"}</option>
          ))}
        </select>
      </div>
      <div className="space-y-2 border-t border-border/50 pt-4">
        <span className="block text-sm font-medium text-foreground">Coordinator provider and model</span>
        <span className="block text-xs text-muted-foreground">Independent of every project's defaults. The initial supported choice is Codex with its default model; the coordinator does not change while you move between projects.</span>
        {catalogError ? <p role="alert" className="text-xs text-destructive">Could not load the provider catalog: {catalogError}</p> : null}
        <select className={selectClass} disabled={loading || !catalog} value={config?.providerId ?? "codex"} onChange={(event) => void update({ providerId: event.target.value, model: null })}>
          {providers.length === 0 && config ? <option value={config.providerId}>{config.providerId}</option> : null}
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id} disabled={!provider.available}>{provider.displayName}{provider.available ? "" : " (unavailable)"}</option>
          ))}
        </select>
        <select className={selectClass} disabled={loading || !catalog} value={config?.model ?? ""} onChange={(event) => void update({ model: event.target.value || null })}>
          <option value="">Provider default model</option>
          {models.map((model) => (
            <option key={model.id} value={model.model}>{model.displayName}{model.isDefault ? " (default)" : ""}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
