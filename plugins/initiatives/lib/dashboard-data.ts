import type { ReadTimeoutReport } from "./contract";
import { REPORT_INTERVAL_MS, ReadTimeoutError, withReadTimeout } from "./read-timeout";

/**
 * A read for refresh. A read that also carries another key's data (the panel read carries its
 * Initiative's overview) passes it to seed, which keeps it only while the read is current and
 * the other key has not been written or saved since the read began (W248).
 */
export type Fetch = (seed: (key: string, data: unknown) => void) => Promise<unknown>;

/** Read sharing for the app session. Native RPC/realtime remain the transport. */
export class SharedReads {
  private entries = new Map<string, {
    data: unknown; error: string | null; loaded: boolean; epoch: number;
    pending: Promise<void> | null; listeners: Set<() => void>; holds: number;
    timer?: ReturnType<typeof setTimeout>;
    /** A change arrived while a read or save was in flight: read again once it clears. */
    again?: Fetch;
    /** Failed reads in a row. */
    misses: number;
    /** clock when its data was last written or a save of it began or ended. */
    at: number;
  }>();
  private clock = 0;
  /** Sends a timed-out read's report; the app wires it to its RPC. */
  reporter: ((report: ReadTimeoutReport & { read: string }) => void) | null = null;
  private lastReportAt = -Infinity;
  entry(key: string) {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { data: null, error: null, loaded: false, epoch: 0, pending: null, listeners: new Set(), holds: 0, misses: 0, at: 0 };
      this.entries.set(key, entry);
    }
    return entry;
  }
  private publish(key: string) { for (const listener of this.entry(key).listeners) listener(); }
  /** At most one report per REPORT_INTERVAL_MS for the app session. */
  private report(key: string, error: ReadTimeoutError) {
    const now = Date.now();
    if (!this.reporter || now - this.lastReportAt < REPORT_INTERVAL_MS) return;
    this.lastReportAt = now;
    this.reporter({ read: key.split(":")[0]!.slice(0, 40), ...error.report });
  }
  refresh(key: string, fetch: Fetch): Promise<void> {
    const entry = this.entry(key);
    if (entry.holds) return Promise.resolve();
    if (entry.pending) return entry.pending;
    const epoch = entry.epoch;
    const started = this.clock;
    let settled = false;
    const seed = (other: string, data: unknown) => {
      if (!settled && entry.epoch === epoch && this.entry(other).at <= started) this.seed(other, data);
    };
    const pending = Promise.resolve().then(() => withReadTimeout(fetch(seed))).finally(() => { settled = true; }).then(data => {
      if (entry.epoch === epoch) { entry.misses = 0; entry.data = data; entry.error = null; entry.loaded = true; entry.at = ++this.clock; this.publish(key); }
    }, error => {
      if (error instanceof ReadTimeoutError) this.report(key, error);
      if (entry.epoch !== epoch) return;
      // One missed read stays quiet and reads again at once: it is usually a
      // tab or device that slept, or a stale connection. The last value stays
      // up either way; the error shows from the second miss in a row.
      if (++entry.misses === 1) { if (entry.listeners.size) entry.again ??= fetch; return; }
      entry.error = error instanceof Error ? error.message : String(error); entry.loaded = true; this.publish(key);
    }).finally(() => { if (entry.pending === pending) entry.pending = null; this.catchUp(key); });
    entry.pending = pending;
    return pending;
  }
  /**
   * A change announced while a read is in flight may postdate what that read
   * returns (a delegate's signal during a read another signal started), so the
   * scheduled read runs after it instead of joining it. A save in progress
   * defers it the same way.
   */
  schedule(key: string, fetch: Fetch) {
    const entry = this.entry(key);
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (!entry.listeners.size) return;
      if (entry.pending || entry.holds) entry.again = fetch;
      else void this.refresh(key, fetch);
    }, 150);
  }
  private catchUp(key: string) {
    const entry = this.entry(key);
    const again = entry.again;
    if (!again || entry.pending || entry.holds) return;
    entry.again = undefined;
    if (entry.listeners.size) void this.refresh(key, again);
  }
  subscribe(key: string, listener: () => void) {
    const entry = this.entry(key); entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
      if (!entry.listeners.size && entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
    };
  }
  /**
   * Store data another read returned for this key (a refresh's seed passes it
   * on while current). A held key keeps its pending save; a newer seed wins
   * over any older fetch still in flight.
   */
  seed(key: string, data: unknown) {
    const entry = this.entry(key);
    if (entry.holds) return;
    entry.epoch++; entry.pending = null; entry.misses = 0;
    entry.data = data; entry.error = null; entry.loaded = true; entry.at = ++this.clock;
    this.publish(key);
  }
  /** Forget every entry (tests). */
  clear() {
    for (const entry of this.entries.values()) if (entry.timer) clearTimeout(entry.timer);
    this.entries.clear();
  }
  /** Reject pre-save snapshots and hold optional reads until the RPC settles. */
  begin(key: string) {
    const entry = this.entry(key); entry.holds++; entry.epoch++; entry.pending = null; entry.at = ++this.clock;
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
    let ended = false;
    return (update?: (data: unknown) => unknown) => {
      if (ended) return; ended = true;
      entry.holds--; entry.epoch++; entry.pending = null; entry.at = ++this.clock;
      if (update && entry.data !== null) { entry.data = update(entry.data); this.publish(key); }
      this.catchUp(key);
    };
  }
}
/**
 * One cache for the app session, shared by every mounted panel and page: a
 * thread revisited later paints its Initiative from here at once, then
 * revalidates. RPC clients are per mount, so they cannot scope it.
 */
export const appReads = new SharedReads();
