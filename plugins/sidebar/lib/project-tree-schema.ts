// Version 1 of Projects public RPC tree. Keep both schemas checked against the shared fixture.
import { z } from "zod";

// Versioned public data contract used by the optional Threads integration.
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
