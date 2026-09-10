import { z } from "zod";

const id = z.string().min(1).max(128);
const path = z.string().min(1).max(4096).refine(value => !value.includes("\0") && !value.split(/[\\/]/).includes(".."), "Invalid file path");
export const UiFileTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace"), environmentId: id, path }).strict(),
  z.object({ kind: z.literal("host"), hostId: id, path }).strict(),
  z.object({ kind: z.literal("thread-storage"), threadId: id, path }).strict(),
]);
export const UiFileLocationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("line"), line: z.number().int().positive(), column: z.number().int().positive().nullable().default(null) }).strict(),
  z.object({ kind: z.literal("range"), startLine: z.number().int().positive(), endLine: z.number().int().positive() }).strict().refine(value => value.endLine >= value.startLine, "Invalid line range"),
]);
export const navigationActionSchemas = [
  z.object({ kind: z.literal("open_thread"), threadId: id, split: z.boolean().default(false) }).strict(),
  z.object({ kind: z.literal("open_project"), projectId: id }).strict(),
  z.object({ kind: z.literal("preview_file"), target: UiFileTargetSchema, location: UiFileLocationSchema.nullable().optional() }).strict(),
  z.object({ kind: z.literal("show_voice") }).strict(),
  z.object({ kind: z.literal("switch_space"), space: z.string().min(1).max(120) }).strict(),
] as const;
export const UiActionSchema = z.discriminatedUnion("kind", [
  ...navigationActionSchemas,
  z.object({ kind: z.literal("prepare_draft"), target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("thread"), threadId: id }).strict(),
    z.object({ kind: z.literal("new"), projectId: id.optional() }).strict(),
  ]), text: z.string().max(32000), mode: z.enum(["append", "replace"]).default("append") }).strict(),
]);
export type UiAction = z.infer<typeof UiActionSchema>;
export const UiCommandSchema = z.object({
  id, conversationId: id, requestId: id, callNonce: z.string().min(1).max(256), action: UiActionSchema, expiresAt: z.number().optional(),
}).strict();
export type UiCommand = z.infer<typeof UiCommandSchema>;
export const UiActionResultSchema = z.object({ status: z.enum(["succeeded", "failed", "cancelled", "unknown"]), detail: z.string().max(2000) }).strict();
export type UiActionResult = z.infer<typeof UiActionResultSchema>;
export const voiceUiParamsSchema = z.object({ request_id: id, action: UiActionSchema }).strict();
