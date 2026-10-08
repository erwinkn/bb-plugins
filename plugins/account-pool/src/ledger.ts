import type Database from "better-sqlite3";
import { z } from "zod";
import type { AccountQuota, ModelFamily, PoolProvider } from "./contracts.js";
import {
  describeClaudeRequest,
  type CacheTtl,
  type CacheUsage,
} from "./cache-usage.js";
import { topLevelFields } from "./json-scan.js";
import type { WarmingOutcome } from "./warming.js";
import {
  waitStates,
  warmingRoles,
  type ResumeSample,
  type WaitState,
  type WarmingRole,
} from "./warming-economics.js";

// A durable record of what the Pooler forwarded and what each account's quota did, kept so a
// later report can tell whether cache warming saves more quota than it costs. Rows hold counts,
// ids and times only: never a request or response body, never prompt content.
//
// Nothing here may stall routing. request() and quota() only queue in memory. A flush on a later
// event-loop turn reads at most MAX_BATCH_BODY_BYTES of request bodies and writes at most
// MAX_BATCH rows per table through the ledger's own connection, which never waits for a lock: if
// another writer holds it, the rows stay queued and the flush retries a second later. Queues are bounded and drop their oldest row, counted. Any other write
// error is logged (at most once a minute) and counted, and its rows are dropped.

export const USAGE_LEDGER_KEY = "usage-ledger";
export const DEFAULT_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;
const PRUNE_INTERVAL_MS = 60 * 60_000;
const MAX_QUEUED_REQUESTS = 10_000;
const MAX_QUEUED_QUOTAS = 1_000;
const MAX_BATCH = 500;
const MAX_BATCH_BODY_BYTES = 8 * 1024 * 1024;
const BUSY_RETRY_MS = 1_000;
const MAX_IDLE_KEYS = 4_096;
const ERROR_LOG_INTERVAL_MS = 60_000;

export const usageLedgerConfigSchema = z
  .object({
    retentionDays: z
      .number()
      .int("Use whole days.")
      .min(1, "Must be at least 1.")
      .max(365, "Must be at most 365."),
  })
  .strict();
export type UsageLedgerConfig = z.infer<typeof usageLedgerConfigSchema>;

export type RequestKind = "native" | "refresh" | "advisor";

// Who an advisor caller says a request is for (the x-bb-initiative, x-bb-thread and x-bb-purpose
// headers, read by the hub; null for a field the caller left out).
export interface RequestAttribution {
  initiative: string | null;
  threadId: string | null;
  purpose: string | null;
}

// What the hub knows about one upstream request once it has finished: answered, failed to
// connect, or canceled after it was sent (status and usage null when unknown).
export interface RequestRecord {
  kind: RequestKind;
  provider: PoolProvider;
  // The request's affinity id ("session:<id>" or "cache:<key>"), or null.
  sessionKey: string | null;
  accountId: string;
  family: ModelFamily;
  // Read once, for the model and the tail breakpoint's TTL; never stored.
  body: Uint8Array;
  // Advisor requests only: with no session to find the thread by, the caller names it.
  attribution?: RequestAttribution | null;
  startedAt: number;
  finishedAt: number;
  status: number | null;
  completed: boolean;
  usage: CacheUsage | null;
}

export interface ThreadLabel {
  threadId: string;
  role: string | null;
}

export interface LedgerDeps {
  // The ledger's own connection (see openLedgerDatabase); tests pass any connection.
  db: Database.Database;
  now: () => number;
  retentionDays: () => number;
  // The BB thread behind a session key and its Initiative role, from what is already known.
  thread: (sessionKey: string) => ThreadLabel | null;
  // The Initiative role of a thread a caller named, from what is already known.
  role?: (threadId: string) => string | null;
  log: (message: string) => void;
  // Test seam: runs a flush after delayMs.
  defer?: (flush: () => void, delayMs: number) => void;
}

export interface UsageRequestRow {
  at: number;
  kind: RequestKind;
  provider: PoolProvider;
  session_key: string | null;
  thread_id: string | null;
  role: string | null;
  // The Initiative and purpose an advisor caller named (attribution), else null.
  initiative: string | null;
  purpose: string | null;
  account_id: string;
  model: string | null;
  family: string;
  ttl: CacheTtl | null;
  status: number | null;
  completed: number;
  latency_ms: number;
  idle_gap_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cache_write_5m_tokens: number | null;
  cache_write_1h_tokens: number | null;
}

export interface UsageQuotaRow {
  at: number;
  account_id: string;
  five_hour_utilization: number | null;
  five_hour_reset_at: number | null;
  seven_day_utilization: number | null;
  seven_day_reset_at: number | null;
  family_weekly_json: string;
  limit_windows_json: string;
}

// The settings a report splits periods by.
export interface LedgerSettings {
  claudeMainCacheTtl: CacheTtl;
  warming: Record<string, unknown>;
}

export interface UsageWarmingRow {
  at: number;
  session_key: string;
  thread_id: string | null;
  model: string | null;
  role: WarmingRole | null;
  state: WaitState | null;
  wait_started_at: number;
  first_decision_at: number | null;
  prefix_tokens: number;
  ttl: CacheTtl | null;
  refreshes: number;
  kind: "end" | "skip";
  reason: string;
  review_hold: string | null;
}

export interface UsageSettingsRow {
  at: number;
  settings: LedgerSettings;
}

export interface LedgerHealth {
  since: number;
  rowsWritten: number;
  writeErrors: number;
  // Flushes postponed because another connection held the write lock.
  busyRetries: number;
  dropped: number;
  lastError: string | null;
}

type QuotaSnapshot = Omit<UsageQuotaRow, "at">;
type QueuedQuota = UsageQuotaRow & { key: string };

// A second connection to the plugin database that fails at once on a held lock instead of waiting
// (BB's own handle waits up to 5 s). The shared handle's settings are left alone. Falls back to the
// shared handle, with a warning, where no second connection can be opened.
export function openLedgerDatabase(
  shared: Database.Database,
  log: (message: string) => void,
): Database.Database {
  try {
    if (shared.memory || shared.name === "") throw new Error("in-memory database");
    const Connection = shared.constructor as new (file: string) => Database.Database;
    const db = new Connection(shared.name);
    db.pragma("busy_timeout = 0");
    return db;
  } catch (error) {
    log(
      `Account Pooler usage ledger shares the plugin database connection: ${error instanceof Error ? error.message : String(error)}`,
    );
    return shared;
  }
}

export class UsageLedger {
  // Request records wait for their row (body parse, thread label, idle gap); rows wait for a write.
  private records: RequestRecord[] = [];
  private rows: UsageRequestRow[] = [];
  private quotas: QueuedQuota[] = [];
  private settingsRows: Array<{ at: number; settings_json: string }> = [];
  private warmingRows: UsageWarmingRow[] = [];
  private scheduled = false;
  private closed = false;
  private pruneDueAt = 0;
  private lastErrorLogAt = 0;
  // Per session key and model: when its previous successful native request finished.
  private readonly lastNativeEnd = new Map<string, number>();
  // Quota dedupe: what is stored per account, and what is queued but not yet stored.
  private readonly savedQuota = new Map<string, string>();
  private readonly queuedQuota = new Map<string, string>();
  private lastSettings: string | null = null;
  private readonly health: LedgerHealth;
  private readonly insertRequest: Database.Statement;
  private readonly insertQuota: Database.Statement;
  private readonly insertSettings: Database.Statement;
  private readonly insertWarming: Database.Statement;

  constructor(private readonly deps: LedgerDeps) {
    this.health = {
      since: deps.now(),
      rowsWritten: 0,
      writeErrors: 0,
      busyRetries: 0,
      dropped: 0,
      lastError: null,
    };
    this.insertRequest = deps.db.prepare(
      `INSERT INTO usage_requests (
        at, kind, provider, session_key, thread_id, role, initiative, purpose, account_id, model,
        family, ttl, status, completed, latency_ms, idle_gap_ms, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, cache_write_5m_tokens, cache_write_1h_tokens
      ) VALUES (
        @at, @kind, @provider, @session_key, @thread_id, @role, @initiative, @purpose, @account_id,
        @model, @family, @ttl, @status, @completed, @latency_ms, @idle_gap_ms, @input_tokens,
        @output_tokens, @cache_read_tokens, @cache_write_tokens, @cache_write_5m_tokens,
        @cache_write_1h_tokens
      )`,
    );
    this.insertQuota = deps.db.prepare(
      `INSERT INTO usage_quota (
        at, account_id, five_hour_utilization, five_hour_reset_at, seven_day_utilization,
        seven_day_reset_at, family_weekly_json, limit_windows_json
      ) VALUES (
        @at, @account_id, @five_hour_utilization, @five_hour_reset_at, @seven_day_utilization,
        @seven_day_reset_at, @family_weekly_json, @limit_windows_json
      )`,
    );
    this.insertSettings = deps.db.prepare(
      "INSERT INTO usage_settings (at, settings_json) VALUES (@at, @settings_json)",
    );
    this.insertWarming = deps.db.prepare(
      `INSERT INTO usage_warming (
        at, session_key, thread_id, model, role, state, wait_started_at, first_decision_at,
        prefix_tokens, ttl, refreshes, kind, reason, review_hold
      ) VALUES (
        @at, @session_key, @thread_id, @model, @role, @state, @wait_started_at,
        @first_decision_at, @prefix_tokens, @ttl, @refreshes, @kind, @reason, @review_hold
      )`,
    );
    // The dedupe baselines are read once, at startup, so quota() never touches SQLite.
    this.guard(() => {
      const latest = deps.db
        .prepare(
          `SELECT account_id, five_hour_utilization, five_hour_reset_at, seven_day_utilization,
            seven_day_reset_at, family_weekly_json, limit_windows_json, MAX(at) AS at
           FROM usage_quota GROUP BY account_id`,
        )
        .all() as UsageQuotaRow[];
      for (const row of latest) this.savedQuota.set(row.account_id, snapshotKey(row));
      const settings = deps.db
        .prepare(
          "SELECT settings_json FROM usage_settings ORDER BY at DESC, rowid DESC LIMIT 1",
        )
        .get() as { settings_json: string } | undefined;
      this.lastSettings = settings?.settings_json ?? null;
    });
  }

  // Only queues: the body is parsed and the row written after the response has been delivered.
  request(record: RequestRecord): void {
    this.guard(() => {
      this.records.push(record);
      if (this.records.length + this.rows.length > MAX_QUEUED_REQUESTS) {
        if (this.rows.length > 0) this.rows.shift();
        else this.records.shift();
        this.health.dropped += 1;
      }
      this.schedule(0);
    });
  }

  // Every quota write lands here; a row is kept only when what was observed changed. In memory only.
  quota(quota: AccountQuota): void {
    this.guard(() => {
      if (quota.observedAt === null) return;
      const snapshot = quotaSnapshot(quota);
      const key = snapshotKey(snapshot);
      const previous =
        this.queuedQuota.get(quota.accountId) ?? this.savedQuota.get(quota.accountId);
      if (previous === key) return;
      this.queuedQuota.set(quota.accountId, key);
      this.quotas.push({ at: quota.observedAt, ...snapshot, key });
      if (this.quotas.length > MAX_QUEUED_QUOTAS) {
        const dropped = this.quotas.shift();
        if (dropped !== undefined) this.forgetQuota([dropped]);
        this.health.dropped += 1;
      }
      this.schedule(0);
    });
  }

  // Queues the settings in force from now when they differ from the last recorded ones. Called at
  // startup and after every settings change.
  settings(settings: LedgerSettings): void {
    this.guard(() => {
      const json = JSON.stringify(settings);
      if (json === this.lastSettings) return;
      this.lastSettings = json;
      this.settingsRows.push({ at: this.deps.now(), settings_json: json });
      this.schedule(0);
    });
  }

  // A lease that ended, or a wait left unwarmed. In memory only.
  warming(outcome: WarmingOutcome): void {
    this.guard(() => {
      this.warmingRows.push({
        at: outcome.at,
        session_key: `session:${outcome.sessionId}`,
        thread_id: outcome.threadId,
        model: outcome.model,
        role: outcome.role,
        state: outcome.state,
        wait_started_at: outcome.waitStartedAt,
        first_decision_at: outcome.firstDecisionAt,
        prefix_tokens: outcome.prefixTokens,
        ttl: outcome.ttl,
        refreshes: outcome.refreshes,
        kind: outcome.kind,
        reason: outcome.reason,
        review_hold: outcome.reviewHold,
      });
      if (this.warmingRows.length > MAX_QUEUED_REQUESTS) {
        this.warmingRows.shift();
        this.health.dropped += 1;
      }
      this.schedule(0);
    });
  }

  // Asks the next flush to prune, e.g. after the retention changed.
  pruneSoon(): void {
    this.pruneDueAt = 0;
    this.schedule(0);
  }

  // Writes up to MAX_BATCH queued rows per table, then one prune chunk when due. Leaves the rest
  // queued for the next flush; a held lock postpones everything by BUSY_RETRY_MS.
  flush(): void {
    this.flushWithin(Number.POSITIVE_INFINITY);
  }

  // The session keys of requests queued but not yet written (usage-relink.ts skips them).
  queuedSessions(): Set<string> {
    const sessions = new Set<string>();
    for (const { sessionKey } of this.records) if (sessionKey !== null) sessions.add(sessionKey);
    for (const { session_key } of this.rows) if (session_key !== null) sessions.add(session_key);
    return sessions;
  }

  // A flush on its own event-loop turn. Reading a body costs about 1 ms per MB (see
  // describeClaudeRequest), so it reads at most bodyBytes of them (and at least one record); the
  // next turn takes the rest. An explicit flush (close, a report) is not limited.
  private flushWithin(bodyBytes: number): void {
    this.scheduled = false;
    if (this.closed) return;
    let taken = 0;
    let bytes = 0;
    while (taken < Math.min(this.records.length, MAX_BATCH)) {
      bytes += this.records[taken].body.byteLength;
      if (taken > 0 && bytes > bodyBytes) break;
      taken += 1;
    }
    for (const record of this.records.splice(0, taken)) {
      try {
        this.rows.push(this.requestRow(record));
      } catch (error) {
        this.health.dropped += 1;
        this.fail(error);
      }
    }
    const busy =
      this.write(this.settingsRows, (row) => this.insertSettings.run(row), () => {
        this.lastSettings = null;
      }) ||
      this.write(
        this.quotas,
        (row) => {
          const { key: _key, ...values } = row;
          this.insertQuota.run(values);
        },
        (rows) => this.forgetQuota(rows),
        (rows) => {
          for (const row of rows) {
            this.savedQuota.set(row.account_id, row.key);
            if (this.queuedQuota.get(row.account_id) === row.key)
              this.queuedQuota.delete(row.account_id);
          }
        },
      ) ||
      this.write(this.rows, (row) => this.insertRequest.run(row), () => {}) ||
      this.write(this.warmingRows, (row) => this.insertWarming.run(row), () => {}) ||
      this.pruneChunk();
    if (busy) {
      this.health.busyRetries += 1;
      this.schedule(BUSY_RETRY_MS);
    } else if (
      this.records.length +
        this.rows.length +
        this.quotas.length +
        this.settingsRows.length +
        this.warmingRows.length >
        0 ||
      this.pruneDueAt <= this.deps.now()
    )
      this.schedule(0);
  }

  // A last flush; whatever is still queued (a held lock) is lost, and later calls do nothing.
  close(): void {
    this.flush();
    this.closed = true;
  }

  // The start of the oldest request queued but not yet written, or null.
  oldestQueued(): number | null {
    let oldest: number | null = null;
    for (const { startedAt } of this.records)
      if (oldest === null || startedAt < oldest) oldest = startedAt;
    for (const { at } of this.rows) if (oldest === null || at < oldest) oldest = at;
    return oldest;
  }

  status(): LedgerHealth {
    return { ...this.health };
  }

  // Writes the head of one queue in a transaction. Returns true when the lock was held: the rows
  // stay queued. Any other error drops them.
  private write<T>(
    queue: T[],
    insert: (row: T) => void,
    dropped: (rows: T[]) => void,
    saved: (rows: T[]) => void = () => {},
  ): boolean {
    if (queue.length === 0) return false;
    const batch = queue.slice(0, MAX_BATCH);
    try {
      this.deps.db.transaction(() => {
        for (const row of batch) insert(row);
      })();
    } catch (error) {
      if (isBusy(error)) return true;
      queue.splice(0, batch.length);
      this.health.dropped += batch.length;
      dropped(batch);
      this.fail(error);
      return false;
    }
    queue.splice(0, batch.length);
    this.health.rowsWritten += batch.length;
    saved(batch);
    return false;
  }

  // Deletes one chunk of rows older than the retention from each table, at most hourly until a
  // pass finds nothing left. The last settings row before the cutoff stays: it says which settings
  // were in force when the oldest kept row was written.
  private pruneChunk(): boolean {
    const now = this.deps.now();
    if (now < this.pruneDueAt) return false;
    const cutoff = now - this.deps.retentionDays() * DAY_MS;
    const db = this.deps.db;
    let deleted = 0;
    try {
      db.transaction(() => {
        for (const table of ["usage_requests", "usage_quota", "usage_warming"])
          deleted += db
            .prepare(
              `DELETE FROM ${table} WHERE rowid IN (
                SELECT rowid FROM ${table} WHERE at < ? ORDER BY at LIMIT ?
              )`,
            )
            .run(cutoff, MAX_BATCH).changes;
        db.prepare(
          `DELETE FROM usage_settings WHERE at < ? AND rowid <> (
            SELECT rowid FROM usage_settings WHERE at < ? ORDER BY at DESC, rowid DESC LIMIT 1
          )`,
        ).run(cutoff, cutoff);
      })();
    } catch (error) {
      if (isBusy(error)) return true;
      this.fail(error);
    }
    // A full chunk means more may be left: prune again on the next flush.
    this.pruneDueAt = deleted >= MAX_BATCH ? now : now + PRUNE_INTERVAL_MS;
    return false;
  }

  // Rows that will never be stored no longer count as recorded, so the next identical
  // observation is queued again.
  private forgetQuota(rows: QueuedQuota[]): void {
    for (const row of rows)
      if (this.queuedQuota.get(row.account_id) === row.key)
        this.queuedQuota.delete(row.account_id);
  }

  private schedule(delayMs: number): void {
    if (this.scheduled || this.closed) return;
    this.scheduled = true;
    (
      this.deps.defer ??
      ((flush, delay) => {
        if (delay === 0) setImmediate(flush);
        else setTimeout(flush, delay).unref();
      })
    )(() => this.flushWithin(MAX_BATCH_BODY_BYTES), delayMs);
  }

  private requestRow(record: RequestRecord): UsageRequestRow {
    const { model, ttl } = requestModel(record);
    const label =
      record.sessionKey === null ? null : this.deps.thread(record.sessionKey);
    const usage = record.usage;
    const named = record.attribution?.threadId ?? null;
    const threadId = label?.threadId ?? named;
    return {
      at: record.startedAt,
      kind: record.kind,
      provider: record.provider,
      session_key: record.sessionKey,
      thread_id: threadId,
      role: label !== null ? label.role : named === null ? null : (this.deps.role?.(named) ?? null),
      initiative: record.attribution?.initiative ?? null,
      purpose: record.attribution?.purpose ?? null,
      account_id: record.accountId,
      model,
      family: record.family,
      ttl,
      status: record.status,
      completed: record.completed ? 1 : 0,
      latency_ms: Math.max(0, record.finishedAt - record.startedAt),
      idle_gap_ms: this.idleGap(record, model),
      input_tokens: usage?.inputTokens ?? null,
      output_tokens: usage?.outputTokens ?? null,
      cache_read_tokens: usage?.cacheReadTokens ?? null,
      cache_write_tokens: usage?.cacheWriteTokens ?? null,
      cache_write_5m_tokens: usage?.cacheWrite5mTokens ?? null,
      cache_write_1h_tokens: usage?.cacheWrite1hTokens ?? null,
    };
  }

  // How long the session sat idle before this native request: from the end of its previous
  // successful native request on the same model (other models have their own cache entries) to
  // this one's start. A failed attempt gets a gap but never becomes the previous request. After a
  // restart the previous end comes from the ledger itself.
  private idleGap(record: RequestRecord, model: string | null): number | null {
    if (record.kind !== "native" || record.sessionKey === null) return null;
    const key = JSON.stringify([record.sessionKey, model]);
    const previous =
      this.lastNativeEnd.get(key) ?? this.storedNativeEnd(record.sessionKey, model);
    if (succeeded(record.status) && record.usage !== null) {
      this.lastNativeEnd.delete(key);
      this.lastNativeEnd.set(key, Math.max(previous ?? 0, record.finishedAt));
      while (this.lastNativeEnd.size > MAX_IDLE_KEYS) {
        const oldest = this.lastNativeEnd.keys().next();
        if (!oldest.done) this.lastNativeEnd.delete(oldest.value);
      }
    }
    return previous === null ? null : Math.max(0, record.startedAt - previous);
  }

  private storedNativeEnd(sessionKey: string, model: string | null): number | null {
    const row = this.deps.db
      .prepare(
        `SELECT at + latency_ms AS end FROM usage_requests
         WHERE session_key = ? AND model IS ? AND kind = 'native'
           AND status BETWEEN 200 AND 299 AND cache_read_tokens IS NOT NULL
         ORDER BY at DESC LIMIT 1`,
      )
      .get(sessionKey, model) as { end: number } | undefined;
    return row?.end ?? null;
  }

  private guard(action: () => void): void {
    try {
      action();
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    this.health.writeErrors += 1;
    this.health.lastError = error instanceof Error ? error.message : String(error);
    const now = this.deps.now();
    if (now - this.lastErrorLogAt < ERROR_LOG_INTERVAL_MS) return;
    this.lastErrorLogAt = now;
    this.deps.log(
      `Account Pooler usage ledger write failed (${this.health.writeErrors} so far): ${this.health.lastError}`,
    );
  }
}

function succeeded(status: number | null): boolean {
  return status !== null && status >= 200 && status < 300;
}

function isBusy(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  return code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED");
}

const MODEL_FIELD = new Set(["model"]);

function requestModel(record: RequestRecord): {
  model: string | null;
  ttl: CacheTtl | null;
} {
  if (record.provider === "claude") {
    const shape = describeClaudeRequest(record.body);
    return { model: shape.model, ttl: shape.tailTtl };
  }
  try {
    const model = topLevelFields(record.body, MODEL_FIELD)?.model;
    return { model: typeof model === "string" ? model : null, ttl: null };
  } catch {
    return { model: null, ttl: null };
  }
}

// What a quota observation says, without when it was seen or how: utilization and reset times.
function quotaSnapshot(quota: AccountQuota): QuotaSnapshot {
  const familyWeekly: Record<string, [number | null, number | null]> = {};
  for (const [family, value] of Object.entries(quota.familyWeekly)) {
    if (value !== null) familyWeekly[family] = [value.utilization, value.resetAt];
  }
  return {
    account_id: quota.accountId,
    five_hour_utilization: quota.fiveHourUtilization,
    five_hour_reset_at: quota.fiveHourResetAt,
    seven_day_utilization: quota.sevenDayUtilization,
    seven_day_reset_at: quota.sevenDayResetAt,
    family_weekly_json: JSON.stringify(familyWeekly),
    limit_windows_json: JSON.stringify(
      quota.limitWindows.map((window) => [
        window.slot,
        window.windowMinutes,
        window.utilization,
        window.resetAt,
      ]),
    ),
  };
}

// Reset times are compared to the minute: two reads of the same window can differ by a second.
function snapshotKey(snapshot: QuotaSnapshot): string {
  const minute = (value: number | null) =>
    value === null ? null : Math.round(value / 60_000);
  return JSON.stringify([
    snapshot.five_hour_utilization,
    minute(snapshot.five_hour_reset_at),
    snapshot.seven_day_utilization,
    minute(snapshot.seven_day_reset_at),
    roundResets(snapshot.family_weekly_json),
    roundResets(snapshot.limit_windows_json),
  ]);
}

function roundResets(json: string): string {
  return json.replace(/\d{12,}/gu, (value) =>
    String(Math.round(Number(value) / 60_000)),
  );
}

export function readRequestRows(
  db: Database.Database,
  since: number,
): IterableIterator<UsageRequestRow> {
  return db
    .prepare("SELECT * FROM usage_requests WHERE at >= ? ORDER BY at, rowid")
    .iterate(since) as IterableIterator<UsageRequestRow>;
}

// A refresh is sent at most 4 hours (the largest maxWaitMinutes) after the native request it
// keeps warm, and keeps an entry alive for at most another hour.
const SEED_REFRESH_MS = 6 * 60 * 60_000;

// The cache history a report starting at since needs, in time order: each session and model's
// last successful native request before since, and the refreshes shortly before since.
export function readSeedRows(
  db: Database.Database,
  since: number,
): UsageRequestRow[] {
  const natives = db
    .prepare(
      `SELECT *, MAX(at) AS last_at FROM usage_requests
       WHERE at < ? AND kind = 'native' AND provider = 'claude' AND session_key IS NOT NULL
         AND status BETWEEN 200 AND 299 AND cache_read_tokens IS NOT NULL
       GROUP BY session_key, model`,
    )
    .all(since) as UsageRequestRow[];
  const refreshes = db
    .prepare(
      `SELECT * FROM usage_requests WHERE kind = 'refresh' AND at >= ? AND at < ?
       ORDER BY at, rowid`,
    )
    .all(since - SEED_REFRESH_MS, since) as UsageRequestRow[];
  return [...natives, ...refreshes].sort((left, right) => left.at - right.at);
}

// Quota rows from the last one before since, per account, so the first delta has a baseline.
export function readQuotaRows(
  db: Database.Database,
  since: number,
): IterableIterator<UsageQuotaRow> {
  return db
    .prepare(
      `SELECT * FROM usage_quota WHERE at >= COALESCE(
        (SELECT MIN(last) FROM (
          SELECT MAX(at) AS last FROM usage_quota WHERE at < ? GROUP BY account_id
        )), ?)
       ORDER BY at, rowid`,
    )
    .iterate(since, since) as IterableIterator<UsageQuotaRow>;
}

const settingsRowSchema = z.object({ at: z.number(), settings_json: z.string() });

// Every settings row in force at some point since since: the last one before it, then the rest.
export function readSettingsRows(
  db: Database.Database,
  since: number,
): UsageSettingsRow[] {
  return z
    .array(settingsRowSchema)
    .parse(
      db
        .prepare(
          `SELECT at, settings_json FROM usage_settings WHERE at >= COALESCE(
            (SELECT MAX(at) FROM usage_settings WHERE at < ?), ?)
           ORDER BY at, rowid`,
        )
        .all(since, since),
    )
    .map((row) => ({
      at: row.at,
      settings: JSON.parse(row.settings_json) as LedgerSettings,
    }));
}

// A wait with no native request after it for this long counts as one that never resumed; a younger
// one is still open and says nothing yet.
const NO_RESUME_MS = 3 * 60 * 60_000;

// The waits warming reached a refresh decision on since `since`, newest first and at most `limit`
// of them, each with how long it lasted: until the next native request of its session on the same
// model. A wait under a review hold is left out: its odds are the review's, not its role's.
// Synchronous: callers bound it and cache the result.
export function readResumeSamples(
  db: Database.Database,
  since: number,
  now: number,
  limit: number,
): ResumeSample[] {
  const rows = db
    .prepare(
      `SELECT w.role, w.state, w.wait_started_at, (
         SELECT MIN(r.at) FROM usage_requests r
         WHERE r.session_key = w.session_key AND r.model IS w.model AND r.kind = 'native'
           AND r.at > w.wait_started_at
       ) AS resumed_at
       FROM usage_warming w
       WHERE w.wait_started_at >= ? AND w.state IS NOT NULL AND w.role IS NOT NULL
         AND w.review_hold IS NULL
       ORDER BY w.wait_started_at DESC LIMIT ?`,
    )
    .all(since, limit) as Array<{
    role: string;
    state: string;
    wait_started_at: number;
    resumed_at: number | null;
  }>;
  const samples: ResumeSample[] = [];
  for (const row of rows) {
    const role = warmingRoles.find((value) => value === row.role);
    const state = waitStates.find((value) => value === row.state);
    if (role === undefined || state === undefined) continue;
    if (row.resumed_at !== null)
      samples.push({ role, state, waitMs: row.resumed_at - row.wait_started_at });
    else if (now - row.wait_started_at >= NO_RESUME_MS)
      samples.push({ role, state, waitMs: null });
  }
  return samples;
}
