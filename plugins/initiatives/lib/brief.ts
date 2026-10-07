import type { Brief, Profile } from "./schema";
import { describeProfile } from "./policy";
import type { ProjectRecord, TaskRecord } from "./store";
import { PLUGIN_ID } from "./identity";

// Per-assignment text sent as an ordinary message (T136): the task, its context and the
// report instruction. Standing rules live in the worker instructions and skill, sent once
// per session, never repeated here.

/** Marks a message as plugin-sent so the dispatch hook can tell it from a user's. */
export const opMarker = (opId: string) => `[${PLUGIN_ID}:${opId}]`;
export const OP_MARKER_PATTERN = new RegExp(`\\[${PLUGIN_ID}:(op_[a-z0-9]+)\\]`, "u");

const list = (items: string[]) => items.map((item) => `- ${item}`).join("\n");

/** A structured brief recorded before T136; new tasks carry plain text instead. */
export function renderBrief(brief: Brief): string {
  return [
    `Objective: ${brief.objective}`,
    `Acceptance criteria:\n${list(brief.acceptanceCriteria)}`,
    `Areas:\n${list(brief.areas.map((area) => `${area.bbProjectId}${area.paths.length ? `: ${area.paths.join(", ")}` : " (whole project)"}`))}`,
    brief.constraints.length
      ? `Constraints:\n${list(brief.constraints)}`
      : null,
    brief.contextRefs.length ? `Context:\n${list(brief.contextRefs)}` : null,
    `Verification:\n${list(brief.verification)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** A task as a brief shows it: title, then its structured brief or its text. */
export const renderTask = (task: TaskRecord) =>
  `${task.ref} ${task.title}${task.brief ? `\n${renderBrief(task.brief)}` : task.summary && task.summary !== task.title ? `\n${task.summary}` : ""}`;

export function renderAssignment(input: {
  assignmentRef: string;
  workerRef: string;
  workerLabel: string;
  workerPurpose: string;
  role: "work" | "review";
  /** Declared by older sessions' initiative_delegate; reviews are always read-only. */
  access?: "read-only" | "write";
  profile?: Profile;
  permissionMode?: "accept-edits" | "auto" | "full";
  tasks: TaskRecord[];
  reviewOf: TaskRecord[];
  /** The reviewed report, rendered (reviews only). */
  reviewed: string | null;
  /** Prior reports the coordinator chose to embed. */
  priorReports: string[];
  /** The coordinator's own brief text. */
  text: string | null;
  opId: string;
}): string {
  const scope = (input.role === "review" ? input.reviewOf : input.tasks).map((task) => task.ref);
  return [
    `${input.workerRef} "${input.workerLabel}" (${input.workerPurpose}) · ${input.role}${scope.length ? ` · ${scope.join(", ")}` : ""}`,
    ...(input.role === "review" ? [] : input.tasks.map(renderTask)),
    input.text,
    input.reviewed,
    ...input.priorReports,
    input.role === "work" && input.access === "read-only"
      ? "Access: read-only. Don't write source or install state, even with full permissions; report the exact source state you checked."
      : null,
    input.profile
      ? `Execution: ${describeProfile(input.profile)}; permissions: ${input.permissionMode ?? "environment default"}.`
      : null,
    input.role === "review"
      ? "This review is read-only: read the code, then give your findings as your final message. Don't fix them."
      : "Finish with your report as your final message.",
    opMarker(input.opId),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The new coordinator's first message (T136): the handover generated from recent activity.
 * Nothing else is injected; the Initiative's records stay readable through initiative_read.
 */
export function renderCoordinatorSeed(input: {
  project: Pick<ProjectRecord, "name" | "objective">;
  replacing: boolean;
  reason: string | null;
  handover: string | null;
}): string {
  return [
    input.replacing
      ? `This thread is starting as the replacement coordinator of the Initiative "${input.project.name}".${input.reason ? ` Reason: ${input.reason}.` : ""}`
      : `This thread is starting as coordinator of a new Initiative, "${input.project.name}".`,
    "Start with initiative_read to check that this thread is the confirmed current coordinator. Until it is, do not give out work or change Initiative state. If Initiative membership is unavailable, leave confirmation and settlement to the operator and do not retry the start.",
    `Objective: ${input.project.objective}`,
    input.replacing
      ? "Once confirmed, this replacement is complete: continue the work below. Don't request another handover or recreate the coordinator to finish it."
      : null,
    input.handover
      ? `Handover from the previous coordinator:\n\n${input.handover}`
      : input.replacing
        ? "No handover text was given. Read the overview, workers and recent reports with initiative_read before acting."
        : "After confirmation, plan with the user: create tasks if they help, then spawn workers with complete briefs.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
