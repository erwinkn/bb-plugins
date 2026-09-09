import React, { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import type { rpcContract } from "./server.ts";
import { conversationWorkSchema, taskViewSchema, watchViewSchema, EMPTY_CONVERSATION_WORK, type ConversationWork } from "./conversation-work.ts";
import { nativeUi } from "./native-ui.ts";
import { Button } from "./components/ui/button";

const statuses = { spawning: "Starting", running: "Running", turn_ended: "Turn ended", failed: "Failed", stopped: "Stopped", unknown: "Unknown" };
export function TasksView({ conversationId, nonce, initialWork = EMPTY_CONVERSATION_WORK }: { conversationId: string; nonce: string | null; initialWork?: ConversationWork }) {
  const rpc = useRpc<typeof rpcContract>();
  const [work, setWork] = useState(initialWork);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    if (inFlight.current || document.visibilityState === "hidden") return;
    const request = ++generation.current;
    inFlight.current = true; setLoading(true);
    try {
      let next: ConversationWork;
      if (nonce) {
        const [tasks, subscriptions] = await Promise.all([
          rpc.call("listLiveTasks", { nonce, conversationId }), rpc.call("listLiveSubscriptions", { nonce, conversationId }),
        ]);
        const taskResult = z.object({ items: z.array(taskViewSchema), asOf: z.number() }).parse(tasks);
        const watchResult = z.object({ items: z.array(watchViewSchema), asOf: z.number() }).parse(subscriptions);
        next = { tasks: taskResult.items, subscriptions: watchResult.items.filter(w => !w.thread_id.startsWith("spawn:")), asOf: Math.min(taskResult.asOf, watchResult.asOf) };
      } else {
        const detail = await rpc.call("getVoiceSession", { sessionId: conversationId });
        next = conversationWorkSchema.parse(detail.work);
      }
      if (request === generation.current) { setWork(next); setError(null); }
    } catch (cause) { if (request === generation.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (request === generation.current) { setLoading(false); inFlight.current = false; } }
  }, [rpc, nonce, conversationId]);
  useEffect(() => {
    mounted.current = true; inFlight.current = false; void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => { mounted.current = false; generation.current++; clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [refresh]);
  useRealtime("aide-log", () => void refresh());
  async function open(threadId: string) {
    // A button click is direct user navigation, independent of a spoken effect or call owner.
    const result = await nativeUi.execute({ kind: "open_thread", threadId, split: false }, () => mounted.current);
    if (mounted.current && result.status !== "succeeded") setError(result.detail);
  }
  return <section aria-label="Conversation tasks" aria-busy={loading} className="min-w-0 space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0"><h3 className="text-sm font-medium">Tasks</h3><p className="text-xs text-muted-foreground">A turn ending does not confirm that the task is complete.</p></div>
      <Button variant="outline" size="sm" disabled={loading} onClick={() => void refresh()}>Refresh tasks</Button>
    </div>
    {error ? <p role="alert" className="break-words text-sm text-destructive">Could not update tasks. {error}</p> : null}
    {!work.tasks.length ? <p className="text-sm text-muted-foreground">No tasks in this conversation.</p> : <ul className="min-w-0 space-y-3">
      {work.tasks.map(task => <li key={task.op_id} className="min-w-0 space-y-2 rounded-lg border border-border bg-card p-3.5">
        <button type="button" disabled={!task.thread_id} onClick={() => task.thread_id && void open(task.thread_id)} aria-label={`Open ${task.title}`} className="block w-full min-w-0 rounded text-left text-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:no-underline [overflow-wrap:anywhere]">{task.title}</button>
        <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{task.kind === "worker" ? "Worker" : "Thread"}</span>{task.profile ? <span className="break-all">{task.profile}</span> : null}
          <span>{statuses[task.status]}</span><time dateTime={new Date(task.updated_at).toISOString()}>Updated {new Date(task.updated_at).toLocaleString()}</time>
        </div>
        {task.last_text ? <pre className="max-h-64 min-w-0 overflow-y-auto whitespace-pre-wrap break-words font-sans text-sm leading-relaxed [overflow-wrap:anywhere]">{task.last_text.slice(-6000)}</pre> : <p className="text-xs text-muted-foreground">No output yet.</p>}
        {task.truncated || (task.last_text?.length ?? 0) > 6000 ? <p className="text-xs text-muted-foreground">Showing the latest output. Open the thread for the full text.</p> : null}
      </li>)}
    </ul>}
    <div className="min-w-0 space-y-2"><h3 className="text-sm font-medium">Subscriptions</h3>
      {!work.subscriptions.length ? <p className="text-sm text-muted-foreground">No subscriptions in this conversation.</p> : <ul className="min-w-0 divide-y divide-border rounded-lg border border-border">
        {work.subscriptions.map(watch => {
          const title = work.tasks.find(task => task.thread_id === watch.thread_id)?.title ?? watch.thread_id;
          return <li key={watch.thread_id} className="flex min-w-0 items-start justify-between gap-3 p-3">
            <button type="button" onClick={() => void open(watch.thread_id)} aria-label={`Open subscription ${title}`} className="min-w-0 rounded text-left text-sm underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring [overflow-wrap:anywhere]">{title}</button>
            <span className="shrink-0 text-xs text-muted-foreground">{watch.state === "active" ? "Active" : "Muted"}</span>
          </li>;
        })}
      </ul>}
    </div>
    {work.asOf ? <p className="text-xs text-muted-foreground">{nonce ? "Last checked" : "Saved state checked"} {new Date(work.asOf).toLocaleTimeString()}</p> : null}
  </section>;
}
