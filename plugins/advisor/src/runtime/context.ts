// One context read for a watch: the thread (parent, archived, fork origin) and
// the optional Initiative membership, assignments and task briefs. Each is an
// explicit read outcome; reads are independent and non-atomic.

import { failed, ok, snapshot, type Membership, type Read, type Snapshot, type ThreadFacts } from "../rules/snapshot.js";
import type { ForkOrigin } from "../rules/requests.js";
import type { AdvisorHost, ThreadDto } from "./host.js";
import { readSignal } from "./host.js";
import type { InitiativeSource } from "./initiatives.js";

export interface WatchContext {
  thread: ThreadDto | null;
  threadRead: Read<ThreadFacts>;
  /** The thread read answered BB's own 404: the thread is deleted. Any other failure is unknown, not deleted. */
  deleted: boolean;
  snapshot: Snapshot;
  fork: ForkOrigin;
  parent: string | null;
  coordinator: string | null;
  member: boolean;
  /** The thread's own Initiative membership (labels and filters only); undefined when the read failed. */
  initiative?: Membership["initiative"] | null;
  /** Requirement coverage gaps caused by context that could not be read. */
  gaps: string[];
  notes: string[];
}

export interface ReadOptions {
  /** Per-read deadline (default 10 s); every read is also cut by the caller's signal. */
  deadlineMs?: number;
  /** Fork facts from an earlier successful thread read: a fork's origin never changes. */
  cachedThread?: { sourceThreadId: string | null; createdAt: number | null } | null;
}

export async function readContext(
  host: AdvisorHost,
  initiatives: InitiativeSource,
  threadId: string,
  settings: { epoch: number; settingsRev: number },
  dispatchRefs: Iterable<string>,
  signal: AbortSignal,
  opts: ReadOptions = {},
): Promise<WatchContext> {
  const rs = () => readSignal(signal, opts.deadlineMs);
  let thread: ThreadDto | null = null;
  let threadRead: Read<ThreadFacts>;
  let deleted = false;
  try {
    thread = await host.getThread(threadId, rs());
    threadRead = ok({ parentThreadId: thread.parentThreadId ?? null, archivedAt: thread.archivedAt ?? null });
  } catch (err) {
    deleted = isNotFound(err);
    threadRead = failed(`threads.get failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const gaps: string[] = [];
  const notes: string[] = [];
  const membership = await initiatives.membership(threadId, rs()).catch((e) => failed(String(e)));
  let assignments = null;
  let tasks = null;
  if (membership.ok && membership.value) {
    const active = membership.value.worker.assignments.map((a) => a.ref);
    const refs = [...new Set([...dispatchRefs, ...active])].sort();
    assignments = await initiatives.assignments(threadId, refs, rs()).catch((e) => failed(String(e)));
    const taskRefs = assignments.ok ? [...new Set(assignments.value.items.flatMap((a) => a.taskNums.map((n) => `T${n}`)))].sort() : [];
    tasks = await initiatives.tasks(threadId, taskRefs, rs()).catch((e) => failed(String(e)));
    if (membership.value.queued) notes.push(`next assignment ${membership.value.queued} queued (not delivered yet; not a requirement)`);
  }
  if (!initiatives.available) {
    notes.push(initiatives.label);
    if (thread?.originPluginId === "projects") gaps.push("initiative-context-unavailable");
  }
  const snap = snapshot(threadRead, settings, membership, assignments, tasks, dispatchRefs);
  // Labels may use cached fork facts after a failed read; the failed read still gates dispatch (dispatchGate).
  const facts = thread ?? opts.cachedThread ?? null;
  let fork: ForkOrigin = null;
  if (!facts) fork = "unknown";
  else if (facts.sourceThreadId) {
    fork = typeof facts.createdAt === "number" ? { sourceThreadId: facts.sourceThreadId, createdAt: facts.createdAt } : "unknown";
  }
  const member = membership.ok ? membership.value !== null : false;
  return {
    thread,
    threadRead,
    deleted,
    snapshot: snap,
    fork,
    parent: threadRead.ok ? threadRead.value.parentThreadId : null,
    coordinator: membership.ok && membership.value ? membership.value.coordinatorThreadId : null,
    member,
    ...(membership.ok ? { initiative: membership.value?.initiative ?? null } : {}),
    gaps,
    notes,
  };
}

/**
 * The snapshot components a completion could never compare: any of them makes
 * the result unknown forever, so a dispatch with them sends nothing.
 */
export function snapshotGaps(s: Snapshot): string[] {
  const out: string[] = [];
  if (s.thread.status !== "ok") out.push("thread-missing");
  if (s.membership.status !== "ok") out.push("membership-missing");
  if (s.coordinator && s.coordinator.status !== "ok") out.push("coordinator-missing");
  if (s.activeRow?.truncated) out.push("assignments-truncated");
  for (const [ref, a] of Object.entries(s.assignments ?? {})) if (a.read !== "ok") out.push(`${ref}-${a.read}`);
  for (const [ref, t] of Object.entries(s.tasks ?? {})) if (t.read !== "ok") out.push(`${ref}-brief-${t.read}`);
  return out;
}

/**
 * Why this context forbids a review request, or null. A former member (a
 * replaced coordinator, a superseded generation) can never be current, and a
 * failed or incomplete read can never be compared at completion: either way a
 * request would be paid for and discarded. Observation goes on.
 */
export function dispatchGate(ctx: WatchContext): string | null {
  const m = ctx.snapshot.membership;
  if (m.status === "ok" && m.value?.former) {
    return "former Initiative member (a replaced coordinator or a superseded worker generation): a review could never be current, so none is sent; evidence is still recorded";
  }
  if (m.status === "ok" && m.value?.userStopped) return "the user stopped this worker (Projects): no review is sent";
  const gaps = snapshotGaps(ctx.snapshot);
  return gaps.length > 0 ? `context read failed or incomplete (${gaps.join(", ")}): no request until a later pass reads it` : null;
}

/** BB's own "not found" for a read: the thread is gone. Network errors, 5xx and timeouts are not. */
export const isNotFound = (err: unknown): boolean => (err as { status?: number } | null)?.status === 404;
