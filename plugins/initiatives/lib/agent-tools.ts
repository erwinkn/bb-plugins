import { z } from "zod";
import { answerOptionsSchema, FINAL_MESSAGE_MAX, profileSchema, workerKindSchema } from "./schema";
import { placementFields } from "./placement";
import type { Command } from "./commands";
import { ruleSources, ruleText } from "./rules";
import { ToolInputError } from "./tool-errors";
import { removedMode } from "./messaging";
import { headTail } from "./handover-packet";

/**
 * T136: the agent tool surface. Each tool is one flat object (Claude's bridge blanks union
 * roots) translated onto the shared commands, so the dashboard, CLI and tools run the same
 * rules. Giving work is a spawn or a message; tasks are optional; a report is
 * initiative_report with the report text, sent to the coordinator.
 */
const text = (max = 2000) => z.string().trim().min(1).max(max);
const ref = text(80);

const KIND_DESCRIPTION = "Work only: worker (default; everything else, investigations, read-only exploration and prototypes included: say so in the brief), fast (small, well-specified changes) or very-fast (mechanical: lookups, scans, renames, simple scripted checks). Settings map each to a model.";

export const spawnToolSchema = z.object({
  label: text(200).describe("Short name, shown in the W# title."),
  purpose: text(300).describe("What this worker is for."),
  text: text(20000).describe("The brief: the task, the context it needs, explicit user instructions that matter, how to verify."),
  /** Older sessions only (not advertised): v9 refuses role "review" and reviews, workers review their own work. */
  role: z.enum(["work", "review"]).optional(),
  tasks: z.array(ref).max(30).optional().describe("T# tasks this work is for."),
  reviews: ref.optional(),
  handoffs: z.array(ref).max(3).optional().describe("Up to 3 prior reports to embed, as W# (latest report) or A#."),
  kind: workerKindSchema.optional().describe(KIND_DESCRIPTION),
  profile: profileSchema.optional().describe("An explicit model; wins over kind."),
  project: ref.optional().describe("Member BB project id, when not the primary one."),
  ...placementFields,
  permissionMode: z.enum(["accept-edits", "auto", "full"]).optional(),
}).strict();

export const messageToolSchema = z.object({
  to: z.string().max(32).optional().describe("W#, or (a worker) \"lead\": the tab that gave you your work. \"coordinator\": the coordinator tab."),
  /** Older sessions' name for to; not advertised (messageToolAdvertised). */
  target: z.string().max(32).optional(),
  text: text(20000),
  /** Removed, refused with an explanation; not advertised (messageToolAdvertised). */
  mode: removedMode,
  tasks: z.array(ref).max(30).optional().describe("A lead only: give this worker more work on these tasks."),
  work: z.boolean().optional().describe("A lead only: this message is more work (the worker reports on it again), even without tasks."),
  resumeCold: z.boolean().optional().describe("A lead only: send more work even though the worker is idle with a large, cold cache; the refusal without it states the rewrite cost."),
}).strict();
/** What agents see: messageToolSchema without the older target. */
export const messageToolAdvertised = messageToolSchema.omit({ target: true, mode: true });
/**
 * W492: initiative_message as a worker's session advertises it (agents.configure): giving work
 * is a lead's, so tasks, work and resumeCold are not offered. Execution parses messageToolSchema.
 */
export const workerMessageToolSchema = messageToolSchema.pick({ text: true }).extend({
  to: z.string().max(32).describe('"lead": the tab that gave you your work ("coordinator" reaches it too). W# reaches a peer worker.'),
}).strict();
/** W554: initiative_pr_watch. */
export const prWatchToolSchema = z.object({
  pr: text(300).describe('The PR: its URL or "owner/repo#12"; "#12" or "repo#12" when one PR this Adventure lists matches.'),
  worker: ref.optional().describe("A lead only: watch for this W#, whose thread the PR's news then wakes."),
}).strict();
/** What a worker's session advertises: it watches for itself. */
export const workerPrWatchToolSchema = prWatchToolSchema.omit({ worker: true });
/** W554: initiative_pr_unwatch. */
export const prUnwatchToolSchema = workerPrWatchToolSchema;
/** What initiative_spawn advertises: no review fields (workers run their own reviews). */
export const spawnToolAdvertised = spawnToolSchema.omit({ role: true, reviews: true });

export const taskToolSchema = z.object({
  action: z.enum(["create", "update", "status", "close", "reopen"]),
  task: ref.optional().describe("T# (update, status)."),
  title: text(200).optional(),
  text: text(20000).optional().describe("What the task is about."),
  note: text().optional().describe("update: progress note."),
  status: z.enum(["planned", "cancelled", "done", "auto"]).optional().describe("status: only on the user's instruction. auto lets the status follow the task's work and PRs again."),
  reason: text().optional().describe("status: the user's instruction, quoted."),
  /** Older sessions only. */
  outcome: z.enum(["done", "cancelled"]).optional(),
}).strict();
export const taskToolAdvertised = taskToolSchema.extend({ action: z.enum(["create", "update", "status"]) }).omit({ outcome: true });

/** v9 (D523): the standing rules, for leads. */
export const ruleToolSchema = z.object({
  action: z.enum(["add", "edit", "remove"]),
  rule: ref.optional().describe("R# (edit, remove)."),
  text: ruleText.optional().describe("add, edit: one line, one or two sentences."),
  sources: ruleSources.optional().describe("add: where it comes from, e.g. D12."),
}).strict();

/** v9: a question for the user (the question half of the old initiative_decision); W488: or the answer the user gave to one in chat. */
export const questionToolSchema = z.object({
  question: text(1000).optional().describe("The question, in plain words. answered: the blocker's question the user answered."),
  context: text(2000).optional().describe("What the user needs to know to answer."),
  options: answerOptionsSchema.optional(),
  recommendation: z.string().max(1000).optional(),
  withdraw: ref.optional().describe("D# of your own open question to withdraw instead (with reason)."),
  reason: text().optional().describe("withdraw: why the user no longer needs to answer."),
  answered: ref.optional().describe("A# of a worker's blocked report whose question the user answered in this chat instead of in the Inbox (with text)."),
  text: text(4000).optional().describe("answered: what the user said, quoted or faithfully summed up."),
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
  host: placementFields.host.describe("handover: must be the host of the first repository's default checkout, where a coordinator runs."),
  environment: placementFields.environment,
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
  outcome: z.enum(["done", "blocked", "failed"]).describe("done: finished (partial work too: say what is left). blocked: you can't go on without an answer. failed: it can't be done."),
  summary: text(4000).describe("What the coordinator reads first, standing on its own: outcome, PR URL and head, merge order, what you need. Its first 300 characters are the dashboard line; a long report reaches the coordinator as its first 1000."),
  question: text(1000).optional().describe("blocked, when only the user can answer: the question, shown in their Inbox. Without one, your lead decides what happens next."),
  options: answerOptionsSchema.optional().describe("blocked: the choices, shown to the user as options."),
  recommendation: z.string().max(1000).optional().describe("blocked: your pick, starting with its label, and why."),
  report: text(FINAL_MESSAGE_MAX).describe(`Your full report, as you would write it to the coordinator: what you did, what you verified, what is left. It is recorded; the coordinator gets it whole when short, otherwise reads it on demand. Past ${FINAL_MESSAGE_MAX} characters only its start and end are kept.`),
}).strict();

/** W492: outcomes agents write for the three initiative_report takes. */
const OUTCOME_ALIASES: Record<string, "done" | "failed"> = {
  succeeded: "done", success: "done", successful: "done", completed: "done", complete: "done", finished: "done", ok: "done",
  failure: "failed", error: "failed", errored: "failed",
};
/** The summary a report without one gets: the report's start. */
const SUMMARY_FROM_REPORT = 1000;

/**
 * W492: what initiative_report would otherwise refuse but can read without guessing: an outcome
 * named another way, a missing summary or report (the other stands in), a report past
 * FINAL_MESSAGE_MAX (its start and end are kept, like a captured final message). Each is said in
 * `notes`; the result is still parsed by reportToolSchema.
 */
export function normalizeReport(raw: unknown): { raw: unknown; notes: string[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { raw, notes: [] };
  const r: Record<string, unknown> = { ...raw };
  const notes: string[] = [];
  const meant = typeof r.outcome === "string" ? OUTCOME_ALIASES[r.outcome.trim().toLowerCase()] : undefined;
  if (meant) {
    notes.push(`outcome "${r.outcome}" was recorded as "${meant}".`);
    r.outcome = meant;
  }
  const given = (key: string) => (typeof r[key] === "string" && (r[key] as string).trim() ? (r[key] as string).trim() : null);
  const summary = given("summary"), report = given("report");
  if (!summary && report) {
    r.summary = report.length > SUMMARY_FROM_REPORT ? `${report.slice(0, SUMMARY_FROM_REPORT - 1).trimEnd()}…` : report;
    notes.push(`No summary: the report's first ${SUMMARY_FROM_REPORT} characters stand in.`);
  }
  if (!report && summary) {
    r.report = summary;
    notes.push("No report: the summary is recorded as the report.");
  }
  if (report && report.length > FINAL_MESSAGE_MAX) {
    // The omission marker takes the room left under the cap.
    r.report = headTail(report, FINAL_MESSAGE_MAX - 100);
    notes.push(`The report is ${report.length} characters: its start and end are kept, ${FINAL_MESSAGE_MAX - 100} in all.`);
  }
  return { raw: r, notes };
}

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
  if (value === undefined) throw new ToolInputError(`${what} is required.`);
  return value;
};

/** v9 (§3): no one starts a review assignment; existing reviewers still report. */
export const NO_NEW_REVIEWS = "Workers run their own reviews now: give the work to one worker, which starts a fresh reviewer each round and reports once. To check a finished worker's change, send it back to that worker with initiative_message work:true.";

export const spawnCommand = (i: z.infer<typeof spawnToolSchema>): Command => {
  if (i.role === "review" || i.reviews) throw new ToolInputError(NO_NEW_REVIEWS);
  return spawnCommandOf(i);
};
const spawnCommandOf = (i: z.infer<typeof spawnToolSchema>): Command => ({
  action: "delegate",
  route: "fresh",
  role: "work",
  label: i.label,
  area: i.purpose,
  note: i.text,
  ...(i.tasks ? { tasks: i.tasks } : {}),
  ...(i.handoffs ? { handoffs: i.handoffs } : {}),
  ...(i.kind ? { kind: i.kind } : {}),
  ...(i.profile ? { profile: i.profile } : {}),
  ...(i.project ? { bbProjectId: i.project } : {}),
  ...(i.host !== undefined ? { host: i.host } : {}),
  ...(i.worktree !== undefined ? { worktree: i.worktree } : {}),
  ...(i.environment ? { environment: i.environment } : {}),
  ...(i.permissionMode ? { permissionMode: i.permissionMode } : {}),
});

/**
 * A message with tasks or work:true gives work (route continue, always coordinator to worker, so it steers); otherwise it is one plain message whose default sendInitiativeMessage picks from sender and target.
 */
export function messageCommand(i: z.infer<typeof messageToolSchema>): Command {
  const to = i.to ?? i.target;
  if (!to) throw new ToolInputError('Name the recipient: to:"W4", to:"lead" or to:"coordinator".');
  if (i.to && i.target && i.to !== i.target) throw new ToolInputError("Give the recipient once, as to.");
  if (i.tasks?.length || i.work) {
    if (to === "coordinator" || to === "lead") throw new ToolInputError("Work goes to a worker (W#), not a lead.");
    return { action: "delegate", route: "continue", role: "work", worker: to, note: i.text, ...(i.tasks ? { tasks: i.tasks } : {}), ...(i.resumeCold ? { resumeCold: true } : {}) };
  }
  if (i.resumeCold) throw new ToolInputError("resumeCold applies to more work (work:true or tasks).");
  return { action: "message", target: to as never, text: i.text };
}

export function taskCommand(i: z.infer<typeof taskToolSchema>): Command {
  switch (i.action) {
    case "create":
      return { action: "task-create", title: need(i.title, "title"), ...(i.text ? { summary: i.text } : {}) };
    case "update":
      return { action: "task-update", task: need(i.task, "task"), ...(i.title ? { title: i.title } : {}), ...(i.text ? { summary: i.text } : {}), ...(i.note ? { note: i.note } : {}) };
    case "status":
      return { action: "task-status", task: need(i.task, "task"), status: need(i.status, "status (planned, cancelled, done or auto)"), reason: need(i.reason, "reason (the user's instruction)") };
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

export function ruleCommand(i: z.infer<typeof ruleToolSchema>): Command {
  switch (i.action) {
    case "add":
      return { action: "rule-add", text: need(i.text, "text"), ...(i.sources ? { sources: i.sources } : {}) };
    case "edit":
      return { action: "rule-edit", rule: need(i.rule, "rule"), text: need(i.text, "text") };
    case "remove":
      return { action: "rule-remove", rule: need(i.rule, "rule") };
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
      return { action: "coordinator-handover", ...(i.reason ? { reason: i.reason } : {}), ...(i.note ? { note: i.note } : {}), ...(i.cancel ? { cancel: true } : {}), ...(i.profile ? { profile: i.profile } : {}), ...(i.host !== undefined ? { host: i.host } : {}), ...(i.environment ? { environment: i.environment } : {}) };
    case "edit":
      return { action: "edit", ...(i.name ? { name: i.name } : {}), ...(i.objective ? { objective: i.objective } : {}), ...(i.memberProjectIds ? { memberProjectIds: i.memberProjectIds } : {}) };
  }
}
