import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  adventureWorkers,
  overviewSliceSchema,
  type AdventureWorker,
} from "./adventure-workers";
import { withReadTimeout } from "./read-timeout";

/**
 * An Adventure's facts are read again at most this often. The read is the
 * Initiatives overview (summary tier): about 1.2 MB and 1.5 s for an
 * Adventure of 80 workers, so a busy Adventure, which announces a change
 * every few seconds, costs one read per interval at most.
 */
export const FACTS_INTERVAL_MS = 30_000;
/** A client's picked Adventure stays refreshed this long after its last read. */
export const WANTED_MS = 120_000;

type Entry = { workers: AdventureWorker[] | null; readAt: number; dirty: boolean };

/**
 * The model and group of each picked Adventure's workers, which the tree does
 * not carry, shared by every client. `read` answers at once from what the
 * last reads found and marks the Adventures as wanted; a background loop,
 * one read at a time, reads the wanted ones that are new or announced as
 * changed, and announces on `onChanged` each answer that differs.
 */
export function createWorkerFacts(
  bb: BbPluginApi,
  readOverview: (projectId: string) => Promise<unknown>,
  onChanged: (projectId: string) => void,
) {
  const facts = new Map<string, Entry>();
  const wanted = new Map<string, number>();
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const refresh = () => {
    if (running || disposed) return;
    clearTimeout(timer);
    timer = undefined;
    const now = Date.now();
    for (const [id, at] of wanted) if (now - at > WANTED_MS) wanted.delete(id);
    const due = [...wanted.keys()].filter((id) => {
      const entry = facts.get(id);
      return !entry || entry.dirty;
    });
    if (!due.length) return;
    const next = (id: string) => (facts.get(id)?.readAt ?? -Infinity) + FACTS_INTERVAL_MS;
    const ready = due.filter((id) => next(id) <= now);
    if (!ready.length) {
      timer = setTimeout(() => {
        timer = undefined;
        refresh();
      }, Math.min(...due.map(next)) - now);
      return;
    }
    // One read per pass: the next pass decides again what is wanted and
    // still in the tree, so a slow read never leaves a stale queue behind it.
    // The most overdue first: one never read before one read again.
    const id = ready.reduce((a, b) => (next(b) < next(a) ? b : a));
    running = true;
    void (async () => {
      const before = facts.get(id)?.workers ?? null;
      // A change announced while this read runs marks the entry dirty again.
      facts.set(id, { workers: before, readAt: Date.now(), dirty: false });
      const read = readOverview(id);
      try {
        const workers = adventureWorkers(
          overviewSliceSchema.parse(await withReadTimeout(read)),
        );
        const entry = facts.get(id);
        // Gone from the tree meanwhile.
        if (!entry || disposed) return;
        facts.set(id, { ...entry, workers });
        if (JSON.stringify(before) !== JSON.stringify(workers)) onChanged(id);
      } catch (cause: unknown) {
        // Tried again once the interval allows.
        const entry = facts.get(id);
        if (entry) entry.dirty = true;
        bb.log.warn(
          `Reading the workers of Adventure ${id} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        // A read that timed out still runs: the next starts once it ends,
        // so at most one is ever outstanding.
        await read.catch(() => {});
      }
    })()
      // A read that outlives a plugin reload finds its API handle stale.
      .catch(() => {})
      .finally(() => {
        running = false;
        refresh();
      });
  };
  return {
    /** The known facts of these Adventures; unknown ones are absent until read. */
    read(projectIds: readonly string[]): Record<string, AdventureWorker[]> {
      const now = Date.now();
      const out: Record<string, AdventureWorker[]> = {};
      for (const id of projectIds) {
        wanted.set(id, now);
        const workers = facts.get(id)?.workers;
        if (workers) out[id] = workers;
      }
      refresh();
      return out;
    },
    /** An Adventure (or, without an id, every one) changed: read it again once allowed. */
    changed(projectId?: string) {
      for (const [id, entry] of facts)
        if (!projectId || id === projectId) entry.dirty = true;
      refresh();
    },
    /** Forgets the Adventures the tree no longer lists. */
    retain(projectIds: ReadonlySet<string>) {
      for (const id of facts.keys()) if (!projectIds.has(id)) facts.delete(id);
      for (const id of wanted.keys()) if (!projectIds.has(id)) wanted.delete(id);
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
    },
  };
}
