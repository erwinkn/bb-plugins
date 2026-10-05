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
/**
 * Optional Initiative appearance, chosen by the user from a small palette:
 * one of BB's own icons and one of the sidebar's eight identity hues (in hue
 * step order). Readers treat null, or a value they do not know, as the
 * default (the Target icon and the hue derived from the name), so a newer
 * palette never breaks an older reader.
 */
export const PROJECT_ICONS = [
  "Target", "Layers", "Workflow", "Code", "Terminal", "Bug", "Beaker", "Brain",
  "Bot", "Globe", "Cloud", "Zap", "Star", "Puzzle", "Palette", "ChartColumn",
] as const;
export const PROJECT_COLORS = ["blue", "violet", "pink", "red", "orange", "yellow", "green", "teal"] as const;
export const appearanceSchema = z.object({
  icon: z.string().max(40).nullable(),
  color: z.string().max(40).nullable(),
});
export type ProjectAppearance = z.infer<typeof appearanceSchema>;
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
  appearance: appearanceSchema.optional(),
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
