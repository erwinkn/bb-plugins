import { z } from "zod";
import { errorMessage, type Sdk } from "./bb";
import type { Store, WorkerRecord } from "./store";

/**
 * T142: more work for an idle worker whose prompt cache has expired re-sends its whole context
 * as a cache write. Above a size, a fresh worker with the old one's report embedded is far
 * cheaper (W188 spent 356M tokens over 19 fix rounds), so the coordinator gets that choice with
 * the numbers instead of a silent rewrite. Running, warm and small workers pass silently.
 *
 * Cache state comes from the Account Pooler (threads.cacheState): the cached prefix, when the
 * entry expires and whether warming keeps it alive. Without it (not installed, failed, slower
 * than 2 s, or no record of the thread) the work goes ahead: missing evidence never blocks
 * (D426). BB's own context record only corrects the size: a context snapshot or compaction newer
 * than the Pooler's last request means the context has changed since, usually shrunk.
 */
export const COLD_RESUME_DEFAULT_TOKENS = 150_000;
const POOLER_PLUGIN_ID = "account-pool-local";
const POOLER_TIMEOUT_MS = 2_000;
// Cache-write price relative to plain input, by entry TTL.
const WRITE_FACTOR = { "5m": 1.25, "1h": 2 } as const;

/** The Account Pooler's threads.cacheState output, as far as this guard reads it. */
const poolerCacheSchema = z.object({
  threads: z.array(z.object({
    threadId: z.string(),
    cache: z.object({
      lastRequestAt: z.number(),
      prefixTokens: z.number(),
      ttl: z.enum(["5m", "1h"]),
      coveredUntil: z.number(),
    }).nullable(),
  })),
});

/** A worker's prompt cache, from the Account Pooler. */
interface WorkerCache {
  contextTokens: number;
  lastRequestAt: number;
  coveredUntil: number;
  writeFactor: number;
}

export function createColdCacheGuard(deps: {
  sdk: Sdk;
  store: Store;
  limit: () => number;
  log: (message: string) => void;
}) {
  // Logged once until the Pooler answers again.
  let poolerFailed = false;

  /** null: the Pooler could not answer or has no record of the thread. */
  async function poolerCache(threadId: string): Promise<WorkerCache | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const output = await Promise.race([
        Promise.resolve().then(() => deps.sdk.plugins.callRpc({
          pluginId: POOLER_PLUGIN_ID,
          method: "threads.cacheState",
          input: { threadIds: [threadId] },
          outputSchema: poolerCacheSchema,
        })),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no answer within ${POOLER_TIMEOUT_MS / 1000} s`)), POOLER_TIMEOUT_MS);
        }),
      ]);
      poolerFailed = false;
      const cache = poolerCacheSchema.parse(output).threads.find(t => t.threadId === threadId)?.cache ?? null;
      return cache && {
        contextTokens: cache.prefixTokens,
        lastRequestAt: cache.lastRequestAt,
        coveredUntil: cache.coveredUntil,
        writeFactor: WRITE_FACTOR[cache.ttl],
      };
    } catch (error) {
      if (!poolerFailed) deps.log(`Cold-cache check skipped: the Account Pooler's cache state is unavailable (${errorMessage(error)}).`);
      poolerFailed = true;
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The context size, corrected by BB's record: a snapshot taken after the Pooler's last request
   * has the current size (smaller after a compaction). A compaction or clear with no snapshot
   * since leaves the size unknown: null.
   */
  function contextTokens(threadId: string, cache: WorkerCache): number | null {
    const usage = deps.store.usage(threadId);
    const snapshotAt = usage?.contextObservedAt ?? null;
    const changedAt = usage?.contextChangedAt ?? null;
    if (changedAt !== null && changedAt > cache.lastRequestAt && (snapshotAt === null || snapshotAt < changedAt)) return null;
    if (snapshotAt !== null && snapshotAt > cache.lastRequestAt && usage?.contextUsed != null)
      return Math.min(cache.contextTokens, usage.contextUsed);
    return cache.contextTokens;
  }

  const idle = (threadId: string) =>
    deps.sdk.threads.get({ threadId }).then(thread => thread.status === "idle", () => false);

  return {
    /**
     * Why more work for this worker should go to a fresh one instead, or null to go ahead.
     * reviewed: the W# a reviewer reviews, for its fresh-reviewer alternative.
     */
    async check(worker: WorkerRecord, reviewed: string | null): Promise<string | null> {
      const limit = deps.limit();
      if (limit <= 0 || !worker.threadId || worker.state === "retired") return null;
      const threadId = worker.threadId;
      if (!await idle(threadId)) return null;
      const cache = await poolerCache(threadId);
      const now = deps.store.now();
      if (!cache || now <= cache.coveredUntil) return null;
      const context = contextTokens(threadId, cache);
      if (context === null || context <= limit) return null;
      // The worker may have started a turn while the Pooler answered.
      if (!await idle(threadId)) return null;
      const alternative = worker.role === "review"
        ? `Spawn a fresh reviewer with reviews:"${reviewed ?? "W#"}" and handoffs:["${worker.ref}"] (its findings are embedded)`
        : `Spawn a fresh worker with handoffs:["${worker.ref}"] (its report is embedded)`;
      return `${worker.ref}'s cache is cold (last request ${duration(now - cache.lastRequestAt)} ago) and its context is ~${thousands(context)} tokens: resuming costs ~${thousands(context * cache.writeFactor)} tokens of cache rewrite. ${alternative}, or pass resumeCold:true to resume anyway.`;
    },
  };
}
export type ColdCacheGuard = ReturnType<typeof createColdCacheGuard>;

const thousands = (tokens: number) => `${Math.round(tokens / 1000)}k`;
const duration = (ms: number) => {
  const minutes = Math.round(ms / 60_000);
  return minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
};
