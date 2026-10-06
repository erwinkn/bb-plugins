import type { LiveThread } from "./overview";

/** The lifecycle fields of a native thread DTO the dashboard shows. */
interface NativeThread {
  id: string;
  status: string;
  archivedAt: number | null;
  deletedAt: number | null;
  title: string | null;
  environmentId?: string | null;
  projectId?: string | null;
  parentThreadId?: string | null;
}

/** How long a native fact serves dashboard reads before it is read again. */
export const LIVE_TTL_MS = 30_000;
/** Facts no read asked for in this long are dropped. */
const LIVE_IDLE_MS = 10 * 60_000;

const liveOf = (thread: NativeThread): LiveThread => ({
  status: thread.deletedAt !== null ? "deleted" : thread.status,
  archived: thread.archivedAt !== null,
  title: thread.title,
  environmentId: thread.environmentId,
  projectId: thread.projectId,
  parentThreadId: thread.parentThreadId,
});
const GONE: LiveThread = { status: "deleted", archived: true, title: null };

/**
 * Native status for the dashboard, read once per thread and kept current by
 * thread lifecycle events, so opening or refreshing an Initiative does not
 * wait on reading every member again. A fact older than LIVE_TTL_MS is still
 * answered, then re-read in the background, which also heals any transition
 * no event announced. Presentation only: ledger decisions never read it.
 */
export class LiveThreads {
  private facts = new Map<string, { live: LiveThread; at: number; asked: number; version: number }>();
  private reads = new Map<string, Promise<void>>();

  constructor(
    private readonly read: (threadId: string) => Promise<NativeThread>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** A lifecycle event carries the current DTO: refresh a thread already shown. */
  observe(thread: NativeThread) {
    const fact = this.facts.get(thread.id);
    if (!fact && !this.reads.has(thread.id)) return;
    this.facts.set(thread.id, {
      live: liveOf(thread),
      at: this.now(),
      asked: fact?.asked ?? this.now(),
      version: (fact?.version ?? 0) + 1,
    });
  }

  /**
   * Facts for `threadIds`. Unknown threads are read before answering; stale
   * ones are answered as they are and re-read in the background, calling
   * `revalidated` if that changed any of them. `fresh` starts its own read of
   * every thread and answers from those, never from a read already in
   * flight. A 404 reads as deleted.
   */
  async get(
    threadIds: string[],
    { fresh = false, revalidated }: { fresh?: boolean; revalidated?: () => void } = {},
  ): Promise<Map<string, LiveThread>> {
    const now = this.now();
    for (const [id, fact] of this.facts)
      if (now - fact.asked > LIVE_IDLE_MS) this.facts.delete(id);
    if (fresh) {
      const ids = [...new Set(threadIds)];
      const read = await Promise.all(ids.map((id) => this.readNow(id)));
      return new Map(ids.map((id, index) => [id, read[index]!]));
    }
    const missing: string[] = [];
    const stale: string[] = [];
    for (const id of new Set(threadIds)) {
      const fact = this.facts.get(id);
      if (fact) fact.asked = now;
      if (!fact) missing.push(id);
      else if (now - fact.at >= LIVE_TTL_MS) stale.push(id);
    }
    if (stale.length) void this.revalidate(stale, revalidated);
    await Promise.all(missing.map((id) => this.load(id)));
    const live = new Map<string, LiveThread>();
    for (const id of threadIds) {
      const fact = this.facts.get(id);
      if (fact) live.set(id, fact.live);
    }
    return live;
  }

  /** One direct read whose answer the caller uses; it also refreshes the shared fact. */
  private async readNow(threadId: string): Promise<LiveThread> {
    const version = this.facts.get(threadId)?.version;
    let live: LiveThread;
    try {
      live = liveOf(await this.read(threadId));
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
      live = GONE;
    }
    const fact = this.facts.get(threadId);
    // A newer event keeps its fact; an older pending read is superseded by the version bump.
    if (fact?.version === version)
      this.facts.set(threadId, { live, at: this.now(), asked: fact?.asked ?? this.now(), version: (version ?? 0) + 1 });
    return live;
  }

  private async revalidate(threadIds: string[], revalidated?: () => void) {
    const shown = (id: string) => JSON.stringify(this.facts.get(id)?.live);
    const before = threadIds.map(shown);
    // A failed read keeps the stale fact; the next request retries it.
    await Promise.allSettled(threadIds.map((id) => this.load(id)));
    if (threadIds.some((id, index) => shown(id) !== before[index])) revalidated?.();
  }

  private load(threadId: string) {
    const pending = this.reads.get(threadId);
    if (pending) return pending;
    const version = this.facts.get(threadId)?.version ?? 0;
    const settle = (live: LiveThread) => {
      // An event that landed during the read is newer than this response.
      if ((this.facts.get(threadId)?.version ?? 0) !== version) return;
      this.facts.set(threadId, { live, at: this.now(), asked: this.now(), version });
    };
    const read = this.read(threadId)
      .then(
        (thread) => settle(liveOf(thread)),
        (error) => {
          if ((error as { status?: number }).status !== 404) throw error;
          settle(GONE);
        },
      )
      .finally(() => this.reads.delete(threadId));
    this.reads.set(threadId, read);
    return read;
  }
}

/**
 * One native read shared by every caller for `ttl`; failures are not kept.
 * For slow-changing context (project sources, environments, defaults).
 */
export class Recent<T> {
  private entries = new Map<string, { value: Promise<T>; at: number }>();
  constructor(
    private readonly ttl: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    const entry = this.entries.get(key);
    if (entry && this.now() - entry.at < this.ttl) return entry.value;
    const value = load();
    this.entries.set(key, { value, at: this.now() });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    return value;
  }
}
