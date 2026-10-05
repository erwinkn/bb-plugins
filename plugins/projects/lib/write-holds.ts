import { createHash } from "node:crypto";
import { pathsOverlap } from "./policy";
import type { AssignmentRecord } from "./store";

/**
 * T91: a write assignment keeps its declared scope after it stops counting as
 * running work, for as long as its native thread may still run or its report
 * lists unverified background work (D343). This module is the pure part: which
 * past assignments could hold a new write, grouped by native thread. Native
 * evidence is read separately, once, before dispatch's final reservation re-read.
 */

/**
 * Settled-looking states whose thread may still be running or own detached jobs.
 * Cancelled and failed work counts too (A205 F1): a stopped writer's late report can
 * list background jobs, and its thread may keep running after the op settles.
 */
const HOLD_STATES = new Set(["reported", "accepted", "rejected", "idle_no_report", "stopped", "cancelled", "failed"]);

/**
 * A short fingerprint of one report filing, binding a scope release to the filing it
 * was given for. The filing count makes an identical re-file a new version even on a
 * frozen clock; the filing time also covers reports stored by a build that did not count.
 */
export const reportVersion = (a: Pick<AssignmentRecord, "report" | "reportSeq" | "reportedAt">) =>
  createHash("sha256").update(JSON.stringify([a.reportSeq, a.reportedAt, a.report ?? null])).digest("hex").slice(0, 16);

/** Listed background work a report still claims, unless explicitly released for this very report. */
export function unreleasedBackground(a: AssignmentRecord): string[] {
  const listed = a.report?.pendingBackgroundWork ?? [];
  if (!listed.length) return [];
  return a.scopeRelease?.reportVersion === reportVersion(a) ? [] : listed;
}

export interface HoldGroup {
  threadId: string;
  /** The overlapping assignments on this thread, oldest first. */
  assignments: AssignmentRecord[];
  /** Union of their recorded scopes; null when any has none (whole project). */
  paths: string[] | null;
  /** Unreleased listed background work across them. */
  background: string[];
  /** Changes whenever any of them is re-reported, settled or released. */
  signature: string;
}

/**
 * Past write assignments in the same project and workspace whose recorded scope
 * overlaps `paths`, grouped by native thread. Assignments still counted as running
 * work (dispatching/queued/running, unresolved op or live queue receipt) are left
 * to the running check. Only a continuation's own thread is exempt.
 */
export function holdGroups(
  assignments: readonly AssignmentRecord[],
  scope: { bbProjectId: string; environmentId: string | null; paths: string[]; exemptThreadId: string | null },
): HoldGroup[] {
  const groups = new Map<string, AssignmentRecord[]>();
  for (const a of assignments) {
    if (a.role !== "work" || a.access === "read-only" || a.bbProjectId !== scope.bbProjectId) continue;
    if (!HOLD_STATES.has(a.state) || a.opState === "pending" || a.opState === "uncertain" || a.queuedMessageId !== null) continue;
    if (!a.threadId || a.threadId === scope.exemptThreadId) continue;
    // A different checkout cannot write over this one.
    if (a.environmentId && scope.environmentId && a.environmentId !== scope.environmentId) continue;
    if (a.writeScope !== null && !pathsOverlap(scope.paths, a.writeScope)) continue;
    groups.set(a.threadId, [...(groups.get(a.threadId) ?? []), a]);
  }
  return [...groups].map(([threadId, held]) => ({
    threadId,
    assignments: held,
    paths: held.some(a => a.writeScope === null) ? null : [...new Set(held.flatMap(a => a.writeScope!))],
    background: held.flatMap(unreleasedBackground),
    signature: JSON.stringify(held.map(a => [a.num, a.state, a.opState, reportVersion(a), a.scopeRelease?.reportVersion ?? null])),
  }));
}
