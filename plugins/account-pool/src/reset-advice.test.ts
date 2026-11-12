import { describe, expect, it } from "vitest";
import type { AccountQuota, AccountSummary, ResetGrant, UsageResets } from "./contracts.js";
import { adviseReset, formatResetAdvice, nextPicks, resetAccounts, type ResetAccount } from "./reset-advice.js";

// 2026-11-12 13:30Z: six accounts at their weekly limit, and hi@erwinkn.com (weekly 20%) held by a
// 5-hour rejection until 16:30Z. The old advice said "none needed. hi@erwinkn.com still has weekly room."
const NOW = Date.parse("2026-11-12T13:30:00Z");
const THRESHOLD = 0.98;
const FIVE_HOUR_HOLD = Date.parse("2026-11-12T16:30:00Z");

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
    // The Pooler holds an account at its weekly limit until the weekly reset, as on a weekly 429.
    rejectedUntil: weekly >= 1 ? resetAt : null,
    rejectedAt: weekly >= 1 ? NOW - 60_000 : null,
    rejectedLimit: weekly >= 1 ? "seven_day" : null,
    error: null,
    ...extra,
  };
}

function grant(id: string, kind: ResetGrant["kind"], left: number, extra: Partial<ResetGrant> = {}): ResetGrant {
  return {
    id,
    kind,
    resetsTotal: null,
    resetsLeft: left,
    startsAt: null,
    endsAt: Date.parse("2027-03-09T00:00:00Z"),
    clears: kind === "fable" ? ["seven_day_overage_included"] : ["seven_day", "seven_day_overage_included"],
    paused: false,
    usableNow: left > 0,
    useRequiresLimit: false,
    percentUsed: {},
    blocking: [],
    unavailableReason: null,
    ...extra,
  };
}

const resets = (grants: ResetGrant[], extra: Partial<UsageResets> = {}): UsageResets => ({
  eligible: true,
  ineligibleReason: null,
  grants,
  cooldownUntil: null,
  observedAt: NOW,
  ...extra,
});

const account = (label: string, q: AccountQuota, r: UsageResets | null): ResetAccount => ({ id: `id-${label}`, label, quota: q, resets: r });
const blocked = { usableNow: false, blocking: ["five_hour"] };

// The live inventory after tech@'s claim of launch-2610-fable (from the brief), with the Fable use
// smeared over the pool.
const TODAY = {
  tech: account("tech@equisafe.io", quota(1, "2026-11-17T21:00:00Z", 0.06), resets([
    grant("full-reset-2611", "weekly", 1, { endsAt: Date.parse("2026-12-10T00:00:00Z") }),
    grant("launch-2610-fable", "fable", 0),
    grant("launch-2610-fable-6mo", "fable", 1),
    grant("launch-2610-fable-12mo", "fable", 1),
  ])),
  gmail: account("erwin@gmail.com", quota(1, "2026-11-16T22:00:00Z", 0.53), resets([grant("launch-2610-fable", "fable", 2), grant("full-reset-2611", "full", 0)])),
  pm: account("erwin@pm.me", quota(1, "2026-11-16T09:00:00Z", 0.48), resets([grant("launch-2610-fable", "fable", 1), grant("full-reset-2611", "full", 0)])),
  hi: account(
    "hi@erwinkn.com",
    quota(0.2, "2026-11-14T23:00:00Z", 0.41, { rejectedUntil: FIVE_HOUR_HOLD, rejectedAt: NOW - 60_000, rejectedLimit: "five_hour" }),
    resets([grant("launch-2610-fable", "fable", 1, blocked), grant("full-reset-2611", "full", 1, blocked)]),
  ),
  urthrax: account("urthrax", quota(1, "2026-11-12T23:00:00Z", 0.59), resets([grant("launch-2610-fable", "fable", 1), grant("full-reset-2611", "full", 0)])),
  vadlerr: account("vadlerr", quota(1, "2026-11-16T13:00:00Z", 0.15), resets([grant("launch-2610-fable", "fable", 1), grant("full-reset-2611", "full", 1)])),
  griffe: account("griffe", quota(1, "2026-11-14T23:00:00Z", 0.37), resets([grant("launch-2610-fable", "fable", 0), grant("full-reset-2611", "full", 1)])),
};

const advise = (accounts: ResetAccount[], now = NOW) => adviseReset(accounts, THRESHOLD, now);
const kinds = (accounts: ResetAccount[]) => advise(accounts).picks.map((pick) => `${pick.label}:${pick.kind}`);

describe("adviseReset on the 2026-11-12 wall", () => {
  it("sees the wall: hi@'s weekly room does not serve while its 5-hour hold lasts", () => {
    const advice = advise(Object.values(TODAY));
    expect(advice.state).toBe("walled");
    expect(advice.reason).toBe(
      "No Claude account can serve now. hi@erwinkn.com serves again on its own in 3 h. A weekly reset on tech@equisafe.io (full-reset-2611, 1 left) gives back its whole weekly limit.",
    );
  });

  it("ranks the grants actually held and usable: worth spending first, then the longest wait", () => {
    // hi@'s grants are blocked by its 5-hour limit; pm.me's Fable reset gives back 24 points only.
    expect(kinds(Object.values(TODAY))).toEqual([
      "tech@equisafe.io:weekly",
      "erwin@gmail.com:fable",
      "vadlerr:full",
      "griffe:full",
      "urthrax:fable",
      "erwin@pm.me:fable",
    ]);
    expect(advise(Object.values(TODAY)).picks[1]).toEqual({
      accountId: "id-erwin@gmail.com",
      label: "erwin@gmail.com",
      kind: "fable",
      grantId: "launch-2610-fable",
      resetsLeft: 2,
      freeAt: Date.parse("2026-11-16T22:00:00Z"),
      worth: true,
      why: "gives back 27 points of its weekly limit",
    });
  });

  it("formats one CLI line: the decision and the command that spends it, then why", () => {
    const advice = advise(Object.values(TODAY));
    expect(formatResetAdvice(advice)).toBe(
      "Usage reset: spend the weekly reset on tech@equisafe.io (bb pool-local account reset id-tech@equisafe.io weekly). " +
        "No Claude account can serve now. hi@erwinkn.com serves again on its own in 3 h. A weekly reset on tech@equisafe.io (full-reset-2611, 1 left) gives back its whole weekly limit. " +
        "Next: erwin@gmail.com (fable), vadlerr (full), griffe (full), urthrax (fable), erwin@pm.me (fable).",
    );
  });

  it("needs no reset once hi@'s hold has passed", () => {
    const advice = advise(Object.values(TODAY), FIVE_HOUR_HOLD + 60_000);
    expect(advice).toEqual({ picks: [], reason: "hi@erwinkn.com can serve now.", state: "serving" });
    expect(formatResetAdvice(advice)).toBe("Usage reset: none needed. hi@erwinkn.com can serve now.");
  });

  it("says when nothing is usable, and why each held grant is not", () => {
    const advice = advise([TODAY.hi, account("tech@equisafe.io", quota(1, "2026-11-17T21:00:00Z", 0), resets([grant("full-reset-2611", "weekly", 1, { paused: true })]))]);
    expect(advice.picks).toEqual([]);
    expect(formatResetAdvice(advice)).toBe(
      "Usage reset: none to spend. No Claude account can serve now. hi@erwinkn.com serves again on its own in 3 h. No account holds a usable reset; held: hi@erwinkn.com fable (blocked by five_hour), hi@erwinkn.com full (blocked by five_hour), tech@equisafe.io weekly (paused).",
    );
  });
});

describe("adviseReset rules", () => {
  it("weighs a Fable reset by the use its grant reports for the limit it refills", () => {
    // The grant's 58% wins over the usage reading's 10%: 29 points, worth spending.
    const fable = account("a", quota(1, "2026-11-17T21:00:00Z", 0.1), resets([
      grant("f", "fable", 1, { percentUsed: { seven_day_overage_included: 0.58 } }),
    ]));
    expect(advise([fable]).picks[0]).toMatchObject({ kind: "fable", worth: true, why: "gives back 29 points of its weekly limit" });
    const low = account("b", quota(1, "2026-11-17T21:00:00Z", 0.9), resets([
      grant("f", "fable", 1, { percentUsed: { seven_day_overage_included: 0.16 } }),
      grant("w", "weekly", 1),
    ]));
    expect(advise([low]).picks[0]).toMatchObject({ kind: "weekly", grantId: "w" });
  });

  it("spends a session reset where only the 5-hour limit holds the account", () => {
    const session = account("s", quota(0.3, "2026-11-17T21:00:00Z", 0, { rejectedUntil: FIVE_HOUR_HOLD, rejectedAt: NOW - 1, rejectedLimit: "five_hour" }), resets([
      grant("s5", "session", 1, { clears: ["five_hour"] }),
    ]));
    expect(advise([session]).picks[0]).toMatchObject({ kind: "session", why: "clears its 5-hour limit" });
  });

  it("offers nothing from an ineligible program, an expired grant, or one with none left", () => {
    const ineligible = account("i", quota(1, "2026-11-17T21:00:00Z", 0.9), resets([grant("f", "fable", 1)], { eligible: false, ineligibleReason: "surface" }));
    const expired = account("e", quota(1, "2026-11-17T21:00:00Z", 0.9), resets([grant("f", "fable", 1, { endsAt: NOW - 1 })]));
    const spent = account("n", quota(1, "2026-11-17T21:00:00Z", 0.9), resets([grant("f", "fable", 0)]));
    expect(advise([ineligible, expired, spent]).picks).toEqual([]);
  });

  it("offers nothing on an account whose claim cooldown runs, and says so", () => {
    const cooling = account("c", quota(1, "2026-11-17T21:00:00Z", 0.9), resets([grant("w", "weekly", 1)], { cooldownUntil: NOW + 30_000 }));
    const advice = advise([cooling]);
    expect(advice.picks).toEqual([]);
    expect(advice.reason).toContain(`held: c weekly (claim cooldown until ${new Date(NOW + 30_000).toISOString()})`);
    expect(advise([cooling], NOW + 31_000).picks[0]).toMatchObject({ grantId: "w" });
  });

  it("names an unknown free-up, and judges an account without a reset reading by its holds", () => {
    const unknown = account("u", { ...quota(1, "2026-11-17T21:00:00Z", 0), sevenDayResetAt: null, rejectedUntil: null }, null);
    expect(advise([unknown]).reason).toBe(
      "No Claude account can serve now. None is known to serve again on its own. No account holds a usable reset.",
    );
  });

  it("ignores accounts whose usage read failed or that have no reading", () => {
    const broken = account("x", { ...quota(0, "2026-11-30T00:00:00Z", 0.9), error: "401" }, null);
    const unread = account("u", { ...quota(0, "2026-11-30T00:00:00Z", 0), observedAt: null }, null);
    expect(advise([broken, unread])).toEqual({ picks: [], reason: "No Claude account has a usage reading.", state: "unread" });
    expect(formatResetAdvice(advise([broken, unread]))).toBe("Usage reset: no reading yet. No Claude account has a usage reading.");
    expect(nextPicks(advise([broken]))).toBe("");
  });

  it("takes only enabled Claude OAuth accounts from a status read, with their grants", () => {
    const summary = (id: string, extra: Partial<AccountSummary>): AccountSummary =>
      ({ ...quota(1, "2026-11-17T21:00:00Z", 0.58), id, label: id, email: null, provider: "claude", kind: "oauth", enabled: true, resets: resets([]), ...extra }) as AccountSummary;
    const taken = resetAccounts([
      summary("11111111-0000-4000-8000-000000000000", {}),
      summary("22222222-0000-4000-8000-000000000000", { enabled: false }),
      summary("33333333-0000-4000-8000-000000000000", { kind: "api-key" }),
      summary("44444444-0000-4000-8000-000000000000", { provider: "codex" }),
    ]);
    expect(taken.map((a) => [a.label, a.quota.accountId, a.resets?.eligible])).toEqual([
      ["11111111-0000-4000-8000-000000000000", "11111111-0000-4000-8000-000000000000", true],
    ]);
    expect(resetAccounts([summary("55555555-0000-4000-8000-000000000000", { label: "Erwin", email: "e@example.com" })])[0]?.label).toBe(
      "e@example.com",
    );
  });
});
