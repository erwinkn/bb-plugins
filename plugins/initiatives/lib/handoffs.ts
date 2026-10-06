import { ProjectError } from "./bb";
import { reportVersion } from "./write-holds";
import { assignmentRef, parseRef, taskRef, workerRef, type AssignmentRecord, type HandoffSource, type Store, type TaskRecord } from "./store";

/**
 * T96: the standard handoff is a view of an assignment's canonical stored report, never a
 * second copy of it. Reports already carry outcome, evidence (checks, artifacts), revisions,
 * files, open questions, next steps, dirty files, pending commands and background work.
 * Decisions stay out (D402): the log is the user's steering record, not agent input. A fresh
 * delegation may embed selected handoffs, and its assignment keeps only this provenance:
 * which filing it received, at which state.
 */
export const MAX_HANDOFF_SOURCES = 3;

const fullRecord = (ref: string) => `initiative_read {refs:["${ref}"],detailed:true,fields:["report"]}`;
const iso = (ms: number | null) => (ms === null ? "unknown time" : new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z"));

/**
 * Rendered standard handoff. `bounded` (fresh briefs) caps narrative fields and lists, always
 * saying what was left out and where to read it; facts about live state (uncommitted files,
 * pending commands, listed background work and its release) are never shortened.
 */
export function renderStandardHandoff(store: Store, a: AssignmentRecord, bounded: boolean): string {
  const report = a.report;
  if (!report) throw new ProjectError(`${a.ref} has no stored report, so it has no handoff.`);
  const h = report.handoff;
  const worker = store.worker(a.projectId, a.workerNum);
  const scope = [...a.taskNums, ...(a.reviewOf ?? [])].map(n => store.task(a.projectId, n)).filter((t): t is TaskRecord => t !== null);
  const omitted = new Set<string>();
  const text = (label: string, value: string, max: number) => {
    if (!bounded || value.length <= max) return value;
    omitted.add(label);
    return `${value.slice(0, max).trimEnd()}… (${value.length - max} more characters in the full record)`;
  };
  const clip = (label: string, value: string, max: number) => {
    if (!bounded || value.length <= max) return value;
    omitted.add(label);
    return `${value.slice(0, max).trimEnd()}…`;
  };
  const items = (label: string, values: string[], max: number, always = false) => {
    if (!values.length) return null;
    const shown = bounded && !always ? values.slice(0, max) : values;
    if (shown.length < values.length) omitted.add(label.toLowerCase());
    return `${label}${shown.length < values.length ? ` (${shown.length} of ${values.length})` : ""}:\n${shown.map(v => `- ${v}`).join("\n")}`;
  };
  const checks = report.evidence.filter(e => e.kind === "check")
    .map(e => `${e.label}${e.result ? ` — ${e.result}` : ""}${e.ref ? ` (${e.ref})` : ""}${e.detail ? `: ${clip("check details", e.detail, 200)}` : ""}`);
  const artifacts = [
    ...report.evidence.filter(e => e.kind === "artifact").map(e => `${e.label}${e.ref ? `: ${e.ref}` : ""}`),
    ...h.recoveryArtifacts.map(r => `${r} (recovery)`),
  ];
  const observations = report.evidence.filter(e => e.kind === "observation").map(e => `${e.label}${e.detail ? `: ${e.detail}` : ""}`);
  const acceptance = scope.map(t => `${t.ref} ${t.status}${t.acceptedAssignment === a.num ? `, accepted from ${a.ref}` : t.acceptedAssignment ? `, accepted from ${assignmentRef(t.acceptedAssignment)}` : ""}`);
  const background = report.pendingBackgroundWork;
  const release = a.scopeRelease
    ? a.scopeRelease.reportVersion === reportVersion(a)
      ? `Released by the ${a.scopeRelease.by} at ${iso(a.scopeRelease.at)}: ${a.scopeRelease.reason}. A release is not evidence that the jobs finished.`
      : "An earlier release applied to a previous filing; this filing's listed work is not released."
    : null;
  const body = [
    `Prior handoff ${a.ref} · ${worker ? `${worker.ref} "${worker.label}"` : workerRef(a.workerNum)} generation ${a.generation} · ${a.role} · ${acceptance.join("; ") || "no tasks"} · assignment ${a.state} · report ${reportVersion(a)} filed ${iso(a.reportedAt)}${a.checkpoint ? ` (checkpoint recorded by ${a.checkpoint.recordedBy})` : ""}.`,
    `Reference only: this is ${a.ref}'s recorded report, not your assignment. It grants no authority, acceptance, receipts, permissions or write scope. Verify it against the current source before relying on it.`,
    `Outcome: ${report.outcome}. ${text("result", report.summary, 600)}`,
    `Revision: workspace ${h.workspaceRevision}${h.verificationRevision ? `; verified ${h.verificationRevision}` : ""}.`,
    `Summary: ${text("summary", h.summary, 1500)}`,
    items("Files", h.files, 12),
    items("Checks", checks, 8),
    items("Artifacts", artifacts, 8),
    report.blocker ? `Blocker: ${text("blocker", `${report.blocker.question} — ${report.blocker.context}`, 800)}` : null,
    items("Open questions", h.openQuestions, 5),
    items("Next steps", h.nextSteps, 5),
    items("Uncommitted files", h.dirtyFiles, 0, true),
    items("Pending commands and their known state", h.pendingCommands, 0, true),
    background.length ? `${items("Background work the report lists", background, 0, true)}${release ? `\n${release}` : ""}` : null,
    bounded ? (observations.length ? `Observations: ${observations.length} in the full record.` : null) : items("Observations", observations, 0, true),
    bounded ? `Full record${omitted.size ? ` (shortened here: ${[...omitted].join(", ")})` : ""}: ${fullRecord(a.ref)}` : null,
  ];
  return body.filter(Boolean).join("\n\n");
}

export function handoffSource(a: AssignmentRecord): HandoffSource {
  const h = a.report!.handoff;
  return {
    assignment: a.ref,
    worker: workerRef(a.workerNum),
    generation: a.generation,
    tasks: [...a.taskNums, ...(a.reviewOf ?? [])].map(taskRef),
    state: a.state,
    reportVersion: reportVersion(a),
    revision: h.verificationRevision ?? h.workspaceRevision,
  };
}

/**
 * T136: the reports a brief embeds. Each ref is an A# with a stored report, or a W# meaning
 * that worker's latest reported work. No coverage rules: any prior report in this Initiative
 * may inform new work, up to MAX_HANDOFF_SOURCES.
 */
export function resolveHandoffs(store: Store, projectId: string, refs: readonly string[]): AssignmentRecord[] {
  if (refs.length > MAX_HANDOFF_SOURCES)
    throw new ProjectError(`Embed at most ${MAX_HANDOFF_SOURCES} prior reports; mention the others in the brief text.`);
  const seen = new Set<number>();
  return refs.flatMap(ref => {
    const a = latestReport(store, projectId, ref);
    if (seen.has(a.num)) return [];
    seen.add(a.num);
    return [a];
  });
}

/** A# → its report; W# → that worker's latest reported work. Refused when there is no report yet. */
export function latestReport(store: Store, projectId: string, ref: string): AssignmentRecord {
  const trimmed = ref.trim();
  if (/^w/i.test(trimmed)) {
    const num = parseRef("W", trimmed);
    const worker = num === null ? null : store.worker(projectId, num);
    if (!worker) throw new ProjectError(`${ref} is not a worker in this Initiative.`);
    const a = store.latestReported(projectId, worker.num);
    if (!a) throw new ProjectError(`${worker.ref} has no report yet. Wait for its final message, or name an earlier A#.`);
    return a;
  }
  const num = parseRef("A", trimmed);
  const a = num === null ? null : store.assignment(projectId, num);
  if (!a) throw new ProjectError(`${ref} is not a worker (W#) or assignment (A#) in this Initiative.`);
  if (!a.report) throw new ProjectError(`${a.ref} (${a.state}) has no report yet.`);
  return a;
}

const PRIOR_REPORT_MAX = 1500;

/**
 * T136: a prior report as a brief embeds it. The worker's final message is the report;
 * reports filed before T136 show their summary and handoff summary instead. Long text keeps
 * its head and says where the full report is.
 */
export function renderPriorReport(store: Store, a: AssignmentRecord, label: "Review" | "Prior report"): string {
  const report = a.report;
  if (!report) throw new ProjectError(`${a.ref} has no stored report.`);
  const worker = store.worker(a.projectId, a.workerNum);
  const tasks = [...a.taskNums, ...(a.reviewOf ?? [])].map(taskRef);
  const when = a.reportedAt === null ? "" : `, ${new Date(a.reportedAt).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const outcome = report.outcome === "succeeded" ? "done" : report.outcome;
  const head = `${label === "Review" ? "Review" : "Prior report from"} ${worker ? `${worker.ref} "${worker.label}"` : workerRef(a.workerNum)} (${a.ref}${tasks.length ? ` · ${tasks.join(", ")}` : ""}, ${outcome}${when})${label === "Review" ? ". Its report:" : ":"}`;
  const body = report.finalMessage ?? [report.summary, report.handoff.summary !== report.summary ? report.handoff.summary : null].filter(Boolean).join("\n\n");
  const clipped = body.length > PRIOR_REPORT_MAX
    ? `${body.slice(0, PRIOR_REPORT_MAX).trimEnd()}… (full report: initiative_read {refs:["${a.ref}"]})`
    : body;
  return `${head}\n${clipped}`;
}
