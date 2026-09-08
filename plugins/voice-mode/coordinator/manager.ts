import { LiveActionExecutor, combineResults } from "../live-action-executor.ts";
import { LiveActionStore, type ActionResult } from "../live-action-store.ts";
import { quickActionRefusal, type QuickAction } from "../quick-actions.ts";
import type { UiAction, UiActionResult } from "../ui-actions.ts";
import { coordinatorOptions } from "./settings.ts";
// The voice bridge's server half: owns the hidden coordinator thread's
// lifecycle, request dispatch with receipts, structured replies, questions,
// the background-update inbox, and hangup drain. Deterministic guarantees here
// are about bridge dispatch and reply delivery, not about what a trusted
// coordinator does with its native BB tools.
import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import {
  ENVELOPE_VERSION,
  formatDigestMessage,
  formatRequestMessage,
  truncateSpeech,
  type PublishedReply,
  type UserRequestEnvelope,
  type VoiceAskParams,
  type VoiceReplyParams,
} from "./envelopes.ts";
import { COORDINATOR_TITLE_PREFIX, coordinatorBootstrapPrompt, coordinatorTitle } from "./prompts.ts";
import { refuseBatch, selectBatch, type BatchRefusal } from "./scheduler.ts";
import type { ConversationRow, CoordinatorStore, QuestionRow, ReplyRow, RequestReceipt, RequestRow, StoredReply } from "./store.ts";

export interface CoordinatorConfig {
  providerId: string;
  model: string | null;
  reasoningLevel: string | null;
  serviceTier: "default" | "fast";
}

export const DEFAULT_COORDINATOR_CONFIG: CoordinatorConfig = {
  providerId: "codex",
  model: "gpt-5.4-mini",
  reasoningLevel: "medium",
  serviceTier: "default",
};

export class CoordinatorUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoordinatorUnavailableError";
  }
}

interface ManagerDeps {
  quickUi?: (envelope: UserRequestEnvelope, action: UiAction, signal: AbortSignal) => Promise<UiActionResult>;
  preferences?: () => string;
  onRequestEnded?: (requestId: string) => void;
  bb: BbPluginApi;
  store: CoordinatorStore;
  config: () => Promise<CoordinatorConfig>;
  now?: () => number;
}

interface QuestionWaiter {
  resolve: (outcome: { kind: "answer"; value: unknown; via: "ui" | "voice" } | { kind: "cancelled"; reason: string }) => void;
  cancelNative: () => void;
}

export interface CoordinatorStatus {
  conversation: {
    id: string;
    status: string;
    coordinatorThreadId: string | null;
    providerId: string | null;
    model: string | null;
    hostId: string | null;
    currentCallNonce: string | null;
    revision: number;
    topic: string | null;
    discussedThreadId: string | null;
  } | null;
  requests: { id: string; seq: number; status: string; text: string; delivery: string | null; error: string | null; createdAt: number }[];
  questions: { id: string; question: string; options: string[]; allowFreeText: boolean; status: string; createdAt: number }[];
  pendingInteractions: { id: string; threadId: string; title: string; kind: string }[];
  watch: { threadId: string; reason: string; addedAt: number }[];
  queuedUpdates: number;
  recentReplies: { id: string; kind: string; speech: string; delivery: string; createdAt: number; threadIds: string[] }[];
  conversations: { id: string; createdAt: number; updatedAt: number; status: string; coordinatorThreadId: string | null; current: boolean }[];
}

const REPLY_CHANNEL = "voice-reply";
const INBOX_CHANNEL = "voice-inbox";
const STATUS_CHANNEL = "voice-coordinator";
const QUESTION_RENDERER = "voice-question";

/** Serialize async work per key so concurrent callers share one in-flight run. */
class KeyedLock {
  private chains = new Map<string, Promise<unknown>>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    this.chains.set(key, next);
    const cleanup = () => { if (this.chains.get(key) === next) this.chains.delete(key); };
    next.then(cleanup, cleanup);
    return next;
  }
}

export class CoordinatorManager {
  readonly actions: LiveActionExecutor;
  private readonly bb: BbPluginApi;
  private readonly store: CoordinatorStore;
  private readonly readConfig: () => Promise<CoordinatorConfig>;
  private readonly now: () => number;
  private readonly preferences: () => string;
  private readonly onRequestEnded: (requestId: string) => void;
  private readonly locks = new KeyedLock();
  private readonly questionWaiters = new Map<string, QuestionWaiter>();
  /** Native interaction ids seen for the coordinator that are not ours. */
  private readonly nativeInteractions = new Map<string, { id: string; threadId: string; title: string; kind: string; conversationId: string }>();
  private disposed = false;
  private quickUi: ManagerDeps["quickUi"];
  private quickControllers = new Map<string, AbortController>();

  constructor(deps: ManagerDeps) {
    this.bb = deps.bb;
    this.quickUi = deps.quickUi;
    this.store = deps.store;
    this.readConfig = deps.config;
    this.now = deps.now ?? Date.now;
    this.preferences = deps.preferences ?? (() => "");
    this.onRequestEnded = deps.onRequestEnded ?? (() => {});
    this.actions = new LiveActionExecutor(this.bb, new LiveActionStore(this.bb.storage.database()), {
      watch: (conversationId, threadId) => this.store.watch(conversationId, threadId, "voice-action"),
      isCoordinator: thread => this.isCoordinatorThread(thread),
    });
  }

  dispose() {
    this.disposed = true;
    for (const controller of this.quickControllers.values()) controller.abort();
    for (const [id, waiter] of this.questionWaiters) {
      waiter.resolve({ kind: "cancelled", reason: "plugin-disposed" });
      this.questionWaiters.delete(id);
      try { this.store.updateQuestion(id, { status: "unresolved", cancelReason: "plugin-disposed" }); } catch { /* database may be closed */ }
    }
  }

  // ---- identity ----

  isCoordinatorThread(thread: { id: string; title: string | null }): boolean {
    if (this.store.coordinatorThreadIds().has(thread.id)) return true;
    return typeof thread.title === "string" && thread.title.startsWith(COORDINATOR_TITLE_PREFIX);
  }

  conversationFor(threadId: string): ConversationRow | null {
    return this.store.conversationByCoordinator(threadId);
  }

  // ---- call lifecycle ----

  /**
   * Bind a call to the logical conversation: the last one by default, a fresh
   * one when asked. Re-surfaces unresolved questions and redelivers answers
   * that were submitted but never reached the coordinator.
   */
  async startCall(input: { nonce: string; sequence: number; view: { threadId: string | null; projectId: string | null }; newConversation: boolean; conversationId?: string }): Promise<{ conversationId: string; resumed: boolean; coordinatorThreadId: string | null; queuedUpdates: number }> {
    const currentId = input.conversationId ?? this.store.currentConversationId();
    let conversation = input.newConversation ? null : currentId ? this.store.getConversation(currentId) : null;
    if (conversation && input.newConversation === false && conversation.status !== "active" && conversation.status !== "released") conversation = null;
    const resumed = conversation !== null && conversation.callStartedAt !== null;
    if (!conversation) conversation = this.store.createConversation();
    const ts = this.now();
    conversation = this.store.updateConversation(conversation.id, {
      status: "active",
      currentCallNonce: input.nonce,
      currentCallSequence: input.sequence,
      callStartedAt: ts,
      resumedAt: resumed ? ts : conversation.resumedAt,
      state: { viewedThreadId: input.view.threadId, viewedProjectId: input.view.projectId, openingAnswered: false },
    });
    this.store.setCurrentConversation(conversation.id);
    for (const request of this.store.listRequests(conversation.id, ["quick_running", "quick_unknown"])) {
      if (this.quickControllers.has(request.id)) continue;
      this.store.updateRequest(request.id, {status:"quick_unknown",error:"The previous quick action has no confirmed result. It will not be retried automatically."});
      if (!this.store.listReplies(conversation.id).some(reply => reply.requestId === request.id)) this.recordFailureReply(conversation, request.id, "The previous quick action has no confirmed result. I will not repeat it automatically.");
    }
    // Answers accepted by the UI but never delivered to the coordinator.
    for (const question of this.store.listQuestions(conversation.id, ["submitted"])) {
      await this.deliverStoredAnswer(conversation, question).catch((error) => this.bb.log.warn(`could not redeliver answer ${question.id}: ${String(error)}`));
    }
    // Questions the coordinator asked that were never answered: ask again.
    for (const question of this.store.listQuestions(conversation.id, ["unresolved", "pending"])) {
      if (question.status === "pending" && this.questionWaiters.has(question.id)) continue;
      if (question.status === "pending") this.store.updateQuestion(question.id, { status: "unresolved", cancelReason: "invocation-lost" });
      this.publishReply(this.store.recordReply({
        conversationId: conversation.id,
        requestId: question.requestId,
        batchId: null,
        questionId: question.id,
        kind: "clarification",
        source: "bridge",
        body: { speech: `Earlier, the coordinator asked: ${question.question}${question.options.length ? ` Options: ${question.options.join(", ")}.` : ""}`, detail: null, threadIds: [], receipts: [], focusThreadId: null },
        ready: true,
        delivery: "pending",
        targetCallNonce: input.nonce,
      }));
    }
    this.publishStatus(conversation.id);
    return {
      conversationId: conversation.id,
      resumed,
      coordinatorThreadId: conversation.coordinatorThreadId,
      queuedUpdates: this.store.listUpdates(conversation.id, ["queued"]).length,
    };
  }

  /** Start a separate logical conversation; the previous one keeps finishing its accepted work. */
  async newConversation(): Promise<{ conversationId: string }> {
    const currentId = this.store.currentConversationId();
    if (currentId) {
      const current = this.store.getConversation(currentId);
      if (current?.currentCallNonce) await this.endCall(current.currentCallNonce);
    }
    const conversation = this.store.createConversation();
    this.publishStatus(conversation.id);
    return { conversationId: conversation.id };
  }

  /**
   * The call ended. Accepted requests keep running on the coordinator; open
   * questions are cancelled and preserved as unresolved; the runtime is
   * released once the coordinator settles.
   */
  async endCall(nonce: string, options: { releaseRuntime?: boolean } = {}): Promise<void> {
    const conversation = this.store.listConversations(20).find((row) => row.currentCallNonce === nonce);
    if (!conversation) return;
    this.store.updateConversation(conversation.id, { currentCallNonce: null, currentCallSequence: null });
    for (const [requestId, controller] of this.quickControllers) {
      if (this.store.getRequest(requestId)?.callNonce === nonce) controller.abort();
    }
    // Speech the ended call never heard becomes a queued update for the next call.
    for (const reply of this.store.listReplies(conversation.id, { delivery: ["pending", "held", "generated"] })) {
      if (reply.targetCallNonce !== nonce || !reply.ready) continue;
      this.store.updateReply(reply.id, { delivery: "deferred" });
      if (reply.kind !== "clarification") this.deferReplyToInbox(conversation, reply);
    }
    for (const question of this.store.listQuestions(conversation.id, ["pending"])) {
      const waiter = this.questionWaiters.get(question.id);
      if (waiter) waiter.resolve({ kind: "cancelled", reason: "hangup" });
      else this.store.updateQuestion(question.id, { status: "unresolved", cancelReason: "hangup" });
    }
    if (options.releaseRuntime !== false) await this.releaseIfSettled(conversation.id);
    this.publishStatus(conversation.id);
  }

  /** Release the coordinator runtime when nothing accepted is still running. */
  private async releaseIfSettled(conversationId: string): Promise<void> {
    const conversation = this.store.getConversation(conversationId);
    if (!conversation || conversation.currentCallNonce || !conversation.coordinatorThreadId) return;
    const open = this.store.listRequests(conversationId, ["recorded", "dispatching", "accepted", "dispatch_unknown", "quick_running"]);
    if (open.length > 0) return;
    if (this.store.listQuestions(conversationId, ["pending"]).length > 0) return;
    try {
      const thread = await this.bb.sdk.threads.get({ threadId: conversation.coordinatorThreadId });
      if (thread.status !== "idle" && thread.status !== "error" && thread.status !== "pending") return;
      if (thread.queuedMessageCount > 0) return;
      if (thread.status === "idle") await this.bb.sdk.threads.stop({ threadId: conversation.coordinatorThreadId }).catch(() => undefined);
    } catch (error) {
      this.bb.log.warn(`coordinator release check failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.store.updateConversation(conversationId, { status: "released" });
  }

  // ---- coordinator thread ----

  /** Resolve the personal project, machine, provider, and model for a new coordinator. */
  private async resolveTarget(config: CoordinatorConfig): Promise<{ projectId: string; hostId: string; hostName: string; providerId: string; model: string }> {
    const {personal, host, selected, serviceTiers} = await coordinatorOptions(this.bb, config.providerId, config.model);
    if (config.reasoningLevel && !(selected.supportedReasoningEfforts ?? []).some(option => option.reasoningEffort === config.reasoningLevel)) {
      throw new CoordinatorUnavailableError(`Reasoning effort ${config.reasoningLevel} is not supported by ${selected.displayName}. Update the coordinator settings.`);
    }
    if (config.serviceTier === "fast" && !serviceTiers.some(option => option.id === "fast")) {
      throw new CoordinatorUnavailableError("Fast service is not supported by this coordinator provider.");
    }
    return {projectId:personal.id,hostId:host.id,hostName:host.name,providerId:config.providerId,model:selected.model};
  }

  /**
   * Ensure the conversation has a live coordinator thread. Reconciles a
   * partially completed create before spawning again, so a timeout can never
   * leave two coordinators for one conversation.
   */
  ensureCoordinator(conversationId: string): Promise<{ threadId: string }> {
    return this.locks.run(`coordinator:${conversationId}`, async () => {
      let conversation = this.store.getConversation(conversationId);
      if (!conversation) throw new CoordinatorUnavailableError("Unknown voice conversation.");
      if (conversation.coordinatorThreadId) {
        try {
          const thread = await this.bb.sdk.threads.get({ threadId: conversation.coordinatorThreadId });
          if (!thread.archivedAt && !thread.deletedAt) return { threadId: thread.id };
          this.bb.log.warn(`coordinator ${thread.id} is archived or deleted; creating a replacement`);
        } catch (error) {
          throw new CoordinatorUnavailableError(`The existing coordinator is unreachable; its identity is retained until BB can verify its state: ${error instanceof Error ? error.message : String(error)}`);
        }
        conversation = this.store.updateConversation(conversationId, { coordinatorThreadId: null, coordinatorEnvironmentId: null, createStartedAt: null });
      }
      if (conversation.createStartedAt !== null) {
        const adopted = await this.findExistingCoordinator(conversation);
        if (adopted) {
          this.store.updateConversation(conversationId, { coordinatorThreadId: adopted.id, coordinatorEnvironmentId: adopted.environmentId ?? null });
          this.publishStatus(conversationId);
          return { threadId: adopted.id };
        }
        throw new CoordinatorUnavailableError("The previous coordinator create has no confirmed result. Open BB to check its state before starting a new conversation.");
      }
      const config = await this.readConfig();
      const target = await this.resolveTarget(config);
      this.store.updateConversation(conversationId, {
        createStartedAt: this.now(),
        coordinatorProjectId: target.projectId,
        hostId: target.hostId,
        providerId: target.providerId,
        model: target.model,
      });
      let thread;
      try {
        thread = await this.bb.sdk.threads.spawn({
          projectId: target.projectId,
          environment: { type: "host", hostId: target.hostId, workspace: { type: "personal" } },
          visibility: "hidden",
          title: coordinatorTitle(conversationId),
          providerId: target.providerId,
          model: target.model,
          ...(config.reasoningLevel ? { reasoningLevel: config.reasoningLevel as "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | "ultracode" } : {}),
          serviceTier: config.serviceTier,
          prompt: coordinatorBootstrapPrompt(conversationId),
        });
      } catch (error) {
        // The create may have succeeded server-side; the next attempt reconciles.
        throw new CoordinatorUnavailableError(`The coordinator could not start: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.store.updateConversation(conversationId, { coordinatorThreadId: thread.id, coordinatorEnvironmentId: thread.environmentId ?? null });
      this.store.watch(conversationId, thread.id, "coordinator");
      this.bb.log.info(`voice coordinator ${thread.id} started for ${conversationId} on ${target.hostName} (${target.providerId}/${target.model})`);
      this.publishStatus(conversationId);
      return { threadId: thread.id };
    });
  }

  private async findExistingCoordinator(conversation: ConversationRow) {
    try {
      const threads = await this.bb.sdk.threads.list({
        originPluginId: this.bb.pluginId,
        includeHidden: true,
        ...(conversation.coordinatorProjectId ? { projectId: conversation.coordinatorProjectId } : {}),
        limit: 100,
      });
      return threads.find((thread) => thread.title === coordinatorTitle(conversation.id) && !thread.archivedAt && !thread.deletedAt) ?? null;
    } catch (error) {
      this.bb.log.warn(`coordinator reconcile lookup failed: ${error instanceof Error ? error.message : String(error)}`);
      throw new CoordinatorUnavailableError("The previous coordinator create could not be checked. Retry when BB is reachable; no new coordinator was created.");
    }
  }

  // ---- requests ----

  /**
   * Record a validated request durably, then dispatch it. Idempotent per
   * request id: a retried RPC returns the existing receipt instead of sending
   * twice.
   */
  async submitRequest(envelope: UserRequestEnvelope): Promise<{ requestId: string; status: string; receipt: RequestReceipt | null; error: string | null; coordinatorThreadId: string | null }> {
    const conversation = this.store.getConversation(envelope.conversationId);
    if (!conversation) throw new Error("Unknown voice conversation.");
    if (conversation.currentCallNonce !== envelope.callNonce) throw new Error("Voice call was stopped or replaced.");
    const existing = this.store.getRequest(envelope.requestId);
    if (existing && (existing.callNonce !== envelope.callNonce || existing.conversationId !== envelope.conversationId)) throw new Error("Request identity mismatch.");
    if (existing) return this.receiptOf(existing, conversation);
    let request = this.store.recordRequest(envelope);
    if (!envelope.transcriptAvailable || !envelope.originalText.trim() || envelope.utteranceItemIds.length === 0) {
      const message = "I could not get a complete transcript. Please repeat the request.";
      request = this.store.updateRequest(request.id, { status: "failed", error: message });
      this.recordFailureReply(conversation, request.id, message);
      return this.receiptOf(request, conversation);
    }
    this.store.updateConversation(conversation.id, { state: { viewedThreadId: envelope.view.threadId, viewedProjectId: envelope.view.projectId } });
    // A spoken answer to a live question resolves that question instead of
    // starting a new coordinator turn, but only when it maps unambiguously.
    if (envelope.answersQuestionId) {
      const question = this.store.getQuestion(envelope.answersQuestionId);
      const live = question && question.conversationId === conversation.id && question.status === "pending" ? this.questionWaiters.get(question.id) : undefined;
      if (question && live) {
        const value = this.mapSpokenAnswer(question, envelope.originalText || envelope.interpretation || "");
        this.store.updateQuestion(question.id, { status: "submitted", answer: value, submittedVia: "voice", submittedAt: this.now() });
        live.resolve({ kind: "answer", value, via: "voice" });
        request = this.store.updateRequest(request.id, { status: "settled", receipt: { delivery: "sent", coordinatorThreadId: question.coordinatorThreadId, mode: "answer" }, dispatchedAt: this.now(), settledAt: this.now() });
        this.publishStatus(conversation.id);
        return this.receiptOf(request, conversation);
      }
      if (!question || question.conversationId !== conversation.id || question.status === "delivered" || question.status === "cancelled") {
        // Not the active question: treat the words as an ordinary request.
        this.bb.log.info(`voice request ${envelope.requestId} referenced question ${envelope.answersQuestionId}, which is not open; sending as a normal request`);
      }
    }
    if (envelope.quickAction && !envelope.answersQuestionId && envelope.urgency !== "steer") {
      const action = envelope.quickAction;
      const transcribed = envelope.utteranceItemIds.map(id => envelope.transcriptDelta.find(item => item.itemId === id)?.text);
      if (transcribed.some(text=>!text?.trim()) || transcribed.join(" ").trim() !== envelope.originalText.trim()) {
        request = this.store.updateRequest(request.id, {status:"failed",error:"The quick action requires the full original transcript."});
        this.recordFailureReply(conversation,request.id,"I could not get a complete transcript. Please repeat the request.");
        return this.receiptOf(request,conversation);
      }
      const refusal = quickActionRefusal(action, envelope.originalText);
      if (!refusal) {
        // A second model call for the same utterance must not repeat an effect.
        const duplicate = this.store.priorQuickRequest(envelope);
        if (duplicate || this.store.quickCancelled(envelope.callNonce, envelope.requestId)) {
          request = this.store.updateRequest(request.id, { status: "quick_cancelled", error: "This quick request was cancelled or already handled." });
          return this.receiptOf(request, conversation);
        }
        request = this.store.updateRequest(request.id, { status: "quick_running" });
        void this.runQuickRequest(request, action).catch(error => this.bb.log.warn(`Quick request ${request.id} result could not be published: ${String(error)}`));
        return this.receiptOf(request, conversation);
      }
      this.bb.log.info(`Quick request ${request.id} uses coordinator: ${refusal}`);
    }
    request = await this.dispatchRequest(request);
    return this.receiptOf(request, this.store.getConversation(conversation.id) ?? conversation);
  }

  cancelQuickRequest(conversationId: string, callNonce: string, requestId: string) {
    if (this.store.getConversation(conversationId)?.currentCallNonce !== callNonce) return;
    const request = this.store.getRequest(requestId);
    if (request && (request.conversationId !== conversationId || request.callNonce !== callNonce || request.status !== "quick_running")) return;
    this.store.cancelQuick(callNonce, requestId);
    this.quickControllers.get(requestId)?.abort();
    this.onRequestEnded(requestId);
  }

  private async runQuickRequest(request: RequestRow, action: QuickAction) {
    const controller = new AbortController();
    this.quickControllers.set(request.id, controller);
    const current = () => !this.disposed && !controller.signal.aborted && !this.store.quickCancelled(request.callNonce, request.id)
      && this.store.getConversation(request.conversationId)?.currentCallNonce === request.callNonce;
    let result: ActionResult;
    try {
      result = await this.actions.execute(request.envelope, action, "live", {
        signal: controller.signal, current,
        ui: async (operation, signal) => {
          if (!this.quickUi) throw new Error("Native UI actions are unavailable.");
          return this.quickUi(request.envelope, operation, signal);
        },
        lateResult: value => this.recordLateActionResult(request, value),
      });
    } catch (error) {
      result = {status:"failed",speech:"I could not complete that action.",detail:String(error),threadIds:[],receipts:[]};
    }
    const interrupted = controller.signal.aborted;
    controller.abort("action-settled");
    this.quickControllers.delete(request.id);
    if (this.disposed) return;
    const failed = result.status !== "succeeded";
    this.store.updateRequest(request.id, {status:result.status === "unknown" ? "quick_unknown" : "settled",settledAt:this.now(),error:failed ? result.speech : null});
    this.publishActionResult(request, result, interrupted);
    this.onRequestEnded(request.id);
    this.publishStatus(request.conversationId);
    await this.releaseIfSettled(request.conversationId);
  }

  private publishActionResult(request: RequestRow, result: ActionResult, interrupted: boolean) {
    const conversation = this.store.getConversation(request.conversationId);
    if (!conversation) return;
    const addressed = conversation.currentCallNonce === request.callNonce && !interrupted;
    const reply = this.store.recordReply({conversationId:conversation.id,requestId:request.id,batchId:null,questionId:null,
      kind:result.status === "succeeded" ? "final" : "failure",source:"bridge",
      body:{speech:result.speech,detail:result.detail,threadIds:result.threadIds,receipts:result.receipts,focusThreadId:null},ready:true,
      delivery:addressed ? "pending" : "deferred",targetCallNonce:addressed ? request.callNonce : null});
    if (addressed) this.publishReply(reply);
    else if (result.status === "unknown" || result.receipts.some(receipt=>receipt.outcome === "done" || receipt.outcome === "pending")) this.deferReplyToInbox(conversation,reply);
  }

  private recordLateActionResult(request: RequestRow, result: ActionResult) {
    if (this.disposed) return;
    const recorded = this.actions.store.results(request.id);
    if (this.store.getRequest(request.id)?.status === "quick_unknown" && recorded.length && recorded.every(item=>item && item.status !== "unknown")) {
      this.store.updateRequest(request.id,{status:"settled",error:recorded.some(item=>item?.status !== "succeeded") ? "Some recorded actions did not complete." : null});
    }
    this.publishActionResult(request,{...result,speech:`An earlier action now has a result. ${result.speech}`},false);
    this.publishStatus(request.conversationId);
  }

  /** A coordinator may use the same operator tools only for its accepted user request. */
  async executeCoordinatorAction(threadId: string, requestId: string, action: QuickAction, signal: AbortSignal) {
    const conversation = this.store.conversationByCoordinator(threadId);
    const request = this.store.getRequest(requestId);
    if (!conversation || !request || request.conversationId !== conversation.id || request.status !== "accepted") throw new Error("Actions require an accepted request belonging to this coordinator.");
    if (this.store.listBatches(conversation.id,["reserved","sent"]).length) throw new Error("Background updates do not authorize actions.");
    return this.actions.execute(request.envelope,action,"coordinator",{
      signal,
      current:()=>!this.disposed && !signal.aborted && this.store.getRequest(requestId)?.status === "accepted",
      ui:async (operation, operationSignal)=> {
        if (!this.quickUi) throw new Error("Native UI actions are unavailable.");
        return this.quickUi(request.envelope,operation,operationSignal);
      },
      lateResult:value=>this.recordLateActionResult(request,value),
    });
  }

  private receiptOf(request: RequestRow, conversation: ConversationRow) {
    return { requestId: request.id, status: request.status, receipt: request.receipt, error: request.error, coordinatorThreadId: conversation.coordinatorThreadId };
  }

  /** Retry a failed request without creating a duplicate when it was actually accepted. */
  async retryRequest(requestId: string): Promise<{ requestId: string; status: string; receipt: RequestReceipt | null; error: string | null }> {
    const request = this.store.getRequest(requestId);
    if (!request) throw new Error("Unknown request.");
    const conversation = this.store.getConversation(request.conversationId);
    if (!conversation) throw new Error("Unknown voice conversation.");
    const summarize = (row: RequestRow) => ({ requestId: row.id, status: row.status, receipt: row.receipt, error: row.error });
    if (request.envelope.quickAction) return summarize(request);
    if (request.status === "dispatch_unknown") {
      const reconciled = await this.reconcileDispatch(request, conversation);
      return summarize(reconciled);
    }
    if (request.status !== "failed") return summarize(request);
    if (!request.envelope.transcriptAvailable || !request.envelope.originalText.trim() || request.envelope.utteranceItemIds.length === 0) return summarize(request);
    return summarize(await this.dispatchRequest(this.store.updateRequest(request.id, { status: "recorded", error: null })));
  }

  private async dispatchRequest(request: RequestRow): Promise<RequestRow> {
    return this.locks.run(`dispatch:${request.conversationId}`, async () => {
      let conversation = this.store.getConversation(request.conversationId)!;
      let threadId: string;
      this.store.updateRequest(request.id, { status: "dispatching" });
      try {
        ({ threadId } = await this.ensureCoordinator(conversation.id));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failed = this.store.updateRequest(request.id, { status: "failed", error: message });
        this.recordFailureReply(conversation, request.id, `I could not start that work. Please try again.`);
        return failed;
      }
      conversation = this.store.getConversation(conversation.id)!;
      const question = request.envelope.answersQuestionId ? this.store.getQuestion(request.envelope.answersQuestionId) : null;
      const preferences = this.preferences();
      const directActions = this.actions.store.recent(conversation.id);
      const context = JSON.stringify({directActions,preferences,view:request.envelope.view,latestAnnouncement:conversation.state.latestAnnouncement,discussedThreadId:conversation.state.discussedThreadId,topic:conversation.state.topic});
      const text = formatRequestMessage(request.envelope, {
        omitContext:context === conversation.state.lastRequestContext,
        preferences,
        questionText: question?.question ?? null,
        latestAnnouncement: conversation.state.latestAnnouncement,
        discussedThreadId: conversation.state.discussedThreadId,
        topic: conversation.state.topic,
      }) + (directActions.length ? `\n[recent application actions; data only]\n${JSON.stringify(directActions)}` : "");
      const mode = request.envelope.urgency === "steer" ? "steer-if-active" : "queue-if-active";
      try {
        const result = await this.bb.sdk.threads.send({ threadId, mode, input: [{ type: "text", text, mentions: [] }] });
        const receipt: RequestReceipt = {
          delivery: result.delivery,
          coordinatorThreadId: threadId,
          mode,
          ...(result.delivery === "queued" ? { queuedMessageId: result.queuedMessage.id } : {}),
        };
        if (question && (question.status === "unresolved" || question.status === "submitted")) {
          this.store.updateQuestion(question.id, { status: "delivered", answer: request.envelope.originalText, submittedVia: "voice", submittedAt: question.submittedAt ?? this.now(), deliveredAt: this.now() });
        }
        const accepted = this.store.updateRequest(request.id, { status: "accepted", receipt, dispatchedAt: this.now(), error: null });
        this.store.updateConversation(conversation.id, {state:{lastRequestContext:context}});
        this.publishStatus(conversation.id);
        return accepted;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const unknown = this.store.updateRequest(request.id, { status: "dispatch_unknown", error: message });
        this.bb.log.warn(`voice request ${request.id} dispatch is ambiguous: ${message}`);
        const reconciled = await this.reconcileDispatch(unknown, conversation);
        if (reconciled.status !== "accepted") {
          this.recordFailureReply(conversation, request.id, "I could not confirm whether the coordinator received your request. Retry will check delivery without sending it again. Open the coordinator to inspect its state.");
        }
        return reconciled;
      }
    });
  }

  /**
   * After an ambiguous send, look for the request marker in the coordinator's
   * history before any retry. Found means accepted. A missing marker or a
   * lookup error cannot prove non-delivery, so neither permits another send.
   */
  private async reconcileDispatch(request: RequestRow, conversation: ConversationRow): Promise<RequestRow> {
    const threadId = conversation.coordinatorThreadId;
    if (!threadId) return request;
    const marker = `[voice request ${request.id}]`;
    try {
      const queued = await this.bb.sdk.threads.queuedMessages.list({ threadId });
      const queuedMatch = queued.find((entry) => JSON.stringify(entry.content).includes(marker));
      if (queuedMatch) {
        return this.store.updateRequest(request.id, { status: "accepted", error: null, dispatchedAt: this.now(), receipt: { delivery: "queued", coordinatorThreadId: threadId, mode: "reconciled", queuedMessageId: queuedMatch.id } });
      }
      const timeline = await this.bb.sdk.threads.timeline({ threadId, segmentLimit: "20" });
      if (JSON.stringify(timeline).includes(marker)) {
        return this.store.updateRequest(request.id, { status: "accepted", error: null, dispatchedAt: this.now(), receipt: { delivery: "sent", coordinatorThreadId: threadId, mode: "reconciled" } });
      }
      return request;
    } catch (error) {
      this.bb.log.warn(`voice request ${request.id} reconcile failed: ${error instanceof Error ? error.message : String(error)}`);
      return request;
    }
  }

  private recordFailureReply(conversation: ConversationRow, requestId: string | null, speech: string) {
    const reply = this.store.recordReply({
      conversationId: conversation.id,
      requestId,
      batchId: null,
      questionId: null,
      kind: "failure",
      source: "bridge",
      body: { speech, detail: null, threadIds: [], receipts: [], focusThreadId: null },
      ready: true,
      delivery: conversation.currentCallNonce ? "pending" : "deferred",
      targetCallNonce: conversation.currentCallNonce,
    });
    if (conversation.currentCallNonce) this.publishReply(reply);
    else this.deferReplyToInbox(conversation, reply);
    this.publishStatus(conversation.id);
  }

  // ---- replies (voice_reply tool) ----

  /** Recover pre-operator receipts without reviving the retired send path. */
  private async recoverLegacySend(threadId: string, request: RequestRow): Promise<boolean> {
    const record = this.store.getMessageSend(request.id);
    if (!record) return false;
    if (record.status === "sending") {
      record.status = "unknown";
      record.receipt = {action:"send_message",thread_id:record.threadId,outcome:"unknown",note:"The earlier send has no confirmed result; do not resend."};
      this.store.putMessageSend(request.id,record);
    }
    await this.recordReply(threadId,{request_id:request.id,kind:"final",
      speech:record.status === "unknown" ? "I could not confirm message delivery. I will not send it again automatically." : `Your message is ${record.status === "queued" ? "queued" : "sent"}.`,
      thread_ids:[record.threadId],receipts:record.receipt ? [record.receipt] : []});
    return true;
  }

  /** A tool result is more reliable than trailing coordinator text after dispatch. */
  private async recoverActionReply(threadId: string, request: RequestRow): Promise<boolean> {
    if (!this.actions.store.hasGroup(request.id)) return false;
    if (this.actions.isRunning(request.id)) return true;
    const unknown: ActionResult = {status:"unknown",speech:"An earlier action has no confirmed result. I have not repeated it.",detail:"Inspect the recorded action before retrying.",threadIds:[],receipts:[{action:"voice_actions",outcome:"unknown"}]};
    const saved = this.actions.store.results(request.id);
    const result = combineResults(saved.length ? saved.map(value => value ?? unknown) : [unknown]);
    await this.recordReply(threadId,{request_id:request.id,kind:"final",speech:result.speech,
      detail:result.detail,thread_ids:result.threadIds,receipts:result.receipts});
    return true;
  }

  async recordReply(callingThreadId: string, params: VoiceReplyParams): Promise<PluginAgentToolResult> {
    const conversation = this.store.conversationByCoordinator(callingThreadId);
    if (!conversation || conversation.coordinatorThreadId !== callingThreadId) {
      return { content: [{ type: "text", text: "voice_reply is only available to the Voice Mode coordinator thread." }], isError: true };
    }
    const bootstrap = params.request_id === "bootstrap";
    let requestId: string | null = null;
    if (!bootstrap && params.request_id) {
      const match = this.store.getRequest(params.request_id);
      if (match && match.conversationId === conversation.id) requestId = match.id;
      else return "Unknown request: do not attach late output to another request.";
    }
    let batchId: string | null = null;
    if (params.batch_id) {
      const batch = this.store.getBatch(params.batch_id);
      if (batch && batch.conversationId === conversation.id && batch.status === "sent") batchId = batch.id;
      else return "This batch is no longer waiting for a reply; keep late output internal.";
    }
    const request = requestId ? this.store.getRequest(requestId) : null;
    if (requestId && this.actions.isRunning(requestId)) return "Actions are still pending. Wait for their recorded results before replying.";
    if (!bootstrap && !requestId && !batchId) return "No active request or batch: keep this intermediate text internal.";
    if (params.sequence && (params.kind !== "final" || !request || request.status !== "accepted" || batchId || !conversation.currentCallNonce || request.callNonce !== conversation.currentCallNonce || params.speech.trim())) {
      return {content:[{type:"text",text:"A sequence requires a final reply for this call's active request, with empty speech. Put each spoken message in a speech step."}],isError:true};
    }
    const debugRequested = /debug|diagnos|troubleshoot|coordinator.*(?:log|status|work)/i.test(request?.envelope.originalText ?? "");
    const routingNoise = /\bcoordinator[’']?s?\b|\b(?:internal RPC|model routing|delegation plumbing)\b/i.test(params.speech);
    const internal = params.kind === "silent" || (!batchId && params.kind === "assigned");
    if (!debugRequested && routingNoise && !internal) {
      return {content:[{type:"text",text:"Hide internal plumbing, not user-relevant actions. Announce the real destination and scope using final; do not narrate coordinator internals."}],isError:true};
    }
    if (batchId && params.kind === "assigned") return "Assignment is internal. Use silent for this batch, or report a material result.";
    const previousReplies = requestId ? this.store.listReplies(conversation.id,{requestId}) : [];
    if (request?.status === "settled" && !conversation.state.activeTasks.some(task=>task.requestId === request.id)) return "This request has ended; do not open another reply turn.";
    if (previousReplies.some(reply => reply.kind === "final")) return "A final reply is already recorded; this request has ended.";
    if (params.kind === "assigned" && previousReplies.some(reply=>reply.kind === "assigned")) return "Assignment already reported.";
    if (params.kind === "blocked" && previousReplies.some(reply=>reply.kind === "blocked" && reply.body.speech === params.speech)) return "This blocker was already reported.";
    if (params.kind === "assigned" && !(params.receipts ?? []).some(receipt=>receipt.thread_id && (receipt.outcome === "done" || receipt.outcome === "pending"))) return "Assignment requires an actual thread receipt.";
    if (requestId && params.kind === "final" && this.store.listReplies(conversation.id, { requestId }).some(r => r.kind === "final")) return "A final reply is already recorded for this request.";

    // State and watch changes are data about the conversation, not new instructions.
    const threadIds = uniqueIds([...(params.thread_ids ?? []), ...(params.receipts ?? []).map((receipt) => receipt.thread_id).filter((id): id is string => !!id)]);
    const statePatch: Record<string, unknown> = {};
    if (params.state?.topic) statePatch.topic = params.state.topic;
    if (params.state?.discussed_thread_id) statePatch.discussedThreadId = params.state.discussed_thread_id;
    if (params.state?.authorized_scope) statePatch.authorizedScopes = [...conversation.state.authorizedScopes, params.state.authorized_scope].slice(-50);
    for (const id of params.state?.watch_add ?? []) this.store.watch(conversation.id, id, "requested");
    for (const id of threadIds) if (!this.store.isWatched(conversation.id, id)) this.store.watch(conversation.id, id, "discussed");
    for (const id of params.state?.watch_remove ?? []) this.store.unwatch(conversation.id, id);
    const pendingReceipts = (params.receipts ?? []).filter((receipt) => receipt.outcome === "pending" || (params.kind === "assigned" && receipt.outcome === "done"));
    if (request && pendingReceipts.length > 0) {
      const tasks = conversation.state.activeTasks.filter((task) => task.requestId !== request.id);
      for (const receipt of pendingReceipts) if (receipt.thread_id) statePatch.threadStates = {...conversation.state.threadStates,...(statePatch.threadStates as object ?? {}),[receipt.thread_id]:""};
      tasks.push({ requestId: request.id, summary: truncateSpeech(request.envelope.originalText || request.envelope.interpretation || "request", 300), threadIds: uniqueIds(pendingReceipts.map((receipt) => receipt.thread_id ?? "")) });
      statePatch.activeTasks = tasks.slice(-50);
    }
    if (request && params.kind === "final") statePatch.activeTasks = conversation.state.activeTasks.filter(task=>task.requestId !== request.id);
    this.store.updateConversation(conversation.id, { state: statePatch });

    const body: StoredReply = {
      speech: truncateSpeech(params.speech, 1200),
      ...(params.sequence ? {sequence:params.sequence} : {}),
      detail: params.detail ?? null,
      threadIds,
      receipts: params.receipts ?? [],
      focusThreadId: null,
    };
    if (params.kind === "assigned" && !batchId) {
      const progress = this.store.recordReply({ conversationId: conversation.id, requestId, batchId, questionId: null, kind: params.kind, source: "tool", body, ready: true, delivery: "silent", targetCallNonce: conversation.currentCallNonce });
      this.publishStatus(conversation.id);
      return `Recorded ${params.kind} ${progress.id} internally. Work quietly; report only a material blocker or changed results.`;
    }
    if (bootstrap || params.kind === "silent") {
      const silent = this.store.recordReply({ conversationId: conversation.id, requestId, batchId, questionId: null, kind: "silent", source: "tool", body, ready: true, delivery: "silent", targetCallNonce: conversation.currentCallNonce });
      if (batchId) { this.store.setBatchStatus(batchId, "answered"); this.markBatchUpdates(batchId, "skipped"); }
      if (requestId && params.kind === "silent") this.settleRequest(requestId, silent.id);
      this.publishStatus(conversation.id);
      return `Recorded silent reply ${silent.id}.`;
    }
    let questionId: string | null = null;
    if (params.kind === "clarification") {
      // A question asked without voice_ask has no live invocation: the answer
      // arrives as the next request and is delivered as a message.
      const question = this.store.createQuestion({ conversationId: conversation.id, requestId, coordinatorThreadId: callingThreadId, question: body.speech, options: [], allowFreeText: true });
      this.store.updateQuestion(question.id, { status: "unresolved", cancelReason: "asked-without-invocation" });
      this.store.updateConversation(conversation.id, { state: { unresolvedQuestionId: question.id } });
      questionId = question.id;
    }
    const kind = batchId ? "update" : params.kind;
    const addressedCall = this.callForReply(conversation, request, batchId);
    const ready = true;
    const reply = this.store.recordReply({
      conversationId: conversation.id,
      requestId,
      batchId,
      questionId,
      kind,
      source: "tool",
      body,
      ready,
      delivery: addressedCall ? "pending" : "deferred",
      targetCallNonce: addressedCall,
    });
    if (request && kind === "final") this.settleRequest(request.id, reply.id);
    if (batchId) this.store.setBatchStatus(batchId, "answered");
    if (!addressedCall && ready) this.deferReplyToInbox(conversation, reply);
    else if (ready) this.publishReply(reply);
    if (request && kind === "final") {
      this.bb.log.info(`voice reply ${reply.id} committed for ${request.id}; ready for playback`);
    }
    this.publishStatus(conversation.id);
    return `Recorded ${kind} reply ${reply.id}.${kind === "final" ? " This request is complete. Do not repeat its actions or reply again." : ""}`;
  }

  private callForReply(conversation: ConversationRow, request: RequestRow | null, batchId: string | null): string | null {
    if (!conversation.currentCallNonce) return null;
    if (request && request.callNonce !== conversation.currentCallNonce) return null;
    if (batchId) return conversation.currentCallNonce;
    return conversation.currentCallNonce;
  }

  /** A reply that cannot be spoken into the current call becomes a queued update. */
  private deferReplyToInbox(conversation: ConversationRow, reply: ReplyRow) {
    if (!reply.body.speech) return;
    const request = reply.requestId ? this.store.getRequest(reply.requestId) : null;
    const title = request ? `Result for "${truncateSpeech(request.envelope.originalText || request.envelope.interpretation || "an earlier request", 60)}"` : "Coordinator result";
    this.store.enqueueUpdate({
      conversationId: conversation.id,
      threadId: reply.body.threadIds[0] ?? conversation.coordinatorThreadId ?? "coordinator",
      title,
      kind: reply.kind === "failure" ? "failed" : "result",
      fingerprint: `reply:${reply.id}`,
      detail: reply.body.speech,
    });
  }

  private publishReply(reply: ReplyRow) {
    const payload: PublishedReply = {
      v: ENVELOPE_VERSION,
      replyId: reply.id,
      conversationId: reply.conversationId,
      seq: reply.seq,
      requestId: reply.requestId,
      batchId: reply.batchId,
      questionId: reply.questionId,
      kind: reply.kind as PublishedReply["kind"],
      source: reply.source,
      speech: reply.body.speech,
      detail: reply.body.detail,
      threadIds: reply.body.threadIds,
      receipts: reply.body.receipts,
      targetCallNonce: reply.targetCallNonce,
      createdAt: reply.createdAt,
      ...(reply.body.sequence ? {sequence:reply.body.sequence} : {}),
    };
    this.bb.realtime.publish(REPLY_CHANNEL, payload);
  }

  /** Replies the current call has not yet reported as delivered, for a reconnecting client. */
  pendingReplies(conversationId: string, callNonce: string): PublishedReply[] {
    return this.store
      .listReplies(conversationId, { ready: true, delivery: ["pending", "held", "generated"] })
      .filter((reply) => reply.targetCallNonce === callNonce)
      .map((reply) => ({
        v: ENVELOPE_VERSION,
        replyId: reply.id,
        conversationId: reply.conversationId,
        seq: reply.seq,
        requestId: reply.requestId,
        batchId: reply.batchId,
        questionId: reply.questionId,
        kind: reply.kind as PublishedReply["kind"],
        source: reply.source,
        speech: reply.body.speech,
        detail: reply.body.detail,
        threadIds: reply.body.threadIds,
        receipts: reply.body.receipts,
        targetCallNonce: reply.targetCallNonce,
        createdAt: reply.createdAt,
      ...(reply.body.sequence ? {sequence:reply.body.sequence} : {}),
      }));
  }

  /** The bridge reports what the user actually heard. */
  reportDelivery(replyId: string, state: "generated" | "playing" | "delivered" | "interrupted" | "partial" | "held" | "superseded" | "mismatch", callNonce: string): void {
    const reply = this.store.getReply(replyId);
    if (!reply || reply.body.sequence) return;
    if (reply.targetCallNonce && reply.targetCallNonce !== callNonce) {
      this.bb.log.warn(`reply ${replyId} delivery report from call ${callNonce} ignored (addressed to ${reply.targetCallNonce})`);
      return;
    }
    const updated = this.store.updateReply(replyId, { delivery: state });
    const conversation = this.store.getConversation(reply.conversationId);
    if (!conversation) return;
    const heard = state === "delivered" || state === "partial" || state === "interrupted";
    if (heard && (reply.kind === "update" || reply.kind === "final" || reply.kind === "assigned" || reply.kind === "blocked") && reply.body.speech) {
      const statePatch: Record<string, unknown> = { latestAnnouncement: { replyId: reply.id, threadIds: reply.body.threadIds, text: reply.body.speech, delivery: state } };
      if (reply.kind !== "update" && reply.requestId && conversation.currentCallNonce === callNonce) statePatch.openingAnswered = true;
      this.store.updateConversation(conversation.id, { state: statePatch });
    }
    if (reply.batchId) {
      if (state === "delivered") this.markBatchUpdates(reply.batchId, "delivered");
      else if (state === "interrupted" || state === "superseded") this.markBatchUpdates(reply.batchId, "queued");
      else if (state === "partial") this.markBatchUpdates(reply.batchId, "delivered");
    }
    void updated;
    this.publishStatus(conversation.id);
  }

  private markBatchUpdates(batchId: string, status: "delivered" | "skipped" | "queued") {
    const conversation = this.store.getBatch(batchId)?.conversationId;
    if (!conversation) return;
    const rows = this.store.listUpdates(conversation, ["reserved", "delivered", "queued"], 500).filter((row) => row.batchId === batchId);
    this.store.setUpdatesStatus(rows.map((row) => row.id), status, batchId);
    if (status === "delivered" && conversation) {
      const completed = new Set(rows.filter(row=>row.kind === "idle").map(row=>row.threadId));
      const current = this.store.getConversation(conversation);
      if (current) this.store.updateConversation(conversation,{state:{activeTasks:current.state.activeTasks.map(task=>({...task,threadIds:task.threadIds.filter(id=>!completed.has(id))})).filter(task=>task.threadIds.length>0)}});
    }
  }

  // ---- questions (voice_ask tool) ----

  async ask(callingThreadId: string, params: VoiceAskParams, signal: AbortSignal): Promise<PluginAgentToolResult> {
    const conversation = this.store.conversationByCoordinator(callingThreadId);
    if (!conversation || conversation.coordinatorThreadId !== callingThreadId) {
      return { content: [{ type: "text", text: "voice_ask is only available to the Voice Mode coordinator thread." }], isError: true };
    }
    const open = this.store.listRequests(conversation.id, ["accepted", "dispatch_unknown"]);
    const request = (params.request_id ? this.store.getRequest(params.request_id) : null) ?? open[0] ?? null;
    const question = this.store.createQuestion({
      conversationId: conversation.id,
      requestId: request?.id ?? null,
      coordinatorThreadId: callingThreadId,
      question: params.question,
      options: params.options ?? [],
      allowFreeText: params.allow_free_text,
    });
    this.store.updateConversation(conversation.id, { state: { unresolvedQuestionId: question.id } });
    if (!conversation.currentCallNonce) {
      // Nobody is on the call: keep the question for the next resume.
      this.store.updateQuestion(question.id, { status: "unresolved", cancelReason: "no-active-call" });
      this.publishStatus(conversation.id);
      return "No answer: the voice call has ended. Do not guess. End your turn now; the question will be re-asked when the user returns.";
    }
    const reply = this.store.recordReply({
      conversationId: conversation.id,
      requestId: request?.id ?? null,
      batchId: null,
      questionId: question.id,
      kind: "clarification",
      source: "tool",
      body: { speech: `${params.question}${params.options?.length ? ` ${params.options.join(", or ")}?` : ""}`, detail: null, threadIds: [], receipts: [], focusThreadId: null },
      ready: true,
      delivery: "pending",
      targetCallNonce: conversation.currentCallNonce,
    });
    this.publishReply(reply);
    this.bb.realtime.publish("voice-question", { conversationId: conversation.id, question: this.describeQuestion(question) });
    this.publishStatus(conversation.id);

    const nativeController = new AbortController();
    const outcome = await new Promise<Parameters<QuestionWaiter["resolve"]>[0]>((resolve) => {
      let settled = false;
      const settle = (value: Parameters<QuestionWaiter["resolve"]>[0]) => { if (settled) return; settled = true; resolve(value); };
      this.questionWaiters.set(question.id, { resolve: settle, cancelNative: () => nativeController.abort() });
      signal.addEventListener("abort", () => settle({ kind: "cancelled", reason: "invocation-aborted" }), { once: true });
      // The native form keeps a real pending interaction alive for the app's
      // UI. It outlives this invocation on purpose: a submission that lands
      // after the tool call was torn down is stored and redelivered, never lost.
      this.bb.ui
        .requestInput(
          { threadId: callingThreadId, rendererId: QUESTION_RENDERER, title: params.question, payload: { questionId: question.id, question: params.question, options: params.options ?? [], allowFreeText: params.allow_free_text }, timeoutMs: 3_600_000 },
          { signal: nativeController.signal },
        )
        .then((result) => {
          if (result.outcome === "submitted") {
            if (!settled) { settle({ kind: "answer", value: result.value, via: "ui" }); return; }
            void this.acceptLateAnswer(question.id, result.value);
          } else if (result.reason !== "request-aborted") {
            settle({ kind: "cancelled", reason: result.reason });
          }
        })
        .catch((error) => { if (!nativeController.signal.aborted) settle({ kind: "cancelled", reason: `native:${error instanceof Error ? error.message : String(error)}` }); });
      void this.recordInteractionId(callingThreadId, question.id);
    });
    this.questionWaiters.delete(question.id);
    if (outcome.kind === "answer") {
      if (outcome.via === "ui") nativeController.abort();
      else this.cancelNativeQuestion(question.id, callingThreadId, nativeController);
      const current = this.store.getQuestion(question.id)!;
      if (current.status !== "submitted") this.store.updateQuestion(question.id, { status: "submitted", answer: outcome.value, submittedVia: outcome.via, submittedAt: this.now() });
      if (signal.aborted) {
        // The UI accepted the answer, but this invocation is gone: keep it for redelivery.
        this.publishStatus(conversation.id);
        return "The answer arrived after this call was torn down; it will be redelivered.";
      }
      this.store.updateQuestion(question.id, { status: "delivered", deliveredAt: this.now() });
      this.store.updateConversation(conversation.id, { state: { unresolvedQuestionId: null } });
      this.publishStatus(conversation.id);
      return `User answered (${outcome.via === "voice" ? "by voice" : "in the app"}): ${JSON.stringify(outcome.value)}`;
    }
    const current = this.store.getQuestion(question.id)!;
    if (current.status === "submitted") {
      nativeController.abort();
      this.publishStatus(conversation.id);
      return "The answer arrived after this call was torn down; it will be redelivered.";
    }
    if (outcome.reason === "user") {
      nativeController.abort();
      this.store.updateQuestion(question.id, { status: "cancelled", cancelReason: "user" });
      this.store.updateConversation(conversation.id, { state: { unresolvedQuestionId: null } });
      this.publishStatus(conversation.id);
      return "The user dismissed the question without answering. Do not guess. Ask again only if the request cannot proceed; otherwise end your turn.";
    }
    // Hangup and runtime stop cancel the native row explicitly; a torn-down
    // invocation leaves it open so a late submission can still be delivered.
    if (outcome.reason !== "invocation-aborted") nativeController.abort();
    this.store.updateQuestion(question.id, { status: "unresolved", cancelReason: outcome.reason });
    this.publishStatus(conversation.id);
    return "No answer: the voice call ended or the question was interrupted before the user answered. Do not guess. End your turn now; the question will be re-asked when the user returns.";
  }

  /** A form submission that arrived after its tool invocation ended. */
  private async acceptLateAnswer(questionId: string, value: unknown): Promise<void> {
    const question = this.store.getQuestion(questionId);
    if (!question || question.status === "delivered" || question.status === "cancelled") return;
    this.store.updateQuestion(questionId, { status: "submitted", answer: value, submittedVia: "ui", submittedAt: this.now() });
    const conversation = this.store.getConversation(question.conversationId);
    if (!conversation) return;
    try {
      await this.deliverStoredAnswer(conversation, this.store.getQuestion(questionId)!);
    } catch (error) {
      // Stays "submitted"; the next call start redelivers it.
      this.bb.log.warn(`late answer ${questionId} could not be delivered yet: ${error instanceof Error ? error.message : String(error)}`);
      this.publishStatus(conversation.id);
    }
  }

  private async recordInteractionId(threadId: string, questionId: string) {
    try {
      const interactions = await this.bb.sdk.threads.interactions.list({ threadId });
      const match = interactions.find((interaction) => interaction.status === "pending" && interaction.origin?.kind === "plugin" && interaction.origin.pluginId === this.bb.pluginId && interaction.payload.kind === "plugin" && (interaction.payload.data as { questionId?: string } | null)?.questionId === questionId);
      if (match) this.store.updateQuestion(questionId, { interactionId: match.id });
    } catch {
      /* the native row is optional bookkeeping */
    }
  }

  private cancelNativeQuestion(questionId: string, threadId: string, controller?: AbortController) {
    const question = this.store.getQuestion(questionId);
    const waiter = this.questionWaiters.get(questionId);
    waiter?.cancelNative();
    controller?.abort();
    if (!question?.interactionId) return;
    void this.bb.sdk.threads.interactions.cancel({ threadId, interactionId: question.interactionId }).catch(() => undefined);
  }

  /** Map spoken words to the question's schema; free text when options do not match. */
  private mapSpokenAnswer(question: QuestionRow, text: string): unknown {
    const normalized = text.trim().toLowerCase();
    const option = question.options.find((candidate) => candidate.toLowerCase() === normalized || normalized.includes(candidate.toLowerCase()));
    if (option) return option;
    return text.trim();
  }

  /** Answer from the Voice page form or a stored answer path. */
  async answerQuestion(questionId: string, value: unknown, via: "ui" | "voice"): Promise<{ status: string }> {
    const question = this.store.getQuestion(questionId);
    if (!question) throw new Error("Unknown question.");
    const live = this.questionWaiters.get(questionId);
    if (question.status === "pending" && live) {
      this.store.updateQuestion(questionId, { status: "submitted", answer: value, submittedVia: via, submittedAt: this.now() });
      live.resolve({ kind: "answer", value, via });
      return { status: "submitted" };
    }
    if (question.status === "unresolved" || question.status === "pending") {
      const conversation = this.store.getConversation(question.conversationId);
      if (!conversation) throw new Error("Unknown voice conversation.");
      this.store.updateQuestion(questionId, { status: "submitted", answer: value, submittedVia: via, submittedAt: this.now() });
      await this.deliverStoredAnswer(conversation, this.store.getQuestion(questionId)!);
      return { status: "delivered" };
    }
    throw new Error(`Question is ${question.status}.`);
  }

  /** Deliver a stored answer as a message when no live invocation waits for it. */
  private async deliverStoredAnswer(conversation: ConversationRow, question: QuestionRow): Promise<void> {
    const { threadId } = await this.ensureCoordinator(conversation.id);
    const text = `[voice answer ${question.id}]\nThe user answered your earlier question ${JSON.stringify(question.question)}: ${JSON.stringify(question.answer)}\nContinue the request; reply with voice_reply${question.requestId ? ` (request_id "${question.requestId}")` : ""}.`;
    await this.bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text, mentions: [] }] });
    this.store.updateQuestion(question.id, { status: "delivered", deliveredAt: this.now() });
    this.store.updateConversation(conversation.id, { state: { unresolvedQuestionId: null } });
    if (question.requestId) {
      const request = this.store.getRequest(question.requestId);
      if (request && request.status === "settled") this.store.updateRequest(request.id, { status: "accepted", settledAt: null });
    }
    this.publishStatus(conversation.id);
  }

  private describeQuestion(question: QuestionRow) {
    return { id: question.id, question: question.question, options: question.options, allowFreeText: question.allowFreeText, status: question.status, createdAt: question.createdAt };
  }

  // ---- coordinator events ----

  async onCoordinatorIdle(threadId: string, thread: { queuedMessageCount: number }, lastAssistantText: string | null): Promise<void> {
    const conversation = this.store.conversationByCoordinator(threadId);
    if (!conversation) return;
    await this.locks.run(`settle:${conversation.id}`, async () => {
      const accepted = this.store.listRequests(conversation.id, ["accepted"]);
      // Requests still queued behind this turn run next; settle the rest.
      const queuedRequests = accepted.filter((request) => request.receipt?.delivery === "queued");
      const keep = Math.max(0, Math.min(thread.queuedMessageCount, queuedRequests.length));
      const stillQueued = new Set(keep === 0 ? [] : queuedRequests.slice(-keep).map((request) => request.id));
      // Compatibility for final replies persisted by versions that waited for idle.
      for (const reply of this.store.listReplies(conversation.id, { ready: false })) {
        if (reply.kind !== "final" || (reply.requestId && stillQueued.has(reply.requestId))) continue;
        const ready = this.store.updateReply(reply.id, { ready: true });
        if (ready.targetCallNonce && ready.delivery === "pending") this.publishReply(ready);
        else if (ready.delivery === "deferred") this.deferReplyToInbox(conversation, ready);
      }
      for (const request of accepted) {
        if (stillQueued.has(request.id)) continue;
        if (await this.recoverLegacySend(threadId, request) || await this.recoverActionReply(threadId, request)) continue;
        const replies = this.store.listReplies(conversation.id, { requestId: request.id }).filter((reply) => reply.createdAt >= (request.dispatchedAt ?? 0) && reply.source !== "bridge");
        if (!replies.some(reply => reply.kind !== "progress")) this.fallbackReply(conversation, request, lastAssistantText);
        if (request.callNonce === conversation.currentCallNonce && replies.some(reply => reply.kind === "assigned")) {
          // Assignment is intentionally silent. Its later result must still be
          // eligible for a digest, under the full client speech/playback gate.
          this.store.updateConversation(conversation.id, { state: { openingAnswered: true } });
        }
        this.settleRequest(request.id, null);
      }
      for (const batch of this.store.listBatches(conversation.id, ["sent"])) {
        this.store.setBatchStatus(batch.id, "answered");
        this.markBatchUpdates(batch.id, "skipped");
      }
      this.publishStatus(conversation.id);
    });
    await this.releaseIfSettled(conversation.id);
  }

  private settleRequest(requestId: string, replyId: string | null) {
    const request = this.store.getRequest(requestId);
    if (!request || request.status === "settled") return;
    this.store.updateRequest(requestId, { status: "settled", settledAt: this.now() });
    this.onRequestEnded(requestId);
    void replyId;
  }

  /** Bounded fallback when a turn ended without any structured reply. */
  private fallbackReply(conversation: ConversationRow, request: RequestRow, lastAssistantText: string | null) {
    const text = "I did not receive a result for that request.";
    const current = this.store.getConversation(conversation.id) ?? conversation;
    const addressed = current.currentCallNonce && request.callNonce === current.currentCallNonce ? current.currentCallNonce : null;
    const reply = this.store.recordReply({
      conversationId: conversation.id,
      requestId: request.id,
      batchId: null,
      questionId: null,
      kind: "final",
      source: "fallback",
      body: { speech: text, detail: lastAssistantText, threadIds: [], receipts: [], focusThreadId: null },
      ready: true,
      delivery: addressed ? "pending" : "deferred",
      targetCallNonce: addressed,
    });
    if (addressed) this.publishReply(reply);
    else this.deferReplyToInbox(current, reply);
  }

  async onCoordinatorFailed(threadId: string, error: string | null, rateLimitHint: string | null): Promise<void> {
    const conversation = this.store.conversationByCoordinator(threadId);
    if (!conversation) return;
    const open = this.store.listRequests(conversation.id, ["accepted", "dispatching", "dispatch_unknown"]);
    const failed: RequestRow[] = [];
    for (const request of open) {
      if (await this.recoverLegacySend(threadId, request) || await this.recoverActionReply(threadId, request)) continue;
      failed.push(request);
      this.store.updateRequest(request.id, { status: "failed", error: error ?? "coordinator failed" });
      this.onRequestEnded(request.id);
    }
    for (const batch of this.store.listBatches(conversation.id, ["sent"])) {
      this.store.setBatchStatus(batch.id, "failed");
      this.markBatchUpdates(batch.id, "queued");
    }
    if (failed.length > 0) this.recordFailureReply(conversation, failed[0].id, `I could not finish that request. Please try again.`);
    await this.releaseIfSettled(conversation.id);
  }

  /** A native (non-plugin) interaction on the coordinator needs the user. */
  onCoordinatorInteraction(threadId: string, interaction: { id: string; status: string; payload: { title: string; kind: string }; origin?: { kind: string; pluginId?: string } }): void {
    const conversation = this.store.conversationByCoordinator(threadId);
    if (!conversation) return;
    if (interaction.origin?.kind === "plugin" && interaction.origin.pluginId === this.bb.pluginId) return;
    if (interaction.status !== "pending") { this.nativeInteractions.delete(interaction.id); this.publishStatus(conversation.id); return; }
    this.nativeInteractions.set(interaction.id, { id: interaction.id, threadId, title: interaction.payload.title, kind: interaction.payload.kind, conversationId: conversation.id });
    const reply = this.store.recordReply({
      conversationId: conversation.id,
      requestId: null,
      batchId: null,
      questionId: null,
      kind: "clarification",
      source: "bridge",
      body: { speech: `I need your decision in the app: ${truncateSpeech(interaction.payload.title, 160)}`, detail: `Interaction ${interaction.id} (${interaction.payload.kind}) on the coordinator thread. Answer it in the Voice page or open the coordinator.`, threadIds: [threadId], receipts: [], focusThreadId: null },
      ready: true,
      delivery: conversation.currentCallNonce ? "pending" : "deferred",
      targetCallNonce: conversation.currentCallNonce,
    });
    if (conversation.currentCallNonce) this.publishReply(reply);
    else this.deferReplyToInbox(conversation, reply);
    this.publishStatus(conversation.id);
  }

  // ---- watched thread events (background updates) ----

  enqueueThreadUpdate(input: { threadId: string; title: string | null; kind: "idle" | "failed" | "interaction" | "turn_failed"; detail: string | null; eventKey: string; queuedMessageCount?: number }): void {
    if (this.store.coordinatorThreadIds().has(input.threadId)) return;
    const worker = this.actions.store.workerForThread(input.threadId);
    if (worker && ((input.kind === "idle" && input.queuedMessageCount === 0) || input.kind === "failed" || input.kind === "turn_failed")) {
      this.actions.store.workerStatus(worker.requestId,worker.step,"settled");
    }
    const directReport = input.kind === "idle" ? worker?.report : null;
    if (directReport) this.actions.store.clearWorkerReport(input.threadId);
    for (const conversationId of this.store.watchersOf(input.threadId)) {
      const conversation = this.store.getConversation(conversationId);
      if (!conversation) continue;
      const signature = JSON.stringify([input.kind,input.detail?.trim() ?? ""]);
      if (conversation.state.threadStates[input.threadId] === signature) continue;
      const threadStates = {...conversation.state.threadStates,[input.threadId]:signature};
      const row = this.store.enqueueUpdate({
        conversationId,
        threadId: input.threadId,
        title: input.title ?? "(untitled thread)",
        kind: input.kind,
        fingerprint: `${input.threadId}:${input.kind}:${input.eventKey}`,
        detail: directReport ? JSON.stringify({voice_worker_report:directReport}) : input.detail ? truncateSpeech(input.detail, 600) : null,
      });
      if (!row) continue;
      this.store.updateConversation(conversationId,{state:{threadStates:Object.fromEntries(Object.entries(threadStates).slice(-200))}});
      if (conversation.currentCallNonce) {
        this.bb.realtime.publish(INBOX_CHANNEL, { conversationId, callNonce: conversation.currentCallNonce, queued: this.store.listUpdates(conversationId, ["queued"]).length });
      }
      this.publishStatus(conversationId);
    }
  }

  /**
   * The bridge found a quiet boundary. Check the coordinator-side conditions,
   * reserve a bounded batch, and open a digest turn. Never speaks by itself.
   */
  async reserveBatch(input: { conversationId: string; callNonce: string; msSinceCallLive: number }): Promise<{ batch: { id: string; count: number; remaining: number } | null; reason: BatchRefusal | "empty" | "send-failed" | null }> {
    const conversation = this.store.getConversation(input.conversationId);
    if (!conversation) throw new Error("Unknown voice conversation.");
    const requestsThisCall = this.store.listRequests(conversation.id, undefined, 200).filter((request) => request.callNonce === input.callNonce);
    let coordinatorIdle = true;
    if (conversation.coordinatorThreadId) {
      try {
        const thread = await this.bb.sdk.threads.get({ threadId: conversation.coordinatorThreadId });
        coordinatorIdle = (thread.status === "idle" || thread.status === "pending") && thread.queuedMessageCount === 0;
      } catch { coordinatorIdle = false; }
    }
    const refusal = refuseBatch({
      callMatches: conversation.currentCallNonce === input.callNonce,
      openRequests: requestsThisCall.filter((request) => request.status === "accepted" || request.status === "dispatching" || request.status === "recorded" || request.status === "quick_running").length,
      coordinatorIdle,
      blockingInteraction: this.store.listQuestions(conversation.id, ["pending"]).length > 0 || [...this.nativeInteractions.values()].some((entry) => entry.conversationId === conversation.id),
      batchInFlight: this.store.listBatches(conversation.id, ["reserved", "sent"]).length > 0,
      openingAnswered: conversation.state.openingAnswered,
      msSinceCallLive: input.msSinceCallLive,
      requestsThisCall: requestsThisCall.length,
    });
    if (refusal) return { batch: null, reason: refusal };
    const queued = this.store.listUpdates(conversation.id, ["queued"]);
    if (queued.length === 0) return { batch: null, reason: "empty" };
    const { selected, superseded } = selectBatch(queued);
    this.store.setUpdatesStatus(superseded, "skipped", null);
    const batchId = this.store.createBatch(conversation.id);
    this.store.setUpdatesStatus(selected.map((row) => row.id), "reserved", batchId);
    const direct = selected.map(update => {
      try {
        const data = JSON.parse(update.detail ?? "null") as {voice_worker_report?: {speech?: unknown}} | null;
        const speech = data?.voice_worker_report?.speech;
        return typeof speech === "string" && speech.trim() ? `${update.title}: ${speech}` : null;
      } catch { return null; }
    });
    if (direct.every((text): text is string => text !== null)) {
      const reply = this.store.recordReply({conversationId:conversation.id,requestId:null,batchId,questionId:null,kind:"update",source:"bridge",
        body:{speech:direct.join(" "),detail:JSON.stringify(selected),threadIds:selected.map(update=>update.threadId),receipts:[],focusThreadId:null},
        ready:true,delivery:"pending",targetCallNonce:input.callNonce});
      this.store.setBatchStatus(batchId,"answered");
      this.publishReply(reply);
      this.publishStatus(conversation.id);
      return {batch:{id:batchId,count:selected.length,remaining:queued.length-selected.length-superseded.length},reason:null};
    }
    let threadId: string;
    try {
      ({ threadId } = await this.ensureCoordinator(conversation.id));
      await this.bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text: formatDigestMessage(batchId, selected), mentions: [] }] });
    } catch (error) {
      this.bb.log.warn(`digest batch ${batchId} failed: ${error instanceof Error ? error.message : String(error)}`);
      this.store.setBatchStatus(batchId, "failed");
      this.store.setUpdatesStatus(selected.map((row) => row.id), "queued", null);
      return { batch: null, reason: "send-failed" };
    }
    this.store.setBatchStatus(batchId, "sent");
    this.publishStatus(conversation.id);
    return { batch: { id: batchId, count: selected.length, remaining: queued.length - selected.length - superseded.length }, reason: null };
  }

  // ---- controls ----

  setWatch(conversationId: string, threadId: string, watched: boolean): void {
    if (watched) this.store.watch(conversationId, threadId, "user");
    else this.store.unwatch(conversationId, threadId);
    this.publishStatus(conversationId);
  }

  status(conversationId?: string | null): CoordinatorStatus {
    const id = conversationId ?? this.store.currentConversationId();
    const conversation = id ? this.store.getConversation(id) : null;
    const currentId = this.store.currentConversationId();
    const conversations = this.store.listConversations(10).map((row) => ({ id: row.id, createdAt: row.createdAt, updatedAt: row.updatedAt, status: row.status, coordinatorThreadId: row.coordinatorThreadId, current: row.id === currentId }));
    if (!conversation) {
      return { conversation: null, requests: [], questions: [], pendingInteractions: [], watch: [], queuedUpdates: 0, recentReplies: [], conversations };
    }
    return {
      conversation: {
        id: conversation.id,
        status: conversation.status,
        coordinatorThreadId: conversation.coordinatorThreadId,
        providerId: conversation.providerId,
        model: conversation.model,
        hostId: conversation.hostId,
        currentCallNonce: conversation.currentCallNonce,
        revision: conversation.revision,
        topic: conversation.state.topic,
        discussedThreadId: conversation.state.discussedThreadId,
      },
      requests: this.store.listRequests(conversation.id, undefined, 12).map((request) => ({
        id: request.id,
        seq: request.seq,
        status: request.status,
        text: request.envelope.originalText || request.envelope.interpretation || "(no transcript)",
        delivery: request.receipt?.delivery ?? null,
        error: request.error,
        createdAt: request.createdAt,
      })),
      questions: this.store.listQuestions(conversation.id, ["pending", "unresolved", "submitted"]).map((question) => this.describeQuestion(question)),
      pendingInteractions: [...this.nativeInteractions.values()].filter((entry) => entry.conversationId === conversation.id).map(({ id: interactionId, threadId, title, kind }) => ({ id: interactionId, threadId, title, kind })),
      watch: this.store.watchList(conversation.id).filter((row) => row.threadId !== conversation.coordinatorThreadId),
      queuedUpdates: this.store.listUpdates(conversation.id, ["queued"]).length,
      recentReplies: this.store.listReplies(conversation.id, undefined, 200).slice(-8).map((reply) => ({ id: reply.id, kind: reply.kind, speech: reply.body.speech, delivery: reply.delivery, createdAt: reply.createdAt, threadIds: reply.body.threadIds })),
      conversations,
    };
  }

  private publishStatus(conversationId: string) {
    if (this.disposed) return;
    const conversation = this.store.getConversation(conversationId);
    this.bb.realtime.publish(STATUS_CHANNEL, { conversationId, callNonce:conversation?.currentCallNonce ?? null,
      activeRequestIds:[...new Set([...this.store.listRequests(conversationId,["recorded","dispatching","accepted","dispatch_unknown","quick_running"]).map(request=>request.id),...(conversation?.state.activeTasks ?? []).map(task=>task.requestId)])] });
  }
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.filter((id) => typeof id === "string" && id.trim().length > 0))];
}
