import { errorMessage, type Sdk } from "./bb";
import type { Store } from "./store";

/**
 * W215: a coordinator re-reads its whole context on every request, so each one costs more as
 * the Initiative runs (Equisafe's grew from 25k to 554k tokens in 14 hours). Once its context
 * passes a limit, it is compacted in place with BB's own compaction (threads.compact: Claude
 * Code's /compact, Codex's thread compaction). It keeps its thread, its workers' parent and
 * its notices; a handover to a fresh coordinator stays the coordinator's own choice.
 *
 * It runs only when the coordinator goes idle, and BB itself refuses unless the thread is idle
 * or errored, so a turn is never cut. The size is BB's record, read fresh rather than from the
 * usage sampler, whose cursor can lag behind a long turn (W218): the latest context-window
 * snapshot, unless a compaction or clear came after it (the size is then unknown until the
 * next turn ends). One snapshot triggers at most one attempt, and one thread is not compacted
 * twice within COMPACT_INTERVAL_MS, so a context that stays large never loops. It never
 * overlaps a coordinator replacement or start, or a handover being written: each skips or
 * waits while the other is in flight.
 */
export const COMPACT_COORDINATOR_DEFAULT_TOKENS = 300_000;
/**
 * D431: a hybrid coordinator compacts at half that. What a compaction drops stays one zoom away
 * in the memory tree. W216 priced Equisafe's day at $29 compacting at 150k, $39 at 300k, and $30
 * in pure tree mode.
 */
export const COMPACT_HYBRID_DEFAULT_TOKENS = 150_000;
const COMPACT_INTERVAL_MS = 30 * 60_000;
const CONTEXT_EVIDENCE = ["thread/contextWindowUsage/updated", "thread/compacted", "thread/context/cleared"] as const;

/** The used tokens a thread/contextWindowUsage/updated row records, in either payload shape. */
export function contextUsedTokens(data: unknown): number | null {
  const usage = (data as { contextWindowUsage?: { snapshot?: { usedTokens: number | null }; usedTokens?: number } })?.contextWindowUsage;
  return (usage?.snapshot ? usage.snapshot.usedTokens : usage?.usedTokens) ?? null;
}

export function createCoordinatorCompaction(deps: {
  sdk: Sdk;
  store: Store;
  /** The Initiative's compaction limit; 0 is off. */
  limit: (projectId: string) => number;
  /** A coordinator replacement or start is in flight for the project. */
  replacing: (projectId: string) => boolean;
}) {
  const attempted = new Map<string, number>();
  /** The compact call in flight, by project; a replacement waits for it (see settled). */
  const compacting = new Map<string, Promise<unknown>>();
  /** The limit when this thread may be compacted now, else null. Rechecked after every await. */
  const eligible = (projectId: string, threadId: string) => {
    const limit = deps.limit(projectId);
    if (limit <= 0) return null;
    const project = deps.store.project(projectId);
    if (!project || project.coordinatorThreadId !== threadId || project.archivedAt !== null || project.paused) return null;
    if (deps.store.pendingHandover(projectId) || deps.replacing(projectId) || compacting.has(projectId)) return null;
    // A handover being written is captured from this context; compacting it would make the text stale.
    const draft = deps.store.handoverDraft(projectId);
    if (draft && (draft.state !== "ready" || draft.thenReplace)) return null;
    if (deps.store.now() - (attempted.get(threadId) ?? -Infinity) < COMPACT_INTERVAL_MS) return null;
    return limit;
  };
  return {
    enabled: (projectId: string) => deps.limit(projectId) > 0,
    /** Resolves once no compact call is in flight for the project. */
    async settled(projectId: string) {
      await compacting.get(projectId)?.catch(() => {});
    },
    /** Compact the current coordinator's thread when its last turn left it larger than the limit. */
    async afterIdle(projectId: string, threadId: string, signal: AbortSignal): Promise<boolean> {
      if (eligible(projectId, threadId) === null) return false;
      // One row: the newest of the three. Per-type limits would return more, so take the latest.
      const rows = await deps.sdk.threads.events.list({ threadId, types: CONTEXT_EVIDENCE, order: "desc", limit: "1", signal });
      if (signal.aborted) return false;
      const latest = rows.reduce<(typeof rows)[number] | undefined>((a, b) => (!a || b.seq > a.seq ? b : a), undefined);
      if (latest?.type !== "thread/contextWindowUsage/updated") return false;
      const used = contextUsedTokens(latest.data);
      const limit = eligible(projectId, threadId);
      if (limit === null || used === null || used <= limit) return false;
      const flag = `compact:${threadId}:${latest.seq}`;
      if (deps.store.hasFlag(flag)) return false;
      deps.store.setFlag(flag);
      attempted.set(threadId, deps.store.now());
      const size = `~${Math.round(used / 1000)}k tokens (limit ${Math.round(limit / 1000)}k)`;
      // BB's SDK does not cancel an issued POST, so the signal only guards what follows it: once
      // the plugin shuts down, the store may be closed and nothing more is written either way.
      const call = deps.sdk.threads.compact({ threadId, signal });
      compacting.set(projectId, call);
      try {
        await call;
        if (signal.aborted) return false;
        deps.store.log(projectId, "cache", `Coordinator context at ${size}: compacting it between turns`);
        return true;
      } catch (error) {
        if (signal.aborted) return false;
        deps.store.log(projectId, "cache", `Coordinator context at ${size} could not be compacted: ${errorMessage(error)}`);
        return false;
      } finally {
        compacting.delete(projectId);
      }
    },
  };
}
export type CoordinatorCompaction = ReturnType<typeof createCoordinatorCompaction>;
