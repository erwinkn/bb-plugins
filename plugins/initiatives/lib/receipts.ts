import type { AssignmentRecord } from "./store";

/**
 * Plain explanations of an assignment's native receipt state, built from the
 * ledger record alone (no native reads). They name what is pending and the
 * supported way forward; they never change a guard.
 *
 * What actually releases an unsettled operation (see reconcile and
 * settleCancelledIfQuiet): a cancelled assignment whose native thread is known
 * (any continue route, or a confirmed fresh/fork thread) is released by the
 * sweep alone, once any leftover queued brief is gone and the thread is
 * positively quiet or gone. Missing from bounded queue/history reads is never
 * proof a brief did not run. Only an unconfirmed fresh/fork creation, or a
 * live send the sweep cannot confirm, needs inspection and an explicit settle.
 * Operations already done or failed are terminal: neither the sweep nor a
 * settle acts on them again, so their text never asks anyone to wait or settle.
 */

const isCancelled = (a: AssignmentRecord) => a.state === "cancelled" || a.cancelRequested;
/** Only these operations are still open; the sweep and explicit settles act on nothing else. */
const isUnresolved = (a: AssignmentRecord) => a.opState === "pending" || a.opState === "uncertain";

/** Why this pending/uncertain operation still blocks the worker, and what clears it. */
export function unsettledReason(a: AssignmentRecord): string {
  const op = `${a.ref} (op ${a.opId} ${a.opState}, assignment ${a.state})`;
  const threadKnown = a.route === "continue" || a.threadId !== null;
  if (isCancelled(a) && threadKnown) {
    const queued = a.queuedMessageId
      ? ` Its queued brief ${a.queuedMessageId} may still dispatch; the sweep keeps deleting it, and removing it alone does not release anything.`
      : "";
    return `${op}: Stop was requested and ${a.threadId ?? "its thread"} may still run.${queued} Nothing needs settling by hand: the sweep releases the reservation once ${a.queuedMessageId ? "the queued brief is gone and the thread is" : "the thread is"} positively quiet (idle, no queued or background work) or gone. A brief missing from bounded queue/history reads is not proof it never ran.`;
  }
  if (isCancelled(a))
    return `${op}: Stop was requested, but BB never confirmed whether its thread was created. The sweep keeps looking for it and, if found, releases the reservation once that thread is positively quiet. If it stays unconfirmed, inspect BB's threads, then record assignment-settle outcome {"threadId":"…"} for a thread that exists, or {"notSent":true} only when you have established that nothing started.`;
  return `${op}: BB never confirmed this ${a.route === "continue" ? "send" : "thread creation"}. The sweep keeps checking${a.route === "continue" ? " the thread's queue and history" : " for the created thread"}; if it stays unconfirmed, inspect it, then record assignment-settle outcome {"threadId":"…"} if it arrived, or {"notSent":true} only when you have established that nothing started. Never resend on a missing receipt alone.`;
}

/**
 * The receipt state that blocks checkpointing: an unresolved (pending/uncertain)
 * operation or a live queued brief. A settled cancellation is history and never
 * reaches this helper (T89).
 */
export function receiptBlockReason(a: AssignmentRecord): string {
  if (isUnresolved(a)) return unsettledReason(a);
  return `${a.ref} (op ${a.opId} ${a.opState}, assignment ${a.state}): its brief ${a.queuedMessageId} is still in BB's native queue. The ledger follows by itself when BB dispatches it; stop the assignment if it should not run.`;
}

/** The first thing an assignment-settle result says, ahead of the full record. */
export function settlementReceipt(a: AssignmentRecord, outcome: { threadId: string } | { notSent: true }): string {
  if ("threadId" in outcome && isCancelled(a) && a.opState !== "done")
    return `${a.ref}: delivery to ${outcome.threadId} confirmed; native quiet confirmation still pending. ${a.ref} is cancelled, so op ${a.opId} stays ${a.opState} until a sweep sees the thread positively quiet and releases its tasks. This settle confirmed delivery only, not quiet or task release.`;
  if ("threadId" in outcome)
    return `${a.ref}: delivery to ${outcome.threadId} confirmed; op ${a.opId} is ${a.opState} and the assignment is ${a.state}.`;
  return `${a.ref}: recorded as never sent; op ${a.opId} is ${a.opState} and the assignment is ${a.state}.`;
}

/**
 * Why a worker cannot be messaged, from its latest assignment, and what the
 * coordinator does instead. Messages never grant work or bypass a Stop.
 */
export function noDeliverableWorkReason(workerRef: string, latest: AssignmentRecord | null | undefined): string {
  const base = `${workerRef} has no current deliverable work`;
  const tail = "Stopped, cancelled, unconfirmed or finished work cannot be messaged, and peer messages grant no work, cannot resume it and cannot bypass a Stop.";
  if (!latest) return `${base}. ${tail} For authorized new work, the coordinator delegates to ${workerRef}.`;
  const state = `(latest ${latest.ref} is ${latest.state}${latest.cancelRequested ? ", Stop requested" : ""}, op ${latest.opState})`;
  if (!isCancelled(latest) && isUnresolved(latest))
    return `${base} ${state}. ${tail} ${latest.ref} is existing work whose dispatch is not confirmed yet: the coordinator confirms it (the sweep's reconcile, or assignment-settle after inspection), after which messages can reach it.`;
  if (isCancelled(latest) && isUnresolved(latest))
    return `${base} ${state}. ${tail} For authorized new work, the coordinator delegates a continuation to ${workerRef} once ${latest.ref}'s reservation is released (the sweep does that when its thread is positively quiet or gone).`;
  if (isCancelled(latest))
    return `${base} ${state}. ${tail} ${latest.ref}'s cancellation is already settled and its reservation released; for authorized new work, the coordinator can delegate a continuation to ${workerRef} now, subject to the usual native and Stop checks.`;
  return `${base} ${state}. ${tail} For authorized new work, the coordinator delegates a continuation to ${workerRef}.`;
}

/**
 * What to do instead with a reported assignment (T136): nothing is accepted or rejected.
 * Send fixes to the same worker as more work, or close the task when it is done.
 */
export function reportedRetryHint(a: AssignmentRecord, taskRef: string): string {
  const worker = `W${a.workerNum}`;
  const task = taskRef.split(",")[0]?.trim() || null;
  if (a.role === "review")
    return `Read the review's final message, send the fixes to the reviewed worker with initiative_message {"to":"${a.reviewTargets?.[0]?.worker ?? "W#"}","text":"<the fixes>","work":true}, and ask ${worker} to re-review with initiative_message {"to":"${worker}","text":"<what changed>","work":true}.`;
  return `To retry, send ${worker} the fixes as more work: initiative_message {"to":"${worker}","text":"<the fixes>","work":true}${task ? `. If it is done, close the task: initiative_task {"action":"close","task":"${task}","outcome":"done"}` : ""}.`;
}

/** A ledger record: task, worker, assignment or update. Decisions answer with their own short shape. */
const RECORD_REF = /^[TWAU]\d+$/;

/**
 * W215: what a write tool answers the coordinator. A record it just wrote comes back as its
 * ref and new state, never the brief or report the coordinator already has; what it must act
 * on (warnings, notes, notifications, a settlement, the new W# and thread) stays. Nulls are
 * dropped. Full records are one initiative_read {refs:[…]} away. E.g. a closed task is
 * {"ref":"T20","state":"done"}, a stop {"ref":"A187","worker":"W121","state":"cancelled"}.
 */
export function toolReceipt(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toolReceipt);
  if (!value || typeof value !== "object") return value;
  const v = value as Record<string, any>;
  if (typeof v.ref === "string" && RECORD_REF.test(v.ref)) {
    const a = v.ref.startsWith("A");
    return {
      ref: v.ref,
      ...(a && typeof v.workerNum === "number" ? { worker: `W${v.workerNum}` } : {}),
      ...(v.state ?? v.status ? { state: v.state ?? v.status } : {}),
      ...(a && v.opState && v.opState !== "done" ? { opState: v.opState } : {}),
      ...(v.settlement ? { settlement: v.settlement } : {}),
    };
  }
  // A plain message: who got it and whether it was sent now or queued.
  if ("target" in v && "receipt" in v) return { to: v.target, delivery: v.receipt?.delivery ?? null };
  if (Array.isArray(v.prs)) return { prs: v.prs.map(({ url, stage }: { url: string; stage: string }) => ({ url, stage })) };
  return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null && x !== undefined).map(([k, x]) => [k, toolReceipt(x)]));
}
