// The usage ledger and its report over a real SQLite database: request rows, idle gaps across a
// restart, write failures that stay inside the ledger, quota history dedupe, retention, settings
// periods, and the report's aggregation on a fixture that changes the cache TTL mid-way.
import fs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountQuota } from "./contracts.js";
import {
  openLedgerDatabase,
  readResumeSamples,
  UsageLedger,
  type LedgerDeps,
  type RequestRecord,
  type UsageRequestRow,
} from "./ledger.js";
import { QUOTA_MIGRATIONS } from "./store.js";
import type { WarmingOutcome } from "./warming.js";
import {
  buildUsageReport,
  formatUsageReport,
  parseSince,
} from "./usage-report.js";

const T0 = Date.UTC(2026, 9, 5, 10);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function database(): Database.Database {
  const db = new Database(":memory:");
  for (const statement of QUOTA_MIGRATIONS) db.exec(statement);
  return db;
}

function rig(db = database(), overrides: Partial<LedgerDeps> = {}) {
  let clock = T0;
  const flushes: Array<() => void> = [];
  const delays: number[] = [];
  const logs: string[] = [];
  const ledger = new UsageLedger({
    db,
    now: () => clock,
    retentionDays: () => 30,
    thread: (key) =>
      key === "session:s1" ? { threadId: "thr_1", role: "coordinator" } : null,
    log: (message) => logs.push(message),
    defer: (flush, delay) => {
      flushes.push(flush);
      delays.push(delay);
    },
    ...overrides,
  });
  return {
    db,
    ledger,
    logs,
    flushes,
    delays,
    set: (at: number) => {
      clock = at;
    },
  };
}

function claudeBody(ttl: "5m" | "1h" = "5m"): Uint8Array {
  const cache = ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
  return new TextEncoder().encode(
    JSON.stringify({
      model: "claude-opus-5-5",
      system: [{ type: "text", text: "secret prompt", cache_control: cache }],
      messages: [{ role: "user", content: [{ type: "text", text: "secret turn", cache_control: cache }] }],
    }),
  );
}

function record(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    kind: "native",
    provider: "claude",
    sessionKey: "session:s1",
    accountId: ACCOUNT,
    family: "opus",
    body: claudeBody(),
    startedAt: T0,
    finishedAt: T0 + 2_000,
    status: 200,
    completed: true,
    usage: {
      inputTokens: 4,
      outputTokens: 10,
      cacheReadTokens: 80_000,
      cacheWriteTokens: 20_000,
      cacheWrite5mTokens: 20_000,
      cacheWrite1hTokens: 0,
    },
    ...overrides,
  };
}

function requestRows(db: Database.Database): UsageRequestRow[] {
  return db.prepare("SELECT * FROM usage_requests ORDER BY at, rowid").all() as UsageRequestRow[];
}

function quota(overrides: Partial<AccountQuota> = {}): AccountQuota {
  return {
    accountId: ACCOUNT,
    fiveHourUtilization: 0.1,
    fiveHourResetAt: T0 + 3 * 60 * MINUTE,
    fiveHourStatus: "allowed",
    sevenDayUtilization: 0.4,
    sevenDayResetAt: T0 + 3 * DAY,
    sevenDayStatus: "allowed",
    representativeClaim: null,
    familyWeekly: { fable: null, sonnet: null, opus: null, haiku: null, other: null },
    limitWindows: [],
    observedAt: T0,
    heldUntil: null,
    error: null,
    ...overrides,
  };
}

describe("usage ledger request rows", () => {
  it("writes one row per request after the response, with counts and ids only", () => {
    const r = rig();
    r.ledger.request(record());
    // Nothing is written while the response is being delivered.
    expect(requestRows(r.db)).toEqual([]);
    expect(r.flushes).toHaveLength(1);
    r.flushes[0]?.();
    const [row] = requestRows(r.db);
    expect(row).toEqual({
      at: T0,
      kind: "native",
      provider: "claude",
      session_key: "session:s1",
      thread_id: "thr_1",
      role: "coordinator",
      initiative: null,
      purpose: null,
      account_id: ACCOUNT,
      model: "claude-opus-5-5",
      family: "opus",
      ttl: "5m",
      status: 200,
      completed: 1,
      latency_ms: 2_000,
      idle_gap_ms: null,
      input_tokens: 4,
      output_tokens: 10,
      cache_read_tokens: 80_000,
      cache_write_tokens: 20_000,
      cache_write_5m_tokens: 20_000,
      cache_write_1h_tokens: 0,
    });
    expect(JSON.stringify(requestRows(r.db))).not.toContain("secret");
  });

  it("reads at most 8 MiB of request bodies per flush and leaves the rest for the next", () => {
    const r = rig();
    // Three 3 MB bodies: one flush takes two, a later flush the third.
    const large = () => {
      const body = new Uint8Array(3 * 1024 * 1024).fill(0x20);
      body.set(claudeBody());
      return body;
    };
    for (let index = 0; index < 3; index += 1) r.ledger.request(record({ body: large() }));
    r.flushes[0]?.();
    expect(requestRows(r.db)).toHaveLength(2);
    expect(r.flushes).toHaveLength(2);
    expect(r.delays[1]).toBe(0);
    r.flushes[1]?.();
    expect(requestRows(r.db).map((row) => row.model)).toEqual([
      "claude-opus-5-5",
      "claude-opus-5-5",
      "claude-opus-5-5",
    ]);
  });

  it("writes every queued row on close, whatever their bodies weigh", () => {
    const r = rig();
    const large = () => {
      const body = new Uint8Array(3 * 1024 * 1024).fill(0x20);
      body.set(claudeBody());
      return body;
    };
    for (let index = 0; index < 3; index += 1) r.ledger.request(record({ body: large() }));
    r.ledger.close();
    expect(requestRows(r.db)).toHaveLength(3);
    expect(r.ledger.status().dropped).toBe(0);
  });

  it("writes a row with no model for a body that is not JSON", () => {
    const r = rig();
    r.ledger.request(
      record({ body: new TextEncoder().encode('{"model":"bad\\q"}'), status: 400, usage: null }),
    );
    r.flushes[0]?.();
    expect(requestRows(r.db).map((row) => [row.model, row.ttl, row.status])).toEqual([[null, null, 400]]);
    expect(r.ledger.status()).toMatchObject({ dropped: 0, writeErrors: 0 });
  });

  it("measures the idle gap per session and model, also across a restart", () => {
    const db = database();
    const first = rig(db);
    first.ledger.request(record());
    first.ledger.request(record({ startedAt: T0 + 10_000, finishedAt: T0 + 12_000, kind: "refresh" }));
    first.ledger.request(record({ startedAt: T0 + 7 * MINUTE, finishedAt: T0 + 7 * MINUTE + 1_000 }));
    first.flushes[0]?.();
    const second = rig(db);
    second.ledger.request(record({ startedAt: T0 + 20 * MINUTE, finishedAt: T0 + 20 * MINUTE + 1_000 }));
    second.ledger.request(record({ sessionKey: "session:other", startedAt: T0 + 21 * MINUTE }));
    second.flushes[0]?.();
    expect(requestRows(db).map((row) => [row.kind, row.idle_gap_ms])).toEqual([
      ["native", null],
      ["refresh", null],
      ["native", 7 * MINUTE - 2_000],
      ["native", 13 * MINUTE - 1_000],
      ["native", null],
    ]);
  });

  it("records Codex model and usage without a TTL, and an advisor request without a session", () => {
    const r = rig();
    r.ledger.request(
      record({
        provider: "codex",
        family: "other",
        sessionKey: "session:codex-thread",
        body: new TextEncoder().encode(JSON.stringify({ model: "gpt-6-luna", input: [] })),
        usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 900, cacheWriteTokens: 0, cacheWrite5mTokens: null, cacheWrite1hTokens: null },
      }),
    );
    r.ledger.request(record({ kind: "advisor", sessionKey: null, usage: null, status: 429 }));
    r.flushes[0]?.();
    expect(requestRows(r.db).map((row) => [row.provider, row.kind, row.model, row.ttl, row.thread_id, row.cache_read_tokens, row.status])).toEqual([
      ["codex", "native", "gpt-6-luna", null, null, 900, 200],
      ["claude", "advisor", "claude-opus-5-5", "5m", null, null, 429],
    ]);
  });

  it("a failed write is counted and logged at most once a minute, and never thrown", () => {
    const r = rig();
    r.db.exec("DROP TABLE usage_requests");
    r.ledger.request(record());
    expect(() => r.flushes[0]?.()).not.toThrow();
    r.ledger.request(record());
    expect(() => r.flushes[1]?.()).not.toThrow();
    // Two inserts and the first prune, all on the dropped table.
    expect(r.ledger.status()).toMatchObject({ writeErrors: 3, rowsWritten: 0, dropped: 2 });
    expect(r.ledger.status().lastError).toContain("usage_requests");
    expect(r.logs).toHaveLength(1);
    expect(r.logs[0]).toContain("usage ledger write failed");
  });
});

describe("usage ledger quota history", () => {
  it("keeps a row only when an observation changes, ignoring a reset time's seconds", () => {
    const db = database();
    const r = rig(db);
    r.ledger.quota(quota());
    r.ledger.quota(quota({ observedAt: T0 + MINUTE }));
    r.ledger.quota(quota({ observedAt: T0 + 2 * MINUTE, sevenDayResetAt: T0 + 3 * DAY + 1_000, error: "held" }));
    r.ledger.quota(quota({ observedAt: T0 + 3 * MINUTE, sevenDayUtilization: 0.41 }));
    r.ledger.quota(quota({ accountId: OTHER, observedAt: T0 + 3 * MINUTE }));
    r.ledger.quota(quota({ observedAt: null, sevenDayUtilization: 0.9 }));
    r.flushes[0]?.();
    // After a restart the last stored row is the baseline.
    const restarted = rig(db);
    restarted.ledger.quota(quota({ observedAt: T0 + 4 * MINUTE, sevenDayUtilization: 0.41 }));
    restarted.ledger.quota(
      quota({
        observedAt: T0 + 5 * MINUTE,
        sevenDayUtilization: 0.41,
        familyWeekly: { fable: null, sonnet: null, haiku: null, other: null, opus: { utilization: 0.2, resetAt: T0 + DAY, status: "allowed", observedAt: T0, source: "header" } },
      }),
    );
    restarted.flushes[0]?.();
    const rows = db.prepare("SELECT at, account_id, seven_day_utilization, family_weekly_json FROM usage_quota ORDER BY at, rowid").all();
    expect(rows).toEqual([
      { at: T0, account_id: ACCOUNT, seven_day_utilization: 0.4, family_weekly_json: "{}" },
      { at: T0 + 3 * MINUTE, account_id: ACCOUNT, seven_day_utilization: 0.41, family_weekly_json: "{}" },
      { at: T0 + 3 * MINUTE, account_id: OTHER, seven_day_utilization: 0.4, family_weekly_json: "{}" },
      { at: T0 + 5 * MINUTE, account_id: ACCOUNT, seven_day_utilization: 0.41, family_weekly_json: `{"opus":[0.2,${T0 + DAY}]}` },
    ]);
  });
});

describe("usage ledger retention and settings", () => {
  it("prunes rows past the retention, keeping the settings in force at the cutoff", () => {
    const r = rig();
    r.set(T0 - 40 * DAY);
    r.ledger.settings({ claudeMainCacheTtl: "1h", warming: { mode: "off" } });
    r.set(T0 - 35 * DAY);
    r.ledger.settings({ claudeMainCacheTtl: "5m", warming: { mode: "off" } });
    r.ledger.settings({ claudeMainCacheTtl: "5m", warming: { mode: "off" } });
    r.set(T0 - DAY);
    r.ledger.settings({ claudeMainCacheTtl: "5m", warming: { mode: "warm" } });
    r.ledger.request(record({ startedAt: T0 - 31 * DAY }));
    r.ledger.request(record({ startedAt: T0 - 29 * DAY }));
    r.ledger.quota(quota({ observedAt: T0 - 31 * DAY }));
    r.ledger.quota(quota({ observedAt: T0 - DAY, sevenDayUtilization: 0.5 }));
    r.set(T0);
    r.flushes[0]?.();
    expect(requestRows(r.db).map((row) => row.at)).toEqual([T0 - 29 * DAY]);
    expect(r.db.prepare("SELECT at FROM usage_quota").all()).toEqual([{ at: T0 - DAY }]);
    expect(r.db.prepare("SELECT at, settings_json FROM usage_settings ORDER BY at").all()).toEqual([
      { at: T0 - 35 * DAY, settings_json: '{"claudeMainCacheTtl":"5m","warming":{"mode":"off"}}' },
      { at: T0 - DAY, settings_json: '{"claudeMainCacheTtl":"5m","warming":{"mode":"warm"}}' },
    ]);
  });

  it("a build without the ledger migration still starts on a migrated database", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-ledger-"));
    cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
    const host = createFakePluginHost({ pluginId: "account-pool-local", dataDir });
    const db = host.bb.storage.database();
    host.bb.storage.migrate(db, QUOTA_MIGRATIONS);
    // The previous build's list: the same statements without the last one.
    expect(() => host.bb.storage.migrate(db, QUOTA_MIGRATIONS.slice(0, -1))).not.toThrow();
    expect(() => host.bb.storage.migrate(db, QUOTA_MIGRATIONS)).not.toThrow();
  });
});

describe("advisor attribution (W256)", () => {
  const codexBody = () => new TextEncoder().encode(JSON.stringify({ model: "gpt-6-luna", input: [] }));
  const advisor = (attribution: RequestRecord["attribution"], usage = { inputTokens: 1_000, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 0, cacheWrite5mTokens: null, cacheWrite1hTokens: null }) =>
    record({ kind: "advisor", provider: "codex", sessionKey: null, family: "other", body: codexBody(), attribution, usage });

  it("stores the named thread, its role, the Initiative and the purpose on the row", () => {
    const r = rig(database(), { role: (threadId) => (threadId === "thr_coord" ? "coordinator" : null) });
    r.ledger.request(advisor({ initiative: "ini_1", threadId: "thr_coord", purpose: "memory-tree" }));
    r.ledger.request(advisor(null));
    r.flushes[0]?.();
    expect(requestRows(r.db).map((row) => [row.kind, row.thread_id, row.role, row.initiative, row.purpose])).toEqual([
      ["advisor", "thr_coord", "coordinator", "ini_1", "memory-tree"],
      ["advisor", null, null, null, null],
    ]);
  });

  it("the report breaks advisor usage down by purpose and Initiative, in JSON and in text", () => {
    const r = rig(database(), { role: () => "coordinator" });
    const tree = (initiative: string, threadId: string | null, inputTokens: number) =>
      advisor({ initiative, threadId, purpose: "memory-tree" }, { inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite5mTokens: null, cacheWrite1hTokens: null });
    r.ledger.request(tree("ini_small", "thr_small", 1_000));
    r.ledger.request(tree("ini_big", "thr_big", 4_000_000));
    r.ledger.request(tree("ini_big", "thr_big", 1_000_000));
    r.ledger.request({ ...tree("ini_big", "thr_big", 5), status: 429, usage: null });
    r.ledger.request(advisor(null));
    r.flushes[0]?.();
    const report = buildUsageReport(r.db, {
      since: T0 - MINUTE,
      until: T0 + MINUTE,
      ledger: { since: T0, rowsWritten: 0, writeErrors: 0, busyRetries: 0, dropped: 0, lastError: null, retentionDays: 30 },
      accountLabels: {},
    });
    expect(report.advisor.map(({ provider, purpose, initiative, threadId, requests, errors, input, inputEquivalent }) => ({ provider, purpose, initiative, threadId, requests, errors, input, inputEquivalent }))).toEqual([
      { provider: "codex", purpose: "memory-tree", initiative: "ini_big", threadId: "thr_big", requests: 3, errors: 1, input: 5_000_000, inputEquivalent: 5_000_000 },
      // The unattributed call: 1,000 input, 20 output (5x), 900 cached (0.1x).
      { provider: "codex", purpose: null, initiative: null, threadId: null, requests: 1, errors: 0, input: 1_000, inputEquivalent: 1_000 + 20 * 5 + 900 * 0.1 },
      { provider: "codex", purpose: "memory-tree", initiative: "ini_small", threadId: "thr_small", requests: 1, errors: 0, input: 1_000, inputEquivalent: 1_000 },
    ]);
    expect(JSON.parse(JSON.stringify(report)).advisor).toHaveLength(3);
    const text = formatUsageReport(report);
    expect(text).toContain("Advisor by purpose and Initiative");
    expect(text).toContain("codex memory-tree · ini_big · thr_big: 3 req (1 not 2xx), 5.0M input-eq (in 5.0M, cached 0, out 0)");
    expect(text).toContain("codex (no purpose) · (no Initiative) · (no thread): 1 req");
  });
});

describe("usage report", () => {
  // Session a runs under ttl 1h with warming off; at T0+2h the TTL becomes 5m and warming warm,
  // and session b starts: one refresh keeps it warm across an 8 minute gap, then a 31 minute gap
  // without a refresh rewrites the prefix.
  function fixtureLedger(): Database.Database {
    const db = database();
    const settings = db.prepare("INSERT INTO usage_settings (at, settings_json) VALUES (?, ?)");
    settings.run(T0 - 60 * MINUTE, JSON.stringify({ claudeMainCacheTtl: "1h", warming: { mode: "off", families: ["opus"] } }));
    settings.run(T0 + 120 * MINUTE, JSON.stringify({ claudeMainCacheTtl: "5m", warming: { mode: "warm", families: ["opus"], coordinatorMinutes: 20, workerActiveMinutes: 15, workerReportedMinutes: 10 } }));
    const insert = db.prepare(
      `INSERT INTO usage_requests (at, kind, provider, session_key, account_id, model, family, ttl, status, completed,
        latency_ms, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_5m_tokens, cache_write_1h_tokens)
       VALUES (?, ?, 'claude', ?, ?, 'claude-opus-5-5', 'opus', ?, ?, 1, 1000, ?, ?, ?, ?, ?, ?)`,
    );
    const row = (at: number, kind: string, session: string | null, ttl: string | null, read: number, write: number, extra: { account?: string; input?: number; output?: number; status?: number } = {}) =>
      insert.run(at, kind, session, extra.account ?? ACCOUNT, ttl, extra.status ?? 200, extra.input ?? 4, extra.output ?? 0, read, write, ttl === "1h" ? 0 : write, ttl === "1h" ? write : 0);
    row(T0 - 10 * MINUTE, "native", "session:a", "1h", 0, 99_000);
    row(T0, "native", "session:a", "1h", 0, 50_000);
    row(T0 + 30 * MINUTE, "native", "session:a", "1h", 50_000, 1_000);
    row(T0 + 121 * MINUTE, "native", "session:b", "5m", 0, 40_000);
    row(T0 + 125 * MINUTE, "refresh", "session:b", "5m", 40_000, 0);
    row(T0 + 129 * MINUTE, "native", "session:b", "5m", 40_000, 2_000);
    row(T0 + 130 * MINUTE, "advisor", null, "5m", 0, 0, { account: OTHER, input: 1_000, output: 200 });
    row(T0 + 160 * MINUTE, "native", "session:b", "5m", 0, 42_000);
    row(T0 + 161 * MINUTE, "native", "session:b", "5m", 0, 0, { status: 529 });
    const quotas = db.prepare(
      `INSERT INTO usage_quota (at, account_id, five_hour_utilization, five_hour_reset_at, seven_day_utilization, seven_day_reset_at,
        family_weekly_json, limit_windows_json) VALUES (?, ?, ?, ?, ?, ?, '{}', '[]')`,
    );
    const fiveHourReset = T0 + 60 * MINUTE;
    const sevenDayReset = T0 + 3 * DAY;
    quotas.run(T0 - 30 * MINUTE, ACCOUNT, 0.1, fiveHourReset, 0.4, sevenDayReset);
    quotas.run(T0 + 60 * MINUTE - 1, ACCOUNT, 0.2, fiveHourReset, 0.42, sevenDayReset);
    quotas.run(T0 + 180 * MINUTE, ACCOUNT, 0.05, fiveHourReset + 5 * 60 * MINUTE, 0.45, sevenDayReset);
    return db;
  }

  function report() {
    return buildUsageReport(fixtureLedger(), {
      since: T0,
      until: T0 + 200 * MINUTE,
      ledger: { since: T0, rowsWritten: 0, writeErrors: 0, busyRetries: 0, dropped: 0, lastError: null, retentionDays: 30 },
      accountLabels: { [ACCOUNT]: "main" },
    });
  }

  it("splits by settings period and judges cold starts against each request's TTL", () => {
    const result = report();
    expect(result.periods.map((period) => [period.from, period.to, period.settings?.claudeMainCacheTtl])).toEqual([
      [T0, T0 + 120 * MINUTE, "1h"],
      [T0 + 120 * MINUTE, null, "5m"],
    ]);
    const [hour, fiveMinutes] = result.periods.map((period) => period.stats);
    // Under 1h, a 30 minute gap is not an expiry.
    expect(hour?.claude.native).toMatchObject({ requests: 2, cacheRead: 50_000, cacheWrite: 51_000, cacheWrite1h: 51_000, cacheWrite5m: 0 });
    expect(hour?.idle.afterExpiry).toBe(0);
    expect(hour?.cacheHitRatio).toBeCloseTo(50_000 / (50_000 + 51_000 + 8));
    expect(fiveMinutes?.claude.native).toMatchObject({ requests: 4, errors: 1, cacheWrite5m: 84_000 });
    expect(fiveMinutes?.claude.refresh).toMatchObject({ requests: 1, cacheRead: 40_000, input: 4 });
    expect(fiveMinutes?.claude.advisor).toMatchObject({ requests: 1, input: 1_000, output: 200 });
    expect(fiveMinutes?.idle).toEqual({
      afterExpiry: 2,
      coldRewrites: 1,
      coldRewriteTokens: 42_000,
      coldDespiteRefresh: 0,
      rewritesAvoided: 1,
      rewriteTokensAvoided: 40_000,
      hitsWithoutRefresh: 0,
    });
    expect(fiveMinutes?.estimate.savedInputEquivalent).toBeCloseTo(40_000 * 1.15);
    expect(fiveMinutes?.estimate.refreshCostInputEquivalent).toBeCloseTo(40_000 * 0.1 + 4);
    expect(fiveMinutes?.estimate.netInputEquivalent).toBeCloseTo(46_000 - 4_004);
    expect(result.total.idle.rewritesAvoided).toBe(1);
    expect(result.days.map((day) => day.day)).toEqual(["2026-10-05"]);
    expect(result.days[0]?.stats.claude.native.requests).toBe(6);
  });

  it("adds quota burn per account, counting a reset window from zero", () => {
    const result = report();
    const [hour, fiveMinutes] = result.periods.map((period) => period.stats.accounts[ACCOUNT]?.windows);
    expect(hour?.["7d"]?.burn).toBeCloseTo(2);
    expect(hour?.["5h"]?.burn).toBeCloseTo(10);
    expect(fiveMinutes?.["7d"]?.burn).toBeCloseTo(3);
    expect(fiveMinutes?.["5h"]?.burn).toBeCloseTo(5);
    expect(fiveMinutes?.["7d"]?.last).toBeCloseTo(45);
    expect(result.total.accounts[ACCOUNT]?.windows["7d"]?.burn).toBeCloseTo(5);
    // An account whose quota was never observed has no windows, not a zero burn.
    expect(result.total.accounts[OTHER]).toEqual({ requests: 1, inputEquivalent: 2_000, windows: {} });
    expect(formatUsageReport(result)).toContain("22222222: 1 req, 2.0k input-eq · quota not observed");
  });

  it("prints a compact human report", () => {
    const text = formatUsageReport(report());
    expect(text).toContain("ttl 1h · warming off");
    expect(text).toContain("ttl 5m · warming warm (opus; coordinator 20m, worker 15/10m)");
    expect(text).toContain("2 after expiry: 1 cold rewrites (42.0k tok) · 1 kept warm (40.0k tok) · 0 warm without refresh");
    expect(text).toContain("net +42.0k input-eq");
    expect(text).toContain("main: ");
    expect(text).toContain("2026-10-05  native 6 · refresh 1 · advisor 1");
  });

  it("parses --since as a duration or an ISO date", () => {
    expect(parseSince("90m", T0)).toBe(T0 - 90 * MINUTE);
    expect(parseSince("7d", T0)).toBe(T0 - 7 * DAY);
    expect(parseSince("2026-10-01", T0)).toBe(Date.UTC(2026, 9, 1));
    expect(() => parseSince("yesterday", T0)).toThrow("--since");
  });
});

// Small scenarios for the review findings (A247): one session on one model unless stated.
function scenario() {
  const db = database();
  const insert = db.prepare(
    `INSERT INTO usage_requests (at, kind, provider, session_key, account_id, model, family, ttl, status, completed,
      latency_ms, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_5m_tokens, cache_write_1h_tokens)
     VALUES (?, ?, 'claude', 'session:s', ?, 'claude-opus-5-5', 'opus', ?, ?, ?, 0, ?, 0, ?, ?, NULL, NULL)`,
  );
  const add = (minute: number, kind: "native" | "refresh", read: number | null, write: number | null, options: { ttl?: "5m" | "1h"; status?: number | null } = {}) => {
    const status = options.status === undefined ? 200 : options.status;
    insert.run(T0 + minute * MINUTE, kind, ACCOUNT, options.ttl ?? "5m", status, status === null ? 0 : 1, read === null ? null : 4, read, write);
  };
  const run = (since = T0) =>
    buildUsageReport(db, {
      since,
      until: T0 + 120 * MINUTE,
      ledger: { since: T0, rowsWritten: 0, writeErrors: 0, busyRetries: 0, dropped: 0, lastError: null, retentionDays: 30 },
      accountLabels: {},
    }).total;
  return { db, add, run };
}

describe("usage report: A247 corrections", () => {
  it("2: a failed native attempt keeps the cache history, and a failed refresh proves nothing", () => {
    const retried = scenario();
    retried.add(0, "native", 0, 40_000);
    retried.add(4, "refresh", 40_000, 0);
    retried.add(7.99, "native", null, null, { status: 401 });
    retried.add(8, "native", 40_000, 0);
    expect(retried.run().idle).toMatchObject({ afterExpiry: 1, rewritesAvoided: 1, rewriteTokensAvoided: 40_000 });
    expect(retried.run().claude.native).toMatchObject({ requests: 3, errors: 1 });

    const failedRefresh = scenario();
    failedRefresh.add(0, "native", 0, 40_000);
    failedRefresh.add(4, "refresh", null, null, { status: 529 });
    failedRefresh.add(8, "native", 40_000, 0);
    const total = failedRefresh.run();
    expect(total.idle).toMatchObject({ afterExpiry: 1, rewritesAvoided: 0, hitsWithoutRefresh: 1 });
    expect(total.claude.refresh).toMatchObject({ requests: 1, errors: 1 });
  });

  it("4: a report starting mid-chain is seeded from earlier activity without counting it", () => {
    const s = scenario();
    s.add(0, "native", 0, 40_000);
    s.add(4, "refresh", 40_000, 0);
    s.add(8, "native", 40_000, 0);
    const full = s.run();
    const later = s.run(T0 + MINUTE);
    expect(later.idle).toEqual(full.idle);
    expect(later.estimate.netInputEquivalent).toBeCloseTo(40_000 * 1.15 - (40_000 * 0.1 + 4));
    // The seed native is not in the totals; the refresh after since is.
    expect([later.claude.native.requests, later.claude.refresh.requests]).toEqual([1, 1]);
  });

  it("5: expiry is judged by the previous entry's TTL across a TTL change", () => {
    const shorter = scenario();
    shorter.add(0, "native", 0, 40_000, { ttl: "5m" });
    shorter.add(8, "native", 0, 40_000, { ttl: "1h" });
    expect(shorter.run().idle).toMatchObject({ afterExpiry: 1, coldRewrites: 1, coldRewriteTokens: 40_000 });

    const longer = scenario();
    longer.add(0, "native", 0, 40_000, { ttl: "1h" });
    longer.add(4, "refresh", 40_000, 0, { ttl: "1h" });
    longer.add(8, "native", 40_000, 0, { ttl: "5m" });
    expect(longer.run().idle).toMatchObject({ afterExpiry: 0, rewritesAvoided: 0 });
  });

  it("7: reports Codex limit windows and per-family weekly burn", () => {
    const db = database();
    const quota = db.prepare(
      `INSERT INTO usage_quota (at, account_id, five_hour_utilization, five_hour_reset_at, seven_day_utilization, seven_day_reset_at,
        family_weekly_json, limit_windows_json) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?)`,
    );
    const reset = T0 + DAY;
    quota.run(T0, OTHER, null, null, "{}", JSON.stringify([["primary", 300, 0.1, reset], ["secondary", 10_080, 0.3, reset]]));
    quota.run(T0 + MINUTE, OTHER, null, null, "{}", JSON.stringify([["primary", 300, 0.2, reset], ["secondary", 10_080, 0.31, reset]]));
    quota.run(T0, ACCOUNT, 0.4, reset, JSON.stringify({ opus: [0.2, reset] }), "[]");
    quota.run(T0 + MINUTE, ACCOUNT, 0.41, reset, JSON.stringify({ opus: [0.25, reset] }), "[]");
    const report = buildUsageReport(db, {
      since: T0,
      until: T0 + 10 * MINUTE,
      ledger: { since: T0, rowsWritten: 0, writeErrors: 0, busyRetries: 0, dropped: 0, lastError: null, retentionDays: 30 },
      accountLabels: { [OTHER]: "codex" },
    });
    const codex = report.total.accounts[OTHER]?.windows;
    expect(codex?.["5h"]?.burn).toBeCloseTo(10);
    expect(codex?.["7d"]?.burn).toBeCloseTo(1);
    expect(report.total.accounts[ACCOUNT]?.windows["7d opus"]?.burn).toBeCloseTo(5);
    expect(formatUsageReport(report)).toContain("codex: 0 req, 0 input-eq · 5h +10.0pp (now 20%) · 7d +1.0pp (now 31%)");
  });
});

describe("usage ledger: A247 corrections", () => {
  it("1: a held write lock never makes the ledger wait; rows stay queued and retry", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bb-ledger-lock-"));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const shared = new Database(path.join(dir, "data.db"));
    shared.pragma("journal_mode = WAL");
    shared.pragma("busy_timeout = 5000");
    for (const statement of QUOTA_MIGRATIONS) shared.exec(statement);
    const own = openLedgerDatabase(shared, () => {});
    expect(own).not.toBe(shared);
    expect(shared.pragma("busy_timeout", { simple: true })).toBe(5000);
    const holder = new Database(path.join(dir, "data.db"));
    cleanups.push(async () => {
      for (const db of [holder, own, shared]) if (db.open) db.close();
    });
    const r = rig(own);
    r.ledger.request(record());
    holder.exec("BEGIN IMMEDIATE");
    const started = performance.now();
    r.flushes.shift()?.();
    expect(performance.now() - started).toBeLessThan(500);
    expect(r.ledger.status()).toMatchObject({ busyRetries: 1, rowsWritten: 0, writeErrors: 0 });
    expect(r.delays.at(-1)).toBe(1_000);
    holder.exec("COMMIT");
    r.flushes.shift()?.();
    expect(requestRows(shared)).toHaveLength(1);
  });

  it("names the oldest request still queued, so the rollup waits for its row", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bb-ledger-queued-"));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const shared = new Database(path.join(dir, "data.db"));
    shared.pragma("journal_mode = WAL");
    for (const statement of QUOTA_MIGRATIONS) shared.exec(statement);
    const own = openLedgerDatabase(shared, () => {});
    const holder = new Database(path.join(dir, "data.db"));
    cleanups.push(async () => {
      for (const db of [holder, own, shared]) if (db.open) db.close();
    });
    const r = rig(own);
    expect(r.ledger.oldestQueued()).toBeNull();
    r.ledger.request(record({ startedAt: T0 + MINUTE }));
    r.ledger.request(record({ startedAt: T0 }));
    expect(r.ledger.oldestQueued()).toBe(T0);
    // Parsed into rows but held back by another writer: still queued.
    holder.exec("BEGIN IMMEDIATE");
    r.flushes.shift()?.();
    expect(r.ledger.oldestQueued()).toBe(T0);
    holder.exec("COMMIT");
    r.flushes.shift()?.();
    expect(r.ledger.oldestQueued()).toBeNull();
  });

  it("names the sessions of requests queued but not written, parsed into rows or not", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bb-ledger-sessions-"));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const shared = new Database(path.join(dir, "data.db"));
    shared.pragma("journal_mode = WAL");
    for (const statement of QUOTA_MIGRATIONS) shared.exec(statement);
    const own = openLedgerDatabase(shared, () => {});
    const holder = new Database(path.join(dir, "data.db"));
    cleanups.push(async () => {
      for (const db of [holder, own, shared]) if (db.open) db.close();
    });
    const r = rig(own);
    r.ledger.request(record({ sessionKey: "session:s1" }));
    r.ledger.request(record({ sessionKey: null }));
    // Parsed into rows but held back by another writer.
    holder.exec("BEGIN IMMEDIATE");
    r.flushes.shift()?.();
    r.ledger.request(record({ sessionKey: "session:s2" }));
    expect(r.ledger.queuedSessions()).toEqual(new Set(["session:s1", "session:s2"]));
    holder.exec("COMMIT");
    r.flushes.shift()?.();
    expect(r.ledger.queuedSessions()).toEqual(new Set());
  });

  it("1: quota() and request() run no SQL; flushes write bounded batches and prune in chunks", () => {
    const db = database();
    const r = rig(db);
    const prepare = vi.spyOn(db, "prepare");
    r.ledger.quota(quota());
    for (let index = 0; index < 1_200; index += 1)
      r.ledger.request(record({ sessionKey: null, startedAt: T0 - 40 * DAY }));
    expect(prepare).not.toHaveBeenCalled();
    prepare.mockRestore();
    r.flushes.shift()?.();
    // 500 rows written, then the first prune chunk deletes them (they are past the retention).
    expect(r.ledger.status().rowsWritten).toBe(501);
    while (r.flushes.length > 0) r.flushes.shift()?.();
    expect(r.ledger.status().rowsWritten).toBe(1_201);
    expect(requestRows(db)).toEqual([]);
  });

  it("2: a failed native attempt gets an idle gap but never becomes the previous request", () => {
    const r = rig();
    r.ledger.request(record());
    r.ledger.request(record({ startedAt: T0 + 7 * MINUTE, finishedAt: T0 + 7 * MINUTE, status: 401, usage: null }));
    r.ledger.request(record({ startedAt: T0 + 8 * MINUTE, finishedAt: T0 + 8 * MINUTE + 1_000 }));
    r.flushes[0]?.();
    expect(requestRows(r.db).map((row) => row.idle_gap_ms)).toEqual([null, 7 * MINUTE - 2_000, 8 * MINUTE - 2_000]);
  });

  it("3: an observation whose write failed or was dropped is queued again next time", () => {
    const r = rig();
    r.db.exec("CREATE TRIGGER quota_full BEFORE INSERT ON usage_quota BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    r.ledger.quota(quota());
    r.flushes.shift()?.();
    expect(r.ledger.status()).toMatchObject({ writeErrors: 1, dropped: 1 });
    r.db.exec("DROP TRIGGER quota_full");
    r.ledger.quota(quota({ observedAt: T0 + MINUTE }));
    r.flushes.shift()?.();
    expect(r.db.prepare("SELECT at FROM usage_quota").all()).toEqual([{ at: T0 + MINUTE }]);
    // Request rows are written in their own transaction: a quota failure never takes them along.
    r.db.exec("CREATE TRIGGER quota_full BEFORE INSERT ON usage_quota BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    r.ledger.quota(quota({ observedAt: T0 + 2 * MINUTE, sevenDayUtilization: 0.5 }));
    r.ledger.request(record());
    r.flushes.shift()?.();
    expect(requestRows(r.db)).toHaveLength(1);
  });
});

describe("usage ledger warming outcomes (T141)", () => {
  function outcome(overrides: Partial<WarmingOutcome> = {}): WarmingOutcome {
    return {
      at: T0 + 20 * MINUTE,
      sessionId: "s1",
      threadId: "thr_1",
      model: "claude-opus-5-5",
      role: "worker",
      state: "background",
      waitStartedAt: T0 + 2_000,
      firstDecisionAt: T0 + 4 * MINUTE,
      prefixTokens: 100_000,
      ttl: "5m",
      refreshes: 3,
      kind: "end",
      reason: "a native request on the thread took over",
      reviewHold: null,
      ...overrides,
    };
  }

  it("writes one row per lease end or unwarmed wait, with its reason, and prunes it with the rest", () => {
    const r = rig();
    r.ledger.warming(outcome());
    r.ledger.warming(
      outcome({ role: null, state: null, firstDecisionAt: null, refreshes: 0, kind: "skip", reason: "skipped: no BB thread is linked to this Claude session" }),
    );
    r.flushes[0]?.();
    expect(r.db.prepare("SELECT * FROM usage_warming ORDER BY rowid").all()).toEqual([
      {
        at: T0 + 20 * MINUTE, session_key: "session:s1", thread_id: "thr_1", model: "claude-opus-5-5",
        role: "worker", state: "background", wait_started_at: T0 + 2_000, first_decision_at: T0 + 4 * MINUTE,
        prefix_tokens: 100_000, ttl: "5m", refreshes: 3, kind: "end", reason: "a native request on the thread took over",
        review_hold: null,
      },
      {
        at: T0 + 20 * MINUTE, session_key: "session:s1", thread_id: "thr_1", model: "claude-opus-5-5",
        role: null, state: null, wait_started_at: T0 + 2_000, first_decision_at: null,
        prefix_tokens: 100_000, ttl: "5m", refreshes: 0, kind: "skip", reason: "skipped: no BB thread is linked to this Claude session",
        review_hold: null,
      },
    ]);
    r.set(T0 + 31 * DAY);
    r.ledger.pruneSoon();
    r.flushes.at(-1)?.();
    expect(r.db.prepare("SELECT COUNT(*) AS n FROM usage_warming").get()).toEqual({ n: 0 });
  });

  it("reads each decided wait's length from the next native request of its session and model", () => {
    const r = rig();
    const wait = (overrides: Partial<WarmingOutcome>) => r.ledger.warming(outcome(overrides));
    // s1 resumes 9 minutes in; a Haiku helper in between does not count as a resume.
    wait({});
    r.ledger.request(record({ body: new TextEncoder().encode(JSON.stringify({ model: "claude-haiku-4-5" })), family: "haiku", startedAt: T0 + 3 * MINUTE }));
    r.ledger.request(record({ startedAt: T0 + 2_000 + 9 * MINUTE }));
    // s2 never resumed; s3 is still open; s4 never reached a decision; s5 has a value this build
    // does not know.
    wait({ sessionId: "s2", state: "idle", role: "standalone", waitStartedAt: T0 - 4 * 60 * MINUTE });
    wait({ sessionId: "s3", state: "idle", waitStartedAt: T0 - 60 * MINUTE });
    wait({ sessionId: "s4", state: null, firstDecisionAt: null });
    wait({ sessionId: "s5", state: "sleeping" as never });
    r.flushes[0]?.();
    expect(readResumeSamples(r.db, T0 - DAY, T0 + 30 * MINUTE, 100)).toEqual([
      { role: "worker", state: "background", waitMs: 9 * MINUTE },
      { role: "standalone", state: "idle", waitMs: null },
    ]);
  });

  it("D440: leaves waits under a review hold out of calibration", () => {
    const r = rig();
    r.ledger.warming(outcome({ sessionId: "s1", state: "idle", waitStartedAt: T0 - 4 * 60 * MINUTE }));
    r.ledger.warming(outcome({ sessionId: "s2", state: "idle", waitStartedAt: T0 - 4 * 60 * MINUTE, reviewHold: "review of W1 by W2 running (A2)" }));
    r.flushes[0]?.();
    expect(r.db.prepare("SELECT session_key, review_hold FROM usage_warming ORDER BY rowid").all()).toEqual([
      { session_key: "session:s1", review_hold: null },
      { session_key: "session:s2", review_hold: "review of W1 by W2 running (A2)" },
    ]);
    expect(readResumeSamples(r.db, T0 - DAY, T0, 100)).toEqual([{ role: "worker", state: "idle", waitMs: null }]);
  });

  it("W211 7: reads at most the newest `limit` waits through the wait_started_at index", () => {
    const r = rig();
    for (let index = 0; index < 5; index += 1)
      r.ledger.warming(outcome({ sessionId: `s${index}`, state: "idle", waitStartedAt: T0 - 5 * 60 * MINUTE + index * MINUTE }));
    r.flushes[0]?.();
    expect(readResumeSamples(r.db, T0 - DAY, T0, 2)).toHaveLength(2);
    const plan = r.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM usage_warming w WHERE w.wait_started_at >= ? AND w.state IS NOT NULL ORDER BY w.wait_started_at DESC LIMIT 2",
      )
      .all(0) as Array<{ detail: string }>;
    expect(plan.map((step) => step.detail).join(" ")).toContain("usage_warming_wait");
  });
});
