import type { AssignmentAccess, Brief, Profile } from "./schema";
import { describeProfile } from "./policy";
import type { DecisionRecord, ProjectRecord, TaskRecord } from "./store";
import { decisionRef } from "./store";
import { PLUGIN_ID } from "./identity";

// Per-assignment text sent as an ordinary message. Standing instructions live
// in the plugin skills and tool snippets, so this is an appended delta that
// does not rewrite any system prompt.

/** Marks a message as plugin-sent so the dispatch hook can tell it from a user's. */
export const opMarker = (opId: string) => `[${PLUGIN_ID}:${opId}]`;
export const OP_MARKER_PATTERN = new RegExp(`\\[${PLUGIN_ID}:(op_[a-z0-9]+)\\]`, "u");

const list = (items: string[]) => items.map((item) => `- ${item}`).join("\n");

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

export function renderAssignment(input: {
  project: Pick<ProjectRecord, "name">;
  assignmentRef: string;
  workerRef: string;
  workerLabel: string;
  workerPurpose: string;
  role: "work" | "review";
  access?: AssignmentAccess;
  profile?: Profile;
  permissionMode?: "accept-edits" | "auto" | "full";
  guidance?: string | null;
  tasks: TaskRecord[];
  reviewOf: TaskRecord[];
  decisions: DecisionRecord[];
  reviewTargets?: import("./store").ReviewTargetRecord[];
  /** Rendered standard handoffs of explicitly selected prior assignments (T96). */
  handoffs?: string[];
  note: string | null;
  opId: string;
}): string {
  const header =
    input.role === "review"
      ? `Initiative · ${input.project.name} · ${input.workerRef} ${input.workerLabel} — ${input.workerPurpose}: independent review ${input.assignmentRef}.`
      : `Initiative · ${input.project.name} · ${input.workerRef} ${input.workerLabel} — ${input.workerPurpose}: ${input.assignmentRef}.`;
  const body =
    input.role === "review"
      ? [
          `Review the implemented work for ${input.reviewOf.map((task) => `${task.ref} "${task.title}"`).join(", ")}. You did not write it; judge it against each task's brief and report findings. Do not fix the code yourself.`,
          ...input.reviewOf.map((task) =>
            task.brief
              ? `${task.ref} brief\n${renderBrief(task.brief)}`
              : `${task.ref}: ${task.summary}`,
          ),
        ]
      : input.tasks.map(
          (task) =>
            `${task.ref} "${task.title}"\n${task.brief ? renderBrief(task.brief) : task.summary}`,
        );
  return [
    header,
    input.profile
      ? `Execution: ${describeProfile(input.profile)}; permissions: ${input.permissionMode ?? "native inheritance"}.`
      : null,
    input.guidance ? `Current worker guidance from Initiative Settings:\n${input.guidance}` : null,
    input.role === "review" || input.access === "read-only"
      ? "Access: read-only. This assignment may share a checkout with readers and writers. Do not write source or install state, even with full native permissions. This is a coordination rule, not a filesystem sandbox. If live edits overlap your audit, identify the actual revision/source state checked in your report."
      : "Access: write. Overlapping writers must use separate checkouts or wait. Access is assignment coordination metadata, independent of native permissions.",
    ...body,
    input.reviewTargets?.length ? `Implemented scope:\n${list(input.reviewTargets.map(t => `${t.task} ← ${t.assignment} (${t.worker}), checked revision ${t.revision}; implementer ${describeProfile(t.profile)}`))}` : null,
    ...(input.handoffs ?? []),
    input.decisions.length
      ? `Relevant decisions (read more with initiative_read):\n${list(input.decisions.map((item) => `${decisionRef(item.num)} ${item.title}`))}`
      : null,
    input.note ? `Coordinator note: ${input.note}` : null,
    `Keep implementation choices, alternatives and rationale in a small handoff artifact. Use initiative_decision madeBy agent only for independently chosen, non-obvious significant design forks, never normal steps, checks, restatements, mandated implementation, routine reporting, audit/review setup or requested clean SHA/execution settings. Require explicit madeBy. Record explicit user choices as madeBy user regardless of recorder, excluding any agent-added defaults. An explicit user chat answer to an open question uses action answer; worker answers notify the coordinator by default, notify false is quiet. Never infer an answer or run Git to record choices. Only the current coordinator may use decision-cleanup accept/veto/remove on an explicit user cleanup request; workers cannot review/remove choices, and nobody may do so merely to silence Inbox.`,
    `Read exact mixed refs with initiative_read {refs:["A#","T#","D#"],detailed:true}; select fields for large reports. For an unresolved human choice, give the coordinator question/context, options with consequences, recommendation and affected task refs for a durable question. Do not infer questions from transcript prose. Discover current peers with initiative_read {view:"workers",limit:8}. initiative_message {target:"W#"|"coordinator",text,mode:"steer"|"queue"} sends one native message, grants no work and never resumes stopped/finished contexts. Direct interface facts go to work peers; dependency/ownership/scope changes and human questions go to coordinator. Reviewers communicate through coordinator. Routine progress never wakes agents; steer urgent corrections/blockers, queue future facts and inspect uncertain receipts. Retained sessions can use bb initiative message. Trust current membership over inherited fork identity.`,
    `When you finish or get blocked, call initiative_report with ${input.assignmentRef} once, include evidence and a bounded handoff. Follow the configured worker guidance for completion; going idle is not a report. Ending your turn is not silent: for an ordinary native child, BB sends the parent thread a completion notice each time a turn ends; forks and the report fallback keep their existing delivery. Wait for your own tests and tools within the turn where the tool supports it, or on your tool's single completion notification, rather than watchers that wake you per test or log line. Monitors that surface actionable events, blockers or questions remain appropriate.`,
    opMarker(input.opId),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function renderCoordinatorSeed(input: {
  project: Pick<
    ProjectRecord,
    "name" | "objective" | "checkpoint" | "context"
  >;
  replacing: boolean;
  reason: string | null;
}): string {
  const context = input.project.context;
  return [
    input.replacing
      ? `This thread is starting as the replacement coordinator of the initiative "${input.project.name}".${input.reason ? ` Reason: ${input.reason}.` : ""}`
      : `This thread is starting as coordinator of a new initiative, "${input.project.name}".`,
    "Start with initiative_read to check whether this thread is the confirmed current coordinator. Native checkout confirmation may still be pending. If Initiative membership is unavailable, leave confirmation and settlement to the operator and do not retry the start. Until confirmation, do not delegate, change Initiative state, or claim coordinator authority.",
    `Objective: ${input.project.objective}`,
    context.vision ? `Vision: ${context.vision}` : null,
    context.objectives.length
      ? `Current objectives:\n${list(context.objectives.slice(0, 12))}`
      : null,
    context.ideas.length
      ? `Ideas under consideration:\n${list(context.ideas.slice(0, 12))}`
      : null,
    input.project.checkpoint
      ? `Checkpoint from the previous coordinator:\n${input.project.checkpoint}`
      : null,
    input.replacing
      ? "After confirmation, the previous coordinator's workers transfer to this thread. Check their current native parentage in initiative_read before claiming the transfer is complete, then continue coordinating. Do not redo accepted work."
      : "After confirmation, start by planning: create tasks with initiative_task, record the decisions you need from the user, then delegate with initiative_delegate.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
