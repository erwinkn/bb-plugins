import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { projectOrderDocSchema } from "./project-order-schema";
import { treeSchema } from "./project-tree-schema";

const projectId = z.string().min(1).max(80);

// Mirrors the Projects `command`/`thread-create` reply; also validates the
// remote response when the sidebar server forwards the call.
export const threadCreateResultSchema = z.object({
  threadId: z.string().nullable(),
  state: z.enum(["active", "uncertain"]),
  note: z.string().nullable(),
});

export const projectModeContract = defineRpcContract({
  projectMode: {
    input: z.null(),
    output: z.object({
      available: z.boolean(),
      tree: treeSchema.nullable(),
      /**
       * The persisted sidebar order, or null when unavailable. Reading also
       * merges never-seen project ids into the stored order.
       */
      order: projectOrderDocSchema.nullable(),
      /**
       * Why the order could not be read or synced — most importantly an
       * unreadable stored document, which is surfaced rather than silently
       * replaced. Null when the read path is healthy.
       */
      orderError: z.string().nullable(),
    }),
  },
  // Compare-and-swap on the stored revision; a stale revision rejects so a
  // reorder cannot silently overwrite another client's.
  saveProjectOrder: {
    input: z.object({
      expectedRevision: z.number().int().nonnegative(),
      order: z.array(projectId).max(256),
    }),
    output: projectOrderDocSchema,
  },
  // Renames are delegated to the Projects plugin's own `command` RPC so the
  // sidebar never owns project data. The name differs from the management
  // contract's `renameProject`: rpc method names share one registry.
  renameTreeProject: {
    input: z.object({
      projectId,
      name: z.string().trim().min(1).max(200),
    }),
    output: z.unknown(),
  },
  // Thread creation runs through the Projects plugin's user-scoped `command`
  // RPC ("thread-create"); the sidebar chooses the member BB project and a
  // required first message — BB rejects an idle spawn. `uncertain` means
  // spawn did not confirm — the plugin reconciles it, so a null threadId
  // must never be retried blindly or navigated to.
  createProjectThread: {
    input: z.object({
      projectId,
      bbProjectId: projectId.optional(),
      prompt: z.string().trim().min(1).max(4000),
    }),
    output: threadCreateResultSchema,
  },
  /**
   * Cross-plugin bump the Projects plugin calls on every ledger mutation.
   * Republished on the sidebar's own realtime channel, which its app can
   * subscribe to; `useRealtime` only delivers the owning plugin's signals.
   */
  projectsChanged: {
    input: z.object({ projectId: projectId.optional() }),
    output: z.object({ ok: z.literal(true) }),
  },
});
