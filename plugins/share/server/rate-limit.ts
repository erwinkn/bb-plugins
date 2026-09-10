/** One bucket shared by both routes; idle buckets are pruned without a timer. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private lastPruned = 0;
  constructor(private readonly now: () => number = Date.now, private readonly maxClients = 10_000) {}

  take(ip: string): boolean {
    const now = this.now();
    if (now - this.lastPruned >= 60_000 || this.buckets.size >= this.maxClients) {
      for (const [key, bucket] of this.buckets) if (now - bucket.at >= 60_000) this.buckets.delete(key);
      this.lastPruned = now;
    }
    const previous = this.buckets.get(ip);
    // Keep live clients' limits when the map is full instead of evicting them.
    if (!previous && this.buckets.size >= this.maxClients) return false;
    const tokens = previous ? Math.min(60, previous.tokens + Math.max(0, now - previous.at) / 1000) : 60;
    const allowed = tokens >= 1;
    this.buckets.set(ip, { tokens: allowed ? tokens - 1 : tokens, at: now });
    return allowed;
  }
  clear(): void { this.buckets.clear(); }
}

export function clientIp(request: Request, socketAddress?: string): string {
  return request.headers.get("cf-connecting-ip")?.trim()
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || socketAddress || "unknown";
}
