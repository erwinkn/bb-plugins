import { COORDINATOR_TITLE_PREFIX } from "./coordinator/prompts.ts";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { UserRequestEnvelope } from "./coordinator/envelopes.ts";
import { operationsOf, quickActionSchema, quickActionRefusal, QUICK_ACTION_TIMEOUT_MS, waitForQuickAction, type LiveOperation, type QuickAction } from "./quick-actions.ts";
import { LiveActionStore, type ActionResult } from "./live-action-store.ts";
import { readWorkerSettings, resolveWorkerModel, WORKER_ROLE_INSTRUCTIONS } from "./worker-profiles.ts";
import type { UiAction, UiActionResult } from "./ui-actions.ts";

type Thread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;
export interface ActionContext {
  signal: AbortSignal;
  current(): boolean;
  ui(action: UiAction, signal: AbortSignal): Promise<UiActionResult>;
  /** A late SDK result is recorded but must never trigger an automatic retry. */
  lateResult?(result: ActionResult): void;
}
interface Hooks {
  coordinatorParent(conversationId:string):Promise<string>;
  watch(conversationId: string, threadId: string): void;
  isCoordinator(thread: Thread): boolean;
}
interface Prepared {
  commit(): Promise<ActionResult>;
  cancel?(): void;
}
const label = (value: string, max = 120) => {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const result = (status: ActionResult["status"], speech: string, detail = speech, threadIds: string[] = [], receipts: ActionResult["receipts"] = []): ActionResult => ({status,speech,detail:detail.length>16000 ? `${detail.slice(0,16000)}\n[detail truncated; original request retained]` : detail,threadIds,receipts});
export function combineResults(results: ActionResult[]): ActionResult {
  const status = results.some(r => r.status === "unknown") ? "unknown" : results.some(r => r.status === "failed") ? "failed" : results.some(r => r.status === "cancelled") ? "cancelled" : "succeeded";
  return {status,speech:results.map(r=>r.speech).filter(Boolean).join(" "),detail:results.map(r=>r.detail).join("\n\n").slice(0,32000),threadIds:[...new Set(results.flatMap(r=>r.threadIds))],receipts:results.flatMap(r=>r.receipts)};
}

/** User text, interpretation, and application provenance remain separate all the way to the worker. */
export function formatVoiceInstruction(envelope: UserRequestEnvelope, operation: LiveOperation, actor: "live"|"coordinator", step: number): string {
  const purpose = operation.kind === "send_message" ? operation.purpose : "instruction";
  const contract = purpose === "status" ? "Answer the user's status question; do not start implementation for this status request."
    : purpose === "comment" ? "This is a user comment. Preserve its questions and conditions; it is not a blanket instruction to change state."
    : "Carry out the user's requested scope under your existing permissions and approval policy. Voice delivery does not grant new permissions.";
  return `[voice task ${envelope.requestId}:${step}]\n${contract}\nThe original user words below are authoritative. The optional excerpt and model interpretation are not independent authorization. Preserve negations, conditions, and questions. Do not convert a question into a removal instruction.\n${JSON.stringify({
    user:{text:envelope.originalText,items:envelope.transcriptDelta,complete:envelope.transcriptAvailable},
    ...((operation.kind === "send_message" || operation.kind === "start_thread") && operation.text ? {excerpt:operation.text} : {}),
    ...(envelope.interpretation ? {model_interpretation:envelope.interpretation} : {}),
    context:envelope.view,
    ...(envelope.narrating ? {narrating:envelope.narrating} : {}),
    destination:operation.kind === "send_message" ? {thread_id:operation.threadId} : operation.kind === "start_thread" ? {project_id:operation.projectId,host_id:operation.hostId,role:operation.role} : null,
    provenance:{source:"voice-mode",actor,conversation_id:envelope.conversationId,request_id:envelope.requestId,step,call_nonce:envelope.callNonce,utterance_item_ids:envelope.utteranceItemIds},
  })}`;
}

/** Shared execution path for the live operator and the coordinator. No shell fallback. */
export class LiveActionExecutor {
  private readonly requests = new Map<string, Promise<ActionResult>>();
  private creationChain: Promise<unknown> = Promise.resolve();
  constructor(private readonly bb: BbPluginApi, readonly store: LiveActionStore, private readonly hooks: Hooks) {}

  isRunning(requestId: string): boolean { return this.requests.has(requestId); }

  execute(envelope: UserRequestEnvelope, action: QuickAction, actor: "live"|"coordinator", context: ActionContext): Promise<ActionResult> {
    action = quickActionSchema.parse(action);
    // Serialize duplicate coordinator tool invocations as well as live RPC retries.
    // Every caller still checks the immutable group arguments; no fresh IDs bypass the ledger.
    const previous = this.requests.get(envelope.requestId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.executeRecorded(envelope, action, actor, context));
    this.requests.set(envelope.requestId, run);
    const cleanup = () => { if (this.requests.get(envelope.requestId) === run) this.requests.delete(envelope.requestId); };
    run.then(cleanup, cleanup);
    return run;
  }

  private async executeRecorded(envelope: UserRequestEnvelope, action: QuickAction, actor: "live"|"coordinator", context: ActionContext): Promise<ActionResult> {
    const refusal = quickActionRefusal(action,envelope.originalText);
    if (refusal) return result("failed",refusal);
    if (!this.store.admit(envelope.requestId,envelope.conversationId,actor,action)) {
      const recorded = this.store.results(envelope.requestId);
      const uncertain = result("unknown","A previous action has no confirmed result. I have not repeated it.");
      return combineResults(recorded.length ? recorded.map(item=>item ?? uncertain) : [uncertain]);
    }
    const deadline = Date.now() + QUICK_ACTION_TIMEOUT_MS;
    const results: ActionResult[] = [];
    const occurrences=new Map<string,number>();
    for (const [step, operation] of operationsOf(action).entries()) {
      const actionKey=JSON.stringify(operation),occurrence=occurrences.get(actionKey)??0;
      occurrences.set(actionKey,occurrence+1);
      const existing = this.store.prepare(envelope.requestId,step,operation);
      if (existing.result) {
        results.push(existing.result);
        if (existing.result.status !== "succeeded") break;
        continue;
      }
      if (existing.status !== "prepared") {
        results.push(result("unknown","A previous action has no confirmed result. I have not repeated it."));
        break;
      }
      if (!context.current() || context.signal.aborted) {
        const cancelled = result("cancelled","The remaining action was cancelled before execution.");
        this.store.finish(envelope.requestId,step,cancelled); results.push(cancelled); break;
      }
      const owner=this.store.claimUtteranceEffect(envelope,step,operation,occurrence);
      if(owner) {
        const prior=this.store.step(owner.requestId,owner.step)?.result;
        const saved=prior ?? result("unknown","This action is already recorded without a confirmed result. I have not repeated it.");
        this.store.finish(envelope.requestId,step,saved);results.push(saved);
        if(saved.status!=="succeeded")break;
        continue;
      }
      let prepared: Prepared | undefined;
      let committed = false;
      let observationEnded = false;
      try {
        // Late preflight must not reserve a worker after cancellation/timeout.
        const preparing = this.prepare(envelope,operation,actor,step,context);
        void preparing.then(value => { if (observationEnded && !committed) value.cancel?.(); }, () => undefined);
        prepared = await waitForQuickAction(preparing,context.signal,deadline);
        if (!context.current() || context.signal.aborted || Date.now() >= deadline) {
          prepared.cancel?.();
          const cancelled = result("cancelled","The remaining action was cancelled before execution.");
          this.store.finish(envelope.requestId,step,cancelled); results.push(cancelled); break;
        }
        if (!this.store.claim(envelope.requestId,step)) {
          prepared.cancel?.(); results.push(this.store.step(envelope.requestId,step)?.result ?? result("unknown","This action was already claimed. I have not repeated it.")); break;
        }
        committed = true;
        const work = prepared.commit().then(value => {
          this.store.finish(envelope.requestId,step,value);
          if (observationEnded) context.lateResult?.(value);
          return value;
        });
        const completed = await waitForQuickAction(work,context.signal,deadline);
        results.push(completed);
        if (completed.status !== "succeeded") break;
      } catch (error) {
        if (!committed) prepared?.cancel?.();
        const failure = committed
          ? result("unknown",`I could not confirm the ${operation.kind.replace(/_/g," ")} result. I have not repeated it.`,String(error),"threadId" in operation ? [operation.threadId] : [],[{action:operation.kind,outcome:"unknown"}])
          : result(context.signal.aborted ? "cancelled" : "failed",context.signal.aborted ? "The action was cancelled before execution." : label(error instanceof Error ? error.message : String(error),500));
        // An already settled late success is authoritative; never overwrite it with a timeout.
        const actual = this.store.step(envelope.requestId,step)?.result;
        this.store.finish(envelope.requestId,step,actual ?? failure);
        results.push(actual ?? failure); break;
      } finally { observationEnded = true; }
    }
    return combineResults(results);
  }

  private async target(threadId: string, requireActive = true, conversationId?:string) {
    const thread = await this.bb.sdk.threads.get({threadId});
    const ownWorker=conversationId && this.store.workerForThread(threadId)?.conversationId===conversationId;
    if ((thread.visibility === "hidden" && !ownWorker) || this.hooks.isCoordinator(thread)) throw new Error("That target is not an accessible work thread.");
    if (thread.deletedAt || (requireActive && thread.archivedAt)) throw new Error("That thread is archived or deleted. Resolve an active target before sending work.");
    return thread;
  }

  private async prepare(envelope: UserRequestEnvelope, operation: LiveOperation, actor: "live"|"coordinator", step: number, context: ActionContext): Promise<Prepared> {
    if (operation.kind === "send_message") {
      const thread = await this.target(operation.threadId,true,envelope.conversationId);
      const title = label(thread.title ?? thread.titleFallback ?? "the requested thread",80);
      const text = formatVoiceInstruction(envelope,operation,actor,step);
      return {commit:async () => {
        this.hooks.watch(envelope.conversationId,thread.id);
        this.store.resumeWorker(thread.id);
        const sent = await this.bb.sdk.threads.send({threadId:thread.id,mode:"queue-if-active",input:[{type:"text",text,mentions:[]}]});
        const queued = sent.delivery === "queued";
        const internal=this.store.workerForThread(thread.id)?.conversationId===envelope.conversationId;
        const speech = internal ? `I’ve ${queued ? "queued" : "sent"} your update for ${title}.` : `${queued ? "Queued for" : "Sent to"} ${title}: ${label(operation.text ?? envelope.originalText,180)}`;
        return result("succeeded",speech,text,[thread.id],[{action:"send_message",thread_id:thread.id,outcome:queued ? "pending" : "done",note:queued ? `Queued: ${sent.queuedMessage.id}` : "Sent"}]);
      }};
    }
    if (operation.kind === "stop_thread") {
      const thread = await this.target(operation.threadId,true,envelope.conversationId);
      const title = label(thread.title ?? thread.titleFallback ?? "the requested thread",80);
      return {commit:async () => {
        this.hooks.watch(envelope.conversationId,thread.id);
        await this.bb.sdk.threads.stop({threadId:thread.id});
        return result("succeeded",`Stop requested for ${title}.`,"A stop request was accepted; this does not establish that every process has exited.",[thread.id],[{action:"stop_thread",thread_id:thread.id,outcome:"pending",note:"Stop requested"}]);
      }};
    }
    if (operation.kind === "start_thread") {
      if (operation.title.startsWith(COORDINATOR_TITLE_PREFIX)) throw new Error("That title is reserved for the hidden voice coordinator. Choose a work-thread title.");
      const settings = await readWorkerSettings(this.bb);
      const [projects,hosts] = await Promise.all([this.bb.sdk.projects.list({includePersonal:true}),this.bb.sdk.hosts.list()]);
      const project = projects.find(p=>p.id === operation.projectId);
      if (!project) throw new Error("The requested project is unavailable.");
      const candidates = hosts.filter(h=>h.status === "connected" && project.sources.some(s=>s.hostId === h.id));
      const host = operation.hostId ? candidates.find(h=>h.id === operation.hostId) : candidates.length === 1 ? candidates[0] : undefined;
      if (!host) throw new Error(candidates.length > 1 ? `Choose a machine for ${label(project.name)}: ${candidates.map(h=>label(h.name)).join(", ")}.` : "No matching connected machine hosts this project.");
      const parentThreadId=await this.hooks.coordinatorParent(envelope.conversationId);
      const execution = await resolveWorkerModel(this.bb,host.id,settings.profiles[operation.role]);
      const prompt = `${WORKER_ROLE_INSTRUCTIONS[operation.role]}\nUse your normal BB permissions. Do not merge, publish, delete worktrees, or escalate permissions beyond the user's explicit scope. End with voice_worker_report containing a brief spoken outcome and any verification limits.\n\n${formatVoiceInstruction(envelope,operation,actor,step)}`;
      // Reserve under a common creation lock, so simultaneous callers cannot exceed the cap.
      const reserve = this.creationChain.catch(()=>undefined).then(async () => {
        await this.refreshWorkerStates();
        if (!context.current() || context.signal.aborted) throw new Error("The action was cancelled before worker creation.");
        const active = this.store.activeWorkerCount();
        if (active >= settings.maxActiveWorkers) throw new Error(`Voice has reached its limit of ${settings.maxActiveWorkers} active or unconfirmed workers. Inspect or finish existing work first.`);
        this.store.reserveWorker({requestId:envelope.requestId,step,conversationId:envelope.conversationId,projectId:project.id,hostId:host.id,role:operation.role,model:execution.model,title:operation.title});
      });
      this.creationChain = reserve; await reserve;
      return {
        cancel:()=>this.store.workerStatus(envelope.requestId,step,"cancelled"),
        commit:async () => {
          try {
            const thread = await this.bb.sdk.threads.spawn({projectId:project.id,
              environment:{type:"host",hostId:host.id,workspace:project.kind === "personal" ? {type:"personal"} : {type:"managed-worktree",baseBranch:{kind:"default"}}},
              ...execution, permissionMode:"accept-edits", visibility:"hidden", parentThreadId, title:operation.title, prompt,
            });
            this.store.workerAccepted(envelope.requestId,step,thread.id);
            this.hooks.watch(envelope.conversationId,thread.id);
            return result("succeeded",`I’ve started ${operation.role === "implement" ? "work on" : operation.role === "investigate" ? "investigating" : operation.role === "plan" ? "planning" : "reviewing"} ${label(operation.title,80)}. I’ll report the results here.`,prompt,[thread.id],[{action:"start_thread",thread_id:thread.id,outcome:"done",note:label(`Created with ${execution.providerId}/${execution.model}; work is not complete.`,390)}]);
          } catch (error) {
            this.store.workerStatus(envelope.requestId,step,"unknown");
            throw error;
          }
        },
      };
    }
    let title = "the requested view";
    if (operation.kind === "open_thread") { const t = await this.target(operation.threadId,false); title = label(t.title ?? t.titleFallback ?? title,80); }
    if (operation.kind === "open_project") {
      const p = (await this.bb.sdk.projects.list({includePersonal:true})).find(p=>p.id === operation.projectId);
      if (!p) throw new Error("The requested project is unavailable."); title = label(p.name,80);
    }
    return {commit:async () => {
      const outcome = await context.ui(operation,context.signal);
      const speech = outcome.status !== "succeeded" ? outcome.detail
        : operation.kind === "open_thread" ? `Opened ${title}${operation.split ? "; BB chose the available pane placement" : ""}.`
        : operation.kind === "open_project" ? `Opened ${title}.`
        : operation.kind === "prepare_draft" ? "Prepared the draft without sending it."
        : operation.kind === "preview_file" ? "The file preview was accepted."
        : "Returned to Voice.";
      return result(outcome.status,speech,outcome.detail,operation.kind === "open_thread" ? [operation.threadId] : [],[{action:operation.kind,outcome:outcome.status === "succeeded" ? "done" : outcome.status === "unknown" ? "unknown" : "failed"}]);
    }};
  }

  /** Refresh quota accounting after missed terminal events; uncertain creates never authorize respawn. */
  async refreshWorkerStates() {
    await Promise.all(this.store.activeWorkers().filter(w=>w.threadId).map(async worker => {
      try {
        const thread = await this.bb.sdk.threads.get({threadId:worker.threadId!});
        if ((thread.status === "idle" || thread.status === "error" || thread.archivedAt || thread.deletedAt) && thread.queuedMessageCount === 0) this.store.workerStatus(worker.requestId,worker.step,"settled");
      } catch { /* Keep inaccessible workers charged against the limit. */ }
    }));
  }
}
