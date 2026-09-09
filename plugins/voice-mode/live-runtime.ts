import { isHistoricalAgentThread } from "./history-boundary.ts";
import { UiActionSchema, type UiAction } from "./ui-actions.ts";
/** Client RPC contract for the next cutover step.
 * runTool(input) -> compact read data or {operationId,status,asOf,...receipt}.
 * input = {nonce,conversationId,utterance:{id,version,text,startedAt}|null,
 *   responseOrigin:'user'|'background',tool,args,occurrence?:number}.
 * occurrence is assigned by the sequencer, defaults to 0, and MUST survive retries.
 * beginClientEffect(input) -> {execute,operationId?,receipt}; only execute when true.
 * finishClientEffect({nonce,operationId,status,result}) -> stored receipt.
 * nextUpdateBatch({nonce}) -> {offerId,items,asOf}|null, one pending offer per conversation.
 * closeOffer({nonce,offerId,outcome,responseId?}) -> {closed}; delivered requires reportDrain.
 * reportDrain({nonce,responseId,at}) -> {ok}; report ONLY natural audio stops, in epoch ms.
 * finishUserExchange({nonce,utteranceId}) -> {ok}; call once at the end of a user exchange,
 * including a silent exchange. This is the defer trigger, not the quiet timer.
 * callStartContext({nonce,conversationId,view?:{threadId?,projectId?}}) -> system context.
 * listLiveSubscriptions/listLiveTasks({nonce,conversationId}) -> {items,asOf}.
 * The server reads the existing call owner. Call start binds the conversation and resets
 * per-call authority only for a new nonce; a reload requires context to be fetched again.
 * prepare_draft/control_ui stay client-executed. The client must check the nonce again
 * immediately before applying them. An unfinished client receipt becomes unknown on restart.
 * end_call and remain_silent return directives for the sequencer; they do not play speech.
 */
import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { LiveStore, type OperationRow, type InboxRow } from "./live-store.ts";
import { Operations, hash, type EffectInput } from "./operations.ts";
import { LIVE_EFFECTS, liveToolArgs, type LiveTool } from "./live-tools.ts";
import { Watches, interactionData, tail, threadName, type Thread } from "./watches.ts";
import { readNamedWorkerSettings, resolveWorkerModel, type NamedWorkerSettings } from "./worker-profiles.ts";
import { assembleWorkerPrompt } from "./worker-prompt.ts";
import { queryTokens, rank, resolveName } from "./target-matching.ts";
import { describeInteraction, resolveAnswers, submitAnswers } from "./interaction-answers.ts";
import type { WorkerProfile } from "./worker-profiles.ts";

interface ModelChoice { id: string; name: string; isDefault: boolean; reasoning: string[]; fast: boolean }
/** The subset of a thread's environment record that voice reports. */
interface EnvironmentInfo {
  path: string; branchName: string | null; baseBranch: string | null; defaultBranch: string | null; isWorktree: boolean; managed: boolean;
  workspaceProvisionType: string; status: string; hostId: string;
  pullRequest?: { status: string; pullRequest?: { number: number; title: string; url: string; state: string } | null } | null;
}
function queuedText(q: { content: { type: string; text?: string }[] }) { return q.content.filter(p => p.type === "text").map(p => p.text ?? "").join("\n"); }
function environmentData(environment: EnvironmentInfo | null | undefined) {
  if (!environment) return null;
  const pr = environment.pullRequest?.pullRequest;
  return { path: environment.path, branch: environment.branchName, baseBranch: environment.baseBranch, defaultBranch: environment.defaultBranch,
    isWorktree: environment.isWorktree, kind: environment.workspaceProvisionType, status: environment.status, hostId: environment.hostId,
    pullRequest: pr ? { number: pr.number, title: pr.title, url: pr.url, state: pr.state } : null };
}

const nonceInput = z.object({ nonce: z.string().min(1).max(256) }).strict();
const conversationInput = nonceInput.extend({ conversationId: z.string().min(1).max(256) });
export const liveToolInputSchema = conversationInput.extend({
  utterance: z.object({ id: z.string().min(1).max(256), version: z.number().int().nonnegative(), text: z.string().min(1).max(24000), startedAt: z.number().finite().nonnegative() }).strict().nullable(),
  responseOrigin: z.enum(["user", "background"]), tool: z.enum(Object.keys(liveToolArgs) as [LiveTool, ...LiveTool[]]),
  args: z.record(z.string(), z.json()), occurrence: z.number().int().nonnegative().default(0),
});
export const liveRpcContract = {
  runTool: { input: liveToolInputSchema, output: z.json() },
  beginClientEffect: { input: liveToolInputSchema, output: z.json() },
  finishClientEffect: { input: nonceInput.extend({ operationId: z.string().min(1), status: z.enum(["succeeded", "failed", "cancelled", "unknown"]), result: z.record(z.string(), z.json()) }), output: z.json() },
  nextUpdateBatch: { input: nonceInput, output: z.json() },
  closeOffer: { input: nonceInput.extend({ offerId: z.string().min(1), outcome: z.enum(["delivered", "not_delivered", "deferred", "dismissed"]), responseId: z.string().min(1).optional() }), output: z.object({ closed: z.boolean() }).strict() },
  reportDrain: { input: nonceInput.extend({ responseId: z.string().min(1), at: z.number().finite().nonnegative() }), output: z.object({ ok: z.literal(true) }).strict() },
  finishUserExchange: { input: nonceInput.extend({ utteranceId: z.string().min(1) }), output: z.object({ ok: z.literal(true) }).strict() },
  callStartContext: { input: conversationInput.extend({ view: z.object({ threadId: z.string().nullable().optional(), projectId: z.string().nullable().optional(), space: z.string().max(120).nullable().optional() }).strict().optional() }), output: z.json() },
  listLiveSubscriptions: { input: conversationInput, output: z.json() },
  listLiveTasks: { input: conversationInput, output: z.json() },
};
type ToolInput = z.infer<typeof liveToolInputSchema>;
type Presented = { returnedAt: number; spokenAt: number | null };
interface CallState {
  nonce: string; conversationId: string; allowed: Set<string>; drains: Map<string, { at: number; receivedAt: number }>;
  presented: Map<string, Presented>; exchanges: Set<string>;
  deferredAfter: Map<string, string | null>;
  previews: Map<string, { roots: string[]; scopeHash: string; utteranceId: string; used: boolean }>;
}
class SdkTimeout extends Error { constructor() { super("SDK call timed out. The result is unknown; do not repeat this effect."); } }
// JSON-normalize SDK values at the RPC boundary, including optional properties.
const json = (value: unknown): z.infer<ReturnType<typeof z.json>> => JSON.parse(JSON.stringify(value));
export class LiveRuntime {
  readonly store: LiveStore;
  readonly operations: Operations;
  readonly watches: Watches;
  private call: CallState | null = null;
  private creationChain: Promise<unknown> = Promise.resolve();
  private startChain: Promise<unknown> = Promise.resolve();
  constructor(readonly bb: BbPluginApi, readonly owner: () => { nonce: string | null; conversationId?: string | null },
    readonly now = Date.now, readonly timeoutMs = 30000, private workerPrompt?: () => string) {
    this.store = new LiveStore(bb.storage.database(), now);
    this.operations = new Operations(this.store); this.watches = new Watches(bb, this.store, this.operations);
  }
  assertOwner(nonce: string, conversationId?: string) {
    const owner = this.owner();
    if (owner.nonce !== nonce) throw new Error("Not authorized: voice call was stopped or replaced");
    if (conversationId && owner.conversationId !== conversationId) throw new Error("Not authorized: conversation does not own this call");
  }
  private state(nonce: string, conversationId?: string) {
    this.assertOwner(nonce, conversationId);
    if (!this.call || this.call.nonce !== nonce || (conversationId && this.call.conversationId !== conversationId)) {
      // The owner record and the client call both outlive this process. After a plugin
      // reload the in-memory state is gone while the call is still live, so rebuild it
      // from the store instead of failing every tool until hangup.
      const owned = conversationId ?? this.owner().conversationId;
      if (!owned) throw new Error("Not authorized: fetch call-start context first");
      this.bb.log.warn(`Rebuilding call state for ${nonce} after a restart`);
      this.call = this.rehydrate(nonce, owned);
    }
    return this.call;
  }
  /** A fresh call state that already holds every target this call was shown before the restart. */
  private rehydrate(nonce: string, conversationId: string): CallState {
    const call: CallState = { nonce, conversationId, allowed: new Set(), drains: new Map(), presented: new Map(), exchanges: new Set(), deferredAfter: new Map(), previews: new Map() };
    for (const row of this.store.db.prepare("SELECT id FROM voice_call_targets WHERE call_nonce = ?").all(nonce) as { id: string }[]) call.allowed.add(row.id);
    this.rememberConversationTargets(call);
    return call;
  }
  /** Targets every call in this conversation may act on: its running tasks and pending interactions. */
  private rememberConversationTargets(call: CallState) {
    for (const task of this.store.tasks(call.conversationId)) if (["spawning", "running", "unknown"].includes(task.status)) this.remember(call, task.thread_id);
    const activeRoots = new Set(this.store.watches(call.conversationId).filter(watch => watch.state === "active").map(watch => watch.root_thread_id));
    for (const item of this.store.inbox(call.conversationId)) if (item.interaction_id && item.status !== "resolved" && activeRoots.has(item.root_thread_id)) this.remember(call, item.thread_id, item.interaction_id);
  }
  private authorize(input: ToolInput, args: Record<string, unknown>, effect = LIVE_EFFECTS.has(input.tool) && !(input.tool === "queued_messages" && args.op === "list")) {
    const call = this.state(input.nonce, input.conversationId);
    if (effect && input.responseOrigin === "background") throw new Error("Not authorized: background updates cannot act");
    if (effect && typeof args.thread_id === "string" && isHistoricalAgentThread(this.store.db,args.thread_id)) throw new Error("Not authorized: historical agent threads cannot run new work");
    if (effect && !input.utterance) throw new Error("Not authorized: an effect needs a user utterance");
    if (effect && input.utterance && this.store.db.prepare(`SELECT 1 FROM voice_operations WHERE conversation_id = ? AND utterance_id = ? AND utterance_version = ? AND status = 'unknown'
      AND (tool != ? OR args_hash != ? OR occurrence != ?)`).get(input.conversationId, input.utterance.id, input.utterance.version, input.tool, hash(args), input.occurrence))
      throw new Error("Not authorized: this utterance has an unknown effect. Read its receipt; do not try another tool.");
    if (effect) for (const key of ["thread_id", "project_id", "host_id", "interaction_id", "queued_message_id"]) {
      const id = args[key];
      if (typeof id === "string" && !call.allowed.has(id)) throw new Error(`Not authorized: unknown target ID ${id}. Resolve it with find_targets or read_threads first.`);
    }
    return call;
  }
  private remember(call: CallState, ...ids: (string | null | undefined)[]) {
    const insert = this.store.db.prepare("INSERT OR IGNORE INTO voice_call_targets (call_nonce, id) VALUES (?, ?)");
    for (const id of ids) if (id && !call.allowed.has(id)) { call.allowed.add(id); insert.run(call.nonce, id); }
  }
  private present(call: CallState, key: string) {
    // An already heard interaction stays heard. A later read must not move its confirmation gate.
    if (!call.presented.has(key)) call.presented.set(key, { returnedAt: this.now(), spokenAt: null });
  }
  private heard(call: CallState, key: string, input: EffectInput) {
    const spoken = call.presented.get(key)?.spokenAt;
    if (spoken == null) throw new Error("Not authorized: this item has not been spoken and drained in this call");
    if (!input.utterance || input.utterance.startedAt <= spoken) throw new Error("Not authorized: confirmation must start after the spoken explanation drained");
  }
  private parse(input: ToolInput) {
    if (input.tool === "message_thread" && Object.keys(input.args).some(k => /^(sendAt|send_at|schedule|scheduled_at|delay|deliver_at)$/.test(k))) throw new Error("Sending later is not supported. Ask to send now.");
    return liveToolArgs[input.tool].parse(input.args);
  }
  async initialize() { this.operations.recover(); await this.watches.recover(); }
  async callStartContext(input: z.infer<typeof liveRpcContract.callStartContext.input>) {
    const work = async () => {
      this.assertOwner(input.nonce, input.conversationId);
      const fresh = this.call?.nonce !== input.nonce;
      if (fresh) this.call = { nonce: input.nonce, conversationId: input.conversationId, allowed: new Set(), drains: new Map(), presented: new Map(),
        exchanges: new Set(), deferredAfter: new Map(), previews: new Map() };
      const call = this.state(input.nonce, input.conversationId);
      if (fresh) {
        this.watches.prepareRecovery(input.conversationId);
        this.watches.trigger(input.conversationId, "resume");
        void this.watches.reconcileRecovery(input.conversationId).catch(error => this.bb.log.warn(`Call recovery failed: ${String(error)}`));
      }
      const tasks = this.store.tasks(input.conversationId).filter(t => ["spawning", "running", "unknown"].includes(t.status));
      tasks.forEach(t => this.remember(call, t.thread_id));
      const activeRoots = new Set(this.store.watches(input.conversationId).filter(watch => watch.state === "active").map(watch => watch.root_thread_id));
      const pending = this.store.inbox(input.conversationId)
        .filter(item => item.interaction_id && item.status !== "resolved" && activeRoots.has(item.root_thread_id))
        .map(item => ({ threadId: item.thread_id, ...JSON.parse(item.detail) }));
      pending.forEach(item => this.remember(call, item.threadId, item.id));
      // The space is a client-side sidebar scope; the client reports its name and the server only echoes it.
      let view: Record<string, unknown> = input.view?.space ? { space: input.view.space } : {};
      if (input.view?.threadId) {
        const thread = await this.bb.sdk.threads.get({ threadId: input.view.threadId });
        this.remember(call, thread.id, thread.projectId); view = { ...view, threadId: thread.id, title: threadName(thread), projectId: thread.projectId };
      }
      if (input.view?.projectId) {
        const project = (await this.bb.sdk.projects.list({ includePersonal: true })).find(p => p.id === input.view!.projectId);
        if (project) { this.remember(call, project.id, ...project.sources.map(s => s.hostId)); view = { ...view, projectId: project.id, projectName: project.name, hostIds: project.sources.map(s => s.hostId) }; }
      }
      // Machines are not secrets: a worker may name any connected machine without a prior search.
      try { (await this.bb.sdk.hosts.list()).forEach(h => this.remember(call, h.id)); } catch (error) { this.bb.log.warn(`Call start could not list machines: ${String(error)}`); }
      this.state(input.nonce, input.conversationId);
      pending.forEach(i => this.present(call, `interaction:${i.id}`));
      return json({ type: "call_start_context", view, tasks: tasks.map(({op_id, thread_id, title, kind, profile, status, updated_at}) => ({op_id, thread_id, title, kind, profile, status, updated_at})), pendingInteractions: pending, pendingUpdates: this.store.inbox(input.conversationId).filter(i => !["spoken", "resolved", "dismissed"].includes(i.status)).length,
        recentTurns: this.history(input.conversationId), asOf: this.now(), truncated: false });
    };
    const next = this.startChain.then(work, work); this.startChain = next.catch(() => undefined); return next;
  }
  private history(conversationId: string) {
    const rows = this.store.db.prepare(`SELECT ts, kind, payload FROM session_events WHERE session_id IN
      (SELECT call_id FROM voice_conversation_calls WHERE conversation_id = ? UNION SELECT ?) AND kind IN ('user','assistant') ORDER BY ts DESC, id DESC LIMIT 12`).all(conversationId, conversationId) as { ts: number; kind: string; payload: string }[];
    let remaining = 2000;
    return rows.map(r => {
      let text = ""; try { text = String(JSON.parse(r.payload).text ?? ""); } catch { /* Invalid historical payload has no usable text. */ }
      const result = { at: r.ts, role: r.kind, ...tail(text, remaining) }; remaining = Math.max(0, remaining - (result.text?.length ?? 0)); return result;
    }).filter(r => r.text).reverse();
  }
  async runTool(raw: ToolInput) {
    const input = liveToolInputSchema.parse(raw);
    try {
      this.state(input.nonce, input.conversationId);
      const args = this.parse(input); const call = this.authorize(input, args);
      if (["prepare_draft", "control_ui"].includes(input.tool)) throw new Error("Use beginClientEffect for this client tool");
      const readOnly = !LIVE_EFFECTS.has(input.tool) || (input.tool === "queued_messages" && (args as { op?: string }).op === "list");
      if (readOnly) { const result = await this.read(input, call); this.state(input.nonce, input.conversationId); return json(result); }
      const begin = this.operations.begin({ ...input, args });
      if (!begin.execute) { this.rememberReceipt(call, begin.row); return json(this.operations.receipt(begin.row)); }
      try {
        const receipt = await this.effect(input, begin.row, begin.text, call);
        this.state(input.nonce, input.conversationId); return json(receipt);
      } catch (error) {
        const row = this.operations.get(begin.row.id)!;
        if (this.owner().nonce !== input.nonce) {
          if (row.status === "accepted") this.operations.finish(row.id, isTimeout(error) ? "unknown" : errorMessage(error).startsWith("Not authorized:") ? "cancelled" : "failed", { error: errorMessage(error) });
          return json({ error: "Not authorized: voice call was stopped or replaced", status: "failed", asOf: this.now() });
        }
        // A failure in the follow-up read must not turn an accepted spawn into a failed launch.
        if (row.status !== "accepted") return json(this.operations.receipt(row));
        return json(this.operations.finish(row.id, isTimeout(error) ? "unknown" : "failed", { error: errorMessage(error) }));
      }
    } catch (error) { return json({ error: errorMessage(error), status: "failed", asOf: this.now() }); }
  }
  private rememberReceipt(call: CallState, row: OperationRow) {
    this.remember(call, row.target_thread_id);
    const receipt = this.operations.receipt(row);
    if (typeof receipt.threadId === "string") this.remember(call, receipt.threadId);
  }
  /** Every receipt for work that continues in the background says whether this call will report its result. */
  private followUp(watch: { state: string }) { return { updates: watch.state === "disabled" ? "muted" : "automatic" }; }
  private async sdkEffect<T>(input: ToolInput, work: () => Promise<T>) {
    this.state(input.nonce, input.conversationId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SdkTimeout()), this.timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  private async effect(input: ToolInput, row: OperationRow, text: string, call: CallState) {
    switch (input.tool) {
      case "message_thread": {
        const args = liveToolArgs.message_thread.parse(input.args);
        const watch = await this.watches.watch(input.conversationId, args.thread_id);
        const body = `${args.body}\nSpoken request: ${text}`;
        this.store.db.prepare("UPDATE voice_operations SET target_thread_id = ?, body = ? WHERE id = ?").run(args.thread_id, body, row.id);
        // Native callbacks can arrive before send resolves. Queue them behind the receipt write.
        return this.watches.serial(async () => {
        const result = await this.sdkEffect(input, () => this.bb.sdk.threads.send({ threadId: args.thread_id, input: [{ type: "text", text: body, mentions: [] }], mode: args.mode === "steer" ? "steer-if-active" : "queue-if-active" }));
        const queued = result.delivery === "queued";
        this.store.db.prepare("UPDATE voice_operations SET queued_message_id = ?, dispatched_at = ? WHERE id = ?").run(queued ? result.queuedMessage.id : null, queued ? null : this.now(), row.id);
        return this.operations.finish(row.id, queued ? "queued" : "running", { threadId: args.thread_id, title: watch.title, delivery: result.delivery, delivered: true, ...(queued ? { queuedMessageId: result.queuedMessage.id } : {}), updatesMuted: watch.state === "disabled", ...this.followUp(watch) });
        });
      }
      case "spawn_worker": case "create_thread": return this.spawn(input, row, text, call);
      case "stop_thread": {
        const { thread_id } = liveToolArgs.stop_thread.parse(input.args);
        const watch = await this.watches.watch(input.conversationId, thread_id);
        this.store.db.prepare("UPDATE voice_operations SET target_thread_id = ? WHERE id = ?").run(thread_id, row.id);
        await this.sdkEffect(input, () => this.bb.sdk.threads.stop({ threadId: thread_id }));
        return this.operations.finish(row.id, "succeeded", { threadId: thread_id, title: watch.title, stopRequested: true, processesExited: null, updatesMuted: watch.state === "disabled", ...this.followUp(watch) });
      }
      case "queued_messages": {
        const args = liveToolArgs.queued_messages.parse(input.args);
        if (args.op === "list") throw new Error("queued_messages list is a read");
        if (!args.queued_message_id) throw new Error(`queued_messages ${args.op} needs queued_message_id from a list in this call`);
        const target = { threadId: args.thread_id, queuedMessageId: args.queued_message_id };
        const before = (await this.bb.sdk.threads.queuedMessages.list({ threadId: args.thread_id })).find(q => q.id === args.queued_message_id);
        if (!before) throw new Error("That queued message is gone: it was sent or deleted already.");
        this.store.db.prepare("UPDATE voice_operations SET target_thread_id = ? WHERE id = ?").run(args.thread_id, row.id);
        const own = this.store.db.prepare("SELECT id FROM voice_operations WHERE queued_message_id = ? AND target_thread_id = ? AND completed_at IS NULL AND status = 'queued'").get(args.queued_message_id, args.thread_id) as { id: string } | undefined;
        const watch = await this.watches.watch(input.conversationId, args.thread_id);
        if (args.op === "send_now") {
          await this.sdkEffect(input, () => this.bb.sdk.threads.queuedMessages.send({ ...target, mode: "steer" }));
          if (own) { this.store.db.prepare("UPDATE voice_operations SET dispatched_at = ? WHERE id = ?").run(this.now(), own.id); this.operations.finish(own.id, "running", { delivery: "sent", sentNow: true }); }
          return this.operations.finish(row.id, "succeeded", { threadId: args.thread_id, title: watch.title, queuedMessageId: args.queued_message_id, sentNow: true, text: queuedText(before), ...this.followUp(watch) });
        }
        if (args.op === "delete") {
          await this.sdkEffect(input, () => this.bb.sdk.threads.queuedMessages.delete(target));
          if (own) { this.store.db.prepare("UPDATE voice_operations SET completed_at = ? WHERE id = ?").run(this.now(), own.id); this.operations.finish(own.id, "cancelled", { deletedFromQueue: true }); }
          return this.operations.finish(row.id, "succeeded", { threadId: args.thread_id, title: watch.title, queuedMessageId: args.queued_message_id, deleted: true, text: queuedText(before) });
        }
        if (!args.text) throw new Error("queued_messages edit needs text");
        if (!before.editable) throw new Error("That queued message cannot be edited now; delete it and send a new one.");
        const previousText = queuedText(before);
        const updated = await this.sdkEffect(input, () => this.bb.sdk.threads.queuedMessages.update({ ...target, expectedUpdatedAt: before.updatedAt, input: [{ type: "text", text: args.text!, mentions: [] }] }));
        if (own) this.store.db.prepare("UPDATE voice_operations SET body = ? WHERE id = ?").run(args.text, own.id);
        return this.operations.finish(row.id, "succeeded", { threadId: args.thread_id, title: watch.title, queuedMessageId: updated.id, edited: true, previousText, text: args.text });
      }
      case "rename_thread": {
        const { thread_id, title } = liveToolArgs.rename_thread.parse(input.args);
        const previousTitle = threadName(await this.bb.sdk.threads.get({ threadId: thread_id }));
        this.store.db.prepare("UPDATE voice_operations SET target_thread_id = ? WHERE id = ?").run(thread_id, row.id);
        await this.sdkEffect(input, () => this.bb.sdk.threads.update({ threadId: thread_id, title }));
        return this.operations.finish(row.id, "succeeded", { threadId: thread_id, previousTitle, title });
      }
      case "archive_threads": {
        const { preview_id } = liveToolArgs.archive_threads.parse(input.args);
        const preview = call.previews.get(preview_id);
        if (!preview || preview.used) throw new Error("Not authorized: archive preview is missing or already used");
        this.heard(call, `preview:${preview_id}`, input);
        if (preview.utteranceId === input.utterance!.id) throw new Error("Not authorized: archive needs a later utterance");
        const scope = await this.archiveScope(preview.roots);
        if (hash(scope) !== preview.scopeHash) throw new Error("Not authorized: archive scope changed. Prepare and speak a new preview.");
        this.state(input.nonce, input.conversationId);
        if (preview.used) throw new Error("Not authorized: archive preview is already used");
        preview.used = true;
        const archived: string[] = [];
        for (const threadId of preview.roots) {
          const result = await this.sdkEffect(input, () => this.bb.sdk.threads.archive({ threadId })); archived.push(...result.archivedThreadIds);
          this.operations.finish(row.id, "accepted", { archivedThreadIds: [...new Set(archived)] });
        }
        return this.operations.finish(row.id, "succeeded", { archivedThreadIds: [...new Set(archived)] });
      }
      case "answer_interaction": {
        const args = liveToolArgs.answer_interaction.parse(input.args);
        this.heard(call, `interaction:${args.interaction_id}`, input);
        const interaction = await this.bb.sdk.threads.interactions.get({ threadId: args.thread_id, interactionId: args.interaction_id });
        if (interaction.status !== "pending" || interaction.threadId !== args.thread_id) throw new Error("Not authorized: interaction is no longer pending on this thread");
        this.store.db.prepare("UPDATE voice_operations SET target_thread_id = ? WHERE id = ?").run(args.thread_id, row.id);
        const spec = await describeInteraction(this.bb, interaction);
        const resolved = () => this.store.db.prepare("UPDATE voice_inbox SET status = 'resolved', eligible = 0 WHERE conversation_id = ? AND interaction_id = ?").run(input.conversationId, args.interaction_id);
        if (spec.kind === "approval") {
          if (!args.decision || args.answers !== undefined || !spec.availableDecisions?.includes(args.decision)) throw new Error("Not authorized: select an available approval decision");
          const decision = args.decision;
          const result = await this.sdkEffect(input, () => this.bb.sdk.threads.interactions.resolve({ threadId: args.thread_id, interactionId: args.interaction_id,
            resolution: decision === "deny" ? { decision } : { decision, grantedPermissions: null } }));
          if (result.status !== "pending") resolved();
          return this.operations.finish(row.id, "succeeded", { interaction: interactionData(result) });
        }
        if (args.decision) throw new Error("Not authorized: a decision only answers an approval; this is a question");
        // Labels resolve to options before anything is sent, so a mishearing never half-answers.
        const answers = resolveAnswers(spec, args.answers ?? []);
        const outcome = await this.sdkEffect(input, () => submitAnswers(this.bb, spec, answers));
        resolved();
        return this.operations.finish(row.id, "succeeded", { interactionId: spec.id, threadId: spec.threadId, kind: spec.kind, title: spec.title,
          answered: answers.map(a => ({ question: a.question.prompt, choices: a.selected.map(v => a.question.options.find(o => o.value === v)?.label ?? v), ...(a.text ? { text: a.text } : {}) })),
          ...(outcome.kind === "round" ? { submissionId: outcome.submissionId } : { interaction: interactionData(outcome.interaction) }) });
      }
      default: throw new Error("Unsupported effect");
    }
  }
  /** A missing or approximate profile name never blocks a launch: the configured default applies. */
  private profileFor(settings: NamedWorkerSettings, requested: string | undefined) {
    const names = settings.profiles.map(p => p.name);
    const fallback = settings.profiles.find(p => p.name === settings.defaultProfile) ?? settings.profiles[0];
    if (!fallback) throw new Error("No worker profile is configured. Add one in Voice Mode → Workers.");
    if (!requested) return fallback;
    const exact = settings.profiles.find(p => p.name.trim().toLowerCase() === requested.trim().toLowerCase());
    if (exact) return exact;
    if (/^default$/i.test(requested.trim())) return fallback;
    const resolved = resolveName(requested, settings.profiles, p => p.name);
    if (!resolved) throw new Error(`Unknown worker profile "${requested}". Configured profiles: ${names.join(", ")}. Omit profile for ${fallback.name}.`);
    return resolved;
  }
  /** Workers run outside any project unless one is requested; the primary machine hosts the most projects. */
  private async destination(projectId: string | undefined, hostId: string | undefined) {
    const [projects, hosts] = await Promise.all([this.bb.sdk.projects.list({ includePersonal: true }), this.bb.sdk.hosts.list()]);
    const project = projectId ? projects.find(p => p.id === projectId) : projects.find(p => p.kind === "personal");
    if (!project) throw new Error(projectId ? "The requested project is unavailable" : "BB has no personal project for work outside a project");
    const connected = hosts.filter(h => h.status === "connected");
    const candidates = project.kind === "personal" ? connected : connected.filter(h => project.sources.some(s => s.hostId === h.id));
    const load = (h: { id: string }) => projects.filter(p => p.sources.some(s => s.hostId === h.id)).length;
    const primary = [...candidates].sort((a, b) => load(b) - load(a))[0];
    const host = hostId ? candidates.find(h => h.id === hostId) : project.kind === "personal" ? primary : candidates.length === 1 ? candidates[0] : undefined;
    if (!host) throw new Error(project.kind === "personal" ? "No connected machine can run the worker" : hostId ? "That machine is not connected or does not host this project" : `Choose one connected machine that hosts this project: ${candidates.map(h => h.name).join(", ")}`);
    return { project, host };
  }
  /** Providers on a machine with each one's models, for list_models and spoken overrides. */
  private async catalog(hostId: string, providerId?: string) {
    const providers = (await this.bb.sdk.providers.list({ hostId })).filter(p => !providerId || p.id === providerId);
    return Promise.all(providers.map(async provider => {
      if (!provider.available) return { id: provider.id, name: provider.displayName, available: false, models: [] as ModelChoice[] };
      try {
        const result = await this.bb.sdk.providers.models({ hostId, providerId: provider.id });
        const fast = !!result.providers?.find(p => p.id === provider.id)?.serviceTiers?.some(t => t.id === "fast");
        const models: ModelChoice[] = result.models.filter(m => !m.routeProviderId || m.routeProviderId === provider.id)
          .map(m => ({ id: m.model, name: m.displayName, isDefault: m.isDefault, reasoning: (m.supportedReasoningEfforts ?? []).map(e => e.reasoningEffort), fast }));
        return { id: provider.id, name: provider.displayName, available: true, models, ...(result.modelLoadError ? { error: result.modelLoadError.code } : {}) };
      } catch (error) { return { id: provider.id, name: provider.displayName, available: true, models: [] as ModelChoice[], error: errorMessage(error) }; }
    }));
  }
  /**
   * Apply spoken provider, model, and reasoning overrides to the profile's execution.
   * Names are approximate: "astra" resolves to gpt-6-astra. An unresolved name fails
   * with the available choices instead of silently launching the profile's model.
   */
  private async execution(hostId: string, profile: NamedWorkerSettings["profiles"][number], spoken: { provider?: string; model?: string; reasoning?: string }) {
    if (!spoken.provider && !spoken.model && !spoken.reasoning) return resolveWorkerModel(this.bb, hostId, profile);
    const catalog = await this.catalog(hostId);
    const available = catalog.filter(p => p.available);
    let provider = available.find(p => p.id === profile.providerId);
    if (spoken.provider) {
      provider = resolveName(spoken.provider, available, p => `${p.id} ${p.name}`) ?? undefined;
      if (!provider) throw new Error(`No available provider matches "${spoken.provider}". Providers: ${available.map(p => p.name).join(", ")}.`);
    }
    if (spoken.model && !spoken.provider) {
      // A model name can pick the provider: "opus" belongs to one provider only.
      const owners = available.filter(p => resolveName(spoken.model!, p.models, m => `${m.id} ${m.name}`));
      if (owners.length === 1) provider = owners[0];
      else if (owners.length > 1) throw new Error(`"${spoken.model}" exists on several providers: ${owners.map(p => p.name).join(", ")}. Say which one.`);
    }
    if (!provider) throw new Error(`Provider ${profile.providerId} is unavailable on the selected machine.`);
    const model = spoken.model ? resolveName(spoken.model, provider.models, m => `${m.id} ${m.name}`) : provider.models.find(m => m.id === profile.model) ?? provider.models.find(m => m.isDefault);
    if (!model) throw new Error(spoken.model ? `No ${provider.name} model matches "${spoken.model}". Models: ${provider.models.map(m => m.name).join(", ")}.` : `Provider ${provider.name} has no default model.`);
    const reasoning = spoken.reasoning ?? (provider.id === profile.providerId && model.id === profile.model ? profile.reasoningLevel : null);
    if (reasoning && !model.reasoning.includes(reasoning)) throw new Error(`${model.name} does not support ${reasoning} reasoning. Levels: ${model.reasoning.join(", ")}.`);
    return { providerId: provider.id, model: model.id, ...(reasoning ? { reasoningLevel: reasoning as WorkerProfile["reasoningLevel"] & string } : {}), serviceTier: profile.serviceTier };
  }
  /** Where a new thread runs. Reuse needs a thread this call has seen; the main folder is the project's own checkout. */
  private async workspace(call: CallState, project: { kind: string }, spoken: { workspace?: string; reuse_thread_id?: string }) {
    if (project.kind === "personal") return { environment: { type: "personal" as const }, workspace: "personal" };
    const choice = spoken.workspace ?? "new_worktree";
    if (choice === "reuse_thread") {
      if (!spoken.reuse_thread_id) throw new Error("workspace reuse_thread needs reuse_thread_id");
      if (!call.allowed.has(spoken.reuse_thread_id)) throw new Error(`Not authorized: unknown target ID ${spoken.reuse_thread_id}. Resolve it with find_targets or read_threads first.`);
      const thread = await this.bb.sdk.threads.get({ threadId: spoken.reuse_thread_id, include: "environment" });
      const environment = (thread as { environment?: EnvironmentInfo | null }).environment;
      if (!thread.environmentId || !environment) throw new Error("That thread has no environment to reuse.");
      return { environment: { type: "reuse" as const, environmentId: thread.environmentId }, workspace: "reuse_thread", reusedThreadId: thread.id, branch: environment.branchName, path: environment.path };
    }
    if (choice === "main_folder") return { environment: { type: "unmanaged" as const, path: null }, workspace: "main_folder" };
    return { environment: { type: "managed-worktree" as const, baseBranch: { kind: "default" as const } }, workspace: "new_worktree" };
  }
  private async spawn(input: ToolInput, row: OperationRow, spoken: string, call: CallState) {
    const worker = input.tool === "spawn_worker";
    const args = worker ? liveToolArgs.spawn_worker.parse(input.args) : liveToolArgs.create_thread.parse(input.args);
    const settings = await readNamedWorkerSettings(this.bb);
    const profile = this.profileFor(settings, "profile" in args ? args.profile : undefined);
    const { project, host } = await this.destination(args.project_id, args.host_id);
    const execution = await this.execution(host.id, profile, args);
    const placement = await this.workspace(call, project, args);
    const reserve = this.creationChain.then(async () => {
      await this.refreshWorkerQuota();
      this.state(input.nonce, input.conversationId);
      const active = this.store.tasks().filter(t => t.kind === "worker" && ["spawning", "running", "unknown"].includes(t.status)).length;
      if (worker && active >= settings.maxActiveWorkers) throw new Error(`Voice has reached its limit of ${settings.maxActiveWorkers} active or unconfirmed workers`);
      this.watches.reserveTask(row.id, input.conversationId, worker ? "worker" : "thread", args.title, profile.name);
    });
    this.creationChain = reserve.catch(() => undefined); await reserve;
    const prompt = "task" in args ? assembleWorkerPrompt(this.workerPrompt?.() ?? settings.workerBasePrompt, profile, args.title, args.task, spoken) : args.body;
    let thread: Thread;
    try {
      thread = await this.sdkEffect(input, () => this.bb.sdk.threads.spawn({ projectId: project.id, title: args.title, prompt,
        environment: placement.environment.type === "reuse" ? placement.environment : { type: "host", hostId: host.id, workspace: placement.environment },
        ...execution, permissionMode: profile.permissionMode, visibility: worker ? "hidden" : "visible" }));
    } catch (error) {
      this.store.db.prepare("UPDATE voice_tasks SET status = ?, updated_at = ? WHERE op_id = ?").run(isTimeout(error) ? "unknown" : "failed", this.now(), row.id); throw error;
    }
    this.store.db.prepare("UPDATE voice_operations SET target_thread_id = ? WHERE id = ?").run(thread.id, row.id);
    this.remember(call, thread.id, project.id, host.id);
    const { environment: _environment, ...placed } = placement;
    this.operations.finish(row.id, "running", { threadId: thread.id, title: threadName(thread), profile: profile.name, projectId: project.id, projectName: project.name, outsideProject: project.kind === "personal", hostId: host.id, hostName: host.name,
      provider: execution.providerId, model: execution.model, reasoning: execution.reasoningLevel ?? null, ...placed, visibility: worker ? "hidden" : "visible", launchAccepted: true, ...this.followUp({ state: "active" }) });
    try { await this.watches.spawned(row.id, thread); }
    catch (error) { this.operations.finish(row.id, "running", { recoveryNeeded: true, error: errorMessage(error) }); }
    return this.operations.receipt(this.operations.get(row.id)!);
  }
  private async archiveScope(ids: string[]) {
    const threads = new Map<string, Thread>();
    for (const id of ids) { const thread = await this.bb.sdk.threads.get({ threadId: id }); threads.set(id, thread); for (const child of await this.watches.descendants(id)) threads.set(child.id, child); }
    return Promise.all([...threads.values()].sort((a, b) => a.id.localeCompare(b.id)).map(async t => ({ id: t.id, title: threadName(t), parentThreadId: t.parentThreadId, status: t.status,
      archivedAt: t.archivedAt, updatedAt: t.updatedAt, queuedMessageCount: t.queuedMessageCount, queued: await this.bb.sdk.threads.queuedMessages.list({ threadId: t.id }) })));
  }
  private async refreshWorkerQuota() {
    await Promise.all(this.store.tasks().filter(t => t.kind === "worker" && t.thread_id && ["running", "unknown"].includes(t.status)).map(async task => {
      try {
        const thread = await this.bb.sdk.threads.get({ threadId: task.thread_id! });
        if (thread.queuedMessageCount > 0) return;
        const status = thread.archivedAt || thread.deletedAt ? "stopped" : thread.status === "error" ? "failed" : thread.status === "idle" ? "turn_ended" : null;
        if (status) this.store.db.prepare("UPDATE voice_tasks SET status = ?, updated_at = ? WHERE op_id = ?").run(status, thread.updatedAt, task.op_id);
      } catch (error) { this.bb.log.warn(`Live runtime keeps unavailable worker ${task.thread_id} in the quota: ${String(error)}`); }
    }));
  }
  private async read(input: ToolInput, call: CallState): Promise<unknown> {
    switch (input.tool) {
      case "queued_messages": {
        const args = liveToolArgs.queued_messages.parse(input.args);
        if (args.op !== "list") throw new Error("queued_messages changes are effects");
        if (!call.allowed.has(args.thread_id)) throw new Error(`Not authorized: unknown target ID ${args.thread_id}. Resolve it with find_targets or read_threads first.`);
        const queued = await this.bb.sdk.threads.queuedMessages.list({ threadId: args.thread_id });
        this.state(input.nonce, input.conversationId);
        const own = new Map((this.store.db.prepare("SELECT id, queued_message_id FROM voice_operations WHERE conversation_id = ? AND target_thread_id = ? AND queued_message_id IS NOT NULL").all(input.conversationId, args.thread_id) as { id: string; queued_message_id: string }[]).map(r => [r.queued_message_id, r.id]));
        const items = queued.map((q, position) => ({ id: q.id, position: position + 1, text: queuedText(q), createdAt: q.createdAt, editable: q.editable, sendAt: q.sendAt,
          waitingOn: q.waitingOn?.kind ?? null, failureReason: q.failureReason, fromThisConversation: own.has(q.id), ...(own.has(q.id) ? { operationId: own.get(q.id) } : {}) }));
        items.forEach(q => this.remember(call, q.id));
        return { threadId: args.thread_id, queued: items, asOf: this.now() };
      }
      case "list_models": {
        const args = liveToolArgs.list_models.parse(input.args);
        const { host } = await this.destination(undefined, args.host_id);
        const all = await this.catalog(host.id);
        const providers = args.provider ? [resolveName(args.provider, all, p => `${p.id} ${p.name}`)].filter((p): p is typeof all[number] => !!p) : all;
        this.state(input.nonce, input.conversationId);
        this.remember(call, host.id);
        return { hostId: host.id, hostName: host.name, providers, asOf: this.now() };
      }
      case "find_targets": {
        const args = liveToolArgs.find_targets.parse(input.args), tokens = queryTokens(args.query);
        const [projects, hosts] = await Promise.all([this.bb.sdk.projects.list({ includePersonal: true }), this.bb.sdk.hosts.list()]);
        type Candidate = Pick<Thread, "id" | "title" | "titleFallback" | "projectId" | "parentThreadId" | "status" | "createdAt" | "updatedAt" | "archivedAt" | "deletedAt">;
        const found: Candidate[] = [];
        let truncated = false;
        const listArgs = args.parent_id ? { parentThreadId: args.parent_id, includeHidden: true } : args.include_children ? {} : { hasParent: false };
        for (const archived of args.include_archived ? [false, true] : [false]) {
          for (let offset = 0; offset < 1000; offset += 100) {
            const page = await this.bb.sdk.threads.list({ archived, ...listArgs, limit: 100, offset });
            found.push(...page);
            if (page.length < 100) break;
            if (offset === 900) truncated = true;
          }
        }
        const tasks = args.parent_id ? [] : this.store.tasks(input.conversationId).filter(t => t.thread_id);
        const taskThreads = (await Promise.all(tasks.map(t => this.bb.sdk.threads.get({ threadId: t.thread_id! }).catch(() => null)))).filter((t): t is Thread => !!t);
        // BB's own search sees message bodies, so it can find a thread whose title never says the words.
        const searched = new Set<string>();
        if (tokens.length > 0 && !args.parent_id) {
          const search = await this.bb.sdk.threads.search({ query: args.query }).catch(() => ({} as Record<string, { total: number; results: { thread: Candidate }[] }>));
          for (const group of Object.values(search)) {
            if (group.total > group.results.length) truncated = true;
            for (const entry of group.results) { searched.add(entry.thread.id); found.push(entry.thread); }
          }
        }
        const byId = new Map<string, Candidate>([...found, ...taskThreads].filter(t => !t.deletedAt && (args.include_archived || !t.archivedAt) &&
          (args.parent_id ? t.parentThreadId === args.parent_id : args.include_children || !t.parentThreadId)).map(t => [t.id, t]));
        // The title is what the user knows a thread by. The prompt excerpt only stands in for a missing title; BB search covers bodies.
        const name = (t: Candidate) => t.title?.trim() || t.titleFallback || "";
        // Strong title matches and message hits come first. A few weak matches follow when little else was found, so the model can offer a near miss instead of nothing.
        // "The child that thread just started" is the newest by creation; elsewhere recent activity matters more.
        const scored = rank([...byId.values()], tokens, name, t => args.parent_id ? t.createdAt : t.updatedAt, { threshold: 0, limit: Number.MAX_SAFE_INTEGER });
        const strong = scored.filter(({ item, match }) => match >= 0.5 || searched.has(item.id));
        const weak = scored.filter(entry => !strong.includes(entry) && entry.match >= 0.25);
        const ranked = strong.length >= 5 ? strong : [...strong, ...weak];
        const projectName = new Map(projects.map(p => [p.id, p.name]));
        const threads = ranked.slice(0, 30).map(({ item: t, match }) => ({ id: t.id, title: threadName(t), match, projectId: t.projectId, projectName: projectName.get(t.projectId) ?? null,
          parentThreadId: t.parentThreadId, status: t.status, createdAt: t.createdAt, updatedAt: t.updatedAt, archived: t.archivedAt !== null, ...(searched.has(t.id) ? { foundInMessages: true } : {}) }));
        // Every project is listed so the model can resolve an imprecise name itself; the list is small.
        const ps = rank(projects, tokens, p => p.name, p => p.updatedAt ?? 0, { threshold: 0, limit: Number.MAX_SAFE_INTEGER }).map(({ item: p, match }) => ({ id: p.id, name: p.name, match, outsideProject: p.kind === "personal", hostIds: p.sources.map(s => s.hostId) }));
        const hs = hosts.map(h => ({ id: h.id, name: h.name, status: h.status }));
        threads.forEach(t => this.remember(call, t.id, t.projectId, t.parentThreadId)); ps.forEach(p => this.remember(call, p.id, ...p.hostIds)); hs.forEach(h => this.remember(call, h.id));
        return { threads, projects: ps, hosts: hs, searched: { query: args.query, words: tokens, includeChildren: !!args.include_children, includeArchived: !!args.include_archived, parentId: args.parent_id ?? null, conversationTasks: !args.parent_id }, asOf: this.now(), truncated: truncated || ranked.length > 30 };
      }
      case "read_threads": {
        const args = liveToolArgs.read_threads.parse(input.args);
        const threads = await Promise.all(args.thread_ids.map(async threadId => {
          try {
            const [thread, output, interactions] = await Promise.all([this.bb.sdk.threads.get({ threadId, ...(args.what === "environment" ? { include: "environment" } : {}) }), this.bb.sdk.threads.output({ threadId }), this.bb.sdk.threads.interactions.list({ threadId })]);
            this.remember(call, thread.id, thread.projectId, thread.parentThreadId);
            const pending = interactions.filter(i => i.status === "pending");
            pending.forEach(i => this.remember(call, i.id));
            let updates: InboxRow[] | undefined;
            if (args.what === "updates") {
              const root = await this.watches.root(thread); this.watches.trigger(input.conversationId, "ask", root);
              updates = this.store.inbox(input.conversationId).filter(i => i.root_thread_id === root && i.status !== "resolved");
            }
            const environment = args.what === "environment" ? environmentData((thread as { environment?: EnvironmentInfo | null }).environment) : undefined;
            return { threadId, title: threadName(thread), status: thread.status, projectId: thread.projectId, parentThreadId: thread.parentThreadId, environmentId: thread.environmentId,
              ...(environment !== undefined ? { environment } : {}),
              output: tail(output.output), receipts: this.operations.forThread(input.conversationId, threadId),
              pendingInteractions: await Promise.all(pending.map(i => describeInteraction(this.bb, i))), ...(updates ? { updates } : {}), task: this.taskData(input.conversationId, threadId),
              asOf: this.now(), evidenceAt: thread.updatedAt, ageMs: Math.max(0, this.now() - thread.updatedAt), source: "BB thread and latest output" };
          } catch (error) { return { threadId, missing: true, error: errorMessage(error), asOf: this.now() }; }
        }));
        this.state(input.nonce, input.conversationId);
        for (const thread of threads) {
          if ("pendingInteractions" in thread) thread.pendingInteractions?.forEach(i => this.present(call, `interaction:${i.id}`));
          if ("updates" in thread) thread.updates?.forEach(i => this.present(call, `inbox:${i.id}`));
        }
        return { threads, asOf: this.now() };
      }
      case "subscriptions": {
        const args = liveToolArgs.subscriptions.parse(input.args);
        if (args.op !== "list") {
          if (!args.thread_id) throw new Error("A thread_id is required");
          if (input.responseOrigin === "background") throw new Error("Not authorized: background updates cannot act");
          if (args.op === "unsubscribe") await this.watches.unsubscribe(input.conversationId, args.thread_id);
          else { await this.watches.watch(input.conversationId, args.thread_id, true); await this.watches.refreshThread(args.thread_id); }
        }
        const items = this.store.watches(input.conversationId); items.forEach(w => this.remember(call, w.thread_id, w.root_thread_id));
        return { items, asOf: this.now() };
      }
      case "prepare_archive": {
        const { thread_ids } = liveToolArgs.prepare_archive.parse(input.args);
        if (!input.utterance) throw new Error("Not authorized: archive preview needs a user utterance");
        if (thread_ids.some(id => !call.allowed.has(id))) throw new Error("Not authorized: unknown target ID. Resolve it with find_targets or read_threads first.");
        const scope = await this.archiveScope(thread_ids), previewId = randomUUID();
        scope.forEach(t => this.remember(call, t.id));
        const selected = new Set(thread_ids);
        const roots = [...selected].filter(id => {
          let parent = scope.find(t => t.id === id)?.parentThreadId;
          const seen = new Set<string>();
          while (parent && !seen.has(parent)) {
            if (selected.has(parent)) return false;
            seen.add(parent); parent = scope.find(t => t.id === parent)?.parentThreadId;
          }
          return true;
        });
        call.previews.set(previewId, { roots, scopeHash: hash(scope), utteranceId: input.utterance.id, used: false });
        this.present(call, `preview:${previewId}`);
        return { previewId, threads: scope, activeWork: scope.some(t => ["active", "starting"].includes(t.status) || t.queuedMessageCount > 0), asOf: this.now(), truncated: false };
      }
      case "remain_silent": return { action: "remain_silent", updates: liveToolArgs.remain_silent.parse(input.args).updates ?? "defer" };
      case "end_call":
        if (input.responseOrigin === "background") throw new Error("Not authorized: background updates cannot act");
        return { action: "end_call", afterDrain: true };
      default: throw new Error("Unsupported read tool");
    }
  }
  async beginClientEffect(raw: ToolInput) {
    const input = liveToolInputSchema.parse(raw), args = this.parse(input);
    this.authorize(input, args);
    if (input.tool !== "prepare_draft" && input.tool !== "control_ui") throw new Error("Only prepare_draft and control_ui run on the client");
    if (input.tool === "prepare_draft") {
      const draft = liveToolArgs.prepare_draft.parse(args);
      if (!!draft.thread_id === !!draft.project_id) throw new Error("Choose exactly one composer target");
    } else {
      const ui = liveToolArgs.control_ui.parse(args);
      if ((ui.action === "open_thread" && !ui.thread_id) || (ui.action === "open_project" && !ui.project_id) || (ui.action === "preview_file" && (!ui.path || !ui.thread_id)) || (ui.action === "switch_space" && !ui.space)) throw new Error("The UI action is missing its target");
    }
    let action: UiAction;
    if (input.tool === "prepare_draft") {
      const draft = liveToolArgs.prepare_draft.parse(args);
      action = { kind: "prepare_draft", target: draft.thread_id ? { kind: "thread", threadId: draft.thread_id } : { kind: "new", projectId: draft.project_id }, text: draft.text, mode: draft.mode };
    } else {
      const ui = liveToolArgs.control_ui.parse(args);
      if (ui.action === "preview_file") {
        if (ui.source === "thread-storage") action = { kind: "preview_file", target: { kind: "thread-storage", threadId: ui.thread_id!, path: ui.path! } };
        else {
          const thread = await this.bb.sdk.threads.get({ threadId: ui.thread_id! });
          if (!thread.environmentId) throw new Error("This thread has no workspace");
          action = { kind: "preview_file", target: { kind: "workspace", environmentId: thread.environmentId, path: ui.path! } };
        }
      } else if (ui.action === "open_thread") action = { kind: "open_thread", threadId: ui.thread_id!, split: false };
      else if (ui.action === "open_project") action = { kind: "open_project", projectId: ui.project_id! };
      else if (ui.action === "switch_space") action = { kind: "switch_space", space: ui.space! };
      else action = { kind: "show_voice" };
    }
    this.authorize(input, args);
    action = UiActionSchema.parse(action);
    const begun = this.operations.begin({ ...input, args });
    if ("thread_id" in args && typeof args.thread_id === "string") this.store.db.prepare("UPDATE voice_operations SET target_thread_id = ? WHERE id = ?").run(args.thread_id, begun.row.id);
    return json({ execute: begun.execute, operationId: begun.row.id, receipt: this.operations.receipt(begun.row), action });
  }
  finishClientEffect(input: z.infer<typeof liveRpcContract.finishClientEffect.input>) {
    const call = this.state(input.nonce), row = this.operations.get(input.operationId);
    if (!row || row.call_nonce !== input.nonce || row.conversation_id !== call.conversationId || !["prepare_draft", "control_ui"].includes(row.tool)) throw new Error("Not authorized: client operation belongs to another call");
    return json(row.status === "accepted" ? this.operations.finish(row.id, input.status, input.result) : this.operations.receipt(row));
  }
  reportDrain(input: z.infer<typeof liveRpcContract.reportDrain.input>) {
    const call = this.state(input.nonce);
    const receivedAt = this.now();
    if (!call.drains.has(input.responseId)) {
      call.drains.set(input.responseId, { at: input.at, receivedAt });
      for (const item of call.presented.values()) if (item.spokenAt === null && item.returnedAt < receivedAt) item.spokenAt = input.at;
      for (const item of this.store.inbox(call.conversationId)) if (call.presented.get(`inbox:${item.id}`)?.spokenAt && !["question", "approval", "failed"].includes(item.kind))
        this.store.db.prepare("UPDATE voice_inbox SET status = 'spoken', eligible = 0 WHERE id = ?").run(item.id);
    }
    return { ok: true as const };
  }
  async nextUpdateBatch({ nonce }: { nonce: string }) {
    const call = this.state(nonce);
    if (!this.store.inbox(call.conversationId).some(item => item.eligible && ["queued", "offered"].includes(item.status))) return null;
    await this.watches.refreshInteractions(call.conversationId);
    this.state(nonce);
    const batch = this.watches.next(call.conversationId, nonce);
    if (batch) for (const item of batch.items.flatMap(i => [i, ...i.children])) {
      this.remember(call, item.thread_id, item.root_thread_id, item.interaction_id);
      if (item.interaction_id) this.present(call, `interaction:${item.interaction_id}`);
    }
    return json(batch);
  }
  closeOffer(input: z.infer<typeof liveRpcContract.closeOffer.input>) {
    const call = this.state(input.nonce), offer = this.watches.offer(input.offerId);
    if (!offer || offer.call_nonce !== input.nonce || offer.conversation_id !== call.conversationId) throw new Error("Not authorized: offer belongs to another call");
    const responseId = input.responseId ?? [...call.drains].filter(([, drain]) => drain.receivedAt > offer.created_at).sort((a, b) => b[1].receivedAt - a[1].receivedAt)[0]?.[0];
    const outcome = input.outcome === "delivered" && (!responseId || (call.drains.get(responseId)?.receivedAt ?? 0) <= offer.created_at)
      ? "not_delivered" : input.outcome;
    const closed = this.watches.close(input.offerId, outcome, responseId);
    if (closed && outcome !== "delivered") for (const id of JSON.parse(offer.item_ids_json) as string[]) {
      call.presented.delete(`inbox:${id}`);
      const item = this.store.inbox(call.conversationId).find(item => item.id === id);
      if (item?.interaction_id) call.presented.delete(`interaction:${item.interaction_id}`);
      if (outcome === "deferred") call.deferredAfter.set(id, [...call.exchanges].at(-1) ?? null);
    }
    return { closed };
  }
  finishUserExchange({ nonce, utteranceId }: { nonce: string; utteranceId: string }) {
    const call = this.state(nonce);
    if (!call.exchanges.has(utteranceId)) {
      call.exchanges.add(utteranceId);
      for (const item of this.store.inbox(call.conversationId)) if (call.deferredAfter.has(item.id) && call.deferredAfter.get(item.id) !== utteranceId) {
        if (item.status === "deferred" || item.status === "offered")
          this.store.db.prepare("UPDATE voice_inbox SET status = ?, eligible = 1 WHERE id = ?").run(item.status === "offered" ? "offered" : "queued", item.id);
        call.deferredAfter.delete(item.id);
      }
    }
    return { ok: true as const };
  }
  listLiveSubscriptions(input: { nonce: string; conversationId: string }) {
    const call = this.state(input.nonce, input.conversationId), items = this.store.watches(input.conversationId);
    items.forEach(w => this.remember(call, w.thread_id, w.root_thread_id));
    return json({ items, asOf: this.now() });
  }
  listLiveTasks(input: { nonce: string; conversationId: string }) {
    const call = this.state(input.nonce, input.conversationId), items = this.store.tasks(input.conversationId);
    items.forEach(t => this.remember(call, t.thread_id));
    return json({ items: items.map(t => ({ ...t, last_text: tail(t.last_text).text, truncated: tail(t.last_text).truncated })), asOf: this.now() });
  }
  private taskData(conversationId: string, threadId: string) {
    const task = this.store.tasks(conversationId).find(t => t.thread_id === threadId);
    return task ? { ...task, last_text: tail(task.last_text).text, truncated: tail(task.last_text).truncated } : null;
  }
}
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const isTimeout = (error: unknown) => error instanceof SdkTimeout || (error instanceof Error && (error.name === "TimeoutError" || /\b(?:ETIMEDOUT|timed out|timeout)\b/i.test(error.message)));
