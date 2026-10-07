import { z } from "zod";
import type { AssignmentRecord, Store } from "./store";
import { ProjectError } from "./bb";
import { workerWork } from "./messaging";
import { reportVersion } from "./write-holds";
import { renderStandardHandoff } from "./handoffs";

export const READ_FIELDS = ["brief", "briefText", "report", "report.handoff", "report.evidence", "standardHandoff", "handoff", "body", "payload", "answer", "resolution", "checkpoint", "reviewTargets", "reportNotice"] as const;
export const readOptionsSchema = z.object({
  refs: z.array(z.string().min(1).max(80)).min(1).max(30).optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(30).default(20),
  detailed: z.boolean().default(false),
  fields: z.array(z.enum(READ_FIELDS)).min(1).max(10).optional(),
}).strict();
export const READ_VIEWS = ["tasks", "workers", "assignments", "reports", "decisions", "inbox", "updates", "activity", "usage", "threads"] as const;
export type ReadView = (typeof READ_VIEWS)[number];
export type ReadOptions = z.infer<typeof readOptionsSchema>;
export const agentReadSchema = readOptionsSchema.extend({ view: z.enum(["overview", "records", "context", ...READ_VIEWS]).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(30).optional(), detailed: z.boolean().optional() }).strict();
export const MAX_READ_BYTES = 65536;
const refViews: Record<string, ReadView> = { T: "tasks", W: "workers", A: "assignments", D: "decisions", K: "decisions", U: "updates" };
export const fieldsByView: Partial<Record<ReadView, readonly string[]>> = {
  tasks: ["brief"], workers: ["handoff", "report"], assignments: ["briefText", "report", "report.handoff", "report.evidence", "standardHandoff", "checkpoint", "reviewTargets", "reportNotice"],
  reports: ["briefText", "report", "report.handoff", "report.evidence", "standardHandoff", "reportNotice"],
  decisions: ["answer", "resolution", "body"], updates: ["body"], inbox: ["payload"], activity: ["payload"],
};
const canonical = (ref: string) => ref.replace(/^K(?=\d+$)/, "D");
export function viewForRef(ref: string): ReadView {
  const match = /^([TWADKU])\d+$/.exec(ref);
  if (!match) throw new ProjectError(`Unknown durable ref ${ref}. Use T/W/A/D/U refs, or an explicit view for native thread IDs and numeric activity/inbox IDs.`);
  return refViews[match[1]]!;
}

const rowRef = (view: ReadView, row: Record<string, any>) => String(view === "activity" || view === "inbox" ? row.id : row.ref ?? row.threadId ?? row.id);
function fullRow(view: ReadView, row: Record<string, any>) {
  // Activity stores an object named ref; public reads expose its numeric ID
  // as ref and the event association as payload, like the other event view.
  if (view === "activity") return { ...row, ref: rowRef(view, row), payload: row.ref };
  if (view !== "decisions") return row;
  const body = row.body;
  return { ref: row.ref, description: row.description, madeBy: row.madeBy, review: row.review, reviewMessage: row.reviewMessage, notification: row.notification,
    recordedBy: body.answer?.recordedBy ?? row.provenance, supersedes: row.supersedes, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt,
    question: body.question ?? null, answer: body.answer ?? null, resolution: body.resolution ?? null, body };
}
function summary(view: ReadView, row: Record<string, any>) {
  const common = { ref: rowRef(view, row), ...(row.state ? { state: row.state } : {}), ...(row.status ? { status: row.status } : {}) };
  const trimmed: string[] = [];
  const text = (key: string, value: unknown, length = 400) => {
    if (typeof value !== "string") return value ?? null;
    if (value.length > length) trimmed.push(key);
    return value.slice(0, length);
  };
  const refs = (key: string, values: number[] | null | undefined) => {
    if (!values) return null;
    if (values.length > 20) trimmed.push(key);
    return values.slice(0, 20).map(n => `T${n}`);
  };
  let item: Record<string, unknown>;
  switch (view) {
    case "tasks": item = { ...common, title: text("title", row.title, 200), summary: text("summary", row.summary), progress: text("progress", row.progress, 240), priority: row.priority, dependsOn: refs("dependsOn", row.dependsOn), acceptedAssignment: row.acceptedAssignment ? `A${row.acceptedAssignment}` : null }; break;
    case "workers": item = { ...common, label: text("label", row.label, 200), area: text("area", row.area, 200), role: row.role, threadId: row.threadId, generation: row.generation, bbProjectId: row.bbProjectId, userStopped: row.userStopped, assignments: row.assignments, assignmentsTruncated: row.assignmentsTruncated, ...(row.latestReport !== undefined ? { latestReport: row.latestReport } : {}) }; break;
    case "assignments": item = { ...common, reportVersion: row.report ? reportVersion(row as AssignmentRecord) : null, worker: `W${row.workerNum}`, tasks: refs("tasks", row.taskNums), role: row.role, access: row.access, route: row.route, opState: row.opState, queuedMessageId: row.queuedMessageId, profile: row.actualProfile ?? row.profile, reviewOf: refs("reviewOf", row.reviewOf), report: row.report ? { outcome: row.report.outcome, summary: text("report.summary", row.report.summary) } : null, notification: row.reportNotice ? { ...row.reportNotice, ...(row.reportNotice.detail ? { detail: text("notification.detail", row.reportNotice.detail, 240) } : {}) } : null, verificationRevision: text("verificationRevision", row.report?.handoff.verificationRevision ?? row.report?.handoff.workspaceRevision, 200), checkpoint: row.checkpoint ? { recordedBy: row.checkpoint.recordedBy } : null, ...(row.handoffSources?.length ? { handoffSources: row.handoffSources.map((h: { assignment: string }) => h.assignment) } : {}) }; break;
    case "reports": item = { ...common, worker: `W${row.workerNum}`, tasks: refs("tasks", row.taskNums), role: row.role, outcome: row.report?.outcome === "succeeded" ? "done" : row.report?.outcome ?? null, summary: text("summary", row.report?.summary), reportedAt: row.reportedAt, finalMessage: text("finalMessage", row.report?.finalMessage ?? null, 600) }; break;
    case "decisions": item = { ...common, description: text("description", row.description), madeBy: row.madeBy, review: row.review, recordedBy: row.body.answer?.recordedBy ?? row.provenance, supersedes: row.supersedes, notification: row.notification ? { ...row.notification, ...(row.notification.detail ? { detail: text("notification.detail", row.notification.detail, 240) } : {}) } : null }; break;
    case "updates": item = { ...common, summary: text("summary", row.summary), createdAt: row.createdAt }; break;
    case "inbox": case "activity": item = { ...common, kind: row.kind, summary: text("summary", row.summary), createdAt: row.createdAt ?? row.at }; break;
    case "usage": item = { ...common, worker: `W${row.workerNum}`, lastObservedAt: row.lastObservedAt, profileObservation: row.profileObservation }; break;
    case "threads": item = { ...common, label: text("label", row.label, 200), nativeStatus: row.nativeStatus, parentThreadId: row.parentThreadId, parentKnown: row.parentKnown, ownership: row.ownership, retained: row.retained }; break;
  }
  return { ...item, ...(trimmed.length ? { truncatedFields: trimmed } : {}) };
}
const rowsFor = (store: Store, projectId: string, view: ReadView): Record<string, any>[] => {
  if (view === "threads") throw new ProjectError("Native threads must be read through initiative_read view threads.");
  if (view === "workers") return store.workers(projectId);
  if (view === "usage") return store.projectUsage(projectId) as unknown as Record<string, any>[];
  if (view === "inbox" || view === "activity") return store[view](projectId, -1) as unknown as Record<string, any>[];
  if (view === "reports") return store.assignments(projectId).filter(a => a.report).sort((a, b) => (b.reportedAt ?? 0) - (a.reportedAt ?? 0)) as unknown as Record<string, any>[];
  return (view === "decisions" ? store.decisions(projectId, { includeHistory: true }) : store[view](projectId)) as unknown as Record<string, any>[];
};
export function validateSelection(view: ReadView, options: ReadOptions) {
  for (const ref of options.refs ?? []) {
    if ((["tasks", "workers", "assignments", "decisions", "updates"].includes(view) || /^[TWADKU]\d+$/.test(ref)) && viewForRef(ref) !== view)
      throw new ProjectError(`${ref} belongs to ${viewForRef(ref)}, not ${view}. Omit view to read mixed durable refs.`);
  }
  if (options.fields && !options.detailed) throw new ProjectError("fields selects full fields: pass detailed:true with fields.");
  const invalid = options.fields?.find(f => !fieldsByView[view]?.includes(f));
  if (invalid) throw new ProjectError(`${invalid} is not selectable in ${view}. Valid fields: ${(fieldsByView[view] ?? []).join(", ") || "none; omit fields"}.`);
}
function projectRow(view: ReadView, row: Record<string, any>, options: ReadOptions) {
  if (!options.detailed) return summary(view, row);
  const full = fullRow(view, row);
  if (!options.fields) return full;
  return { ref: rowRef(view, row), view, ...Object.fromEntries(options.fields.map(f => [f, f.split(".").reduce<any>((value, key) => value?.[key], full) ?? null])) };
}

/** Page complete records, never slice serialized JSON. Oversized individual details need explicit field selection. */
export function readRows(rows: { view: ReadView; row: Record<string, any> }[], options: ReadOptions, missingRefs: string[] = [], enrich: (view: ReadView, row: Record<string, any>) => Record<string, any> = (_view, row) => row) {
  if (options.refs) {
    const byRef = new Map(rows.map(entry => [rowRef(entry.view, entry.row), entry]));
    missingRefs = [...new Set([...missingRefs, ...options.refs.filter(ref => !byRef.has(canonical(ref)))])];
    rows = [...new Set(options.refs.map(canonical))].flatMap(ref => byRef.has(ref) ? [byRef.get(ref)!] : []);
  }
  const items: Record<string, any>[] = [];
  let byteLimited = false;
  for (const { view, row } of rows.slice(options.offset, options.offset + options.limit)) {
    const item = projectRow(view, enrich(view, row), options);
    if (Buffer.byteLength(JSON.stringify({ items: [...items, item], missingRefs })) > MAX_READ_BYTES - 1000) {
      if (!items.length) throw new ProjectError(`${rowRef(view, row)} exceeds the ${MAX_READ_BYTES}-byte read budget. Select fewer/smaller fields with detailed:true, fields:[${(fieldsByView[view] ?? []).map(f => JSON.stringify(f)).join(",")}], and one ref. If a single field is too large, read its linked artifact instead.`);
      byteLimited = true; break;
    }
    items.push(item);
  }
  const nextOffset = options.offset + items.length < rows.length ? options.offset + items.length : null;
  return { items, total: rows.length, missingRefs, offset: options.offset, limit: options.limit, nextOffset, truncated: nextOffset !== null || items.some(i => i.truncatedFields?.length), byteLimited, detail: options.detailed ? "Full selected records/fields; no JSON clipping." : "Summaries only. Use detailed:true and optionally fields for full records." };
}

// The standard handoff is rendered from the canonical report on request, never stored twice.
const selectedWorker = (store: Store, projectId: string, options: ReadOptions) => (view: ReadView, row: Record<string, any>) =>
  view === "workers" && !options.fields ? { ...row, ...workerWork(store, projectId, row.num, row.generation), latestReport: latestReportOf(store, projectId, row.num, options.detailed) }
  : view === "workers" && options.fields?.includes("report") ? { ...row, report: latestReportOf(store, projectId, row.num, true) }
  : (view === "assignments" || view === "reports") && options.fields?.includes("standardHandoff") ? { ...row, standardHandoff: row.report ? renderStandardHandoff(store, row as AssignmentRecord, false) : null }
  : row;

/** T136: a worker read carries its latest report, the final message in full only when detailed. */
function latestReportOf(store: Store, projectId: string, workerNum: number, detailed: boolean) {
  const a = store.latestReported(projectId, workerNum);
  if (!a?.report) return null;
  const final = a.report.finalMessage ?? null;
  return { ref: a.ref, outcome: a.report.outcome === "succeeded" ? "done" : a.report.outcome, summary: a.report.summary, reportedAt: a.reportedAt,
    finalMessage: final && !detailed && final.length > 1500 ? `${final.slice(0, 1500)}… (detailed:true for the full text)` : final };
}

/** T136: the shared, user-editable context, read on demand; it is never injected into prompts. */
export function readContext(store: Store, projectId: string) {
  const p = store.project(projectId);
  if (!p) throw new ProjectError("Unknown Initiative.");
  return { name: p.name, objective: p.objective, vision: p.context.vision, objectives: p.context.objectives, ideas: p.context.ideas };
}

export function readCollection(store: Store, projectId: string, view: ReadView, options: ReadOptions) {
  validateSelection(view, options);
  const rows = rowsFor(store, projectId, view);
  const byRef = new Map(rows.map(row => [rowRef(view, row), row]));
  const selected = options.refs ? [...new Set(options.refs.map(canonical))].flatMap(ref => byRef.has(ref) ? [byRef.get(ref)!] : []) : rows;
  return readRows(selected.map(row => ({ view, row })), options, options.refs?.filter(ref => !byRef.has(canonical(ref))) ?? [], selectedWorker(store, projectId, options));
}
export function readRefs(store: Store, projectId: string, options: ReadOptions) {
  if (!options.refs) throw new ProjectError("view records requires refs, for example refs:[\"A7\",\"T3\",\"D12\"].");
  const caches = new Map<ReadView, Map<string, Record<string, any>>>();
  const rows = [...new Set(options.refs.map(canonical))].flatMap(ref => {
    const view = viewForRef(ref);
    validateSelection(view, { ...options, refs: [ref] });
    if (!caches.has(view)) caches.set(view, new Map(rowsFor(store, projectId, view).map(r => [String(r.ref), r])));
    const row = caches.get(view)!.get(ref);
    if (!row) return [];
    return [{ view, row }];
  });
  return readRows(rows, options, [], selectedWorker(store, projectId, options));
}

/** Agent overview (T136): live workers with their latest report, open tasks, and what waits on the user. No native calls. */
export function compactOverview(store: Store, projectId: string) {
  const p = store.project(projectId);
  if (!p) throw new ProjectError("Unknown Initiative.");
  const tasks = store.tasks(projectId), assignments = store.assignments(projectId), decisions = store.decisions(projectId);
  const open = tasks.filter(t => !["done", "cancelled"].includes(t.status));
  const workers = store.workers(projectId).filter(w => w.state !== "retired");
  const questions = decisions.filter(d => d.status === "active" && d.humanAttention === "needs-opinion" && d.madeBy === null);
  const unchecked = decisions.filter(d => d.madeBy === "agent" && d.review === "pending");
  const limit = 12;
  const working = (num: number) => assignments.find(a => a.workerNum === num && (["dispatching", "queued", "running", "idle_no_report"].includes(a.state) || ["pending", "uncertain"].includes(a.opState)));
  return {
    project: { id: p.id, name: p.name, objective: p.objective.slice(0, 1200), paused: p.paused, coordinatorThreadId: p.coordinatorThreadId },
    counts: { openTasks: open.length, liveWorkers: workers.length, questions: questions.length, uncheckedAgentDecisions: unchecked.length },
    workers: workers.slice(-limit).map(w => {
      const now = working(w.num);
      const last = latestReportOf(store, projectId, w.num, false);
      return { ref: w.ref, label: w.label, purpose: w.area, role: w.role, working: now ? { ref: now.ref, state: now.state, tasks: now.taskNums.map(n => `T${n}`) } : null,
        latestReport: last ? { ref: last.ref, outcome: last.outcome, summary: last.summary } : null };
    }),
    tasks: open.slice(0, limit).map(row => summary("tasks", row)),
    humanAttention: { questions: questions.slice(0, limit).map(row => ({ ...summary("decisions", row), question: (row.body as { question?: string }).question?.slice(0, 400), ...(((row.body as { question?: string }).question?.length ?? 0) > 400 ? { questionTruncated: true } : {}) })), uncheckedAgentDecisions: unchecked.slice(-limit).map(row => row.ref) },
    truncated: workers.length > limit || open.length > limit || questions.length > limit || unchecked.length > limit,
    reads: 'refs:["W12","T40"] for exact records; view workers, tasks, reports, context or activity to list.',
  };
}
