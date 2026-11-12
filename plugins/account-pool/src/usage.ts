import { z } from "zod";
import {
  EMPTY_FAMILY_WEEKLY,
  type AccountQuota,
  type FamilyQuota,
  type FamilyWeekly,
  type ModelFamily,
} from "./contracts.js";
import { activeWindow, modelFamily, parseReset } from "./quota.js";

const numberValueSchema = z.union([z.number(), z.string()]);

const usageBucketSchema = z
  .object({
    utilization: numberValueSchema.nullish(),
    used_percentage: numberValueSchema.nullish(),
    usedPercentage: numberValueSchema.nullish(),
    resets_at: z.union([z.number(), z.string()]).nullish(),
    reset_at: z.union([z.number(), z.string()]).nullish(),
    resetAt: z.union([z.number(), z.string()]).nullish(),
    status: z.string().nullish(),
  })
  .passthrough();

const usageLimitSchema = z
  .object({
    kind: z.string().nullish(),
    group: z.string().nullish(),
    percent: numberValueSchema.nullish(),
    resets_at: z.union([z.number(), z.string()]).nullish(),
    status: z.string().nullish(),
    scope: z
      .object({
        model: z
          .object({ display_name: z.string().nullish() })
          .passthrough()
          .nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

const usagePayloadSchema = z
  .object({
    five_hour: usageBucketSchema.nullish(),
    seven_day: usageBucketSchema.nullish(),
    seven_day_fable: usageBucketSchema.nullish(),
    seven_day_sonnet: usageBucketSchema.nullish(),
    seven_day_opus: usageBucketSchema.nullish(),
    seven_day_haiku: usageBucketSchema.nullish(),
    limits: z.array(usageLimitSchema).optional(),
  })
  .passthrough();

type UsageBucket = z.infer<typeof usageBucketSchema>;

function percentage(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed / 100 : null;
}

function normalizeBucket(bucket: UsageBucket, now: number): FamilyQuota | null {
  const utilization = percentage(
    bucket.used_percentage ??
      bucket.utilization ??
      bucket.usedPercentage ??
      null,
  );
  const resetAt = parseReset(
    bucket.resets_at ?? bucket.reset_at ?? bucket.resetAt ?? null,
  );
  if (utilization === null && resetAt === null && bucket.status == null)
    return null;
  return {
    utilization,
    resetAt,
    status:
      bucket.status ??
      (utilization === null ? null : utilization >= 1 ? "rejected" : "allowed"),
    observedAt: now,
    source: "usage",
  };
}

function stronger(
  current: FamilyQuota | null,
  candidate: FamilyQuota | null,
): FamilyQuota | null {
  if (candidate === null) return current;
  if (current === null) return candidate;
  return (candidate.utilization ?? -1) > (current.utilization ?? -1)
    ? candidate
    : current;
}

function limitBucket(
  percent: string | number | null | undefined,
  reset: string | number | null | undefined,
  status: string | null | undefined,
  now: number,
): FamilyQuota | null {
  return normalizeBucket(
    {
      utilization: percent,
      resets_at: reset,
      status,
    },
    now,
  );
}

// Whether a reading releases the hold a quota 429 put on the account: it was requested after that
// 429 (a hold an older build recorded has no rejectedAt and predates every reading of this one) and
// reports room under the limit the 429 named and under the account-wide limits it reports (5-hour,
// weekly), so a release is not met by the next 429: each model's weekly limit still blocks that model
// at the switch threshold once released. A named limit the reading does not report releases nothing;
// a full window whose reset has passed counts as room, as it does for routing.
function releasesRejection(
  previous: AccountQuota,
  limits: ReadonlyMap<string, FamilyQuota>,
  requestedAt: number,
  now: number,
): boolean {
  if (previous.rejectedUntil === null) return false;
  if ((previous.rejectedAt ?? -Infinity) >= requestedAt) return false;
  const accountWide = [...limits].filter(([key]) => !key.startsWith("seven_day_")).map(([, limit]) => limit);
  const named =
    previous.rejectedLimit === null ? accountWide : [limits.get(previous.rejectedLimit), ...accountWide];
  return (
    named.length > 0 &&
    named.every(
      (limit) =>
        limit !== undefined &&
        limit.utilization !== null &&
        !activeWindow(limit.utilization, limit.status, limit.resetAt, 1, now),
    )
  );
}

// requestedAt: when the usage request was sent, so a reading that left before a 429 cannot end it.
export function quotaFromUsage(
  accountId: string,
  payload: object,
  previous: AccountQuota,
  now: number,
  requestedAt: number,
): AccountQuota | null {
  const parsed = usagePayloadSchema.safeParse(payload);
  if (!parsed.success) return null;
  const data = parsed.data;
  if (
    data.seven_day == null &&
    data.seven_day_fable == null &&
    data.seven_day_sonnet == null &&
    data.seven_day_opus == null &&
    data.seven_day_haiku == null &&
    data.limits === undefined
  )
    return null;
  // The limits this reading itself reports, keyed as a 429's representative claim names them.
  const limits = new Map<string, FamilyQuota>();
  const familyWeekly: FamilyWeekly =
    data.limits === undefined
      ? { ...previous.familyWeekly }
      : { ...EMPTY_FAMILY_WEEKLY };
  for (const limit of data.limits ?? []) {
    if (
      limit.kind !== "weekly_scoped" &&
      !(limit.group === "weekly" && limit.scope?.model?.display_name != null)
    )
      continue;
    const displayName = limit.scope?.model?.display_name;
    if (displayName == null) continue;
    const family = modelFamily(displayName);
    const bucket = stronger(
      familyWeekly[family],
      limitBucket(limit.percent, limit.resets_at, limit.status, now),
    );
    familyWeekly[family] = bucket;
    // An entry with no percent, reset or status leaves the bucket empty: it reports no limit.
    if (bucket !== null) limits.set(`seven_day_${family}`, bucket);
  }
  const slots: Array<[ModelFamily, UsageBucket | null | undefined]> = [
    ["fable", data.seven_day_fable],
    ["sonnet", data.seven_day_sonnet],
    ["opus", data.seven_day_opus],
    ["haiku", data.seven_day_haiku],
  ];
  for (const [family, bucket] of slots) {
    if (bucket == null) continue;
    const normalized = normalizeBucket(bucket, now);
    if (normalized === null) continue;
    familyWeekly[family] = normalized;
    limits.set(`seven_day_${family}`, normalized);
  }
  const sevenDay =
    data.seven_day == null ? null : normalizeBucket(data.seven_day, now);
  const fiveHour =
    data.five_hour == null ? null : normalizeBucket(data.five_hour, now);
  if (sevenDay !== null) limits.set("seven_day", sevenDay);
  if (fiveHour !== null) limits.set("five_hour", fiveHour);
  const released = releasesRejection(previous, limits, requestedAt, now);
  return {
    ...previous,
    accountId,
    sevenDayUtilization: sevenDay?.utilization ?? previous.sevenDayUtilization,
    sevenDayResetAt: sevenDay?.resetAt ?? previous.sevenDayResetAt,
    sevenDayStatus: sevenDay?.status ?? previous.sevenDayStatus,
    familyWeekly,
    observedAt: now,
    ...(released
      ? { rejectedUntil: null, rejectedAt: null, rejectedLimit: null }
      : {}),
  };
}
