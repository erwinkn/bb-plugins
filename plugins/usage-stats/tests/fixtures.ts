// A fake Account Pooler that sums hand-written ledger slices the way usage.stats does, and a fake
// directory, for building pages without BB.
import type { Directory, Membership, ThreadInfo } from "../src/directory";
import type { Metrics } from "../src/model";
import type { Pooler, PoolerQuota, PoolerStatsInput, PoolerStatsRow, PoolerStatus } from "../src/pooler";
import { addMetrics, emptyMetrics } from "../src/shared";

export const HOUR = 60 * 60_000;
export const DAY = 24 * HOUR;
export const T0 = Date.UTC(2026, 9, 7, 0);

export interface Slice {
  at: number;
  provider?: string;
  kind?: string;
  model?: string | null;
  account?: string;
  role?: string | null;
  thread?: string | null;
  metrics: Partial<Metrics>;
}

const WEIGHTS = { input: 1, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2, output: 5 };

export function fakePooler(
  slices: Slice[],
  options: { status?: PoolerStatus | Error; quota?: PoolerQuota } = {},
): Pooler & { calls: PoolerStatsInput[] } {
  const calls: PoolerStatsInput[] = [];
  const full = slices.map((slice) => ({
    bucketSource: slice.at,
    key: {
      provider: slice.provider ?? "claude",
      kind: slice.kind ?? "native",
      model: slice.model === undefined ? "claude-opus-5-5" : slice.model,
      account: slice.account ?? "acct-a",
      role: slice.role === undefined ? "work" : slice.role,
      thread: slice.thread === undefined ? "thr_1" : slice.thread,
    },
    metrics: { ...emptyMetrics(), ...slice.metrics },
  }));
  return {
    calls,
    async stats(input) {
      calls.push(input);
      // As the Pooler: the hour that holds from counts whole, in the first bucket.
      const starts = input.bucket?.starts ?? [input.from];
      const bucketOf = (at: number) => starts.filter((start) => start <= Math.max(at, input.from)).at(-1) ?? starts[0]!;
      const kept = full.filter(
        (slice) =>
          slice.bucketSource >= Math.floor(input.from / HOUR) * HOUR &&
          slice.bucketSource < input.to &&
          Object.entries(input.filter).every(([dimension, values]) =>
            values!.includes(slice.key[dimension as keyof typeof slice.key] ?? null),
          ),
      );
      return {
        weights: WEIGHTS,
        retentionDays: 30,
        oldestHour: full.length === 0 ? null : Math.min(...full.map((slice) => slice.bucketSource)),
        pendingRows: 0,
        results: input.groups.map((group) => {
          const rows = new Map<string, PoolerStatsRow>();
          for (const slice of kept) {
            const key: PoolerStatsRow["key"] = {};
            for (const dimension of group) {
              if (dimension === "bucket") key.bucket = bucketOf(slice.bucketSource);
              else key[dimension] = slice.key[dimension];
            }
            const id = JSON.stringify(key);
            const row = rows.get(id) ?? { key, metrics: emptyMetrics() };
            addMetrics(row.metrics, slice.metrics);
            rows.set(id, row);
          }
          return [...rows.values()];
        }),
      };
    },
    async quota() {
      return options.quota ?? { accounts: [] };
    },
    async status() {
      if (options.status instanceof Error) throw options.status;
      return (
        options.status ?? {
          accounts: [
            { id: "acct-a", provider: "claude", label: "Erwin", email: "a@example.com", status: "ready", active: true },
            { id: "acct-b", provider: "claude", label: "Erwin", email: null, status: "exhausted", active: false },
          ],
        }
      );
    },
  };
}

export function fakeDirectory(
  threads: Record<string, Partial<ThreadInfo>>,
  memberships: Record<string, Membership> = {},
  projects: Record<string, string> = {},
): Directory & { asked: string[][] } {
  const asked: string[][] = [];
  return {
    asked,
    async threads(ids) {
      asked.push(ids);
      return new Map(ids.map((id) => [id, { title: id, projectId: null, deleted: false, ...threads[id] }]));
    },
    async projects() {
      return new Map(Object.entries(projects));
    },
    async memberships() {
      return new Map(Object.entries(memberships));
    },
  };
}
