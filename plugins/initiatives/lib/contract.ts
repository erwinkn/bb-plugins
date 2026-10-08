import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { commandSchema } from "./commands";
import { legacyThreadCreateSchema } from "./legacy";
import type { MergeQueue } from "./merge-queue";
import type { PrNote } from "./pr-notes";
import type { Overview } from "./overview";
import { projectSummarySchema, treeSchema } from "./tree-schema";
import { readOptionsSchema, READ_VIEWS } from "./read";
export type { ProjectSummary, ProjectTree } from "./tree-schema";

const id = z.string().min(1).max(80);
const membershipSchema = z
  .object({
    projectId: id,
    name: z.string(),
    role: z.enum(["coordinator", "work", "review", "adhoc"]),
    former: z.boolean(),
  })
  .nullable();
export type PanelMembership = z.infer<typeof membershipSchema>;
/**
 * What the tab looked like when a dashboard read gave up: evidence for whether
 * the device slept, the tab was frozen, or the connection went stale.
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
export const projectsContract = defineRpcContract({
  resetSetting: {
    input: z.object({ field: z.enum(["coordinatorInstructions", "workerInstructions", "executionProfiles"]) }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  list: { input: z.null(), output: z.array(projectSummarySchema) },
  tree: { input: z.null(), output: treeSchema },
  membership: {
    input: z.object({ threadId: id }),
    output: membershipSchema,
  },
  /**
   * Everything a thread's Initiative panel and header need in one request:
   * the thread's membership and, for a member, the summary-tier overview.
   */
  panel: {
    input: z.object({ threadId: id }),
    output: z.object({ membership: membershipSchema, summary: z.custom<Overview>().nullable() }),
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
  /**
   * Open PRs by the `gh` user in the member projects' GitHub repositories,
   * in merge-queue order. Answered from a server cache at once, never waiting
   * on GitHub (D441): a stale repository (two minutes) or `refresh` starts a
   * fetch behind the answer, shown as `fetching`, and its end is announced on
   * the merge-queue-changed realtime channel. Fetch failures come back per
   * repository beside the last good data, never as a thrown error.
   */
  mergeQueue: {
    input: z.object({ projectId: id, refresh: z.boolean().optional() }),
    output: z.custom<MergeQueue>(),
  },
  /** D442: one PR's whole notes log, oldest first (the queue carries only the last few). */
  prNotes: {
    input: z.object({ projectId: id, url: z.string().min(1).max(300) }),
    output: z.custom<PrNote[]>(),
  },
  /**
   * A client's read timed out; logged as one warn line. `read` names the view
   * (panel, overview, details…). Clients send at most one per minute.
   */
  reportReadTimeout: {
    input: readTimeoutReportSchema.extend({ read: z.string().min(1).max(40) }),
    output: z.object({ ok: z.literal(true) }),
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
