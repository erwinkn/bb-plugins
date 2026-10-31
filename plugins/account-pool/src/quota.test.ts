import { describe, expect, it } from "vitest";
import type { AccountQuota } from "./contracts.js";
import {
  isQuotaExhausted,
  quotaFromHeaders,
  quotaRejection,
  usableAt,
} from "./quota.js";
import { quotaFromUsage } from "./usage.js";

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
        ),
      ).toEqual({ tracked: false, resetAt: RESET * 1_000 });
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
      expect(quotaRejection(new Headers(headers))).toEqual({ tracked: true });
    // A 429 that names no spent quota is a short rate limit.
    expect(quotaRejection(new Headers({ "retry-after": "5" }))).toBeNull();
    expect(
      quotaRejection(
        new Headers({ "anthropic-ratelimit-unified-status": "allowed" }),
      ),
    ).toBeNull();
  });

  it("blocks every family until rejectedUntil, and nothing after it", () => {
    const quota = { ...emptyQuota(), rejectedUntil: NOW + 60_000 };
    expect(isQuotaExhausted(quota, "sonnet", 0.95, NOW)).toBe(true);
    expect(usableAt(quota, null, 0.95, NOW)).toBe(NOW + 60_000);
    expect(isQuotaExhausted(quota, "sonnet", 0.95, NOW + 60_000)).toBe(false);
  });
});
