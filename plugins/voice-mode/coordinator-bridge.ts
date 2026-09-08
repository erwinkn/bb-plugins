import { SequencePlayer, type SequenceControlResult } from "./sequence-player.ts";
import type { InputController } from "./input-controller.ts";
import { sequenceControlSchema } from "./narrated-sequence.ts";
// Frontend half of the voice bridge. Binds realtime tool calls to settled
// user transcripts, dispatches validated requests, speaks coordinator replies
// under the right gate, tracks what the user actually heard, and reserves
// background-update batches at quiet boundaries. Everything here is driven by
// data-channel events the VoiceAgent forwards; nothing touches audio directly.
import { quickActionSchema, type QuickAction } from "./quick-actions.ts";
import { publishedReplySchema, type PublishedReply, type UserRequestEnvelope } from "./coordinator/envelopes.ts";
import { QUIET_INTERVAL_MS, refuseBackgroundSpeech, refuseDirectSpeech, type VoiceIdleFacts } from "./coordinator/scheduler.ts";

export interface BridgeHost {
  nonce(): string | null;
  callSequence(): number | null;
  /** Send one realtime client event; false when the channel is closed. */
  send(event: Record<string, unknown>): boolean;
  rpc<T = unknown>(method: string, args: unknown): Promise<T>;
  log(kind: string, payload?: Record<string, unknown>): void;
  facts(): VoiceIdleFacts;
  view(): { threadId: string | null; projectId: string | null; onNewThreadScreen: boolean };
  now(): number;
  /** The bridge is about to send response.create; the host marks generation active. */
  speaking(): void;
  changed(): void;
  input(): InputController;
  interruptSpeech(reason: string): void;
  cancelQuickRequest(requestId: string): void;
  subscribeNavigation?(listener:()=>void):()=>void;
}

export interface PendingHandoff {
  requestId: string;
  callId: string;
  request: string;
  interpretation: string | null;
  urgency: "new" | "steer" | "after_current";
  answersQuestionId: string | null;
  boundItemIds: string[];
  quickAction?: QuickAction;
  createdAt: number;
  status: "settling-input" | "dispatching" | "dispatched" | "superseded" | "cancelled" | "failed";
  speechEndedAt: number | null;
}

interface ActiveSpeech {
  reply: PublishedReply;
  responseId: string | null;
  playing: boolean;
  startedAt: number;
  actualSpeech: string | null;
}

export interface BridgeSnapshot {
  conversationId: string;
  working: boolean;
  pendingHandoff: string | null;
  queuedReplies: number;
  openQuestion: { id: string; text: string } | null;
}

/** One voice call's view of the coordinator conversation. */
export class CoordinatorBridge {
  private toolCalls = new Map<string, Promise<string>>();
  private pending: PendingHandoff | null = null;
  private dispatched = new Map<string, PendingHandoff>();
  private replyQueue: PublishedReply[] = [];
  private seenReplies = new Set<string>();
  private active: ActiveSpeech | null = null;
  private inboxPending = false;
  private reserving = false;
  private lastRefusal: string | null = null;
  private openQuestion: { id: string; text: string } | null = null;
  private liveAt: number;
  private disposed = false;
  private acknowledgedTurns = new Set<number>();
  private acknowledgments = new Map<number, {requestId:string;text:string}>();

  private sequence: SequencePlayer;
  private unsubscribeNavigation?:()=>void;

  constructor(private readonly host: BridgeHost, readonly conversationId: string, private readonly userTurnOf: () => number) {
    this.liveAt = host.now();
    this.sequence=new SequencePlayer({
      callNonce:()=>host.nonce(),rpc:input=>host.rpc("sequence",input),
      speak:reply=>this.speak(reply),cancelAction:id=>host.cancelQuickRequest(id),
      context:text=>this.addContext(text),log:(kind,data)=>host.log(kind,data),
      changed:()=>{host.changed();this.drain();},
    },conversationId);
    this.unsubscribeNavigation=host.subscribeNavigation?.(()=>{
      if (!this.sequence.pending() || this.sequence.actionInFlight()) return;
      this.pauseSequence("You changed the view. Say continue when ready.",true);
    });
  }

  snapshot(): BridgeSnapshot {
    return {
      conversationId: this.conversationId,
      working: this.sequence.pending() || this.pending !== null || [...this.dispatched.values()].some((handoff) => handoff.status === "dispatched"),
      pendingHandoff: this.pending?.requestId ?? null,
      queuedReplies: this.replyQueue.length,
      openQuestion: this.openQuestion,
    };
  }

  offerInputRepair(message: string) {
    this.enqueueLocalReply(message, "failure", `local_input_${this.userTurnOf()}`);
  }

  /** The user started speaking: unsent speculative handoffs are held, not sent. */
  onSpeechStarted() {
    void this.sequence.pause("The user started speaking.");
    for (const handoff of this.dispatched.values()) {
      if (!handoff.quickAction || handoff.status === "cancelled") continue;
      handoff.status = "cancelled";
      this.host.cancelQuickRequest(handoff.requestId);
      void this.host.rpc("cancelQuickRequest", {conversationId:this.conversationId,callNonce:this.host.nonce(),requestId:handoff.requestId}).catch(() => undefined);
    }
    if (this.active) this.finishSpeech("interrupted");
    this.replyQueue = this.replyQueue.filter(reply => !reply.replyId.startsWith("local_ack_") && !reply.replyId.startsWith("local_input_"));
    this.acknowledgments.clear();
  }

  // ---- realtime tools ----

  delegate(callId: string, args: Record<string, unknown>, quick = false): Promise<string> {
    const existing=this.toolCalls.get(callId);
    if(existing)return existing;
    const task=this.delegateInput(callId,args,quick);
    this.toolCalls.set(callId,task);
    if(this.toolCalls.size>300)this.toolCalls.delete(this.toolCalls.keys().next().value!);
    return task;
  }

  private async delegateInput(callId:string,args:Record<string,unknown>,quick:boolean):Promise<string> {
    const quickAction=quick ? quickActionSchema.parse(args.action) : undefined;
    const navigation=(action:Record<string,unknown>)=>["open_thread","open_project","preview_file","show_voice"].includes(String(action.kind));
    const effect=!quickAction || !(quickAction.kind==="group" ? quickAction.actions.every(action=>navigation(action)) : navigation(quickAction));
    const version=this.userTurnOf();
    const handoff:PendingHandoff={requestId:`r_${crypto.randomUUID().replace(/-/g, "").slice(0,16)}`,callId,
      request:typeof args.request==="string" ? args.request : "",
      interpretation:typeof args.interpretation==="string" ? args.interpretation : null,
      urgency:args.urgency==="steer" ? "steer" : args.urgency==="after_current" ? "after_current" : "new",
      answersQuestionId:typeof args.answers_question_id==="string" ? args.answers_question_id : null,
      boundItemIds:[],...(quickAction ? {quickAction} : {}),createdAt:this.host.now(),status:"settling-input",speechEndedAt:null};
    this.pending=handoff;this.host.changed();
    const input=await this.host.input().waitFor(version,effect);
    if(this.disposed || !input || version!==this.userTurnOf()) {
      if(this.pending===handoff)this.pending=null;
      handoff.status="superseded";this.host.changed();
      return "No work was sent. The spoken request changed or has incomplete transcription; wait for the complete current request.";
    }
    const nonce=this.host.nonce(),sequence=this.host.callSequence();
    if(!nonce || sequence===null)return "The voice call has ended.";
    handoff.boundItemIds=input.items.map(item=>item.itemId);handoff.status="dispatching";
    handoff.speechEndedAt=input.finalAt;
    const envelope:UserRequestEnvelope={v:1,conversationId:this.conversationId,callNonce:nonce,callSequence:sequence,
      requestId:handoff.requestId,narrating:this.sequence.narrating(),utteranceId:input.id,utteranceVersion:input.version,
      utteranceItemIds:handoff.boundItemIds,transcriptRevision:input.version,transcriptAvailable:true,
      originalText:input.text,transcriptDelta:input.items.map(item=>({...item})),interpretation:handoff.interpretation,
      urgency:handoff.urgency,answersQuestionId:handoff.answersQuestionId,view:input.view,...(quickAction ? {quickAction} : {})};
    if(!quickAction) {
      this.sequence.expectPlan(handoff.requestId);
      this.acknowledgments.set(version,{requestId:handoff.requestId,text:typeof args.acknowledgment==="string" && args.acknowledgment.trim() ? args.acknowledgment.trim().slice(0,160) : "I’ll check that for you."});
    }
    this.host.log("handoff.recorded",{requestId:handoff.requestId,callId,boundItems:handoff.boundItemIds,utteranceId:input.id,utteranceVersion:input.version});
    this.pending=null;this.dispatched.set(handoff.requestId,handoff);
    try {
      const receipt=await this.host.rpc<{status:string;receipt:{delivery:string}|null;error:string|null}>("submitRequest",{envelope});
      if((handoff as PendingHandoff).status!=="cancelled")handoff.status=receipt.status==="failed"||receipt.status==="quick_cancelled" ? "failed" : "dispatched";
      if(receipt.status==="quick_cancelled")this.dispatched.delete(handoff.requestId);
      this.host.log("handoff.dispatched",{requestId:handoff.requestId,status:receipt.status,delivery:receipt.receipt?.delivery??null,error:receipt.error,transcriptWaitMs:this.host.now()-handoff.createdAt,transcriptAvailable:true});
      if(receipt.status==="failed" || receipt.status==="quick_cancelled") {
        return `Request ${handoff.requestId} was not executed: ${receipt.error ?? receipt.status}. Do not claim delivery or repeat accepted steps. The bridge reports failures.`;
      }
      return `Request ${handoff.requestId} recorded on the ${quickAction ? "direct" : "coordinator"} path; this is not a delivery receipt. Keep all remaining steps on this path. Wait silently; the bridge speaks the actual result.`;
    } catch(error) {
      handoff.status="failed";
      this.host.log("handoff.error",{requestId:handoff.requestId,error:String(error)});
      this.acknowledgments.delete(version);
      this.enqueueLocalReply("I could not confirm the request result. I will not repeat it automatically.","failure",`local_unknown_${handoff.requestId}`);
      return "The request result could not be confirmed. Do not resend it under a new ID.";
    } finally {this.host.changed();this.drain();}
  }

  /** Called after the original tool response settles, never as a model tool follow-up. */
  acknowledge(turn: number, alreadySpoke: boolean) {
    const acknowledgment = this.acknowledgments.get(turn);
    const requestId = acknowledgment?.requestId;
    this.acknowledgments.delete(turn);
    if (!requestId || turn !== this.userTurnOf() || this.acknowledgedTurns.has(turn)) return;
    this.acknowledgedTurns.add(turn);
    if (alreadySpoke) return;
    if (this.replyQueue.some(reply => reply.requestId === requestId && reply.kind !== "progress")) return;
    const reply: PublishedReply = {
      v: 1, replyId: `local_ack_${requestId}`, conversationId: this.conversationId, seq: -1,
      requestId, batchId: null, questionId: null, kind: "progress", source: "bridge",
      speech: acknowledgment!.text, detail: null, threadIds: [], receipts: [],
      targetCallNonce: this.host.nonce(), createdAt: this.host.now(),
    };
    this.replyQueue.unshift(reply);
    this.drain();
  }

  speechIdentity(responseId: string | null) {
    if (!responseId || this.active?.responseId !== responseId) return null;
    return { replyId: this.active.reply.replyId, requestId: this.active.reply.requestId,
      source: this.active.reply.replyId.startsWith("local_ack_") ? "acknowledgment" : this.active.reply.source === "bridge" ? "bridge" : "coordinator" };
  }

  remainSilent(): string {
    this.host.log("handoff.silent", {});
    return "Staying silent.";
  }

  // ---- replies ----

  ingestReply(payload: unknown) {
    const parsed = publishedReplySchema.safeParse(payload);
    if (!parsed.success) return;
    const reply = parsed.data;
    if (reply.conversationId !== this.conversationId) return;
    if (reply.targetCallNonce !== this.host.nonce()) { this.host.log("reply.stale", { replyId: reply.replyId, target: reply.targetCallNonce }); return; }
    if (this.seenReplies.has(reply.replyId)) return;
    this.seenReplies.add(reply.replyId);
    if (reply.kind === "clarification" && reply.questionId) this.openQuestion = { id: reply.questionId, text: reply.speech };
    if (reply.sequence) {
      if (reply.requestId) this.dispatched.delete(reply.requestId);
      void this.sequence.recover(reply.replyId,reply.requestId);
      return;
    }
    this.replyQueue.push(reply);
    this.replyQueue.sort((a, b) => a.seq - b.seq);
    this.host.log("reply.received", { replyId: reply.replyId, kind: reply.kind, requestId: reply.requestId, batchId: reply.batchId, source: reply.source });
    this.host.changed();
    this.drain();
  }

  ingestStatus(payload: unknown) {
    const status = payload as {conversationId?:string;callNonce?:string;activeRequestIds?:string[]};
    if (status?.conversationId !== this.conversationId || status.callNonce !== this.host.nonce() || !Array.isArray(status.activeRequestIds)) return;
    for (const id of this.dispatched.keys()) if (!status.activeRequestIds.includes(id)) this.dispatched.delete(id);
    this.host.changed();
  }

  ingestInbox(payload: unknown) {
    const p = payload as { conversationId?: unknown; callNonce?: unknown; queued?: unknown } | null;
    if (p?.conversationId !== this.conversationId || p?.callNonce !== this.host.nonce()) return;
    this.inboxPending = typeof p.queued === "number" ? p.queued > 0 : true;
    this.drain();
  }

  /** Re-fetch replies the server still holds for this call (reconnect). */
  async reconcile() {
    await this.sequence.recover();
    try {
      const { replies } = await this.host.rpc<{ replies: unknown[] }>("pendingReplies", { conversationId: this.conversationId, nonce: this.host.nonce() });
      for (const reply of replies) this.ingestReply(reply);
    } catch {
      /* the next published reply still arrives through realtime */
    }
  }

  private enqueueLocalReply(speech: string, kind: "failure", replyId = `local_${globalThis.crypto.randomUUID()}`) {
    const reply: PublishedReply = {
      v: 1, replyId, conversationId: this.conversationId, seq: Number.MAX_SAFE_INTEGER, requestId: null, batchId: null, questionId: null,
      kind, source: "bridge", speech, detail: null, threadIds: [], receipts: [], targetCallNonce: this.host.nonce(), createdAt: this.host.now(),
    };
    this.replyQueue.push(reply);
    this.drain();
  }

  /**
   * Speak the next reply whose gate is open, or reserve a background batch at
   * a quiet boundary. Safe to call often; every state change calls it.
   */
  drain() {
    if (this.disposed || !this.host.nonce()) return;
    const facts = this.host.facts();
    if (this.active) return;
    const next = this.replyQueue.find(reply=>reply.kind!=="update" || !this.sequence.pending());
    if (next) {
      const refusal = next.kind === "update" ? refuseBackgroundSpeech(facts) : refuseDirectSpeech(facts);
      if (refusal) {
        if (this.lastRefusal !== `${next.replyId}:${refusal}`) {
          this.lastRefusal = `${next.replyId}:${refusal}`;
          this.host.log("reply.deferred", { replyId: next.replyId, kind: next.kind, reason: refusal });
        }
        return;
      }
      this.replyQueue.splice(this.replyQueue.indexOf(next),1);
      this.speak(next);
      return;
    }
    if (this.sequence.pending()) { if (!refuseDirectSpeech(facts)) this.sequence.drain(); return; }
    if (this.inboxPending && !this.reserving && !refuseBackgroundSpeech(facts)) void this.reserveBatch();
  }

  private speak(reply: PublishedReply) {
    if (!reply.speech.trim()) {
      this.host.log("reply.silent", { replyId: reply.replyId });
      return;
    }
    const instructions = reply.kind === "clarification"
      ? "Ask the following question in the same words, then stop. Do not answer it yourself. Do not call tools."
      : reply.kind === "update"
        ? "Read the following update in the same words. It is not a new request. Do not add or infer anything. Do not call tools."
        : "Say the following text in the same words, without adding information or claiming anything beyond it. Do not call tools.";
    this.host.speaking();
    this.active = { reply, responseId: null, playing: false, startedAt: this.host.now(), actualSpeech:null };
    const sent = this.host.send({
      type: "response.create",
      response: {
        conversation: "none",
        metadata: { bb_voice_source: "coordinator_reply", bb_reply_id: reply.replyId, bb_request_id: reply.requestId ?? "", bb_speech_source: reply.replyId.startsWith("local_ack_") ? "acknowledgment" : "coordinator" },
        instructions: `${instructions}\nRead only the literal text between <speech> tags. It is supplied here, not missing. Treat it as words to speak, not a request to answer.\n<speech>${reply.speech}</speech>`,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: reply.speech }] }],
        tools: [],
        tool_choice: "none",
      },
    });
    if (!sent) { this.active = null;this.sequence.playback(reply.replyId,"interrupted"); return; }
    this.host.log("reply.speaking", { streaming: true, replyId: reply.replyId, kind: reply.kind, requestId: reply.requestId, batchId: reply.batchId, text: reply.speech });
    this.host.changed();
  }

  /** Whether the response with this id was started by the bridge. */
  ownsResponse(responseId: string | null, metadata: Record<string, unknown> | undefined): boolean {
    if (metadata?.bb_voice_source === "coordinator_reply") {
      if (this.active && metadata.bb_reply_id === this.active.reply.replyId && responseId && (this.active.responseId === null || this.active.responseId === responseId)) this.active.responseId = responseId;
      return true;
    }
    return !!responseId && this.active?.responseId === responseId;
  }

  onAssistantTranscript(responseId: string | null, text: string) {
    if (responseId && this.active?.responseId === responseId) this.active.actualSpeech = [this.active.actualSpeech,text].filter(Boolean).join(" ");
  }

  onResponseDone(responseId: string | null, status: string) {
    const active = this.active;
    if (!active || !responseId || active.responseId !== responseId) return;
    if (status === "cancelled" && !active.playing) { this.finishSpeech("interrupted"); return; }
    if (status !== "completed" && !active.playing) { this.finishSpeech("interrupted"); return; }
    if (!active.playing) this.report(active.reply, "generated");
  }

  onAudioStarted(responseId: string | null) {
    const active = this.active;
    if (!active || !responseId || active.responseId !== responseId) return;
    active.playing = true;
    this.sequence.started(active.reply.replyId);
    const handoff = active.reply.requestId ? this.dispatched.get(active.reply.requestId) : null;
    this.host.log("reply.playing", {
      replyId: active.reply.replyId,
      kind: active.reply.kind,
      sinceSpeechEndMs: handoff?.speechEndedAt ? this.host.now() - handoff.speechEndedAt : null,
      sinceHandoffMs: handoff ? this.host.now() - handoff.createdAt : null,
    });
    this.report(active.reply, "playing");
  }

  onAudioStopped(responseId: string | null) {
    if (responseId && this.active?.responseId === responseId && this.active.playing) this.finishSpeech("delivered");
  }

  onAudioCleared(responseId: string | null) {
    if (responseId && this.active?.responseId === responseId) this.finishSpeech(this.active.playing ? "interrupted" : "superseded");
  }

  private finishSpeech(state: "delivered" | "interrupted" | "superseded") {
    const active = this.active;
    if (!active) return;
    this.active = null;
    const reply = active.reply;
    const normalize = (text:string) => text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    const mismatch = active.actualSpeech !== null && normalize(active.actualSpeech) !== normalize(reply.speech);
    if (mismatch) {
      this.host.log("reply.mismatch", {replyId:reply.replyId,responseId:active.responseId,expected:reply.speech,actual:active.actualSpeech});
      this.addContext(JSON.stringify({voice_output:{reply_id:reply.replyId,actual:active.actualSpeech,intended_reply_not_delivered:true}}));
      this.sequence.playback(reply.replyId,"mismatch");
      this.report(reply,"mismatch");
      this.host.changed(); this.drain(); return;
    }
    if (reply.requestId && (reply.kind === "final" || reply.kind === "failure")) {
      const handoff = this.dispatched.get(reply.requestId);
      if (handoff) handoff.status = "dispatched";
      this.dispatched.delete(reply.requestId);
    }
    if (!reply.replyId.startsWith("local_ack_")) this.addContext(JSON.stringify({voice_reply:{id:reply.replyId,request_id:reply.requestId,kind:reply.kind,delivery:state,text:reply.speech,...(reply.threadIds.length ? {threads:reply.threadIds} : {}),...(reply.questionId ? {question_id:reply.questionId} : {})}}));
    this.host.log(`reply.${state}`, { replyId: reply.replyId, requestId: reply.requestId, responseId: active.responseId, kind: reply.kind });
    this.sequence.playback(reply.replyId,state);
    this.report(reply, state);
    this.host.changed();
    this.drain();
  }

  private report(reply: PublishedReply, state: "generated" | "playing" | "delivered" | "interrupted" | "partial" | "held" | "superseded" | "mismatch") {
    if (reply.replyId.startsWith("local_") || reply.replyId.startsWith("sequence_speech:")) return;
    const nonce = this.host.nonce();
    if (!nonce) return;
    void this.host.rpc("reportReplyDelivery", { replyId: reply.replyId, nonce, state }).catch(() => undefined);
  }

  private addContext(text: string) {
    this.host.send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text: text.slice(0, 4000) }] } });
  }

  // ---- background updates ----

  private async reserveBatch() {
    const nonce = this.host.nonce();
    if (!nonce) return;
    this.reserving = true;
    try {
      const result = await this.host.rpc<{ batch: { id: string; count: number; remaining: number } | null; reason: string | null }>("reserveUpdateBatch", { conversationId: this.conversationId, nonce, msSinceCallLive: this.host.now() - this.liveAt });
      if (result.batch) {
        this.inboxPending = result.batch.remaining > 0;
        this.host.log("updates.reserved", { batchId: result.batch.id, count: result.batch.count, remaining: result.batch.remaining });
      } else {
        if (result.reason === "empty" || result.reason === "call-mismatch") this.inboxPending = false;
        this.host.log("updates.deferred", { reason: result.reason });
      }
    } catch (error) {
      this.host.log("updates.reserveFailed", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.reserving = false;
    }
  }

  /** Delay before the next quiet check; mirrors the existing two-second window. */
  quietDelayMs(): number {
    return QUIET_INTERVAL_MS;
  }

  // ---- lifecycle ----

  pauseSequence(reason:string,restoreView=false) {
    void this.sequence.pause(reason,restoreView);
    if(this.active?.reply.replyId.startsWith("sequence_speech:")) {
      this.host.interruptSpeech("sequence-paused");
      this.finishSpeech("interrupted");
    }
  }

  async controlSequence(args:Record<string,unknown>):Promise<SequenceControlResult> {
    const operation=sequenceControlSchema.parse(args.operation);
    const turn=this.userTurnOf();
    if (this.host.facts().userSpeaking || !this.host.input().snapshot()) return {status:"held",message:"Wait for the complete spoken instruction before controlling the sequence."};
    return this.sequence.control(operation);
  }

  dispose(reason: "hangup" | "replaced") {
    this.unsubscribeNavigation?.();
    this.sequence.dispose();
    this.disposed = true;
    const pending = this.pending;
    if (pending) {
      pending.status = "cancelled";
      this.pending = null;
      this.host.log("handoff.cancelled", { requestId: pending.requestId, reason: `${reason} before transcript settled` });
    }
    for (const reply of this.replyQueue) this.host.log("reply.undelivered", { replyId: reply.replyId, kind: reply.kind, reason });
    this.replyQueue = [];
    if (this.active) this.host.log("reply.undelivered", { replyId: this.active.reply.replyId, kind: this.active.reply.kind, reason });
    this.active = null;
  }
}
