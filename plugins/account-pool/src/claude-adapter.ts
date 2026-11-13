import { z } from "zod";
import type { AccountSecret } from "./contracts.js";
import {
  importClaudeCredentials,
  type ImportedClaudeCredentials,
} from "./credentials.js";
import type { AdapterUsageContext, ProviderAdapter } from "./provider-adapter.js";
import {
  fetchOAuthRefresh,
  filterRequestHeaders,
  mountedUpstreamUrl,
  oauthSecretDueForRefresh,
} from "./provider-adapter.js";
import {
  epochMilliseconds,
  quotaRejection,
  quotaFromHeaders,
} from "./quota.js";
import { parseRequestBody } from "./request-body.js";
import { quotaFromUsage } from "./usage.js";
import {
  CLAUDE_CLI_HEADERS,
  claimAnswer,
  RESET_PROGRAM,
  resetsFromUsage,
} from "./usage-resets.js";

const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_BETA = "oauth-2025-04-20";
const USAGE_REQUEST_TIMEOUT_MS = 10_000;
const ALLOWED_REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "user-agent",
  "x-app",
]);
const ALLOWED_REQUEST_HEADER_PREFIXES = ["anthropic-", "x-stainless-"];

const refreshResponseSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    expires_in: z.number().positive().optional(),
    expires_at: z.number().positive().optional(),
  })
  .passthrough();

const profileResponseSchema = z
  .object({
    account: z
      .object({ uuid: z.string().uuid().nullish() })
      .passthrough()
      .nullish(),
    organization: z
      .object({ uuid: z.string().uuid().nullish() })
      .passthrough()
      .nullish(),
  })
  .passthrough();

type Profile = z.infer<typeof profileResponseSchema>;

// The organization's claim endpoint; tests pass their own.
export const DEFAULT_RESET_URL = (organizationUuid: string) =>
  `https://api.anthropic.com/api/organizations/${organizationUuid}/reset_rate_limits`;

export function createClaudeAdapter(options: {
  refreshUrl: string;
  // The usage read; the default asks for the reset program block (?cedar_ember=1&skip_spend=1).
  usageUrl: string;
  profileUrl: string;
  resetUrl?: (organizationUuid: string) => string;
  importCredentials?: () => Promise<ImportedClaudeCredentials>;
}): ProviderAdapter {
  // Usage, profile and claim requests carry the CLI's identity: the reset program answers only it.
  const apiHeaders = (accessToken: string) => ({
    authorization: `Bearer ${accessToken}`,
    "anthropic-beta": OAUTH_BETA,
    accept: "application/json",
    ...CLAUDE_CLI_HEADERS,
  });
  const readProfile = async (
    context: AdapterUsageContext,
    accessToken: string,
  ): Promise<Profile | null> => {
    const profile = await context.fetch(options.profileUrl, {
      headers: apiHeaders(accessToken),
      signal: AbortSignal.timeout(USAGE_REQUEST_TIMEOUT_MS),
    });
    if (!profile.ok) {
      await profile.body?.cancel();
      return null;
    }
    const parsed = profileResponseSchema.safeParse(
      await profile.json().catch(() => null),
    );
    return parsed.success ? parsed.data : null;
  };
  return {
    provider: "claude",
    upstreamName: "Anthropic",
    retryAfterLimitSeconds: null,
    async importAccount() {
      const imported = await (
        options.importCredentials ?? importClaudeCredentials
      )();
      return {
        label: imported.email ?? "Claude Code account",
        email: imported.email,
        ...(imported.accountUuid === null
          ? {}
          : { accountUuid: imported.accountUuid }),
        subscriptionType: imported.subscriptionType,
        rateLimitTier: imported.rateLimitTier,
        secret: {
          kind: "oauth",
          accessToken: imported.accessToken,
          refreshToken: imported.refreshToken,
          expiresAt: imported.expiresAt,
        },
      };
    },
    parseRequest(body) {
      const parsed = parseRequestBody(body);
      return {
        family: parsed.family,
        model: parsed.model,
        affinityId: parsed.affinityId,
        parentAffinityId: parsed.parentAffinityId,
        forAccount: (account) => parsed.forAccount(account.accountUuid),
      };
    },
    // An OAuth token only ever goes to Anthropic: a base URL counts on an API-key account alone.
    upstreamUrl: (request, settings, account) =>
      mountedUpstreamUrl(
        request,
        (account.kind === "api-key" ? account.baseUrl : undefined) ??
          settings.anthropicUpstreamBaseUrl,
      ),
    requestHeaders(inbound, _account, secret) {
      const headers = filterRequestHeaders(
        inbound,
        ALLOWED_REQUEST_HEADERS,
        ALLOWED_REQUEST_HEADER_PREFIXES,
      );
      if (secret.kind === "oauth") {
        headers.set("authorization", `Bearer ${secret.accessToken}`);
      } else {
        headers.set("x-api-key", secret.apiKey);
      }
      return headers;
    },
    quotaFromHeaders,
    quotaRejection,
    async refreshSecret(context) {
      const secret = oauthSecretDueForRefresh(context);
      if (secret === null) return { secret: context.secret, refreshed: false };
      const parsed = refreshResponseSchema.parse(
        JSON.parse(
          await fetchOAuthRefresh(context, options.refreshUrl, {
            grant_type: "refresh_token",
            refresh_token: secret.refreshToken,
            client_id: OAUTH_CLIENT_ID,
          }),
        ),
      );
      const rawExpiresAt =
        parsed.expires_at ??
        (parsed.expires_in === undefined
          ? context.now() + 60 * 60 * 1_000
          : context.now() + parsed.expires_in * 1_000);
      const refreshed: AccountSecret = {
        kind: "oauth",
        accessToken: parsed.access_token,
        refreshToken: parsed.refresh_token ?? secret.refreshToken,
        expiresAt: epochMilliseconds(rawExpiresAt),
        ...(secret.idToken === undefined ? {} : { idToken: secret.idToken }),
      };
      await context.accounts.writeSecret(context.account.id, refreshed);
      return { secret: refreshed, refreshed: true };
    },
    async refreshUsage(context) {
      if (context.account.kind !== "oauth") return;
      const secret = await context.freshSecret();
      if (secret.kind !== "oauth") return;
      const requestedAt = context.now();
      const response = await context.fetch(options.usageUrl, {
        headers: apiHeaders(secret.accessToken),
        signal: AbortSignal.timeout(USAGE_REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        const payload = await response.json().catch(() => null);
        if (typeof payload === "object" && payload !== null) {
          const now = context.now();
          const quota = quotaFromUsage(
            context.account.id,
            payload,
            context.quotas.get(context.account.id),
            now,
            requestedAt,
          );
          if (quota !== null) context.quotas.put(quota);
          const resets = resetsFromUsage(payload, now);
          if (resets !== null) context.quotas.putResets(context.account.id, resets);
        }
      } else {
        await response.body?.cancel();
      }
      if (context.account.accountUuid === null) {
        const accountUuid =
          (await readProfile(context, secret.accessToken))?.account?.uuid ?? null;
        if (accountUuid !== null) {
          await context.accounts.setAccountUuid(context.account.id, accountUuid);
        }
      }
      // A claim judges only from a reading taken now (hub.ts readUsageNow); the usage loop ignores it.
      if (!response.ok) throw new Error(`The usage read answered HTTP ${response.status}.`);
    },
    // The organization comes from a profile read at claim time: claims are rare, and storing it on
    // the account record would break an older build's strict parse of that record.
    async claimReset(context, claim) {
      let secret: AccountSecret;
      try {
        secret = await context.freshSecret();
      } catch (error) {
        return {
          kind: "unsent",
          reason: `its credential could not be prepared (${error instanceof Error ? error.message : String(error)})`,
        };
      }
      if (secret.kind !== "oauth")
        return { kind: "unsent", reason: "the account has no OAuth login" };
      const organizationUuid =
        (await readProfile(context, secret.accessToken).catch(() => null))
          ?.organization?.uuid ?? null;
      if (organizationUuid === null)
        return { kind: "unsent", reason: "the profile read named no organization" };
      let response: Response;
      try {
        response = await context.fetch(
          (options.resetUrl ?? DEFAULT_RESET_URL)(organizationUuid),
          {
            method: "POST",
            headers: { ...apiHeaders(secret.accessToken), "content-type": "application/json" },
            body: JSON.stringify({
              program: RESET_PROGRAM,
              grant_id: claim.grantId,
              request_id: claim.requestId,
            }),
            signal: AbortSignal.timeout(USAGE_REQUEST_TIMEOUT_MS),
          },
        );
      } catch (error) {
        return {
          kind: "ambiguous",
          reason: `no answer (${error instanceof Error ? error.message : String(error)})`,
        };
      }
      return claimAnswer(response.status, await response.json().catch(() => null));
    },
    errorResponse(status, message, headers) {
      const type =
        status === 401
          ? "authentication_error"
          : status === 429
            ? "rate_limit_error"
            : "api_error";
      return Response.json(
        { type: "error", error: { type, message } },
        { status, headers },
      );
    },
  };
}
