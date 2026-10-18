/** W514: a call slower than this is logged once, with where its time went. */
export const SLOW_CALL_MS = 1000;

/** Times the awaited steps of one call, in order, for one log line when it ran long. */
export class StepTimer {
  private readonly steps: [string, number][] = [];
  private readonly started: number;

  constructor(private readonly clock: () => number = () => performance.now()) {
    this.started = clock();
  }

  /** Run one step; its time is recorded even when it throws. */
  async step<T>(name: string, run: () => Promise<T>): Promise<T> {
    const at = this.clock();
    try {
      return await run();
    } finally {
      this.steps.push([name, this.clock() - at]);
    }
  }

  get totalMs() {
    return this.clock() - this.started;
  }

  /** "1234 ms (get 12, list 900, archive 300)": steps of the same name add up; zero-length ones are left out. */
  summary() {
    const byName = new Map<string, number>();
    for (const [name, ms] of this.steps) byName.set(name, (byName.get(name) ?? 0) + ms);
    const parts = [...byName].filter(([, ms]) => Math.round(ms) > 0).map(([name, ms]) => `${name} ${Math.round(ms)}`);
    return `${Math.round(this.totalMs)} ms${parts.length ? ` (${parts.join(", ")})` : ""}`;
  }
}
