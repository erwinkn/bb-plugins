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
 * branch is not the environment's default. The lookup's outcome is cached
 * per environment for 60 s so bursts of idle events do not repeat it; the
 * panel's explicit "Link current branch PR" action bypasses the cache.
 * Manual links come from the agent tools, the CLI, and the panel
 * (`agent` / `user`), and from "Review with agent" spawns (`spawn`). The
 * `trigger` column records which entrypoint created the link for forensics.
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

  /**
   * Short-TTL cache for the branch link lookup. `decisions` holds what an
   * environment's branch lookup concluded, keyed by environment id so sibling
   * threads on one checkout share a single `environments.pullRequest` call;
   * `threadEnvironments` memoizes the thread → environment resolution so a
   * repeat `thread.idle` needs no SDK call at all. Entries live for
   * BRANCH_LINK_TTL_MS, `panel-action` always bypasses the cache (it is the
   * user's explicit "check now", so a just-opened PR links immediately), and
   * `removeThread` drops a thread's memo so a deleted thread cannot replay a
   * stale link.
   */
  const BRANCH_LINK_TTL_MS = 60_000;
  type BranchLinkTrigger = "thread-idle" | "panel-action";
  /**
   * What one branch lookup concluded. `linked` replays as a local `link()`
   * call for the asking thread; `unlinked` covers every negative outcome —
   * `reason` is the diagnostic for the ones worth logging (guard skips and
   * lookup failures), null for the quiet ones (no PR, lookup unavailable,
   * unparseable URL).
   */
  type BranchLinkDecision =
    | { kind: "linked"; ref: PullRequestRef; title: string | null; state: string | null }
    | { kind: "unlinked"; reason: string | null };
  const decisions = new Map<string, { trigger: BranchLinkTrigger; decision: BranchLinkDecision; expiresAt: number }>();
  const threadEnvironments = new Map<string, { environmentId: string; expiresAt: number }>();
  /** Last seen outcome per scope (`env:<id>` / `thread:<id>`); repeats stay quiet. */
  const loggedOutcomes = new Map<string, string>();

  const logOnce = (scope: string, outcome: string, message: string): void => {
    if (loggedOutcomes.get(scope) === outcome) return;
    loggedOutcomes.set(scope, outcome);
    bb.log.debug(message);
  };

  /** Entries expire lazily on read; sweep only when a map grows past churn scale. */
  const pruneExpired = <T extends { expiresAt: number }>(map: Map<string, T>): void => {
    const now = Date.now();
    for (const [key, entry] of map) if (entry.expiresAt <= now) map.delete(key);
  };

  const removeThread = (threadId: string): void => {
    threadEnvironments.delete(threadId);
    const result = db.prepare("DELETE FROM thread_pull_requests WHERE thread_id = ?").run(threadId);
    if (result.changes > 0) bb.realtime.publish(PULL_REQUESTS_CHANGED, { threadId });
  };

  /** Apply a cached or freshly-made decision: local writes only, no SDK calls. */
  const applyDecision = (
    threadId: string,
    environmentId: string,
    decision: BranchLinkDecision,
    trigger: BranchLinkTrigger,
  ): { environmentId: string; link: ThreadPullRequest | null } => {
    if (decision.kind !== "linked") return { environmentId, link: null };
    return {
      environmentId,
      link: link({ threadId, ...decision.ref, source: "branch", trigger, title: decision.title, state: decision.state }).link,
    };
  };

  /**
   * Run the real lookups (`environments.get`, then `environments.pullRequest`)
   * and record the outcome as the environment's cached decision. Skip reasons
   * log once per environment until the decision changes instead of once per
   * idle event.
   */
  const lookupBranchLink = async (
    threadId: string,
    environmentId: string,
    trigger: BranchLinkTrigger,
  ): Promise<{ environmentId: string; link: ThreadPullRequest | null }> => {
    const decide = (decision: BranchLinkDecision) => {
      decisions.set(environmentId, { trigger, decision, expiresAt: Date.now() + BRANCH_LINK_TTL_MS });
      const scope = `env:${environmentId}`;
      const outcome = decision.kind === "linked" ? `linked:${decision.ref.repo}#${decision.ref.number}` : `unlinked:${decision.reason ?? "none"}`;
      // One debug line per decision change, not per idle: quiet outcomes
      // (absent/unavailable) update the seen outcome without logging.
      if (loggedOutcomes.get(scope) !== outcome) {
        loggedOutcomes.set(scope, outcome);
        if (decision.kind === "unlinked" && decision.reason !== null) {
          bb.log.debug(`branch pull request link skipped for thread ${threadId} (${trigger}): ${decision.reason}`);
        }
      }
      return applyDecision(threadId, environmentId, decision, trigger);
    };
    try {
      const environment = await bb.sdk.environments.get({ environmentId });
      const branchName = environment.branchName ?? "";
      if (branchName === "") return decide({ kind: "unlinked", reason: "the environment has no branch" });
      if (trigger === "thread-idle") {
        if (environment.isWorktree === false) {
          return decide({ kind: "unlinked", reason: `environment ${environmentId} is a shared checkout, not a thread-owned worktree` });
        }
        if (environment.defaultBranch !== null && branchName === environment.defaultBranch) {
          return decide({ kind: "unlinked", reason: `branch ${branchName} is the environment's default branch` });
        }
      }
      const result = await bb.sdk.environments.pullRequest({ environmentId });
      if (result.outcome !== "available") return decide({ kind: "unlinked", reason: null });
      const head = result.pullRequest.headRefName;
      if (head !== branchName) {
        return decide({ kind: "unlinked", reason: `pull request head ${head === "" ? "?" : head} does not match branch ${branchName}` });
      }
      const ref = parsePullRequestUrl(result.pullRequest.url);
      if (ref === null) return decide({ kind: "unlinked", reason: null });
      return decide({ kind: "linked", ref, title: result.pullRequest.title, state: result.pullRequest.state });
    } catch (error) {
      return decide({ kind: "unlinked", reason: `the lookup failed: ${String(error)}` });
    }
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
   * `thread-idle` replays the environment's cached decision while it is
   * fresh; `panel-action` never reads the cache. A `linked` replay still runs
   * `link()` for the asking thread, so attribution to sibling threads on the
   * same environment matches the uncached behavior.
   *
   * Silent on lookup failures: `unavailable` (no gh, non-GitHub remote) and
   * `absent` are normal outcomes, not errors.
   */
  const refreshBranchLink = async (
    threadId: string,
    trigger: "thread-idle" | "panel-action",
  ): Promise<{ environmentId: string | null; link: ThreadPullRequest | null }> => {
    if (threadEnvironments.size > 256) pruneExpired(threadEnvironments);
    if (decisions.size > 256) pruneExpired(decisions);
    const now = Date.now();
    let environmentId: string | null = null;
    if (trigger === "thread-idle") {
      const memo = threadEnvironments.get(threadId);
      if (memo !== undefined && memo.expiresAt > now) environmentId = memo.environmentId;
    }
    if (environmentId === null) {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.deletedAt || !thread.environmentId) return { environmentId: null, link: null };
        environmentId = thread.environmentId;
        threadEnvironments.set(threadId, { environmentId, expiresAt: now + BRANCH_LINK_TTL_MS });
      } catch (error) {
        logOnce(`thread:${threadId}`, `error:${String(error)}`, `branch pull request lookup for thread ${threadId} failed: ${String(error)}`);
        return { environmentId: null, link: null };
      }
    }
    if (trigger === "thread-idle") {
      const cached = decisions.get(environmentId);
      // A `panel-action` entry is never replayed for thread-idle: the explicit
      // action skips the worktree and default-branch guards, so its outcome is
      // not a decision thread-idle would have made — it just expires the slot.
      if (cached !== undefined && cached.trigger === "thread-idle" && cached.expiresAt > now) {
        return applyDecision(threadId, environmentId, cached.decision, trigger);
      }
    }
    return lookupBranchLink(threadId, environmentId, trigger);
  };

  const settled = () => Promise.all(chains.values()).then(() => undefined);

  return { list, get, threadsFor, allPullLinks, link, linkDescribed, unlink, removeThread, refreshBranchLink, mirror, settled };
}
export type LinkStore = ReturnType<typeof createLinkStore>;
