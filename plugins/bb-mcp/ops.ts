import { ToolError } from "./config";
import { operationView, type Store } from "./store";

export type SdkCall = (path: string, args: unknown) => Promise<unknown>;

// The one thing callers cannot do themselves: a durable receipt that survives
// HTTP disconnects and dedupes retries by key. Everything else is a plain
// bb.sdk call.
export async function runOp(store: Store, args: unknown, call: SdkCall, blocked?: (callPath: string) => boolean) {
  const a = (args ?? {}) as { call?: unknown; args?: unknown; key?: unknown; kind?: unknown; threadId?: unknown; projectId?: unknown };
  if (typeof a.call !== "string" || !a.call) throw new ToolError("invalid_arguments", "ops.run requires a call path like \"threads.spawn\".");
  if (a.key !== undefined && typeof a.key !== "string") throw new ToolError("invalid_arguments", "key must be a string.");
  // Credential-bearing reads gain nothing from a receipt and would persist
  // secrets in plaintext — refuse to ledger them.
  if (blocked?.(a.call)) throw new ToolError("invalid_arguments", `"${a.call}" returns credentials or configuration; call it directly instead of recording a receipt.`);
  const kind = typeof a.kind === "string" && a.kind ? a.kind : a.call;
  const scope = {
    threadId: typeof a.threadId === "string" ? a.threadId : null,
    projectId: typeof a.projectId === "string" ? a.projectId : null,
  };
  // Receipt identity is the whole intent: call, args and declared scope. The
  // `kind` label is cosmetic and stays out of the fingerprint.
  const payload = { call: a.call, args: a.args, ...scope };
  const op = await store.run(
    { kind, call: a.call, ...scope, hostId: null },
    a.key, payload,
    async () => {
      const result = await call(a.call as string, a.args);
      const response: Record<string, unknown> = result !== null && typeof result === "object" && !Array.isArray(result) ? { ...(result as Record<string, unknown>) } : { result };
      if (typeof response.threadId !== "string" && typeof response.id === "string" && response.id.startsWith("thr_")) response.threadId = response.id;
      return response;
    },
  );
  return operationView(op);
}

// Receipts store full dispatch responses. Under bb_read the metadata stays
// readable, but a response recorded by an execute-only call (plugins.token,
// plugins.getSettings, system.config) is redacted — the live path hides it too.
export function getOp(store: Store, args: unknown, sensitive?: (callPath: string) => boolean) {
  const id = (args as { operationId?: unknown })?.operationId;
  const op = typeof id === "string" ? store.get(id) : undefined;
  if (!op) throw new ToolError("not_found", "Operation unavailable.");
  const view = operationView(op);
  if (sensitive?.(op.call ?? op.kind)) {
    view.response = null;
    (view as Record<string, unknown>).responseRedacted = "The recorded call is execute-only.";
  }
  return view;
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
  // A failed lookup is pre-commit: wrap it so the ledger records "failed",
  // not "outcome_unknown" (resolve was never sent).
  let interaction: {
    status?: unknown;
    expiresAt?: unknown;
    payload?: { kind?: unknown; expiresAt?: unknown; availableDecisions?: unknown; subject?: { kind?: unknown; sessionGrant?: unknown; permissions?: unknown } };
  };
  try {
    interaction = await call("threads.interactions.get", { threadId: a.threadId, interactionId: a.interactionId }) as typeof interaction;
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError("precondition_failed", `Could not load the interaction: ${e instanceof Error ? e.message : String(e)}`);
  }
  const payload = interaction?.payload;
  if (payload?.kind !== "approval") throw new ToolError("conflict", "Interaction is not a pending approval.");
  if (interaction.status !== undefined && interaction.status !== "pending")
    throw new ToolError("conflict", "Interaction is no longer pending.");
  const expiresAt = payload.expiresAt ?? interaction.expiresAt;
  if (typeof expiresAt === "number" && expiresAt <= Date.now())
    throw new ToolError("conflict", "Interaction has expired.");
  const offered = Array.isArray(payload.availableDecisions) ? payload.availableDecisions : [];
  if (offered.length && !offered.includes(decision))
    throw new ToolError("conflict", `Decision "${decision}" is not offered on this interaction.`);
  if (decision === "deny")
    return call("threads.interactions.resolve", { threadId: a.threadId, interactionId: a.interactionId, resolution: { decision: "deny" } });
  // Explicit null is meaningful (one-time allow); only an omitted key defaults.
  // The default is what the subject requested: permission_grant asks for
  // subject.permissions on either allow decision; other subjects offer a
  // sessionGrant that only applies to allow_for_session.
  const subject = payload.subject;
  const requested = subject?.kind === "permission_grant" ? subject.permissions
    : decision === "allow_for_session" ? subject?.sessionGrant : undefined;
  let grantedPermissions = a.grantedPermissions !== undefined ? a.grantedPermissions : (requested ?? null);
  // The grant object's children are required-but-nullable in the SDK schema.
  if (grantedPermissions !== null && typeof grantedPermissions === "object")
    grantedPermissions = { fileSystem: null, network: null, ...(grantedPermissions as Record<string, unknown>) };
  return call("threads.interactions.resolve", { threadId: a.threadId, interactionId: a.interactionId, resolution: { decision, grantedPermissions } });
}
