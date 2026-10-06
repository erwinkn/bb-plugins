import { z } from "zod";
import { environmentSchema, profileSchema, reportSchema } from "./schema";

// Retained-session input and historical storage only. No proposals become rows.
export const legacyReportSchema = reportSchema.safeExtend({
  proposedKnowledge: z.array(z.object({
    kind: z.enum(["fact", "decision"]), title: z.string(), body: z.string(),
  }).strict()).max(10).optional(),
});
export const storedReportSchema = legacyReportSchema.transform(({ proposedKnowledge: _archived, ...report }) => report);
/** True when stored report JSON carries fields the public projection drops. */
export function isLegacyReport(stored: string): boolean {
  try {
    const value = JSON.parse(stored) as unknown;
    return typeof value === "object" && value !== null && "proposedKnowledge" in value;
  } catch {
    return false;
  }
}

export const LEGACY_TOOL_NAMES = [
  "create", "read", "manage", "task", "delegate", "worker", "update", "report", "progress",
] as const;

// Only the already-installed Sidebar/old panel RPC caller uses this shape.
// Canonical tools, CLI commands and the new Initiative UI never offer it.
export const legacyThreadCreateSchema = z.object({
  action: z.literal("thread-create"),
  title: z.string().trim().min(1).max(200).optional(),
  prompt: z.string().trim().min(1).max(4000),
  bbProjectId: z.string().min(1).max(80).optional(),
  environment: environmentSchema.optional(),
  profile: profileSchema.optional(),
}).strict();
export type LegacyThreadCreate = z.infer<typeof legacyThreadCreateSchema>;
