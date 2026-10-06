import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { commandSchema } from "./commands";
import { legacyThreadCreateSchema } from "./legacy";
import type { Overview } from "./overview";
import { projectSummarySchema, treeSchema } from "./tree-schema";
import { readOptionsSchema, READ_VIEWS } from "./read";
export type { ProjectSummary, ProjectTree } from "./tree-schema";

const id = z.string().min(1).max(80);
export const projectsContract = defineRpcContract({
  resetSetting: {
    input: z.object({ field: z.enum(["coordinatorInstructions", "workerInstructions", "executionProfiles"]) }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  list: { input: z.null(), output: z.array(projectSummarySchema) },
  tree: { input: z.null(), output: treeSchema },
  membership: {
    input: z.object({ threadId: id }),
    output: z
      .object({
        projectId: id,
        name: z.string(),
        role: z.enum(["coordinator", "work", "review", "adhoc"]),
        former: z.boolean(),
      })
      .nullable(),
  },
  overview: {
    /** `detail` wins over the older `detailed` (false = summary, default full). */
    input: z.object({
      projectId: id,
      detailed: z.boolean().optional(),
      detail: z.enum(["summary", "history", "full"]).optional(),
    }),
    output: z.custom<Overview>(),
  },
  read: {
    input: readOptionsSchema.extend({
      projectId: id,
      view: z.enum(READ_VIEWS),
    }),
    output: z.unknown(),
  },
  command: {
    input: z.object({ projectId: id.optional(), command: z.union([commandSchema, legacyThreadCreateSchema]) }),
    output: z.unknown(),
  },
  inventory: {
    input: z.null(),
    output: z.array(
      z.object({
        id,
        name: z.string(),
        environments: z.array(
          z.object({
            id,
            path: z.string().nullable(),
            hostId: id,
            name: z.string().nullable(),
            isWorktree: z.boolean(),
            status: z.string(),
            isDefaultHome: z.boolean(),
          }),
        ),
      }),
    ),
  },
});
