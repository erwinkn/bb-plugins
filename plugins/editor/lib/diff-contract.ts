import { z } from "zod";

/** A branch name that cannot be read as a Git option or break a command line. */
export const refSchema = z.string().trim().min(1).max(256).refine((value) => !/^[-]/.test(value) && !/[\0\r\n]/.test(value), "Invalid Git reference");
export const shaSchema = z.string().trim().regex(/^[a-fA-F0-9]{7,40}$/, "Enter a commit hash");

export const diffTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("uncommitted") }).strict(),
  z.object({ type: z.literal("all"), mergeBaseBranch: refSchema.optional() }).strict(),
  z.object({ type: z.literal("branch_committed"), mergeBaseBranch: refSchema.optional() }).strict(),
  z.object({ type: z.literal("commit"), sha: shaSchema }).strict(),
]);
export type DiffTarget = z.infer<typeof diffTargetSchema>;

export const diffEntrySchema = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  changeKind: z.enum(["added", "copied", "deleted", "modified", "renamed", "type_changed"]),
  origin: z.enum(["tracked", "untracked"]),
  binary: z.boolean(),
  loadMode: z.enum(["auto", "on_demand", "too_large"]),
  additions: z.number(),
  deletions: z.number(),
});
export type DiffEntry = z.infer<typeof diffEntrySchema>;

export function isWorkingTreeTarget(target: DiffTarget): boolean {
  return target.type === "uncommitted" || target.type === "all";
}

export function hasConflictMarkers(content: string): boolean {
  return /^<<<<<<<(?: |$)/m.test(content) && /^=======\r?$/m.test(content) && /^>>>>>>>(?: |$)/m.test(content);
}
