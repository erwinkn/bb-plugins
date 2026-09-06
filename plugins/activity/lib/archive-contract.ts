import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod/mini";

const archivedThread = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.nullable(z.string()),
  titleFallback: z.nullable(z.string()),
  parentThreadId: z.nullable(z.string()),
  providerId: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  environmentId: z.nullable(z.string()),
  environmentName: z.nullable(z.string()),
  environmentBranchName: z.nullable(z.string()),
  environmentWorkspaceDisplayKind: z.enum([
    "managed-worktree",
    "unmanaged-worktree",
    "other",
  ]),
});
export const archiveContract = defineRpcContract({
  listArchived: {
    input: z.object({ offset: z.number().check(z.int(), z.nonnegative()) }),
    output: z.array(archivedThread),
  },
  restoreThread: {
    input: z.object({ threadId: z.string().check(z.minLength(1)) }),
    output: z.object({ ok: z.literal(true) }),
  },
});
export type ArchivedThread = z.infer<typeof archivedThread>;
