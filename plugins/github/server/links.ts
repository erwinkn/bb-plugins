/**
 * Thread ⇄ pull request links.
 *
 * The plugin SQLite table `thread_pull_requests` is the source of truth. Every
 * change publishes `pull-requests-changed {threadId}` for the app and mirrors
 * the thread's list into its plugin metadata (`pullRequests`) so agents and
 * other plugins can read it through `bb.sdk.threads.getPluginMetadata`.
 *
 * Automatic links come from BB's own branch lookup
 * (`bb.sdk.environments.pullRequest`, the same `gh pr view` the sidebar chip
 * uses): the PR of the thread environment's branch is linked with source
 * `branch` on `thread.idle`, but only for a thread-dedicated worktree whose
 * branch is not the environment's default. Manual links come from the agent
 * tools, the CLI, and the panel (`agent` / `user`), and from "Review with
 * agent" spawns (`spawn`). The `trigger` column records which entrypoint
 * created the link for forensics.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  PULL_REQUESTS_CHANGED,
  threadPullRequestSchema,
  type LinkSource,
  type LinkTrigger,
  type MetadataPullRequest,
  type ThreadPullRequest,
} from "../contract";
import { parsePullRequestUrl, pullRequestUrl, type PullRequestRef } from "../lib/pull-request-url";

/** Appended to the plugin's single ordered migration list in server.ts. */
export const LINK_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS thread_pull_requests (
     thread_id TEXT NOT NULL,
     repo TEXT NOT NULL,
     number INTEGER NOT NULL,
     url TEXT NOT NULL,
     source TEXT NOT NULL,
     title TEXT,
     state TEXT,
     linked_at TEXT NOT NULL,
     PRIMARY KEY (thread_id, repo, number)
   )`,
  `CREATE INDEX IF NOT EXISTS thread_pull_requests_by_pull ON thread_pull_requests (repo, number)`,
  // Which entrypoint created the link (thread-idle, panel-action, …). Rows
  // written before attribution existed keep NULL.
  `ALTER TABLE thread_pull_requests ADD COLUMN trigger TEXT`,
];

/** Thread metadata key holding the mirrored list. */
export const METADATA_KEY = "pullRequests";

export interface LinkInput extends PullRequestRef {
  threadId: string;
  source: LinkSource;
  trigger: LinkTrigger;
  title?: string | null;
  state?: string | null;
}

export interface LinkStoreDeps {
  /** Best-effort title and state lookup for manual links; null when unknown. */
  describePull?: (ref: PullRequestRef) => Promise<{ title: string; state: string } | null>;
  /**
   * Runs after every link change once the metadata mirror settled. The
   * sidebar uses it to refresh its chips: a plugin app cannot subscribe to
   * another plugin's realtime channel, so the bump reaches it through its
   * own RPC. Best effort; errors here are swallowed.
   */
  notifyChanged?: (threadId: string) => void;
}

interface Row {
  thread_id: string;
  repo: string;
  number: number;
  url: string;
  source: string;
  trigger: string | null;
  title: string | null;
  state: string | null;
  linked_at: string;
}

function decode(row: Row): ThreadPullRequest {
  return threadPullRequestSchema.parse({
    threadId: row.thread_id,
    repo: row.repo,
    number: Number(row.number),
    url: row.url,
    source: row.source,
    trigger: row.trigger,
    title: row.title,
    state: row.state,
    linkedAt: row.linked_at,
  });
}

export function toMetadata(link: ThreadPullRequest): MetadataPullRequest {
  return {
    repo: link.repo,
    number: link.number,
    url: link.url,
    source: link.source,
    trigger: link.trigger,
    title: link.title,
    state: link.state,
    linkedAt: link.linkedAt,
  };
}

export function createLinkStore(bb: BbPluginApi, deps: LinkStoreDeps = {}) {
  // server.ts runs the migrations: one ordered list per database.
  const db = bb.storage.database();

  const list = (threadId: string): ThreadPullRequest[] =>
    (db
      .prepare("SELECT * FROM thread_pull_requests WHERE thread_id = ? ORDER BY linked_at DESC, number DESC")
      .all(threadId) as Row[]).map(decode);

  const get = (threadId: string, ref: PullRequestRef): ThreadPullRequest | null => {
    const row = db
      .prepare("SELECT * FROM thread_pull_requests WHERE thread_id = ? AND repo = ? AND number = ?")
      .get(threadId, ref.repo, ref.number) as Row | undefined;
    return row === undefined ? null : decode(row);
  };

  /** Thread ids linked to one PR, oldest link first (the nav panel's ⚡ pills). */
  const threadsFor = (ref: PullRequestRef): Array<{ threadId: string; linkedAt: string }> =>
    (db
      .prepare("SELECT thread_id, linked_at FROM thread_pull_requests WHERE repo = ? AND number = ? ORDER BY linked_at ASC")
      .all(ref.repo, ref.number) as Array<{ thread_id: string; linked_at: string }>).map((row) => ({
      threadId: row.thread_id,
      linkedAt: row.linked_at,
    }));

  const allPullLinks = (): ThreadPullRequest[] =>
    (db.prepare("SELECT * FROM thread_pull_requests ORDER BY linked_at ASC").all() as Row[]).map(decode);

  // One metadata write chain per thread keeps the mirror at the newest state
  // (the plans plugin uses the same shape). Best effort: SQLite already holds
  // the truth, a failed mirror only delays what agents see.
  const chains = new Map<string, Promise<void>>();
  const mirror = (threadId: string): Promise<void> => {
    const next = (chains.get(threadId) ?? Promise.resolve())
      .then(async () => {
        const links = list(threadId).map(toMetadata);
        if (links.length === 0) await bb.sdk.threads.updatePluginMetadata({ threadId, remove: [METADATA_KEY] });
        else await bb.sdk.threads.updatePluginMetadata({ threadId, set: { [METADATA_KEY]: links } });
      })
      .catch((error: unknown) => {
        bb.log.warn(`pull request metadata for thread ${threadId} not updated: ${String(error)}`);
      });
    chains.set(threadId, next);
    void next.then(() => {
      if (chains.get(threadId) === next) chains.delete(threadId);
    });
    return next;
  };
  const changed = (threadId: string) => {
    bb.realtime.publish(PULL_REQUESTS_CHANGED, { threadId });
    void mirror(threadId).then(() => {
      try {
        deps.notifyChanged?.(threadId);
      } catch {
        /* notification is best effort */
      }
    });
  };

  /**
   * Record a link. An existing link keeps its original source and time; its
   * title and state are refreshed when the caller knows newer values.
   */
  const link = (input: LinkInput): { link: ThreadPullRequest; created: boolean } => {
    const ref = { repo: input.repo, number: input.number };
    const existing = get(input.threadId, ref);
    if (existing !== null) {
      const title = input.title ?? existing.title;
      const state = input.state ?? existing.state;
      if (title !== existing.title || state !== existing.state) {
        db.prepare("UPDATE thread_pull_requests SET title = ?, state = ? WHERE thread_id = ? AND repo = ? AND number = ?")
          .run(title, state, input.threadId, ref.repo, ref.number);
        changed(input.threadId);
      }
      return { link: get(input.threadId, ref)!, created: false };
    }
    db.prepare(
      `INSERT INTO thread_pull_requests (thread_id, repo, number, url, source, trigger, title, state, linked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.threadId, ref.repo, ref.number, pullRequestUrl(ref), input.source, input.trigger,
      input.title ?? null, input.state ?? null, new Date().toISOString(),
    );
    changed(input.threadId);
    bb.log.info(`linked ${ref.repo}#${ref.number} to thread ${input.threadId} (${input.source} via ${input.trigger})`);
    return { link: get(input.threadId, ref)!, created: true };
  };

  /** Manual link: fills in title and state when the lookup succeeds. */
  const linkDescribed = async (input: LinkInput): Promise<{ link: ThreadPullRequest; created: boolean }> => {
    let described: { title: string; state: string } | null = null;
    if (deps.describePull !== undefined && input.title === undefined) {
      try {
        described = await deps.describePull({ repo: input.repo, number: input.number });
      } catch (error) {
        bb.log.warn(`could not describe ${input.repo}#${input.number}: ${String(error)}`);
      }
    }
    return link({ ...input, ...(described ?? {}) });
  };

  const unlink = (threadId: string, ref: PullRequestRef): boolean => {
    const result = db
      .prepare("DELETE FROM thread_pull_requests WHERE thread_id = ? AND repo = ? AND number = ?")
      .run(threadId, ref.repo, ref.number);
    if (result.changes === 0) return false;
    changed(threadId);
    return true;
  };

  const removeThread = (threadId: string): void => {
    const result = db.prepare("DELETE FROM thread_pull_requests WHERE thread_id = ?").run(threadId);
    if (result.changes > 0) bb.realtime.publish(PULL_REQUESTS_CHANGED, { threadId });
  };

  /**
   * Ask BB core for the PR of the thread's branch and link it with source
   * `branch`. Only ever called from `thread.idle` and the panel's explicit
   * "Link current branch PR" action — never from list paths, which must stay
   * side-effect free.
   *
   * Automatic linking (`thread-idle`) requires a thread-dedicated worktree:
   * a shared `project-checkout` environment has a branch that moves
   * independently of the threads on it, so its PR must not be attributed to
   * them. The branch must also be non-empty and differ from the
   * environment's default branch, and the returned PR's head must be the
   * branch. An explicit `panel-action` skips the worktree and default-branch
   * checks — the user asked — but still requires the head match.
   *
   * Silent on lookup failures: `unavailable` (no gh, non-GitHub remote) and
   * `absent` are normal outcomes, not errors.
   */
  const refreshBranchLink = async (
    threadId: string,
    trigger: "thread-idle" | "panel-action",
  ): Promise<{ environmentId: string | null; link: ThreadPullRequest | null }> => {
    let environmentId: string | null = null;
    const skip = (reason: string) => {
      bb.log.debug(`branch pull request link skipped for thread ${threadId} (${trigger}): ${reason}`);
      return { environmentId, link: null };
    };
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.deletedAt || !thread.environmentId) return { environmentId: null, link: null };
      environmentId = thread.environmentId;
      const environment = await bb.sdk.environments.get({ environmentId });
      const branchName = environment.branchName ?? "";
      if (branchName === "") return skip("the environment has no branch");
      if (trigger === "thread-idle") {
        if (environment.isWorktree === false) {
          return skip(`environment ${environmentId} is a shared checkout, not a thread-owned worktree`);
        }
        if (environment.defaultBranch !== null && branchName === environment.defaultBranch) {
          return skip(`branch ${branchName} is the environment's default branch`);
        }
      }
      const result = await bb.sdk.environments.pullRequest({ environmentId });
      if (result.outcome !== "available") return { environmentId, link: null };
      const head = result.pullRequest.headRefName;
      if (head !== branchName) {
        return skip(`pull request head ${head === "" ? "?" : head} does not match branch ${branchName}`);
      }
      const ref = parsePullRequestUrl(result.pullRequest.url);
      if (ref === null) return { environmentId, link: null };
      return {
        environmentId,
        link: link({
          threadId,
          ...ref,
          source: "branch",
          trigger,
          title: result.pullRequest.title,
          state: result.pullRequest.state,
        }).link,
      };
    } catch (error) {
      bb.log.debug(`branch pull request lookup for thread ${threadId} failed: ${String(error)}`);
      return { environmentId, link: null };
    }
  };

  const settled = () => Promise.all(chains.values()).then(() => undefined);

  return { list, get, threadsFor, allPullLinks, link, linkDescribed, unlink, removeThread, refreshBranchLink, mirror, settled };
}
export type LinkStore = ReturnType<typeof createLinkStore>;
