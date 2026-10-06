import type { Sdk } from "./bb";
import type { LiveThread } from "./overview";
import type { Store } from "./store";

/**
 * Queued messages BB is holding for an Initiative's members although nothing
 * is running to deliver them (T133). BB owns dispatch: this only names what is
 * held and why, and the user decides to send or remove it. A row still in
 * BB's queue was never dispatched (BB removes it in the same transaction that
 * records the turn), so acting on that row can never deliver a message twice.
 */
export type QueuedRow = Awaited<ReturnType<Sdk["threads"]["queue"]["list"]>>[number];

/** Long enough for BB's own drains (a 10 s sweep, 60 s after a failed turn) to have acted. */
export const HELD_AFTER_MS = 3 * 60_000;

export interface NotDeliveredMessage {
  id: string;
  threadId: string;
  /** "the coordinator", "a former coordinator" or a current worker's W#. */
  target: string;
  preview: string;
  queuedAt: number;
  reason: string;
}

const RUNNING = new Set(["active", "starting", "stopping"]);
/** Waits that only an ended turn clears; clocks, limiters and interactions hold rows on purpose. */
const TURN_END_WAITS = new Set(["thread-busy", "turn-starting", "stopping"]);

/** The member threads whose held messages the Initiative's Inbox shows. */
export function queueTargets(store: Store, projectId: string): Map<string, string> {
  const project = store.project(projectId);
  const targets = new Map<string, string>();
  if (!project) return targets;
  for (const generation of store.generations(projectId, 0).filter((g) => g.threadId !== project.coordinatorThreadId).slice(-5))
    targets.set(generation.threadId, "a former coordinator");
  for (const worker of store.workers(projectId))
    if (worker.threadId && worker.state !== "retired") targets.set(worker.threadId, worker.ref);
  if (project.coordinatorThreadId) targets.set(project.coordinatorThreadId, "the coordinator");
  return targets;
}

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function heldReason(row: QueuedRow, target: string, status: string): string {
  if (row.failureReason) return `BB stopped trying to send this to ${target}: ${row.failureReason}`;
  if (status === "error") return `${sentence(target)}'s last turn failed, and BB has not sent this since.`;
  if (status === "idle") return `${sentence(target)} is idle, but BB is holding this, usually because its turn was stopped by hand.`;
  return `${sentence(target)} has not started, and BB has not sent this yet.`;
}

function preview(row: QueuedRow): string {
  const text = row.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 240 ? `${text.slice(0, 239)}…` : text;
}

export function notDeliveredMessages(
  rows: readonly QueuedRow[],
  targets: ReadonlyMap<string, string>,
  live: ReadonlyMap<string, LiveThread>,
  now: number,
): NotDeliveredMessage[] {
  const held: NotDeliveredMessage[] = [];
  for (const row of rows) {
    const target = targets.get(row.threadId);
    const thread = live.get(row.threadId);
    // No positive native fact, no claim: a missing or archived thread is settled elsewhere.
    if (!target || !thread || thread.archived) continue;
    if (!row.failureReason) {
      if (RUNNING.has(thread.status)) continue;
      if (row.waitingOn && !TURN_END_WAITS.has(row.waitingOn.kind)) continue;
      if (now - row.updatedAt < HELD_AFTER_MS) continue;
    }
    held.push({
      id: row.id,
      threadId: row.threadId,
      target,
      preview: preview(row),
      queuedAt: row.createdAt,
      reason: heldReason(row, target, thread.status),
    });
  }
  return held.sort((a, b) => a.queuedAt - b.queuedAt || (a.id < b.id ? -1 : 1));
}
