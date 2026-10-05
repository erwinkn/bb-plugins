import { ProjectError } from "./bb";
import { reportVersion } from "./write-holds";
import { assignmentRef, parseRef, taskRef, workerRef, type AssignmentRecord, type HandoffSource, type Store, type TaskRecord } from "./store";

/**
 * T96: the standard handoff is a view of an assignment's canonical stored report, never a
 * second copy of it. Reports already carry outcome, evidence (checks, artifacts), revisions,
 * files, open questions, next steps, dirty files, pending commands and background work;
 * decisions come from their own provenance. A fresh delegation may embed selected handoffs,
 * and its assignment keeps only this provenance: which filing it received, at which state.
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
  const decisions = store.decisions(a.projectId, { includeHistory: true })
    .filter(d => d.provenance.assignment === a.num && d.status !== "removed")
    .map(d => `${d.ref} (${d.madeBy ?? "question"}, ${d.status}): ${clip("decision text", d.description, 200)}`);
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
    items("Decisions recorded by this assignment", decisions, 5),
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

const refNums = (text: string, letter: "T" | "A") =>
  [...text.matchAll(new RegExp(`\\b${letter}(\\d+)\\b`, "g"))].map(m => Number(m[1]));

/**
 * The prior handoffs a new work assignment may receive. Each must be a stored report in
 * this Initiative whose tasks the new tasks name: as themselves, as dependencies, or in
 * their briefs' context refs (an A# context ref names the assignment directly).
 */
export function resolveHandoffs(store: Store, projectId: string, refs: readonly string[], tasks: readonly TaskRecord[]): AssignmentRecord[] {
  if (refs.length > MAX_HANDOFF_SOURCES)
    throw new ProjectError(`Select at most ${MAX_HANDOFF_SOURCES} prior handoffs; read the others with initiative_read and summarize them in the note.`);
  const related = new Set<number>();
  const namedAssignments = new Set<number>();
  for (const task of tasks) {
    related.add(task.num);
    task.dependsOn.forEach(n => related.add(n));
    for (const ref of task.brief?.contextRefs ?? []) {
      refNums(ref, "T").forEach(n => related.add(n));
      refNums(ref, "A").forEach(n => namedAssignments.add(n));
    }
  }
  const seen = new Set<number>();
  return refs.flatMap(ref => {
    const num = parseRef("A", ref);
    const a = num === null ? null : store.assignment(projectId, num);
    if (!a) throw new ProjectError(`handoffs: ${ref} is not an assignment in this Initiative. Pass A# refs whose reports you read.`);
    if (seen.has(a.num)) return [];
    seen.add(a.num);
    if (!a.report) throw new ProjectError(`handoffs: ${a.ref} (${a.state}) has no stored report, so it has no handoff yet.`);
    const covered = [...a.taskNums, ...(a.reviewOf ?? [])];
    if (!namedAssignments.has(a.num) && !covered.some(n => related.has(n))) {
      const source = covered.map(taskRef).join(", ") || "no task";
      const target = tasks.map(t => t.ref).join(", ") || "this delegation";
      // contextRefs and the same task work whatever the source's state; dependsOn also gates
      // dispatch on the source task being done, so it is offered only once it is (A223).
      const done = covered.length > 0 && covered.every(n => store.task(projectId, n)?.status === "done");
      throw new ProjectError(
        `handoffs: ${a.ref} covers ${source}, which ${target} does not name. If the handoff belongs to this work, ` +
          `add ${covered[0] ? `"${taskRef(covered[0])}" or ` : ""}"${a.ref}" to the contextRefs of ${tasks.length ? `${target}'s brief (initiative_task task-update)` : "the delegated tasks' briefs"}` +
          `${covered.length && !done ? `, or delegate ${source} itself with this handoff` : ""}.` +
          (done ? ` ${source} is done, so adding it to dependsOn also works.` : ""),
      );
    }
    return [a];
  });
}
