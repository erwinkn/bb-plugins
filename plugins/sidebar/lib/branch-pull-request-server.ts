import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { branchPullRequestContract } from "./branch-pull-request-contract";
import { abortable } from "./initiative-threads";
import {
  BRANCH_PULL_REQUESTS_CHANGED,
  isBranchPullRequestEnvironment,
} from "./branch-pull-request";

/** Thread reads per batch: loopback calls are cheap but still bounded. */
const LOOKUP_BATCH = 25;
const PAGE = 200;
/** A call finding the lists older than this answers from them and reads them again. */
export const LISTS_TTL_MS = 45_000;
/** The first call waits this long for the first lists, then reads its ids one by one. */
export const FIRST_LISTS_WAIT_MS = 10_000;
/** A read of the lists still running after this is abandoned. */
export const LISTS_DEADLINE_MS = 20_000;
/** A call slower than this logs one line. */
export const SLOW_CALL_MS = 200;

type Environment = Parameters<typeof isBranchPullRequestEnvironment>[0] & {
  id: string;
  status: string;
};

/**
 * The last value read for each id, tagged with the moment its read began: a
 * read never overwrites one that began after it, so an event's thread wins
 * over a list page read before it. A value that may be stale (archived
 * thread, environment not ready, dropped by the last list) is kept but not
 * `usable`: calls read it again, and changes are still measured against it.
 */
export function stampedTable<V>() {
  const rows = new Map<string, { value: V; usable: boolean; stamp: number }>();
  // The last list read: a read older than it cannot bring back a row it dropped.
  let floor = -Infinity;
  return {
    /** The value a call may answer with. */
    get: (id: string) => {
      const row = rows.get(id);
      return row?.usable ? row.value : undefined;
    },
    /** The last value read, usable or not. */
    last: (id: string) => rows.get(id)?.value,
    write(id: string, value: V, usable: boolean, stamp: number) {
      const row = rows.get(id);
      if ((row?.stamp ?? floor) <= stamp) rows.set(id, { value, usable, stamp });
    },
    /** Read again: calls stop answering with the value until a newer read. */
    invalidate(id: string, stamp: number) {
      const row = rows.get(id);
      if (row && row.stamp <= stamp) rows.set(id, { ...row, usable: false, stamp });
    },
    /**
     * After a list read begun at `stamp`: the older rows it left out stop
     * being usable, and those already unusable at the list before go.
     */
    retain(keep: ReadonlySet<string>, stamp: number) {
      floor = stamp;
      for (const [id, row] of rows)
        if (row.stamp < stamp && !keep.has(id))
          if (row.usable) rows.set(id, { ...row, usable: false, stamp });
          else rows.delete(id);
    },
  };
}

/**
 * Which threads may show their environment's branch PR, answered from the
 * active thread and environment lists (a few pages) instead of one read per
 * thread and environment. Thread events keep the lists current; a call
 * finding them older than LISTS_TTL_MS answers at once and reads them again
 * in the background. Threads missing from the lists (archived, created a
 * moment ago) and environments missing or not settled (destroyed, still
 * provisioning) are read one by one, as before.
 *
 * A read that changes a kept value (an environment's eligibility, a thread's
 * environment) is announced on BRANCH_PULL_REQUESTS_CHANGED, so clients ask
 * again; a failed read announces nothing. The clients' 60 s safety poll
 * covers whatever this misses.
 */
export function createEligibilityCache(
  bb: BbPluginApi,
  { listsDeadlineMs = LISTS_DEADLINE_MS } = {},
) {
  let sequence = 0;
  const threads = stampedTable<string | null>();
  const environments = stampedTable<boolean>();
  // When the lists were last read whole, and when they may be read again.
  let listedAt = -Infinity;
  let nextListAt = -Infinity;
  let listing: Promise<void> | null = null;
  let disposed = false;
  let announceTimer: ReturnType<typeof setTimeout> | undefined;

  const announce = () => {
    if (disposed || announceTimer) return;
    announceTimer = setTimeout(() => {
      announceTimer = undefined;
      if (!disposed) bb.realtime.publish(BRANCH_PULL_REQUESTS_CHANGED, {});
    }, 100);
  };
  // Writes announce when they replace a different value; a first value, or
  // one written after its row was dropped, announces nothing.
  const recordThread = (
    threadId: string,
    environmentId: string | null,
    usable: boolean,
    stamp: number,
  ) => {
    const before = threads.last(threadId);
    threads.write(threadId, environmentId, usable, stamp);
    const after = threads.last(threadId);
    if (before !== undefined && after !== before) announce();
  };
  // Only a ready or destroyed environment's branch is settled enough to keep.
  // The list leaves destroyed ones out, so each list read drops them again.
  const recordEnvironment = (environment: Environment, stamp: number) => {
    const eligible = isBranchPullRequestEnvironment(environment);
    const settled = environment.status === "ready" || environment.status === "destroyed";
    const before = environments.last(environment.id);
    environments.write(environment.id, eligible, settled, stamp);
    const after = environments.last(environment.id);
    if (before !== undefined && after !== before) announce();
    return eligible;
  };

  const readPages = async <T>(
    read: (offset: number) => Promise<T[]>,
    signal: AbortSignal,
  ) => {
    const rows: T[] = [];
    for (let offset = 0; ; offset += PAGE) {
      signal.throwIfAborted();
      const page = await abortable(read(offset), signal);
      rows.push(...page);
      if (page.length < PAGE) return rows;
    }
  };
  const readLists = async () => {
    const stamp = ++sequence;
    // A stalled read must not hold every later refresh.
    const signal = AbortSignal.timeout(listsDeadlineMs);
    const [threadRows, environmentRows] = await Promise.all([
      readPages(
        (offset) =>
          bb.sdk.threads.list({ archived: false, includeHidden: true, limit: PAGE, offset, signal }),
        signal,
      ),
      readPages((offset) => bb.sdk.environments.list({ limit: PAGE, offset, signal }), signal),
    ]);
    if (disposed) return;
    for (const thread of threadRows) recordThread(thread.id, thread.environmentId, true, stamp);
    threads.retain(new Set(threadRows.map((thread) => thread.id)), stamp);
    for (const environment of environmentRows) recordEnvironment(environment, stamp);
    environments.retain(new Set(environmentRows.map((e) => e.id)), stamp);
    listedAt = Date.now();
  };
  // At most one read of the lists at a time. A failure keeps the last lists;
  // the next try waits for the TTL like any refresh.
  const refreshLists = (): Promise<void> => {
    if (listing || disposed) return listing ?? Promise.resolve();
    nextListAt = Date.now() + LISTS_TTL_MS;
    listing = readLists()
      .catch((cause: unknown) => {
        bb.log.warn(
          `Reading the thread and environment lists for branch PRs failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      })
      .finally(() => {
        listing = null;
      });
    return listing;
  };

  // One read of an environment at a time; asking again meanwhile earns one
  // more read once it ends. A failed read leaves the environment to be read
  // by the next call.
  const rereads = new Map<string, boolean>();
  const rereadEnvironment = (environmentId: string) => {
    if (rereads.has(environmentId)) {
      rereads.set(environmentId, true);
      return;
    }
    rereads.set(environmentId, false);
    const stamp = ++sequence;
    void bb.sdk.environments
      .get({ environmentId })
      .then(
        (environment) => {
          if (!disposed) recordEnvironment(environment, stamp);
        },
        () => {
          if (!disposed) environments.invalidate(environmentId, stamp);
        },
      )
      // A read that outlives a plugin reload finds its API handle stale.
      .catch(() => {})
      .finally(() => {
        const again = rereads.get(environmentId);
        rereads.delete(environmentId);
        if (again && !disposed) rereadEnvironment(environmentId);
      });
  };
  // A thread event carries the thread as it is now: its environment replaces
  // the listed one. The environment is read again when it is not kept, or
  // when a turn ends or fails (an agent may have switched its branch).
  const threadChanged = (
    thread: { id: string; environmentId: string | null; archivedAt: number | null; deletedAt: number | null },
    turnEnded: boolean,
  ) => {
    if (disposed) return;
    const live = thread.archivedAt === null && thread.deletedAt === null;
    recordThread(thread.id, thread.environmentId, live, ++sequence);
    const environmentId = thread.environmentId;
    if (live && environmentId !== null && (turnEnded || environments.get(environmentId) === undefined))
      rereadEnvironment(environmentId);
  };
  for (const event of [
    "thread.created",
    "thread.active",
    "thread.unarchived",
    "thread.archived",
    "thread.deleted",
  ] as const)
    bb.events.on(event, ({ thread }) => threadChanged(thread, false));
  for (const event of ["thread.idle", "thread.failed"] as const)
    bb.events.on(event, ({ thread }) => threadChanged(thread, true));

  return {
    dispose() {
      disposed = true;
      clearTimeout(announceTimer);
    },
    async eligibility(threadIds: readonly string[]) {
      const ids = [...new Set(threadIds)];
      const counts = { threadReads: 0, environmentReads: 0 };
      const due = Date.now() >= nextListAt;
      if (listedAt === -Infinity) {
        // Until the lists are first read, a call waits for them (the first
        // call starts them), but a stalled or failed read leaves it to the
        // reads one by one.
        const first = due ? refreshLists() : listing;
        let timer: ReturnType<typeof setTimeout> | undefined;
        if (first)
          await Promise.race([
            first,
            new Promise<void>((resolve) => (timer = setTimeout(resolve, FIRST_LISTS_WAIT_MS))),
          ]).finally(() => clearTimeout(timer));
      } else if (due) void refreshLists();
      const listsAgeMs = Date.now() - listedAt;

      const eligible: Record<string, boolean> = {};
      // Threads sharing an environment share one lookup; the same project
      // checkout backs every thread on it.
      const reads = new Map<string, Promise<boolean>>();
      const evaluate = async (threadId: string): Promise<void> => {
        let environmentId = threads.get(threadId);
        if (environmentId === undefined) {
          counts.threadReads++;
          environmentId = (await bb.sdk.threads.get({ threadId })).environmentId;
        }
        if (environmentId === null) return;
        const kept = environments.get(environmentId);
        if (kept !== undefined) {
          eligible[threadId] = kept;
          return;
        }
        let pending = reads.get(environmentId);
        if (pending === undefined) {
          counts.environmentReads++;
          const stamp = ++sequence;
          pending = bb.sdk.environments
            .get({ environmentId })
            .then((environment) => recordEnvironment(environment, stamp));
          reads.set(environmentId, pending);
        }
        eligible[threadId] = await pending;
      };
      const unknown: string[] = [];
      for (const threadId of ids) {
        const environmentId = threads.get(threadId);
        if (environmentId === null) continue;
        const kept = environmentId === undefined ? undefined : environments.get(environmentId);
        if (kept !== undefined) eligible[threadId] = kept;
        else unknown.push(threadId);
      }
      for (let start = 0; start < unknown.length; start += LOOKUP_BATCH) {
        await Promise.all(
          unknown.slice(start, start + LOOKUP_BATCH).map(async (threadId) => {
            try {
              await evaluate(threadId);
            } catch {
              // A thread deleted mid-list or a read hiccup leaves it
              // unevaluated, and its row keeps showing the branch PR.
            }
          }),
        );
      }
      return { eligible, ids: ids.length, listsAgeMs, ...counts };
    },
  };
}

export function registerBranchPullRequests(bb: BbPluginApi) {
  const cache = createEligibilityCache(bb);
  bb.onDispose(() => cache.dispose());
  bb.rpc.register(branchPullRequestContract, {
    branchPullRequestEligibility: async ({ threadIds }) => {
      const startedAt = performance.now();
      const { eligible, ids, listsAgeMs, threadReads, environmentReads } =
        await cache.eligibility(threadIds);
      const elapsedMs = Math.round(performance.now() - startedAt);
      if (elapsedMs >= SLOW_CALL_MS)
        bb.log.warn(
          `branchPullRequestEligibility took ${elapsedMs} ms: ids=${ids} threadReads=${threadReads} environmentReads=${environmentReads} listsAgeMs=${Number.isFinite(listsAgeMs) ? Math.round(listsAgeMs) : "none"}`,
        );
      return { eligible };
    },
  });
}
