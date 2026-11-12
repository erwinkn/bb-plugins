import { z } from "zod";
import type { PluginKvStorage } from "@get-bb/plugin-sdk";
import {
  resetGrantSchema,
  type AccountQuota,
  type ResetGrant,
  type ResetClaimOutcome,
  type ResetKind,
  type UsageResets,
} from "./contracts.js";
import { parseReset } from "./quota.js";

// Claude usage resets ("cedar_ember"), the program behind Claude Code's /limit-reset, as Claude
// Code 2.1.321 reads and claims it. The usage read with ?cedar_ember=1 adds a program block listing
// the account's grants; a claim POSTs one grant id to the organization's reset_rate_limits.

export const RESET_PROGRAM = "cedar_ember";
// The server answers eligible:false, ineligible_reason "surface" unless the read looks like the
// CLI's. Pinned: a CLI release the server stops accepting shows as ineligible_reason
// "cli_version" in `bb pool-local status`, and this is the one place to bump.
export const CLAUDE_CLI_USER_AGENT = "claude-cli/2.1.321 (external, cli)";
export const CLAUDE_CLI_HEADERS = { "user-agent": CLAUDE_CLI_USER_AGENT, "x-app": "cli" };

const timeSchema = z.union([z.number(), z.string()]).nullish();

const rawGrantSchema = z
  .object({
    id: resetGrantSchema.shape.id,
    resets_total: z.number().int().nonnegative().nullish(),
    resets_left: z.number().int().nonnegative(),
    starts_at: timeSchema,
    ends_at: timeSchema,
    clears: z.array(z.string()).nullish(),
    paused: z.boolean().nullish(),
    usable_now: z.boolean().nullish(),
    use_requires_limit: z.boolean().nullish(),
    percent_used: z.record(z.string(), z.number()).nullish(),
    blocking: z.array(z.string()).nullish(),
    type: z.string().nullish(),
    gives_back_weekly: z.boolean().nullish(),
    unavailable_reason: z.string().nullish(),
  })
  .passthrough();

const rawProgramSchema = z
  .object({
    eligible: z.boolean(),
    ineligible_reason: z.string().nullish(),
    grants: z.array(z.unknown()).nullish(),
    cooldown_until: timeSchema,
  })
  .passthrough();

// The CLI's derivation: a grant that gives back weekly use is a Fable reset; else its declared type;
// else what it clears.
function grantKind(grant: z.infer<typeof rawGrantSchema>): ResetKind {
  if (grant.gives_back_weekly === true) return "fable";
  if (grant.type === "session" || grant.type === "weekly" || grant.type === "full") return grant.type;
  const clears = grant.clears ?? [];
  const session = clears.includes("five_hour");
  const weekly = clears.some((limit) => limit.startsWith("seven_day"));
  return session && weekly ? "full" : session ? "session" : "weekly";
}

const time = (value: string | number | null | undefined) =>
  value === null || value === undefined ? null : parseReset(value);

// The program block of a usage payload, or null when it has none. A malformed grant is dropped on
// its own; a malformed block reads as none. Never throws: the usage reading stands either way.
export function resetsFromUsage(payload: object, now: number): UsageResets | null {
  const block = rawProgramSchema.safeParse((payload as Record<string, unknown>)[RESET_PROGRAM]);
  if (!block.success) return null;
  const grants = (block.data.grants ?? []).flatMap((value): ResetGrant[] => {
    const raw = rawGrantSchema.safeParse(value);
    if (!raw.success) return [];
    const grant = raw.data;
    return [
      {
        id: grant.id,
        kind: grantKind(grant),
        resetsTotal: grant.resets_total ?? null,
        resetsLeft: grant.resets_left,
        startsAt: time(grant.starts_at),
        endsAt: time(grant.ends_at),
        clears: grant.clears ?? [],
        paused: grant.paused ?? false,
        usableNow: grant.usable_now ?? false,
        useRequiresLimit: grant.use_requires_limit ?? false,
        percentUsed: Object.fromEntries(
          Object.entries(grant.percent_used ?? {}).map(([limit, percent]) => [limit, percent / 100]),
        ),
        blocking: grant.blocking ?? [],
        unavailableReason: grant.unavailable_reason ?? null,
      },
    ];
  });
  return {
    eligible: block.data.eligible,
    ineligibleReason: block.data.ineligible_reason ?? null,
    grants,
    cooldownUntil: time(block.data.cooldown_until),
    observedAt: now,
  };
}

// Whether a claim of the grant would be accepted now, by the CLI's rule for its target: usable now,
// not paused, not expired, with a reset left.
export function claimable(grant: ResetGrant, now: number): boolean {
  return (
    grant.usableNow &&
    !grant.paused &&
    grant.resetsLeft > 0 &&
    (grant.endsAt === null || grant.endsAt > now)
  );
}

// Whether the account holds the grant now: started, not expired, not paused, with a reset left,
// and either usable now or unusable for a reason the server names. Unlike claimable, it accepts a
// grant that is not usable now for a stated reason: one that becomes usable only once a limit it
// refills is at its cap (useRequiresLimit), or one blocked by another limit or an
// unavailable_reason, is still held and spendable later, which is what routing toward it (the
// preferred Fable account) needs. A grant unusable with no reason given may never be claimable, so
// it is not held. claimable leaves startsAt to usableNow, the server's verdict.
export function holdsGrant(grant: ResetGrant, now: number): boolean {
  return (
    grant.resetsLeft > 0 &&
    !grant.paused &&
    (grant.startsAt === null || grant.startsAt <= now) &&
    (grant.endsAt === null || grant.endsAt > now) &&
    (grant.usableNow || grant.useRequiresLimit || grant.blocking.length > 0 || grant.unavailableReason !== null)
  );
}

// Why a grant cannot be claimed now; the server's own classification first.
export function unusableReason(grant: ResetGrant, now: number): string {
  if (grant.resetsLeft === 0) return "none left";
  if (grant.endsAt !== null && grant.endsAt <= now) return `expired ${new Date(grant.endsAt).toISOString()}`;
  if (grant.paused) return "paused";
  if (grant.unavailableReason !== null) return grant.unavailableReason;
  if (grant.blocking.length > 0) return `blocked by ${grant.blocking.join(", ")}`;
  if (grant.useRequiresLimit) return `usable only once ${grant.clears.join(" or ")} is at its limit`;
  return "not usable now";
}

export type GrantChoice = { grant: ResetGrant } | { refused: string };

function programRefusal(resets: UsageResets, now: number): { refused: string } | null {
  if (!resets.eligible)
    return { refused: `the account is not eligible for usage resets (${resets.ineligibleReason ?? "unknown reason"})` };
  if (resets.cooldownUntil !== null && resets.cooldownUntil > now)
    return { refused: `a claim cooldown runs until ${new Date(resets.cooldownUntil).toISOString()}` };
  return null;
}

// The grant a claim of this kind spends, as the CLI picks it: the first claimable one of the kind in
// the server's order. Otherwise why there is none, naming the kinds the account does hold.
export function pickGrant(resets: UsageResets, kind: ResetKind, now: number): GrantChoice {
  const program = programRefusal(resets, now);
  if (program !== null) return program;
  const ofKind = resets.grants.filter((grant) => grant.kind === kind);
  const grant = ofKind.find((candidate) => claimable(candidate, now));
  if (grant !== undefined) return { grant };
  const held = resets.grants
    .filter((candidate) => candidate.kind !== kind && candidate.resetsLeft > 0)
    .map((candidate) => `${candidate.kind} (${candidate.id})`);
  const others = held.length === 0 ? "" : `; it holds ${held.join(", ")}`;
  if (ofKind.length === 0) return { refused: `it holds no ${kind} reset${others}` };
  return {
    refused: `no ${kind} reset is usable: ${ofKind.map((candidate) => `${candidate.id} ${unusableReason(candidate, now)}`).join("; ")}${others}`,
  };
}

// The use of the Fable weekly limit a Fable reset clears: as the grant reports it, else the reading.
export function fableUse(grant: ResetGrant, quota: AccountQuota): number {
  const reported = grant.clears.flatMap((limit) => grant.percentUsed[limit] ?? []);
  return reported.length > 0 ? Math.max(...reported) : (quota.familyWeekly.fable?.utilization ?? 0);
}

// An automatic claim spends a Fable reset only once the Fable weekly limit is at least this used
// (Erwin, 2026-11-12): below it, the reset gives back too little to spend unattended.
export const FABLE_AUTO_USE_MIN = 0.4;

// The flagged grant an automatic claim may spend: claimable now, blocked by no limit at its cap,
// and, for a Fable reset, with the Fable weekly limit at least FABLE_AUTO_USE_MIN used.
export function autoUseGrant(resets: UsageResets, grantId: string, quota: AccountQuota, now: number): GrantChoice {
  const program = programRefusal(resets, now);
  if (program !== null) return program;
  const grant = resets.grants.find((candidate) => candidate.id === grantId);
  if (grant === undefined) return { refused: "the account no longer holds it" };
  if (!claimable(grant, now) || grant.blocking.length > 0) return { refused: unusableReason(grant, now) };
  if (grant.kind === "fable" && fableUse(grant, quota) < FABLE_AUTO_USE_MIN)
    return {
      refused: `its Fable weekly use is ${Math.round(fableUse(grant, quota) * 100)}%, under the ${FABLE_AUTO_USE_MIN * 100}% an automatic Fable reset needs`,
    };
  return { grant };
}

const claimAnswerSchema = z
  .object({
    result: z.string(),
    reason: z.string().nullish(),
    resets_left: z.number().int().nonnegative().nullish(),
    cleared: z.array(z.string()).nullish(),
    cooldown_until: timeSchema,
  })
  .passthrough();

// What the server said to a claim. "ambiguous": no answer, an error status the claim may have
// outlived (429, 5xx), or result "unavailable"; the same request id is safe to send again.
export type ClaimAnswer =
  | {
      kind: "answered";
      result: string;
      reason: string | null;
      resetsLeft: number | null;
      cleared: string[];
    }
  | { kind: "ambiguous"; reason: string }
  | { kind: "rejected"; reason: string }
  // Nothing was sent (the profile read that names the organization failed, say).
  | { kind: "unsent"; reason: string };

export function claimAnswer(status: number, body: unknown): ClaimAnswer {
  if (status === 429 || status >= 500) return { kind: "ambiguous", reason: `HTTP ${status}` };
  if (status < 200 || status >= 300) return { kind: "rejected", reason: `HTTP ${status}` };
  const parsed = claimAnswerSchema.safeParse(body);
  if (!parsed.success) return { kind: "ambiguous", reason: "an unreadable answer" };
  if (parsed.data.result === "unavailable")
    return { kind: "ambiguous", reason: `unavailable${parsed.data.reason ? ` (${parsed.data.reason})` : ""}` };
  return {
    kind: "answered",
    result: parsed.data.result,
    reason: parsed.data.reason ?? null,
    resetsLeft: parsed.data.resets_left ?? null,
    cleared: parsed.data.cleared ?? [],
  };
}

// Web Crypto: this module is also bundled into the settings page (reset-advice.ts).
export const newRequestId = () => globalThis.crypto.randomUUID().replaceAll("-", "");

const pendingClaimSchema = z
  .object({
    grantId: z.string(),
    requestId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u),
    // The grant's resets_left when the claim was sent: a later read with fewer settles it as used.
    resetsLeftBefore: z.number().int().nonnegative(),
    at: z.number().int(),
  })
  .strict();
export type PendingClaim = z.infer<typeof pendingClaimSchema>;

export interface AutoUseFlag {
  accountId: string;
  grantId: string;
}

// How long an unsettled claim stays unsettled, as in Claude Code: until then a read that does not
// show it used (or no longer lists its grant) leaves its state unknown; after it, the claim is
// taken as never applied and dropped.
export const UNSETTLED_HORIZON_MS = 10 * 60_000;

// Whether a read shows an unsettled claim used: its grant is still listed with fewer resets left
// than when it was sent. A grant missing from the read settles nothing: a malformed grant dropped
// by the parse, or a program change, would look the same.
export function claimLanded(claim: PendingClaim, resets: UsageResets): boolean {
  const grant = resets.grants.find((candidate) => candidate.id === claim.grantId);
  return grant !== undefined && grant.resetsLeft < claim.resetsLeftBefore;
}

export function describeClaimOutcome(outcome: ResetClaimOutcome): string {
  if (outcome.status === "refused") return `refused: ${outcome.reason}`;
  if (outcome.status === "unsettled") return `unsettled: ${outcome.reason}`;
  return [
    outcome.result,
    outcome.reason === null ? null : `(${outcome.reason})`,
    outcome.resetsLeft === null ? null : `${outcome.resetsLeft} left`,
    outcome.cleared.length === 0 ? null : `cleared ${outcome.cleared.join(", ")}`,
  ]
    .filter((part) => part !== null)
    .join(", ");
}

const PENDING_PREFIX = "reset-claim:";
const AUTO_USE_PREFIX = "reset-auto-use:";
const WALL_CLAIMED_KEY = "reset-wall-claimed";

// The reset state the Pooler keeps itself, each in its own KV records (the config record keeps its
// five keys): the one unsettled claim per account, whose request id a retry reuses; the grants
// flagged for automatic use at a wall; and whether an automatic claim was sent at the current wall,
// so a reload at that wall spends no second flagged grant.
export class ResetClaimStore {
  private flags: AutoUseFlag[] | null = null;
  private wall: boolean | null = null;

  constructor(private readonly kv: PluginKvStorage) {}

  // null when the account has none; "unreadable" when a record is there but does not parse: its
  // request id may be the only safe one to resend, so a claim must not go ahead as if it were absent.
  async pending(accountId: string): Promise<PendingClaim | "unreadable" | null> {
    const value = await this.kv.get(PENDING_PREFIX + accountId);
    if (value === undefined) return null;
    const parsed = pendingClaimSchema.safeParse(value);
    return parsed.success ? parsed.data : "unreadable";
  }

  // Every account's pending record, for the pool-wide check before an automatic claim.
  async allPending(): Promise<Array<{ accountId: string; claim: PendingClaim | "unreadable" }>> {
    const records = [];
    for (const key of await this.kv.list(PENDING_PREFIX)) {
      const accountId = key.slice(PENDING_PREFIX.length);
      const claim = await this.pending(accountId);
      if (claim !== null) records.push({ accountId, claim });
    }
    return records;
  }

  async setPending(accountId: string, claim: PendingClaim): Promise<void> {
    await this.kv.set(PENDING_PREFIX + accountId, pendingClaimSchema.parse(claim));
  }

  async clearPending(accountId: string): Promise<void> {
    await this.kv.delete(PENDING_PREFIX + accountId);
  }

  // A flag is its key, reset-auto-use:<account>:<grant>, whatever its value (true; an earlier build
  // wrote an object). Read once, then kept in memory: a wall asks on every request.
  async autoUse(): Promise<AutoUseFlag[]> {
    this.flags ??= (await this.kv.list(AUTO_USE_PREFIX)).flatMap((key) => {
      const [accountId, grantId] = key.slice(AUTO_USE_PREFIX.length).split(":");
      return accountId && grantId ? [{ accountId, grantId }] : [];
    });
    return this.flags;
  }

  async setAutoUse(accountId: string, grantId: string, enabled: boolean): Promise<void> {
    const key = `${AUTO_USE_PREFIX}${accountId}:${grantId}`;
    if (enabled) await this.kv.set(key, true);
    else await this.kv.delete(key);
    this.flags = null;
  }

  async wallClaimed(): Promise<boolean> {
    this.wall ??= (await this.kv.get(WALL_CLAIMED_KEY)) !== undefined;
    return this.wall;
  }

  // The record's existence is the state (an earlier build wrote {at}). Written only on a change: a
  // cleared wall is checked on every served response.
  async setWallClaimed(claimed: boolean): Promise<void> {
    if ((await this.wallClaimed()) === claimed) return;
    this.wall = claimed;
    if (claimed) await this.kv.set(WALL_CLAIMED_KEY, true);
    else await this.kv.delete(WALL_CLAIMED_KEY);
  }

  async forget(accountId: string): Promise<void> {
    await this.clearPending(accountId);
    for (const key of await this.kv.list(`${AUTO_USE_PREFIX}${accountId}:`)) await this.kv.delete(key);
    this.flags = null;
  }
}
