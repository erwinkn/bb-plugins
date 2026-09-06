import type { ProviderUsage, ProviderUsageResult, ProviderUsageWindow } from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_resolveExecutablePath as resolveExecutablePath } from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import { probeDevinUsage } from "./usage-probe";

const infoSchema = z.object({ planName: z.string().optional(), hideDailyQuota: z.boolean().optional(), hideWeeklyQuota: z.boolean().optional() });
const responseSchema = z.object({
  planInfo: infoSchema.nullish(),
  userStatus: z.object({ email: z.string().optional(), planStatus: z.object({
    planInfo: infoSchema.nullish(), planEnd: z.object({ seconds: z.number().finite() }).nullish(),
    dailyQuotaRemainingPercent: z.number().finite().min(0).max(100).optional(),
    weeklyQuotaRemainingPercent: z.number().finite().min(0).max(100).optional(),
    dailyQuotaResetAtUnix: z.number().finite().optional(), weeklyQuotaResetAtUnix: z.number().finite().optional(),
    acuConsumed: z.number().finite().nonnegative().nullish(), acuLimit: z.number().finite().nonnegative().nullish(),
  }).nullish() }),
});

function errorUsage(message: string): ProviderUsage {
  return { status: "error", message, accountEmail: null, planLabel: null };
}
function resetAt(seconds: number | undefined): string | null {
  if (seconds === undefined || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
export function normalizeUsage(raw: unknown): ProviderUsage {
  const result = responseSchema.safeParse(raw);
  if (!result.success) return errorUsage("Devin returned invalid account usage data.");
  const { userStatus, planInfo } = result.data;
  const plan = userStatus.planStatus;
  const info = plan?.planInfo ?? planInfo;
  const windows: ProviderUsageWindow[] = [];
  if (plan) {
    for (const [label, remaining, reset, hidden] of [
      ["Daily limit", plan.dailyQuotaRemainingPercent, plan.dailyQuotaResetAtUnix, info?.hideDailyQuota],
      ["Weekly limit", plan.weeklyQuotaRemainingPercent, plan.weeklyQuotaResetAtUnix, info?.hideWeeklyQuota],
    ] as const) {
      const resetsAt = resetAt(reset);
      // A reset identifies an applicable quota. An absent quota is not 100% used.
      if (!hidden && remaining !== undefined && resetsAt !== null) windows.push({ label, usedPercent: 100 - remaining, resetsAt });
    }
    if (plan.acuConsumed != null && plan.acuLimit != null && plan.acuLimit > 0) {
      windows.push({ label: `Billing cycle (${plan.acuConsumed.toLocaleString("en-US", { maximumFractionDigits: 2 })} / ${plan.acuLimit.toLocaleString("en-US", { maximumFractionDigits: 2 })} ACUs)`,
        usedPercent: Math.min(100, plan.acuConsumed / plan.acuLimit * 100), resetsAt: resetAt(plan.planEnd?.seconds) });
    }
  }
  return { status: "ok", accountEmail: userStatus.email || null, planLabel: info?.planName || null, windows };
}

export async function getDevinUsage(command: string, deps = { executable: resolveExecutablePath, probe: probeDevinUsage }): Promise<ProviderUsageResult> {
  try {
    // Probe the same resolved executable that the existence check found.
    const executable = await deps.executable(command);
    if (executable === null) return { supported: true, usage: { status: "not_installed" } };
    return { supported: true, usage: normalizeUsage(await deps.probe(executable)) };
  } catch {
    // CLI failures may contain credential-bearing inputs. Do not echo them.
    return { supported: true, usage: errorUsage("Devin account usage could not be loaded. Check devin auth status on this machine, then try again.") };
  }
}
