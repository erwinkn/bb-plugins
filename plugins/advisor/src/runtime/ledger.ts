// Spend accounting per review (A140 §5.5, A154 §6.2, A161 F4). Subscription
// quota is counted in requests and tokens and never converted to USD. Unknown
// usage is charged in full and never refunded, on its send day.

import { PRICE_VERSION, PRICES, actualUsd, reservationTokens, reservationUsd } from "../config/prices.js";
import type { RouteSpec } from "../config/routes.js";
import type { AdvisorConfig } from "../config/settings.js";
import type { LedgerRow } from "../store/store.js";
import type { SendResult } from "../transport/types.js";

const formats = new Map<string, Intl.DateTimeFormat>();

/** Calendar send-day in a named time zone (not a rolling 24 hours). */
export function dayKey(now: number, timeZone: string): string {
  let f = formats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    formats.set(timeZone, f);
  }
  return f.format(new Date(now));
}

const DAY_SEARCH_MS = 48 * 3_600_000;

/** The first millisecond of `now`'s calendar day in the zone (binary search; zones shift by at most a day). */
export function dayStart(now: number, timeZone: string): number {
  const key = dayKey(now, timeZone);
  let lo = now - DAY_SEARCH_MS;
  let hi = now;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (dayKey(mid, timeZone) === key) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** The first millisecond of the next calendar day in the zone. */
export function nextDayStart(now: number, timeZone: string): number {
  const key = dayKey(now, timeZone);
  let lo = now;
  let hi = now + DAY_SEARCH_MS;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (dayKey(mid, timeZone) === key) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * A time-zone change made during a budget day. Charges since the old zone's
 * day start keep counting until the new zone's next day begins, so a change
 * can never open a fresh daily budget in the current period (A230 #4).
 */
export interface BudgetCarry {
  start: number;
  until: number;
  from: string;
  to: string;
}

/** The current budget period's start: today in the zone, extended back by an active carry. */
export function budgetSince(now: number, timeZone: string, carry: BudgetCarry | null): number {
  const start = dayStart(now, timeZone);
  return carry && now < carry.until ? Math.min(start, carry.start) : start;
}

/** The carry a change from `from` to `to` at `now` leaves, merged with one still active. */
export function carryFor(now: number, from: string, to: string, prior: BudgetCarry | null): BudgetCarry {
  const start = dayStart(now, from);
  return { start: prior && now < prior.until ? Math.min(prior.start, start) : start, until: nextDayStart(now, to), from, to };
}

export interface Reservation {
  billing: "usd" | "subscription";
  usd: number;
  tokens: number;
  caps: { usd: number | null; requests: number | null; tokens: number | null };
  basis: string;
}

export function reservationFor(route: RouteSpec, config: AdvisorConfig, bodyBytes: number): Reservation | null {
  if (route.billing === "none" || route.model === null) return null;
  const maxOut = route.id === "jev:typesafe" ? 0 : config.maxOutputTokens;
  if (route.billing === "usd") {
    const p = PRICES[route.model]!;
    return {
      billing: "usd",
      usd: reservationUsd(route.model, bodyBytes, maxOut),
      tokens: reservationTokens(bodyBytes, maxOut),
      caps: { usd: config.budgets.usdPerDay, requests: config.budgets.apiRequestsPerDay, tokens: null },
      basis: `(${bodyBytes} body bytes + 1024) x $${p.inMax}/MTok + ${maxOut} x $${p.out}/MTok; ${p.basis}; prices ${PRICE_VERSION}`,
    };
  }
  return {
    billing: "subscription",
    usd: 0,
    tokens: reservationTokens(bodyBytes, maxOut),
    caps: { usd: null, requests: config.budgets.subscriptionRequestsPerDay, tokens: config.budgets.subscriptionTokensPerDay },
    basis: `(${bodyBytes} body bytes + 1024) + ${maxOut} max output tokens; subscription quota, never USD`,
  };
}

/** The ledger patch for a finished send. */
export function settle(row: LedgerRow, model: string | null, r: SendResult): Partial<LedgerRow> {
  switch (r.outcome) {
    case "pre-upstream":
      return { state: "released", posted: false, outcome: r.outcome, actualUsd: 0, actualTokens: 0, note: r.error ?? null };
    case "rejected":
      return { state: "released", outcome: r.outcome, actualUsd: 0, actualTokens: 0, note: r.error ?? "rejected before the model ran (by convention)" };
    case "completed": {
      if (!r.usage || !model) return { state: "unknown_charged", outcome: r.outcome, note: "completed without usage: charged in full" };
      const tokens = r.usage.input + r.usage.output + (r.usage.cacheWrite ?? 0) + (r.usage.cacheRead ?? 0);
      return {
        state: "reconciled",
        outcome: r.outcome,
        actualUsd: row.billing === "usd" ? actualUsd(model, r.usage) : 0,
        actualTokens: tokens,
      };
    }
    default:
      return { state: "unknown_charged", outcome: r.outcome, note: r.error ?? "usage unknown: charged in full" };
  }
}
