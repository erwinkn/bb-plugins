/** Realm-local read sharing. Native RPC/realtime remain the transport. */
export class SharedReads {
  private entries = new Map<string, {
    data: unknown; error: string | null; loaded: boolean; epoch: number;
    pending: Promise<void> | null; listeners: Set<() => void>; holds: number;
    timer?: ReturnType<typeof setTimeout>;
  }>();
  entry(key: string) {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { data: null, error: null, loaded: false, epoch: 0, pending: null, listeners: new Set(), holds: 0 };
      this.entries.set(key, entry);
    }
    return entry;
  }
  private publish(key: string) { for (const listener of this.entry(key).listeners) listener(); }
  refresh(key: string, fetch: () => Promise<unknown>): Promise<void> {
    const entry = this.entry(key);
    if (entry.holds) return Promise.resolve();
    if (entry.pending) return entry.pending;
    const epoch = entry.epoch;
    const pending = Promise.resolve().then(fetch).then(data => {
      if (entry.epoch === epoch) { entry.data = data; entry.error = null; entry.loaded = true; this.publish(key); }
    }, error => {
      if (entry.epoch === epoch) { entry.error = error instanceof Error ? error.message : String(error); entry.loaded = true; this.publish(key); }
    }).finally(() => { if (entry.pending === pending) entry.pending = null; });
    entry.pending = pending;
    return pending;
  }
  schedule(key: string, fetch: () => Promise<unknown>) {
    const entry = this.entry(key);
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (entry.listeners.size) void this.refresh(key, fetch);
    }, 150);
  }
  subscribe(key: string, listener: () => void) {
    const entry = this.entry(key); entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
      if (!entry.listeners.size && entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
    };
  }
  /** Reject pre-save snapshots and hold optional reads until the RPC settles. */
  begin(key: string) {
    const entry = this.entry(key); entry.holds++; entry.epoch++; entry.pending = null;
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
    let ended = false;
    return (update?: (data: unknown) => unknown) => {
      if (ended) return; ended = true;
      entry.holds--; entry.epoch++; entry.pending = null;
      if (update && entry.data !== null) { entry.data = update(entry.data); this.publish(key); }
    };
  }
}
const caches = new WeakMap<object, SharedReads>();
export function sharedReads(scope: object) {
  let cache = caches.get(scope);
  if (!cache) { cache = new SharedReads(); caches.set(scope, cache); }
  return cache;
}
