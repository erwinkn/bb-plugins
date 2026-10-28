// R2 (Erwin, 2026-10-14): each pull request belongs to one Initiative, or to
// none yet. Initiatives sharing a repository (Equisafe and Equisafe UI both
// list equisafe/infra) list only their own PRs, and every Initiative lists the
// unassigned ones apart, under "Unassigned". A manual move always wins; without
// one, the owner is the Initiative whose worker opened the PR: its BB worktree
// branch names the thread, which is that worker's or one of its descendants.
import type Database from "better-sqlite3";
import { branchThreadId } from "./merge-queue";
import type { Store } from "./store";

export const PR_OWNER_MIGRATIONS = [
  // Additive: an older build never reads it, and lists every PR in every Initiative as before.
  // project_id NULL is a manual "Unassign": no automatic owner takes the PR back.
  `CREATE TABLE pr_owners (
    url TEXT PRIMARY KEY,
    project_id TEXT,
    source TEXT NOT NULL,
    set_at INTEGER NOT NULL
  )`,
];

export interface PrOwner {
  /** The owning Initiative; null when unassigned by hand. */
  projectId: string | null;
  source: "auto" | "manual";
  setAt: number;
}

export interface OwnerThreads {
  /** The open Initiative a thread is a worker of (any of its generations), else null. */
  workerInitiative(threadId: string): string | null;
  /** A BB thread's parent, read from BB; null for a top-level or unknown thread. */
  parentOf(threadId: string): Promise<string | null>;
  /** Whether an Initiative is open: an archived owner leaves its PRs unassigned. */
  isOpen(projectId: string): boolean;
}

/** The server's OwnerThreads: workers and Initiatives from the ledger, a thread's parent from BB. */
export const ledgerThreads = (store: Pick<Store, "membership" | "project">, parentOf: (threadId: string) => Promise<string | null>): OwnerThreads => ({
  workerInitiative: (threadId) => {
    const m = store.membership(threadId);
    return m?.kind === "worker" ? m.project.id : null;
  },
  parentOf,
  isOpen: (projectId) => store.project(projectId)?.archivedAt === null,
});

/** A thread no worker was found above is looked up again after this long. */
export const MISS_TTL_MS = 10 * 60_000;

/**
 * The pr_owners table, on the plugin's one connection, and the automatic owner
 * of PRs it has no row for. URLs are canonical (canonicalPrUrl).
 */
export class PrOwners {
  private rows: Map<string, PrOwner> | null = null;
  /** Each looked-up thread's Initiative (null: no worker above it), and when it was found. */
  private threads = new Map<string, { projectId: string | null; at: number }>();
  private walks = new Map<string, Promise<void>>();

  constructor(
    private readonly db: Database.Database,
    private readonly lookup: OwnerThreads,
    /** An owner was found behind a read: the lists should be read again. */
    private readonly changed: () => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  /** Every recorded owner, by URL, as stored. */
  all(): ReadonlyMap<string, PrOwner> {
    this.rows ??= new Map((this.db.prepare("SELECT * FROM pr_owners").all() as Record<string, unknown>[]).map((row) => [
      String(row.url),
      { projectId: (row.project_id as string | null) ?? null, source: row.source === "manual" ? "manual" : "auto", setAt: Number(row.set_at) },
    ]));
    return this.rows;
  }

  /** W548: the open Initiative a PR's recorded owner is now; null for none (never found, unassigned by hand, or archived). */
  recorded(url: string): string | null {
    const id = this.all().get(url)?.projectId ?? null;
    return id && this.lookup.isOpen(id) ? id : null;
  }

  /** A manual move to `projectId`, or out of every Initiative with null. */
  move(url: string, projectId: string | null, at: number) {
    this.db.prepare(`INSERT INTO pr_owners (url, project_id, source, set_at) VALUES (?, ?, 'manual', ?)
      ON CONFLICT (url) DO UPDATE SET project_id = excluded.project_id, source = 'manual', set_at = excluded.set_at`).run(url, projectId, at);
    this.rows = null;
  }

  /**
   * Each PR's owner, by URL; a PR without one is unassigned. A recorded owner
   * stands, unless its Initiative was archived. Otherwise a PR whose branch
   * names a worker's thread is that worker's Initiative's, recorded as found.
   * A thread that is no worker is looked up its parents in BB, to the root, behind the read,
   * never waited on; `changed` announces an owner it finds.
   */
  owners(pullRequests: readonly { url: string; head: string }[]): Map<string, PrOwner> {
    const rows = this.all();
    const out = new Map<string, PrOwner>();
    for (const pr of pullRequests) {
      const row = rows.get(pr.url);
      if (row) {
        if (row.projectId && this.lookup.isOpen(row.projectId)) out.set(pr.url, row);
        continue;
      }
      const threadId = branchThreadId(pr.head);
      const projectId = threadId ? this.ownerOf(threadId) : null;
      if (!projectId) continue;
      const at = this.now();
      this.db.prepare("INSERT OR IGNORE INTO pr_owners (url, project_id, source, set_at) VALUES (?, ?, 'auto', ?)").run(pr.url, projectId, at);
      this.rows = null;
      out.set(pr.url, { projectId, source: "auto", setAt: at });
    }
    return out;
  }

  /** The Initiative of the worker a thread is, or descends from, as far as known now; starts a lookup when not known. */
  private ownerOf(threadId: string): string | null {
    // The ledger first: a thread that became a worker since a miss is its Initiative's at once.
    const direct = this.lookup.workerInitiative(threadId);
    if (direct) return direct;
    const known = this.threads.get(threadId);
    if (known && (known.projectId || this.now() - known.at < MISS_TTL_MS)) return known.projectId;
    if (!this.walks.has(threadId)) this.walks.set(threadId, this.walk(threadId).finally(() => this.walks.delete(threadId)));
    return null;
  }

  private async walk(threadId: string) {
    let projectId: string | null = null;
    try {
      // Up to the root, however deep; a cycle of parents ends the walk.
      const seen = new Set([threadId]);
      for (let id = await this.lookup.parentOf(threadId); id && !seen.has(id); id = await this.lookup.parentOf(id)) {
        seen.add(id);
        projectId = this.lookup.workerInitiative(id);
        if (projectId) break;
      }
    } catch {
      // BB could not say: looked up again after MISS_TTL_MS.
    }
    this.threads.set(threadId, { projectId, at: this.now() });
    if (projectId) {
      try {
        this.changed();
      } catch {
        // A hint; the next read finds the owner anyway.
      }
    }
  }

  /** Resolves once no lookup is running (tests). */
  async settled() {
    while (this.walks.size) await Promise.all(this.walks.values());
  }
}
