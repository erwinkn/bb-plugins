import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { ToolError } from "./config";
import { operationView, type Store } from "./store";

type Sdk = BbPluginApi["sdk"];
type PendingInteractionResolution = Parameters<Sdk["threads"]["interactions"]["resolve"]>[0]["resolution"];
type ForkArgs = Pick<Parameters<Sdk["threads"]["fork"]>[0], "sourceThreadId" | "sourceSeqEnd" | "title" | "permissionMode" | "visibility"> & { environmentId?: string; idempotencyKey?: string };
type InteractionTarget = { threadId: string; interactionId: string };
type PermissionResolution = Extract<PendingInteractionResolution, { decision: string }>;
export type PermissionArgs = InteractionTarget & {
  decision: PermissionResolution["decision"];
  grantedPermissions?: Extract<PermissionResolution, { decision: "allow_once" }>["grantedPermissions"];
  idempotencyKey?: string;
};
export type AnswerArgs = InteractionTarget & {
  answers?: Extract<PendingInteractionResolution, { kind: "user_answer" }>["answers"];
  value?: Parameters<Sdk["threads"]["interactions"]["respond"]>[0]["value"];
  idempotencyKey?: string;
};

export function createThreadManager(bb: BbPluginApi, store: Store) {
  const lifetime = new AbortController();
  bb.onDispose(() => lifetime.abort(new Error("BB MCP reloading")));
  // Optional keys cover dispatch and interaction responses as well as creates.
  // Replay before reading a target: a successfully answered prompt is no longer pending.
  async function mutation<T extends { idempotencyKey?: string }>(kind: string, args: T, threadId: string, action: () => Promise<unknown>) {
    const dispatch = async () => {
      const result = await action() ?? null;
      const newThreadId = kind === "fork" && result && typeof result === "object" && "id" in result && typeof result.id === "string" ? result.id : threadId;
      return { threadId: newThreadId, ...(kind === "fork" ? { sourceThreadId: threadId } : {}), result };
    };
    if (args.idempotencyKey === undefined) return dispatch();
    const old = store.find(args.idempotencyKey, kind, args);
    if (old) return operationView(old);
    const t = await bb.sdk.threads.get({ threadId });
    const op = await store.run({ kind, projectId: t.projectId, hostId: null, threadId }, args.idempotencyKey, args, dispatch);
    return operationView(op);
  }
  async function pending(target: InteractionTarget) {
    const interaction = await bb.sdk.threads.interactions.get(target);
    if (interaction.threadId !== target.threadId || interaction.id !== target.interactionId)
      throw new ToolError("interaction_mismatch", "The interaction does not belong to this thread.");
    if (interaction.status !== "pending" || (interaction.expiresAt != null && interaction.expiresAt <= Date.now()))
      throw new ToolError("interaction_not_pending", "This interaction is no longer pending. Read the thread's current interactions.");
    return interaction;
  }
  return {
    fork(args: ForkArgs) {
      const { idempotencyKey: _key, environmentId, ...native } = args;
      return mutation("fork", args, args.sourceThreadId, () => bb.sdk.threads.fork({ ...native, ...(environmentId ? { environment: { type: "reuse", environmentId } } : {}) }));
    },
    retry(args: Parameters<Sdk["threads"]["retry"]>[0] & { idempotencyKey?: string }) {
      const { idempotencyKey: _key, ...native } = args;
      return mutation("retry", args, args.threadId, () => bb.sdk.threads.retry(native));
    },
    async archive(args: { threadId: string }) { return { result: await bb.sdk.threads.archive(args) }; },
    async unarchive(args: { threadId: string }) { return { result: await bb.sdk.threads.unarchive(args) }; },
    async setPinned({ threadId, pinned }: { threadId: string; pinned: boolean }) { return { result: await (pinned ? bb.sdk.threads.pin({ threadId }) : bb.sdk.threads.unpin({ threadId })) }; },
    async setRead({ threadId, read }: { threadId: string; read: boolean }) { return { result: await (read ? bb.sdk.threads.markRead({ threadId }) : bb.sdk.threads.markUnread({ threadId })) }; },
    async reorderPinned(args: Parameters<Sdk["threads"]["reorderPinned"]>[0]) { return { result: await bb.sdk.threads.reorderPinned(args) }; },
    async listSections() { return { sections: await bb.sdk.threadSections.list() }; },
    async createSection(args: { name: string }) { return { section: await bb.sdk.threadSections.create(args) }; },
    async renameSection({ sectionId, name }: { sectionId: string; name: string }) { return { section: await bb.sdk.threadSections.update({ id: sectionId, name }) }; },
    async wait(args: Omit<Parameters<Sdk["threads"]["wait"]>[0], "signal">, signal?: AbortSignal) {
      return { result: await bb.sdk.threads.wait({ ...args, signal: signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal }) };
    },
    async listQueue(args: { threadId?: string }) { return { queuedMessages: await bb.sdk.threads.queue.list(args) }; },
    async updateQueued({ message, ...target }: { threadId: string; queuedMessageId: string; expectedUpdatedAt: number; message: string }) {
      return { queuedMessage: await bb.sdk.threads.queuedMessages.update({ ...target, input: [{ type: "text", text: message, mentions: [] }] }) };
    },
    async cancelQueued(args: { threadId: string; queuedMessageId: string }) { return { result: await bb.sdk.threads.queuedMessages.delete(args) }; },
    async reorderQueued(args: Parameters<Sdk["threads"]["queuedMessages"]["reorder"]>[0]) { return { result: await bb.sdk.threads.queuedMessages.reorder(args) }; },
    sendQueued(args: Parameters<Sdk["threads"]["queuedMessages"]["send"]>[0] & { idempotencyKey?: string }) {
      const { idempotencyKey: _key, ...native } = args;
      return mutation("queue-send", args, args.threadId, () => bb.sdk.threads.queuedMessages.send(native));
    },
    async listInteractions(args: { threadId: string }) { return { interactions: await bb.sdk.threads.interactions.list(args) }; },
    async getInteraction(args: InteractionTarget) { return { interaction: await bb.sdk.threads.interactions.get(args) }; },
    answer(args: AnswerArgs) {
      const { threadId, interactionId, answers, value } = args;
      return mutation("answer", args, threadId, async () => {
        const interaction = await pending({ threadId, interactionId });
        if (interaction.payload.kind === "approval") throw new ToolError("approval_required", "Use bb_approve_permission for an approval request.");
        if (interaction.payload.kind === "user_question") {
          if (!answers || value !== undefined) throw new ToolError("invalid_answer", "Provide answers keyed by the question IDs, with selected option values and optional freeText.");
          return bb.sdk.threads.interactions.resolve({ threadId, interactionId, resolution: { kind: "user_answer", answers } });
        }
        if (value === undefined || answers !== undefined) throw new ToolError("invalid_answer", "Provide value matching this pending form's response contract.");
        return bb.sdk.threads.interactions.respond({ threadId, interactionId, value });
      });
    },
    approve(args: PermissionArgs) {
      const { threadId, interactionId, decision } = args;
      return mutation("permission", args, threadId, async () => {
        const interaction = await pending({ threadId, interactionId });
        const payload = interaction.payload;
        if (payload.kind !== "approval") throw new ToolError("not_approval", "This interaction is not an approval request. Use bb_answer_question for questions/forms.");
        if (!payload.availableDecisions.includes(decision)) throw new ToolError("unsupported_decision", "The requested decision is not offered by this pending approval.");
        const permissions = args.grantedPermissions !== undefined ? args.grantedPermissions : payload.subject.kind === "permission_grant" ? payload.subject.permissions
          : "sessionGrant" in payload.subject && decision === "allow_for_session" ? payload.subject.sessionGrant : null;
        const resolution: PermissionResolution = decision === "deny" ? { decision } : { decision, grantedPermissions: permissions };
        return bb.sdk.threads.interactions.resolve({ threadId, interactionId, resolution });
      });
    },
  };
}
