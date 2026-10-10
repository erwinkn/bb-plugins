import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { errorMessage } from "./memory";
import { READ_FAILED, type MemoryStore, type MemoryThread, type Scope } from "./store";

type Sdk = BbPluginApi["sdk"];

/**
 * W215: a long-running agent re-reads its whole context on every request, so each one costs more
 * as the chat runs (Equisafe's coordinator grew from 25k to 554k tokens in 14 hours). Once an
 * attached thread's context passes its scope's limit, it is compacted in place with BB's own
 * compaction (threads.compact: Claude Code's /compact, Codex's thread compaction).
 *
 * It runs only when the thread goes idle (and from the sweep, to try a failed one again), and BB
 * itself refuses unless the thread is idle or errored, so a turn is never cut. The size is BB's
 * record, read fresh: the latest context-window snapshot, unless a compaction or clear came after
 * it (the size is then unknown until the next turn ends). One thread is not compacted twice within
 * COMPACT_INTERVAL_MS, so a context that stays large never loops.
 *
 * D458: a failed compaction is never taken for a done one. It is kept on the thread (shown in the
 * memory's problems until one succeeds) and tried again RETRY_MS later, at most COMPACT_TRIES times
 * per snapshot; a later turn's snapshot starts over. Reading the size is part of it (A471): a read
 * that fails is kept the same way, as a try of an unknown snapshot (READ_FAILED), and a thread is
 * read again RETRY_MS later; a read that works again clears it.
 */
const COMPACT_INTERVAL_MS = 30 * 60_000;
export const COMPACT_TRIES = 3;
const RETRY_MS = 2 * 60_000;
const CONTEXT_EVIDENCE = ["thread/contextWindowUsage/updated", "thread/compacted", "thread/context/cleared"] as const;

/** The used tokens a thread/contextWindowUsage/updated row records, in either payload shape. */
export function contextUsedTokens(data: unknown): number | null {
  const usage = (data as { contextWindowUsage?: { snapshot?: { usedTokens: number | null }; usedTokens?: number } })?.contextWindowUsage;
  return (usage?.snapshot ? usage.snapshot.usedTokens : usage?.usedTokens) ?? null;
}

export function createCompaction(deps: {
  sdk: Sdk;
  store: MemoryStore;
  /** The scope's compaction limit; 0 is off. */
  limit: (scope: Scope) => number;
  log: (message: string) => void;
  /** A compaction failed or recovered: the memory's problems changed. */
  changed?: (scopeId: string) => void;
}) {
  const compacting = new Set<string>();
  /** The limit when this thread may be compacted now, else null. Rechecked after every await. */
  const eligible = (threadId: string) => {
    const scope = deps.store.scopeOf(threadId);
    const limit = scope ? deps.limit(scope) : 0;
    if (!scope || limit <= 0 || compacting.has(threadId)) return null;
    const thread = deps.store.thread(threadId);
    if (!thread || deps.store.now() - (thread.compactedAt ?? -Infinity) < COMPACT_INTERVAL_MS) return null;
    return { scope, thread, limit };
  };
  /** Whether snapshot `seq` is still to try: new, or failed fewer than COMPACT_TRIES times and RETRY_MS ago. */
  const due = (m: MemoryThread, seq: number) =>
    m.compactedSeq !== seq || (m.compactError !== null && m.compactTries < COMPACT_TRIES && deps.store.now() - (m.compactTriedAt ?? -Infinity) >= RETRY_MS);
  return {
    /** Compact the thread when its last turn left it larger than its scope's limit. */
    async afterIdle(threadId: string, signal: AbortSignal): Promise<boolean> {
      const before = eligible(threadId);
      if (!before) return false;
      // A failed read is read again RETRY_MS later: by the sweep while it has failed fewer than
      // COMPACT_TRIES times, and after each later turn.
      const { thread } = before;
      if (thread.compactedSeq === READ_FAILED && thread.compactError !== null && deps.store.now() - (thread.compactTriedAt ?? -Infinity) < RETRY_MS) return false;
      let rows: Array<{ seq: number; type: string; data: unknown }>;
      try {
        // One row: the newest of the three. Per-type limits would return more, so take the latest.
        rows = (await deps.sdk.threads.events.list({ threadId, types: CONTEXT_EVIDENCE, order: "desc", limit: "1", signal } as never)) as typeof rows;
      } catch (error) {
        if (signal.aborted) return false;
        const why = `reading its context size failed: ${errorMessage(error)}`;
        deps.store.compactTry(threadId, READ_FAILED);
        deps.store.compactFailed(threadId, why);
        deps.log(`${threadId}: ${why}`);
        deps.changed?.(before.scope.id);
        return false;
      }
      if (signal.aborted) return false;
      if (deps.store.compactReadRecovered(threadId)) deps.changed?.(before.scope.id);
      const latest = rows.reduce<(typeof rows)[number] | undefined>((a, b) => (!a || b.seq > a.seq ? b : a), undefined);
      if (latest?.type !== "thread/contextWindowUsage/updated") return false;
      const used = contextUsedTokens(latest.data);
      const now = eligible(threadId);
      if (!now || used === null || used <= now.limit || !due(now.thread, latest.seq)) return false;
      const { scope } = now;
      deps.store.compactTry(threadId, latest.seq);
      const size = `~${Math.round(used / 1000)}k tokens (limit ${Math.round(now.limit / 1000)}k)`;
      compacting.add(threadId);
      try {
        // BB's SDK does not cancel an issued POST, so the signal only guards what follows it.
        await deps.sdk.threads.compact({ threadId, signal } as never);
        if (signal.aborted) return false;
        deps.store.compactDone(threadId);
        deps.log(`${threadId}: context at ${size}, compacting it between turns`);
        if (now.thread.compactError !== null) deps.changed?.(scope.id);
        return true;
      } catch (error) {
        if (signal.aborted) return false;
        const why = errorMessage(error);
        deps.store.compactFailed(threadId, why);
        deps.log(`${threadId}: context at ${size} could not be compacted: ${why}`);
        deps.changed?.(scope.id);
        return false;
      } finally {
        compacting.delete(threadId);
      }
    },
  };
}
export type Compaction = ReturnType<typeof createCompaction>;
