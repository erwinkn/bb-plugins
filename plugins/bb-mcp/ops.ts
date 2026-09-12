import { ToolError } from "./config";
import { operationView, type Store } from "./store";

export type SdkCall = (path: string, args: unknown) => Promise<unknown>;

// The one thing callers cannot do themselves: a durable receipt that survives
// HTTP disconnects and dedupes retries by key. Everything else is a plain
// bb.sdk call.
export async function runOp(store: Store, args: unknown, call: SdkCall) {
  const a = (args ?? {}) as { call?: unknown; args?: unknown; key?: unknown; kind?: unknown; threadId?: unknown; projectId?: unknown };
  if (typeof a.call !== "string" || !a.call) throw new ToolError("invalid_arguments", "ops.run requires a call path like \"threads.spawn\".");
  if (a.key !== undefined && typeof a.key !== "string") throw new ToolError("invalid_arguments", "key must be a string.");
  const kind = typeof a.kind === "string" && a.kind ? a.kind : a.call;
  const payload = { call: a.call, args: a.args };
  const old = store.find(a.key, kind, payload);
  if (old) return operationView(old);
  const op = await store.run(
    { kind, projectId: typeof a.projectId === "string" ? a.projectId : null, hostId: null, threadId: typeof a.threadId === "string" ? a.threadId : null },
    a.key, payload,
    async () => {
      const result = await call(a.call as string, a.args);
      const response: Record<string, unknown> = result !== null && typeof result === "object" ? { ...(result as Record<string, unknown>) } : { result };
      if (typeof response.threadId !== "string" && typeof response.id === "string") response.threadId = response.id;
      return response;
    },
  );
  return operationView(op);
}

export function getOp(store: Store, args: unknown) {
  const id = (args as { operationId?: unknown })?.operationId;
  const op = typeof id === "string" ? store.get(id) : undefined;
  if (!op) throw new ToolError("not_found", "Operation unavailable.");
  return operationView(op);
}

// Operator-only recovery for an outcome_unknown receipt. The thread must exist
// and match the recorded one; reconciliation records acceptance, it does not
// execute work.
export async function reconcileOp(store: Store, call: SdkCall, operationId: string, threadId: string) {
  const op = store.get(operationId);
  if (!op || op.state !== "outcome_unknown") throw new ToolError("conflict", "Only an outcome_unknown operation can be reconciled.");
  if (op.threadId && op.threadId !== threadId) throw new ToolError("conflict", "The thread does not match the operation's record.");
  const t = await call("threads.get", { threadId }) as { projectId?: unknown };
  if (op.projectId && t && typeof t === "object" && typeof t.projectId === "string" && t.projectId !== op.projectId)
    throw new ToolError("conflict", "The thread's project does not match the operation's record.");
  return operationView(store.reconcile(operationId, threadId));
}

// Resolves a pending permission approval the way `bb thread approve` /
// `bb thread grant --scope session` do. The SDK's resolution union requires
// grantedPermissions to be present (nullable) on allow_* decisions — omitting
// it fails with a cryptic "Invalid discriminator value". Session approvals
// default to the request's offered sessionGrant.
export async function approveInteraction(args: unknown, call: SdkCall) {
  const a = (args ?? {}) as { threadId?: unknown; interactionId?: unknown; decision?: unknown; grantedPermissions?: unknown };
  if (typeof a.threadId !== "string" || typeof a.interactionId !== "string")
    throw new ToolError("invalid_arguments", "approve requires { threadId, interactionId }.");
  const decision = a.decision;
  if (decision !== "allow_once" && decision !== "allow_for_session" && decision !== "deny")
    throw new ToolError("invalid_arguments", "decision must be allow_once, allow_for_session or deny.");
  if (decision === "deny" && a.grantedPermissions !== undefined)
    throw new ToolError("invalid_arguments", "deny does not take grantedPermissions.");
  const interaction = await call("threads.interactions.get", { threadId: a.threadId, interactionId: a.interactionId }) as {
    payload?: { kind?: unknown; availableDecisions?: unknown; subject?: { sessionGrant?: unknown } };
  };
  const payload = interaction?.payload;
  if (payload?.kind !== "approval") throw new ToolError("conflict", "Interaction is not a pending approval.");
  const offered = Array.isArray(payload.availableDecisions) ? payload.availableDecisions : [];
  if (offered.length && !offered.includes(decision))
    throw new ToolError("conflict", `Decision "${decision}" is not offered on this interaction.`);
  if (decision === "deny")
    return call("threads.interactions.resolve", { threadId: a.threadId, interactionId: a.interactionId, resolution: { decision: "deny" } });
  const grantedPermissions = a.grantedPermissions ?? (decision === "allow_for_session" ? payload.subject?.sessionGrant : undefined) ?? null;
  return call("threads.interactions.resolve", { threadId: a.threadId, interactionId: a.interactionId, resolution: { decision, grantedPermissions } });
}
