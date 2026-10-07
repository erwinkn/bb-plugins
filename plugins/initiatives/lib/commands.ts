import { z } from "zod";
import type { NewThreadRequest } from "@get-bb/plugin-sdk/app";
import {
  briefSchema,
  decisionSchema,
  reportSchema,
  lightweightDecisionSchema,
  environmentSchema,
  policySchema,
  profileSchema,
  projectContextSchema,
  ROLES,
  ASSIGNMENT_ACCESS,
  WORK_KINDS,
  workerKindSchema,
} from "./schema";
import type { ProjectsService } from "./service";
import { ProjectError } from "./bb";
import { messageSchema } from "./messaging";
import { DECISION_ACTIONS, decisionIssues, normalizeDecisionInput } from "./decision-input";
import { settlementReceipt } from "./receipts";
import { PROJECT_COLORS, PROJECT_ICONS } from "./tree-schema";

const text = (max = 2000) => z.string().trim().min(1).max(max);
const ref = text(80);
const refs = z.array(ref).max(30);
const taskFields = {
  title: text(200),
  summary: text(20000).optional(),
  brief: briefSchema.optional(),
  priority: z.number().int().min(0).max(5).optional(),
  dependsOn: refs.optional(),
  workKind: z.enum(WORK_KINDS).optional(),
  profile: profileSchema.optional(),
};
export const createSchema = z
  .object({
    action: z.literal("create"),
    name: text(200),
    objective: text(4000),
    memberProjectIds: z.array(ref).min(1).max(30),
    policy: policySchema.optional(),
    coordinator: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("new"),
          bbProjectId: ref.optional(),
          environment: environmentSchema.optional(),
        })
        .strict(),
      z.object({ kind: z.literal("adopt"), threadId: ref }).strict(),
    ]),
  })
  .strict();
/** Internal and legacy: spawn (fresh) or work message (continue). Agents use initiative_spawn/initiative_message. */
export const delegateSchema = z
  .object({
    action: z.literal("delegate"),
    route: z.enum(["fresh", "continue"]).default("fresh"),
    role: z.enum(ROLES).default("work"),
    access: z.enum(ASSIGNMENT_ACCESS).optional(),
    tasks: refs.optional(),
    reviews: ref.optional(),
    reviewOf: refs.optional(),
    reviewTargets: z.array(z.object({ task: ref, assignment: ref, revision: text(200) }).strict()).min(1).max(20).optional(),
    worker: ref.optional(),
    kind: workerKindSchema.optional(),
    profile: profileSchema.optional(),
    bbProjectId: ref.optional(),
    environment: environmentSchema.optional(),
    label: text(200).optional(),
    area: text(300).optional(),
    note: text(20000).optional(),
    delivery: z.enum(["steer", "queue"]).optional(),
    rationale: text().optional(),
    handoffs: z.array(ref).max(3).optional(),
    permissionMode: z.enum(["accept-edits", "auto", "full"]).optional(),
    resumeCold: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.delivery && value.route !== "continue") ctx.addIssue({ code: "custom", path: ["delivery"], message: "delivery applies only to a message to an existing worker." });
    if (value.resumeCold && value.route !== "continue") ctx.addIssue({ code: "custom", path: ["resumeCold"], message: "resumeCold applies only to more work for an existing worker." });
    if (value.kind && (value.route !== "fresh" || value.role === "review"))
      ctx.addIssue({ code: "custom", path: ["kind"], message: "kind applies to a new work worker; a message keeps the worker's model, and a review follows the reviewed worker's model family." });
    if (value.route !== "fresh") return;
    if (!value.label?.trim())
      ctx.addIssue({ code: "custom", path: ["label"], message: "A new worker needs a label, shown in its W# title." });
    if (!value.area?.trim())
      ctx.addIssue({ code: "custom", path: ["area"], message: "A new worker needs a purpose describing what it is for." });
  });
export const taskCommands = [
  z.object({ action: z.literal("task-create"), ...taskFields }).strict(),
  z
    .object(taskFields)
    .partial()
    .extend({
      action: z.literal("task-update"),
      task: ref,
      profile: profileSchema.nullable().optional(),
      note: text().optional(),
    })
    .strict(),
  z.object({ action: z.literal("task-close"), task: ref, outcome: z.enum(["done", "cancelled"]), note: text().optional() }).strict(),
  z
    .object({ action: z.literal("task-cancel"), task: ref, reason: text() })
    .strict(),
  z
    .object({ action: z.literal("task-reopen"), task: ref, reason: text().optional() })
    .strict(),
  z
    .object({
      action: z.literal("assignment-stop"),
      assignment: ref,
      reason: text(),
    })
    .strict(),
  z
    .object({
      action: z.literal("assignment-settle"),
      assignment: ref,
      outcome: z.union([
        z.object({ threadId: ref }).strict(),
        z.object({ notSent: z.literal(true) }).strict(),
      ]),
    })
    .strict(),
] as const;
export const workerCommands = [
  z
    .object({ action: z.literal("worker-retire"), worker: ref, reason: text() })
    .strict(),
  z
    .object({
      action: z.literal("adopt"),
      threadId: ref,
      role: z.enum(ROLES),
      label: text(200),
      area: text(300).optional(),
      tasks: refs.optional(),
      detachNativeParent: z.boolean().optional(),
    })
    .strict(),
] as const;
export const decisionCommands = [
  z.object({
    action: z.literal("decision"), decision: lightweightDecisionSchema,
    scope: ref.optional(), topic: text(200).optional(), supersedes: ref.optional(),
  }).strict(),
  z.object({ action: z.literal("question"), question: decisionSchema }).strict(),
] as const;
export const decisionReviewSchema = z.object({
  action: z.literal("decision-review"), decision: ref,
  verdict: z.enum(["okay", "not-okay"]),
  message: z.string().trim().max(2000).default(""),
}).strict().refine(value => value.verdict === "okay" || value.message.length > 0, { message: "Not okay needs a message for the coordinator.", path: ["message"] });
export const manageCommands = [
  z
    .object({
      action: z.literal("coordinator-settle"),
      outcome: z.union([
        z.object({ threadId: ref }).strict(),
        z.object({ notSent: z.literal(true) }).strict(),
      ]),
    })
    .strict(),
  z
    .object({
      action: z.literal("edit"),
      name: text(200).optional(),
      objective: text(4000).optional(),
      memberProjectIds: refs.optional(),
      policy: policySchema.optional(),
      context: projectContextSchema.optional(),
      expected: z
        .object({
          name: text(200),
          objective: text(4000),
          context: projectContextSchema,
        })
        .strict()
        .optional(),
    })
    .strict(),
  /** T136: write (or rewrite) the handover a replacement coordinator will start from. */
  z.object({ action: z.literal("handover-draft"), restart: z.boolean().optional(), note: text(6000).optional() }).strict(),
  z.object({ action: z.literal("handover-draft-discard") }).strict(),
  z.object({ action: z.literal("pause"), paused: z.boolean() }).strict(),
  z.object({ action: z.literal("stop-work") }).strict(),
  z.object({ action: z.literal("archive") }).strict(),
  z
    .object({
      action: z.literal("replace-coordinator"),
      reason: text(),
      profile: profileSchema.optional(),
      /** T136: the reviewed handover text, used as the new coordinator's first message as-is. */
      handover: text(20000).optional(),
      /** Legacy checkpoint text: passed to the generated handover as the outgoing note. */
      checkpoint: text(6000).optional(),
      adoptThreadId: ref.optional(),
      bbProjectId: ref.optional(),
      environment: environmentSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("coordinator-handover"),
      reason: text().optional(),
      /** Optional note from the outgoing coordinator, given to the handover writer. */
      note: text(6000).optional(),
      /** Legacy name for note. */
      checkpoint: text(6000).optional(),
      profile: profileSchema.optional(),
      environment: environmentSchema.optional(),
      cancel: z.boolean().optional(),
    })
    .strict(),
] as const;
/**
 * User-owned thread creation: intentionally not part of manageCommands, so the
 * initiative_manage tool never offers it to a coordinator. The sidebar and the
 * Project panel call it through the command RPC.
 */
const nativeComposeRequestSchema = z.object({
  projectId: text(80), providerId: text(80), model: text(120),
  reasoningLevel: profileSchema.shape.reasoningLevel,
  permissionMode: z.enum(["accept-edits", "auto", "full"]),
  serviceTier: profileSchema.shape.serviceTier,
  executionInputSources: z.object({
    providerId: z.enum(["explicit", "client-preference"]).optional(),
    model: z.enum(["explicit", "client-preference"]).optional(),
    reasoningLevel: z.enum(["explicit", "client-preference"]).optional(),
    serviceTier: z.enum(["explicit", "client-preference"]).optional(),
    permissionMode: z.enum(["explicit", "client-preference"]).optional(),
  }).strict(),
  environment: z.record(z.string(), z.json()).refine(v => typeof v.type === "string"),
  input: z.array(z.record(z.string(), z.json())).min(1).max(100),
  sendAt: z.number().int().nonnegative().optional(),
}).strict().transform(request => request as unknown as NewThreadRequest);
export const threadCreateSchema = z
  .object({
    action: z.literal("thread-create"),
    title: text(200).optional(),
    request: nativeComposeRequestSchema,
  })
  .strict();
export const acknowledgeSchema = z
  .object({
    action: z.literal("acknowledge"),
    decision: ref,
    note: z.string().trim().max(4000).default(""),
  })
  .strict();
/** The user sends or removes a message BB is holding for a member thread (T133). */
export const queuedMessageSchema = z
  .object({
    action: z.literal("queued-message"),
    thread: z.string().regex(/^thr_[a-z0-9]+$/),
    message: z.string().regex(/^qmsg_[a-z0-9]+$/),
    operation: z.enum(["send", "delete"]),
  })
  .strict();
export const answerSchema = z
  .object({
    action: z.literal("answer"),
    decision: ref,
    choice: text(200).nullable(),
    note: z.string().trim().max(4000).default(""),
    notify: z.boolean().optional(),
  })
  .strict();
/** D386: the user's Inbox answer to a blocked report; question and context are the blocker they saw. */
export const blockerAnswerSchema = z.object({
  action: z.literal("blocker-answer"), assignment: ref,
  question: z.string().max(1000),
  context: z.string().max(2000),
  note: z.string().trim().min(1, "Write an answer.").max(4000),
  /** T130: the coordinator continues the worker (default), or the answer goes straight to the worker with an FYI to the coordinator. */
  to: z.enum(["coordinator", "worker"]).default("coordinator"),
}).strict();
/** T128: the user dismisses a blocked report without answering; notify tells the coordinator, with an optional note. */
export const blockerDismissSchema = z.object({
  action: z.literal("blocker-dismiss"), assignment: ref,
  question: z.string().max(1000),
  context: z.string().max(2000),
  notify: z.boolean().default(false),
  note: z.string().trim().max(4000).default(""),
}).strict();
/** T128: the user takes a dismissal back; the blocker returns to the Inbox if it is still open. */
export const blockerDismissUndoSchema = z.object({
  action: z.literal("blocker-dismiss-undo"), decision: ref,
}).strict();
export const closeQuestionSchema = z.object({
  action: z.literal("question-close"), decision: ref,
  note: z.string().trim().max(4000).default(""),
}).strict();
/** D340: the current coordinator withdraws its own open question; never an answer. */
export const questionWithdrawSchema = z.object({
  action: z.literal("question-withdraw"), decision: ref,
  reason: z.string().trim().min(1, "a reason is required: why the user no longer needs to answer").max(2000),
}).strict();
export const updateSchema = z
  .object({
    action: z.literal("update"),
    /** T136: one short update; summary/body remain for the dashboard and older sessions. */
    text: text(6000).optional(),
    summary: text(1000).optional(),
    body: text(6000).optional(),
    /** Ignored since T136: the coordinator keeps no persistent checkpoint. */
    checkpoint: text(6000).optional(),
  })
  .strict()
  .refine(v => v.text || (v.summary && v.body), { message: "Write the update as text." });
/** T16: user-only Initiative icon and color. Omitted keeps a field, null resets it to the default look. */
export const appearanceCommandSchema = z
  .object({
    action: z.literal("appearance"),
    icon: z.enum(PROJECT_ICONS).nullable().optional(),
    color: z.enum(PROJECT_COLORS).nullable().optional(),
  })
  .strict();
export const commandSchema = z.discriminatedUnion("action", [
  createSchema,
  messageSchema.extend({ action: z.literal("message") }),
  threadCreateSchema,
  delegateSchema,
  ...taskCommands,
  ...workerCommands,
  ...decisionCommands,
  z.object({ action: z.literal("decision-accept-all") }).strict(),
  z.object({ action: z.literal("decision-clear") }).strict().describe("Retired bulk removal: always refuses with refresh/decision-accept-all instructions; never changes data."),
  ...manageCommands,
  answerSchema,
  blockerAnswerSchema,
  blockerDismissSchema,
  blockerDismissUndoSchema,
  closeQuestionSchema,
  questionWithdrawSchema,
  decisionReviewSchema,
  acknowledgeSchema,
  queuedMessageSchema,
  updateSchema,
  appearanceCommandSchema,
]);
export type Command = z.infer<typeof commandSchema>;

const decisionCommandSchema = z.discriminatedUnion("action", [...decisionCommands, answerSchema, questionWithdrawSchema]);
export type DecisionCommand = z.infer<typeof decisionCommandSchema>;
/** The one agent boundary for initiative_decision and its CLI: flat or legacy input, errors with an example. */
export function parseDecisionCommand(raw: unknown): DecisionCommand {
  const normalized = normalizeDecisionInput(raw);
  if (!normalized.ok) throw new ProjectError(normalized.message);
  const parsed = decisionCommandSchema.safeParse(normalized.value);
  if (!parsed.success) throw new ProjectError(decisionIssues(String(normalized.value.action), parsed.error, normalized.flat));
  return parsed.data;
}
/** T136: actions that no longer exist, with what replaces them. */
export const REMOVED_ACTIONS: Record<string, string> = {
  "task-accept": 'Acceptance was removed: close the task with initiative_task {"action":"close","task":"T#","outcome":"done"}.',
  "review-accept": "Review acceptance was removed: read the review's final message, send fixes to the worker, and retire the reviewer.",
  "assignment-reject": 'Rejection was removed: message the worker with the fixes (initiative_message {"to":"W#","text":"…","work":true}).',
  "assignment-scope-release": "Write holds were removed; overlapping writers only get a warning.",
  "task-checkpoint": 'Checkpoints were removed: record the outcome with initiative_task {"action":"update","task":"T#","note":"…"} or close the task.',
  "decision-cleanup": "Decision cleanup was removed; the user checks agent decisions in the Inbox.",
  fork: "Forking was removed: spawn a fresh worker with handoffs, or message the existing one.",
};
export function refuseRemoved(raw: unknown) {
  if (typeof raw !== "object" || raw === null) return;
  const { action, route } = raw as { action?: unknown; route?: unknown };
  const why = typeof action === "string" ? REMOVED_ACTIONS[action] : undefined;
  if (why) throw new ProjectError(why);
  if (action === "delegate" && route === "fork") throw new ProjectError(REMOVED_ACTIONS.fork!);
}
/** CLI command input: decision-family actions go through the agent boundary; the rest are unchanged. */
export const parseCommandInput = (raw: unknown): Command => {
  refuseRemoved(raw);
  return typeof raw === "object" && raw !== null && (DECISION_ACTIONS as readonly unknown[]).includes((raw as { action?: unknown }).action)
    ? parseDecisionCommand(raw)
    : commandSchema.parse(raw);
};

/** Shared entry point for tools, UI and CLI. Agent authority is checked by the caller. */
export async function runCommand(
  service: ProjectsService,
  projectId: string | undefined,
  c: Command,
  author: "user" | "coordinator",
  threadId: string | null,
) {
  if (c.action === "create") return service.createProject(c);
  if (!projectId)
    throw new ProjectError(
      "Pass an Initiative ID or run this from its coordinator thread.",
    );
  const provenance = { author, threadId, assignment: null };
  switch (c.action) {
    case "message":
      if (!threadId) throw new ProjectError("Messages require a current managed agent caller.");
      return service.message(threadId, c, projectId);
    case "thread-create": {
      if (author !== "user")
        throw new ProjectError(
          "Only the user can open an Initiative thread. Coordinators delegate managed work instead.",
        );
      return service.createUserThread(projectId, { title: c.title, request: c.request });
    }
    case "edit":
      return service.editProject(projectId, c, author);
    case "appearance":
      if (author !== "user") throw new ProjectError("Only the user changes an Initiative's icon or color, from the sidebar or the Initiative panel.");
      return service.setAppearance(projectId, c);
    case "pause":
      return service.setPaused(projectId, c.paused);
    case "stop-work":
      return service.stopRunningWork(projectId);
    case "archive":
      return service.archiveProject(projectId);
    case "replace-coordinator":
      return service.replaceCoordinator(projectId, c, { author });
    case "coordinator-handover":
      return c.cancel
        ? service.cancelHandover(projectId, author)
        : service.requestHandover(projectId, c, author);
    case "handover-draft":
      return service.startHandoverDraft(projectId, { ...(c.note ? { note: c.note } : {}), ...(c.restart ? { restart: true } : {}) });
    case "handover-draft-discard":
      return service.discardHandoverDraft(projectId);
    case "coordinator-settle":
      return service.settleCoordinator(projectId, c.outcome);
    case "task-create":
      return service.createTask(projectId, c, author);
    case "task-update":
      return service.updateTask(projectId, c.task, c, author);
    case "task-close":
      return service.closeTask(projectId, c.task, c.outcome, c.note);
    case "task-cancel":
      return service.cancelTask(projectId, c.task, c.reason);
    case "task-reopen":
      return service.reopenTask(projectId, c.task, c.reason ?? "Reopened.");
    case "assignment-stop":
      return service.stopAssignment(projectId, c.assignment, c.reason);
    case "assignment-settle": {
      // Lead with what the settle did and did not confirm; the full record follows unchanged.
      const settled = await service.settleUncertain(projectId, c.assignment, c.outcome);
      return { settlement: settlementReceipt(settled, c.outcome), ...settled };
    }
    case "delegate":
      // The coordinator's every way of giving more work; the user's own sends are never refused.
      if (author === "coordinator") await service.refuseColdResume(projectId, c);
      return service.delegate(projectId, c);
    case "adopt":
      return service.adoptWorker(projectId, c);
    case "worker-retire":
      return service.retireWorker(projectId, c.worker, c.reason);
    case "decision":
      return service.recordDecision(projectId, c, provenance);
    case "question":
      return service.recordQuestion(projectId, c.question, provenance);
    case "decision-clear":
      throw new ProjectError("Bulk removal is retired. Refresh the dashboard and use decision-accept-all to accept unchecked agent decisions quietly.");
    case "decision-accept-all":
      if (author !== "user") throw new ProjectError("Only the human dashboard can accept unchecked agent decisions in bulk.");
      return service.acceptAgentDecisions(projectId);
    case "decision-review":
      if (author !== "user") throw new ProjectError("Only the user reviews agent decisions.");
      return service.reviewDecision(projectId, c.decision, c.verdict, c.message);
    case "answer": {
      if (author !== "user")
        throw new ProjectError("The user answers their own opinion requests.");
      return service.answerOpinion(projectId, c.decision, c);
    }
    case "blocker-answer":
      if (author !== "user") throw new ProjectError("Only the user answers a worker's blocker from the Inbox. Agents continue the worker with the answer instead.");
      return service.answerBlocker(projectId, c.assignment, { question: c.question, context: c.context }, c.note, c.to);
    case "blocker-dismiss":
      if (author !== "user") throw new ProjectError("Only the user dismisses a worker's blocker from the Inbox. Agents answer the worker instead.");
      return service.dismissBlocker(projectId, c.assignment, { question: c.question, context: c.context }, { notify: c.notify, note: c.note });
    case "blocker-dismiss-undo":
      if (author !== "user") throw new ProjectError("Only the user undoes their dismissal of a blocker.");
      return service.undoBlockerDismissal(projectId, c.decision);
    case "question-close": {
      if (author !== "user") throw new ProjectError("Only the user closes a question quietly.");
      return service.closeQuestion(projectId, c.decision, c.note);
    }
    case "question-withdraw":
      return service.withdrawQuestion(projectId, c.decision, c.reason, provenance);
    case "acknowledge": {
      if (author !== "user")
        throw new ProjectError("Only the user marks decisions as reviewed.");
      return service.acknowledgeDecision(projectId, c.decision, c.note);
    }
    case "queued-message":
      if (author !== "user") throw new ProjectError("Only the user sends or removes a held message from the Inbox. Agents use bb thread queue.");
      return service.resolveHeldMessage(projectId, c.thread, c.message, c.operation);
    case "update":
      return service.recordUpdate(projectId, c, threadId);
  }
}
