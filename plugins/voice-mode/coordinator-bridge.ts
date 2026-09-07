// Frontend half of the voice bridge. Binds realtime tool calls to settled
// user transcripts, dispatches validated requests, speaks coordinator replies
// under the right gate, tracks what the user actually heard, and reserves
// background-update batches at quiet boundaries. Everything here is driven by
// data-channel events the VoiceAgent forwards; nothing touches audio directly.
import { publishedReplySchema, type PublishedReply, type UserRequestEnvelope } from "./coordinator/envelopes.ts";
import { QUIET_INTERVAL_MS, refuseBackgroundSpeech, refuseDirectSpeech, type VoiceIdleFacts } from "./coordinator/scheduler.ts";

/** How long a handoff waits for its input transcript before dispatching without it. */
export const TRANSCRIPT_WAIT_MS = 4000;

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
  applyFocus(threadId: string): Promise<void>;
  changed(): void;
}

interface UserItem {
  itemId: string;
  text: string | null;
  failed: boolean;
  turn: number;
  committedAt: number;
  speechEndedAt: number | null;
}

export interface PendingHandoff {
  requestId: string;
  callId: string;
  request: string;
  interpretation: string | null;
  urgency: "new" | "steer" | "after_current";
  answersQuestionId: string | null;
  boundItemIds: string[];
  createdAt: number;
  status: "waiting-transcript" | "dispatching" | "dispatched" | "superseded" | "cancelled" | "failed";
  timer: ReturnType<typeof setTimeout> | null;
  speechEndedAt: number | null;
}

interface ActiveSpeech {
  reply: PublishedReply;
  responseId: string | null;
  playing: boolean;
  startedAt: number;
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
  private items: UserItem[] = [];
  private cursor = 0;
  private transcriptRevision = 0;
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

  constructor(private readonly host: BridgeHost, readonly conversationId: string, private readonly userTurnOf: () => number) {
    this.liveAt = host.now();
  }

  snapshot(): BridgeSnapshot {
    return {
      conversationId: this.conversationId,
      working: this.pending !== null || [...this.dispatched.values()].some((handoff) => handoff.status === "dispatched"),
      pendingHandoff: this.pending?.requestId ?? null,
      queuedReplies: this.replyQueue.length,
      openQuestion: this.openQuestion,
    };
  }

  // ---- user input tracking ----

  onUserItemCommitted(itemId: string) {
    if (!itemId || this.items.some((item) => item.itemId === itemId)) return;
    this.items.push({ itemId, text: null, failed: false, turn: this.userTurnOf(), committedAt: this.host.now(), speechEndedAt: this.host.now() });
    if (this.items.length > 200) { const drop = this.items.length - 200; this.items.splice(0, drop); this.cursor = Math.max(0, this.cursor - drop); }
  }

  onTranscript(itemId: string, text: string) {
    let item = this.items.find((entry) => entry.itemId === itemId);
    if (!item) {
      // Transcription can land before the commit event on some clients.
      item = { itemId, text: null, failed: false, turn: this.userTurnOf(), committedAt: this.host.now(), speechEndedAt: this.host.now() };
      this.items.push(item);
    }
    item.text = text;
    this.transcriptRevision += 1;
    this.tryDispatch();
  }

  onTranscriptFailed(itemId: string) {
    const item = this.items.find((entry) => entry.itemId === itemId);
    if (item) { item.failed = true; item.text = item.text ?? ""; }
    this.transcriptRevision += 1;
    this.tryDispatch();
  }

  /** The user started speaking: unsent speculative handoffs are held, not sent. */
  onSpeechStarted() {
    if (this.pending && this.pending.status === "waiting-transcript") this.supersedePending("user continued speaking");
    if (this.active?.playing) this.finishSpeech("interrupted");
  }

  // ---- realtime tools ----

  delegate(callId: string, args: Record<string, unknown>): string {
    const request = typeof args.request === "string" ? args.request.trim() : "";
    const urgency = args.urgency === "steer" || args.urgency === "after_current" ? args.urgency : "new";
    const answersQuestionId = typeof args.answers_question_id === "string" && args.answers_question_id ? args.answers_question_id : null;
    if (this.pending) this.supersedePending("a newer delegation replaced it");
    const bound = this.items.slice(this.cursor);
    const requestId = `r_${(globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/-/g, "").slice(0, 16)}`;
    const handoff: PendingHandoff = {
      requestId,
      callId,
      request,
      interpretation: typeof args.interpretation === "string" && args.interpretation.trim() ? args.interpretation.trim() : null,
      urgency,
      answersQuestionId,
      boundItemIds: bound.map((item) => item.itemId),
      createdAt: this.host.now(),
      status: "waiting-transcript",
      timer: null,
      speechEndedAt: bound.at(-1)?.speechEndedAt ?? null,
    };
    this.pending = handoff;
    this.host.log("handoff.recorded", { requestId, callId, boundItems: handoff.boundItemIds, urgency, answersQuestionId });
    this.host.changed();
    if (!this.tryDispatch()) {
      handoff.timer = setTimeout(() => {
        if (this.pending === handoff && handoff.status === "waiting-transcript") {
          this.host.log("handoff.transcriptTimeout", { requestId, waitedMs: TRANSCRIPT_WAIT_MS });
          void this.dispatch(handoff, false);
        }
      }, TRANSCRIPT_WAIT_MS);
      (handoff.timer as { unref?: () => void }).unref?.();
    }
    return `Handoff ${requestId} recorded; the coordinator will reply. Say at most two words or nothing.`;
  }

  remainSilent(): string {
    this.host.log("handoff.silent", {});
    return "Staying silent.";
  }

  private supersedePending(reason: string) {
    const handoff = this.pending;
    if (!handoff) return;
    if (handoff.timer) clearTimeout(handoff.timer);
    handoff.timer = null;
    handoff.status = "superseded";
    this.pending = null;
    this.host.log("handoff.superseded", { requestId: handoff.requestId, reason });
    this.addContext(`[bb coordinator] Handoff ${handoff.requestId} was held and not sent because ${reason}. If the request still stands after the user's latest words, delegate again with the complete request.`);
    this.host.changed();
  }

  /** Dispatch the pending handoff once every bound item has a settled transcript. */
  private tryDispatch(): boolean {
    const handoff = this.pending;
    if (!handoff || handoff.status !== "waiting-transcript") return false;
    const bound = handoff.boundItemIds.map((id) => this.items.find((item) => item.itemId === id)).filter((item): item is UserItem => !!item);
    if (bound.some((item) => item.text === null && !item.failed)) return false;
    void this.dispatch(handoff, !bound.some((item) => item.failed));
    return true;
  }

  private async dispatch(handoff: PendingHandoff, transcriptAvailable: boolean) {
    if (this.pending !== handoff || handoff.status !== "waiting-transcript") return;
    if (handoff.timer) clearTimeout(handoff.timer);
    handoff.timer = null;
    const nonce = this.host.nonce();
    const sequence = this.host.callSequence();
    if (!nonce || sequence === null) { handoff.status = "cancelled"; this.pending = null; return; }
    handoff.status = "dispatching";
    const boundItems = handoff.boundItemIds.map((id) => this.items.find((item) => item.itemId === id)).filter((item): item is UserItem => !!item);
    const lastTurn = boundItems.at(-1)?.turn;
    const utterance = boundItems.filter((item) => item.turn === lastTurn);
    const originalText = utterance.map((item) => item.text ?? "").filter(Boolean).join(" ").trim();
    const envelope: UserRequestEnvelope = {
      v: 1,
      conversationId: this.conversationId,
      callNonce: nonce,
      callSequence: sequence,
      requestId: handoff.requestId,
      utteranceItemIds: utterance.map((item) => item.itemId),
      transcriptRevision: this.transcriptRevision,
      transcriptAvailable: transcriptAvailable && utterance.length > 0 && utterance.every((item) => item.text !== null && !item.failed),
      originalText: originalText.slice(0, 8000),
      transcriptDelta: boundItems.slice(-20).map((item) => ({ itemId: item.itemId, text: item.failed ? null : item.text })),
      interpretation: handoff.interpretation ?? (originalText ? null : handoff.request || null),
      urgency: handoff.urgency,
      answersQuestionId: handoff.answersQuestionId,
      view: this.host.view(),
    };
    // Consumed items never bind to a later handoff; superseded ones stay.
    const lastIndex = this.items.findIndex((item) => item.itemId === handoff.boundItemIds.at(-1));
    if (lastIndex >= 0) this.cursor = lastIndex + 1;
    this.pending = null;
    this.dispatched.set(handoff.requestId, handoff);
    const waitedMs = this.host.now() - handoff.createdAt;
    try {
      const receipt = await this.host.rpc<{ status: string; receipt: { delivery: string } | null; error: string | null }>("submitRequest", { envelope });
      handoff.status = receipt.status === "failed" ? "failed" : "dispatched";
      this.host.log("handoff.dispatched", { requestId: handoff.requestId, status: receipt.status, delivery: receipt.receipt?.delivery ?? null, error: receipt.error, transcriptWaitMs: waitedMs, transcriptAvailable: envelope.transcriptAvailable });
      if (envelope.answersQuestionId && receipt.status !== "failed" && this.openQuestion?.id === envelope.answersQuestionId) this.openQuestion = null;
    } catch (error) {
      handoff.status = "failed";
      const message = error instanceof Error ? error.message : String(error);
      this.host.log("handoff.failed", { requestId: handoff.requestId, error: message });
      if (this.host.nonce() === nonce) {
        this.enqueueLocalReply(`I couldn't reach the coordinator: ${message}. Say retry to try again.`, "failure");
      }
    }
    this.host.changed();
    this.drain();
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
    this.replyQueue.push(reply);
    this.replyQueue.sort((a, b) => a.seq - b.seq);
    this.host.log("reply.received", { replyId: reply.replyId, kind: reply.kind, requestId: reply.requestId, batchId: reply.batchId, source: reply.source });
    this.host.changed();
    this.drain();
  }

  ingestInbox(payload: unknown) {
    const p = payload as { conversationId?: unknown; callNonce?: unknown; queued?: unknown } | null;
    if (p?.conversationId !== this.conversationId || p?.callNonce !== this.host.nonce()) return;
    this.inboxPending = typeof p.queued === "number" ? p.queued > 0 : true;
    this.drain();
  }

  /** Re-fetch replies the server still holds for this call (reconnect). */
  async reconcile() {
    try {
      const { replies } = await this.host.rpc<{ replies: unknown[] }>("pendingReplies", { conversationId: this.conversationId, nonce: this.host.nonce() });
      for (const reply of replies) this.ingestReply(reply);
    } catch {
      /* the next published reply still arrives through realtime */
    }
  }

  private enqueueLocalReply(speech: string, kind: "failure") {
    const reply: PublishedReply = {
      v: 1, replyId: `local_${this.host.now()}`, conversationId: this.conversationId, seq: Number.MAX_SAFE_INTEGER, requestId: null, batchId: null, questionId: null,
      kind, source: "bridge", speech, detail: null, threadIds: [], receipts: [], targetCallNonce: this.host.nonce(), focusThreadId: null, createdAt: this.host.now(),
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
    const next = this.replyQueue[0];
    if (next) {
      const refusal = next.kind === "update" ? refuseBackgroundSpeech(facts) : refuseDirectSpeech(facts);
      if (refusal) {
        if (this.lastRefusal !== `${next.replyId}:${refusal}`) {
          this.lastRefusal = `${next.replyId}:${refusal}`;
          this.host.log("reply.deferred", { replyId: next.replyId, kind: next.kind, reason: refusal });
        }
        return;
      }
      this.replyQueue.shift();
      this.speak(next);
      return;
    }
    if (this.inboxPending && !this.reserving && !refuseBackgroundSpeech(facts)) void this.reserveBatch();
  }

  private speak(reply: PublishedReply) {
    if (!reply.speech.trim()) {
      this.host.log("reply.silent", { replyId: reply.replyId });
      return;
    }
    const instructions = reply.kind === "clarification"
      ? "Ask the user the following question from the coordinator, in the same words, then stop. Do not answer it yourself. Do not call tools."
      : reply.kind === "update"
        ? "Read the following background update from the coordinator to the user in the same words. It is not a new request. Do not add or infer anything. Do not call tools."
        : "Say the following reply from the coordinator to the user in the same words, without adding information or claiming anything beyond it. Do not call tools.";
    this.host.speaking();
    this.active = { reply, responseId: null, playing: false, startedAt: this.host.now() };
    const sent = this.host.send({
      type: "response.create",
      response: {
        conversation: "none",
        metadata: { bb_voice_source: "coordinator_reply", bb_reply_id: reply.replyId },
        instructions,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: reply.speech }] }],
        tools: [],
        tool_choice: "none",
      },
    });
    if (!sent) { this.active = null; return; }
    this.host.log("reply.speaking", { replyId: reply.replyId, kind: reply.kind, requestId: reply.requestId, batchId: reply.batchId, text: reply.speech });
    if (reply.focusThreadId) void this.host.applyFocus(reply.focusThreadId).catch((error) => this.host.log("reply.focusFailed", { replyId: reply.replyId, error: error instanceof Error ? error.message : String(error) }));
    this.host.changed();
  }

  /** Whether the response with this id was started by the bridge. */
  ownsResponse(responseId: string | null, metadata: Record<string, unknown> | undefined): boolean {
    if (metadata?.bb_voice_source === "coordinator_reply") {
      if (this.active && responseId && (this.active.responseId === null || this.active.responseId === responseId)) this.active.responseId = responseId;
      return true;
    }
    return !!responseId && this.active?.responseId === responseId;
  }

  onResponseDone(responseId: string | null, status: string) {
    const active = this.active;
    if (!active || (active.responseId !== null && active.responseId !== responseId)) return;
    if (status === "cancelled" && !active.playing) { this.finishSpeech("interrupted"); return; }
    if (status !== "completed" && !active.playing) { this.finishSpeech("interrupted"); return; }
    if (!active.playing) this.report(active.reply, "generated");
  }

  onAudioStarted() {
    const active = this.active;
    if (!active) return;
    active.playing = true;
    const handoff = active.reply.requestId ? this.dispatched.get(active.reply.requestId) : null;
    this.host.log("reply.playing", {
      replyId: active.reply.replyId,
      kind: active.reply.kind,
      sinceSpeechEndMs: handoff?.speechEndedAt ? this.host.now() - handoff.speechEndedAt : null,
      sinceHandoffMs: handoff ? this.host.now() - handoff.createdAt : null,
    });
    this.report(active.reply, "playing");
  }

  onAudioStopped() {
    if (this.active?.playing) this.finishSpeech("delivered");
  }

  onAudioCleared() {
    if (this.active) this.finishSpeech(this.active.playing ? "interrupted" : "superseded");
  }

  private finishSpeech(state: "delivered" | "interrupted" | "superseded") {
    const active = this.active;
    if (!active) return;
    this.active = null;
    const reply = active.reply;
    if (reply.requestId && (reply.kind === "final" || reply.kind === "failure")) {
      const handoff = this.dispatched.get(reply.requestId);
      if (handoff) handoff.status = "dispatched";
      this.dispatched.delete(reply.requestId);
    }
    const label = state === "delivered" ? "delivered" : state === "interrupted" ? "interrupted (partly heard)" : "not played";
    const threads = reply.threadIds.length ? ` Threads: ${reply.threadIds.join(", ")}.` : "";
    const question = reply.kind === "clarification" && reply.questionId ? ` Question id: ${reply.questionId}; delegate the user's answer with answers_question_id.` : "";
    this.addContext(`[bb coordinator ${reply.kind} ${reply.replyId}, ${label}] ${reply.speech}${threads}${question}`);
    this.host.log(`reply.${state}`, { replyId: reply.replyId, kind: reply.kind });
    this.report(reply, state);
    this.host.changed();
    this.drain();
  }

  private report(reply: PublishedReply, state: "generated" | "playing" | "delivered" | "interrupted" | "partial" | "held" | "superseded") {
    if (reply.replyId.startsWith("local_")) return;
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

  dispose(reason: "hangup" | "replaced") {
    this.disposed = true;
    const pending = this.pending;
    if (pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.timer = null;
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
