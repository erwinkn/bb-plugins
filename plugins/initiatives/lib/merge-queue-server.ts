import { execFile } from "node:child_process";
import {
  GH_PR_FIELDS,
  assignStages,
  attachWorkers,
  githubRepo,
  orderQueue,
  parsePullRequests,
  type MergeQueue,
  type QueuedPullRequest,
} from "./merge-queue";
import { PR_STAGES, type PrStageRecord } from "./pr-stages";

/** Runs `gh` with these arguments and resolves its stdout. */
export type GhRunner = (args: string[]) => Promise<string>;

/** A repository is re-read when its last attempt is older than this. */
export const REFRESH_MS = 2 * 60_000;
/** A manual refresh within this long of the last attempt reuses it. */
export const MIN_FORCED_REFRESH_MS = 10_000;
/** A project's remote is looked up again after this long. */
const REMOTE_TTL_MS = 5 * 60_000;
/** Below the dashboard's 30 s read timeout, so a hung `gh` reads as a failure. */
const GH_TIMEOUT_MS = 20_000;
/** Open PRs read per repository. */
const PR_LIMIT = 50;

/** Spawns `gh` asynchronously: the event loop never waits on it. */
export const runGh: GhRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile(
      "gh",
      args,
      {
        timeout: GH_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
      },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        reject(
          new Error(
            missing
              ? "the GitHub CLI (gh) is not installed on the BB server"
              : (stderr.trim().split("\n").pop() ?? "") || error.message,
          ),
        );
      },
    );
  });

interface RepoEntry {
  pullRequests: QueuedPullRequest[] | null;
  fetchedAt: number | null;
  error: string | null;
  attemptedAt: number;
  pending: Promise<void> | null;
}

export interface MergeQueueSources {
  /** The Initiative's member BB projects, primary first. */
  memberProjectIds(projectId: string): string[];
  /** A BB project's name and git remote. */
  project(bbProjectId: string): Promise<{ name: string; gitRemoteUrl: string | null }>;
  /** BB thread id → W# of the Initiative's workers. */
  workers(projectId: string): Map<string, string>;
  /** The coordinator's recorded stages by canonical PR URL. */
  prStages(projectId: string): ReadonlyMap<string, PrStageRecord>;
}

/**
 * Server-side cache of each repository's open PRs by the `gh` user. Reads
 * share it across Initiatives and clients; a repository is fetched when its
 * last attempt is two minutes old or on a manual refresh, with one `gh pr
 * list` per repository and at most one in flight. A failed fetch keeps the
 * last good list and reports the error beside it.
 */
export class MergeQueueCache {
  private login: Promise<string> | null = null;
  private repos = new Map<string, RepoEntry>();
  private remotes = new Map<string, { at: number; value: Promise<{ name: string; repo: string | null }> }>();

  constructor(
    private sources: MergeQueueSources,
    private gh: GhRunner = runGh,
    private now: () => number = Date.now,
  ) {}

  async read(projectId: string, options: { refresh?: boolean } = {}): Promise<MergeQueue> {
    const members = await Promise.all(this.sources.memberProjectIds(projectId).map((id) => this.remote(id)));
    // GitHub names are case-insensitive: key, cache and rate-limit by lower case,
    // and show the first member remote's own casing.
    const display = new Map<string, string>();
    for (const m of members) if (m.repo && !display.has(m.repo.toLowerCase())) display.set(m.repo.toLowerCase(), m.repo);
    const repos = [...display.keys()];
    const skipped = members.filter((m) => !m.repo).map((m) => ({ project: m.name, reason: "no GitHub origin remote" }));
    await Promise.all(repos.map((repo) => this.refresh(repo, display.get(repo)!, options.refresh === true)));
    const login = await this.login?.catch(() => null) ?? null;
    const workers = this.sources.workers(projectId);
    const pullRequests = assignStages(
      attachWorkers(repos.flatMap((repo) => this.repos.get(repo)!.pullRequests ?? []), workers),
      this.sources.prStages(projectId),
    );
    const stages = PR_STAGES.map((stage) => ({ ...stage }));
    return {
      projectId,
      login,
      repos: repos.map((repo) => {
        const entry = this.repos.get(repo)!;
        return { repo: display.get(repo)!, fetchedAt: entry.fetchedAt, error: entry.error };
      }),
      skipped,
      stages,
      pullRequests: orderQueue(pullRequests, stages),
    };
  }

  private remote(bbProjectId: string) {
    const cached = this.remotes.get(bbProjectId);
    if (cached && this.now() - cached.at < REMOTE_TTL_MS) return cached.value;
    const value = this.sources.project(bbProjectId).then(
      (p) => ({ name: p.name, repo: githubRepo(p.gitRemoteUrl) }),
      () => {
        // Look again on the next read rather than caching the failure.
        this.remotes.delete(bbProjectId);
        return { name: bbProjectId, repo: null };
      },
    );
    this.remotes.set(bbProjectId, { at: this.now(), value });
    return value;
  }

  /** The `gh` account, resolved once; a failure is retried by the next fetch. */
  private user(): Promise<string> {
    if (this.login) return this.login;
    const login = this.gh(["api", "user", "--jq", ".login"]).then((out) => {
      const name = out.trim();
      if (!/^[\w-]+$/.test(name)) throw new Error("gh api user returned no login");
      return name;
    });
    login.catch(() => {
      if (this.login === login) this.login = null;
    });
    this.login = login;
    return login;
  }

  /** `repo` is the lower-case key; `name` the casing to request and show. */
  private refresh(repo: string, name: string, force: boolean): Promise<void> {
    let entry = this.repos.get(repo);
    if (!entry) {
      entry = { pullRequests: null, fetchedAt: null, error: null, attemptedAt: -Infinity, pending: null };
      this.repos.set(repo, entry);
    }
    if (entry.pending) return entry.pending;
    const age = this.now() - entry.attemptedAt;
    if (age < (force ? MIN_FORCED_REFRESH_MS : REFRESH_MS)) return Promise.resolve();
    const target = entry;
    target.attemptedAt = this.now();
    const pending = (async () => {
      try {
        const login = await this.user();
        const out = await this.gh([
          "pr", "list", "--repo", name, "--author", login, "--state", "open",
          "--limit", String(PR_LIMIT), "--json", GH_PR_FIELDS,
        ]);
        target.pullRequests = parsePullRequests(name, out);
        target.fetchedAt = this.now();
        target.error = null;
      } catch (error) {
        target.error = error instanceof Error ? error.message : String(error);
      } finally {
        target.pending = null;
      }
    })();
    target.pending = pending;
    return pending;
  }
}
