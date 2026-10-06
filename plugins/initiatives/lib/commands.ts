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
} from "./schema";
import type { ProjectsService } from "./service";
import { ProjectError } from "./bb";
import { messageSchema } from "./messaging";
import { DECISION_ACTIONS, decisionIssues, normalizeDecisionInput } from "./decision-input";
import { reportedRetryHint, settlementReceipt } from "./receipts";
import { PROJECT_COLORS, PROJECT_ICONS } from "./tree-schema";

const text = (max = 2000) => z.string().trim().min(1).max(max);
const ref = text(80);
const refs = z.array(ref).max(30);
const taskFields = {
  title: text(200),
  summary: text(),
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
export const delegateSchema = z
  .object({
    action: z.literal("delegate"),
    route: z.enum(["fresh", "continue", "fork"]).default("fresh"),
    role: z.enum(ROLES).default("work"),
    access: z.enum(ASSIGNMENT_ACCESS).optional().describe(
      "Checkout coordination: read-only forbids source/install writes even with full native permissions. Omitted work access is write on every route; reviewers stay read-only. Readers may overlap live edits and must report the exact source state checked. This is not a filesystem sandbox.",
    ),
    tasks: refs.optional(),
    reviewOf: refs.optional(),
    reviewTargets: z.array(z.object({ task: ref, assignment: ref, revision: text(200) }).strict()).min(1).max(20).optional(),
    worker: ref.optional(),
    kind: z.enum(WORK_KINDS).optional(),
    profile: profileSchema.optional(),
    bbProjectId: ref.optional(),
    environment: environmentSchema.optional(),
    // Logical identity: required on fresh, an explicit rename on continue,
    // and inherited-with-optional-rename on fork.
    label: text(200).optional(),
    area: text(300).optional(),
    note: text(4000).optional(),
    delivery: z.enum(["steer", "queue"]).optional().describe("Continue only: urgent correction/blocker uses steer; future work uses queue (default). Native BB decides provisioning/interaction/offline queue behavior."),
    forkAtSeq: z.number().int().positive().optional(),
    rationale: text().optional(),
    handoffs: z.array(ref).max(3).optional().describe(
      "Up to 3 prior A# whose stored reports the brief embeds as standard handoffs: bounded, with provenance and exact evidence pointers. Each must cover these tasks, their dependsOn or their brief contextRefs. Reference only: it transfers no authority, acceptance, receipts, permissions or write scope. Work assignments only.",
    ),
    // Approval posture: set on the created thread for fresh/fork and on this
    // turn's send for continue. Omitting it inherits the environment's
    // configured default — pass "full" where the repository expects it.
    permissionMode: z.enum(["accept-edits", "auto", "full"]).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // A plugin-created worker needs a logical name and a purpose; continue
    // and fork reuse the existing worker's identity instead.
    if (value.handoffs?.length && value.role === "review") ctx.addIssue({ code: "custom", path: ["handoffs"], message: "Reviews bind reviewTargets and read reports themselves; handoffs are for work assignments." });
    if (value.delivery && value.route !== "continue") ctx.addIssue({ code: "custom", path: ["delivery"], message: "delivery applies only to continue; fresh/fork have native creation dispatch." });
    if (value.route !== "fresh") return;
    if (!value.label?.trim())
      ctx.addIssue({
        code: "custom",
        path: ["label"],
        message:
          "A fresh worker needs a logical name (label), shown as its W# title.",
      });
    if (!value.area?.trim())
      ctx.addIssue({
        code: "custom",
        path: ["area"],
        message:
          "A fresh worker needs a purpose (area) describing what it is for.",
      });
  });
export const taskCommands = [
  z.object({ action: z.literal("task-checkpoint"), task: ref, worker: ref, assignment: ref.optional(), report: reportSchema }).strict(),
  z.object({ action: z.literal("task-create"), ...taskFields }).strict(),
  z
    .object(taskFields)
    .partial()
    .extend({
      action: z.literal("task-update"),
      task: ref,
      profile: profileSchema.nullable().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("task-accept"),
      task: ref,
      assignment: ref.optional(),
      result: text().optional(),
    })
    .strict(),
  z
    .object({ action: z.literal("task-cancel"), task: ref, reason: text() })
    .strict(),
  z
    .object({ action: z.literal("task-reopen"), task: ref, reason: text() })
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
  z
    .object({
      action: z.literal("review-accept"),
      assignment: ref,
    })
    .strict(),
  z
    .object({
      action: z.literal("assignment-reject"),
      assignment: ref,
      reason: text(),
    })
    .strict(),
  // D343: release the write scope a report's listed, unverified background work still
  // holds, after checking those jobs and once BB shows the thread ended.
  z
    .object({
      action: z.literal("assignment-scope-release"),
      assignment: ref,
      // The report version the caller inspected; the release binds to exactly that report.
      reportVersion: z
        .string({ error: 'reportVersion is required: copy it from initiative_read {"refs":["A#"]} (reportVersion) or from the hold message.' })
        .regex(/^[0-9a-f]{16}$/, "reportVersion must be the 16 hex characters initiative_read shows for this assignment."),
      reason: text(),
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
export const decisionCleanupSchema = z.object({
  action: z.literal("decision-cleanup"), decision: ref,
  operation: z.enum(["accept", "veto", "remove"]), reason: text(2000),
}).strict();
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
  z.object({ action: z.literal("pause"), paused: z.boolean() }).strict(),
  z.object({ action: z.literal("stop-work") }).strict(),
  z.object({ action: z.literal("archive") }).strict(),
  z
    .object({
      action: z.literal("replace-coordinator"),
      reason: text(),
      profile: profileSchema.optional(),
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
    summary: text(1000),
    body: text(6000),
    checkpoint: text(6000).optional(),
  })
  .strict();
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
  decisionCleanupSchema,
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
  updateSchema,
  appearanceCommandSchema,
]);
export type Command = z.infer<typeof commandSchema>;

const decisionCommandSchema = z.discriminatedUnion("action", [...decisionCommands, answerSchema, decisionCleanupSchema, questionWithdrawSchema]);
export type DecisionCommand = z.infer<typeof decisionCommandSchema>;
/** The one agent boundary for initiative_decision and its CLI: flat or legacy input, errors with an example. */
export function parseDecisionCommand(raw: unknown): DecisionCommand {
  const normalized = normalizeDecisionInput(raw);
  if (!normalized.ok) throw new ProjectError(normalized.message);
  const parsed = decisionCommandSchema.safeParse(normalized.value);
  if (!parsed.success) throw new ProjectError(decisionIssues(String(normalized.value.action), parsed.error, normalized.flat));
  return parsed.data;
}
/** CLI command input: decision-family actions go through the agent boundary; the rest are unchanged. */
export const parseCommandInput = (raw: unknown): Command =>
  typeof raw === "object" && raw !== null && (DECISION_ACTIONS as readonly unknown[]).includes((raw as { action?: unknown }).action)
    ? parseDecisionCommand(raw)
    : commandSchema.parse(raw);

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
    case "coordinator-settle":
      return service.settleCoordinator(projectId, c.outcome);
    case "task-checkpoint":
      return service.checkpointTask(projectId, c, threadId);
    case "task-create":
      return service.createTask(projectId, c, author);
    case "task-update":
      return service.updateTask(projectId, c.task, c, author);
    case "task-accept":
      return service.acceptTask(projectId, c.task, c);
    case "task-cancel":
      return service.cancelTask(projectId, c.task, c.reason);
    case "task-reopen": {
      const task = service.reopenTask(projectId, c.task, c.reason);
      // Reopening changes only the task; a reported assignment still holds it.
      const held = service.store.assignments(projectId).find(a => a.role === "work" && a.state === "reported" && a.taskNums.includes(task.num));
      return held ? { note: `${task.ref} is planned again, but ${held.ref} is still reported and still holds ${task.ref}: reopening does not release it. ${reportedRetryHint(held, task.ref)}`, ...task } : task;
    }
    case "assignment-stop":
      return service.stopAssignment(projectId, c.assignment, c.reason);
    case "assignment-settle": {
      // Lead with what the settle did and did not confirm; the full record follows unchanged.
      const settled = await service.settleUncertain(projectId, c.assignment, c.outcome);
      return { settlement: settlementReceipt(settled, c.outcome), ...settled };
    }
    case "review-accept":
      return service.acceptReview(projectId, c.assignment);
    case "assignment-reject":
      return service.rejectReport(projectId, c.assignment, c.reason);
    case "assignment-scope-release":
      return service.releaseScope(projectId, c.assignment, c.reportVersion, c.reason, author, threadId);
    case "delegate":
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
    case "decision-cleanup":
      return service.cleanupDecision(projectId, c.decision, c.operation, c.reason, threadId);
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
      if (author !== "user") throw new ProjectError("Only the user dismisses a worker's blocker from the Inbox. Agents reject or accept the report instead.");
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
    case "update":
      return service.recordUpdate(projectId, c, threadId);
  }
}
