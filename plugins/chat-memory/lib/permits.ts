/** W570: an urgent call's scope passed over this long goes first (about three calls' time). */
const AGE_MS = 15_000;

/** W570: what a scope's waiting turns still need: how many calls, and since when without a break. */
export interface Demand {
  left: number;
  since: number;
}
export const NO_DEMAND: Demand = { left: 0, since: -Infinity };

/**
 * W244: one limit on summarizer calls in flight across every scope, so building every open
 * scope's tree (D447) never runs eight calls per scope at once. Waiting calls are let in
 * round-robin by scope: one large backlog cannot take every freed permit while a small one waits.
 * W315: an urgent call (for a node a turn is waiting for) goes before every other waiting call, so no
 * backlog holds a turn back. Urgency is asked each time a permit frees, not once: a turn can come
 * to need a call that is already waiting.
 * W568: after urgent calls, a scope of higher priority (an Adventure coordinator's) goes before
 * every scope of lower priority; scopes of one priority still take turns.
 * W570: urgent calls go by the fewest calls their scope's waiting turns still need, not by turns.
 * By turns, every turn waiting got an equal share and they missed their 90 s together: on
 * 2026-11-02 at 13:22-13:34, six to seven scopes waited at once, and W569 failed with 6 messages
 * unbuilt, W309 with 8. A scope passed over for AGE_MS goes first, so a large one (an admission
 * holding a whole backlog) still gets a call every AGE_MS. Its age counts from the later of when
 * it was first passed over and when its demand began (a scope whose need ended and came back while
 * no permit freed has waited only since then).
 */
export class FairPermits {
  private active = 0;
  private scheduled = false;
  /** Waiting calls by scope; the map's order is the rotation. */
  private waiting = new Map<string, Waiter[]>();
  /** W570: by scope with an urgent call waiting, since when it has had no urgent call let in. */
  private passed = new Map<string, number>();

  constructor(
    private readonly limit: () => number,
    private readonly priority: (owner: string) => number = () => 0,
    /** W570: what the scope's waiting turns still need. */
    private readonly demand: (owner: string) => Demand = () => NO_DEMAND,
    private readonly now: () => number = Date.now,
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
        this.unage(owner, queue);
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
    // No builder changes while permits are given out (their calls start on later microtasks), so
    // each scope's demand is asked once per batch, not once per permit.
    const demands = new Map<string, Demand>();
    const demand = (owner: string) => {
      let d = demands.get(owner);
      if (!d) demands.set(owner, (d = this.demand(owner)));
      return d;
    };
    while (this.active < Math.max(1, this.limit()) && this.waiting.size) {
      const [owner, queue, k] = this.next(demand);
      const [waiter] = queue.splice(k, 1);
      // This scope goes to the back of the rotation, or leaves it with nothing left waiting.
      this.waiting.delete(owner);
      if (queue.length) this.waiting.set(owner, queue);
      this.active++;
      this.unage(owner, queue);
      waiter!.grant();
    }
  }

  /** W570: a scope with no urgent call left waiting starts afresh when it has one again. */
  private unage(owner: string, queue: Waiter[]) {
    if (!queue.some((w) => w.urgent())) this.passed.delete(owner);
  }

  /**
   * The first urgent call of the scope passed over longest, once that is AGE_MS, else of the scope
   * with the fewest calls left (ties in rotation order); with no urgent call, the oldest call of the
   * next scope of the highest priority.
   */
  private next(demand: (owner: string) => Demand): [string, Waiter[], number] {
    const now = this.now();
    let fewest: [string, Waiter[], number] | null = null;
    let least = Infinity;
    let aged: [string, Waiter[], number] | null = null;
    let oldest = Infinity;
    let first: [string, Waiter[], number] | null = null;
    let best = -Infinity;
    const urgent = new Set<string>();
    for (const [owner, queue] of this.waiting) {
      const k = queue.findIndex((w) => w.urgent());
      if (k >= 0) {
        urgent.add(owner);
        const { left, since: start } = demand(owner);
        const since = Math.max(this.passed.get(owner) ?? now, start);
        this.passed.set(owner, since);
        if (now - since >= AGE_MS && since < oldest) [aged, oldest] = [[owner, queue, k], since];
        if (!fewest || left < least) [fewest, least] = [[owner, queue, k], left];
        continue;
      }
      const priority = this.priority(owner);
      if (priority > best) [first, best] = [[owner, queue, 0], priority];
    }
    // A scope whose waiting calls stopped being urgent starts afresh too.
    for (const owner of this.passed.keys()) if (!urgent.has(owner)) this.passed.delete(owner);
    const pick = aged ?? fewest;
    if (!pick) return first!;
    this.passed.set(pick[0], now);
    return pick;
  }
}

interface Waiter {
  urgent: () => boolean;
  grant: () => void;
}
