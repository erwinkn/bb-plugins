/**
 * Identical consecutive crash reports arrive in bursts — a ResizeObserver
 * loop can emit fifteen inside three seconds. The deduper holds a report
 * for a quiet window; identical reports merge into it with an
 * `occurrences` count, so a burst logs once instead of flooding the log.
 * A nonstop loop still reports periodically, once `maxWaitMs` elapses.
 */

export type CrashLevel = "debug" | "info" | "warn" | "error";
export type CrashFields = Record<string, string | number | boolean | null>;

/**
 * The browser's ResizeObserver starvation notice reports a layout loop it
 * already broke itself; the page keeps running. It is a warning, not a
 * crash — Chrome and Firefox phrase it differently.
 */
export function isResizeObserverLoopMessage(message: string): boolean {
  return /ResizeObserver loop (completed with undelivered notifications|limit exceeded)/.test(message);
}

interface Pending {
  key: string;
  level: CrashLevel;
  fields: CrashFields;
  count: number;
  /** Epoch after which the entry reports even if repeats keep arriving. */
  deadline: number;
  timer: unknown;
}

export interface CrashDeduperOptions {
  /** Quiet period after the last identical report before it emits. */
  windowMs?: number;
  /** Longest a burst is held before it emits mid-stream. */
  maxWaitMs?: number;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  unschedule?: (timer: unknown) => void;
}

export class CrashDeduper {
  private pending: Pending | null = null;
  private readonly windowMs: number;
  private readonly maxWaitMs: number;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly unschedule: (timer: unknown) => void;

  constructor(
    private readonly emit: (level: CrashLevel, fields: CrashFields) => void,
    options: CrashDeduperOptions = {},
  ) {
    this.windowMs = options.windowMs ?? 400;
    this.maxWaitMs = options.maxWaitMs ?? 2_000;
    this.now = options.now ?? (() => Date.now());
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.unschedule = options.unschedule ?? ((timer) => clearTimeout(timer as Parameters<typeof clearTimeout>[0]));
  }

  /** Queue a report; `key` identifies the message identity for merging. */
  push(level: CrashLevel, fields: CrashFields, key: string): void {
    const pending = this.pending;
    if (pending !== null && pending.key === key) {
      pending.count += 1;
      this.unschedule(pending.timer);
      pending.timer = this.schedule(() => this.flush(), Math.min(this.windowMs, Math.max(0, pending.deadline - this.now())));
      return;
    }
    this.flush();
    this.pending = {
      key,
      level,
      fields,
      count: 1,
      deadline: this.now() + this.maxWaitMs,
      timer: this.schedule(() => this.flush(), this.windowMs),
    };
  }

  /** Emit whatever is held; safe to call on teardown. */
  flush(): void {
    const pending = this.pending;
    if (pending === null) return;
    this.pending = null;
    this.unschedule(pending.timer);
    this.emit(pending.level, pending.count > 1 ? { ...pending.fields, occurrences: pending.count } : pending.fields);
  }
}
