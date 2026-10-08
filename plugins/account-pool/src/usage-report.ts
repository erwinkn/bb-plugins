import type Database from "better-sqlite3";
import type { PoolProvider } from "./contracts.js";
import { CACHE_TTL_MS, type CacheTtl } from "./cache-usage.js";
import {
  readQuotaRows,
  readRequestRows,
  readSeedRows,
  readSettingsRows,
  type LedgerHealth,
  type LedgerSettings,
  type RequestKind,
  type UsageQuotaRow,
  type UsageRequestRow,
  type UsageSettingsRow,
} from "./ledger.js";

// Turns ledger rows into the numbers that say whether cache warming pays for itself.
//
// Cold starts are judged per session and model (each model has its own cache entry), from native
// requests in time order. Only cache activity counts: a native request that returned 2xx with
// known usage, and a 2xx refresh that read the cache. Failed or canceled attempts stay in the
// request, error and cost totals but neither move the history nor prove a refresh. A native
// request that started more than the previous entry's TTL after the previous native request on the
// same session and model would, without warming, find that entry gone:
// - it read more than it wrote: if a refresh ran in between, warming avoided that rewrite (the
//   tokens it read); otherwise something else kept the entry alive (a hit without refresh);
// - it wrote more than it read: a cold rewrite (and, if a refresh ran in between, warming failed).
// Claude Code subagents and helpers share their main session id; a subagent on the main model
// therefore counts as session activity, which can hide a cold start but never invents one.
//
// The estimate weighs tokens at Anthropic API price ratios to uncached input, which is the closest
// public proxy for subscription quota: cache read 0.1x, 5m write 1.25x, 1h write 2x, output 5x.
export const INPUT_EQUIVALENT_WEIGHTS = {
  input: 1,
  cacheRead: 0.1,
  cacheWrite5m: 1.25,
  cacheWrite1h: 2,
  output: 5,
};

export interface TokenTotals {
  requests: number;
  // Responses that were not 2xx, or a send whose outcome is unknown.
  errors: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  inputEquivalent: number;
}

export interface IdleStats {
  // Native requests that came after their entry's TTL had passed since the previous native one.
  afterExpiry: number;
  coldRewrites: number;
  coldRewriteTokens: number;
  coldDespiteRefresh: number;
  rewritesAvoided: number;
  rewriteTokensAvoided: number;
  hitsWithoutRefresh: number;
}

// One quota window's change: utilization increases in percentage points (a window that reset
// counts from 0) and its last observed utilization in percent.
export interface WindowBurn {
  burn: number;
  last: number;
}

export interface AccountStats {
  requests: number;
  inputEquivalent: number;
  // Every window observed for the account, by name: "5h" and "7d" (Claude), "7d opus" and other
  // per-family weeklies, and Codex limit windows by length ("5h", "7d") or slot. A window never
  // observed is absent, never a zero.
  windows: Record<string, WindowBurn>;
}

export interface BucketStats {
  claude: Record<RequestKind, TokenTotals>;
  codex: Record<RequestKind, TokenTotals>;
  // Claude native: cache read / (cache read + cache write + uncached input).
  cacheHitRatio: number | null;
  idle: IdleStats;
  estimate: {
    savedInputEquivalent: number;
    refreshCostInputEquivalent: number;
    netInputEquivalent: number;
  };
  accounts: Record<string, AccountStats>;
}

// Advisor requests (kind "advisor") by who they were for, as the caller named it: purpose and
// Initiative from its headers, the thread from the same or, for older callers, none (null).
export interface AdvisorUsage extends TokenTotals {
  provider: PoolProvider;
  purpose: string | null;
  initiative: string | null;
  threadId: string | null;
}

export interface UsageReport {
  since: number;
  until: number;
  ledger: LedgerHealth & { retentionDays: number };
  weights: typeof INPUT_EQUIVALENT_WEIGHTS;
  accountLabels: Record<string, string>;
  total: BucketStats;
  // Most input-equivalent first.
  advisor: AdvisorUsage[];
  periods: Array<{
    from: number;
    to: number | null;
    settings: LedgerSettings | null;
    stats: BucketStats;
  }>;
  days: Array<{ day: string; stats: BucketStats }>;
}

export interface ChainState {
  lastNativeAt: number;
  // The TTL of the entry the last native request wrote or read.
  ttl: CacheTtl;
  refreshesSince: number;
}

export interface WindowState {
  utilization: number;
  resetAt: number | null;
}

export class UsageAggregator {
  private readonly total = emptyBucket();
  private readonly advisor = new Map<string, AdvisorUsage>();
  private readonly periods: Array<{
    from: number;
    to: number | null;
    settings: LedgerSettings | null;
    stats: BucketStats;
  }>;
  private readonly days = new Map<string, BucketStats>();
  private readonly chains = new ResumeChains();
  private readonly quotas = new Map<string, Map<string, WindowState>>();

  constructor(
    private readonly since: number,
    settings: readonly UsageSettingsRow[],
  ) {
    this.periods = settings.map((row, index) => ({
      from: Math.max(row.at, since),
      to: settings[index + 1]?.at ?? null,
      settings: row.settings,
      stats: emptyBucket(),
    }));
    if (this.periods.length === 0 || (this.periods[0]?.from ?? 0) > since)
      this.periods.unshift({
        from: since,
        to: this.periods[0]?.from ?? null,
        settings: null,
        stats: emptyBucket(),
      });
  }

  // Rows must arrive in time order.
  addRequest(row: UsageRequestRow): void {
    const buckets = this.buckets(row.at);
    const tokens = rowTokens(row);
    for (const bucket of buckets) {
      addTokens(bucket[row.provider][row.kind], tokens, row.status);
      const account = accountStats(bucket, row.account_id);
      account.requests += 1;
      account.inputEquivalent += tokens.inputEquivalent;
    }
    if (row.kind === "advisor") this.addAdvisor(row, tokens);
    if (row.kind === "refresh")
      for (const bucket of buckets)
        bucket.estimate.refreshCostInputEquivalent += tokens.inputEquivalent;
    this.chain(row, buckets);
  }

  private addAdvisor(row: UsageRequestRow, tokens: ReturnType<typeof rowTokens>): void {
    const key = JSON.stringify([row.provider, row.purpose, row.initiative, row.thread_id]);
    let usage = this.advisor.get(key);
    if (usage === undefined) {
      usage = {
        provider: row.provider,
        purpose: row.purpose,
        initiative: row.initiative,
        threadId: row.thread_id,
        ...emptyTotals(),
      };
      this.advisor.set(key, usage);
    }
    addTokens(usage, tokens, row.status);
  }

  // Cache history from before since: moves the chains, counts nothing. Rows in time order.
  seed(row: UsageRequestRow): void {
    this.chain(row, null);
  }

  private chain(row: UsageRequestRow, buckets: BucketStats[] | null): void {
    const outcome = this.chains.next(row);
    if (buckets === null || outcome === null) return;
    for (const bucket of buckets) {
      const idle = bucket.idle;
      idle.afterExpiry += 1;
      if (outcome.kind === "cold") {
        idle.coldRewrites += 1;
        idle.coldRewriteTokens += outcome.tokens;
        if (outcome.refreshed) idle.coldDespiteRefresh += 1;
      } else if (outcome.kind === "keptWarm") {
        idle.rewritesAvoided += 1;
        idle.rewriteTokensAvoided += outcome.tokens;
        bucket.estimate.savedInputEquivalent += outcome.savedInputEquivalent;
      } else idle.hitsWithoutRefresh += 1;
    }
  }

  // Rows must arrive in time order; rows before since only set the baseline.
  addQuota(row: UsageQuotaRow): void {
    let states = this.quotas.get(row.account_id);
    if (states === undefined) {
      states = new Map();
      this.quotas.set(row.account_id, states);
    }
    for (const [name, current] of quotaWindows(row)) {
      const previous = states.get(name);
      states.set(name, current);
      if (row.at < this.since) continue;
      const increase = previous === undefined ? 0 : burn(previous, current);
      for (const bucket of this.buckets(row.at)) {
        const windows = accountStats(bucket, row.account_id).windows;
        const window = windows[name] ?? { burn: 0, last: 0 };
        window.burn += increase * 100;
        window.last = current.utilization * 100;
        windows[name] = window;
      }
    }
  }

  result(input: {
    until: number;
    ledger: UsageReport["ledger"];
    accountLabels: Record<string, string>;
  }): UsageReport {
    const all = [
      this.total,
      ...this.periods.map((period) => period.stats),
      ...this.days.values(),
    ];
    for (const stats of all) finish(stats);
    return {
      since: this.since,
      until: input.until,
      ledger: input.ledger,
      weights: INPUT_EQUIVALENT_WEIGHTS,
      accountLabels: input.accountLabels,
      total: this.total,
      advisor: [...this.advisor.values()].sort(
        (left, right) => right.inputEquivalent - left.inputEquivalent,
      ),
      // A period with nothing in it (before the first recorded settings, say) is left out.
      periods: this.periods.filter(
        (period) => Object.keys(period.stats.accounts).length > 0,
      ),
      days: [...this.days.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([day, stats]) => ({ day, stats })),
    };
  }

  private buckets(at: number): BucketStats[] {
    const day = new Date(at).toISOString().slice(0, 10);
    let daily = this.days.get(day);
    if (daily === undefined) {
      daily = emptyBucket();
      this.days.set(day, daily);
    }
    let period = this.periods[0];
    for (const candidate of this.periods) if (candidate.from <= at) period = candidate;
    return [this.total, daily, ...(period === undefined ? [] : [period.stats])];
  }
}

// The cache history of each session and model, fed every request row in ledger order (at, then
// rowid): what each native request found (resumeOutcome). seed gives the history of a chain this
// instance has not seen, for a reader that starts mid-ledger (the usage rollup); undefined when the
// chain has no native request yet.
export class ResumeChains {
  private readonly chains = new Map<string, ChainState | null>();

  constructor(
    private readonly seed: (row: UsageRequestRow) => ChainState | undefined = () => undefined,
  ) {}

  next(row: UsageRequestRow): ResumeOutcome | null {
    if (
      row.provider !== "claude" ||
      row.kind === "advisor" ||
      row.session_key === null ||
      !succeeded(row.status) ||
      row.cache_read_tokens === null ||
      row.cache_write_tokens === null
    )
      return null;
    const key = chainKey(row);
    let chain = this.chains.get(key);
    if (chain === undefined) {
      chain = this.seed(row) ?? null;
      this.chains.set(key, chain);
    }
    if (row.kind === "refresh") {
      if (chain !== null && row.cache_read_tokens > 0) chain.refreshesSince += 1;
      return null;
    }
    if (row.ttl === null) return null;
    this.chains.set(key, { lastNativeAt: row.at, ttl: row.ttl, refreshesSince: 0 });
    if (chain === null) return null;
    return resumeOutcome(
      { at: chain.lastNativeAt, ttl: chain.ttl, refreshed: chain.refreshesSince > 0 },
      { at: row.at, ttl: row.ttl, read: row.cache_read_tokens, write: row.cache_write_tokens },
    );
  }
}

// What a successful native Claude request found when it came after its entry's TTL had passed
// since the previous native request on the same session and model (previous: that request's
// start and TTL, and whether a refresh read the entry in between). null: the entry was still alive.
// - cold: it wrote at least as much as it read, a rewrite of the prefix (tokens: the write);
// - keptWarm: it read more than it wrote after a refresh, a rewrite warming avoided (tokens: the
//   read, saved at the write price of this request's TTL minus the read price);
// - warm: it read more than it wrote with no refresh: something else kept the entry alive.
export type ResumeOutcome =
  | { kind: "cold"; tokens: number; refreshed: boolean }
  | { kind: "keptWarm"; tokens: number; savedInputEquivalent: number }
  | { kind: "warm" };

export function resumeOutcome(
  previous: { at: number; ttl: CacheTtl; refreshed: boolean },
  row: { at: number; ttl: CacheTtl; read: number; write: number },
): ResumeOutcome | null {
  if (row.at - previous.at <= CACHE_TTL_MS[previous.ttl]) return null;
  const { read, write } = row;
  if (write >= read) return { kind: "cold", tokens: write, refreshed: previous.refreshed };
  if (!previous.refreshed) return { kind: "warm" };
  return {
    kind: "keptWarm",
    tokens: read,
    savedInputEquivalent:
      read * (writeWeight(row.ttl) - INPUT_EQUIVALENT_WEIGHTS.cacheRead),
  };
}

function chainKey(row: UsageRequestRow): string {
  return JSON.stringify([row.session_key, row.model]);
}

function writeWeight(ttl: CacheTtl | null): number {
  return ttl === "1h"
    ? INPUT_EQUIVALENT_WEIGHTS.cacheWrite1h
    : INPUT_EQUIVALENT_WEIGHTS.cacheWrite5m;
}

export function rowTokens(row: UsageRequestRow): Omit<TokenTotals, "requests" | "errors"> {
  const write = row.cache_write_tokens ?? 0;
  const split5m = row.cache_write_5m_tokens;
  const split1h = row.cache_write_1h_tokens;
  // Without the split, the write is the tail breakpoint's TTL.
  const write1h = split1h ?? (split5m === null && row.ttl === "1h" ? write : 0);
  const write5m = split5m ?? write - write1h;
  const tokens = {
    input: row.input_tokens ?? 0,
    output: row.output_tokens ?? 0,
    cacheRead: row.cache_read_tokens ?? 0,
    cacheWrite: write,
    cacheWrite5m: write5m,
    cacheWrite1h: write1h,
  };
  const weights = INPUT_EQUIVALENT_WEIGHTS;
  return {
    ...tokens,
    inputEquivalent:
      tokens.input * weights.input +
      tokens.output * weights.output +
      tokens.cacheRead * weights.cacheRead +
      tokens.cacheWrite5m * weights.cacheWrite5m +
      tokens.cacheWrite1h * weights.cacheWrite1h,
  };
}

function addTokens(
  totals: TokenTotals,
  tokens: Omit<TokenTotals, "requests" | "errors">,
  status: number | null,
): void {
  totals.requests += 1;
  if (status === null || status < 200 || status >= 300) totals.errors += 1;
  totals.input += tokens.input;
  totals.output += tokens.output;
  totals.cacheRead += tokens.cacheRead;
  totals.cacheWrite += tokens.cacheWrite;
  totals.cacheWrite5m += tokens.cacheWrite5m;
  totals.cacheWrite1h += tokens.cacheWrite1h;
  totals.inputEquivalent += tokens.inputEquivalent;
}

// How much utilization rose between two observations. A later reset time means the window rolled
// over, so everything now used is new.
function burn(previous: WindowState, current: WindowState): number {
  if (
    previous.resetAt !== null &&
    current.resetAt !== null &&
    current.resetAt - previous.resetAt > 60_000
  )
    return current.utilization;
  return Math.max(0, current.utilization - previous.utilization);
}

function windowName(minutes: number | null, slot: string): string {
  if (minutes === null) return slot;
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

// Every window a quota row observed, by name, with a known utilization.
export function quotaWindows(row: UsageQuotaRow): Array<[string, WindowState]> {
  const windows: Array<[string, WindowState]> = [];
  const add = (name: string, utilization: unknown, resetAt: unknown) => {
    if (typeof utilization !== "number") return;
    windows.push([
      name,
      { utilization, resetAt: typeof resetAt === "number" ? resetAt : null },
    ]);
  };
  add("5h", row.five_hour_utilization, row.five_hour_reset_at);
  add("7d", row.seven_day_utilization, row.seven_day_reset_at);
  try {
    const families = JSON.parse(row.family_weekly_json) as Record<string, [unknown, unknown]>;
    for (const [family, [utilization, resetAt]] of Object.entries(families))
      add(`7d ${family}`, utilization, resetAt);
    const limits = JSON.parse(row.limit_windows_json) as Array<[string, number | null, unknown, unknown]>;
    for (const [slot, minutes, utilization, resetAt] of limits)
      add(windowName(minutes, slot), utilization, resetAt);
  } catch {}
  return windows;
}

function succeeded(status: number | null): boolean {
  return status !== null && status >= 200 && status < 300;
}

function accountStats(bucket: BucketStats, accountId: string): AccountStats {
  let account = bucket.accounts[accountId];
  if (account === undefined) {
    account = { requests: 0, inputEquivalent: 0, windows: {} };
    bucket.accounts[accountId] = account;
  }
  return account;
}

function emptyTotals(): TokenTotals {
  return {
    requests: 0,
    errors: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    inputEquivalent: 0,
  };
}

function emptyKinds(): Record<RequestKind, TokenTotals> {
  return { native: emptyTotals(), refresh: emptyTotals(), advisor: emptyTotals() };
}

function emptyBucket(): BucketStats {
  return {
    claude: emptyKinds(),
    codex: emptyKinds(),
    cacheHitRatio: null,
    idle: {
      afterExpiry: 0,
      coldRewrites: 0,
      coldRewriteTokens: 0,
      coldDespiteRefresh: 0,
      rewritesAvoided: 0,
      rewriteTokensAvoided: 0,
      hitsWithoutRefresh: 0,
    },
    estimate: {
      savedInputEquivalent: 0,
      refreshCostInputEquivalent: 0,
      netInputEquivalent: 0,
    },
    accounts: {},
  };
}

function finish(stats: BucketStats): void {
  const native = stats.claude.native;
  const prompt = native.cacheRead + native.cacheWrite + native.input;
  stats.cacheHitRatio = prompt === 0 ? null : native.cacheRead / prompt;
  stats.estimate.netInputEquivalent =
    stats.estimate.savedInputEquivalent -
    stats.estimate.refreshCostInputEquivalent;
}

// Streams the ledger since since through the aggregator: memory stays bounded by the number of
// sessions, not rows.
export function buildUsageReport(
  db: Database.Database,
  input: {
    since: number;
    until: number;
    ledger: UsageReport["ledger"];
    accountLabels: Record<string, string>;
  },
): UsageReport {
  const aggregator = new UsageAggregator(
    input.since,
    readSettingsRows(db, input.since),
  );
  for (const row of readSeedRows(db, input.since)) aggregator.seed(row);
  for (const row of readRequestRows(db, input.since)) aggregator.addRequest(row);
  for (const row of readQuotaRows(db, input.since)) aggregator.addQuota(row);
  return aggregator.result(input);
}

// "7d", "24h", "90m" before now, or an ISO date or time.
export function parseSince(value: string, now: number): number {
  const relative = /^(\d+)([mhd])$/u.exec(value.trim());
  if (relative !== null) {
    const unit = { m: 60_000, h: 60 * 60_000, d: 24 * 60 * 60_000 }[
      relative[2] as "m" | "h" | "d"
    ];
    return now - Number(relative[1]) * unit;
  }
  const absolute = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}/u.test(value) || Number.isNaN(absolute))
    throw new Error(
      "--since takes a duration (90m, 24h, 7d) or an ISO date or time.",
    );
  return absolute;
}

// --- Human output ---

function compact(value: number): string {
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  if (absolute >= 1e9) return `${sign}${(absolute / 1e9).toFixed(1)}B`;
  if (absolute >= 1e6) return `${sign}${(absolute / 1e6).toFixed(1)}M`;
  if (absolute >= 1e3) return `${sign}${(absolute / 1e3).toFixed(1)}k`;
  return `${sign}${Math.round(absolute)}`;
}

function minute(at: number): string {
  return `${new Date(at).toISOString().slice(0, 16).replace("T", " ")}Z`;
}

function percent(value: number | null): string {
  return value === null ? "-" : `${(value * 100).toFixed(1)}%`;
}

function points(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}pp`;
}

export function settingsLabel(settings: LedgerSettings | null): string {
  if (settings === null) return "settings not recorded";
  const warming = settings.warming;
  const mode = String(warming.mode ?? "?");
  const families = Array.isArray(warming.families)
    ? warming.families.join(",")
    : "?";
  // Periods before T141 used fixed windows; later ones warm while it pays, up to maxWaitMinutes.
  const policy =
    warming.maxWaitMinutes === undefined
      ? `coordinator ${warming.coordinatorMinutes}m, worker ${warming.workerActiveMinutes}/${warming.workerReportedMinutes}m`
      : `economic, max wait ${warming.maxWaitMinutes}m${warming.maxBackgroundWaitMinutes === undefined ? "" : ` (background ${warming.maxBackgroundWaitMinutes}m)`}, ${Array.isArray(warming.roles) ? warming.roles.join(",") : "?"}`;
  const windows = mode === "off" ? "" : ` (${families}; ${policy})`;
  return `ttl ${settings.claudeMainCacheTtl} · warming ${mode}${windows}`;
}

function statsLines(
  stats: BucketStats,
  labels: Record<string, string>,
  indent: string,
): string[] {
  const claude = stats.claude;
  const idle = stats.idle;
  const estimate = stats.estimate;
  const codex = stats.codex.native.requests + stats.codex.advisor.requests;
  const errors =
    claude.native.errors + claude.refresh.errors + claude.advisor.errors;
  const lines = [
    `requests  native ${claude.native.requests} · refresh ${claude.refresh.requests} · advisor ${claude.advisor.requests}${codex > 0 ? ` · codex ${codex}` : ""}${errors > 0 ? ` · ${errors} not 2xx` : ""}`,
    `cache     hit ${percent(stats.cacheHitRatio)} · read ${compact(claude.native.cacheRead)} · write 5m ${compact(claude.native.cacheWrite5m)} · 1h ${compact(claude.native.cacheWrite1h)}`,
    `idle      ${idle.afterExpiry} after expiry: ${idle.coldRewrites} cold rewrites (${compact(idle.coldRewriteTokens)} tok${idle.coldDespiteRefresh > 0 ? `, ${idle.coldDespiteRefresh} despite a refresh` : ""}) · ${idle.rewritesAvoided} kept warm (${compact(idle.rewriteTokensAvoided)} tok) · ${idle.hitsWithoutRefresh} warm without refresh`,
  ];
  if (claude.refresh.requests > 0 || idle.rewritesAvoided > 0)
    lines.push(
      `warming   refreshes read ${compact(claude.refresh.cacheRead)}, wrote ${compact(claude.refresh.cacheWrite)} · saved ${compact(estimate.savedInputEquivalent)} − cost ${compact(estimate.refreshCostInputEquivalent)} = net ${estimate.netInputEquivalent >= 0 ? "+" : ""}${compact(estimate.netInputEquivalent)} input-eq`,
    );
  for (const [id, account] of Object.entries(stats.accounts)) {
    const windows = Object.entries(account.windows)
      .map(([name, window]) => `${name} ${points(window.burn)} (now ${window.last.toFixed(0)}%)`)
      .join(" · ");
    lines.push(
      `account   ${labels[id] ?? id.slice(0, 8)}: ${account.requests} req, ${compact(account.inputEquivalent)} input-eq · ${windows === "" ? "quota not observed" : windows}`,
    );
  }
  return lines.map((line) => `${indent}${line}`);
}

const ADVISOR_LINES = 20;

export function formatUsageReport(report: UsageReport): string {
  const ledger = report.ledger;
  const lines = [
    `Usage ${minute(report.since)} → ${minute(report.until)} · retention ${ledger.retentionDays}d · ledger write errors ${ledger.writeErrors}${ledger.dropped > 0 ? `, ${ledger.dropped} rows dropped` : ""} since ${minute(ledger.since)}`,
    "input-eq weighs tokens at API price ratios: cache read 0.1×, 5m write 1.25×, 1h write 2×, output 5×.",
    "",
    "Total",
    ...statsLines(report.total, report.accountLabels, "  "),
    "",
    "By settings period",
  ];
  for (const period of report.periods) {
    lines.push(
      `  ${minute(period.from)} → ${period.to === null ? "now" : minute(period.to)} · ${settingsLabel(period.settings)}`,
      ...statsLines(period.stats, report.accountLabels, "    "),
    );
  }
  if (report.advisor.length > 0) {
    lines.push("", "Advisor by purpose and Initiative");
    for (const usage of report.advisor.slice(0, ADVISOR_LINES)) {
      const who = [
        usage.purpose ?? "(no purpose)",
        usage.initiative ?? "(no Initiative)",
        usage.threadId ?? "(no thread)",
      ].join(" · ");
      lines.push(
        `  ${usage.provider} ${who}: ${usage.requests} req${usage.errors > 0 ? ` (${usage.errors} not 2xx)` : ""}, ${compact(usage.inputEquivalent)} input-eq (in ${compact(usage.input)}, cached ${compact(usage.cacheRead)}, out ${compact(usage.output)})`,
      );
    }
    if (report.advisor.length > ADVISOR_LINES)
      lines.push(`  … ${report.advisor.length - ADVISOR_LINES} more in --json`);
  }
  lines.push("", "By day (UTC)");
  for (const { day, stats } of report.days) {
    const claude = stats.claude;
    const net = stats.estimate.netInputEquivalent;
    const burn = Object.entries(stats.accounts)
      .flatMap(([id, account]) =>
        Object.entries(account.windows)
          .filter(([, window]) => window.burn > 0)
          .map(
            ([name, window]) =>
              `${report.accountLabels[id] ?? id.slice(0, 8)} ${name} ${points(window.burn)}`,
          ),
      )
      .join(", ");
    lines.push(
      `  ${day}  native ${claude.native.requests} · refresh ${claude.refresh.requests} · advisor ${claude.advisor.requests} · hit ${percent(stats.cacheHitRatio)} · cold ${stats.idle.coldRewrites} · kept warm ${stats.idle.rewritesAvoided} · net ${net >= 0 ? "+" : ""}${compact(net)}${burn === "" ? "" : ` · ${burn}`}`,
    );
  }
  return lines.join("\n");
}
