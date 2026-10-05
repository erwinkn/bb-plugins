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
 * The supported retry for a reported (not yet accepted) assignment. Work: task-accept for
 * a succeeded report, otherwise assignment-reject, which keeps the report in the ledger and
 * frees its tasks for a new assignment. Review: review-accept or assignment-reject, then a
 * fresh independent reviewer; a reviewer is never continued. A report that still lists
 * background work waits for the worker's updated report, unless its context has ended
 * (assignment-reject then checks native end evidence itself).
 */
export function reportedRetryHint(a: AssignmentRecord, taskRef: string): string {
  const worker = `W${a.workerNum}`;
  const review = a.role === "review";
  if (a.report?.pendingBackgroundWork.length)
    return `${a.ref}'s report still lists background work, so it cannot be ${a.report.outcome === "succeeded" ? "accepted or rejected" : "rejected"} until ${worker} reports again: wait for an updated final report from ${worker} once that work finishes. If ${worker} is retired or its thread is archived or deleted, assignment-reject proceeds once BB confirms that thread has ended and records the listed work as unverified; those jobs may still be running and keep ${a.ref}'s write scope until an explicit assignment-scope-release; a rejected assignment takes no later report.`;
  const reject = `reject ${a.ref}'s report with initiative_task {"action":"assignment-reject","assignment":"${a.ref}","reason":"…"} (its report${a.report?.blocker ? ", blocker" : ""} and handoff stay in the ledger)`;
  if (review) {
    if (a.report?.outcome === "succeeded")
      return `Accept the review with initiative_task {"action":"review-accept","assignment":"${a.ref}"}, or ${reject}.`;
    return `${reject[0]!.toUpperCase()}${reject.slice(1)}, then delegate a fresh independent reviewer: role review, route fresh, access read-only, reviewOf ${JSON.stringify((a.reviewOf ?? []).map((n) => `T${n}`))} and reviewTargets ${JSON.stringify((a.reviewTargets ?? []).map(({ task, assignment, revision }) => ({ task, assignment, revision })))}.`;
  }
  if (a.report?.outcome === "succeeded")
    return `Accept it with task-accept, or ${reject}, before delegating ${taskRef} again.`;
  return `To retry ${taskRef}, ${reject}, then delegate ${taskRef} again, usually route continue to ${worker} ${a.report?.blocker ? "with the answer to its blocker" : "with what the retry needs"}.`;
}
