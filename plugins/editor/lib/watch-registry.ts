/**
 * Which clients want change notices for which workspace root. The server
 * keeps one entry per root on a host; a client's registration lasts
 * `WATCH_TTL_MS` unless renewed, so a page that vanished stops costing a
 * watch after a while.
 */

/** How long a client's ask lasts; clients renew at half of it. */
export const WATCH_TTL_MS = 5 * 60 * 1000;

export interface WatchEntry {
  hostId: string;
  rootPath: string;
  /** The name the realtime signal carries; it hides the host id and the path. */
  key: string;
  /** Whether the host confirmed a live watch for this root. */
  watching: boolean;
  clients: Map<string, number>;
}

const idOf = (hostId: string, rootPath: string) => `${hostId}\0${rootPath}`;

export class WatchRegistry {
  private readonly entries = new Map<string, WatchEntry>();
  private nextKey = 1;

  get(hostId: string, rootPath: string): WatchEntry | undefined {
    return this.entries.get(idOf(hostId, rootPath));
  }

  register(hostId: string, rootPath: string, clientId: string, expiresAt: number): WatchEntry {
    const id = idOf(hostId, rootPath);
    let entry = this.entries.get(id);
    if (entry === undefined) {
      entry = { hostId, rootPath, key: `w${this.nextKey++}`, watching: false, clients: new Map() };
      this.entries.set(id, entry);
    }
    entry.clients.set(clientId, expiresAt);
    return entry;
  }

  /** True when the root lost its last client and the host should stop. */
  unregister(hostId: string, rootPath: string, clientId: string): boolean {
    const entry = this.get(hostId, rootPath);
    if (entry === undefined || !entry.clients.delete(clientId)) return false;
    if (entry.clients.size > 0) return false;
    this.entries.delete(idOf(hostId, rootPath));
    return true;
  }

  rootsOn(hostId: string): string[] {
    return this.entriesOn(hostId).map((entry) => entry.rootPath);
  }

  entriesOn(hostId: string): WatchEntry[] {
    return [...this.entries.values()].filter((entry) => entry.hostId === hostId);
  }

  markWatching(hostId: string, watching: readonly string[]): void {
    const live = new Set(watching);
    for (const entry of this.entriesOn(hostId)) entry.watching = live.has(entry.rootPath);
  }

  /** Drops expired clients and empty roots; returns the hosts whose set changed. */
  prune(now: number): string[] {
    const changed = new Set<string>();
    for (const [id, entry] of this.entries) {
      for (const [clientId, expiresAt] of entry.clients) if (expiresAt <= now) entry.clients.delete(clientId);
      if (entry.clients.size === 0) {
        this.entries.delete(id);
        changed.add(entry.hostId);
      }
    }
    return [...changed];
  }

  clear(): void {
    this.entries.clear();
  }
}
