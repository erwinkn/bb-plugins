import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const id = z.string().min(1).max(200);
const markdown = z.string().trim().min(1).max(100_000);
export const versionSchema = z.object({ id, number: z.number().int().positive(), markdown, createdAt: z.number() });
export const annotationKindSchema = z.enum(["comment", "redline", "looksGood"]);
/** Text beside a quote; see CONTEXT_LENGTH in lib/quote-anchor.ts. */
const context = z.string().max(200);
const position = z.number().int().nonnegative();
export const commentSchema = z.object({
  id, versionId: id, quote: z.string().max(10_000), body: z.string().trim().max(10_000),
  kind: annotationKindSchema.optional(),
  prefix: context.optional(), suffix: context.optional(), position: position.optional(),
  resolved: z.boolean(), createdAt: z.number(), sentAt: z.number().nullable(),
});
export const planSchema = z.object({
  id, title: z.string().trim().min(1).max(200), threadId: id.nullable(), projectId: id.nullable(),
  projectName: z.string().nullable(), status: z.enum(["review", "revising", "approved"]), sample: z.boolean(),
  createdAt: z.number(), updatedAt: z.number(), versions: z.array(versionSchema), comments: z.array(commentSchema),
});
export type Plan = z.infer<typeof planSchema>;
export type PlanVersion = z.infer<typeof versionSchema>;
export type PlanComment = z.infer<typeof commentSchema>;
export const createSchema = z.object({ title: planSchema.shape.title, markdown, threadId: id.optional(), sample: z.boolean().optional() });
export const reviseSchema = z.object({ id, markdown, expectedVersionId: id });
export const reviewSchema = z.object({ id, versionId: id, action: z.enum(["feedback", "approve"]), note: z.string().max(10_000), requestId: id });
export const addCommentSchema = z.object({
  id, versionId: id, quote: z.string().max(10_000),
  body: z.string().trim().max(10_000).default(""), kind: annotationKindSchema.optional(),
  prefix: context.optional(), suffix: context.optional(), position: position.optional(),
}).superRefine((value, ctx) => {
  if ((!value.kind || value.kind === "comment") && !value.body) {
    ctx.addIssue({ code: "custom", path: ["body"], message: "Write a comment before saving." });
  }
  if (value.kind && value.kind !== "comment" && !value.quote.trim()) {
    ctx.addIssue({ code: "custom", path: ["quote"], message: "Select text before adding an annotation." });
  }
});
export const plansContract = defineRpcContract({
  list: { input: z.object({ threadId: id.optional(), offset: z.number().int().nonnegative().optional() }), output: z.array(planSchema) },
  get: { input: z.object({ id }), output: planSchema },
  create: { input: createSchema, output: planSchema },
  revise: { input: reviseSchema, output: planSchema },
  addComment: { input: addCommentSchema, output: planSchema },
  resolveComment: { input: z.object({ id, commentId: id, resolved: z.boolean() }), output: planSchema },
  updateComment: { input: z.object({ id, commentId: id, body: z.string().trim().min(1).max(10_000) }), output: planSchema },
  removeComment: { input: z.object({ id, commentId: id }), output: planSchema },
  remove: { input: z.object({ id }), output: z.object({ ok: z.literal(true) }) },
  submitReview: { input: reviewSchema, output: planSchema },
});
