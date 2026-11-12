import { describe, expect, it } from "vitest";
import type { AccountQuota, AccountSummary } from "./contracts.js";
import { adviseReset, formatResetAdvice, resetAccounts, resetFallback, type ResetAccount } from "./reset-advice.js";

// 2026-11-12 00:01Z, when the pool was read for review round 5.
const NOW = Date.parse("2026-11-12T00:01:00Z");
const THRESHOLD = 0.98;

function quota(weekly: number, resetsAt: string, fable: number, extra: Partial<AccountQuota> = {}): AccountQuota {
  const resetAt = Date.parse(resetsAt);
  return {
    accountId: "00000000-0000-4000-8000-000000000000",
    sevenDayUtilization: weekly,
    sevenDayResetAt: resetAt,
    sevenDayStatus: null,
    representativeClaim: "seven_day",
    familyWeekly: {
      fable: { utilization: fable, resetAt, status: null, observedAt: NOW, source: "usage" },
      sonnet: null,
      opus: null,
      haiku: null,
      other: null,
    },
    limitWindows: [],
    observedAt: NOW,
    heldUntil: null,
    rejectedUntil: null,
    rejectedAt: null,
    rejectedLimit: null,
    error: null,
    ...extra,
  };
}

const account = (id: string, q: AccountQuota): ResetAccount => ({ id, label: id, quota: q });
// The Pooler held five of them on a weekly-limit 429 until their weekly reset: the advisor ignores it.
const held = (weekly: number, resetsAt: string, fable: number) =>
  quota(weekly, resetsAt, fable, { rejectedUntil: Date.parse(resetsAt), rejectedLimit: "seven_day" });

// The pool's Claude accounts on 2026-11-12 (weekly use, weekly reset, Fable-limit use), from
// `bb pool-local status`. 7f9c0c21 and 5952c57a show 0% after a claimed reset.
const TODAY = {
  c7b8a948: account("c7b8a948", held(1, "2026-11-16T22:00:00Z", 0.53)),
  a2550188d: account("2550188d", held(1, "2026-11-12T01:00:00Z", 0.34)),
  b4bb7733: account("b4bb7733", held(1, "2026-11-16T09:00:00Z", 0.29)),
  a7f9c0c21: account("7f9c0c21", held(0, "2026-11-17T21:00:00Z", 0)),
  a5a7c185f: account("5a7c185f", quota(1, "2026-11-12T23:00:00Z", 0.15)),
  a5952c57a: account("5952c57a", held(0, "2026-11-14T23:00:00Z", 0)),
  a6b9a444: account("a6b9a444", quota(0.54, "2026-11-16T13:00:00Z", 0.08)),
};
const { a7f9c0c21: _claimed, a5952c57a: _claimedToo, a6b9a444: _serving, ...WALLED } = TODAY;

const advise = (accounts: ResetAccount[]) => adviseReset(accounts, THRESHOLD, NOW);
const kinds = (accounts: ResetAccount[]) => advise(accounts).picks.map((pick) => `${pick.label}:${pick.kind}`);

describe("adviseReset on the 2026-11-12 pool", () => {
  it("needs no reset while an account's usage reading shows weekly room, held on a 429 or not", () => {
    expect(advise(Object.values(TODAY))).toEqual({ picks: [], reason: "7f9c0c21 still has weekly room.", read: true });
    const { a6b9a444: _, ...rest } = TODAY;
    expect(advise(Object.values(rest)).picks).toEqual([]);
  });

  it("at the weekly wall, picks the account whose weekly limit resets latest, not 5a7c185f", () => {
    const advice = advise(Object.values(WALLED));
    expect(advice.picks[0]).toEqual({
      accountId: "c7b8a948",
      label: "c7b8a948",
      kind: "fable",
      orElse: "full",
      resetsAt: Date.parse("2026-11-16T22:00:00Z"),
      why: "a Fable reset gives back 27 points of its weekly limit",
    });
    expect(kinds(Object.values(WALLED))).toEqual(["c7b8a948:fable", "b4bb7733:full", "5a7c185f:full", "2550188d:full"]);
    expect(advice.reason).toBe(
      "Every account is at its weekly limit; c7b8a948's resets latest, in 117 h, and a Fable reset gives back 27 points of its weekly limit.",
    );
  });

  it("formats one short CLI line, the decision and its command first", () => {
    expect(formatResetAdvice(advise(Object.values(WALLED)))).toBe(
      "Usage reset: spend a Fable reset on c7b8a948 (/limit-reset fable). Every account is at its weekly limit; c7b8a948's resets latest, in 117 h, and a Fable reset gives back 27 points of its weekly limit. No Fable reset left on c7b8a948? Spend its full reset. Neither? Next: b4bb7733 (full), 5a7c185f (full), 2550188d (full).",
    );
    expect(formatResetAdvice(advise(Object.values(TODAY)))).toBe("Usage reset: none needed. 7f9c0c21 still has weekly room.");
  });
});

describe("adviseReset rules", () => {
  it("spends a Fable reset where it gives back a quarter of the weekly limit, else a full one", () => {
    // The brief's 2026-11-11 examples: 7f9c0c21 at 58% of its Fable limit, 5a7c185f at 16%.
    const fable = account("7f9c0c21", quota(1, "2026-11-17T21:00:00Z", 0.58));
    const full = account("5a7c185f", quota(1, "2026-11-12T23:00:00Z", 0.16));
    expect(advise([full, fable]).picks).toEqual([
      expect.objectContaining({ accountId: "7f9c0c21", kind: "fable", orElse: "full", why: "a Fable reset gives back 29 points of its weekly limit" }),
      expect.objectContaining({ accountId: "5a7c185f", kind: "full", orElse: null, why: "a Fable reset would give back only 8 points" }),
    ]);
    expect(resetFallback(advise([full]))).toBe("");
  });

  it("prints a wait under an hour as under 1 h", () => {
    expect(advise([TODAY.a2550188d]).reason).toContain("2550188d's resets latest, in under 1 h,");
  });

  it("counts a weekly status of rejected as the wall, and a passed weekly reset as room", () => {
    const rejected = account("r", { ...quota(0.5, "2026-11-16T22:00:00Z", 0), sevenDayStatus: "rejected" });
    expect(kinds([rejected])).toEqual(["r:full"]);
    const reset = account("p", quota(1, "2026-11-11T23:00:00Z", 0));
    expect(advise([rejected, reset]).reason).toBe("p still has weekly room.");
  });

  it("ignores accounts whose usage read failed or has no weekly reading", () => {
    const broken = account("x", { ...quota(0, "2026-11-30T00:00:00Z", 0.9), error: "401" });
    const unread = account("u", { ...quota(0, "2026-11-30T00:00:00Z", 0), sevenDayUtilization: null });
    expect(kinds([broken, unread, TODAY.b4bb7733])).toEqual(["b4bb7733:full"]);
    expect(advise([broken, unread]).reason).toBe("No Claude account with a weekly usage reading.");
    expect(formatResetAdvice(advise([broken, unread]))).toBe(
      "Usage reset: no reading yet. No Claude account with a weekly usage reading.",
    );
  });

  it("names an unknown reset time", () => {
    const unknown = account("u", { ...quota(1, "2026-11-17T21:00:00Z", 0.1), sevenDayResetAt: null });
    expect(advise([unknown]).reason).toContain("u's resets latest, at an unknown time,");
  });

  it("takes only enabled Claude OAuth accounts from a status read", () => {
    const summary = (id: string, extra: Partial<AccountSummary>): AccountSummary =>
      ({ ...quota(1, "2026-11-17T21:00:00Z", 0.58), id, label: id, email: null, provider: "claude", kind: "oauth", enabled: true, ...extra }) as AccountSummary;
    const taken = resetAccounts([
      summary("11111111-0000-4000-8000-000000000000", {}),
      summary("22222222-0000-4000-8000-000000000000", { enabled: false }),
      summary("33333333-0000-4000-8000-000000000000", { kind: "api-key" }),
      summary("44444444-0000-4000-8000-000000000000", { provider: "codex" }),
    ]);
    expect(taken.map((a) => [a.label, a.quota.accountId])).toEqual([
      ["11111111-0000-4000-8000-000000000000", "11111111-0000-4000-8000-000000000000"],
    ]);
    expect(resetAccounts([summary("55555555-0000-4000-8000-000000000000", { label: "Erwin", email: "e@example.com" })])[0]?.label).toBe(
      "e@example.com",
    );
  });
});
