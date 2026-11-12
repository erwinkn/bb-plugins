import type { AccountQuota, AccountSummary, ResetGrant, ResetKind, UsageResets } from "./contracts.js";
import { usableAt } from "./quota.js";
import { claimable, fableUse, unusableReason } from "./usage-resets.js";

// Advice on spending a Claude usage reset, from facts: whether an account can serve now (its usage
// reading and the router's holds), and the grants each account's usage read lists. Besides a
// claim by hand (bb pool-local account reset), the Pooler spends one by itself just ahead of a
// wall, walking this ranking judged at the pre-wall mark, switchThreshold less 3 points
// (Hub.tryAutoReset): when fresh reads show no Claude account under that mark or freeing up
// within an hour, no claim unsettled, and, for a Fable reset, the Fable weekly limit at least 40%
// used.

// The Fable weekly limit is half the weekly limit (allowance_percent_of_weekly 50 on every max_20x
// account on 2026-11-11), so half of the Fable limit's use is the share of the weekly limit a Fable
// reset gives back.
export const FABLE_LIMIT_SHARE_OF_WEEKLY = 0.5;
// A Fable reset is worth spending only when it gives back at least a quarter of the weekly limit:
// about 1¾ of the week's 7 days. Less buys hours, and a full or weekly reset is the better spend.
export const FABLE_RESET_WORTH_IT = 0.25;

export interface ResetAccount {
  id: string;
  label: string;
  quota: AccountQuota;
  resets: UsageResets | null;
}

export interface ResetPick {
  accountId: string;
  label: string;
  kind: ResetKind;
  grantId: string;
  resetsLeft: number;
  // When the account serves again on its own; null when unknown.
  freeAt: number | null;
  // False for a Fable reset that gives back less than FABLE_RESET_WORTH_IT: a last resort.
  worth: boolean;
  why: string;
}

export interface ResetAdvice {
  // Each account's best grant, best first; empty unless the pool cannot serve and some account
  // holds a usable grant.
  picks: ResetPick[];
  // Every usable grant in the same order, each after its account's better ones: what an automatic
  // claim walks when a pick is refused (a grant blocked by another limit, say).
  ranked: ResetPick[];
  reason: string;
  // "unread": no account has a usage reading to judge by; "serving": one can serve now.
  state: "unread" | "serving" | "walled";
}

export const RESET_NAME: Record<ResetKind, string> = {
  fable: "Fable reset",
  full: "full reset",
  weekly: "weekly reset",
  session: "session reset",
};
const points = (share: number) => `${Math.round(share * 100)} points`;
const hours = (ms: number) => (ms < 3_600_000 ? "under 1 h" : `${Math.floor(ms / 3_600_000)} h`);
const label = (account: AccountSummary) => account.email ?? account.label;

// The enabled Claude OAuth accounts of a status read, the only ones a usage reset applies to.
export function resetAccounts(accounts: readonly AccountSummary[]): ResetAccount[] {
  return accounts
    .filter((account) => account.provider === "claude" && account.kind === "oauth" && account.enabled)
    // Labels repeat across one person's accounts ("Erwin" on five); the email names the login.
    .map((account) => ({
      id: account.id,
      label: label(account),
      quota: { ...account, accountId: account.id },
      resets: account.resets,
    }));
}

// The program accepts no claim on the account until its cooldown ends, as pickGrant refuses.
const coolingDown = (resets: UsageResets, now: number) => resets.cooldownUntil !== null && resets.cooldownUntil > now;

const KIND_ORDER: Record<ResetKind, number> = { fable: 0, full: 1, weekly: 1, session: 2 };

// The usable grants of one account, best first: a Fable reset worth spending first (it saves the
// more general resets), then a full or weekly one, then a session one, then a Fable reset that
// gives back little.
function accountPicks(account: ResetAccount, freeAt: number | null, now: number): ResetPick[] {
  if (account.resets === null || !account.resets.eligible || coolingDown(account.resets, now)) return [];
  return account.resets.grants
    .filter((grant) => claimable(grant, now))
    .map((grant): ResetPick => {
      const base = { accountId: account.id, label: account.label, kind: grant.kind, grantId: grant.id, resetsLeft: grant.resetsLeft, freeAt };
      if (grant.kind === "fable") {
        const share = fableUse(grant, account.quota) * FABLE_LIMIT_SHARE_OF_WEEKLY;
        return share >= FABLE_RESET_WORTH_IT
          ? { ...base, worth: true, why: `gives back ${points(share)} of its weekly limit` }
          : { ...base, worth: false, why: `gives back only ${points(share)} of its weekly limit` };
      }
      return {
        ...base,
        worth: true,
        why: grant.kind === "session" ? "clears its 5-hour limit" : "gives back its whole weekly limit",
      };
    })
    .sort((left, right) => Number(right.worth) - Number(left.worth) || KIND_ORDER[left.kind] - KIND_ORDER[right.kind]);
}

// When no account can serve, names when one serves again on its own and the reset worth spending
// now: among accounts holding a usable grant, worth spending first, then the account that would
// wait longest on its own, where a reset buys the most time.
export function adviseReset(accounts: readonly ResetAccount[], threshold: number, now: number): ResetAdvice {
  const read = accounts.filter(({ quota }) => quota.error === null && quota.observedAt !== null);
  if (read.length === 0) return { picks: [], ranked: [], reason: "No Claude account has a usage reading.", state: "unread" };
  const freeAt = new Map(read.map((account) => [account.id, usableAt(account.quota, null, threshold, now)]));
  const serving = read.find((account) => (freeAt.get(account.id) ?? Infinity) <= now);
  if (serving !== undefined) return { picks: [], ranked: [], reason: `${serving.label} can serve now.`, state: "serving" };
  const earliest = [...read]
    .filter((account) => freeAt.get(account.id) !== null)
    .sort((left, right) => freeAt.get(left.id)! - freeAt.get(right.id)!)[0];
  const back =
    earliest === undefined
      ? "None is known to serve again on its own"
      : `${earliest.label} serves again on its own in ${hours(freeAt.get(earliest.id)! - now)}`;
  // A stable sort: one account's grants keep their own order.
  const ranked = read
    .flatMap((account) => accountPicks(account, freeAt.get(account.id) ?? null, now))
    .sort(
      (left, right) =>
        Number(right.worth) - Number(left.worth) || (right.freeAt ?? Infinity) - (left.freeAt ?? Infinity),
    );
  const picks = ranked.filter((pick, index) => ranked.findIndex((other) => other.accountId === pick.accountId) === index);
  const first = picks[0];
  if (first !== undefined)
    return {
      picks,
      ranked,
      reason: `No Claude account can serve now. ${back}. A ${RESET_NAME[first.kind]} on ${first.label} (${first.grantId}, ${first.resetsLeft} left) ${first.why}.`,
      state: "walled",
    };
  const held = read.flatMap((account) =>
    (account.resets?.grants ?? [])
      .filter((grant) => grant.resetsLeft > 0)
      .map(
        (grant) =>
          `${account.label} ${grant.kind} (${account.resets !== null && coolingDown(account.resets, now) ? `claim cooldown until ${new Date(account.resets.cooldownUntil!).toISOString()}` : unusableReason(grant, now)})`,
      ),
  );
  return {
    picks,
    ranked,
    reason: `No Claude account can serve now. ${back}. No account holds a usable reset${held.length === 0 ? "" : `; held: ${held.join(", ")}`}.`,
    state: "walled",
  };
}

export function resetCommand(pick: ResetPick): string {
  return `bb pool-local account reset ${pick.accountId} ${pick.kind}`;
}

// The picks after the first, for when the first is not wanted.
export function nextPicks(advice: ResetAdvice): string {
  const rest = advice.picks.slice(1);
  return rest.length === 0 ? "" : `Next: ${rest.map((pick) => `${pick.label} (${pick.kind})`).join(", ")}.`;
}

// One line for `bb pool-local status`: the decision and its command, then why.
export function formatResetAdvice(advice: ResetAdvice): string {
  const first = advice.picks[0];
  if (first === undefined)
    return `Usage reset: ${{ unread: "no reading yet", serving: "none needed", walled: "none to spend" }[advice.state]}. ${advice.reason}`;
  const next = nextPicks(advice);
  return `Usage reset: spend the ${RESET_NAME[first.kind]} on ${first.label} (${resetCommand(first)}). ${advice.reason}${next === "" ? "" : ` ${next}`}`;
}
