import type { Brief, Profile } from "./schema";
import { describeProfile } from "./policy";
import type { ProjectRecord, TaskRecord } from "./store";
import { PLUGIN_ID } from "./identity";

// Per-assignment text sent as an ordinary message (T136): the task, its context and the
// report instruction. v9 (D523): a brief ends with the reviewer command and the standing rules,
// and every later work message with the whole worker loop (workLoopBlock), because BB cuts
// instructions at 4096 characters and a live session keeps the instructions it started with.

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
  /** v9: what the brief ends with: the reviewer command and rules, or the whole loop block. */
  appendix?: string | null;
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
      ? "This review is read-only: read the code, then report your findings with initiative_report. Don't fix them."
      : FINISH_WORK,
    input.appendix ?? null,
    opMarker(input.opId),
  ]
    .filter(Boolean)
    .join("\n\n");
}

const FINISH_WORK = "Finish by calling initiative_report with your full report.";
const REVIEWER_HEADING = "Reviewer command (code-review skill, other model family):";
const LOOP_HEADING = "How you work in this Initiative (current; replaces anything earlier):";

/**
 * v9: the command a worker starts each round's reviewer with: a BB child thread in its own
 * checkout, from the other model family, archived with the worker. The prompt file lives in the
 * worker's thread storage, so the checkout stays clean.
 */
export function reviewerCommand(reviewer: Profile): string {
  return [
    REVIEWER_HEADING,
    `bb thread spawn --project "$BB_PROJECT_ID" --parent-self \\`,
    `  --lifecycle-owner-thread "$BB_THREAD_ID" --environment "$BB_ENVIRONMENT_ID" \\`,
    `  --provider ${reviewer.providerId} --model ${reviewer.model} --reasoning-level ${reviewer.reasoningLevel}${reviewer.serviceTier ? ` --service-tier ${reviewer.serviceTier}` : ""} \\`,
    `  --title "Review r<N> <PR>" --prompt-file "$BB_THREAD_STORAGE/review-r<N>.md"`,
  ].join("\n");
}

/** What a fresh brief ends with: the reviewer command and the full rules. */
export const briefAppendix = (reviewer: string, rules: string) => [reviewer, rules].join("\n\n");

/**
 * What every more-work message and the adoption message end with: the worker guidance as a new
 * session would get it, the reviewer command and the full rules. It replaces whatever the
 * session was told earlier, so no session's origin has to be guessed.
 */
export const workLoopBlock = (guidance: string, reviewer: string, rules: string) =>
  [LOOP_HEADING, guidance, reviewer, rules].join("\n\n");

/**
 * A stored brief without the appendix every worker shares (guidance, reviewer command, rules):
 * the text that is this work's own. A PR a rule names is no one's work, so PR attribution reads
 * this. renderAssignment puts the appendix right after the brief's closing instruction, so the
 * first place that instruction meets an appendix heading is where it starts: guidance or rules
 * that quote either come after it. Own text quoting both together can only lose own text, never
 * gain the appendix.
 */
export function ownBriefText(text: string): string {
  const starts = [LOOP_HEADING, REVIEWER_HEADING].map((heading) => text.indexOf(`\n\n${FINISH_WORK}\n\n${heading}\n`)).filter((at) => at >= 0);
  return starts.length ? text.slice(0, Math.min(...starts) + 2 + FINISH_WORK.length) : text;
}

/**
 * The new coordinator's first message (T136): the handover generated from recent activity, then
 * (v9) two plugin-written blocks that must arrive whole, so they never go through the handover
 * writer: the full standing rules and, when there is pre-switch work, its list.
 */
export function renderCoordinatorSeed(input: {
  project: Pick<ProjectRecord, "name" | "objective">;
  replacing: boolean;
  reason: string | null;
  handover: string | null;
  rules?: string | null;
  preSwitch?: string | null;
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
    input.rules ?? null,
    input.preSwitch ?? null,
  ]
    .filter(Boolean)
    .join("\n\n");
}
