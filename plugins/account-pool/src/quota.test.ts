import { describe, expect, it } from "vitest";
import {
  isQuotaExhausted,
  quotaFromHeaders,
  quotaRejection,
  usableAt,
} from "./quota.js";
import { quotaFromUsage } from "./usage.js";
import { createClaudeAdapter } from "./claude-adapter.js";
import type { Account, AccountQuota } from "./contracts.js";
import type { AccountStore, QuotaStore } from "./store.js";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const NOW = 1_800_000_000_000;
const RESET = NOW / 1_000 + 3_600;

function emptyQuota(): AccountQuota {
  return {
    accountId: ACCOUNT_ID,
    sevenDayUtilization: null,
    sevenDayResetAt: null,
    sevenDayStatus: null,
    representativeClaim: null,
    familyWeekly: {
      fable: null,
      sonnet: null,
      opus: null,
      haiku: null,
      other: null,
    },
    limitWindows: [],
    observedAt: null,
    heldUntil: null,
    rejectedUntil: null,
    rejectedAt: null,
    rejectedLimit: null,
    error: null,
  };
}

describe("Claude quota without the 5h window", () => {
  it("ignores 5h headers, even a spent window", () => {
    const quota = quotaFromHeaders(
      ACCOUNT_ID,
      new Headers({
        "anthropic-ratelimit-unified-5h-status": "rejected",
        "anthropic-ratelimit-unified-5h-utilization": "1.0",
        "anthropic-ratelimit-unified-5h-reset": String(RESET),
        "anthropic-ratelimit-unified-7d-status": "allowed",
        "anthropic-ratelimit-unified-7d-utilization": "0.61",
      }),
      emptyQuota(),
      "opus",
      NOW,
    );
    expect(quota).not.toHaveProperty("fiveHourStatus");
    expect(quota.sevenDayUtilization).toBe(0.61);
    expect(isQuotaExhausted(quota, "opus", 0.95, NOW)).toBe(false);
  });

  it("ignores five_hour in the usage endpoint's answer", () => {
    const quota = quotaFromUsage(
      ACCOUNT_ID,
      {
        five_hour: { utilization: 100, resets_at: new Date(RESET * 1_000).toISOString() },
        seven_day: { utilization: 62, resets_at: null },
        limits: [{ kind: "session", group: "session", percent: 100 }],
      },
      emptyQuota(),
      NOW,
      NOW,
    );
    expect(quota).not.toHaveProperty("fiveHourUtilization");
    expect(quota?.sevenDayUtilization).toBe(0.62);
    if (quota === null) throw new Error("Expected a quota.");
    expect(isQuotaExhausted(quota, "opus", 0.95, NOW)).toBe(false);
  });

  it("keeps an account with no quota data at all eligible", () => {
    expect(isQuotaExhausted(emptyQuota(), "opus", 0.95, NOW)).toBe(false);
    expect(usableAt(emptyQuota(), "opus", 0.95, NOW)).toBe(0);
  });

  it("reads an overall verdict as account-wide and a weekly one as its window's", () => {
    const at = (seconds: number) => String(seconds);
    // From Claude's 5h window, and even alongside weekly windows that reset at the same time: the
    // overall verdict names no family and may come from a window the Pooler does not track.
    for (const extra of [
      { "anthropic-ratelimit-unified-5h-status": "rejected" },
      { "anthropic-ratelimit-unified-7d-status": "rejected", "anthropic-ratelimit-unified-7d-reset": at(RESET) },
      { "anthropic-ratelimit-unified-7d_oi-status": "rejected", "anthropic-ratelimit-unified-7d_oi-reset": at(RESET) },
    ] as Array<Record<string, string>>)
      expect(
        quotaRejection(
          new Headers({
            "anthropic-ratelimit-unified-status": "rejected",
            "anthropic-ratelimit-unified-reset": at(RESET),
            ...extra,
          }),
          "fable",
        ),
      ).toEqual({ tracked: false, resetAt: RESET * 1_000, limit: null });
    // A weekly verdict alone is held by the window quotaFromHeaders records from the same response.
    for (const headers of [
      { "anthropic-ratelimit-unified-7d-status": "rejected" },
      {
        "anthropic-ratelimit-unified-status": "allowed",
        "anthropic-ratelimit-unified-reset": at(RESET + 86_400),
        "anthropic-ratelimit-unified-7d_oi-status": "rejected",
        "anthropic-ratelimit-unified-7d_oi-reset": at(RESET),
      },
    ] as Array<Record<string, string>>)
      expect(quotaRejection(new Headers(headers), "fable")).toEqual({ tracked: true });
    // A 429 that names no spent quota is a short rate limit.
    expect(quotaRejection(new Headers({ "retry-after": "5" }), "fable")).toBeNull();
    expect(
      quotaRejection(
        new Headers({ "anthropic-ratelimit-unified-status": "allowed" }),
        "fable",
      ),
    ).toBeNull();
  });

  it("names the limit an overall verdict came from, a scoped one by the request's family", () => {
    const limit = (claim: string) =>
      quotaRejection(
        new Headers({
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-representative-claim": claim,
        }),
        "fable",
      );
    expect(limit("seven_day")).toMatchObject({ tracked: false, limit: "seven_day" });
    expect(limit("five_hour")).toMatchObject({ tracked: false, limit: "five_hour" });
    expect(limit("seven_day_oi")).toMatchObject({ tracked: false, limit: "seven_day_fable" });
  });

  it("blocks every family until rejectedUntil, and nothing after it", () => {
    const quota = { ...emptyQuota(), rejectedUntil: NOW + 60_000 };
    expect(isQuotaExhausted(quota, "sonnet", 0.95, NOW)).toBe(true);
    expect(usableAt(quota, null, 0.95, NOW)).toBe(NOW + 60_000);
    expect(isQuotaExhausted(quota, "sonnet", 0.95, NOW + 60_000)).toBe(false);
  });
});

describe("a usage reading ends a quota 429's hold (W586)", () => {
  const DAY = 24 * 3_600_000;
  const resetsAt = new Date(NOW + 5 * DAY).toISOString();
  // A weekly-limit 429 at NOW: the Pooler holds the account until its weekly reset, 5 days out.
  const held = (limit: string | null, rejectedAt: number | null = NOW): AccountQuota => ({
    ...emptyQuota(),
    sevenDayUtilization: 1,
    sevenDayStatus: "rejected",
    rejectedUntil: NOW + 5 * DAY,
    rejectedAt,
    rejectedLimit: limit,
  });
  const read = (
    previous: AccountQuota,
    payload: object,
    requestedAt = NOW + 60_000,
  ) => {
    const quota = quotaFromUsage(ACCOUNT_ID, payload, previous, NOW + 61_000, requestedAt);
    if (quota === null) throw new Error("Expected a quota.");
    return quota;
  };
  const weekly = (seven: number, fable = 0) => ({
    seven_day: { utilization: seven, resets_at: resetsAt },
    seven_day_fable: { utilization: fable, resets_at: resetsAt },
  });
  const serves = (quota: AccountQuota) => !isQuotaExhausted(quota, "fable", 0.98, NOW + 61_000);

  it("keeps the hold on a reading at the limit, one sent before the 429, or one without the limit", () => {
    expect(serves(held("seven_day"))).toBe(false);
    expect(read(held("seven_day"), weekly(100)).rejectedUntil).toBe(NOW + 5 * DAY);
    // Sent before the 429, or in the same millisecond, the reading may predate the limit.
    expect(read(held("seven_day"), weekly(0), NOW - 1).rejectedUntil).toBe(NOW + 5 * DAY);
    expect(read(held("seven_day"), weekly(0), NOW).rejectedUntil).toBe(NOW + 5 * DAY);
    // A reading that leaves out the weekly limit says nothing about it.
    expect(read(held("seven_day"), { seven_day_fable: { utilization: 0 } }).rejectedUntil).toBe(NOW + 5 * DAY);
    // Room under another limit than the one the 429 named releases nothing.
    expect(read(held("five_hour"), weekly(0)).rejectedUntil).toBe(NOW + 5 * DAY);
  });

  it("releases it once a later reading shows room again, as after a claimed full reset", () => {
    const quota = read(held("seven_day"), weekly(0));
    expect(quota).toMatchObject({ rejectedUntil: null, rejectedAt: null, rejectedLimit: null, sevenDayUtilization: 0 });
    expect(serves(quota)).toBe(true);
  });

  it("releases a Fable-limit 429 on room under the Fable limit only", () => {
    const fable429 = { ...held("seven_day_fable"), sevenDayUtilization: 0.6, sevenDayStatus: "allowed" };
    expect(read(fable429, weekly(60, 100)).rejectedUntil).toBe(NOW + 5 * DAY);
    expect(serves(read(fable429, weekly(60, 0)))).toBe(true);
  });

  it("keeps a named-limit hold while the same reading shows a full 5-hour window", () => {
    const fiveHourFull = { ...weekly(0), five_hour: { utilization: 100 } };
    expect(read(held("seven_day"), fiveHourFull).rejectedUntil).toBe(NOW + 5 * DAY);
    expect(read(held("seven_day"), { ...weekly(0), five_hour: { utilization: 3 } }).rejectedUntil).toBeNull();
    // A full window whose reset has passed is room, as it is for routing.
    const expired = { ...weekly(0), five_hour: { utilization: 100, resets_at: new Date(NOW - 7_200_000).toISOString() } };
    expect(read(held("seven_day"), expired).rejectedUntil).toBeNull();
  });

  it("releases a 429 that named no limit on room under the account-wide limits the reading reports", () => {
    const fiveHourFull = { ...weekly(0), five_hour: { utilization: 100 } };
    expect(read(held(null), fiveHourFull).rejectedUntil).toBe(NOW + 5 * DAY);
    expect(read(held(null), { ...weekly(0), five_hour: { utilization: 3 } }).rejectedUntil).toBeNull();
    // A full Fable limit keeps Fable off the account, not Sonnet or Opus.
    const fableFull = read(held(null), weekly(0, 100));
    expect(fableFull.rejectedUntil).toBeNull();
    expect(serves(fableFull)).toBe(false);
    expect(isQuotaExhausted(fableFull, "sonnet", 0.98, NOW + 61_000)).toBe(false);
  });

  it("reads a held account whose limits list an empty scoped entry", () => {
    const empty = { kind: "weekly_scoped", percent: null, resets_at: null, status: null, scope: { model: { display_name: "Fable" } } };
    const payload = { seven_day: { utilization: 0, resets_at: resetsAt }, limits: [empty] };
    expect(read(held(null), payload).rejectedUntil).toBeNull();
    expect(read(held("seven_day_fable"), payload).rejectedUntil).toBe(NOW + 5 * DAY);
  });

  it("releases a hold an older build recorded, with no time, on any reading that shows room", () => {
    expect(read(held(null, null), weekly(0)).rejectedUntil).toBeNull();
  });

  it("keeps a hold a 429 put on while the usage request was in flight", async () => {
    const adapter = createClaudeAdapter({ refreshUrl: "x:", usageUrl: "https://u.invalid/usage", profileUrl: "x:" });
    const refresh = async (during: AccountQuota | null) => {
      let quota = held("seven_day", NOW - 60_000);
      let clock = NOW;
      await adapter.refreshUsage({
        account: { id: ACCOUNT_ID, kind: "oauth", accountUuid: "u" } as Account,
        freshSecret: async () => ({ kind: "oauth", accessToken: "t", refreshToken: "r", expiresAt: NOW + DAY }),
        accounts: {} as AccountStore,
        quotas: { get: () => quota, put: (next: AccountQuota) => (quota = next) } as unknown as QuotaStore,
        fetch: async () => {
          clock += 1_000;
          if (during !== null) quota = during;
          return Response.json(weekly(0));
        },
        now: () => clock,
      });
      return quota.rejectedUntil;
    };
    expect(await refresh(null)).toBeNull();
    expect(await refresh(held("seven_day", NOW + 500))).toBe(NOW + 5 * DAY);
  });
});
