/**
 * W244: one limit on summarizer calls in flight across every scope, so building every open
 * scope's tree (D447) never runs eight calls per scope at once. Waiting calls are let in
 * round-robin by scope: one large backlog cannot take every freed permit while a small one waits.
 * W315: an urgent call (for a node a turn is waiting for) goes before every other waiting call, so no
 * backlog holds a turn back. Urgency is asked each time a permit frees, not once: a turn can come
 * to need a call that is already waiting.
 * W568: after urgent calls, a scope of higher priority (an Adventure coordinator's) goes before
 * every scope of lower priority; scopes of one priority still take turns.
 * D586: an OptChat scope (a coordinator's or a worker's) whose view is over its ceiling has the
 * top priority (ChatMemory.priority).
 */
export class FairPermits {
  private active = 0;
  private scheduled = false;
  /** Waiting calls by scope; the map's order is the rotation. */
  private waiting = new Map<string, Waiter[]>();

  constructor(
    private readonly limit: () => number,
    private readonly priority: (owner: string) => number = () => 0,
  ) {}

  /** Calls in flight now (tests). */
  get inFlight() {
    return this.active;
  }

  /**
   * Runs work once a permit is free and holds it until work settles, an aborted call included.
   * Aborted while waiting, or between its grant and its turn to run, it never runs: the answer is null.
   */
  async run<T>(owner: string, signal: AbortSignal, work: () => Promise<T>, urgent: () => boolean = () => false): Promise<T | null> {
    if (!(await this.acquire(owner, signal, urgent))) return null;
    try {
      return signal.aborted ? null : await work();
    } finally {
      this.active--;
      this.schedule();
    }
  }

  private acquire(owner: string, signal: AbortSignal, urgent: () => boolean) {
    if (signal.aborted) return Promise.resolve(false);
    const granted = new Promise<boolean>((resolve) => {
      const queue = this.waiting.get(owner) ?? [];
      const waiter: Waiter = {
        urgent,
        grant: () => {
          signal.removeEventListener("abort", aborted);
          resolve(true);
        },
      };
      const aborted = () => {
        const k = queue.indexOf(waiter);
        if (k >= 0) queue.splice(k, 1);
        if (!queue.length && this.waiting.get(owner) === queue) this.waiting.delete(owner);
        resolve(false);
      };
      queue.push(waiter);
      this.waiting.set(owner, queue);
      signal.addEventListener("abort", aborted, { once: true });
    });
    this.schedule();
    return granted;
  }

  /**
   * W568: permits are given out once per macrotask, after every call asked for in it is waiting:
   * a scope whose call just ended asks for its next one in the same macrotask (its builder runs on
   * microtasks), so a coordinator's backlog keeps its permits rather than racing lower scopes.
   */
  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.admit();
    });
  }

  private admit() {
    while (this.active < Math.max(1, this.limit()) && this.waiting.size) {
      const [owner, queue, k] = this.next();
      const [waiter] = queue.splice(k, 1);
      // This scope goes to the back of the rotation, or leaves it with nothing left waiting.
      this.waiting.delete(owner);
      if (queue.length) this.waiting.set(owner, queue);
      this.active++;
      waiter!.grant();
    }
  }

  /** The first urgent call in rotation order, else the oldest call of the next scope of the highest priority. */
  private next(): [string, Waiter[], number] {
    let first: [string, Waiter[], number] | null = null;
    let best = -Infinity;
    for (const [owner, queue] of this.waiting) {
      const k = queue.findIndex((w) => w.urgent());
      if (k >= 0) return [owner, queue, k];
      const priority = this.priority(owner);
      if (priority > best) [first, best] = [[owner, queue, 0], priority];
    }
    return first!;
  }
}

interface Waiter {
  urgent: () => boolean;
  grant: () => void;
}
