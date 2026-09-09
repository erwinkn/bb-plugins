import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod/mini";
import {
  directoryListingSchema,
  managedProjectSchema,
  PROJECT_NAME_MAX,
  projectInventorySchema,
} from "./project-schema";

const projectId = z.object({ projectId: z.string().check(z.minLength(1)) });
const name = z
  .string()
  .check(z.trim(), z.minLength(1), z.maxLength(PROJECT_NAME_MAX));
const path = z.string().check(z.trim(), z.minLength(1));

// Server-side only. Frontend code imports `projectContract` as a type.
export const projectContract = defineRpcContract({
  listProjects: { input: z.null(), output: projectInventorySchema },
  createProject: {
    input: z.object({ name, hostId: z.string().check(z.minLength(1)), path }),
    output: managedProjectSchema,
  },
  renameProject: {
    input: z.object({ ...projectId.shape, name }),
    output: managedProjectSchema,
  },
  deleteProject: {
    input: projectId,
    output: z.object({ ok: z.literal(true) }),
  },
  reorderProject: {
    input: z.object({
      ...projectId.shape,
      previousProjectId: z.nullable(z.string()),
      nextProjectId: z.nullable(z.string()),
    }),
    output: projectInventorySchema,
  },
  changeProjectFolder: {
    input: z.object({ ...projectId.shape, path }),
    output: managedProjectSchema,
  },
  listDirectory: {
    input: z.object({
      hostId: z.string().check(z.minLength(1)),
      path: z.optional(z.string()),
    }),
    output: directoryListingSchema,
  },
  pickFolder: {
    input: z.object({ hostId: z.string().check(z.minLength(1)) }),
    output: z.object({ path: z.nullable(z.string()) }),
  },
});
