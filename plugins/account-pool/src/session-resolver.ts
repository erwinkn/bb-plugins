// Finds the BB thread behind a Claude Code session no thread is linked to yet: the one running
// thread whose latest thread/identity event names the session. A lookup runs in the background and
// never delays a request. It is bounded: one pending lookup per session, at most maxConcurrent at
// once, each under its own deadline, and a session is looked up again at most every retryMs. Every
// SDK call gets the lookup's own signal, aborted at the deadline or on dispose, and the lookup stops
// waiting for a call once that signal aborts.
//
// A lookup links only a certain answer: every identity read succeeded and exactly one running
// thread reports the session. A failed read, or two threads reporting the same session, leaves the
// session unresolved; its next request after retryMs looks again.

import { abortable } from "./signals.js";
import type { WarmingTimers } from "./warming.js";

export interface SessionResolverDeps {
  now(): number;
  timers: WarmingTimers;
  listRunning(signal: AbortSignal): Promise<Array<{ id: string }>>;
  identity(threadId: string, signal: AbortSignal): Promise<string | null>;
  link(threadId: string, sessionId: string): void;
  log(message: string): void;
  timeoutMs?: number;
  retryMs?: number;
  maxConcurrent?: number;
}

const TIMEOUT_MS = 5_000;
const RETRY_MS = 30_000;
const MAX_CONCURRENT = 2;
const MAX_REMEMBERED = 256;

export class SessionResolver {
  private readonly pending = new Map<string, AbortController>();
  // When each session was last looked up, oldest first.
  private readonly attempts = new Map<string, number>();
  private disposed = false;

  constructor(private readonly deps: SessionResolverDeps) {}

  resolve(sessionId: string): void {
    if (this.disposed || this.pending.has(sessionId)) return;
    if (this.pending.size >= (this.deps.maxConcurrent ?? MAX_CONCURRENT)) return;
    const now = this.deps.now();
    const last = this.attempts.get(sessionId);
    if (last !== undefined && now - last < (this.deps.retryMs ?? RETRY_MS)) return;
    this.attempts.delete(sessionId);
    this.attempts.set(sessionId, now);
    while (this.attempts.size > MAX_REMEMBERED) {
      const oldest = this.attempts.keys().next();
      if (!oldest.done) this.attempts.delete(oldest.value);
    }
    const controller = new AbortController();
    const timer = this.deps.timers.setTimeout(
      () => controller.abort(new Error("session lookup timed out")),
      this.deps.timeoutMs ?? TIMEOUT_MS,
    );
    this.pending.set(sessionId, controller);
    // The lookup ends once every read has settled, or at the deadline or dispose. Whatever is still
    // running then is aborted before the slot is released.
    void this.lookUp(sessionId, controller.signal).finally(() => {
      this.deps.timers.clearTimeout(timer);
      controller.abort(new Error("session lookup finished"));
      if (this.pending.get(sessionId) === controller) this.pending.delete(sessionId);
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const controller of this.pending.values())
      controller.abort(new Error("Account Pooler stopped"));
    this.pending.clear();
  }

  private async lookUp(sessionId: string, signal: AbortSignal): Promise<void> {
    try {
      const running = await abortable(this.deps.listRunning(signal), signal);
      // allSettled: one failed read must not end the lookup while its siblings still run.
      const identities = await abortable(
        Promise.allSettled(running.map(({ id }) => this.deps.identity(id, signal))),
        signal,
      );
      if (signal.aborted) return;
      const failed = identities.find((result) => result.status === "rejected");
      if (failed !== undefined) throw failed.reason;
      const owners = running.filter((_, index) => {
        const result = identities[index];
        return result?.status === "fulfilled" && result.value === sessionId;
      });
      if (owners.length === 1) this.deps.link(owners[0]!.id, sessionId);
    } catch (error) {
      this.deps.log(
        `Account Pooler could not look up the thread of a Claude session: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
