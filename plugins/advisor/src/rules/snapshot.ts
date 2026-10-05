// Completion freshness (A144 §2, A152 §1, A160 F2).
//
// Every component comes from an explicit read outcome: ok(value) when the call
// succeeded, whatever the value; failed(why) when it did not. A root thread's
// parentThreadId:null, an unarchived thread's archivedAt:null and "not an
// Initiative member" are values, not failures. Reads are independent and
// non-atomic; results say so.

import { createHash } from "node:crypto";
import { type EventRow, isInterrupt } from "./events.js";
import { AUTHORITATIVE, PROGRESS_STATES, type BriefRef, type Requests } from "./requests.js";

export type Read<T> = { ok: true; value: T } | { ok: false; why: string };
export const ok = <T>(value: T): Read<T> => ({ ok: true, value });
export const failed = (why = "read-failed"): Read<never> => ({ ok: false, why });

type Comp<T> = { status: "ok"; value: T } | { status: "missing"; why: string };

/** Projects workers-view row (workerWork keeps only active assignment states). */
export interface WorkerRow {
  ref: string;
  role: string;
  generation: number;
  userStopped: boolean;
  assignments: Array<{ ref: string; state?: string; cancelled: boolean; tasks?: string[] }>;
  assignmentsTruncated?: boolean;
}

export interface Membership {
  coordinatorThreadId: string;
  worker: WorkerRow;
  former?: boolean;
  /** A later assignment queued but not delivered (contract v1 `next`): context, never a requirement. */
  queued?: string | null;
  /** Which Initiative, and the thread's place in it, for labels and feed filters only. */
  initiative?: { id: string; name: string; kind: string; role: string; worker: string | null; state: string };
}

/** A Projects readRefs result (lib/read.ts). */
export interface RefsResult<T> {
  items: T[];
  missingRefs: string[];
  [k: string]: unknown;
}

export interface AssignmentRecord {
  ref: string;
  state: string;
  workerNum: number;
  generation: number;
  cancelRequested: boolean;
  briefText: string;
  taskNums: number[];
  [k: string]: unknown;
}

export interface TaskBriefRecord {
  ref: string;
  brief: unknown;
  [k: string]: unknown;
}

export interface ThreadFacts {
  parentThreadId: string | null;
  archivedAt: number | null;
}

type ByRef<T> = Record<string, ({ read: "ok" } & T) | { read: "missing" | "unread" | "failed" }>;

interface AssignmentFacts {
  state: string;
  workerNum: number;
  generation: number;
  cancelRequested: boolean;
  brief: string;
  briefText: string;
  tasks: string[];
}

export interface Snapshot {
  thread: Comp<ThreadFacts>;
  epoch: Comp<number>;
  settingsRev: Comp<number>;
  membership: Comp<{ worker: string; role: string; generation: number; userStopped: boolean; former: boolean } | null>;
  coordinator?: Comp<string>;
  activeRow?: { refs: Record<string, boolean>; truncated: boolean };
  assignments?: ByRef<AssignmentFacts>;
  tasks?: ByRef<{ brief: string }>;
}

export function shortHash(v: unknown): string {
  return createHash("sha256").update(stableJson(v)).digest("hex").slice(0, 16);
}

export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(stableJson).join(",") + "]";
  if (v && typeof v === "object") {
    return (
      "{" +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + stableJson((v as Record<string, unknown>)[k]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(v ?? null);
}

function comp<T, U>(read: Read<T>, pick: (v: T) => U): Comp<U> {
  return read.ok ? { status: "ok", value: pick(read.value) } : { status: "missing", why: read.why };
}

/**
 * Per exact ref of a readRefs result: "ok" with the picked record, "missing"
 * when listed in missingRefs, "unread" when paging or the byte budget left it
 * out, "failed" when the call itself failed.
 */
function byRef<T, U>(read: Read<RefsResult<T & { ref: string }>> | null, refs: string[], pick: (i: T) => U): ByRef<U> {
  const out: ByRef<U> = {};
  if (read === null || !read.ok) {
    for (const ref of refs) out[ref] = { read: "failed" };
    return out;
  }
  const items = new Map(read.value.items.map((i) => [i.ref, i]));
  for (const ref of refs) {
    const item = items.get(ref);
    out[ref] = item
      ? { read: "ok", ...pick(item) }
      : read.value.missingRefs.includes(ref)
        ? { read: "missing" }
        : { read: "unread" };
  }
  return out;
}

export function snapshot(
  threadRead: Read<ThreadFacts>,
  settings: { epoch: number; settingsRev: number },
  projectsRead: Read<Membership | null>,
  assignmentRead: Read<RefsResult<AssignmentRecord>> | null = null,
  taskRead: Read<RefsResult<TaskBriefRecord>> | null = null,
  dispatchRefs: Iterable<string> = [],
): Snapshot {
  const snap: Snapshot = {
    thread: comp(threadRead, (t) => ({ parentThreadId: t.parentThreadId, archivedAt: t.archivedAt })),
    epoch: { status: "ok", value: settings.epoch },
    settingsRev: { status: "ok", value: settings.settingsRev },
    membership: comp(projectsRead, (p) =>
      p
        ? {
            worker: p.worker.ref,
            role: p.worker.role,
            generation: p.worker.generation,
            userStopped: p.worker.userStopped,
            former: p.former ?? false,
          }
        : null,
    ),
  };
  const p = projectsRead.ok ? projectsRead.value : null;
  if (p) {
    const row = p.worker;
    const active = Object.fromEntries(row.assignments.map((a) => [a.ref, a.cancelled]));
    snap.coordinator = { status: "ok", value: p.coordinatorThreadId };
    snap.activeRow = { refs: active, truncated: row.assignmentsTruncated ?? false };
    const refs = [...new Set([...dispatchRefs, ...Object.keys(active)])].sort();
    snap.assignments = byRef(assignmentRead, refs, (i: AssignmentRecord) => ({
      state: i.state,
      workerNum: i.workerNum,
      generation: i.generation,
      cancelRequested: i.cancelRequested,
      brief: shortHash(i.briefText),
      briefText: i.briefText,
      tasks: i.taskNums.map((n) => `T${n}`),
    }));
    const taskRefs = [
      ...new Set(Object.values(snap.assignments).flatMap((a) => (a.read === "ok" ? (a as AssignmentFacts).tasks : []))),
    ].sort();
    snap.tasks = byRef(taskRead, taskRefs, (i: TaskBriefRecord) => ({ brief: shortHash(i.brief) }));
  }
  return snap;
}

function both<T>(dispatch: Comp<T>, completion: Comp<T>, k: string, unknown: string[]): [T, T] | null {
  if (dispatch.status !== "ok" || completion.status !== "ok") {
    unknown.push(`${k}-missing`);
    return null;
  }
  return [dispatch.value, completion.value];
}

function readOf(e: { read: string } | undefined): string {
  return e?.read ?? "unread";
}

/**
 * Dispatch-time refs are re-read by exact ref. Leaving the active row is not a
 * signal: workerWork drops reported and accepted assignments by design.
 */
function compareAssignments(d: Snapshot, c: Snapshot, stale: string[], unknown: string[], notes: string[]): void {
  const drow = d.activeRow!;
  const crow = c.activeRow!;
  if (drow.truncated || crow.truncated) unknown.push("assignments-truncated");
  for (const ref of Object.keys(crow.refs).filter((r) => !(r in drow.refs)).sort()) stale.push(`${ref}-new-assignment`);
  for (const ref of Object.keys(drow.refs).sort()) {
    const de = d.assignments?.[ref];
    const ce = c.assignments?.[ref];
    if (readOf(de) !== "ok" || readOf(ce) !== "ok") {
      unknown.push(`${ref}-${readOf(ce) !== "ok" ? readOf(ce) : readOf(de)}`); // never implicit cancellation
      continue;
    }
    const dv = de as unknown as AssignmentFacts;
    const cv = ce as unknown as AssignmentFacts;
    if (cv.workerNum !== dv.workerNum || cv.generation !== dv.generation) stale.push(`${ref}-owner-changed`);
    if ((cv.cancelRequested || crow.refs[ref]) && !(dv.cancelRequested || drow.refs[ref])) stale.push(`${ref}-cancel-requested`);
    if (cv.brief !== dv.brief || JSON.stringify(cv.tasks) !== JSON.stringify(dv.tasks)) stale.push("briefs-changed");
    if (cv.state !== dv.state) {
      if (PROGRESS_STATES.has(cv.state)) notes.push(`${ref}-${dv.state}->${cv.state}`);
      else stale.push(`${ref}-${cv.state}`);
    }
  }
  const taskRefs = [...new Set([...Object.keys(d.tasks ?? {}), ...Object.keys(c.tasks ?? {})])].sort();
  for (const ref of taskRefs) {
    const de = d.tasks?.[ref];
    const ce = c.tasks?.[ref];
    if (readOf(de) !== "ok" || readOf(ce) !== "ok") {
      unknown.push(`${ref}-brief-${readOf(ce) !== "ok" ? readOf(ce) : readOf(de)}`);
    } else if ((de as { brief: string }).brief !== (ce as { brief: string }).brief) {
      stale.push("briefs-changed");
    }
  }
}

export type Completion =
  | { state: "stale"; reasons: string[]; alsoUnknown: string[]; notes: string[]; reads: string }
  | { state: "unknown"; reasons: string[]; notes: string[]; reads: string }
  | { state: "current-as-of-tip"; notes: string[]; reads: string };

export const READS_LABEL = "independent, non-atomic";

/** The current briefs, from a snapshot's exact-ref assignment reads. */
export function briefsOf(s: Snapshot): Record<string, BriefRef> {
  const out: Record<string, BriefRef> = {};
  for (const [ref, a] of Object.entries(s.assignments ?? {})) {
    if (a.read === "ok") out[ref] = { text: (a as AssignmentFacts).briefText, state: (a as AssignmentFacts).state };
  }
  return out;
}

/**
 * Stale outranks unknown outranks current. Authority uses the completion
 * snapshot's parent and coordinator.
 */
export function classifyCompletion(
  dispatch: Snapshot,
  completion: Snapshot,
  rowsAfterTip: EventRow[],
  drained: boolean,
  req: Requests,
  nowMin = 0,
): Completion {
  const stale: string[] = [];
  const unknown: string[] = [];
  const notes: string[] = [];
  const th = completion.thread;
  const mem = completion.membership;
  const parent = th.status === "ok" ? th.value.parentThreadId : req.parent;
  const coord = completion.coordinator ? (completion.coordinator.status === "ok" ? completion.coordinator.value : null) : mem.status === "ok" ? null : req.coordinator;
  req.drainBatch(
    {
      parent,
      coordinator: coord,
      member: completion.coordinator !== undefined || (mem.status !== "ok" && req.member),
      briefs: briefsOf(completion),
    },
    rowsAfterTip,
    drained,
    nowMin,
  );
  if (rowsAfterTip.some(isInterrupt)) stale.push("stopped");
  const tip = rowsAfterTip.length > 0 ? Math.min(...rowsAfterTip.map((r) => r.seq)) : null;
  if (tip !== null) {
    for (const [rid, r] of req.rows) {
      if (!AUTHORITATIVE.has(req.authorityNow(r))) continue;
      const after = r.seq >= tip || (r.settledSeq !== null && r.settledSeq >= tip);
      if (after && r.state === "accepted") stale.push(`new-accepted-instruction:${rid}`);
      else if (after && r.state === "requested") unknown.push(`instruction-pending:${rid}`);
    }
  }
  if (!drained) unknown.push("drain-behind");
  const t = both(dispatch.thread, completion.thread, "thread", unknown);
  if (t) {
    if (t[0].parentThreadId !== t[1].parentThreadId) stale.push("parent-changed");
    if (t[0].archivedAt !== t[1].archivedAt) stale.push("archived-changed");
  }
  for (const k of ["epoch", "settingsRev"] as const) {
    const x = both(dispatch[k], completion[k], k, unknown);
    if (x && x[0] !== x[1]) stale.push(`${k}-changed`);
  }
  const m = both(dispatch.membership, completion.membership, "membership", unknown);
  if (m) {
    const [dv, cv] = m;
    if (dv === null && cv !== null) stale.push("membership-joined"); // the dispatch packet had no Initiative context
    else if (dv !== null && cv === null) stale.push("membership-left");
    else if (dv !== null && cv !== null) {
      if (cv.former || cv.generation !== dv.generation || cv.worker !== dv.worker) stale.push("membership-changed");
      if (cv.userStopped && !dv.userStopped) stale.push("user-stopped");
      const dc = dispatch.coordinator?.status === "ok" ? dispatch.coordinator.value : null;
      const cc = completion.coordinator?.status === "ok" ? completion.coordinator.value : null;
      if (dc !== cc) stale.push("coordinator-changed");
      compareAssignments(dispatch, completion, stale, unknown, notes);
    }
  }
  const staleU = [...new Set(stale)];
  if (staleU.length > 0) return { state: "stale", reasons: staleU, alsoUnknown: unknown, notes, reads: READS_LABEL };
  if (unknown.length > 0) return { state: "unknown", reasons: unknown, notes, reads: READS_LABEL };
  return { state: "current-as-of-tip", notes, reads: READS_LABEL };
}
