import { z } from "zod";
import { warmingRoles, type WarmingRole } from "./warming-roles.js";
import { describeIssues, parseOrThrow } from "./validation.js";

// Cache-warming settings live under their own kv key, like advisor-config: the native "config"
// record and accountPoolConfigSchema stay unchanged, and an invalid record turns warming off
// without touching native routing.
export const WARMING_CONFIG_KEY = "warming-config";

export const warmingModeSchema = z.enum(["off", "observe", "warm"]);
export type WarmingMode = z.infer<typeof warmingModeSchema>;

export const warmingFamilySchema = z.enum(["fable", "sonnet", "opus", "haiku"]);
export type WarmingFamily = z.infer<typeof warmingFamilySchema>;

export const warmingRoleSchema = z.enum(warmingRoles);

// Settings of the fixed-window model that economic warming replaced (T141). A stored record that
// still has them stays valid: loading migrates it (upgradeLegacyRecord) and the server saves the
// result.
const LEGACY_KEYS = [
  "coordinatorMinutes",
  "workerActiveMinutes",
  "workerReportedMinutes",
  "workerAcceptedMinutes",
  "workerEndedMinutes",
  "reviewerMinutes",
  "reviewerAcceptedMinutes",
  "standaloneMinutes",
  "maxRefreshesPerLease",
];

const OLD_DEFAULT_REFRESHES_PER_HOUR = 60;

const rolesSchema = z
  .array(warmingRoleSchema)
  .max(warmingRoles.length)
  .refine(
    (roles) => new Set(roles).size === roles.length,
    "List each role once.",
  );

const familiesSchema = z
  .array(warmingFamilySchema)
  .max(4)
  .refine(
    (families) => new Set(families).size === families.length,
    "List each model family once.",
  );

const quotaReserveSchema = z
  .number()
  .positive("Must be greater than 0.")
  .max(1, "Must be at most 1.")
  .nullable();

function integer(min: number, max: number) {
  return z
    .number()
    .int("Use a whole number.")
    .min(min, `Must be at least ${min}.`)
    .max(max, `Must be at most ${max}.`);
}

export const DEFAULT_WARMING_CONFIG = {
  mode: "off" as WarmingMode,
  roles: [...warmingRoles] as WarmingRole[],
  maxWaitMinutes: 60,
  maxBackgroundWaitMinutes: 20,
  reviewHoldMinutes: 45,
  pauseStopsWarming: true,
  families: ["opus"] as WarmingFamily[],
  safetyMarginSeconds: 60,
  maxRefreshesPerHour: 100,
  maxConcurrentRefreshes: 2,
  maxLeases: 8,
  maxLeaseBodyKiB: 4_096,
  refreshTimeoutSeconds: 60,
  quotaReserve: 0.9 as number | null,
  historyLimit: 200,
  historyMinutes: 60,
};

const fieldSchemas = {
  mode: warmingModeSchema,
  // The thread roles that may be warmed: Initiative coordinators, workers and reviewers, and BB
  // threads outside any Initiative. Whether a refresh pays is decided per wait (warming-economics).
  roles: rolesSchema,
  // No refresh is sent once a wait (from the last native request's completion) is this old.
  maxWaitMinutes: integer(5, 240),
  // A thread waiting on a background task gets no refresh once its wait is this old (the T141
  // coordinator's decision: in the back-test, most background tasks that ran longer never led to a
  // resume). maxWaitMinutes still applies if it is lower.
  maxBackgroundWaitMinutes: integer(5, 240),
  // D440: while Initiatives reports a review of a worker's latest report running, the worker is
  // warmed as if it will resume, for at most this long from the review's start, and only while the
  // refreshes cost less than a rewrite. It lifts maxBackgroundWaitMinutes, not maxWaitMinutes, and a
  // hold that maxWaitMinutes cuts short does not count. 0 is off.
  reviewHoldMinutes: integer(0, 240),
  // A paused Initiative's threads are not warmed (D357, an agent default).
  pauseStopsWarming: z.boolean(),
  families: familiesSchema,
  // A refresh is sent this long before the cache entry would expire.
  safetyMarginSeconds: integer(5, 240),
  maxRefreshesPerHour: integer(0, 1_000),
  maxConcurrentRefreshes: integer(1, 8),
  maxLeases: integer(1, 64),
  // The exact native request body a lease keeps in memory to re-send.
  maxLeaseBodyKiB: integer(64, 32_768),
  refreshTimeoutSeconds: integer(5, 300),
  // Warming stops picking an account at this utilization. null means switchThreshold.
  quotaReserve: quotaReserveSchema,
  historyLimit: integer(10, 2_000),
  historyMinutes: integer(1, 1_440),
};

export type WarmingConfigKey = keyof typeof fieldSchemas;

export const warmingConfigSchema = z
  .object({
    mode: fieldSchemas.mode.default(DEFAULT_WARMING_CONFIG.mode),
    roles: fieldSchemas.roles.default(DEFAULT_WARMING_CONFIG.roles),
    maxWaitMinutes: fieldSchemas.maxWaitMinutes.default(
      DEFAULT_WARMING_CONFIG.maxWaitMinutes,
    ),
    maxBackgroundWaitMinutes: fieldSchemas.maxBackgroundWaitMinutes.default(
      DEFAULT_WARMING_CONFIG.maxBackgroundWaitMinutes,
    ),
    reviewHoldMinutes: fieldSchemas.reviewHoldMinutes.default(
      DEFAULT_WARMING_CONFIG.reviewHoldMinutes,
    ),
    pauseStopsWarming: fieldSchemas.pauseStopsWarming.default(
      DEFAULT_WARMING_CONFIG.pauseStopsWarming,
    ),
    families: fieldSchemas.families.default(DEFAULT_WARMING_CONFIG.families),
    safetyMarginSeconds: fieldSchemas.safetyMarginSeconds.default(
      DEFAULT_WARMING_CONFIG.safetyMarginSeconds,
    ),
    maxRefreshesPerHour: fieldSchemas.maxRefreshesPerHour.default(
      DEFAULT_WARMING_CONFIG.maxRefreshesPerHour,
    ),
    maxConcurrentRefreshes: fieldSchemas.maxConcurrentRefreshes.default(
      DEFAULT_WARMING_CONFIG.maxConcurrentRefreshes,
    ),
    maxLeases: fieldSchemas.maxLeases.default(DEFAULT_WARMING_CONFIG.maxLeases),
    maxLeaseBodyKiB: fieldSchemas.maxLeaseBodyKiB.default(
      DEFAULT_WARMING_CONFIG.maxLeaseBodyKiB,
    ),
    refreshTimeoutSeconds: fieldSchemas.refreshTimeoutSeconds.default(
      DEFAULT_WARMING_CONFIG.refreshTimeoutSeconds,
    ),
    quotaReserve: fieldSchemas.quotaReserve.default(
      DEFAULT_WARMING_CONFIG.quotaReserve,
    ),
    historyLimit: fieldSchemas.historyLimit.default(
      DEFAULT_WARMING_CONFIG.historyLimit,
    ),
    historyMinutes: fieldSchemas.historyMinutes.default(
      DEFAULT_WARMING_CONFIG.historyMinutes,
    ),
  })
  .strict();

export type WarmingConfig = z.infer<typeof warmingConfigSchema>;

export const warmingConfigSetInputSchema = z
  .object(
    Object.fromEntries(
      Object.entries(fieldSchemas).map(([key, schema]) => [
        key,
        schema.optional(),
      ]),
    ) as { [K in WarmingConfigKey]: z.ZodOptional<(typeof fieldSchemas)[K]> },
  )
  .strict();

export type WarmingConfigSetInput = z.infer<typeof warmingConfigSetInputSchema>;

export type WarmingConfigState =
  // migrated: the stored record was from the fixed-window model; the server saves config.
  | { ok: true; config: WarmingConfig; migrated?: true }
  | { ok: false; error: string };

export const warmingConfigViewSchema = z
  .object({
    config: warmingConfigSchema,
    effectiveQuotaReserve: z.number(),
    error: z.string().nullable(),
  })
  .strict();

export type WarmingConfigView = z.infer<typeof warmingConfigViewSchema>;

export interface WarmingConfigController {
  get: () => WarmingConfigView;
  // Raw input: mergeWarmingConfig validates it.
  set: (input: unknown) => Promise<WarmingConfigView>;
}

export function loadWarmingConfig(stored: unknown): WarmingConfigState {
  const upgraded = upgradeLegacyRecord(stored ?? {});
  const parsed = warmingConfigSchema.safeParse(upgraded ?? stored ?? {});
  if (parsed.success)
    return upgraded === null
      ? { ok: true, config: parsed.data }
      : { ok: true, config: parsed.data, migrated: true };
  return {
    ok: false,
    error: `Stored ${WARMING_CONFIG_KEY} is invalid, so cache warming is off: ${describeIssues(parsed.error.issues, "(record)")}`,
  };
}

// An invalid stored record is replaced: the update applies to the defaults, so warming stays off
// unless the update itself turns it on. Like mergeAdvisorConfig, this is the only validation of an
// update, with plain-text errors.
export function mergeWarmingConfig(
  current: WarmingConfigState,
  input: unknown,
): WarmingConfig {
  const update = parseOrThrow(warmingConfigSetInputSchema, input);
  const base = current.ok ? current.config : warmingConfigSchema.parse({});
  return parseOrThrow(warmingConfigSchema, { ...base, ...update });
}

// The configuration the warmer acts on: an invalid record behaves as the defaults with mode off.
export function effectiveWarmingConfig(
  state: WarmingConfigState,
): WarmingConfig {
  return state.ok
    ? state.config
    : { ...warmingConfigSchema.parse({}), mode: "off" };
}

export function effectiveWarmingQuotaReserve(
  config: WarmingConfig,
  switchThreshold: number,
): number {
  return Math.min(config.quotaReserve ?? switchThreshold, switchThreshold);
}

export function warmingConfigView(
  state: WarmingConfigState,
  switchThreshold: number,
): WarmingConfigView {
  const config = effectiveWarmingConfig(state);
  return {
    config,
    effectiveQuotaReserve: effectiveWarmingQuotaReserve(
      config,
      switchThreshold,
    ),
    error: state.ok ? null : state.error,
  };
}

// A record of the fixed-window model, without its window keys, and with the hourly refresh budget
// at the new default if it was at the old one (60): economic warming refreshes every linked thread,
// and 60 an hour bound it on 2026-10-05 to 10-07. Null for any other record. Once saved, a record
// has no legacy key, so a later explicit 60 stays.
function upgradeLegacyRecord(stored: unknown): Record<string, unknown> | null {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored))
    return null;
  const entries = Object.entries(stored);
  if (!entries.some(([key]) => LEGACY_KEYS.includes(key))) return null;
  const record = Object.fromEntries(
    entries.filter(([key]) => !LEGACY_KEYS.includes(key)),
  );
  if (record.maxRefreshesPerHour === OLD_DEFAULT_REFRESHES_PER_HOUR)
    record.maxRefreshesPerHour = DEFAULT_WARMING_CONFIG.maxRefreshesPerHour;
  return record;
}

// Turns the CLI's `warming set <key> <value>` into a raw update; mergeWarmingConfig validates it,
// as it does the UI's and RPC's typed values.
export function parseWarmingUpdate(
  key: string,
  value: string,
): Record<string, unknown> {
  if (!(key in fieldSchemas))
    throw new Error(
      `Warming key must be one of: ${Object.keys(fieldSchemas).join(", ")}.`,
    );
  let parsed: unknown;
  if (key === "mode") parsed = value;
  else if (key === "families" || key === "roles")
    parsed =
      value.trim() === "" || value === "none"
        ? []
        : value.split(",").map((item) => item.trim());
  else if (key === "pauseStopsWarming")
    parsed =
      value === "on" || value === "true"
        ? true
        : value === "off" || value === "false"
          ? false
          : value;
  else if (key === "quotaReserve" && value === "null") parsed = null;
  else parsed = value.trim() === "" ? Number.NaN : Number(value);
  return { [key]: parsed };
}
