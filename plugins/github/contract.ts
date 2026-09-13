/**
 * Frontend RPC contract. Most methods are inherited from BB's official GitHub
 * plugin (issues and PR browsing, spawning agents, mentions). This fork adds
 * per-thread pull request links:
 *
 * listPullRequests({threadId}) -> {links}: the thread's linked PRs, newest
 *   first. Refreshes the branch PR through BB's core lookup first, so a PR
 *   opened from the thread's branch is linked the first time anyone asks.
 * linkPullRequest({threadId, reference}) -> {link}: link by URL,
 *   owner/repo#n, or #n (repo resolved from the thread's checkout).
 * unlinkPullRequest({threadId, repo, number}) -> {ok}.
 *
 * Every link change publishes `pull-requests-changed {threadId}`; the panel
 * refetches on that signal and after a realtime reconnection. The same list
 * is mirrored into the thread's plugin metadata under `pullRequests`.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const repoNameSchema = z.string().regex(/^[\w.-]+\/[\w.-]+$/);
export const itemNumberSchema = z.number().int().positive();
export const itemInputSchema = z.object({ repo: repoNameSchema, number: itemNumberSchema }).strict();
const nonBlankStringSchema = z.string().refine((value) => value.trim().length > 0, "must not be blank");
const repoInfoSchema = z.object({ repo: repoNameSchema, projectId: z.string().nullable() }).strict();
const itemSchema = z
  .object({
    repo: repoNameSchema,
    number: itemNumberSchema,
    kind: z.enum(["issue", "pr"]),
    title: z.string(),
    state: z.string(),
    author: z.string(),
    labels: z.array(z.string()),
    assignees: z.array(z.string()),
    url: z.string(),
    body: z.string(),
    updatedAt: z.string(),
  })
  .strict();
const syncResultSchema = z.object({ repos: z.number().int().nonnegative(), items: z.number().int().nonnegative() }).strict();
const okResultSchema = z.object({ ok: z.literal(true) }).strict();
const commentSchema = z.object({ author: z.string(), body: z.string(), createdAt: z.string() }).strict();
export const threadLinkSchema = z
  .object({
    kind: z.enum(["issue", "pr"]),
    repo: repoNameSchema,
    number: itemNumberSchema,
    threadId: z.string().min(1),
    createdAt: z.string(),
  })
  .strict();
export const pullSchema = z
  .object({
    repo: repoNameSchema,
    number: itemNumberSchema,
    title: z.string(),
    state: z.string(),
    author: z.string(),
    body: z.string(),
    url: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    baseRefName: z.string(),
    headRefName: z.string(),
    additions: z.number().nonnegative(),
    deletions: z.number().nonnegative(),
    changedFiles: z.number().int().nonnegative(),
    labels: z.array(z.string()),
    assignees: z.array(z.string()),
    reviewDecision: z.string(),
    mergeStateStatus: z.string(),
    reviewRequests: z.array(z.string()),
    checks: z.array(
      z.object({ name: z.string(), status: z.enum(["success", "failure", "pending", "neutral"]), url: z.string() }).strict(),
    ),
    comments: z.array(commentSchema),
    reviews: z.array(z.object({ author: z.string(), state: z.string(), body: z.string(), createdAt: z.string() }).strict()),
    reviewThreads: z.array(
      z
        .object({
          path: z.string(),
          line: z.number().int().nonnegative().nullable(),
          diffHunk: z.string(),
          comments: z.array(commentSchema),
        })
        .strict(),
    ),
    files: z.array(
      z
        .object({
          path: z.string(),
          status: z.string(),
          additions: z.number().nonnegative(),
          deletions: z.number().nonnegative(),
          patch: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

/** How a thread ended up linked to a PR. */
export const linkSourceSchema = z.enum(["branch", "agent", "user", "spawn"]);
export type LinkSource = z.infer<typeof linkSourceSchema>;

/** One pull request linked to one thread. `title` and `state` are the last values seen, not live. */
export const threadPullRequestSchema = z
  .object({
    threadId: z.string().min(1),
    repo: repoNameSchema,
    number: itemNumberSchema,
    url: z.string().url(),
    source: linkSourceSchema,
    title: z.string().nullable(),
    state: z.string().nullable(),
    linkedAt: z.string(),
  })
  .strict();
export type ThreadPullRequest = z.infer<typeof threadPullRequestSchema>;

/** The `pullRequests` entry mirrored into thread plugin metadata. */
export const metadataPullRequestSchema = z
  .object({ repo: repoNameSchema, number: itemNumberSchema, url: z.string(), source: linkSourceSchema, title: z.string().nullable() })
  .strict();
export type MetadataPullRequest = z.infer<typeof metadataPullRequestSchema>;

export const PULL_REQUESTS_CHANGED = "pull-requests-changed";

export const githubRpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z
      .object({
        ghOk: z.boolean(),
        ghState: z.enum(["ready", "needs_configuration", "unavailable"]),
        ghError: z.string().nullable(),
        repos: z.array(repoInfoSchema),
        lastSyncedAt: z.string().nullable(),
      })
      .strict(),
  },
  refresh: { input: z.null(), output: syncResultSchema },
  listItems: {
    input: z
      .object({
        kind: z.enum(["issue", "pr"]).optional(),
        repo: repoNameSchema.optional(),
        query: z.string().optional(),
        state: z.enum(["open", "closed"]).optional(),
        mine: z.boolean().optional(),
      })
      .strict(),
    output: z.object({ items: z.array(itemSchema) }).strict(),
  },
  viewer: { input: z.null(), output: z.object({ login: z.string().min(1) }).strict() },
  assignableUsers: { input: z.object({ repo: repoNameSchema }).strict(), output: z.object({ users: z.array(z.string().min(1)) }).strict() },
  repositoryLabels: { input: z.object({ repo: repoNameSchema }).strict(), output: z.object({ labels: z.array(z.string().min(1)) }).strict() },
  setIssueState: { input: itemInputSchema.extend({ state: z.enum(["open", "closed"]) }).strict(), output: okResultSchema },
  setAssignees: {
    input: itemInputSchema.extend({ assignees: z.array(z.string().min(1)) }).strict(),
    output: z.object({ ok: z.literal(true), assignees: z.array(z.string().min(1)) }).strict(),
  },
  setLabels: {
    input: itemInputSchema.extend({ labels: z.array(z.string()) }).strict(),
    output: z.object({ ok: z.literal(true), labels: z.array(z.string().min(1)) }).strict(),
  },
  getIssue: {
    input: itemInputSchema,
    output: z
      .object({
        issue: z
          .object({
            repo: repoNameSchema,
            number: itemNumberSchema,
            title: z.string(),
            state: z.string(),
            author: z.string(),
            body: z.string(),
            labels: z.array(z.string()),
            assignees: z.array(z.string()),
            url: z.string(),
            updatedAt: z.string(),
            comments: z.array(commentSchema),
          })
          .strict(),
      })
      .strict(),
  },
  getPull: { input: itemInputSchema, output: z.object({ pull: pullSchema }).strict() },
  commentPull: { input: itemInputSchema.extend({ body: nonBlankStringSchema }).strict(), output: okResultSchema },
  commentIssue: { input: itemInputSchema.extend({ body: nonBlankStringSchema }).strict(), output: okResultSchema },
  createIssue: {
    input: z.object({ repo: repoNameSchema, title: nonBlankStringSchema, body: z.string().optional() }).strict(),
    output: z.object({ number: itemNumberSchema.nullable(), url: z.string() }).strict(),
  },
  startWork: { input: itemInputSchema, output: z.object({ threadId: z.string().min(1) }).strict() },
  startReview: { input: itemInputSchema, output: z.object({ threadId: z.string().min(1) }).strict() },
  listLinks: { input: z.null(), output: z.object({ links: z.record(z.string(), z.array(threadLinkSchema)) }).strict() },
  listPullRequests: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ links: z.array(threadPullRequestSchema), environmentId: z.string().nullable() }).strict(),
  },
  linkPullRequest: {
    input: z.object({ threadId: z.string().min(1), reference: z.string().min(1).max(500) }).strict(),
    output: z.object({ link: threadPullRequestSchema, created: z.boolean() }).strict(),
  },
  unlinkPullRequest: {
    input: z.object({ threadId: z.string().min(1), repo: repoNameSchema, number: itemNumberSchema }).strict(),
    output: z.object({ ok: z.literal(true), removed: z.boolean() }).strict(),
  },
});
export type GithubRpcContract = typeof githubRpcContract;
