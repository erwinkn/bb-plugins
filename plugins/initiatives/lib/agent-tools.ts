import { z } from "zod";
import { environmentSchema, FINAL_MESSAGE_MAX, profileSchema, workerKindSchema } from "./schema";
import type { Command } from "./commands";
import { ProjectError } from "./bb";

/**
 * T136: the agent tool surface. Each tool is one flat object (Claude's bridge blanks union
 * roots) translated onto the shared commands, so the dashboard, CLI and tools run the same
 * rules. Giving work is a spawn or a message; tasks are optional; a report is
 * initiative_report with the report text, sent to the coordinator.
 */
const text = (max = 2000) => z.string().trim().min(1).max(max);
const ref = text(80);

export const spawnToolSchema = z.object({
  label: text(200).describe("Short name, shown in the W# title."),
  purpose: text(300).describe("What this worker is for."),
  text: text(20000).describe("The brief: the task, the context it needs, explicit user instructions that matter, how to verify."),
  role: z.enum(["work", "review"]).optional().describe("work (default) or review. A review is read-only and reports findings."),
  tasks: z.array(ref).max(30).optional().describe("Optional T# tasks this work is for."),
  reviews: ref.optional().describe("Review only: the W# (its latest report) or A# to review; that report is embedded."),
  handoffs: z.array(ref).max(3).optional().describe("Up to 3 prior reports to embed, as W# (latest report) or A#."),
  kind: workerKindSchema.optional().describe("Work only: worker (default; implement a known change), experimenter (try things, prototype, report options), fast (small, well-specified) or analyst (read lots and report; no building or running). Settings map each kind to a model. investigator is a deprecated alias for analyst."),
  profile: profileSchema.optional().describe("Explicit execution profile; wins over kind. Omitted uses the Settings default for the kind or review."),
  project: ref.optional().describe("Member BB project id, when not the primary one."),
  environment: environmentSchema.optional().describe("{type:\"worktree\"} for an isolated checkout; default is the project checkout (a review defaults to the reviewed worker's)."),
  permissionMode: z.enum(["accept-edits", "auto", "full"]).optional(),
}).strict();

export const messageToolSchema = z.object({
  to: z.string().max(32).optional().describe("W# or \"coordinator\"."),
  target: z.string().max(32).optional().describe("Older name for to."),
  text: text(20000),
  mode: z.enum(["steer", "queue"]).optional().describe("steer: urgent corrections and blockers; queue (default): everything else."),
  tasks: z.array(ref).max(30).optional().describe("Coordinator only: give this worker more work on these tasks."),
  work: z.boolean().optional().describe("Coordinator only: this message is more work (the worker reports on it again), even without tasks. To a reviewer it is a re-review of its batch, read-only, with the reviewed worker's latest report."),
  resumeCold: z.boolean().optional().describe("Coordinator only: give the work even though the worker's large prompt cache has gone cold (the refusal says what it costs)."),
}).strict();

export const taskToolSchema = z.object({
  action: z.enum(["create", "update", "close", "reopen"]),
  task: ref.optional().describe("T# (update, close, reopen)."),
  title: text(200).optional(),
  text: text(20000).optional().describe("What the task is about."),
  note: text().optional().describe("update: progress note. close: what happened."),
  outcome: z.enum(["done", "cancelled"]).optional().describe("close: done or cancelled."),
}).strict();

export const workerToolSchema = z.object({
  action: z.enum(["retire", "stop", "adopt"]),
  worker: ref.optional().describe("W# (retire, stop)."),
  reason: text().optional(),
  threadId: ref.optional().describe("adopt: an existing thread."),
  role: z.enum(["work", "review"]).optional().describe("adopt: its role."),
  label: text(200).optional().describe("adopt: its label."),
  purpose: text(300).optional().describe("adopt: its purpose."),
}).strict();

export const manageToolSchema = z.object({
  action: z.enum(["pause", "resume", "stop-work", "archive", "handover", "edit"]),
  reason: text().optional().describe("handover: why."),
  note: text(6000).optional().describe("handover: optional note for the handover writer."),
  cancel: z.boolean().optional().describe("handover: withdraw a pending request."),
  profile: profileSchema.optional().describe("handover: the new coordinator's profile."),
  environment: environmentSchema.optional(),
  name: text(200).optional().describe("edit"),
  objective: text(4000).optional().describe("edit"),
  memberProjectIds: z.array(ref).max(30).optional().describe("edit"),
}).strict();

export const updateToolSchema = z.object({
  text: text(6000).optional().describe("The update: what is done, what is next, what you need."),
  summary: text(1000).optional(),
  body: text(6000).optional(),
  checkpoint: text(6000).optional().describe("Ignored; kept for older sessions."),
}).strict();

export const reportToolSchema = z.object({
  outcome: z.enum(["done", "blocked", "failed"]),
  summary: text(4000).describe("One line for the dashboard. Longer text is kept in full; the dashboard line is clipped to 300 characters."),
  question: text(1000).optional().describe("blocked: what you need answered."),
  report: text(FINAL_MESSAGE_MAX).describe("Your full report, as you would write it to the coordinator: what you did, what you verified, what is left. It is recorded and sent to the coordinator."),
}).strict();

const need = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new ProjectError(`${what} is required.`);
  return value;
};

export const spawnCommand = (i: z.infer<typeof spawnToolSchema>): Command => ({
  action: "delegate",
  route: "fresh",
  role: i.role ?? "work",
  label: i.label,
  area: i.purpose,
  note: i.text,
  ...(i.tasks ? { tasks: i.tasks } : {}),
  ...(i.reviews ? { reviews: i.reviews } : {}),
  ...(i.handoffs ? { handoffs: i.handoffs } : {}),
  ...(i.kind ? { kind: i.kind } : {}),
  ...(i.profile ? { profile: i.profile } : {}),
  ...(i.project ? { bbProjectId: i.project } : {}),
  ...(i.environment ? { environment: i.environment } : {}),
  ...(i.permissionMode ? { permissionMode: i.permissionMode } : {}),
});

/** A message with tasks or work:true gives work (route continue); otherwise it is one plain message. */
export function messageCommand(i: z.infer<typeof messageToolSchema>): Command {
  const to = i.to ?? i.target;
  if (!to) throw new ProjectError('Name the recipient: to:"W4" or to:"coordinator".');
  if (i.to && i.target && i.to !== i.target) throw new ProjectError("Give the recipient once, as to.");
  if (i.tasks?.length || i.work) {
    if (to === "coordinator") throw new ProjectError("Work goes to a worker (W#), not the coordinator.");
    return { action: "delegate", route: "continue", role: "work", worker: to, note: i.text, ...(i.tasks ? { tasks: i.tasks } : {}), delivery: i.mode ?? "queue", ...(i.resumeCold ? { resumeCold: true } : {}) };
  }
  return { action: "message", target: to as never, text: i.text, mode: i.mode ?? "queue" };
}

export function taskCommand(i: z.infer<typeof taskToolSchema>): Command {
  switch (i.action) {
    case "create":
      return { action: "task-create", title: need(i.title, "title"), ...(i.text ? { summary: i.text } : {}) };
    case "update":
      return { action: "task-update", task: need(i.task, "task"), ...(i.title ? { title: i.title } : {}), ...(i.text ? { summary: i.text } : {}), ...(i.note ? { note: i.note } : {}) };
    case "close":
      return { action: "task-close", task: need(i.task, "task"), outcome: need(i.outcome, "outcome (done or cancelled)"), ...(i.note ? { note: i.note } : {}) };
    case "reopen":
      return { action: "task-reopen", task: need(i.task, "task"), ...(i.note ? { reason: i.note } : {}) };
  }
}

/** retire/adopt are commands; stop is resolved by the caller to the worker's open work. */
export function workerCommand(i: z.infer<typeof workerToolSchema>): Command | { action: "worker-stop"; worker: string; reason: string } {
  switch (i.action) {
    case "retire":
      return { action: "worker-retire", worker: need(i.worker, "worker"), reason: i.reason ?? "Batch finished." };
    case "stop":
      return { action: "worker-stop", worker: need(i.worker, "worker"), reason: i.reason ?? "Stopped by the coordinator." };
    case "adopt":
      return { action: "adopt", threadId: need(i.threadId, "threadId"), role: i.role ?? "work", label: need(i.label, "label"), ...(i.purpose ? { area: i.purpose } : {}) };
  }
}

export function manageCommand(i: z.infer<typeof manageToolSchema>): Command {
  switch (i.action) {
    case "pause":
      return { action: "pause", paused: true };
    case "resume":
      return { action: "pause", paused: false };
    case "stop-work":
      return { action: "stop-work" };
    case "archive":
      return { action: "archive" };
    case "handover":
      return { action: "coordinator-handover", ...(i.reason ? { reason: i.reason } : {}), ...(i.note ? { note: i.note } : {}), ...(i.cancel ? { cancel: true } : {}), ...(i.profile ? { profile: i.profile } : {}), ...(i.environment ? { environment: i.environment } : {}) };
    case "edit":
      return { action: "edit", ...(i.name ? { name: i.name } : {}), ...(i.objective ? { objective: i.objective } : {}), ...(i.memberProjectIds ? { memberProjectIds: i.memberProjectIds } : {}) };
  }
}
