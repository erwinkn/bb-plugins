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
  role: z.enum(["work", "review"]).optional().describe("work by default. A review is read-only and reports findings."),
  tasks: z.array(ref).max(30).optional().describe("T# tasks this work is for."),
  reviews: ref.optional().describe("Review only: the W# (its latest report) or A# to review; that report is embedded."),
  handoffs: z.array(ref).max(3).optional().describe("Up to 3 prior reports to embed, as W# (latest report) or A#."),
  kind: workerKindSchema.optional().describe("Work only: worker (default; a known change), experimenter (prototype, report options), fast (small, well-specified) or analyst (read and report; no building). Settings map each to a model."),
  profile: profileSchema.optional().describe("An explicit model; wins over kind."),
  project: ref.optional().describe("Member BB project id, when not the primary one."),
  environment: environmentSchema.optional().describe("{type:\"worktree\"} for an isolated checkout; default is the project checkout (a review defaults to the reviewed worker's)."),
  permissionMode: z.enum(["accept-edits", "auto", "full"]).optional(),
}).strict();

export const messageToolSchema = z.object({
  to: z.string().max(32).optional().describe("W# or \"coordinator\"."),
  /** Older sessions' name for to; not advertised (messageToolAdvertised). */
  target: z.string().max(32).optional(),
  text: text(20000),
  mode: z.enum(["steer", "queue"]).optional().describe("steer: urgent corrections and blockers; queue (default): everything else."),
  tasks: z.array(ref).max(30).optional().describe("Coordinator only: give this worker more work on these tasks."),
  work: z.boolean().optional().describe("Coordinator only: this message is more work (the worker reports on it again), even without tasks. Refused for a reviewer: reviews are not reused, so spawn a fresh reviewer."),
}).strict();
/** What agents see: messageToolSchema without the older target. */
export const messageToolAdvertised = messageToolSchema.omit({ target: true });

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
  summary: text(4000).describe("What the coordinator reads first, standing on its own: outcome, PR URL and head, merge order, what you need. Its first 300 characters are the dashboard line; a long report reaches the coordinator as its first 1000."),
  question: text(1000).optional().describe("blocked: what you need answered."),
  report: text(FINAL_MESSAGE_MAX).describe("Your full report, as you would write it to the coordinator: what you did, what you verified, what is left. It is recorded; the coordinator gets it whole when short, otherwise reads it on demand."),
}).strict();

/**
 * T143: a tool's parameters as agents see them. Each advertised tool costs its tokens in every
 * session, so this drops what says nothing: $schema and zod's implicit integer maximum
 * (9007199254740991). Bounds stay, since the tool refuses what exceeds them (W262).
 */
export function advertisedSchema(schema: z.ZodType | Record<string, unknown>): Record<string, unknown> {
  const json = typeof (schema as { safeParse?: unknown }).safeParse === "function" ? z.toJSONSchema(schema as z.ZodType, { io: "input" }) : schema;
  // Keys of a properties map are field names, never keywords.
  const slim = (value: unknown, fields = false): unknown => {
    if (Array.isArray(value)) return value.map((item) => slim(item));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).flatMap(([key, item]) =>
      !fields && (key === "$schema" || (key === "maximum" && item === Number.MAX_SAFE_INTEGER)) ? [] : [[key, slim(item, !fields && key === "properties")]]));
  };
  return slim(json) as Record<string, unknown>;
}

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
    return { action: "delegate", route: "continue", role: "work", worker: to, note: i.text, ...(i.tasks ? { tasks: i.tasks } : {}), delivery: i.mode ?? "queue" };
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
