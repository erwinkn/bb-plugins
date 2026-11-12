import type { AccountQuota, AccountSummary } from "./contracts.js";
import { activeWindow } from "./quota.js";

// Advice on spending a Claude usage reset, which Erwin claims himself with /limit-reset in his own
// Claude Code CLI. The Pooler claims nothing: its usage read does not say which resets an account
// still holds, so the advice names the kind to spend if the account has one, and a fallback. It
// reads usage readings only, never the router's holds.

// The Fable weekly limit is half the weekly limit (allowance_percent_of_weekly 50 on every max_20x
// account on 2026-11-11), so half of the Fable limit's use is the share of the weekly limit a Fable
// reset gives back. The Pooler's usage read reports the Fable limit's use, not that share.
export const FABLE_LIMIT_SHARE_OF_WEEKLY = 0.5;
// A Fable reset is worth spending only when it gives back at least a quarter of the weekly limit:
// about 1¾ of the week's 7 days. Less buys hours, and the monthly full reset, which gives back the
// whole limit, is the better spend.
export const FABLE_RESET_WORTH_IT = 0.25;
export type ResetKind = "full" | "fable";

export interface ResetAccount {
  id: string;
  label: string;
  quota: AccountQuota;
}

export interface ResetPick {
  accountId: string;
  label: string;
  kind: ResetKind;
  // The kind to spend there instead when the account holds no reset of the first kind.
  orElse: ResetKind | null;
  // When the account's weekly limit resets on its own.
  resetsAt: number | null;
  why: string;
}

export interface ResetAdvice {
  // Best first; empty when no reset is needed or no account has a reading to judge by.
  picks: ResetPick[];
  reason: string;
  read: boolean;
}

export const RESET_NAME: Record<ResetKind, string> = { full: "full reset", fable: "Fable reset" };
const points = (share: number) => `${Math.round(share * 100)} points`;
const hours = (ms: number) => (ms < 3_600_000 ? "under 1 h" : `${Math.floor(ms / 3_600_000)} h`);

// The enabled Claude OAuth accounts of a status read, the only ones a usage reset applies to.
export function resetAccounts(accounts: readonly AccountSummary[]): ResetAccount[] {
  return accounts
    .filter((account) => account.provider === "claude" && account.kind === "oauth" && account.enabled)
    // Labels repeat across one person's accounts ("Erwin" on five); the email names the login.
    .map((account) => ({ id: account.id, label: account.email ?? account.label, quota: { ...account, accountId: account.id } }));
}

// When every account's latest usage reading is at its weekly limit, spend a reset on the account
// whose weekly limit resets furthest out: there it buys the most time.
export function adviseReset(accounts: readonly ResetAccount[], threshold: number, now: number): ResetAdvice {
  const read = accounts.filter(({ quota }) => quota.error === null && (quota.sevenDayUtilization !== null || quota.sevenDayStatus !== null));
  if (read.length === 0) return { picks: [], reason: "No Claude account with a weekly usage reading.", read: false };
  const room = read.find(({ quota }) => !activeWindow(quota.sevenDayUtilization, quota.sevenDayStatus, quota.sevenDayResetAt, threshold, now));
  if (room !== undefined) return { picks: [], reason: `${room.label} still has weekly room.`, read: true };
  const picks = [...read]
    .sort((left, right) => (right.quota.sevenDayResetAt ?? 0) - (left.quota.sevenDayResetAt ?? 0))
    .map(({ id, label, quota }): ResetPick => {
      const base = { accountId: id, label, resetsAt: quota.sevenDayResetAt };
      const share = (quota.familyWeekly.fable?.utilization ?? 0) * FABLE_LIMIT_SHARE_OF_WEEKLY;
      return share >= FABLE_RESET_WORTH_IT
        ? { ...base, kind: "fable", orElse: "full", why: `a Fable reset gives back ${points(share)} of its weekly limit` }
        : { ...base, kind: "full", orElse: null, why: `a Fable reset would give back only ${points(share)}` };
    });
  const first = picks[0]!;
  const when = first.resetsAt === null ? "at an unknown time" : `in ${hours(Math.max(0, first.resetsAt - now))}`;
  return { picks, reason: `Every account is at its weekly limit; ${first.label}'s resets latest, ${when}, and ${first.why}.`, read: true };
}

// What to do when the account holds no reset of the advised kind: Pooler reads cannot tell.
export function resetFallback(advice: ResetAdvice): string {
  const [first, ...rest] = advice.picks;
  if (first === undefined) return "";
  const missing = `No ${RESET_NAME[first.kind]} left on ${first.label}?`;
  const orElse = first.orElse === null ? "" : ` Spend its ${RESET_NAME[first.orElse]}.`;
  const next = rest.length === 0 ? "" : ` ${orElse === "" ? "" : "Neither? "}Next: ${rest.map((pick) => `${pick.label} (${pick.kind})`).join(", ")}.`;
  return orElse === "" && next === "" ? "" : `${missing}${orElse}${next}`;
}

// One line for `bb pool-local status`: the decision and its command, then why.
export function formatResetAdvice(advice: ResetAdvice): string {
  const first = advice.picks[0];
  if (first === undefined) return `Usage reset: ${advice.read ? "none needed" : "no reading yet"}. ${advice.reason}`;
  const fallback = resetFallback(advice);
  return `Usage reset: spend a ${RESET_NAME[first.kind]} on ${first.label} (/limit-reset ${first.kind}). ${advice.reason}${fallback === "" ? "" : ` ${fallback}`}`;
}
