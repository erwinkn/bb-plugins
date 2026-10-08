import { z } from "zod/mini";

const nonemptyStringSchema = z.string().check(z.minLength(1));
const costSchema = z.strictObject({
  usedUsdCents: z.number().check(z.int(), z.nonnegative()),
  limitUsdCents: z.number().check(z.int(), z.positive()),
});

export const usageWindowSchema = z.strictObject({
  label: nonemptyStringSchema,
  usedPercent: z.number(),
  resetsAt: z.nullable(nonemptyStringSchema),
  cost: z.nullable(costSchema),
});

export const providerUsageSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("ok"),
    accountEmail: z.nullable(nonemptyStringSchema),
    planLabel: z.nullable(nonemptyStringSchema),
    windows: z.array(usageWindowSchema),
  }),
  z.strictObject({ status: z.literal("not_installed") }),
  z.strictObject({ status: z.literal("unauthenticated") }),
  z.strictObject({ status: z.literal("expired") }),
  z.strictObject({
    status: z.literal("error"),
    message: nonemptyStringSchema,
  }),
]);

const iconTintSchema = z.strictObject({
  light: nonemptyStringSchema,
  dark: nonemptyStringSchema,
});

export const usageProviderSchema = z.strictObject({
  id: nonemptyStringSchema,
  displayName: nonemptyStringSchema,
  logoUrl: z.nullable(nonemptyStringSchema),
  iconGlyph: z.nullable(nonemptyStringSchema),
  iconTint: z.nullable(iconTintSchema),
  signInHint: nonemptyStringSchema,
  expiredHint: nonemptyStringSchema,
  usage: z.nullable(providerUsageSchema),
});

export const usageMachineProviderSchema = z.strictObject({
  id: nonemptyStringSchema,
  logoUrl: z.nullable(nonemptyStringSchema),
  icon: z.nullable(nonemptyStringSchema),
});

export const usageMachineSchema = z.strictObject({
  id: nonemptyStringSchema,
  displayName: nonemptyStringSchema,
  status: z.enum(["connected", "disconnected"]),
  machineProvider: z.nullable(usageMachineProviderSchema),
  providers: z.array(usageProviderSchema),
  error: z.nullable(nonemptyStringSchema),
});

// An Account Pooler account serving a provider's traffic, whatever the machine.
export const pooledAccountSchema = z.strictObject({
  id: nonemptyStringSchema,
  name: nonemptyStringSchema,
  status: z.enum(["ready", "held", "exhausted", "error", "disabled"]),
  // Where new sessions go; sessions already bound to another account stay there.
  active: z.boolean(),
  // When a held or exhausted account is usable again.
  availableAt: z.nullable(nonemptyStringSchema),
  error: z.nullable(nonemptyStringSchema),
  windows: z.array(usageWindowSchema),
});

// A provider whose traffic the Account Pooler routes: its usage is the pool's, not the machine's.
export const providerPoolSchema = z.strictObject({
  providerId: nonemptyStringSchema,
  planLabel: z.nullable(nonemptyStringSchema),
  accounts: z.array(pooledAccountSchema),
});

export const usageSnapshotSchema = z.strictObject({
  machines: z.array(usageMachineSchema),
  pools: z.array(providerPoolSchema),
  // The Usage stats page's route, while that plugin runs.
  detailsHref: z.nullable(nonemptyStringSchema),
});

export const usageRpcSuccessSchema = z.strictObject({
  ok: z.literal(true),
  result: usageSnapshotSchema,
});

export type ProviderUsage = z.infer<typeof providerUsageSchema>;
export type UsageWindow = z.infer<typeof usageWindowSchema>;
export type UsageProvider = z.infer<typeof usageProviderSchema>;
export type UsageMachine = z.infer<typeof usageMachineSchema>;
export type UsageMachineProvider = z.infer<typeof usageMachineProviderSchema>;
export type UsageSnapshot = z.infer<typeof usageSnapshotSchema>;
export type PooledAccount = z.infer<typeof pooledAccountSchema>;
export type ProviderPool = z.infer<typeof providerPoolSchema>;

function windowsTone(windows: UsageWindow[]): "warning" | "critical" | null {
  const usedPercent = Math.max(0, ...windows.map((window) => window.usedPercent));
  if (usedPercent >= 95) return "critical";
  return usedPercent >= 80 ? "warning" : null;
}

// A pooled provider is critical when no enabled account can take a request, and otherwise as
// close to its limits as the active account.
export function providerUsageTone(
  provider: UsageProvider,
  pool: ProviderPool | null,
): "warning" | "critical" | null {
  if (pool !== null) {
    const enabled = pool.accounts.filter((account) => account.status !== "disabled");
    if (enabled.length === 0) return null;
    if (!enabled.some((account) => account.status === "ready")) return "critical";
    const active = enabled.find((account) => account.active);
    return active === undefined ? null : windowsTone(active.windows);
  }
  if (provider.usage?.status !== "ok") return null;
  return windowsTone(provider.usage.windows);
}
