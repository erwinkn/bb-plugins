import { createHash } from "node:crypto";
import { renderBrief } from "./brief";
import { renderStandardHandoff } from "./handoffs";
import { reportVersion } from "./write-holds";
import { StoreCorruptionError, parseRef, taskRef, workerRef, assignmentRef, type AssignmentRecord, type Store } from "./store";
import type { AssignmentState } from "./schema";

/**
 * T96: the read-only context other plugins (Account Pooler warming, Advisor) read over a
 * token-auth HTTP route. Everything comes from the plugin's own canonical records: no native
 * call, write, wake or model call. Contract: thread-storage w140-a222/context-contract.md.
 */
export const CONTEXT_VERSION = 1;
export const RECORD_PAGE_DEFAULT = 8000;
export const RECORD_PAGE_MAX = 16000;

export type AssignmentPhase = "pending" | "active" | "reported" | "accepted" | "rejected" | "cancelled" | "failed";
const PHASES: Record<AssignmentState, AssignmentPhase> = {
  dispatching: "pending", queued: "pending", running: "active", idle_no_report: "active",
  reported: "reported", accepted: "accepted", rejected: "rejected", stopped: "cancelled", cancelled: "cancelled", failed: "failed",
};

export interface ContextResponse { status: 200 | 400 | 404 | 500; body: Record<string, unknown> }
class ContextError extends Error {
  constructor(readonly status: 400 | 404, readonly code: string, message: string) { super(message); }
}

/** A brief that reached its thread: delivered with no receipt still held, or already reported on. */
const delivered = (a: AssignmentRecord) => a.report !== null || (a.briefDelivered && a.queuedMessageId === null);

function assignmentContext(a: AssignmentRecord) {
  return {
    ref: a.ref,
    tasks: [...a.taskNums, ...(a.reviewOf ?? [])].map(taskRef),
    role: a.role,
    access: a.access,
    route: a.route,
    phase: PHASES[a.state],
    state: a.state,
    cancelRequested: a.cancelRequested,
    outcome: a.report?.outcome ?? null,
    reportVersion: a.report ? reportVersion(a) : null,
    reportedAt: a.reportedAt,
    updatedAt: a.updatedAt,
    briefChars: a.briefText.length,
    handoff: a.report !== null,
  };
}

function membershipContext(store: Store, threadId: string) {
  const m = store.membership(threadId, true);
  if (!m) return null;
  const p = m.project;
  const base = {
    initiativeId: p.id,
    initiativeName: p.name,
    archived: p.archivedAt !== null,
    paused: p.paused,
    coordinator: { threadId: p.coordinatorThreadId, generation: p.coordinatorGeneration },
  };
  if (m.kind === "adhoc")
    return { ...base, kind: "adhoc", role: "adhoc", worker: null, generation: null, currentGeneration: null, state: "active",
      former: false, retired: false, stopped: false, parent: null, assignment: null, next: null };
  const own = store.generations(p.id, m.workerNum).find(g => g.threadId === threadId)?.generation ?? null;
  if (m.kind === "coordinator")
    return { ...base, kind: "coordinator", role: "coordinator", worker: null,
      generation: m.former ? own : p.coordinatorGeneration, currentGeneration: p.coordinatorGeneration,
      state: m.former ? "former" : "active", former: m.former, retired: false, stopped: false, parent: null, assignment: null, next: null };
  const w = m.worker!;
  const current = !m.former && w.threadId === threadId;
  const retired = w.state === "retired";
  const stopped = current && w.userStopped;
  // Canonical records, not the active-work list: reported and accepted work stays visible.
  const mine = store.workerAssignments(p.id, w.num).filter(a =>
    a.threadId === threadId || (current && a.threadId === null && a.generation === w.generation));
  const latest = mine.filter(delivered).at(-1) ?? null;
  const next = mine.filter(a => !delivered(a) && !a.cancelRequested && (latest === null || a.num > latest.num) &&
    ["dispatching", "queued", "running", "idle_no_report"].includes(a.state)).at(-1) ?? null;
  return {
    ...base,
    kind: "worker",
    role: w.role,
    worker: w.ref,
    generation: current ? w.generation : own,
    currentGeneration: w.generation,
    state: !current ? "former" : retired ? "retired" : stopped ? "stopped" : "active",
    former: !current,
    retired,
    stopped,
    parent: { forkedFrom: w.forkedFrom ? workerRef(w.forkedFrom) : null, nativeParent: w.nativeParent },
    assignment: latest ? assignmentContext(latest) : null,
    next: next ? assignmentContext(next) : null,
  };
}

function guard(run: (now: number) => Record<string, unknown>): ContextResponse {
  const now = Date.now();
  try {
    return { status: 200, body: { version: CONTEXT_VERSION, observedAt: now, ...run(now) } };
  } catch (error) {
    if (error instanceof ContextError)
      return { status: error.status, body: { version: CONTEXT_VERSION, observedAt: now, error: { code: error.code, message: error.message } } };
    if (error instanceof StoreCorruptionError)
      return { status: 500, body: { version: CONTEXT_VERSION, observedAt: now, error: { code: "store-unreadable", message: `A stored record failed validation; this context is unknown. ${error.message}` } } };
    throw error;
  }
}

const required = (query: URLSearchParams, key: string, pattern: RegExp, hint: string) => {
  const value = query.get(key);
  if (value === null || !pattern.test(value)) throw new ContextError(400, "bad-request", `${key} is ${value === null ? "missing" : "invalid"}: ${hint}.`);
  return value;
};
const integer = (query: URLSearchParams, key: string, fallback: number, min: number, max: number) => {
  const raw = query.get(key);
  if (raw === null) return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new ContextError(400, "bad-request", `${key} must be an integer from ${min} to ${max}.`);
  return value;
};

/** GET context/v1/thread?threadId= */
export function threadContext(store: Store, query: URLSearchParams): ContextResponse {
  return guard(() => {
    const threadId = required(query, "threadId", /^[\w-]{1,200}$/, "pass a BB thread id");
    return { threadId, membership: membershipContext(store, threadId) };
  });
}

/** GET context/v1/initiatives: the open Initiatives a reader can pick, most recently updated first. */
export function initiativesContext(store: Store, _query: URLSearchParams): ContextResponse {
  return guard(() => ({
    initiatives: store.projects().map(p => ({
      initiativeId: p.id,
      name: p.name,
      paused: p.paused,
      coordinator: { threadId: p.coordinatorThreadId, generation: p.coordinatorGeneration },
    })),
  }));
}

export const MEMBERS_PAGE_DEFAULT = 200;
export const MEMBERS_PAGE_MAX = 500;

/**
 * GET context/v1/members?initiativeId=&after=&limit=: every thread the thread route would
 * place in this Initiative, current and former, in the same terms (kind, role, W#, state).
 * Built from the same membership read, so the two routes never disagree about one thread.
 * Pages are ordered by thread id: pass `next` back as `after` until it is null. A thread
 * present for the whole walk is always on exactly one page.
 */
export function membersContext(store: Store, query: URLSearchParams): ContextResponse {
  return guard(() => {
    const initiativeId = required(query, "initiativeId", /^[\w-]{1,80}$/, "pass an Initiative id from context/v1/initiatives");
    const after = query.get("after");
    if (after !== null && !/^[\w-]{1,200}$/.test(after)) throw new ContextError(400, "bad-request", "after is invalid: pass the previous page's next.");
    const limit = integer(query, "limit", MEMBERS_PAGE_DEFAULT, 1, MEMBERS_PAGE_MAX);
    const p = store.project(initiativeId);
    if (!p) throw new ContextError(404, "not-found", `No Initiative ${initiativeId}.`);
    const ids = new Set<string>();
    if (p.coordinatorThreadId) ids.add(p.coordinatorThreadId);
    for (const g of store.generations(p.id, 0)) ids.add(g.threadId);
    for (const w of store.workers(p.id)) {
      if (w.threadId) ids.add(w.threadId);
      for (const g of store.generations(p.id, w.num)) ids.add(g.threadId);
    }
    for (const t of store.projectThreads(p.id)) if (t.threadId) ids.add(t.threadId);
    for (const t of store.nestedProjectThreads(p.id)) ids.add(t.threadId);
    const candidates = [...ids].sort().filter(id => after === null || id > after);
    const members = [];
    let next: string | null = null;
    for (const [i, threadId] of candidates.entries()) {
      if (members.length === limit) {
        next = candidates[i - 1]!;
        break;
      }
      const m = membershipContext(store, threadId);
      if (!m || m.initiativeId !== p.id) continue;
      members.push({ threadId, kind: m.kind, role: m.role, worker: m.worker, generation: m.generation, state: m.state, former: m.former, retired: m.retired, stopped: m.stopped });
    }
    return {
      initiativeId: p.id,
      name: p.name,
      archived: p.archivedAt !== null,
      paused: p.paused,
      coordinator: { threadId: p.coordinatorThreadId, generation: p.coordinatorGeneration },
      next,
      truncated: next !== null,
      members,
    };
  });
}

/** GET context/v1/record?initiativeId=&ref=&part=&offset=&limit= */
export function recordText(store: Store, query: URLSearchParams): ContextResponse {
  return guard(() => {
    const initiativeId = required(query, "initiativeId", /^[\w-]{1,80}$/, "pass the Initiative id from thread context");
    const ref = required(query, "ref", /^[AT][1-9]\d{0,8}$/, "pass an A# or T# ref");
    const part = required(query, "part", /^(brief|handoff)$/, "use brief or handoff");
    const offset = integer(query, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = integer(query, "limit", RECORD_PAGE_DEFAULT, 1, RECORD_PAGE_MAX);
    if (!store.project(initiativeId)) throw new ContextError(404, "not-found", `No Initiative ${initiativeId}.`);
    let record: { updatedAt: number; reportVersion: string | null; meta: Record<string, unknown>; text: string };
    if (ref.startsWith("T")) {
      if (part !== "brief") throw new ContextError(400, "bad-request", "part=handoff needs an A# ref; a task's handoffs are its assignments' reports.");
      const task = store.task(initiativeId, parseRef("T", ref)!);
      if (!task) throw new ContextError(404, "not-found", `${ref} is not a task in ${initiativeId}.`);
      record = {
        updatedAt: task.updatedAt,
        reportVersion: null,
        meta: { status: task.status, title: task.title, acceptedAssignment: task.acceptedAssignment ? assignmentRef(task.acceptedAssignment) : null },
        text: `${task.ref} "${task.title}"\n${task.brief ? renderBrief(task.brief) : task.summary}`,
      };
    } else {
      const a = store.assignment(initiativeId, parseRef("A", ref)!);
      if (!a) throw new ContextError(404, "not-found", `${ref} is not an assignment in ${initiativeId}.`);
      if (part === "handoff" && !a.report) throw new ContextError(404, "no-report", `${a.ref} (${a.state}) has no stored report, so it has no handoff.`);
      record = {
        updatedAt: a.updatedAt,
        reportVersion: part === "handoff" ? reportVersion(a) : null,
        meta: { phase: PHASES[a.state], state: a.state, tasks: [...a.taskNums, ...(a.reviewOf ?? [])].map(taskRef), worker: workerRef(a.workerNum), generation: a.generation },
        text: part === "handoff" ? renderStandardHandoff(store, a, false) : a.briefText,
      };
    }
    // Hash of the full rendered text, before paging: a handoff also renders task
    // status/acceptance and the worker label, which updatedAt/reportVersion do not cover.
    const textVersion = createHash("sha256").update(record.text).digest("hex").slice(0, 16);
    const totalChars = record.text.length;
    if (offset > totalChars) throw new ContextError(400, "bad-request", `offset ${offset} is past the end (${totalChars} characters).`);
    const end = Math.min(offset + limit, totalChars);
    return {
      initiativeId, ref, part,
      updatedAt: record.updatedAt,
      reportVersion: record.reportVersion,
      meta: record.meta,
      textVersion,
      totalChars, offset,
      nextOffset: end < totalChars ? end : null,
      text: record.text.slice(offset, end),
    };
  });
}
