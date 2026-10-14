import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod/mini";
import { managedProjectSchema, PROJECT_NAME_MAX } from "./project-schema";

const projectId = z.object({ projectId: z.string().check(z.minLength(1)) });
const name = z
  .string()
  .check(z.trim(), z.minLength(1), z.maxLength(PROJECT_NAME_MAX));

// Server-side only. Frontend code imports `projectContract` as a type.
export const projectContract = defineRpcContract({
  renameProject: {
    input: z.object({ ...projectId.shape, name }),
    output: managedProjectSchema,
  },
  deleteProject: {
    input: projectId,
    output: z.object({ ok: z.literal(true) }),
  },
});
