import { execFile, type ChildProcess } from "node:child_process";
import {
  GH_DETAILS_QUERY,
  GH_LIST_QUERY,
  attachDetails,
  attachLinks,
  attachNotes,
  assignStages,
  attachWorkers,
  ghJson,
  githubRepo,
  orderQueue,
  parseDetails,
  parsePullRequests,
  parseSearchPage,
  prSearch,
  type MergeQueue,
  type PrDetails,
  type QueuedPullRequest,
  type SearchPage,
} from "./merge-queue";
import { PR_STAGES, canonicalPrUrl, type PrRecord } from "./pr-stages";
import type { PrNotesSummary } from "./pr-notes";
import type { PrWork } from "./pr-records";
import type { PrOwner } from "./pr-owners";
import { linkStacks } from "./pr-map";

/** Runs `gh` with these arguments and resolves its stdout, failing after `timeoutMs` (default GH_TIMEOUT_MS). */
export type GhRunner = (args: string[], timeoutMs?: number) => Promise<string>;

/** A repository is re-read when its last attempt is older than this. */
export const REFRESH_MS = 2 * 60_000;
/** A manual refresh within this long of the last attempt reuses it. */
export const MIN_FORCED_REFRESH_MS = 10_000;
/** A project's remote is looked up again after this long. */
export const REMOTE_TTL_MS = 5 * 60_000;
/** Each `gh` call's bound; a hung one reads as a failed page. Reads never wait for it. */
export const GH_TIMEOUT_MS = 20_000;
/** All of one query's pages, retry included; reads never wait for them (D441). */
export const FETCH_BUDGET_MS = 60_000;
/**
 * Open PRs read per repository: all GitHub's search returns. The user had 209 open in Equisafe
 * in October 2026, past the earlier cap of 200 (W490); a list cut short says so (`capped`).
 */
export const PR_LIMIT = 1000;

/**
 * Spawns `gh` asynchronously: the event loop never waits on it. The bound is our own timer, not
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
  /** The casing to request and show. */
  name: string;
  pullRequests: QueuedPullRequest[] | null;
  fetchedAt: number | null;
  error: string | null;
  /** The last list stopped short of every open PR (PR_LIMIT); null once one doesn't. */
  capped: { listed: number; total: number } | null;
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
    const listed = repos.flatMap((repo) => {
      const entry = this.repos.get(repo)!;
      return attachDetails(entry.pullRequests ?? [], entry.details.data, { reviewers: entry.details.error === null });
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
        return {
          repo: display.get(repo)!, fetchedAt: entry.fetchedAt, error: entry.error, fetching: entry.pending !== null,
          detailsFetchedAt: entry.details.fetchedAt, detailsError: entry.details.error,
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
    return [...this.repos.values()].flatMap((entry) => (entry.pending ? [entry.pending] : []));
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
      entry = { name, pullRequests: null, fetchedAt: null, error: null, capped: null, details: { data: null, fetchedAt: null, error: null }, attemptedAt: -Infinity, pending: null };
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
    const q = prSearch(target.name, login);
    const [list, details] = await Promise.allSettled([
      this.search(GH_LIST_QUERY, q, "the PR list query"),
      this.search(GH_DETAILS_QUERY, q, "the details query").then((found) => parseDetails(found.nodes)),
    ]);
    if (list.status === "fulfilled") {
      const { nodes, total, complete } = list.value;
      target.pullRequests = parsePullRequests(target.name, nodes);
      target.capped = complete ? null : { listed: nodes.length, total };
      target.fetchedAt = this.now();
      target.error = null;
      try {
        this.sources.prStates?.markOpen(target.pullRequests.flatMap((pr) => canonicalPrUrl(pr.url) ?? []), this.now());
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
        const out = ghJson(await this.gh(["pr", "view", url, "--json", "state,mergedAt,closedAt"]), "gh pr view") as { state?: string; mergedAt?: string | null; closedAt?: string | null };
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
   * Every page of one search query, one `gh api graphql` each, up to PR_LIMIT results, each PR
   * once (results shift as PRs open). The pages share FETCH_BUDGET_MS: each gets at most
   * GH_TIMEOUT_MS of the time left, and a failed one is retried once, quietly, while time is left.
   * One that fails twice, a budget spent before the last page, or an empty page that promises
   * more fails the query: no list stops short unannounced. `complete` is false when it stopped
   * at PR_LIMIT short of GitHub's count.
   */
  private async search(query: string, q: string, what: string): Promise<{ nodes: unknown[]; total: number; complete: boolean }> {
    const deadline = this.now() + FETCH_BUDGET_MS;
    const nodes: unknown[] = [];
    const seen = new Set<number>();
    /** Results GitHub returned, repeats included: its 1000 ceiling counts these. */
    let returned = 0;
    let total = 0;
    let cursor: string | null = null;
    do {
      const args = ["api", "graphql", "-f", `query=${query}`, "-f", `q=${q}`, ...(cursor ? ["-f", `endCursor=${cursor}`] : [])];
      const attempt = (): Promise<SearchPage> => {
        const left = deadline - this.now();
        if (left <= 0) throw new Error(`${what} took over ${FETCH_BUDGET_MS / 1000} s (read ${nodes.length} of ${total} PRs)`);
        return this.gh(args, Math.min(left, GH_TIMEOUT_MS)).then((out) => parseSearchPage(out, what));
      };
      let page: SearchPage;
      try {
        page = await attempt();
      } catch (error) {
        if (deadline - this.now() <= 0) throw error;
        page = await attempt();
      }
      returned += page.nodes.length;
      for (const node of page.nodes) {
        const number = (node as { number?: unknown } | null)?.number;
        if (typeof number === "number") {
          if (seen.has(number)) continue;
          seen.add(number);
        }
        nodes.push(node);
      }
      total = page.total;
      cursor = page.next;
      // It would page on until the budget is spent, and a list cut short here isn't GitHub's limit.
      if (!page.nodes.length && cursor) throw new Error(`${what} returned an empty page before the last (read ${nodes.length} of ${total} PRs)`);
    } while (cursor && returned < PR_LIMIT);
    // GitHub ends the pages at its 1000th result however many match: only its count tells.
    return { nodes, total, complete: nodes.length >= total || (cursor === null && returned < PR_LIMIT) };
  }
}
