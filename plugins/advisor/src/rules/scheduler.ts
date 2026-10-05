// Review cadence (A140 §5.1): a token bucket per watch. Triggers decide only
// when; the bucket bounds how often. At most `size + T/refill` reviews in any
// window of T minutes.

export interface Bucket {
  tokens: number;
  updatedAt: number; // ms
  lastDispatchAt: number | null; // ms
}

export interface Cadence {
  size: number;
  refillMinutes: number;
  minGapMinutes: number;
}

export const DEFAULT_CADENCE: Cadence = { size: 2, refillMinutes: 10, minGapMinutes: 2 };

export function freshBucket(cadence: Cadence, now: number): Bucket {
  return { tokens: cadence.size, updatedAt: now, lastDispatchAt: null };
}

export function refill(b: Bucket, cadence: Cadence, now: number): Bucket {
  const minutes = Math.max(0, now - b.updatedAt) / 60_000;
  return { ...b, tokens: Math.min(cadence.size, b.tokens + minutes / cadence.refillMinutes), updatedAt: now };
}

/** Why the bucket would hold a dispatch now, or null when it admits one. */
export function bucketHold(b: Bucket, cadence: Cadence, now: number): string | null {
  const r = refill(b, cadence, now);
  if (r.tokens < 1) return "cadence: waiting for a review token";
  if (r.lastDispatchAt !== null && now - r.lastDispatchAt < cadence.minGapMinutes * 60_000) return "cadence: minimum gap";
  return null;
}

export function take(b: Bucket, cadence: Cadence, now: number): Bucket {
  const r = refill(b, cadence, now);
  return { tokens: r.tokens - 1, updatedAt: now, lastDispatchAt: now };
}

/** The reference minute-step simulation (A140 fixture `scheduler_bound`). */
export function tokenBucket(pending: (t: number) => boolean, minutes: number, size = 2, refillMinutes = 10, gap = 2): number[] {
  let tokens = size;
  let last = -1e9;
  const out: number[] = [];
  for (let t = 0; t < minutes; t++) {
    if (t > 0) tokens = Math.min(size, tokens + 1 / refillMinutes);
    if (pending(t) && tokens >= 1 && t - last >= gap) {
      out.push(t);
      tokens -= 1;
      last = t;
    }
  }
  return out;
}

export function maxInWindow(ds: number[], T: number): number {
  let best = 0;
  const end = ds.length > 0 ? ds[ds.length - 1]! : 0;
  for (let s = 0; s <= end; s++) best = Math.max(best, ds.filter((x) => s <= x && x < s + T).length);
  return best;
}
