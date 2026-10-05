import { z } from "zod";
import { describeIssues, parseOrThrow } from "./validation.js";

// Cache-warming settings live under their own kv key, like advisor-config: the native "config"
// record and accountPoolConfigSchema stay unchanged, and an invalid record turns warming off
// without touching native routing.
export const WARMING_CONFIG_KEY = "warming-config";

export const warmingModeSchema = z.enum(["off", "observe", "warm"]);
export type WarmingMode = z.infer<typeof warmingModeSchema>;

export const warmingFamilySchema = z.enum(["fable", "sonnet", "opus", "haiku"]);
export type WarmingFamily = z.infer<typeof warmingFamilySchema>;

// Minutes after the last native request completes during which an idle thread's cache is kept
// warm. 0 means no lease.
const windowMinutesSchema = z
  .number()
  .int("Use whole minutes.")
  .min(0, "Must be at least 0.")
  .max(60, "Must be at most 60.");

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
  coordinatorMinutes: 20,
  workerActiveMinutes: 15,
  workerReportedMinutes: 10,
  workerAcceptedMinutes: 0,
  workerEndedMinutes: 0,
  reviewerMinutes: 0,
  reviewerAcceptedMinutes: 0,
  standaloneMinutes: 0,
  pauseStopsWarming: true,
  families: ["opus"] as WarmingFamily[],
  safetyMarginSeconds: 60,
  maxRefreshesPerLease: 4,
  maxRefreshesPerHour: 60,
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
  coordinatorMinutes: windowMinutesSchema,
  workerActiveMinutes: windowMinutesSchema,
  workerReportedMinutes: windowMinutesSchema,
  workerAcceptedMinutes: windowMinutesSchema,
  workerEndedMinutes: windowMinutesSchema,
  // Reviewers with an active or reported assignment.
  reviewerMinutes: windowMinutesSchema,
  // Reviewers whose review was accepted but who are not retired. Independent of
  // workerAcceptedMinutes, so a worker grace never warms reviewers (D362, an agent default).
  reviewerAcceptedMinutes: windowMinutesSchema,
  // Inactive: Projects reports standalone and unknown threads the same way (membership null).
  standaloneMinutes: windowMinutesSchema,
  // A paused Initiative's threads get no window (D357, an agent default).
  pauseStopsWarming: z.boolean(),
  families: familiesSchema,
  // A refresh is sent this long before the cache entry would expire.
  safetyMarginSeconds: integer(5, 240),
  maxRefreshesPerLease: integer(0, 30),
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
    coordinatorMinutes: fieldSchemas.coordinatorMinutes.default(
      DEFAULT_WARMING_CONFIG.coordinatorMinutes,
    ),
    workerActiveMinutes: fieldSchemas.workerActiveMinutes.default(
      DEFAULT_WARMING_CONFIG.workerActiveMinutes,
    ),
    workerReportedMinutes: fieldSchemas.workerReportedMinutes.default(
      DEFAULT_WARMING_CONFIG.workerReportedMinutes,
    ),
    workerAcceptedMinutes: fieldSchemas.workerAcceptedMinutes.default(
      DEFAULT_WARMING_CONFIG.workerAcceptedMinutes,
    ),
    workerEndedMinutes: fieldSchemas.workerEndedMinutes.default(
      DEFAULT_WARMING_CONFIG.workerEndedMinutes,
    ),
    reviewerMinutes: fieldSchemas.reviewerMinutes.default(
      DEFAULT_WARMING_CONFIG.reviewerMinutes,
    ),
    reviewerAcceptedMinutes: fieldSchemas.reviewerAcceptedMinutes.default(
      DEFAULT_WARMING_CONFIG.reviewerAcceptedMinutes,
    ),
    standaloneMinutes: fieldSchemas.standaloneMinutes.default(
      DEFAULT_WARMING_CONFIG.standaloneMinutes,
    ),
    pauseStopsWarming: fieldSchemas.pauseStopsWarming.default(
      DEFAULT_WARMING_CONFIG.pauseStopsWarming,
    ),
    families: fieldSchemas.families.default(DEFAULT_WARMING_CONFIG.families),
    safetyMarginSeconds: fieldSchemas.safetyMarginSeconds.default(
      DEFAULT_WARMING_CONFIG.safetyMarginSeconds,
    ),
    maxRefreshesPerLease: fieldSchemas.maxRefreshesPerLease.default(
      DEFAULT_WARMING_CONFIG.maxRefreshesPerLease,
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
  | { ok: true; config: WarmingConfig }
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
  const parsed = warmingConfigSchema.safeParse(stored ?? {});
  if (parsed.success) return { ok: true, config: parsed.data };
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

// The longest window any thread can get. standaloneMinutes is inactive, so it never counts.
export function longestWindowMinutes(config: WarmingConfig): number {
  return Math.max(
    config.coordinatorMinutes,
    config.workerActiveMinutes,
    config.workerReportedMinutes,
    config.workerAcceptedMinutes,
    config.workerEndedMinutes,
    config.reviewerMinutes,
    config.reviewerAcceptedMinutes,
  );
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
  else if (key === "families")
    parsed =
      value.trim() === "" || value === "none"
        ? []
        : value.split(",").map((family) => family.trim());
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
