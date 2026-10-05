import { z } from "zod";
import type { PoolProvider } from "./contracts.js";
import { describeIssues, parseOrThrow } from "./validation.js";

// Advisor settings live under their own kv key. The native "config" record and
// accountPoolConfigSchema stay unchanged, so native validation and a rollback to a build without
// advisor routes never see these fields.
export const ADVISOR_CONFIG_KEY = "advisor-config";

const maxUtilizationSchema = z
  .number()
  .positive("Must be greater than 0.")
  .max(1, "Must be at most 1.")
  .nullable();

export const advisorConfigSchema = z
  .object({
    routes: z
      .object({
        claude: z.boolean().default(false),
        codex: z.boolean().default(false),
      })
      .strict()
      .default({ claude: false, codex: false }),
    // Advisor traffic stops picking an account at this utilization. null means switchThreshold.
    maxUtilization: maxUtilizationSchema.default(null),
  })
  .strict();

export type AdvisorConfig = z.infer<typeof advisorConfigSchema>;

export const advisorConfigSetInputSchema = z
  .object({
    routes: z
      .object({ claude: z.boolean().optional(), codex: z.boolean().optional() })
      .strict()
      .optional(),
    maxUtilization: maxUtilizationSchema.optional(),
  })
  .strict();

export type AdvisorConfigSetInput = z.infer<typeof advisorConfigSetInputSchema>;

// What the Pooler loaded. An invalid stored record turns every advisor route off and keeps its
// error visible; it never stops native routing.
export type AdvisorConfigState =
  | { ok: true; config: AdvisorConfig }
  | { ok: false; error: string };

export const advisorConfigViewSchema = z
  .object({
    routes: z.object({ claude: z.boolean(), codex: z.boolean() }).strict(),
    maxUtilization: z.number().nullable(),
    effectiveMaxUtilization: z.number(),
    error: z.string().nullable(),
  })
  .strict();

export type AdvisorConfigView = z.infer<typeof advisorConfigViewSchema>;

export interface AdvisorConfigController {
  get: () => AdvisorConfigView;
  // Raw input: mergeAdvisorConfig validates it.
  set: (input: unknown) => Promise<AdvisorConfigView>;
}

export function loadAdvisorConfig(stored: unknown): AdvisorConfigState {
  const parsed = advisorConfigSchema.safeParse(stored ?? {});
  if (parsed.success) return { ok: true, config: parsed.data };
  return {
    ok: false,
    error: `Stored ${ADVISOR_CONFIG_KEY} is invalid, so advisor routes are off: ${describeIssues(parsed.error.issues, "(record)")}`,
  };
}

// set validates the advisor record on its own. A new numeric reserve above the current
// switchThreshold is rejected with explicit feedback. A stored reserve that a later, lower
// switchThreshold left above it is not re-checked, so route toggles (above all turning one off) and
// other updates still apply; the clamp below keeps it within native eligibility. An invalid stored
// record is replaced: the update applies to the defaults. This is the only validation of an
// update: the CLI and RPC pass raw input here, so every caller gets the same plain-text error.
export function mergeAdvisorConfig(
  current: AdvisorConfigState,
  input: unknown,
  switchThreshold: number,
): AdvisorConfig {
  const update = parseOrThrow(advisorConfigSetInputSchema, input);
  if (
    typeof update.maxUtilization === "number" &&
    update.maxUtilization > switchThreshold
  )
    throw new Error(`Must be at most switchThreshold (${switchThreshold}).`);
  const base = current.ok ? current.config : advisorConfigSchema.parse({});
  return parseOrThrow(advisorConfigSchema, {
    ...base,
    ...update,
    routes: { ...base.routes, ...update.routes },
  });
}

// The reserve the advisor pick uses. Lowering switchThreshold is always accepted by native config;
// the advisor then stays within native eligibility.
export function effectiveAdvisorMaxUtilization(
  state: AdvisorConfigState,
  switchThreshold: number,
): number {
  const reserve = state.ok ? state.config.maxUtilization : null;
  return Math.min(reserve ?? switchThreshold, switchThreshold);
}

export function advisorRouteEnabled(
  state: AdvisorConfigState,
  provider: PoolProvider,
): boolean {
  return state.ok && state.config.routes[provider];
}

export function advisorConfigView(
  state: AdvisorConfigState,
  switchThreshold: number,
): AdvisorConfigView {
  return {
    routes: state.ok ? { ...state.config.routes } : { claude: false, codex: false },
    maxUtilization: state.ok ? state.config.maxUtilization : null,
    effectiveMaxUtilization: effectiveAdvisorMaxUtilization(state, switchThreshold),
    error: state.ok ? null : state.error,
  };
}
