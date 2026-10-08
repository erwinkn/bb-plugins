// The usage rollup over a real SQLite database: incremental catch-up behind a completeness margin,
// the live edge, the resume classification it shares with the CLI report, pruning, a held lock,
// filters and buckets, retention, and quota history.
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { QUOTA_MIGRATIONS } from "./store.js";
import { buildUsageReport } from "./usage-report.js";
import {
  COMPLETE_AFTER_MS,
  queryUsageQuota,
  runUsageRollup,
  UsageRollup,
  usageStatsInputSchema,
  type UsageStatsInput,
} from "./usage-rollup.js";

const T0 = Date.UTC(2026, 9, 7, 10);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function database(): Database.Database {
  const db = new Database(":memory:");
  for (const statement of QUOTA_MIGRATIONS) db.exec(statement);
  return db;
}

interface Row {
  at: number;
  kind?: "native" | "refresh" | "advisor";
  provider?: "claude" | "codex";
  session?: string | null;
  thread?: string | null;
  role?: string | null;
  account?: string;
  model?: string | null;
  ttl?: "5m" | "1h" | null;
  status?: number | null;
  input?: number | null;
  output?: number | null;
  read?: number | null;
  write?: number | null;
}

function insert(db: Database.Database, row: Row): void {
  const write = row.write === undefined ? 80_000 : row.write;
  db.prepare(
    `INSERT INTO usage_requests (at, kind, provider, session_key, thread_id, role, account_id, model,
       family, ttl, status, completed, latency_ms, input_tokens, output_tokens, cache_read_tokens,
       cache_write_tokens, cache_write_5m_tokens, cache_write_1h_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'opus', ?, ?, 1, 2000, ?, ?, ?, ?, ?, 0)`,
  ).run(
    row.at,
    row.kind ?? "native",
    row.provider ?? "claude",
    row.session === null ? null : `session:${row.session ?? "s1"}`,
    row.thread === undefined ? "thr_1" : row.thread,
    row.role === undefined ? "work" : row.role,
    row.account ?? "acct-a",
    row.model === undefined ? "claude-opus-5-5" : row.model,
    row.ttl === undefined ? "5m" : row.ttl,
    row.status === undefined ? 200 : row.status,
    row.input === undefined ? 10 : row.input,
    row.output === undefined ? 1_000 : row.output,
    row.read === undefined ? 400_000 : row.read,
    write,
    write,
  );
}

function rollup(db: Database.Database, now = T0 + DAY, retentionDays = 30) {
  const logs: string[] = [];
  const clock = { now, openSince: null as number | null };
  const r = new UsageRollup({
    db,
    now: () => clock.now,
    openSince: () => clock.openSince,
    retentionDays: () => retentionDays,
    log: (m) => logs.push(m),
  });
  return { rollup: r, logs, clock, catchUp: () => drain(r) };
}

// Steps until no final row waits; returns the steps taken.
function drain(r: UsageRollup): number {
  let steps = 1;
  while (r.step() === "behind") steps += 1;
  return steps;
}

function stats(r: UsageRollup, input: Partial<UsageStatsInput> = {}) {
  return r.stats(
    usageStatsInputSchema.parse({
      from: 0,
      to: T0 + 30 * DAY,
      bucket: null,
      filter: {},
      groups: [[]],
      ...input,
    }),
  );
}

const total = (r: UsageRollup, input: Partial<UsageStatsInput> = {}) =>
  stats(r, input).results[0]?.[0]?.metrics;

const rolledUp = (db: Database.Database) =>
  (db.prepare("SELECT coalesce(sum(requests), 0) AS n FROM usage_hourly").get() as { n: number }).n;

function report(db: Database.Database) {
  return buildUsageReport(db, {
    since: 0,
    until: T0 + DAY,
    ledger: { since: 0, rowsWritten: 0, writeErrors: 0, busyRetries: 0, dropped: 0, lastError: null, retentionDays: 30 },
    accountLabels: {},
  });
}

function expectReportAgreement(db: Database.Database, r: UsageRollup) {
  const result = report(db);
  const metrics = total(r);
  expect(metrics).toMatchObject({
    afterExpiry: result.total.idle.afterExpiry,
    coldRewrites: result.total.idle.coldRewrites,
    coldRewriteTokens: result.total.idle.coldRewriteTokens,
    rewritesAvoided: result.total.idle.rewritesAvoided,
    rewriteTokensAvoided: result.total.idle.rewriteTokensAvoided,
    savedInputEquivalent: result.total.estimate.savedInputEquivalent,
    refreshInputEquivalent: result.total.estimate.refreshCostInputEquivalent,
  });
  return { report: result, metrics: metrics! };
}

// The classification fixture: s1 is cold after 10 min, then kept warm by a refresh, then warm with
// no refresh; s2, a 1h entry, is still alive after 30 min and cold after 2 hours despite a
// refresh; another model of s1 has its own entry.
function sessions(db: Database.Database, at = T0) {
  insert(db, { at });
  insert(db, { at: at + 10 * MINUTE, read: 0, write: 500_000 });
  insert(db, { at: at + 14 * MINUTE, kind: "refresh", read: 500_000, write: 0, output: 0 });
  insert(db, { at: at + 20 * MINUTE, read: 500_000, write: 1_000 });
  insert(db, { at: at + 40 * MINUTE, read: 500_000, write: 1_000 });
  insert(db, { at, session: "s2", ttl: "1h" });
  insert(db, { at: at + 30 * MINUTE, session: "s2", ttl: "1h" });
  insert(db, { at: at + 60 * MINUTE, session: "s2", kind: "refresh", ttl: "1h", output: 0 });
  insert(db, { at: at + 150 * MINUTE, session: "s2", ttl: "1h", read: 0, write: 600_000 });
  insert(db, { at: at + 30 * MINUTE, model: "claude-sonnet-5-5" });
}

describe("UsageRollup", () => {
  it("rolls up final rows once, a batch per step", () => {
    const db = database();
    db.transaction(() => {
      for (let index = 0; index < 2_001; index += 1) insert(db, { at: T0 + (index % 50) * MINUTE });
    })();
    const { rollup: r } = rollup(db);
    expect(r.step()).toBe("behind");
    expect(rolledUp(db)).toBe(2_000);
    expect(r.step()).toBe("done");
    expect(r.step()).toBe("done");
    expect(rolledUp(db)).toBe(2_001);
    expect(total(r)?.requests).toBe(2_001);
  });

  it("sums tokens, errors and input-equivalents", () => {
    const db = database();
    for (let index = 0; index < 5; index += 1) insert(db, { at: T0 + index * MINUTE });
    insert(db, { at: T0 + 10 * MINUTE, status: 429, read: null, write: null, input: null, output: null });
    const { rollup: r, catchUp } = rollup(db);
    catchUp();
    expect(total(r)).toMatchObject({
      requests: 6,
      errors: 1,
      rateLimited: 1,
      withUsage: 5,
      cacheRead: 2_000_000,
      cacheWrite5m: 400_000,
      output: 5_000,
      // 50 input + 5,000 output × 5 + 2M read × 0.1 + 400k 5m write × 1.25
      inputEquivalent: 50 + 25_000 + 200_000 + 500_000,
      nativePromptTokens: 2_400_050,
      nativeCacheRead: 2_000_000,
    });
  });

  it("never counts a row twice or loses one when pruning empties the ledger and rowids restart", () => {
    const db = database();
    insert(db, { at: T0 });
    insert(db, { at: T0 + MINUTE });
    const { rollup: r, catchUp, clock } = rollup(db);
    catchUp();
    db.exec("DELETE FROM usage_requests");
    // New requests arrive before the next step and take rowids 1 to 3 again.
    for (let index = 0; index < 3; index += 1) insert(db, { at: T0 + DAY + index * MINUTE });
    clock.now = T0 + 2 * DAY;
    catchUp();
    expect(rolledUp(db)).toBe(5);
    expect(total(r)?.requests).toBe(5);
  });

  it("does not roll up surviving rows again when pruning removes the newest rowid", () => {
    const db = database();
    insert(db, { at: T0 + MINUTE });
    insert(db, { at: T0 });
    const { rollup: r, catchUp } = rollup(db);
    catchUp();
    db.exec("DELETE FROM usage_requests WHERE rowid = 2");
    catchUp();
    expect(total(r)?.requests).toBe(2);
  });

  it.each([
    [35, 7],
    // s2's refresh is rolled up and its resume is live: the seed at the cursor carries the refresh.
    [60, 9],
  ])("classifies resumes exactly as the CLI report does, final up to T0 + %i min", (final, rows) => {
    const db = database();
    sessions(db);
    // Rows that started up to final are rolled up; the rest is the live edge, seeded at the cursor.
    const { rollup: r, catchUp } = rollup(db, T0 + final * MINUTE + COMPLETE_AFTER_MS + 1);
    catchUp();
    expect(rolledUp(db)).toBe(rows);
    const { report: result, metrics } = expectReportAgreement(db, r);
    expect(result.total.idle).toMatchObject({ afterExpiry: 4, coldRewrites: 2, rewritesAvoided: 1, hitsWithoutRefresh: 1 });
    expect(metrics.requests).toBe(10);
    expect(metrics.refreshes).toBe(2);
    expect(metrics.nativeCacheRead / metrics.nativePromptTokens).toBeCloseTo(result.total.cacheHitRatio!, 10);
  });

  it("keeps rows provisional until no earlier-started request can still complete", () => {
    const db = database();
    const { rollup: r, catchUp, clock } = rollup(db, T0 + 12 * MINUTE);
    // A resume at T0 + 10 min completes first; the request it resumes from, started at T0, is
    // written after it.
    insert(db, { at: T0 + 10 * MINUTE, read: 0, write: 500_000 });
    catchUp();
    expect(rolledUp(db)).toBe(0);
    expect(total(r)).toMatchObject({ requests: 1, afterExpiry: 0 });
    insert(db, { at: T0, read: 0, write: 400_000 });
    expect(total(r)).toMatchObject({ requests: 2, afterExpiry: 1, coldRewrites: 1 });
    clock.now = T0 + 10 * MINUTE + COMPLETE_AFTER_MS + 1;
    catchUp();
    expect(rolledUp(db)).toBe(2);
    expectReportAgreement(db, r);
    expect(total(r)).toMatchObject({ requests: 2, afterExpiry: 1, coldRewrites: 1 });
  });

  it("finalizes nothing that started after a request still open, however long it runs", () => {
    const db = database();
    const { rollup: r, catchUp, clock } = rollup(db, T0 + 45 * MINUTE);
    // A request started at T0 streams for 41 minutes; a resume at T0 + 10 min ends first.
    clock.openSince = T0;
    insert(db, { at: T0 + 10 * MINUTE, read: 0, write: 500_000 });
    catchUp();
    expect(rolledUp(db)).toBe(0);
    expect(total(r)).toMatchObject({ requests: 1, afterExpiry: 0 });
    clock.openSince = null;
    insert(db, { at: T0, read: 0, write: 400_000 });
    catchUp();
    expect(rolledUp(db)).toBe(2);
    expect(total(r)).toMatchObject({ requests: 2, afterExpiry: 1, coldRewrites: 1 });
    expect(stats(r).pendingRows).toBe(0);
    expectReportAgreement(db, r);
  });

  it("takes the write lock before reading, and reports a held lock as busy", () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-rollup-"));
    try {
      const file = join(dir, "data.db");
      const db = new Database(file);
      db.pragma("journal_mode = WAL");
      for (const statement of QUOTA_MIGRATIONS) db.exec(statement);
      db.pragma("busy_timeout = 0");
      sessions(db);
      const other = new Database(file);
      other.exec("BEGIN IMMEDIATE");
      const { rollup: r } = rollup(db);
      const batch = vi.spyOn(UsageRollup.prototype as unknown as { rollBatch: () => boolean }, "rollBatch");
      expect(r.step()).toBe("busy");
      expect(batch).not.toHaveBeenCalled();
      // A query still reads, from the hours rolled up so far plus the live edge.
      expect(total(r)?.requests).toBe(10);
      other.exec("COMMIT");
      expect(r.step()).toBe("done");
      expect(batch).toHaveBeenCalledTimes(1);
      expect(rolledUp(db)).toBe(10);
      batch.mockRestore();
      other.close();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("answers a query without rolling up, leaving a large backlog out as pending", () => {
    const db = database();
    db.transaction(() => {
      for (let index = 0; index < 10_001; index += 1) insert(db, { at: T0 + (index % 600) * MINUTE });
    })();
    const { rollup: r } = rollup(db);
    expect(stats(r)).toMatchObject({ pendingRows: 10_001, results: [[]] });
    expect(rolledUp(db)).toBe(0);
    expect(r.step()).toBe("behind");
    expect(stats(r)).toMatchObject({ pendingRows: 0, results: [[{ metrics: { requests: 10_001 } }]] });
    expect(rolledUp(db)).toBe(2_000);
  });

  it("drops hours past the retention", () => {
    const db = database();
    insert(db, { at: T0 - 40 * DAY });
    insert(db, { at: T0 });
    const { rollup: r, catchUp } = rollup(db, T0 + HOUR, 30);
    catchUp();
    db.exec("DELETE FROM usage_requests");
    expect(total(r)?.requests).toBe(1);
    expect(stats(r).oldestHour).toBe(T0);
  });
});

describe("runUsageRollup", () => {
  it("steps at once while behind, idles when done, and backs off while the lock is held", () => {
    const results: Array<"busy" | "behind" | "done"> = ["behind", "behind", "busy", "busy", "busy", "busy", "busy", "busy", "done", "busy"];
    const delays: number[] = [];
    let next: (() => void) | null = null;
    const stop = runUsageRollup(
      { step: () => results.shift()! },
      {
        idleMs: 60_000,
        busyMs: 1_000,
        defer: (run, delay) => {
          delays.push(delay);
          next = run;
          return () => {
            next = null;
          };
        },
      },
    );
    while (results.length > 0) next!();
    expect(delays).toEqual([0, 0, 0, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 1_000]);
    stop();
    expect(next).toBeNull();
  });
});

describe("usage stats queries", () => {
  function fixture() {
    const db = database();
    insert(db, { at: T0, model: "claude-opus-5-5", account: "acct-a", role: "coordinator", thread: "thr_c" });
    insert(db, { at: T0 + 2 * HOUR, model: "claude-haiku-5-5", account: "acct-b", role: null, thread: null, session: null });
    insert(db, { at: T0 + 23 * HOUR, model: "claude-opus-5-5", account: "acct-b", role: "work", thread: "thr_w" });
    insert(db, { at: T0 + 23 * HOUR, provider: "codex", model: "gpt-6-luna", account: "acct-x", role: "work", thread: "thr_w", read: null, write: null, input: null, output: null });
    // The last two are the live edge.
    const { rollup: r, catchUp } = rollup(db, T0 + 23 * HOUR + 10 * MINUTE);
    catchUp();
    expect(rolledUp(db)).toBe(2);
    return r;
  }

  it("groups by dimension, an unknown value as null", () => {
    const r = fixture();
    const [byModel, byThread, byProviderRole] = stats(r, {
      groups: [["model"], ["thread"], ["provider", "role"]],
    }).results;
    expect(byModel?.map((row) => [row.key.model, row.metrics.requests]).sort()).toEqual([
      ["claude-haiku-5-5", 1],
      ["claude-opus-5-5", 2],
      ["gpt-6-luna", 1],
    ]);
    expect(byThread?.map((row) => [row.key.thread, row.metrics.requests])).toContainEqual([null, 1]);
    expect(byProviderRole?.find((row) => row.key.provider === "codex")).toMatchObject({
      key: { provider: "codex", role: "work" },
      metrics: { requests: 1, withUsage: 0, inputEquivalent: 0 },
    });
  });

  it("filters rolled-up hours and the live edge alike, with null matching an unknown value", () => {
    const r = fixture();
    expect(total(r, { filter: { account: ["acct-b"] } })?.requests).toBe(2);
    expect(total(r, { filter: { role: [null] } })?.requests).toBe(1);
    expect(total(r, { filter: { thread: ["thr_w", "thr_c"], provider: ["claude"] } })?.requests).toBe(2);
    expect(total(r, { from: T0 + HOUR, to: T0 + 23 * HOUR })?.requests).toBe(1);
    expect(stats(r, { filter: { model: [] } }).results[0]).toEqual([]);
  });

  it("counts each hour in the last bucket starting at or before it", () => {
    const r = fixture();
    const hours = stats(r, { bucket: { starts: [T0, T0 + HOUR, T0 + 2 * HOUR, T0 + 23 * HOUR] }, groups: [["bucket"]] }).results[0];
    expect(hours?.map((row) => [row.key.bucket, row.metrics.requests])).toEqual([
      [T0, 1],
      [T0 + 2 * HOUR, 1],
      [T0 + 23 * HOUR, 2],
    ]);
    // Calendar days of 23 and 25 hours (a DST change) come from the caller's starts.
    const days = stats(r, { bucket: { starts: [T0 - 11 * HOUR, T0 + HOUR, T0 + 24 * HOUR] }, groups: [["bucket"]] }).results[0];
    expect(days?.map((row) => [row.key.bucket, row.metrics.requests])).toEqual([
      [T0 - 11 * HOUR, 1],
      [T0 + HOUR, 3],
    ]);
  });

  it("counts the hour that holds a half-hour from in the first bucket", () => {
    const db = database();
    // UTC+05:30: the local day starts at 18:30 UTC; a request at 18:45 UTC is in it.
    const from = Date.UTC(2026, 9, 6, 18, 30);
    insert(db, { at: from + 15 * MINUTE });
    const { rollup: r, catchUp } = rollup(db);
    catchUp();
    const result = stats(r, { from, to: from + DAY, bucket: { starts: [from] }, groups: [[], ["bucket"]] });
    expect(result.results[0]?.[0]?.metrics.requests).toBe(1);
    expect(result.results[1]?.map((row) => [row.key.bucket, row.metrics.requests])).toEqual([[from, 1]]);
  });

  it("rejects a bucket group without bucket starts, and starts out of order", () => {
    expect(
      usageStatsInputSchema.safeParse({ from: 0, to: 1, bucket: null, filter: {}, groups: [["bucket"]] }).success,
    ).toBe(false);
    expect(
      usageStatsInputSchema.safeParse({ from: 0, to: 1, bucket: { starts: [2, 1] }, filter: {}, groups: [["bucket"]] }).success,
    ).toBe(false);
  });
});

describe("queryUsageQuota", () => {
  function quota(db: Database.Database, at: number, account: string, fiveHour: number, resetAt: number) {
    db.prepare(
      `INSERT INTO usage_quota (at, account_id, five_hour_utilization, five_hour_reset_at,
         seven_day_utilization, seven_day_reset_at, family_weekly_json, limit_windows_json)
       VALUES (?, ?, ?, ?, 0.5, ?, '{"fable":[0.2,${resetAt}]}', '[]')`,
    ).run(at, account, fiveHour, resetAt, resetAt + DAY);
  }

  it("returns each account's changes in range with the last one before it", () => {
    const db = database();
    quota(db, T0 - 3 * HOUR, "a", 0.1, T0);
    quota(db, T0 - 2 * HOUR, "a", 0.2, T0);
    quota(db, T0 + HOUR, "a", 0.05, T0 + 5 * HOUR);
    quota(db, T0 + 2 * HOUR, "b", 0.3, T0 + 5 * HOUR);
    quota(db, T0 + 3 * HOUR, "a", 0.9, T0 + 5 * HOUR);
    const result = queryUsageQuota(db, { from: T0, to: T0 + 3 * HOUR });
    expect(result.accounts).toEqual([
      {
        accountId: "a",
        points: [
          {
            at: T0 - 2 * HOUR,
            windows: {
              "5h": { utilization: 0.2, resetAt: T0 },
              "7d": { utilization: 0.5, resetAt: T0 + DAY },
              "7d fable": { utilization: 0.2, resetAt: T0 },
            },
          },
          expect.objectContaining({ at: T0 + HOUR }),
        ],
      },
      { accountId: "b", points: [expect.objectContaining({ at: T0 + 2 * HOUR })] },
    ]);
  });
});
