import type Database from "better-sqlite3";
import { z } from "zod";
import { readQuotaRows, type UsageQuotaRow, type UsageRequestRow } from "./ledger.js";
import {
  INPUT_EQUIVALENT_WEIGHTS,
  quotaWindows,
  ResumeChains,
  rowTokens,
  type ChainState,
  type ResumeOutcome,
} from "./usage-report.js";

// Hourly sums of the usage ledger, for statistics pages that slice usage by time, provider, model,
// account, role and thread. A full scan of usage_requests per page load costs about 0.5 s per
// breakdown at 30 days of history (400k rows); the rollup holds one row per hour and slice (about
// 9k for the same history) and answers each breakdown in a few milliseconds.
//
// The rollup is a cache of usage_requests, never written by the routing path. The ledger writes a
// request's row when its response ends but stamps it with the request's start, so recent rows
// arrive out of order. A row is final once it started before every request that can still add
// one: those still open upstream or queued in the ledger (deps.openSince), and anything younger
// than COMPLETE_AFTER_MS, which covers writers this process does not track (a keep-alive is
// bounded by its 5-minute timeout; a previous process draining at a reload). Final rows are folded
// in, in ledger order (at, then rowid), behind a cursor that pruning cannot disturb: pruning only
// removes rows before it, and every new row sorts after it. A query adds the rows after the cursor,
// the live edge (about half an hour of requests, longer while a long request is open), read and
// classified afresh each time.
//
// Each request is classified once it is final: its tokens, and for a native Claude request after
// its cache entry's TTL, what it found (usage-report.ts ResumeChains, the code the CLI report
// uses), with each session's history before the cursor read from the ledger.

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
export const COMPLETE_AFTER_MS = 30 * 60_000;
const BATCH_ROWS = 2_000;
// The most rows past the cursor a query reads. More means the rollup is still being built: the
// query answers from the hours rolled up so far and counts the rest as pending.
const LIVE_ROWS = 10_000;

// The summed columns, in table order. Slice columns hold '' for an unknown value.
const SUMS = [
  "requests",
  "errors",
  "rate_limited",
  "overloaded",
  "with_usage",
  "latency_ms",
  "input",
  "output",
  "cache_read",
  "cache_write_5m",
  "cache_write_1h",
  "after_expiry",
  "cold_rewrites",
  "cold_rewrite_tokens",
  "rewrites_avoided",
  "rewrite_tokens_avoided",
  "saved_input_eq",
] as const;
type Sums = Record<(typeof SUMS)[number], number>;

const SLICES = ["hour", "provider", "kind", "account_id", "model", "role", "thread_id"] as const;
type Slice = Record<(typeof SLICES)[number], string | number>;
const COLUMNS = [...SLICES, ...SUMS];

const UPSERT_SQL = `INSERT INTO usage_hourly (${COLUMNS.join(", ")})
  VALUES (${COLUMNS.map((name) => `@${name}`).join(", ")})
  ON CONFLICT (${SLICES.join(", ")}) DO UPDATE SET
  ${SUMS.map((name) => `${name} = ${name} + excluded.${name}`).join(",\n  ")}`;

// A session's cache history at the cursor: its last native request (the rows ResumeChains
// follows: successful, usage known, a tail TTL), and whether a refresh read the entry after it.
const SEED_NATIVE_SQL = `SELECT rowid, at, ttl FROM usage_requests
  WHERE session_key = @session AND model IS @model AND provider = 'claude' AND kind = 'native'
    AND status BETWEEN 200 AND 299 AND cache_read_tokens IS NOT NULL
    AND cache_write_tokens IS NOT NULL AND ttl IS NOT NULL AND (at, rowid) <= (@at, @rowid)
  ORDER BY at DESC, rowid DESC LIMIT 1`;

const SEED_REFRESH_SQL = `SELECT 1 FROM usage_requests
  WHERE session_key = @session AND model IS @model AND provider = 'claude' AND kind = 'refresh'
    AND status BETWEEN 200 AND 299 AND cache_read_tokens > 0 AND cache_write_tokens IS NOT NULL
    AND (at, rowid) > (@nativeAt, @nativeRowid) AND (at, rowid) <= (@at, @rowid)
  LIMIT 1`;

// The last row rolled up, in ledger order.
interface Cursor {
  at: number;
  rowid: number;
}

type LedgerRow = UsageRequestRow & { rowid: number };
// A usage_hourly row as an array, in COLUMNS order.
type RollupRow = Array<string | number>;

export interface UsageRollupDeps {
  // The ledger's own connection: it never waits for a lock (openLedgerDatabase).
  db: Database.Database;
  now: () => number;
  // The start of the oldest request whose row may still be written (open or queued), or null.
  openSince: () => number | null;
  retentionDays: () => number;
  log: (message: string) => void;
}

export class UsageRollup {
  private readonly readCursor: Database.Statement;
  private readonly writeCursor: Database.Statement;
  private readonly selectFinal: Database.Statement;
  private readonly selectLive: Database.Statement;
  private readonly countAfter: Database.Statement;
  private readonly seedNative: Database.Statement;
  private readonly seedRefresh: Database.Statement;
  private readonly upsert: Database.Statement;
  private readonly prune: Database.Statement;
  private readonly clear: Database.Statement;
  private live: { key: string; live: RollupRow[]; pendingRows: number } | null = null;

  constructor(private readonly deps: UsageRollupDeps) {
    const db = deps.db;
    const after = "(at, rowid) > (@at, @rowid)";
    this.readCursor = db.prepare("SELECT at, request_rowid AS rowid FROM usage_rollup_cursor");
    this.writeCursor = db.prepare("UPDATE usage_rollup_cursor SET at = @at, request_rowid = @rowid");
    this.selectFinal = db.prepare(
      `SELECT rowid, * FROM usage_requests WHERE ${after} AND at < @before
       ORDER BY at, rowid LIMIT @limit`,
    );
    this.selectLive = db.prepare(
      `SELECT rowid, * FROM usage_requests WHERE ${after} ORDER BY at, rowid`,
    );
    this.countAfter = db.prepare(
      `SELECT count(*) AS n, max(rowid) AS last FROM usage_requests WHERE ${after}`,
    );
    this.seedNative = db.prepare(SEED_NATIVE_SQL);
    this.seedRefresh = db.prepare(SEED_REFRESH_SQL);
    this.upsert = db.prepare(UPSERT_SQL);
    this.prune = db.prepare("DELETE FROM usage_hourly WHERE hour < ?");
    this.clear = db.prepare("DELETE FROM usage_hourly");
  }

  // Rolls up one batch of final rows and drops hours past the retention, in a transaction that
  // takes the write lock before reading anything: a held lock costs one failed BEGIN, not a
  // batch's work. "behind": more final rows wait.
  step(): "busy" | "behind" | "done" {
    try {
      return this.deps.db.transaction(() => this.rollBatch()).immediate() ? "behind" : "done";
    } catch (error) {
      if (isBusy(error)) return "busy";
      this.deps.log(
        `Account Pooler usage rollup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return "done";
    }
  }

  // Drops every sum and rewinds the cursor, for a caller that changed rows already rolled up
  // (usage-relink.ts), inside its transaction. The next steps redo a first build from the ledger.
  rebuild(): void {
    this.clear.run();
    this.writeCursor.run({ at: 0, rowid: 0 });
    // Its key can't tell: with every row still live, the cursor was zero already.
    this.live = null;
  }

  // The sums for usage.stats: the hours rolled up plus the live edge. Reads only; a rollup behind
  // by more than LIVE_ROWS (a first build) leaves its backlog out and counts it in pendingRows.
  stats(input: UsageStatsInput): UsageStats {
    const { live, pendingRows } = this.liveEdge();
    return queryUsageStats(this.deps.db, input, {
      retentionDays: this.deps.retentionDays(),
      live,
      pendingRows,
    });
  }

  // The live edge's sums, kept until a row is written or the cursor moves: a page asks twice.
  private liveEdge(): { live: RollupRow[]; pendingRows: number } {
    const cursor = this.cursor();
    const after = this.countAfter.get(cursor) as { n: number; last: number | null };
    const key = JSON.stringify([cursor, after]);
    if (this.live?.key === key) return this.live;
    const behind = after.n > LIVE_ROWS;
    const rows = behind ? [] : (this.selectLive.all(cursor) as LedgerRow[]);
    this.live = {
      key,
      live: [...this.slices(rows, cursor).values()].map((slice) => COLUMNS.map((name) => slice[name])),
      pendingRows: behind ? after.n : 0,
    };
    return this.live;
  }

  private cursor(): Cursor {
    return this.readCursor.get() as Cursor;
  }

  private rollBatch(): boolean {
    const cursor = this.cursor();
    const rows = this.selectFinal.all({
      ...cursor,
      before: Math.min(this.deps.now() - COMPLETE_AFTER_MS, this.deps.openSince() ?? Infinity),
      limit: BATCH_ROWS,
    }) as LedgerRow[];
    for (const sums of this.slices(rows, cursor).values()) this.upsert.run(sums);
    const last = rows.at(-1);
    if (last !== undefined) this.writeCursor.run({ at: last.at, rowid: last.rowid });
    const cutoff = this.deps.now() - this.deps.retentionDays() * DAY_MS;
    this.prune.run(Math.floor(cutoff / HOUR_MS) * HOUR_MS);
    return rows.length === BATCH_ROWS;
  }

  // Sums rows that follow the cursor, in ledger order, per hour and slice.
  private slices(rows: LedgerRow[], cursor: Cursor): Map<string, Slice & Sums> {
    const chains = new ResumeChains((row) => this.seed(row, cursor));
    const slices = new Map<string, Slice & Sums>();
    for (const row of rows) {
      const slice: Slice = {
        hour: Math.floor(row.at / HOUR_MS) * HOUR_MS,
        provider: row.provider,
        kind: row.kind,
        account_id: row.account_id,
        model: row.model ?? "",
        role: row.role ?? "",
        thread_id: row.thread_id ?? "",
      };
      const key = JSON.stringify(SLICES.map((name) => slice[name]));
      let sums = slices.get(key);
      if (sums === undefined) {
        sums = { ...slice, ...emptySums() };
        slices.set(key, sums);
      }
      add(sums, row, chains.next(row));
    }
    return slices;
  }

  private seed(row: UsageRequestRow, cursor: Cursor): ChainState | undefined {
    const session = { session: row.session_key, model: row.model, ...cursor };
    const native = this.seedNative.get(session) as
      | { rowid: number; at: number; ttl: ChainState["ttl"] }
      | undefined;
    if (native === undefined) return undefined;
    const refreshed =
      this.seedRefresh.get({ ...session, nativeAt: native.at, nativeRowid: native.rowid }) !==
      undefined;
    return { lastNativeAt: native.at, ttl: native.ttl, refreshesSince: refreshed ? 1 : 0 };
  }
}

// Runs the rollup in the background: a batch per event-loop turn while it is behind (a first
// build), then every idleMs. A held lock retries after busyMs, doubling up to idleMs, as the ledger
// waits out a writer instead of spinning. Returns a stop function.
export function runUsageRollup(
  rollup: Pick<UsageRollup, "step">,
  options: {
    idleMs: number;
    busyMs: number;
    defer: (run: () => void, delayMs: number) => () => void;
  },
): () => void {
  let busyMs = options.busyMs;
  let cancel = options.defer(run, 0);
  function run() {
    const result = rollup.step();
    let delay = options.idleMs;
    if (result === "busy") {
      delay = busyMs;
      busyMs = Math.min(busyMs * 2, options.idleMs);
    } else {
      busyMs = options.busyMs;
      if (result === "behind") delay = 0;
    }
    cancel = options.defer(run, delay);
  }
  return () => cancel();
}

function add(sums: Sums, row: UsageRequestRow, outcome: ResumeOutcome | null): void {
  const tokens = rowTokens(row);
  const ok = row.status !== null && row.status >= 200 && row.status < 300;
  sums.requests += 1;
  if (!ok) sums.errors += 1;
  if (row.status === 429) sums.rate_limited += 1;
  if (row.status === 529) sums.overloaded += 1;
  if (row.input_tokens !== null || row.cache_read_tokens !== null) sums.with_usage += 1;
  sums.latency_ms += row.latency_ms;
  sums.input += tokens.input;
  sums.output += tokens.output;
  sums.cache_read += tokens.cacheRead;
  sums.cache_write_5m += tokens.cacheWrite5m;
  sums.cache_write_1h += tokens.cacheWrite1h;
  if (outcome === null) return;
  sums.after_expiry += 1;
  if (outcome.kind === "cold") {
    sums.cold_rewrites += 1;
    sums.cold_rewrite_tokens += outcome.tokens;
  } else if (outcome.kind === "keptWarm") {
    sums.rewrites_avoided += 1;
    sums.rewrite_tokens_avoided += outcome.tokens;
    sums.saved_input_eq += outcome.savedInputEquivalent;
  }
}

function emptySums(): Sums {
  return Object.fromEntries(SUMS.map((name) => [name, 0])) as Sums;
}

function isBusy(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  return code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED");
}

// --- Queries (usage.stats and usage.quota RPCs) ---

export const usageDimensionSchema = z.enum([
  "bucket",
  "provider",
  "kind",
  "model",
  "account",
  "role",
  "thread",
]);
export type UsageDimension = z.infer<typeof usageDimensionSchema>;

const DIMENSION_COLUMN: Record<Exclude<UsageDimension, "bucket">, string> = {
  provider: "provider",
  kind: "kind",
  model: "model",
  account: "account_id",
  role: "role",
  thread: "thread_id",
};

// null in a filter matches an unknown value: a request with no model, role or thread.
const filterValuesSchema = z.array(z.string().max(200).nullable()).max(5_000);

export const usageStatsInputSchema = z
  .object({
    // Hours that start in [from, to): the hour that holds from counts whole.
    from: z.number().int().nonnegative(),
    to: z.number().int().positive(),
    // Required when a group includes "bucket": the start of each bucket, ascending, from the
    // caller's calendar (local hours or days, so a day can last 23 or 25 hours). An hour counts in
    // the last bucket that starts at or before it, or before from for the hour that holds from.
    bucket: z
      .object({
        starts: z
          .array(z.number().int())
          .min(1)
          .max(10_000)
          .refine(
            (starts) => starts.every((at, index) => index === 0 || starts[index - 1]! < at),
            "Bucket starts must ascend.",
          ),
      })
      .strict()
      .nullable(),
    filter: z
      .object({
        provider: filterValuesSchema,
        kind: filterValuesSchema,
        model: filterValuesSchema,
        account: filterValuesSchema,
        role: filterValuesSchema,
        thread: filterValuesSchema,
      })
      .partial()
      .strict(),
    // One result per group: the sums for every combination of its dimensions ([] is the total).
    groups: z.array(z.array(usageDimensionSchema).max(3)).min(1).max(12),
  })
  .strict()
  .refine((input) => input.from < input.to, "from must be before to.")
  .refine(
    (input) => input.bucket !== null || input.groups.every((group) => !group.includes("bucket")),
    "A group by bucket needs a bucket size.",
  );
export type UsageStatsInput = z.infer<typeof usageStatsInputSchema>;

const count = z.number().int().nonnegative();
const amount = z.number().nonnegative();

export const usageMetricsSchema = z
  .object({
    requests: count,
    // Not 2xx, or a send whose outcome is unknown; 429 and 529 among them.
    errors: count,
    rateLimited: count,
    overloaded: count,
    // Requests whose token usage was recorded (Codex rows from before 8 Oct 2026 have none).
    withUsage: count,
    latencyMs: count,
    input: count,
    output: count,
    cacheRead: count,
    cacheWrite5m: count,
    cacheWrite1h: count,
    // Tokens weighted at API price ratios to uncached input (weights in the output).
    inputEquivalent: amount,
    // Native Claude prompts: cache hit rate = nativeCacheRead / nativePromptTokens.
    nativePromptTokens: count,
    nativeCacheRead: count,
    // Cache-warming refreshes and their cost.
    refreshes: count,
    refreshInputEquivalent: amount,
    // Native Claude requests after their entry's TTL, and what they found (usage-report.ts).
    afterExpiry: count,
    coldRewrites: count,
    coldRewriteTokens: count,
    rewritesAvoided: count,
    rewriteTokensAvoided: count,
    savedInputEquivalent: amount,
  })
  .strict();
export type UsageMetrics = z.infer<typeof usageMetricsSchema>;

export const usageStatsRowSchema = z
  .object({
    // The group's dimensions: bucket start time, or the value (null when unknown).
    key: z
      .object({
        bucket: z.number().int(),
        provider: z.string().nullable(),
        kind: z.string().nullable(),
        model: z.string().nullable(),
        account: z.string().nullable(),
        role: z.string().nullable(),
        thread: z.string().nullable(),
      })
      .partial()
      .strict(),
    metrics: usageMetricsSchema,
  })
  .strict();
export type UsageStatsRow = z.infer<typeof usageStatsRowSchema>;

export const usageStatsSchema = z
  .object({
    weights: z
      .object({
        input: z.number(),
        cacheRead: z.number(),
        cacheWrite5m: z.number(),
        cacheWrite1h: z.number(),
        output: z.number(),
      })
      .strict(),
    retentionDays: z.number().int().positive(),
    // The oldest hour with data, or null when the ledger is empty.
    oldestHour: z.number().int().nullable(),
    // Ledger rows left out of the sums: a first build of the rollup is still under way.
    pendingRows: count,
    results: z.array(z.array(usageStatsRowSchema)),
  })
  .strict();
export type UsageStats = z.infer<typeof usageStatsSchema>;

const METRIC_NAMES = Object.keys(usageMetricsSchema.shape) as Array<keyof UsageMetrics>;
const COLUMN = Object.fromEntries(COLUMNS.map((name, index) => [name, index])) as Record<
  (typeof COLUMNS)[number],
  number
>;
// One read of the hours in range, plus the live edge's rows, summed per group in memory: a single
// index range scan whatever the number of groups. Rows are arrays (COLUMNS order) and metrics are
// summed as arrays (METRIC_NAMES order): a 30-day page reads about 9k rows into nine groups.
function queryUsageStats(
  db: Database.Database,
  input: UsageStatsInput,
  meta: { retentionDays: number; pendingRows: number; live: RollupRow[] },
): UsageStats {
  const from = Math.floor(input.from / HOUR_MS) * HOUR_MS;
  const where = ["hour >= @from", "hour < @to"];
  const params: Record<string, string | number> = { from, to: input.to };
  const filters: Array<[number, Set<string>]> = [];
  for (const [dimension, values] of Object.entries(input.filter)) {
    if (values === undefined) continue;
    const column = DIMENSION_COLUMN[dimension as keyof typeof DIMENSION_COLUMN];
    where.push(`${column} IN (SELECT coalesce(value, '') FROM json_each(@f_${dimension}))`);
    params[`f_${dimension}`] = JSON.stringify(values);
    filters.push([COLUMN[column as (typeof SLICES)[number]], new Set(values.map((value) => value ?? ""))]);
  }
  const live = meta.live.filter(
    (row) =>
      Number(row[COLUMN.hour]) >= from &&
      Number(row[COLUMN.hour]) < input.to &&
      filters.every(([column, values]) => values.has(String(row[column]))),
  );
  const bucketOf = bucketer(input);
  const keyOf = (row: RollupRow, dimension: UsageDimension): string | number =>
    dimension === "bucket"
      ? bucketOf(Number(row[COLUMN.hour]))
      : row[COLUMN[DIMENSION_COLUMN[dimension] as (typeof SLICES)[number]]]!;
  const groups = input.groups.map(
    () => new Map<string, { values: Array<string | number>; sums: number[] }>(),
  );
  const add = (row: RollupRow) => {
    const metrics = rowMetrics(row);
    input.groups.forEach((group, index) => {
      const values = group.map((dimension) => keyOf(row, dimension));
      const id = values.length === 1 ? String(values[0]) : values.join("\u0000");
      const result = groups[index]!.get(id);
      if (result === undefined) groups[index]!.set(id, { values, sums: metrics.slice() });
      else for (let m = 0; m < metrics.length; m += 1) result.sums[m]! += metrics[m]!;
    });
  };
  const rows = db
    .prepare(`SELECT ${COLUMNS.join(", ")} FROM usage_hourly WHERE ${where.join(" AND ")}`)
    .raw(true)
    .iterate(params) as IterableIterator<RollupRow>;
  for (const row of rows) add(row);
  for (const row of live) add(row);
  const oldest = (db.prepare("SELECT min(hour) AS hour FROM usage_hourly").get() as {
    hour: number | null;
  }).hour;
  const oldestHour = Math.min(oldest ?? Infinity, ...meta.live.map((row) => Number(row[COLUMN.hour])));
  return {
    weights: { ...INPUT_EQUIVALENT_WEIGHTS },
    retentionDays: meta.retentionDays,
    oldestHour: Number.isFinite(oldestHour) ? oldestHour : null,
    pendingRows: meta.pendingRows,
    results: input.groups.map((group, index) => {
      const results = [...groups[index]!.values()].map(({ values, sums }) => {
        const key: UsageStatsRow["key"] = {};
        group.forEach((dimension, position) => {
          const value = values[position]!;
          if (dimension === "bucket") key.bucket = Number(value);
          else key[dimension] = value === "" ? null : String(value);
        });
        const metrics = Object.fromEntries(
          METRIC_NAMES.map((name, position) => [name, sums[position]!]),
        ) as UsageMetrics;
        return { key, metrics };
      });
      if (group.includes("bucket"))
        results.sort((left, right) => (left.key.bucket ?? 0) - (right.key.bucket ?? 0));
      return results;
    }),
  };
}

// The bucket an hour counts in: the last start at or before it, the hour that holds from counting
// from from. Hours repeat across rows, so each is looked up once.
function bucketer(input: UsageStatsInput): (hour: number) => number {
  const starts = input.bucket?.starts ?? [input.from];
  const known = new Map<number, number>();
  return (hour) => {
    let bucket = known.get(hour);
    if (bucket !== undefined) return bucket;
    const at = Math.max(hour, input.from);
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle]! <= at) low = middle;
      else high = middle - 1;
    }
    bucket = starts[low]!;
    known.set(hour, bucket);
    return bucket;
  };
}

// A rollup row (SLICES then SUMS) as metrics in METRIC_NAMES order: the per-row step of a query.
function rowMetrics(row: Array<string | number>): number[] {
  const [, provider, kind, , , , , ...sums] = row;
  const [
    requests, errors, rateLimited, overloaded, withUsage, latencyMs, input, output, cacheRead,
    cacheWrite5m, cacheWrite1h, afterExpiry, coldRewrites, coldRewriteTokens, rewritesAvoided,
    rewriteTokensAvoided, savedInputEquivalent,
  ] = sums as number[];
  const weights = INPUT_EQUIVALENT_WEIGHTS;
  const inputEquivalent =
    input! * weights.input +
    output! * weights.output +
    cacheRead! * weights.cacheRead +
    cacheWrite5m! * weights.cacheWrite5m +
    cacheWrite1h! * weights.cacheWrite1h;
  const native = provider === "claude" && kind === "native";
  const refresh = kind === "refresh";
  return [
    requests!,
    errors!,
    rateLimited!,
    overloaded!,
    withUsage!,
    latencyMs!,
    input!,
    output!,
    cacheRead!,
    cacheWrite5m!,
    cacheWrite1h!,
    inputEquivalent,
    native ? input! + cacheRead! + cacheWrite5m! + cacheWrite1h! : 0,
    native ? cacheRead! : 0,
    refresh ? requests! : 0,
    refresh ? inputEquivalent : 0,
    afterExpiry!,
    coldRewrites!,
    coldRewriteTokens!,
    rewritesAvoided!,
    rewriteTokensAvoided!,
    savedInputEquivalent!,
  ];
}

export const usageQuotaInputSchema = z
  .object({
    from: z.number().int().nonnegative(),
    to: z.number().int().positive(),
  })
  .strict()
  .refine((input) => input.from < input.to, "from must be before to.");
export type UsageQuotaInput = z.infer<typeof usageQuotaInputSchema>;

const quotaWindowSchema = z
  .object({ utilization: z.number(), resetAt: z.number().int().nullable() })
  .strict();

export const usageQuotaSchema = z
  .object({
    accounts: z.array(
      z
        .object({
          accountId: z.string(),
          // Every change observed, in time order. The first may be before from: the state at from.
          // Windows by name: "5h", "7d", "7d <family>", or a Codex window by length.
          points: z.array(
            z
              .object({
                at: z.number().int(),
                windows: z.record(z.string(), quotaWindowSchema),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();
export type UsageQuota = z.infer<typeof usageQuotaSchema>;

export function queryUsageQuota(db: Database.Database, input: UsageQuotaInput): UsageQuota {
  const byAccount = new Map<string, UsageQuota["accounts"][number]["points"]>();
  for (const row of readQuotaRows(db, input.from) as Iterable<UsageQuotaRow>) {
    if (row.at >= input.to) break;
    let points = byAccount.get(row.account_id);
    if (points === undefined) {
      points = [];
      byAccount.set(row.account_id, points);
    }
    // Only the latest row before from is the account's baseline.
    if (row.at < input.from && points.length > 0) points.length = 0;
    points.push({ at: row.at, windows: Object.fromEntries(quotaWindows(row)) });
  }
  return {
    accounts: [...byAccount.entries()].map(([accountId, points]) => ({ accountId, points })),
  };
}
