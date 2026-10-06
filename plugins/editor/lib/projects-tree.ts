// Version 1 of the Initiatives public RPC tree, vendored like the sidebar's
// copy: both are checked against the shared fixture.
import { z } from "zod";

/**
 * The Initiatives plugin's ID, then the one it had until its one-time move.
 * Readers ask whichever runs and read either metadata namespace, so the
 * switch order does not matter. Drop `projects` once it is retired.
 */
export const INITIATIVE_PLUGIN_IDS = ["initiatives", "projects"] as const;

const id = z.string().min(1).max(80);
export const treeNodeSchema = z.object({
  threadId: z.string().nullable(),
  label: z.string(),
  role: z.enum(["coordinator", "work", "review", "adhoc"]),
  worker: z.string().nullable(),
  parentWorker: z.string().nullable(),
  state: z.string(),
  bbProjectId: z.string(),
});
export const projectSummarySchema = z.object({
  id,
  name: z.string(),
  objective: z.string(),
  paused: z.boolean(),
  coordinatorThreadId: z.string().nullable(),
  memberProjectIds: z.array(z.string()),
  inFlight: z.number(),
  remaining: z.number(),
  opinions: z.number(),
  revisit: z.number(),
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export const treeSchema = z.object({
  version: z.literal(1),
  projects: z.array(
    projectSummarySchema.extend({
      nodes: z.array(treeNodeSchema),
      retired: z.number(),
    }),
  ),
});
export type ProjectTree = z.infer<typeof treeSchema>;
export type TreeNode = z.infer<typeof treeNodeSchema>;
