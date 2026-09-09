/**
 * Frontend RPC: list({threadId?, offset?}) -> Plan[]; get({id}) -> Plan;
 * create({title, markdown, threadId?, sample?}) -> Plan (source user).
 * All annotation mutations return Plan:
 * addAnnotation({id, versionId?, quote, body, kind, prefix?, suffix?, position?})
 * uses the selected version or latest, assigns a number/state, and queues feedback.
 * withdrawAnnotation({id, annotationId}) drops pending feedback or queues a withdrawal.
 * resolveAnnotation({id, annotationId}) marks addressed without a message.
 * replyToAnnotation({id, annotationId, body}) queues a user reply with its quote.
 * updateAnnotation({id, annotationId, body}) edits only undelivered feedback.
 * approve({id, requestId, versionId}) approves the viewed latest version once and releases the hold.
 * setDeliveryMode({id, mode}) saves the mode and queues its notification.
 * remove({id}) -> {ok:true}; deliveryStatus({id}) -> pending/failed/dropped items and delivered approvals.
 * annotationDeliveryStatus({id}) -> pending/failed items with annotation IDs.
 * Plan.delivery.notice reports a provider fallback for the panel.
 * Every mutation publishes plans-changed {id}; creation also publishes
 * plan-submitted {id, threadId}. Annotation data remains under comments.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const idSchema = z.string().min(1).max(200);
export const markdownSchema = z.string().min(1).max(100_000).refine((text) => !!text.trim(), "Write a plan.");
const title = z.string().trim().min(1).max(200);
export const bodySchema = z.string().trim().min(1).max(10_000);
export const deliveryModeSchema = z.enum(["queue-if-active", "steer-if-active"]);
export const annotationKindSchema = z.enum(["comment", "ask", "redline", "looksGood"]);
export const versionSchema = z.object({
  id: idSchema, number: z.number().int().positive(), markdown: markdownSchema, createdAt: z.number(),
  source: z.enum(["agent", "user"]).default("user"), summary: z.string().max(10_000).default(""),
  resolves: z.array(idSchema).default([]),
});
export const replySchema = z.object({
  id: idSchema, author: z.enum(["agent", "user"]), body: bodySchema, createdAt: z.number(),
  deliveredAt: z.number().nullable().default(null),
});
const context = z.string().max(200);
const position = z.number().int().nonnegative();
export const commentSchema = z.object({
  id: idSchema, versionId: idSchema, number: z.number().int().nonnegative().default(0),
  quote: z.string().max(10_000), body: z.string().trim().max(10_000).default(""),
  kind: annotationKindSchema.default("comment"),
  prefix: context.optional(), suffix: context.optional(), position: position.optional(),
  createdAt: z.number(), sentAt: z.number().nullable().optional(),
  deliveredAt: z.number().nullable().optional(),
  revision: z.number().int().nonnegative().optional(),
  state: z.enum(["open", "answered", "addressed", "withdrawn"]).optional(),
  replies: z.array(replySchema).default([]),
}).transform(({ sentAt, ...item }) => ({
  ...item, deliveredAt: item.deliveredAt === undefined ? sentAt ?? null : item.deliveredAt,
  state: item.state === "withdrawn" ? "withdrawn" as const : item.kind === "looksGood" ? "addressed" as const : item.state ?? "open" as const,
}));
export const planSchema = z.object({
  id: idSchema, title, threadId: idSchema.nullable(), projectId: idSchema.nullable(),
  projectName: z.string().nullable(),
  status: z.enum(["open", "review", "revising", "approved"]).transform((value) => value === "approved" ? "approved" as const : "open" as const),
  sample: z.boolean().default(false), deliveryMode: deliveryModeSchema.default("queue-if-active"),
  revision: z.number().int().nonnegative().default(0),
  createdAt: z.number(), updatedAt: z.number(), versions: z.array(versionSchema).min(1), comments: z.array(commentSchema).default([]),
  approvalRequestId: idSchema.nullable().default(null),
  delivery: z.object({
    queuedMessageId: idSchema.nullable().default(null), queuedUpdatedAt: z.number().nullable().default(null),
    itemIds: z.array(idSchema).default([]), notice: z.string().nullable().default(null),
    itemRevisions: z.record(idSchema, z.number().int().nonnegative()).optional(),
  }).prefault({}),
}).transform((plan) => {
  const used = new Set(plan.comments.filter((item) => item.number > 0).map((item) => item.number));
  let number = 1;
  for (const item of [...plan.comments].sort((a, b) => a.createdAt - b.createdAt)) {
    if (item.number > 0) continue;
    while (used.has(number)) number += 1;
    item.number = number; used.add(number++);
  }
  return plan;
});
export type Plan = z.infer<typeof planSchema>;
export type PlanVersion = z.infer<typeof versionSchema>;
export type PlanComment = z.infer<typeof commentSchema>;
export const createSchema = z.object({ title, markdown: markdownSchema, threadId: idSchema.optional(), sample: z.boolean().optional() });
export const addAnnotationSchema = z.object({
  versionId: idSchema.optional(),
  id: idSchema, quote: z.string().trim().min(1).max(10_000), body: z.string().trim().max(10_000).default(""),
  kind: annotationKindSchema.default("comment"), prefix: context.optional(), suffix: context.optional(), position: position.optional(),
}).superRefine((value, ctx) => {
  if ((value.kind === "comment" || value.kind === "ask") && !value.body) ctx.addIssue({ code: "custom", path: ["body"], message: "Write a comment or question before saving." });
});
export const updateSchema = z.object({
  planId: idSchema, edits: z.array(z.object({ old: z.string().min(1), new: z.string() })).min(1).optional(),
  markdown: markdownSchema.optional(), summary: bodySchema, resolves: z.array(idSchema).default([]),
}).refine((value) => (value.edits === undefined) !== (value.markdown === undefined), "Supply edits or markdown, exactly one.");
export const agentReplySchema = z.object({ planId: idSchema, annotation: idSchema, body: bodySchema, resolve: z.boolean().optional() });
const target = z.object({ id: idSchema, annotationId: idSchema });
export const deliveryStatusSchema = z.object({
  id: idSchema, kind: z.string(), state: z.enum(["pending", "failed", "dropped", "delivered"]), attempts: z.number(), nextAttemptAt: z.number(),
});
export const plansContract = defineRpcContract({
  list: { input: z.object({ threadId: idSchema.optional(), offset: z.number().int().nonnegative().optional() }), output: z.array(planSchema) },
  get: { input: z.object({ id: idSchema }), output: planSchema },
  create: { input: createSchema, output: planSchema },
  addAnnotation: { input: addAnnotationSchema, output: planSchema },
  withdrawAnnotation: { input: target, output: planSchema },
  resolveAnnotation: { input: target, output: planSchema },
  replyToAnnotation: { input: target.extend({ body: bodySchema }), output: planSchema },
  updateAnnotation: { input: target.extend({ body: bodySchema }), output: planSchema },
  approve: { input: z.object({ id: idSchema, requestId: idSchema, versionId: idSchema }), output: planSchema },
  setDeliveryMode: { input: z.object({ id: idSchema, mode: deliveryModeSchema }), output: planSchema },
  remove: { input: z.object({ id: idSchema }), output: z.object({ ok: z.literal(true) }) },
  annotationDeliveryStatus: { input: z.object({ id: idSchema }), output: z.array(deliveryStatusSchema.extend({ annotationId: idSchema })) },
  deliveryStatus: { input: z.object({ id: idSchema }), output: z.array(deliveryStatusSchema) },
});
