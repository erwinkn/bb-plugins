import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { projectOrderDocSchema } from "./project-order-schema";
import { PROJECT_COLORS, PROJECT_ICONS, treeSchema } from "./project-tree-schema";
import { adventureWorkerSchema } from "./adventure-workers";

const projectId = z.string().min(1).max(80);
/** The most parent links one `threadAncestry` read returns. */
export const MAX_ANCESTRY = 32;

// Mirrors the Initiatives `command`/`thread-create` reply; also validates the
// remote response when the sidebar server forwards the call.
export const threadCreateResultSchema = z.object({
  threadId: z.string().nullable(),
  state: z.enum(["active", "uncertain"]),
  note: z.string().nullable(),
});

/**
 * What the tab looked like when a tree read gave up: evidence for whether the
 * device slept, the tab was frozen, or the connection went stale.
 */
export const readTimeoutReportSchema = z.object({
  /** Wall-clock time from the read's start; above the timeout when the tab froze. */
  elapsedMs: z.number().int().nonnegative(),
  hidden: z.boolean(),
  online: z.boolean(),
  /** 0 while visible. */
  sinceVisibleMs: z.number().int().nonnegative(),
  /** The tab was hidden at some point while the read was pending. */
  hiddenDuringRead: z.boolean(),
});
export type ReadTimeoutReport = z.infer<typeof readTimeoutReportSchema>;

/**
 * What the Initiatives `command` RPC answers to a keyed `create`: a WriteAnswer
 * wrapping `{ project, note }`. An unkeyed (older) reply is the bare answer.
 */
const createdSchema = z.object({
  project: z.object({
    id: projectId,
    coordinatorThreadId: z.string().nullable().optional(),
  }),
  note: z.string().nullable().optional(),
});
export const createReplySchema = z.union([
  z.object({ write: z.literal("done"), answer: createdSchema }),
  z.object({
    write: z.enum(["rejected", "unknown"]),
    message: z.string(),
  }),
  createdSchema,
]);

/**
 * The create's outcome. rejected: Adventures refused it with nothing saved.
 * unknown: an earlier send of the key failed midway, so what it saved is
 * unknown. Either settles the key; a failed call (no answer) does not.
 */
export const createdInitiativeSchema = z.discriminatedUnion("write", [
  z.object({
    write: z.literal("done"),
    projectId,
    coordinatorThreadId: z.string().nullable(),
    /** Why the coordinator is not confirmed yet, or null. */
    note: z.string().nullable(),
  }),
  z.object({
    write: z.enum(["rejected", "unknown"]),
    message: z.string(),
  }),
]);
export type CreatedInitiative = z.infer<typeof createdInitiativeSchema>;

export const projectModeContract = defineRpcContract({
  projectMode: {
    /**
     * Pass the `revision` of the tree the client holds to have an unchanged
     * tree answered as `unchanged` with `tree: null`, instead of resent.
     */
    input: z
      .object({
        known: z.string().max(80).nullable(),
      })
      .nullable(),
    output: z.object({
      available: z.boolean(),
      tree: treeSchema.nullable(),
      /** Identifies this tree; only answered to a conditional read. */
      revision: z.string().nullable().optional(),
      /** The client's `known` tree is current; `tree` is null. */
      unchanged: z.boolean().optional(),
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
  /**
   * The model and group of each worker of an Adventure the client shows, as
   * the server last read them; answered from memory, without reading the
   * tree. Null while not read yet (or for an Adventure the last tree did not
   * list): asking marks it wanted, and its read is announced on
   * ADVENTURE_WORKERS_CHANGED once it lands. An Adventure nobody asked about
   * for WANTED_MS is no longer read again after a change.
   */
  adventureWorkers: {
    input: z.object({ projectId }),
    output: z.object({ workers: z.array(adventureWorkerSchema).nullable() }),
  },
  /**
   * The ids of every thread the Threads view hides: the ones the Initiatives
   * tree names (coordinators, workers, reviewers, member threads) and all
   * their descendants, archived or not. Answers at once from the server's
   * last snapshot and refreshes it in the background (a change is announced
   * on INITIATIVE_THREADS_CHANGED). `status` is "loading" until the first
   * read finishes, "failed" when that first read failed (no snapshot exists;
   * the client must not treat it as an answer), and "ready" once a snapshot
   * exists. `available` is false when Initiatives is confirmed not running.
   */
  initiativeThreads: {
    input: z.null(),
    output: z.object({
      available: z.boolean(),
      threadIds: z.array(z.string().min(1).max(80)),
      status: z.enum(["loading", "failed", "ready"]),
    }),
  },
  /**
   * A thread's parent links, its own first, then up the chain (at most
   * MAX_ANCESTRY): BB's sidebar list omits archived threads, so a client
   * cannot walk up through one to find the Adventure a thread belongs to.
   */
  threadAncestry: {
    input: z.object({ threadId: z.string().min(1).max(80) }),
    output: z.object({
      links: z
        .array(z.object({ id: z.string(), parentThreadId: z.string().nullable() }))
        .max(MAX_ANCESTRY),
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
  // Renames are delegated to the Initiatives plugin's own `command` RPC so the
  // sidebar never owns project data. The name differs from the management
  // contract's `renameProject`: rpc method names share one registry.
  renameTreeProject: {
    input: z.object({
      projectId,
      name: z.string().trim().min(1).max(200),
    }),
    output: z.unknown(),
  },
  // Icon and color go through the same user-scoped `command` RPC
  // ("appearance"), so Initiatives owns the data and validates the palette.
  // Omitted keeps a field; null resets it to the default look.
  setTreeProjectAppearance: {
    input: z.object({
      projectId,
      icon: z.enum(PROJECT_ICONS).nullable().optional(),
      color: z.enum(PROJECT_COLORS).nullable().optional(),
    }),
    output: z.unknown(),
  },
  // Thread creation runs through the Initiatives plugin's user-scoped `command`
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
   * Starts an Adventure through the Adventures plugin's user-scoped `command`
   * RPC ("create"), with a new coordinator on the first member's default
   * checkout, as its own create form does. `key` makes the write idempotent:
   * sending the same request with the same key again (after a timeout or a
   * lost answer) runs it at most once.
   */
  createInitiative: {
    input: z.object({
      name: z.string().trim().min(1).max(200),
      objective: z.string().trim().min(1).max(4000),
      memberProjectIds: z.array(projectId).min(1).max(30),
      key: z.string().min(1).max(100),
    }),
    output: createdInitiativeSchema,
  },
  /**
   * Cross-plugin bump the Initiatives plugin calls on every ledger mutation.
   * Republished on the sidebar's own realtime channel, which its app can
   * subscribe to; `useRealtime` only delivers the owning plugin's signals.
   */
  initiativesChanged: {
    input: z.object({ projectId: projectId.optional() }),
    output: z.object({ ok: z.literal(true) }),
  },
  /**
   * A client's tree read timed out; logged as one warn line. Clients send at
   * most one per minute.
   */
  reportReadTimeout: {
    input: readTimeoutReportSchema,
    output: z.object({ ok: z.literal(true) }),
  },
});
