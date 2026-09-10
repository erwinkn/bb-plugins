// Shared wire contract for the backend and the Phase 2 frontend.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { normalizeEntry } from "./allow";

export const REALTIME_CHANNEL = "share:changed";
export const visibilitySchema = z.enum(["access", "public"]);
export type Visibility = z.infer<typeof visibilitySchema>;
export const timestampSchema = z.number().int().nonnegative().max(8_640_000_000_000_000);
export const expiryDaysSchema = z.number().nonnegative().max(1_000_000);
export const allowEntrySchema = z.string().transform((input, ctx) => {
  try { return normalizeEntry(input); }
  catch (error) {
    ctx.addIssue({ code: "custom", message: (error as Error).message });
    return z.NEVER;
  }
});
const allowedEmailsSchema = z.array(allowEntrySchema).max(1000);
const threadArg = z.object({ threadId: z.string().min(1).max(256) });
export const shareRefSchema = threadArg.extend({ shareId: z.string().min(1).max(256) });
export const createSchema = threadArg.extend({
  visibility: visibilitySchema,
  allowedEmails: allowedEmailsSchema.optional(),
  includeTools: z.boolean().optional(),
  expiresInDays: expiryDaysSchema.nullable().optional(),
});
export const updateSchema = shareRefSchema.extend({
  allowedEmails: allowedEmailsSchema.optional(),
  includeTools: z.boolean().optional(),
  expiresAt: timestampSchema.nullable().optional(),
});
export const shareSchema = z.object({
  id: z.string(), threadId: z.string(), visibility: visibilitySchema, url: z.string(),
  allowedEmails: z.array(z.string()), includeTools: z.boolean(),
  createdAt: timestampSchema, revokedAt: timestampSchema.nullable(), expiresAt: timestampSchema.nullable(),
  lastViewedAt: timestampSchema.nullable(), viewCount: z.number().int().nonnegative(),
  state: z.enum(["active", "revoked", "expired"]),
});
export type Share = z.infer<typeof shareSchema>;
export const statusSchema = z.object({
  configured: z.boolean(), accessConfigured: z.boolean(), publicLinksEnabled: z.boolean(),
  defaultExpiryDays: expiryDaysSchema, publicBaseUrl: z.string().nullable(), missing: z.array(z.string()),
});
export type Status = z.infer<typeof statusSchema>;
export const rpcContract = defineRpcContract({
  share_status: { input: z.object({}), output: statusSchema },
  share_list: { input: threadArg, output: z.object({ shares: z.array(shareSchema) }) },
  share_create: { input: createSchema, output: z.object({ share: shareSchema }) },
  share_update: { input: updateSchema, output: z.object({ share: shareSchema }) },
  share_revoke: { input: shareRefSchema, output: z.object({ share: shareSchema }) },
});

export function buildShareUrl(baseUrl: string, visibility: Visibility, slug: string): string {
  return `${baseUrl}/api/v1/plugins/share/http/${visibility === "access" ? "s" : "p"}?k=${slug}`;
}

export type RenderItem =
  | { kind: "message"; role: "user" | "assistant"; text: string; at: number }
  | { kind: "tool"; title: string; detail: string | null; output: string | null; status: string; at: number };
