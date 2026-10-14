import { execFile } from "node:child_process";
import {
  DETAILS_PAGE,
  GH_DETAILS_QUERY,
  GH_PR_FIELDS,
  attachDetails,
  attachLinks,
  attachNotes,
  detailsSearch,
  parseDetailsPage,
  assignStages,
  attachWorkers,
  githubRepo,
  orderQueue,
  parsePullRequests,
  type MergeQueue,
  type PrDetails,
  type QueuedPullRequest,
} from "./merge-queue";
import { PR_STAGES, canonicalPrUrl, type PrRecord } from "./pr-stages";
import type { PrNotesSummary } from "./pr-notes";
import type { PrWork } from "./pr-records";
import { linkStacks } from "./pr-map";

/** Runs `gh` with these arguments and resolves its stdout, failing after `timeoutMs` (default GH_TIMEOUT_MS). */
export type GhRunner = (args: string[], timeoutMs?: number) => Promise<string>;

/** A repository is re-read when its last attempt is older than this. */
export const REFRESH_MS = 2 * 60_000;
/** A manual refresh within this long of the last attempt reuses it. */
export const MIN_FORCED_REFRESH_MS = 10_000;
/** A project's remote is looked up again after this long. */
const REMOTE_TTL_MS = 5 * 60_000;
/** Each `gh` call's bound; a hung one reads as a failed fetch. Reads never wait for it. */
const GH_TIMEOUT_MS = 20_000;
/** Open PRs read per repository: Equisafe alone had 93 open in October 2026. */
const PR_LIMIT = 200;

/** Spawns `gh` asynchronously: the event loop never waits on it. */
export const runGh: GhRunner = (args, timeoutMs = GH_TIMEOUT_MS) =>
  new Promise((resolve, reject) => {
    execFile(
      "gh",
      args,
      {
        timeout: timeoutMs,
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
  /** The casing to request and show. */
  name: string;
  pullRequests: QueuedPullRequest[] | null;
  fetchedAt: number | null;
  error: string | null;
  /** The last details that loaded (a failed details query keeps them), and their own freshness. */
  details: { data: PrDetails | null; fetchedAt: number | null; error: string | null };
  attemptedAt: number;
  /** The running fetch: list and details both, released only once both settle. */
  pending: Promise<void> | null;
}

interface Remote {
  name: string;
  repo: string | null;
}

export interface MergeQueueSources {
  /** The Initiative's member BB projects, primary first. */
  memberProjectIds(projectId: string): string[];
  /** A BB project's name and git remote. */
  project(bbProjectId: string): Promise<{ name: string; gitRemoteUrl: string | null }>;
  /** BB thread id → W# of the Initiative's workers. */
  workers(projectId: string): Map<string, string>;
  /** The coordinator's PR records by canonical PR URL. */
  prRecords(projectId: string): ReadonlyMap<string, PrRecord>;
  /** Each PR's latest assignment, by canonical PR URL (see AssignedPrs). */
  assignedPrs(projectId: string): ReadonlyMap<string, PrWork>;
  /** Each PR's notes summary (D442), by canonical PR URL. */
  notes(projectId: string): ReadonlyMap<string, PrNotesSummary>;
  /** v9 (§7): PR states for computed task status. Every open-list fetch marks what it lists open. */
  prStates?: {
    markOpen(urls: string[], at: number): void;
    /** Tracked PRs to look up after a fetch: not listed, not MERGED, not checked in the last hour. */
    toLookUp(listed: ReadonlySet<string>, at: number, limit: number): string[];
    save(url: string, at: number, result: { state: "OPEN" | "MERGED" | "CLOSED"; mergedAt: number | null; closedAt: number | null } | { error: string }): void;
  };
}

/** The lookup pass after each open-list fetch: at most this many PRs, this many at a time. */
const LOOKUP_LIMIT = 10;
const LOOKUP_PARALLEL = 2;

/**
 * Server-side cache of each repository's open PRs by the `gh` user, shared
 * across Initiatives and clients. A read never waits on GitHub (D441): it
 * answers from the cache at once and, when a repository's last attempt is two
 * minutes old or on a manual refresh, starts a fetch behind it: one `gh pr
 * list` and the paged details query beside it, at most one fetch per
 * repository in flight. `fetched` hears when one ends, so clients read again.
 * A failed fetch keeps the last good data and reports the error beside it.
 */
export class MergeQueueCache {
  private login: Promise<string> | null = null;
  /** The account once resolved, for reads that never wait on the lookup. */
  private loginName: string | null = null;
  private repos = new Map<string, RepoEntry>();
  private remotes = new Map<string, { at: number; value: Promise<Remote>; last: Remote | null }>();
  /** The running PR-state lookup pass, one at a time. */
  private lookups: Promise<void> | null = null;

  constructor(
    private sources: MergeQueueSources,
    private gh: GhRunner = runGh,
    private now: () => number = Date.now,
    private fetched: (repo: string) => void = () => {},
  ) {}

  async read(projectId: string, options: { refresh?: boolean } = {}): Promise<MergeQueue> {
    const members = await Promise.all(this.sources.memberProjectIds(projectId).map((id) => this.remote(id)));
    // GitHub names are case-insensitive: key, cache and rate-limit by lower case,
    // and show the first member remote's own casing.
    const display = new Map<string, string>();
    for (const m of members) if (m.repo && !display.has(m.repo.toLowerCase())) display.set(m.repo.toLowerCase(), m.repo);
    const repos = [...display.keys()];
    const skipped = members.filter((m) => !m.repo).map((m) => ({ project: m.name, reason: "no GitHub origin remote" }));
    for (const repo of repos) this.refresh(repo, display.get(repo)!, options.refresh === true);
    const workers = this.sources.workers(projectId);
    const records = this.sources.prRecords(projectId);
    const assigned = this.sources.assignedPrs(projectId);
    const pullRequests = linkStacks(attachLinks(attachNotes(attachWorkers(
      assignStages(repos.flatMap((repo) => {
        const entry = this.repos.get(repo)!;
        return attachDetails(entry.pullRequests ?? [], entry.details.data, { reviewers: entry.details.error === null });
      }), records),
      workers,
      assigned,
    ), this.sources.notes(projectId)), assigned, records));
    const stages = PR_STAGES.map((stage) => ({ ...stage }));
    return {
      projectId,
      login: this.loginName,
      repos: repos.map((repo) => {
        const entry = this.repos.get(repo)!;
        return {
          repo: display.get(repo)!, fetchedAt: entry.fetchedAt, error: entry.error, fetching: entry.pending !== null,
          detailsFetchedAt: entry.details.fetchedAt, detailsError: entry.details.error,
        };
      }),
      skipped,
      stages,
      pullRequests: orderQueue(pullRequests, stages),
    };
  }

  /** Resolves once no fetch is running (tests and shutdown; reads never wait). */
  async settled(): Promise<void> {
    for (let pending = this.running(); pending.length; pending = this.running()) await Promise.allSettled(pending);
  }
  private running() {
    return [...this.repos.values()].flatMap((entry) => (entry.pending ? [entry.pending] : []));
  }

  /** The cached open PR at this URL, if any; never fetches. */
  cachedPr(url: string): QueuedPullRequest | null {
    const key = canonicalPrUrl(url);
    for (const entry of this.repos.values())
      for (const pr of entry.pullRequests ?? []) if (canonicalPrUrl(pr.url) === key) return pr;
    return null;
  }

  /**
   * A member's name and repository; after REMOTE_TTL_MS every read gets the last
   * answer while one lookup asks BB again. Only a member's first read waits on BB.
   */
  private remote(bbProjectId: string): Promise<Remote> {
    const cached = this.remotes.get(bbProjectId);
    if (cached && this.now() - cached.at < REMOTE_TTL_MS) return cached.last ? Promise.resolve(cached.last) : cached.value;
    const entry = { at: this.now(), value: null as unknown as Promise<Remote>, last: cached?.last ?? null };
    entry.value = this.sources.project(bbProjectId).then(
      (p) => (entry.last = { name: p.name, repo: githubRepo(p.gitRemoteUrl) }),
      () => {
        // Look again on the next read rather than caching the failure.
        if (this.remotes.get(bbProjectId) === entry) this.remotes.delete(bbProjectId);
        return entry.last ?? { name: bbProjectId, repo: null };
      },
    );
    this.remotes.set(bbProjectId, entry);
    return entry.last ? Promise.resolve(entry.last) : entry.value;
  }

  /** The `gh` account, resolved once; a failure is retried by the next fetch. */
  private user(): Promise<string> {
    if (this.login) return this.login;
    const login = this.gh(["api", "user", "--jq", ".login"]).then((out) => {
      const name = out.trim();
      if (!/^[\w-]+$/.test(name)) throw new Error("gh api user returned no login");
      return (this.loginName = name);
    });
    login.catch(() => {
      if (this.login === login) this.login = null;
    });
    this.login = login;
    return login;
  }

  /** Starts a fetch of `repo` (the lower-case key) when it is due; never waits for it. */
  private refresh(repo: string, name: string, force: boolean): void {
    let entry = this.repos.get(repo);
    if (!entry) {
      entry = { name, pullRequests: null, fetchedAt: null, error: null, details: { data: null, fetchedAt: null, error: null }, attemptedAt: -Infinity, pending: null };
      this.repos.set(repo, entry);
    }
    if (entry.pending) return;
    const age = this.now() - entry.attemptedAt;
    if (age < (force ? MIN_FORCED_REFRESH_MS : REFRESH_MS)) return;
    const target = entry;
    target.attemptedAt = this.now();
    target.pending = this.fetch(target).finally(() => {
      target.pending = null;
      try {
        this.fetched(repo);
      } catch {
        // The announcement is a hint (the plugin may be stopping); the next poll reads anyway.
      }
    });
  }

  private async fetch(target: RepoEntry): Promise<void> {
    const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
    let login: string;
    try {
      login = await this.user();
    } catch (error) {
      target.error = target.details.error = message(error);
      return;
    }
    // Both settle before the guard is released, so a failed list never lets a second
    // details query start beside the first. The details are extra: their failure keeps
    // the last sizes (reviewers are withheld) and never fails the list.
    const [list, details] = await Promise.allSettled([
      this.gh([
        "pr", "list", "--repo", target.name, "--author", login, "--state", "open",
        "--limit", String(PR_LIMIT), "--json", GH_PR_FIELDS,
      ]).then((out) => parsePullRequests(target.name, out)),
      this.details(target.name, login),
    ]);
    if (list.status === "fulfilled") {
      target.pullRequests = list.value;
      target.fetchedAt = this.now();
      target.error = null;
      try {
        this.sources.prStates?.markOpen(list.value.flatMap((pr) => canonicalPrUrl(pr.url) ?? []), this.now());
      } catch { /* the states are a cache; the next fetch writes them again */ }
      this.lookUp();
    } else target.error = message(list.reason);
    if (details.status === "fulfilled") target.details = { data: details.value, fetchedAt: this.now(), error: null };
    else target.details = { ...target.details, error: message(details.reason) };
  }

  /**
   * v9 (§7): after a fetch, looks up the state of tracked PRs the open lists don't name (merged,
   * closed, or someone else's), oldest check first, LOOKUP_PARALLEL at a time. Every lookup stamps
   * its check time, so no PR hogs the pass; reads never wait for it.
   */
  private lookUp(): void {
    const states = this.sources.prStates;
    if (!states || this.lookups) return;
    const listed = new Set([...this.repos.values()].flatMap((entry) => (entry.pullRequests ?? []).flatMap((pr) => canonicalPrUrl(pr.url) ?? [])));
    let urls: string[];
    try {
      urls = states.toLookUp(listed, this.now(), LOOKUP_LIMIT);
    } catch {
      return;
    }
    if (!urls.length) return;
    const one = async (url: string) => {
      try {
        const out = JSON.parse(await this.gh(["pr", "view", url, "--json", "state,mergedAt,closedAt"])) as { state?: string; mergedAt?: string | null; closedAt?: string | null };
        const state = out.state === "MERGED" || out.state === "CLOSED" || out.state === "OPEN" ? out.state : null;
        if (!state) throw new Error(`unexpected state ${String(out.state)}`);
        states.save(url, this.now(), { state, mergedAt: out.mergedAt ? Date.parse(out.mergedAt) : null, closedAt: out.closedAt ? Date.parse(out.closedAt) : null });
      } catch (error) {
        try { states.save(url, this.now(), { error: error instanceof Error ? error.message : String(error) }); } catch { /* a cache */ }
      }
    };
    this.lookups = (async () => {
      for (let i = 0; i < urls.length; i += LOOKUP_PARALLEL) await Promise.all(urls.slice(i, i + LOOKUP_PARALLEL).map(one));
    })().finally(() => {
      this.lookups = null;
    });
  }

  /** Resolves once no PR-state lookup is running (tests). */
  async lookupsSettled(): Promise<void> {
    await this.lookups;
  }

  /**
   * The details query, page by page, never past the list's PR_LIMIT nor GH_TIMEOUT_MS in all:
   * each page gets only the time left, and none starts once it is spent.
   */
  private async details(name: string, login: string): Promise<PrDetails> {
    const all: PrDetails = new Map();
    const deadline = this.now() + GH_TIMEOUT_MS;
    let cursor: string | null = null;
    for (let page = 0; page < Math.ceil(PR_LIMIT / DETAILS_PAGE); page++) {
      const left = deadline - this.now();
      if (left <= 0) break;
      const out = await this.gh([
        "api", "graphql", "-f", `query=${GH_DETAILS_QUERY}`, "-f", `q=${detailsSearch(name, login)}`,
        ...(cursor ? ["-f", `endCursor=${cursor}`] : []),
      ], left);
      const { details, next } = parseDetailsPage(out);
      for (const [number, d] of details) all.set(number, d);
      if (!next) break;
      cursor = next;
    }
    return all;
  }
}
