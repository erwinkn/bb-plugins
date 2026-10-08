import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { metricsSchema, weightsSchema } from "./model";

// The Account Pooler's read-only usage RPCs, as far as this plugin reads them. Its ledger is the
// only source of per-request usage; this plugin never opens the Pooler's database.

export const POOLER_PLUGIN_ID = "account-pool-local";
const TIMEOUT_MS = 10_000;

export const poolerDimensions = [
  "bucket",
  "provider",
  "kind",
  "model",
  "account",
  "role",
  "thread",
] as const;
export type PoolerDimension = (typeof poolerDimensions)[number];

export interface PoolerStatsInput {
  from: number;
  to: number;
  // Bucket starts, ascending: an hour counts in the last one at or before it (or before from).
  bucket: { starts: number[] } | null;
  // null matches an unknown value.
  filter: Partial<Record<Exclude<PoolerDimension, "bucket">, Array<string | null>>>;
  groups: PoolerDimension[][];
}

const statsRowSchema = z.object({
  key: z.object({
    bucket: z.number().optional(),
    provider: z.string().nullable().optional(),
    kind: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    account: z.string().nullable().optional(),
    role: z.string().nullable().optional(),
    thread: z.string().nullable().optional(),
  }),
  metrics: metricsSchema,
});
export type PoolerStatsRow = z.infer<typeof statsRowSchema>;

const statsSchema = z.object({
  weights: weightsSchema,
  retentionDays: z.number(),
  oldestHour: z.number().nullable(),
  pendingRows: z.number(),
  results: z.array(z.array(statsRowSchema)),
});
export type PoolerStats = z.infer<typeof statsSchema>;

const quotaSchema = z.object({
  accounts: z.array(
    z.object({
      accountId: z.string(),
      points: z.array(
        z.object({
          at: z.number(),
          windows: z.record(
            z.string(),
            z.object({ utilization: z.number(), resetAt: z.number().nullable() }),
          ),
        }),
      ),
    }),
  ),
});
export type PoolerQuota = z.infer<typeof quotaSchema>;

const statusSchema = z.object({
  accounts: z.array(
    z.object({
      id: z.string(),
      provider: z.enum(["claude", "codex"]),
      label: z.string(),
      email: z.string().nullable(),
      status: z.enum(["ready", "held", "exhausted", "error", "disabled"]),
      active: z.boolean().optional(),
    }),
  ),
});
export type PoolerStatus = z.infer<typeof statusSchema>;

export interface Pooler {
  stats(input: PoolerStatsInput): Promise<PoolerStats>;
  quota(input: { from: number; to: number }): Promise<PoolerQuota>;
  status(): Promise<PoolerStatus>;
}

export function poolerClient(sdk: BbPluginApi["sdk"]): Pooler {
  const call = <T>(method: string, input: unknown, outputSchema: z.ZodType<T>) =>
    sdk.plugins.callRpc({
      pluginId: POOLER_PLUGIN_ID,
      method,
      input: input as never,
      outputSchema,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  return {
    stats: (input) => call("usage.stats", input, statsSchema),
    quota: (input) => call("usage.quota", input, quotaSchema),
    status: () => call("status.get", null, statusSchema),
  };
}
