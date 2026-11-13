import { z } from "zod";

export const DEFAULT_ACCOUNT_POOL_CONFIG = {
  anthropicUpstreamBaseUrl: "https://api.anthropic.com",
  codexUpstreamBaseUrl: "https://chatgpt.com/backend-api/codex",
  switchThreshold: 0.98,
  claudeMainCacheTtl: "1h" as const,
  sessionAffinityIdleMinutes: 60,
};

const httpUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "Must be an HTTP or HTTPS URL.");

const switchThresholdSchema = z
  .number()
  .positive("Must be greater than 0.")
  .max(1, "Must be at most 1.");

const claudeMainCacheTtlSchema = z.enum(["5m", "1h"]);
const sessionAffinityIdleMinutesSchema = z.number().int().min(1).max(43_200);

export const accountPoolConfigSchema = z
  .object({
    anthropicUpstreamBaseUrl: httpUrlSchema.default(
      DEFAULT_ACCOUNT_POOL_CONFIG.anthropicUpstreamBaseUrl,
    ),
    codexUpstreamBaseUrl: httpUrlSchema.default(
      DEFAULT_ACCOUNT_POOL_CONFIG.codexUpstreamBaseUrl,
    ),
    claudeMainCacheTtl: claudeMainCacheTtlSchema.default(
      DEFAULT_ACCOUNT_POOL_CONFIG.claudeMainCacheTtl,
    ),
    sessionAffinityIdleMinutes: sessionAffinityIdleMinutesSchema.default(
      DEFAULT_ACCOUNT_POOL_CONFIG.sessionAffinityIdleMinutes,
    ),
    switchThreshold: switchThresholdSchema.default(
      DEFAULT_ACCOUNT_POOL_CONFIG.switchThreshold,
    ),
  })
  .strict();

export type AccountPoolConfig = z.infer<typeof accountPoolConfigSchema>;

export const accountPoolConfigSetInputSchema = z
  .object({
    anthropicUpstreamBaseUrl: httpUrlSchema.optional(),
    codexUpstreamBaseUrl: httpUrlSchema.optional(),
    switchThreshold: switchThresholdSchema.optional(),
    claudeMainCacheTtl: claudeMainCacheTtlSchema.optional(),
    sessionAffinityIdleMinutes: sessionAffinityIdleMinutesSchema.optional(),
  })
  .strict();

export type AccountPoolConfigSetInput = z.infer<
  typeof accountPoolConfigSetInputSchema
>;

export interface AccountPoolConfigController {
  get: () => AccountPoolConfig;
  set: (input: AccountPoolConfigSetInput) => Promise<AccountPoolConfig>;
}

export const providerSchema = z.enum(["claude", "codex"]);
export type PoolProvider = z.infer<typeof providerSchema>;
export const accountKindSchema = z.enum(["oauth", "api-key"]);
export const modelFamilySchema = z.enum([
  "fable",
  "sonnet",
  "opus",
  "haiku",
  "other",
]);

export type ModelFamily = z.infer<typeof modelFamilySchema>;

export const familyQuotaSchema = z
  .object({
    utilization: z.number().nullable(),
    resetAt: z.number().int().nullable(),
    status: z.string().nullable(),
    observedAt: z.number().int(),
    source: z.enum(["header", "usage"]),
  })
  .strict();

export type FamilyQuota = z.infer<typeof familyQuotaSchema>;

export const familyWeeklySchema = z
  .object({
    fable: familyQuotaSchema.nullable(),
    sonnet: familyQuotaSchema.nullable(),
    opus: familyQuotaSchema.nullable(),
    haiku: familyQuotaSchema.nullable(),
    other: familyQuotaSchema.nullable(),
  })
  .strict();

export type FamilyWeekly = z.infer<typeof familyWeeklySchema>;

export const EMPTY_FAMILY_WEEKLY: FamilyWeekly = {
  fable: null,
  sonnet: null,
  opus: null,
  haiku: null,
  other: null,
};

export const limitWindowSlotSchema = z.enum(["primary", "secondary"]);

export type LimitWindowSlot = z.infer<typeof limitWindowSlotSchema>;

export const limitWindowSchema = z
  .object({
    slot: limitWindowSlotSchema,
    windowMinutes: z.number().int().positive().nullable(),
    ...familyQuotaSchema.shape,
  })
  .strict();

export type LimitWindow = z.infer<typeof limitWindowSchema>;

const accountProjectsSchema = z
  .array(z.string().regex(/^\S+$/u, "A project ID has no spaces."))
  .min(1);

export const accountSchema = z
  .object({
    id: z.string().uuid(),
    provider: providerSchema,
    kind: accountKindSchema,
    label: z.string().min(1),
    email: z.string().email().nullable(),
    accountUuid: z.string().uuid().nullable().default(null),
    codexAccountId: z.string().min(1).optional(),
    subscriptionType: z.string().nullable(),
    rateLimitTier: z.string().nullable(),
    enabled: z.boolean(),
    priority: z.number().int(),
    createdAt: z.number().int().nonnegative(),
    lastUsedAt: z.number().int().nonnegative().nullable().default(null),
    lastUsedHostId: z.string().min(1).nullable().default(null),
    // API-key accounts only: where its requests go instead of anthropicUpstreamBaseUrl (a gateway
    // that speaks the Anthropic API). OAuth calls never use it.
    baseUrl: httpUrlSchema.optional(),
    // The BB projects whose threads this account serves, and only them; unset, it serves every
    // thread. For a thread of one of them it is preferred over the unscoped accounts.
    projects: accountProjectsSchema.optional(),
  })
  .strict();

export type Account = z.infer<typeof accountSchema>;

export const oauthSecretSchema = z
  .object({
    kind: z.literal("oauth"),
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
    expiresAt: z.number().int().positive().nullable(),
    idToken: z.string().min(1).optional(),
  })
  .strict();

export const apiKeySecretSchema = z
  .object({
    kind: z.literal("api-key"),
    apiKey: z.string().min(1),
  })
  .strict();

export const accountSecretSchema = z.discriminatedUnion("kind", [
  oauthSecretSchema,
  apiKeySecretSchema,
]);

export type AccountSecret = z.infer<typeof accountSecretSchema>;

const quotaFieldsShape = {
  sevenDayUtilization: z.number().nullable(),
  sevenDayResetAt: z.number().int().nullable(),
  sevenDayStatus: z.string().nullable(),
  representativeClaim: z.string().nullable(),
  familyWeekly: familyWeeklySchema,
  limitWindows: z.array(limitWindowSchema),
  observedAt: z.number().int().nullable(),
  heldUntil: z.number().int().nullable(),
  // A quota rejection (a 429) that none of the windows above explained, such as one from a window
  // the Pooler does not track: the account serves no family until the reset that response named,
  // or until a usage reading taken after rejectedAt shows room under rejectedLimit (the limit the
  // 429 named, as its representative claim: "seven_day"; null when it named none).
  rejectedUntil: z.number().int().nullable(),
  rejectedAt: z.number().int().nullable(),
  rejectedLimit: z.string().nullable(),
  error: z.string().nullable(),
};

export const quotaSchema = z
  .object({
    accountId: z.string().uuid(),
    ...quotaFieldsShape,
  })
  .strict();

export type AccountQuota = z.infer<typeof quotaSchema>;

// A usage-reset grant, from the usage read's cedar_ember program block (usage-resets.ts parses it).
// Kinds follow Claude Code's /limit-reset: "fable" gives back the Fable share of the weekly limit,
// "weekly" clears the weekly limits, "session" the 5-hour one, "full" both.
export const resetKindSchema = z.enum(["fable", "full", "weekly", "session"]);
export type ResetKind = z.infer<typeof resetKindSchema>;

export const resetGrantSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_-]{1,40}$/u),
    kind: resetKindSchema,
    resetsTotal: z.number().int().nonnegative().nullable(),
    resetsLeft: z.number().int().nonnegative(),
    startsAt: z.number().int().nullable(),
    endsAt: z.number().int().nullable(),
    // The limits a claim refills ("seven_day", "five_hour", "seven_day_overage_included", ...).
    clears: z.array(z.string()),
    paused: z.boolean(),
    // Whether the server would accept a claim now: authoritative.
    usableNow: z.boolean(),
    // The grant becomes usable only once a limit it refills is at its cap.
    useRequiresLimit: z.boolean(),
    // Use of each limit the grant covers, 0..1.
    percentUsed: z.record(z.string(), z.number()),
    // Limits at their cap that this grant does not refill: why it cannot be used now.
    blocking: z.array(z.string()),
    unavailableReason: z.string().nullable(),
  });
// Not strict: grants stored by an earlier build carry a label, which parsing drops.
export type ResetGrant = z.infer<typeof resetGrantSchema>;

export const usageResetsSchema = z
  .object({
    eligible: z.boolean(),
    ineligibleReason: z.string().nullable(),
    grants: z.array(resetGrantSchema),
    // A claim starts a program cooldown (about 60 s) during which no other claim is accepted.
    cooldownUntil: z.number().int().nullable(),
    observedAt: z.number().int(),
  });
// Not strict: rows stored by an earlier build carry the exhausted limits, which parsing drops.
export type UsageResets = z.infer<typeof usageResetsSchema>;

export const accountSummarySchema = accountSchema.extend({
  lastUsedHostName: z.string().min(1).nullable(),
  ...quotaFieldsShape,
  inFlight: z.number().int().nonnegative(),
  status: z.enum(["disabled", "ready", "held", "exhausted", "error"]),
  // The provider's active account: where a new session goes while it stays eligible. Sessions
  // already bound to another account keep it.
  active: z.boolean(),
  // When a held or exhausted account is usable again: the hold's end, or the latest reset of its
  // exhausted windows. null when it is usable now or the reset is unknown.
  availableAt: z.number().int().nullable(),
  // Claude OAuth accounts: the latest usage read's reset grants (null before the first one).
  resets: usageResetsSchema.nullable().default(null),
});

export type AccountSummary = z.infer<typeof accountSummarySchema>;

export const hubTokenSummarySchema = z
  .object({
    hostId: z.string().min(1),
    hostName: z.string().min(1).nullable(),
    mintedAt: z.number().int().nonnegative(),
    lastUsedAt: z.number().int().nonnegative().nullable(),
  })
  .strict();

export type HubTokenSummary = z.infer<typeof hubTokenSummarySchema>;

export const routedThreadStatusSchema = z
  .object({
    threadId: z.string().min(1),
    hostId: z.string().min(1),
    hostName: z.string().min(1).nullable(),
    routedAt: z.number().int().nonnegative(),
    localClaudeStatus: z.enum(["unauthenticated", "expired", "proxied"]),
  })
  .strict();

export type RoutedThreadStatus = z.infer<typeof routedThreadStatusSchema>;

export const statusSchema = z
  .object({
    route: z.string(),
    enabledAccountCount: z.number().int().nonnegative(),
    inFlight: z.number().int().nonnegative(),
    accepting: z.boolean(),
    hosts: z.array(hubTokenSummarySchema),
    accounts: z.array(accountSummarySchema),
    routing: z.object({ claude: z.boolean(), codex: z.boolean() }).strict(),
  })
  .strict();

export type PoolStatus = z.infer<typeof statusSchema>;

export const routedThreadStatusListSchema = z.array(routedThreadStatusSchema);

export const statusReportSchema = statusSchema
  .extend({ routedThreadsWithoutLocalLogin: routedThreadStatusListSchema })
  .strict();

export type PoolStatusReport = z.infer<typeof statusReportSchema>;

export const accountAddInputSchema = z
  .object({
    provider: providerSchema,
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("import") }).strict(),
      z
        .object({
          kind: z.literal("api-key"),
          apiKey: z.string().min(1),
          baseUrl: httpUrlSchema.optional(),
        })
        .strict(),
    ]),
    label: z.string().min(1).nullable(),
    priority: z.number().int(),
    projects: accountProjectsSchema.optional(),
  })
  .strict();

export type AccountAddInput = z.infer<typeof accountAddInputSchema>;

export const loginStartSchema = z
  .object({
    sessionId: z.string().uuid(),
    authorizeUrl: z.string().url(),
  })
  .strict();

export const loginCompleteInputSchema = z
  .object({
    sessionId: z.string().uuid(),
    pasted: z.string().trim().min(1),
  })
  .strict();

export const codexLoginStartSchema = z
  .object({
    sessionId: z.string().uuid(),
    verificationUri: z.string().url(),
    userCode: z.string().min(1),
    expiresAt: z.number().int().positive(),
    intervalMs: z.number().int().positive(),
  })
  .strict();

export const codexLoginPollInputSchema = z
  .object({ sessionId: z.string().uuid() })
  .strict();

export const codexLoginCancelSchema = z
  .object({ cancelled: z.boolean() })
  .strict();

export const codexLoginPollSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }).strict(),
  z
    .object({ status: z.literal("complete"), account: accountSummarySchema })
    .strict(),
  z.object({ status: z.literal("error"), message: z.string().min(1) }).strict(),
]);

export const accountIdInputSchema = z
  .object({ id: z.string().uuid() })
  .strict();

export const accountPriorityInputSchema = z
  .object({ accountId: z.string().uuid(), priority: z.number().int() })
  .strict();

// An empty list serves every project again.
export const accountProjectsInputSchema = z
  .object({ accountId: z.string().uuid(), projects: z.array(z.string().regex(/^\S+$/u)) })
  .strict();

export const accountReorderInputSchema = z
  .object({
    provider: providerSchema,
    accountIds: z.array(z.string().uuid()).min(1),
  })
  .strict();

export const routingSetInputSchema = z
  .object({ provider: providerSchema, enabled: z.boolean() })
  .strict();

export const tokenRotateInputSchema = z
  .object({ machine: z.string().min(1) })
  .strict();

export const bypassInputSchema = z
  .object({ threadId: z.string().min(1), bypassed: z.boolean() })
  .strict();

export const resetClaimInputSchema = z
  .object({ accountId: z.string().uuid(), kind: resetKindSchema })
  .strict();

// What one claim did. "refused": nothing was sent (why says which grant is missing or blocked).
// "answered": the server's result. "unsettled": the answer was ambiguous and a status re-read did
// not show the reset used; the next claim on the account reuses the same request id.
export const resetClaimOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("refused"), reason: z.string() }).strict(),
  z
    .object({
      status: z.literal("answered"),
      grantId: z.string(),
      kind: resetKindSchema,
      result: z.string(),
      reason: z.string().nullable(),
      resetsLeft: z.number().int().nullable(),
      cleared: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      status: z.literal("unsettled"),
      grantId: z.string(),
      kind: resetKindSchema,
      reason: z.string(),
    })
    .strict(),
]);
export type ResetClaimOutcome = z.infer<typeof resetClaimOutcomeSchema>;
