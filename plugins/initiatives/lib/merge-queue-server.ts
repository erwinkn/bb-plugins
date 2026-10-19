import { execFile, type ChildProcess } from "node:child_process";
import {
  DETAILS_PAGE,
  GH_DETAILS_QUERY,
  GH_LIST_QUERY,
  attachDetails,
  attachLinks,
  attachNotes,
  assignStages,
  attachWorkers,
  githubRepo,
  orderQueue,
  parseDetail,
  parseDetailsNodes,
  parsePrLookup,
  parsePullRequests,
  parseSearchPage,
  prLookupQuery,
  prRepoKey,
  prSearch,
  type MergeQueue,
  type PrSize,
  type QueuedPullRequest,
  type Reviewer,
  type SearchPage,
} from "./merge-queue";
import { githubGraphQl, type GraphQl } from "./github-api";
import { PR_STAGES, canonicalPrUrl, type PrRecord } from "./pr-stages";
import type { PrNotesSummary } from "./pr-notes";
import type { PrWork } from "./pr-records";
import type { PrOwner } from "./pr-owners";
import { linkStacks } from "./pr-map";

/** Runs `gh` with these arguments and resolves its stdout, failing after `timeoutMs` (default GH_TIMEOUT_MS). */
export type GhRunner = (args: string[], timeoutMs?: number) => Promise<string>;
export type { GraphQl } from "./github-api";

/** A repository a dashboard shows is re-read when its last attempt is older than this. */
export const REFRESH_MS = 2 * 60_000;
/** W516: one only agents read (initiative_read and the like) waits this long. */
export const IDLE_REFRESH_MS = 10 * 60_000;
/** W516: a dashboard read this recent counts as one showing the repository (open dashboards poll every 15 s). */
export const VIEWER_MS = 60_000;
/** W516: every PR's details are read again this often, beside those whose `updatedAt` moved. */
export const DETAILS_RESYNC_MS = 30 * 60_000;
/**
 * W520: details requests in flight at once, across every repository and fetch. GitHub's secondary
 * limits allow 100 concurrent requests and 60 s of GraphQL CPU time a minute; a 50-PR request
 * takes 3–6 s, so 4 at a time keeps a cold read of Equisafe's 227 PRs (5 requests, about 20 s of
 * GitHub time) well inside both while the agents' own `gh` calls share them.
 */
export const DETAILS_CONCURRENCY = 4;
/** W520: a PR whose details fail in a request of its own is asked alone again after this, doubling with each failure up to DETAILS_RESYNC_MS. */
export const DETAILS_RETRY_MS = 2 * 60_000;
/** W516: the repositories one search covers at most. */
export const REPOS_PER_SEARCH = 10;
/** A manual refresh within this long of the last attempt reuses it. */
export const MIN_FORCED_REFRESH_MS = 10_000;
/** A project's remote is looked up again after this long. */
export const REMOTE_TTL_MS = 5 * 60_000;
/** Each GitHub request's bound (and `gh auth token`'s); a hung one reads as a failed page. Reads never wait for it. */
export const GH_TIMEOUT_MS = 20_000;
/** All of one search's pages, retries included; reads never wait for them (D441). */
export const FETCH_BUDGET_MS = 60_000;
/**
 * Open PRs read per search: all GitHub's search returns. The user had 209 open in Equisafe
 * in October 2026, past the earlier cap of 200 (W490); a list cut short says so (`capped`).
 * W516: one search spans up to REPOS_PER_SEARCH repositories, which share the 1000.
 */
export const PR_LIMIT = 1000;

/**
 * Spawns `gh` asynchronously: the event loop never waits on it. W516: only `gh auth token` runs,
 * once per server life and after a 401. The bound is our own timer, not
 * execFile's `timeout`: that one destroys stdout before it signals, so a gh that exited 0 while
 * the event loop was busy resolved with its output unread, empty or cut off (W490). Here a gh
 * that exited before the timer still hands over all it wrote.
 */
export const runGh: GhRunner = (args, timeoutMs = GH_TIMEOUT_MS) =>
  new Promise((resolve, reject) => {
    const command = `gh ${args.slice(0, 2).join(" ")}`;
    let child: ChildProcess | undefined;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child?.kill();
    }, timeoutMs);
    child = execFile(
      "gh",
      args,
      {
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
      },
      (error, stdout, stderr) => {
        clearTimeout(timer);
        if (!error) return resolve(stdout);
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        const code = (error as { code?: unknown }).code;
        reject(
          new Error(
            missing
              ? "the GitHub CLI (gh) is not installed on the BB server"
              : timedOut
                ? `${command} timed out after ${Math.ceil(timeoutMs / 1000)} s`
                : (stderr.trim().split("\n").pop() ?? "") || (typeof code === "number" ? `${command} exited with code ${code}` : error.message),
          ),
        );
      },
    );
  });

interface RepoEntry {
  /** The lower-case key. */
  key: string;
  /** The casing to request and show. */
  name: string;
  pullRequests: QueuedPullRequest[] | null;
  fetchedAt: number | null;
  error: string | null;
  /**
   * The last search stopped short of every open PR (PR_LIMIT); null once one doesn't. A search
   * covers several repositories: the counts are the whole search's.
   */
  capped: { listed: number; total: number; search: string[] } | null;
  /** W520: each listed PR's details, by number; a PR that leaves the list drops its own. */
  details: Map<number, PrDetail>;
  /** When a details request for this repository last succeeded. */
  detailsFetchedAt: number | null;
  attemptedAt: number;
  /** W516: the last dashboard read that showed this repository. */
  viewedAt: number;
  /** The running list fetch. W520: details run on their own and never hold it. */
  pending: Promise<void> | null;
}

/** W520: one PR's details, read and retried apart from every other PR's. */
interface PrDetail {
  /** The last that loaded, the PR's `updatedAt` they were read at, and when. A failed read keeps them. */
  got: { size: PrSize; reviewers: Reviewer[]; updatedAt: number; readAt: number } | null;
  /**
   * Its latest read failed, in a request of `among` PRs. Alone (1), the fault is its own: it is
   * asked alone again after `retryAt` (DETAILS_RETRY_MS, doubling with each of `tries`). Among
   * others, no details request of its fetch succeeded to say whose fault it was: the next fetch
   * asks for it in requests half that size, so a split goes on where it stopped.
   */
  failed: { error: string; among: number; tries: number; retryAt: number } | null;
  /**
   * A request for it is queued or running: no other fetch asks for it meanwhile. The PR keeps
   * this state while it does, even if it leaves the list.
   */
  asked: boolean;
}

/**
 * W520: one details request: up to DETAILS_PAGE PRs of one repository. `level` is 0 for a first
 * request of PRs that didn't fail together before, else 1 or more; `tries` its own failures, once
 * it asks for one PR.
 */
interface DetailsRequest {
  entry: RepoEntry;
  prs: { id: string; number: number; updatedAt: number; detail: PrDetail }[];
  level: number;
  tries: number;
}

/**
 * W520: one fetch's details requests. `answered`: one succeeded, so GitHub answers and a failure
 * is the failing PRs' fault. `running`: queued or running. `parked`: failures that wait for either.
 */
interface DetailsFetch {
  answered: boolean;
  running: number;
  parked: { request: DetailsRequest; error: string }[];
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
  /** R2: the owner of each PR that has one, by canonical PR URL (see PrOwners.owners). */
  owners?(pullRequests: readonly { url: string; head: string }[]): ReadonlyMap<string, PrOwner>;
  /** v9 (§7): PR states for computed task status. Every open-list fetch marks what it lists open. */
  prStates?: {
    markOpen(urls: string[], at: number): void;
    /** Tracked PRs to look up after a fetch: not listed, not MERGED, not checked in the last hour. */
    toLookUp(listed: ReadonlySet<string>, at: number, limit: number): string[];
    save(url: string, at: number, result: { state: "OPEN" | "MERGED" | "CLOSED"; mergedAt: number | null; closedAt: number | null } | { error: string }): void;
  };
}

/**
 * R2: the PRs left out of `listed` (another Initiative's) that a listed PR is stacked on, at any
 * depth, so what keeps a listed PR waiting can still be named.
 */
function beneath(listed: readonly QueuedPullRequest[], all: readonly QueuedPullRequest[]): QueuedPullRequest[] {
  const at = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;
  const byNumber = new Map(all.map((pr) => [at(pr.repo, pr.number), pr]));
  const under = (pr: QueuedPullRequest) => (pr.stack?.on == null ? undefined : byNumber.get(at(pr.repo, pr.stack.on)));
  // By repository and number: a listed PR is a copy (an unassigned one is marked so), not `all`'s object.
  const shown = new Set(listed.map((pr) => at(pr.repo, pr.number)));
  const found = new Map<string, QueuedPullRequest>();
  // A listed PR on the way down has its own turn; `found` ends a cycle.
  for (const pr of listed)
    for (let below = under(pr); below && !shown.has(at(below.repo, below.number)) && !found.has(at(below.repo, below.number)); below = under(below))
      found.set(at(below.repo, below.number), below);
  return [...found.values()];
}

/** The lookup pass after each open-list fetch: at most this many PRs, in one request. */
export const LOOKUP_LIMIT = 50;

/**
 * Server-side cache of each repository's open PRs by the `gh` user, shared
 * across Initiatives and clients. A read never waits on GitHub (D441): it
 * answers from the cache at once and, when a repository's last attempt is
 * old enough (REFRESH_MS while a dashboard shows it, IDLE_REFRESH_MS
 * otherwise) or on a manual refresh, starts a fetch behind it: one paged
 * search over every due repository of the read, then the details of the PRs
 * that changed, at most one fetch per repository in flight. `fetched` hears
 * when the list lands and when the fetch ends, so clients read again. A
 * failed fetch keeps the last good data and reports the error beside it.
 * W516: GitHub is read over HTTP (github-api.ts), never through a `gh` spawn.
 */
export class MergeQueueCache {
  /** The account the last search ran as, for the dashboard's "by …". */
  private loginName: string | null = null;
  private repos = new Map<string, RepoEntry>();
  /**
   * R2: members whose latest lookup failed (a deleted BB project answers 404), with the last answer
   * they had, if any. cachedRepos takes such a member as it was, or without a repository, and asks
   * again only after REMOTE_TTL_MS; a member's own read still asks again at once.
   */
  private remoteFailures = new Map<string, { at: number; last: Remote | null }>();
  /** `announce`: a read that wouldn't wait asked for it, so its first answer is announced (`fetched`). */
  private remotes = new Map<string, { at: number; value: Promise<Remote>; last: Remote | null; announce: boolean }>();
  /** The running PR-state lookup pass, one at a time. */
  private lookups: Promise<void> | null = null;
  /** W520: the details requests queued or running, and the slots they take turns in. */
  private detailsRunning = new Set<Promise<void>>();
  private detailsSlots = semaphore(DETAILS_CONCURRENCY);

  constructor(
    private sources: MergeQueueSources,
    private github: GraphQl = githubGraphQl(() => runGh(["auth", "token"])),
    private now: () => number = Date.now,
    private fetched: (repo: string) => void = () => {},
  ) {}

  /** `viewer`: a dashboard read, which keeps its repositories on the REFRESH_MS cadence. */
  async read(projectId: string, options: { refresh?: boolean; viewer?: boolean } = {}): Promise<MergeQueue> {
    const members = await Promise.all(this.sources.memberProjectIds(projectId).map((id) => this.remote(id)));
    // GitHub names are case-insensitive: key, cache and rate-limit by lower case,
    // and show the first member remote's own casing.
    const display = new Map<string, string>();
    for (const m of members) if (m.repo && !display.has(m.repo.toLowerCase())) display.set(m.repo.toLowerCase(), m.repo);
    const repos = [...display.keys()];
    const skipped = members.filter((m) => !m.repo).map((m) => ({ project: m.name, reason: "no GitHub origin remote" }));
    this.refresh(repos.map((repo) => this.entry(repo, display.get(repo)!)), options.refresh === true, options.viewer === true);
    const workers = this.sources.workers(projectId);
    const records = this.sources.prRecords(projectId);
    const assigned = this.sources.assignedPrs(projectId);
    const listed = repos.flatMap((repo) => {
      const entry = this.repos.get(repo)!;
      const details = new Map([...entry.details].map(([number, d]) => [number, { size: d.got?.size ?? null, reviewers: d.got?.reviewers ?? [], error: d.failed?.error ?? null }]));
      return attachDetails(entry.pullRequests ?? [], details);
    });
    const owner = this.ownerOf(projectId, listed);
    // Each PR staged by its owner's records (this Initiative's when unassigned): a PR another
    // Initiative owns still holds up the ones stacked on it, at the stage that one recorded.
    const recordsOf = new Map([[projectId, records]]);
    const staged = listed.map((pr) => {
      const id = owner(pr) ?? projectId;
      if (!recordsOf.has(id)) recordsOf.set(id, this.sources.prRecords(id));
      return assignStages([pr], recordsOf.get(id)!)[0]!;
    });
    const linked = linkStacks(attachLinks(attachNotes(attachWorkers(staged, workers, assigned), this.sources.notes(projectId)), assigned, records));
    // R2: this Initiative's PRs and the unassigned ones; another Initiative's PRs leave the list.
    const pullRequests = this.sources.owners ? linked.flatMap((pr) => {
      const id = owner(pr);
      return !id ? [{ ...pr, unassigned: true }] : id === projectId ? [pr] : [];
    }) : linked;
    const stages = PR_STAGES.map((stage) => ({ ...stage }));
    return {
      projectId,
      beneath: beneath(pullRequests, linked),
      login: this.loginName,
      repos: repos.map((repo) => {
        const entry = this.repos.get(repo)!;
        const details = [...entry.details.values()];
        const listed = new Set((entry.pullRequests ?? []).map((pr) => pr.number));
        const failed = [...entry.details].flatMap(([number, d]) => (d.failed && listed.has(number) ? [d.failed.error] : []));
        return {
          repo: display.get(repo)!, fetchedAt: entry.fetchedAt, error: entry.error,
          fetching: entry.pending !== null || details.some((d) => d.asked),
          detailsFetchedAt: entry.detailsFetchedAt,
          detailsError: failed.length ? `${failed[0]} (${failed.length} PR${failed.length === 1 ? "" : "s"})` : null,
          ...(entry.capped ? { capped: entry.capped } : {}),
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
    return [...this.repos.values()].flatMap((entry) => (entry.pending ? [entry.pending] : [])).concat([...this.detailsRunning]);
  }

  /**
   * R2: each listed PR's owner Initiative, or null when it has none. An owner counts only while
   * it lists the PR's repository: one that doesn't would show the PR nowhere, so the PR stays
   * unassigned and every Initiative listing the repository shows it.
   */
  private ownerOf(projectId: string, listed: readonly QueuedPullRequest[]): (pr: QueuedPullRequest) => string | null {
    const key = (pr: QueuedPullRequest) => canonicalPrUrl(pr.url) ?? pr.url.toLowerCase();
    const owners = this.sources.owners?.(listed.map((pr) => ({ url: key(pr), head: pr.head })));
    if (!owners) return () => null;
    const others = new Set([...owners.values()].flatMap((o) => (o.projectId && o.projectId !== projectId ? [o.projectId] : [])));
    // Never waits on another Initiative's remotes: one not looked up yet keeps its PRs (they leave
    // this list) until the lookup behind the read lands and is announced.
    const reposOf = new Map([...others].map((id) => [id, this.cachedRepos(id)] as const));
    return (pr) => {
      const id = owners.get(key(pr))?.projectId;
      const repos = id && reposOf.get(id);
      return id && (id === projectId || repos === null || repos?.includes(pr.repo.toLowerCase())) ? id : null;
    };
  }

  /**
   * R2: an Initiative's repositories, lower case, as far as the remotes cache knows them; null
   * while a member's first lookup runs. Never waits: a missing or stale remote is looked up behind
   * the answer, and the first answer for one never read is announced. A member whose lookup
   * failed counts as it last was, or without a repository, so an owner that can't be read leaves
   * its PRs unassigned rather than nowhere.
   */
  cachedRepos(projectId: string): string[] | null {
    let ids: string[];
    try {
      ids = this.sources.memberProjectIds(projectId);
    } catch {
      return [];
    }
    const repos = new Set<string>();
    let known = true;
    for (const id of ids) {
      const failed = this.remoteFailures.get(id);
      const recent = failed && this.now() - failed.at < REMOTE_TTL_MS;
      if (!recent) void this.remote(id, true);
      const last = this.remotes.get(id)?.last ?? (recent ? failed.last : null);
      if (last?.repo) repos.add(last.repo.toLowerCase());
      else if (!last && !recent) known = false;
    }
    return known ? [...repos] : null;
  }

  /**
   * R2: an Initiative's GitHub repositories, lower case, from its members' remotes, for a write
   * that must know them: only a member's first lookup waits on BB, never on GitHub.
   */
  async reposOf(projectId: string): Promise<string[]> {
    const members = await Promise.all(this.sources.memberProjectIds(projectId).map((id) => this.remote(id)));
    return [...new Set(members.flatMap((m) => (m.repo ? [m.repo.toLowerCase()] : [])))];
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
  private remote(bbProjectId: string, announce = false): Promise<Remote> {
    const cached = this.remotes.get(bbProjectId);
    if (cached && this.now() - cached.at < REMOTE_TTL_MS) {
      if (!cached.last) cached.announce ||= announce;
      return cached.last ? Promise.resolve(cached.last) : cached.value;
    }
    // The last good answer survives failed lookups: a retry starts from it, and fails keeping it.
    const last = cached?.last ?? this.remoteFailures.get(bbProjectId)?.last ?? null;
    const entry = { at: this.now(), value: null as unknown as Promise<Remote>, last, announce: announce && !last };
    const announced = (repo: string) => {
      if (!entry.announce) return;
      try {
        this.fetched(repo);
      } catch {
        // A hint; the next poll reads anyway.
      }
    };
    entry.value = this.sources.project(bbProjectId).then(
      (p) => {
        entry.last = { name: p.name, repo: githubRepo(p.gitRemoteUrl) };
        this.remoteFailures.delete(bbProjectId);
        announced(entry.last.repo ?? "");
        return entry.last;
      },
      () => {
        // Look again on the next read rather than caching the failure.
        if (this.remotes.get(bbProjectId) === entry) this.remotes.delete(bbProjectId);
        this.remoteFailures.set(bbProjectId, { at: this.now(), last: entry.last });
        // A first lookup that fails still answers: cachedRepos now counts the member without a repository.
        announced("");
        return entry.last ?? { name: bbProjectId, repo: null };
      },
    );
    this.remotes.set(bbProjectId, entry);
    return entry.last ? Promise.resolve(entry.last) : entry.value;
  }

  private entry(repo: string, name: string): RepoEntry {
    let entry = this.repos.get(repo);
    if (!entry) {
      entry = {
        key: repo, name, pullRequests: null, fetchedAt: null, error: null, capped: null,
        details: new Map(), detailsFetchedAt: null,
        attemptedAt: -Infinity, viewedAt: -Infinity, pending: null,
      };
      this.repos.set(repo, entry);
    }
    return entry;
  }

  /** Starts one fetch for the due repositories among `entries`, REPOS_PER_SEARCH a search; never waits for it. */
  private refresh(entries: RepoEntry[], force: boolean, viewer: boolean): void {
    const now = this.now();
    const due = entries.filter((entry) => {
      if (viewer) entry.viewedAt = now;
      if (entry.pending) return false;
      const every = force ? MIN_FORCED_REFRESH_MS : now - entry.viewedAt < VIEWER_MS ? REFRESH_MS : IDLE_REFRESH_MS;
      return now - entry.attemptedAt >= every;
    });
    for (let i = 0; i < due.length; i += REPOS_PER_SEARCH) {
      const group = due.slice(i, i + REPOS_PER_SEARCH);
      for (const entry of group) entry.attemptedAt = now;
      const pending = this.fetch(group).finally(() => {
        for (const entry of group) {
          entry.pending = null;
          this.announce(entry.key);
        }
      });
      for (const entry of group) entry.pending = pending;
    }
  }

  private announce(repo: string): void {
    try {
      this.fetched(repo);
    } catch {
      // The announcement is a hint (the plugin may be stopping); the next poll reads anyway.
    }
  }

  private async fetch(group: RepoEntry[]): Promise<void> {
    let list: { nodes: unknown[]; total: number; complete: boolean; login: string | null };
    try {
      list = await this.search(GH_LIST_QUERY, prSearch(group.map((entry) => entry.name)), "the PR list query");
    } catch (error) {
      for (const entry of group) entry.error = message(error);
      return;
    }
    if (list.login) this.loginName = list.login;
    const byKey = new Map(group.map((entry) => [entry.key, [] as unknown[]]));
    for (const node of list.nodes) {
      const url = (node as { url?: unknown } | null)?.url;
      const repo = typeof url === "string" ? prRepoKey(url) : null;
      if (repo) byKey.get(repo)?.push(node);
    }
    const at = this.now();
    for (const entry of group) {
      entry.pullRequests = parsePullRequests(entry.name, byKey.get(entry.key)!);
      entry.capped = list.complete ? null : { listed: list.nodes.length, total: list.total, search: group.map((e) => e.name) };
      entry.fetchedAt = at;
      entry.error = null;
    }
    try {
      this.sources.prStates?.markOpen(group.flatMap((entry) => entry.pullRequests!.flatMap((pr) => canonicalPrUrl(pr.url) ?? [])), at);
    } catch { /* the states are a cache; the next fetch writes them again */ }
    this.lookUp();
    // The list shows before its details land: the fetch ends here, and is announced.
    this.loadDetails(group, byKey);
  }

  /**
   * W516: the details of each listed PR whose `updatedAt` moved since its details were read, or
   * whose details are DETAILS_RESYNC_MS old. W520: every PR is read and retried on its own
   * terms, DETAILS_CONCURRENCY requests at a time, so one PR failing or hanging never holds up
   * another, in its repository or any other:
   * - a request asks for up to DETAILS_PAGE PRs of one repository (one point, however many);
   * - one that fails is split in two, each half queued on its own, down to single PRs: a PR's
   *   fault ends up in a request of its own, and the others load. A first request always splits;
   *   halves split again only once a details request of this fetch succeeded (one that fails
   *   first waits for the others). When GitHub fails them all, the fault may not be a PR's: the
   *   split stops, and the next fetch goes on from it (PrDetail.failed.among), so GitHub down
   *   costs three requests a batch, then twice as many each fetch;
   * - a PR asked alone in a first request is retried once, quietly. One that fails alone keeps
   *   its last details, says why (`detailsError`), and is asked alone again after
   *   DETAILS_RETRY_MS, doubling.
   * Never awaited: reads and the next list fetch never wait for details.
   */
  private loadDetails(group: RepoEntry[], nodesOf: ReadonlyMap<string, unknown[]>): void {
    const now = this.now();
    const fetch: DetailsFetch = { answered: false, running: 0, parked: [] };
    const first: DetailsRequest[] = [];
    const resumed: DetailsRequest[] = [];
    const alone: DetailsRequest[] = [];
    for (const entry of group) {
      const listed = new Set<number>();
      const fresh: DetailsRequest["prs"] = [];
      /** PRs that failed together, by the size of the requests the next step of their split asks for. */
      const split = new Map<number, DetailsRequest["prs"]>();
      for (const node of nodesOf.get(entry.key)!) {
        const n = node as { id?: unknown; number?: unknown; updatedAt?: unknown };
        if (typeof n.number !== "number") continue;
        listed.add(n.number);
        // 0 for none, so a PR without one compares equal to itself.
        const updatedAt = typeof n.updatedAt === "string" && Number.isFinite(Date.parse(n.updatedAt)) ? Date.parse(n.updatedAt) : 0;
        let detail = entry.details.get(n.number);
        if (!detail) entry.details.set(n.number, (detail = { got: null, failed: null, asked: false }));
        const { got, failed } = detail;
        if (detail.asked || typeof n.id !== "string" || (failed?.among === 1 && failed.retryAt > now)) continue;
        if (got && !failed && got.updatedAt === updatedAt && now - got.readAt < DETAILS_RESYNC_MS) continue;
        detail.asked = true;
        const pr = { id: n.id, number: n.number, updatedAt, detail };
        if (!failed) fresh.push(pr);
        else if (failed.among === 1) alone.push({ entry, prs: [pr], level: 0, tries: 0 });
        else {
          const size = Math.ceil(failed.among / 2);
          split.set(size, [...(split.get(size) ?? []), pr]);
        }
      }
      // A PR whose request still runs keeps its state until that settles.
      for (const [number, detail] of entry.details) if (!listed.has(number) && !detail.asked) entry.details.delete(number);
      // PRs without details first: they show none until read.
      fresh.sort((a, b) => Number(a.detail.got !== null) - Number(b.detail.got !== null));
      for (let i = 0; i < fresh.length; i += DETAILS_PAGE) first.push({ entry, prs: fresh.slice(i, i + DETAILS_PAGE), level: 0, tries: 0 });
      for (const [size, prs] of split)
        for (let i = 0; i < prs.length; i += size) resumed.push({ entry, prs: prs.slice(i, i + size), level: 1, tries: 0 });
    }
    // The PRs known to fail last, so they never take a slot ahead of the others.
    for (const request of [...first, ...resumed, ...alone]) this.readDetails(request, fetch);
  }

  /** Queues one details request (DETAILS_CONCURRENCY run at once) and what follows from its answer. */
  private readDetails(request: DetailsRequest, fetch: DetailsFetch): void {
    fetch.running++;
    const task = this.detailsSlots(() => this.github(GH_DETAILS_QUERY, { ids: request.prs.map((pr) => pr.id) }, GH_TIMEOUT_MS))
      // Read inside the chain: an answer that can't be read fails its request like any other.
      .then((data) => readDetailsAnswer(request.prs, data))
      .then(
        (read) => {
          fetch.running--;
          fetch.answered = true;
          this.gotDetails(request, read);
          for (const parked of fetch.parked.splice(0)) this.failedDetails(parked.request, fetch, parked.error);
        },
        (error) => {
          fetch.running--;
          this.failedDetails(request, fetch, message(error));
          // Every request of the fetch failed: none says whose fault the parked failures are.
          if (!fetch.running) for (const parked of fetch.parked.splice(0)) this.markFailed(parked.request, parked.error);
        },
      )
      .finally(() => {
        this.detailsRunning.delete(task);
        this.announce(request.entry.key);
      });
    this.detailsRunning.add(task);
  }

  private gotDetails({ entry, prs }: DetailsRequest, read: ReadonlyMap<number, { size: PrSize; reviewers: Reviewer[] }>): void {
    const at = this.now();
    entry.detailsFetchedAt = at;
    // A PR that left the list and came back meanwhile has a new state: `detail` is no longer its.
    for (const pr of prs.filter((pr) => entry.details.get(pr.number) === pr.detail)) {
      pr.detail.asked = false;
      // GitHub answered for it: whatever failed before didn't this time.
      pr.detail.failed = null;
      // A PR gone since the list (null) or malformed keeps what it had, and is asked again next time.
      const got = read.get(pr.number);
      if (got) pr.detail.got = { ...got, updatedAt: pr.updatedAt, readAt: at };
    }
  }

  private failedDetails(request: DetailsRequest, fetch: DetailsFetch, error: string): void {
    const { entry, prs } = request;
    if (prs.length > 1 && (fetch.answered || request.level === 0)) {
      const half = Math.ceil(prs.length / 2);
      for (const part of [prs.slice(0, half), prs.slice(half)]) this.readDetails({ entry, prs: part, level: request.level + 1, tries: 0 }, fetch);
      return;
    }
    // Whether to split waits on the fetch's other requests, whichever order they end in.
    if (prs.length > 1 && fetch.running) return void fetch.parked.push({ request, error });
    // A PR that a split left alone already failed in every request above it: no retry.
    if (prs.length === 1 && request.level === 0 && request.tries === 0) return this.readDetails({ ...request, tries: 1 }, fetch);
    this.markFailed(request, error);
  }

  private markFailed({ entry, prs }: DetailsRequest, error: string): void {
    const at = this.now();
    for (const pr of prs.filter((pr) => entry.details.get(pr.number) === pr.detail)) {
      pr.detail.asked = false;
      const tries = prs.length === 1 ? (pr.detail.failed?.among === 1 ? pr.detail.failed.tries : 0) + 1 : 0;
      const wait = Math.min(DETAILS_RETRY_MS * 2 ** Math.max(tries - 1, 0), DETAILS_RESYNC_MS);
      pr.detail.failed = { error, among: prs.length, tries, retryAt: at + wait };
    }
  }

  /**
   * v9 (§7): after a fetch, looks up the state of tracked PRs the open lists don't name (merged,
   * closed, or someone else's), oldest check first, LOOKUP_LIMIT in one request (W516). Every
   * lookup stamps its check time, so no PR hogs the pass; reads never wait for it.
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
    const save = (url: string, result: Parameters<NonNullable<MergeQueueSources["prStates"]>["save"]>[2]) => {
      try { states.save(url, this.now(), result); } catch { /* a cache */ }
    };
    this.lookups = (async () => {
      try {
        const data = (await this.github(prLookupQuery(urls.length), Object.fromEntries(urls.map((url, i) => [`u${i}`, url])), GH_TIMEOUT_MS)) as Record<string, unknown>;
        urls.forEach((url, i) => save(url, parsePrLookup(data[`p${i}`])));
      } catch (error) {
        for (const url of urls) save(url, { error: message(error) });
      }
    })().finally(() => {
      this.lookups = null;
    });
  }

  /** Resolves once no PR-state lookup is running (tests). */
  async lookupsSettled(): Promise<void> {
    await this.lookups;
  }

  /**
   * One request within `deadline`, retried once, quietly, while time is left. `read` of `total`
   * name how far the search got when it gives up.
   */
  private async retried<T>(deadline: number, what: string, read: number, total: number, attempt: () => Promise<T>): Promise<T> {
    const once = () => {
      if (deadline - this.now() <= 0) throw new Error(`${what} took over ${FETCH_BUDGET_MS / 1000} s (read ${read} of ${total} PRs)`);
      return attempt();
    };
    try {
      return await once();
    } catch (error) {
      if (deadline - this.now() <= 0) throw error;
      return once();
    }
  }

  /**
   * Every page of one search query, one request each, up to PR_LIMIT results, each PR once
   * (results shift as PRs open). The pages share FETCH_BUDGET_MS: each gets at most
   * GH_TIMEOUT_MS of the time left, and a failed one is retried once, quietly, while time is left.
   * One that fails twice, a budget spent before the last page, or an empty page that promises
   * more fails the query: no list stops short unannounced. `complete` is false when it stopped
   * at PR_LIMIT short of GitHub's count.
   */
  private async search(query: string, q: string, what: string): Promise<{ nodes: unknown[]; total: number; complete: boolean; login: string | null }> {
    const deadline = this.now() + FETCH_BUDGET_MS;
    const nodes: unknown[] = [];
    // By URL: one search spans repositories, whose numbers repeat.
    const seen = new Set<string>();
    /** Results GitHub returned, repeats included: its 1000 ceiling counts these. */
    let returned = 0;
    let total = 0;
    let login: string | null = null;
    let cursor: string | null = null;
    do {
      const variables = { q, ...(cursor ? { endCursor: cursor } : {}) };
      const page: SearchPage = await this.retried(deadline, what, nodes.length, total, () =>
        this.github(query, variables, Math.min(deadline - this.now(), GH_TIMEOUT_MS)).then((data) => parseSearchPage(data, what)));
      returned += page.nodes.length;
      for (const node of page.nodes) {
        const url = (node as { url?: unknown } | null)?.url;
        if (typeof url === "string") {
          const key = url.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
        }
        nodes.push(node);
      }
      total = page.total;
      login = page.login ?? login;
      cursor = page.next;
      // It would page on until the budget is spent, and a list cut short here isn't GitHub's limit.
      if (!page.nodes.length && cursor) throw new Error(`${what} returned an empty page before the last (read ${nodes.length} of ${total} PRs)`);
    } while (cursor && returned < PR_LIMIT);
    // GitHub ends the pages at its 1000th result however many match: only its count tells.
    return { nodes, total, complete: nodes.length >= total || (cursor === null && returned < PR_LIMIT), login };
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** W520: each asked PR's size and reviewers from a details answer, by number; a PR gone or malformed has none. Throws on an answer it can't read. */
function readDetailsAnswer(prs: DetailsRequest["prs"], data: unknown): Map<number, { size: PrSize; reviewers: Reviewer[] }> {
  const byId = new Map(parseDetailsNodes(data, "the details query").flatMap((node) => {
    const id = (node as { id?: unknown } | null)?.id;
    return typeof id === "string" ? [[id, node] as const] : [];
  }));
  const read = new Map<number, { size: PrSize; reviewers: Reviewer[] }>();
  for (const pr of prs) {
    const detail = parseDetail(byId.get(pr.id));
    if (detail?.number === pr.number) read.set(pr.number, { size: detail.size, reviewers: detail.reviewers });
  }
  return read;
}

/** W520: runs at most `limit` tasks at once; the others wait their turn in order. */
export function semaphore(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    if (running < limit) running++;
    // A finishing task hands its slot straight to the next in line.
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };
}
