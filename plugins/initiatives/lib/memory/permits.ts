/**
 * W244: one limit on summarizer calls in flight across every Initiative, so building every live
 * Initiative's tree (D447) never runs eight calls per Initiative at once. Waiting calls are let
 * in round-robin by Initiative: one large backlog cannot take every freed permit while a small
 * one waits.
 */
export class FairPermits {
  private active = 0;
  /** Waiting calls by Initiative; the map's order is the rotation. */
  private waiting = new Map<string, (() => void)[]>();

  constructor(private readonly limit: () => number) {}

  /** Calls in flight now (tests). */
  get inFlight() {
    return this.active;
  }

  /**
   * Runs work once a permit is free and holds it until work settles, an aborted call included.
   * Aborted while waiting, it never runs: the answer is null.
   */
  async run<T>(owner: string, signal: AbortSignal, work: () => Promise<T>): Promise<T | null> {
    if (!(await this.acquire(owner, signal))) return null;
    try {
      return await work();
    } finally {
      this.active--;
      this.admit();
    }
  }

  private acquire(owner: string, signal: AbortSignal) {
    if (signal.aborted) return Promise.resolve(false);
    const granted = new Promise<boolean>((resolve) => {
      const queue = this.waiting.get(owner) ?? [];
      const grant = () => {
        signal.removeEventListener("abort", aborted);
        resolve(true);
      };
      const aborted = () => {
        const k = queue.indexOf(grant);
        if (k >= 0) queue.splice(k, 1);
        if (!queue.length && this.waiting.get(owner) === queue) this.waiting.delete(owner);
        resolve(false);
      };
      queue.push(grant);
      this.waiting.set(owner, queue);
      signal.addEventListener("abort", aborted, { once: true });
    });
    this.admit();
    return granted;
  }

  private admit() {
    while (this.active < Math.max(1, this.limit()) && this.waiting.size) {
      const [owner, queue] = this.waiting.entries().next().value!;
      const grant = queue.shift()!;
      // This Initiative goes to the back of the rotation, or leaves it with nothing left waiting.
      this.waiting.delete(owner);
      if (queue.length) this.waiting.set(owner, queue);
      this.active++;
      grant();
    }
  }
}
