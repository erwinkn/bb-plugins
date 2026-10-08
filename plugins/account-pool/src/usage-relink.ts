import type Database from "better-sqlite3";
import type { UsageLedger } from "./ledger.js";
import type { UsageRollup } from "./usage-rollup.js";

// Links ledger rows to the thread that sent them after the fact. The ledger labels a request with
// its thread only once the Pooler has linked its session to one (session-resolver.ts); requests
// before that carry none, about half of Claude's before 7 Oct 2026. BB's thread/identity
// events name every provider session a thread ran, so a session links when exactly one thread
// reports it and none of its rows already names another thread. Anything else stays unlinked.
// It is a backfill for past sessions: a session active in the last RECENT_MS, or with a request
// the ledger has not written yet, is skipped, since another thread may be joining it right now
// and live linking labels it anyway. Applying is idempotent: it only fills rows with no thread,
// then rebuilds the rollup from the ledger, since rows it already summed changed their slice.
// Requests keep landing while the plan awaits BB, so applying checks all of this again and
// touches only the rows the plan read.

export interface RelinkSources {
  // Every thread BB knows, archived and hidden ones included.
  threads(): Promise<string[]>;
  // The provider sessions a thread's thread/identity events name.
  sessions(threadId: string): Promise<string[]>;
  // The ledger's role label for a thread (threadRoleLabel), or null when unknown.
  role(threadId: string): Promise<string | null>;
}

export interface RelinkStore {
  db: Database.Database;
  ledger: Pick<UsageLedger, "queuedSessions" | "status">;
  now: () => number;
}

export interface RelinkSession {
  sessionKey: string;
  provider: string;
  rows: number;
}

export interface RelinkPlan {
  // The last ledger row the plan read; applying leaves later rows alone.
  throughRowid: number;
  // The rows the ledger had dropped when the plan started (its health count): a request dropped
  // since could have named another thread, so applying refuses.
  ledgerDropped: number;
  // Every session with rows that name no thread.
  unlinked: RelinkSession[];
  links: Array<RelinkSession & { threadId: string; role: string | null }>;
  // Sessions active in the last RECENT_MS or still queued, left to live linking.
  recent: RelinkSession[];
  // Sessions no thread reports, and sessions more than one thread claims, with their claimants.
  unmapped: RelinkSession[];
  ambiguous: Array<RelinkSession & { threadIds: string[] }>;
}

// Well past the ledger's flush interval and a long request's duration.
export const RECENT_MS = 15 * 60_000;
const READ_CONCURRENCY = 8;

export async function planRelink(store: RelinkStore, sources: RelinkSources): Promise<RelinkPlan> {
  const { db } = store;
  const throughRowid = (
    db.prepare("SELECT coalesce(max(rowid), 0) AS last FROM usage_requests").get() as { last: number }
  ).last;
  const unlinked = db
    .prepare(
      `SELECT session_key AS sessionKey, provider, count(*) AS rows FROM usage_requests
       WHERE thread_id IS NULL AND session_key LIKE 'session:%' AND rowid <= ?
       GROUP BY session_key, provider ORDER BY min(at)`,
    )
    .all(throughRowid) as RelinkSession[];
  const plan: RelinkPlan = {
    throughRowid,
    ledgerDropped: store.ledger.status().dropped,
    unlinked,
    links: [],
    recent: [],
    unmapped: [],
    ambiguous: [],
  };
  if (unlinked.length === 0) return plan;
  // The threads each session is known to belong to: from its rows that name one, and from every
  // thread that reports it. Every read must succeed: a missing one could hide a second owner.
  const owners = new Map<string, Set<string>>();
  const own = (sessionKey: string, threadId: string) => {
    let threads = owners.get(sessionKey);
    if (threads === undefined) owners.set(sessionKey, (threads = new Set()));
    threads.add(threadId);
  };
  const linked = db
    .prepare(
      `SELECT DISTINCT session_key AS sessionKey, thread_id AS threadId FROM usage_requests
       WHERE thread_id IS NOT NULL AND session_key IN
         (SELECT session_key FROM usage_requests WHERE thread_id IS NULL)`,
    )
    .all() as Array<{ sessionKey: string; threadId: string }>;
  for (const { sessionKey, threadId } of linked) own(sessionKey, threadId);
  const threads = await sources.threads();
  const reported = await mapLimited(threads, (threadId) => sources.sessions(threadId));
  threads.forEach((threadId, index) => {
    for (const session of reported[index]!) own(`session:${session}`, threadId);
  });
  const isRecent = recency(store);
  for (const session of unlinked) {
    const threads = owners.get(session.sessionKey);
    if (isRecent(session.sessionKey)) plan.recent.push(session);
    else if (threads === undefined) plan.unmapped.push(session);
    else if (threads.size > 1) plan.ambiguous.push({ ...session, threadIds: [...threads].sort() });
    else plan.links.push({ ...session, threadId: [...threads][0]!, role: null });
  }
  const linkedThreads = [...new Set(plan.links.map((link) => link.threadId))];
  const roles = await mapLimited(linkedThreads, (threadId) => sources.role(threadId));
  const roleOf = new Map(linkedThreads.map((threadId, index) => [threadId, roles[index]!]));
  for (const link of plan.links) link.role = roleOf.get(link.threadId) ?? null;
  return plan;
}

// Fills the plan's rows that still name no thread, and rebuilds the rollup, in one transaction.
// A link is checked again first: a session that became recent moves to the returned plan's recent
// list, and one whose rows named another thread since the plan read them to its ambiguous list.
export function applyRelink(
  store: RelinkStore,
  rollup: Pick<UsageRollup, "rebuild">,
  plan: RelinkPlan,
): { plan: RelinkPlan; linkedRows: number } {
  const { db } = store;
  if (store.ledger.status().dropped !== plan.ledgerDropped)
    throw new Error("The usage ledger dropped requests since the plan was made; nothing was linked. Try again.");
  const owners = db.prepare(
    `SELECT DISTINCT thread_id AS threadId FROM usage_requests
     WHERE session_key = ? AND thread_id IS NOT NULL`,
  );
  const update = db.prepare(
    `UPDATE usage_requests SET thread_id = @threadId, role = @role
     WHERE session_key = @sessionKey AND thread_id IS NULL AND rowid <= @throughRowid`,
  );
  return db
    .transaction(() => {
      const applied: RelinkPlan = {
        ...plan,
        links: [],
        recent: [...plan.recent],
        ambiguous: [...plan.ambiguous],
      };
      const isRecent = recency(store);
      let linkedRows = 0;
      for (const link of plan.links) {
        const { sessionKey, provider, rows, threadId, role } = link;
        if (isRecent(sessionKey)) {
          applied.recent.push({ sessionKey, provider, rows });
          continue;
        }
        const threadIds = new Set([
          threadId,
          ...(owners.all(sessionKey) as Array<{ threadId: string }>).map((row) => row.threadId),
        ]);
        if (threadIds.size > 1) {
          applied.ambiguous.push({ sessionKey, provider, rows, threadIds: [...threadIds].sort() });
          continue;
        }
        applied.links.push(link);
        linkedRows += update.run({ sessionKey, threadId, role, throughRowid: plan.throughRowid }).changes;
      }
      if (linkedRows > 0) rollup.rebuild();
      return { plan: applied, linkedRows };
    })
    .immediate();
}

// Whether a session had a request end in the last RECENT_MS, or has one the ledger still queues.
function recency(store: RelinkStore): (sessionKey: string) => boolean {
  const queued = store.ledger.queuedSessions();
  const active = store.db.prepare(
    `SELECT 1 FROM usage_requests
     WHERE session_key = ? AND at + latency_ms >= ? LIMIT 1`,
  );
  const since = store.now() - RECENT_MS;
  return (sessionKey) => queued.has(sessionKey) || active.get(sessionKey, since) !== undefined;
}

async function mapLimited<T, R>(items: T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await read(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, items.length) }, worker));
  return results;
}
