import type {
  Account,
  AccountPoolConfig,
  AccountQuota,
  AccountSecret,
  ModelFamily,
  PoolProvider,
  PoolStatus,
  ResetClaimOutcome,
  ResetGrant,
  ResetKind,
  UsageResets,
} from "./contracts.js";
import {
  advisorRouteEnabled,
  effectiveAdvisorMaxUtilization,
  type AdvisorConfigState,
} from "./advisor-config.js";
import {
  cacheUsageFrom,
  createCodexUsageTap,
  createUsageTap,
} from "./cache-usage.js";
import { createClaudeAdapter } from "./claude-adapter.js";
import {
  autoUseGrant,
  claimLanded,
  describeClaimOutcome,
  holdsGrant,
  newRequestId,
  pickGrant,
  UNSETTLED_HORIZON_MS,
  type ClaimAnswer,
  type PendingClaim,
  type ResetClaimStore,
} from "./usage-resets.js";
import { StringCheck } from "./json-scan.js";
import { abortable, linkSignals } from "./signals.js";
import {
  createCodexAdapter,
  DEFAULT_CODEX_REFRESH_URL,
  DEFAULT_CODEX_USAGE_URL,
} from "./codex-adapter.js";
import type { RequestAttribution, RequestKind, RequestRecord } from "./ledger.js";
import type { ProviderAdapter } from "./provider-adapter.js";
import type { ImportedProviderAccount } from "./provider-adapter.js";
import { TransientOAuthRefreshError } from "./provider-adapter.js";
import type {
  ImportedClaudeCredentials,
  ImportedCodexCredentials,
} from "./credentials.js";
import {
  accountStatus,
  governingWeeklyResetAt,
  isQuotaExhausted,
  isSharedQuotaExhausted,
  retryAfterMilliseconds,
  usableAt,
} from "./quota.js";
import type {
  AccountBinding,
  AccountStore,
  HubTokenStore,
  PoolAffinityStore,
  QuotaStore,
} from "./store.js";
import {
  type KeepAliveRequest,
  type KeepAliveResult,
  type NativeObservation,
  type NativeRequestStart,
  type ResponseTap,
} from "./warming.js";

const ROUTE = "/api/v1/plugins/account-pool-local/http";
// Sessions whose latest 429 the hub remembers, and for how long: a turn fails within seconds of
// the 429 (Codex after its own retries, within minutes).
const MAX_SESSION_REJECTIONS = 1_024;
const SESSION_REJECTION_TTL_MS = 15 * 60_000;
const DEFAULT_REFRESH_URL = "https://platform.claude.com/v1/oauth/token";
// With the reset program's block (usage-resets.ts); skip_spend leaves out the spend section.
const DEFAULT_USAGE_URL =
  "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1";
// A flagged reset is spent at a wall only when no account frees up sooner than this on its own.
const AUTO_RESET_MIN_WAIT_MS = 60 * 60_000;
// After an automatic-claim decision that probed (fresh reads) or sent a claim, walled requests skip
// probing this long: the server's own claim cooldown is about as long.
const AUTO_RESET_QUIET_MS = 60_000;
const DEFAULT_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const DEFAULT_USAGE_REFRESH_INTERVAL_MS = 5 * 60 * 1_000;
const MAX_INLINE_HOLD_MS = 20_000;
// A declared content-length up to this is trusted to size the request body buffer.
const MAX_PREALLOCATED_BODY_BYTES = 32 * 1024 * 1024;
const ADVISOR_MAX_BODY_BYTES = 256 * 1024;
const ADVISOR_DISPATCH_HEADER = "x-account-pool-dispatch";
const OAUTH_BETA = "oauth-2025-04-20";
const MAX_KEEP_ALIVE_RESPONSE_BYTES = 64 * 1024;
const MAX_REFRESH_BACKOFF_MS = 60_000;
const MAX_REFRESH_BACKOFFS = 1_024;
const MAX_FAILURE_DETAIL_BYTES = 1_024;
const FAILURE_DISPOSAL_TIMEOUT_MS = 250;
const MAX_AFFINITY_BINDINGS = 4_096;
const DROPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

interface HubOptions {
  accounts: AccountStore;
  quotas: QuotaStore;
  affinity: PoolAffinityStore;
  maxAffinityBindings: number;
  hubTokens: HubTokenStore;
  getSettings: () => AccountPoolConfig;
  getAdvisorConfig: () => AdvisorConfigState;
  adapters: ReadonlyMap<PoolProvider, ProviderAdapter>;
  fetch: typeof fetch;
  now: () => number;
  drainTimeoutMs: number;
  onAccountsChanged: () => void;
  onUpstreamError: (provider: PoolProvider, error: unknown) => void;
  warming: WarmingHooks | null;
  ledger: LedgerHooks | null;
  resetClaims: ResetClaimStore | null;
  // Every reset claim and automatic-claim decision: "info" for a claim sent, "debug" for a decline.
  logReset: (message: string, level: "info" | "debug") => void;
}

// The hub's view of the cache warmer: it reports native Claude Messages traffic, and the session of
// every native request, which the warmer links to its BB thread.
export interface WarmingHooks {
  observe(start: NativeRequestStart): NativeObservation | null;
  lookUpSession(sessionId: string): void;
}

// The hub's view of the usage ledger: one record per upstream response. It must not throw.
export interface LedgerHooks {
  request(record: RequestRecord): void;
}

// What the ledger needs about a request before its response.
type LedgerStart = Omit<
  RequestRecord,
  "status" | "completed" | "usage" | "finishedAt" | "startedAt"
>;

interface SelectedAccount {
  account: Account;
  quota: AccountQuota;
  keepAffinity: boolean;
  accept: () => void;
}

// What a claim spends: the first usable grant of a kind (a claim by hand), or one grant (a flag).
type ClaimTarget = { kind: ResetKind } | { grantId: string };

// A claim's outcome, and what became of its POST. "sent": it left (answered, ambiguous, or
// rejected after the send). "not-sent": a refusal before it, or the adapter's "unsent".
// "pool-serves": an automatic claim stopped just before its POST because an account can serve
// now (a claim by hand landed meanwhile): nothing to spend, select again. Internal: the RPC and
// CLI see the outcome only.
interface ClaimResult {
  outcome: ResetClaimOutcome;
  delivery: "sent" | "not-sent" | "pool-serves";
}

interface ActiveAccount {
  accountId: string;
}

interface PacingFlight {
  heldUntil: number;
  result: Promise<void>;
}

interface RoutingAttempt {
  binding: AccountBinding | null;
  active: ActiveAccount | null;
  pinnedAccountId: string | null;
}
interface UpstreamResult {
  response: Response;
  controller: AbortController;
  release: () => void;
}

interface RefreshBackoff {
  kind: "proactive" | "rejected";
  accessToken: string;
  retryAt: number;
  delayMs: number;
  error: TransientOAuthRefreshError;
}

// "isolated" (advisor and cache-warming traffic) behaves like "normal" (near-expiry refresh,
// single flight) but never escalates to a forced refresh and never waits behind native credential
// repair: it fails with IsolatedCredentialUnavailable instead.
type SecretUse =
  | { kind: "normal" }
  | { kind: "isolated" }
  | { kind: "rejected"; accessToken: string };

type SecretFlight =
  | { kind: "refresh"; use: SecretUse; result: Promise<AccountSecret> }
  | { kind: "rejection-check"; result: Promise<void> };

interface FailureSummary {
  status: number;
  message: string;
  headers: Record<string, string>;
}

class UpstreamConnectionError extends Error {}
class IsolatedCredentialUnavailable extends Error {}

export class AccountPoolHub {
  private accepting = false;
  private stopped = new AbortController();
  private readonly inFlightByAccount = new Map<string, number>();
  // Each upstream request still open, with its ledger start: its row is not recorded yet.
  private readonly activeControllers = new Map<AbortController, number>();
  private readonly refreshes = new Map<string, SecretFlight>();
  private readonly refreshBackoffs = new Map<string, RefreshBackoff>();
  private readonly pacingByAccount = new Map<string, PacingFlight>();
  private affinityBindings = new Map<string, AccountBinding>();
  private activeAccounts = new Map<PoolProvider, ActiveAccount>();
  private readonly usageRefreshes = new Map<string, Promise<void>>();
  private readonly lastUsageRefreshAt = new Map<string, number>();
  private readonly drainWaiters = new Set<() => void>();
  private readonly sessionRejections = new Map<
    string,
    { answeredAt: number; retryAt: number }
  >();
  // Claims run one at a time per account; an automatic one at a time for the pool.
  private readonly resetClaimFlights = new Map<string, Promise<ClaimResult>>();
  private autoResetFlight: Promise<boolean> | null = null;
  // Until when walled requests skip probing for an automatic claim, after a decline or a sent one.
  private autoResetQuietUntil = 0;
  private lastAutoResetLog: string | null = null;

  constructor(private readonly options: HubOptions) {}

  private affinityIdleTtlMs(): number {
    return this.options.getSettings().sessionAffinityIdleMinutes * 60_000;
  }

  async start(signal: AbortSignal): Promise<void> {
    this.affinityBindings = this.options.affinity.loadBindings(
      this.options.now() - this.affinityIdleTtlMs(),
      MAX_AFFINITY_BINDINGS,
    );
    this.activeAccounts = this.options.affinity.loadActiveAccounts();
    // Whether an automatic claim was already sent at the current wall, before a reload.
    await this.options.resetClaims?.wallClaimed().catch(() => undefined);
    this.pacingByAccount.clear();
    this.stopped = new AbortController();
    this.accepting = true;
    while (!signal.aborted) {
      await this.refreshUsage();
      await waitForDelay(DEFAULT_USAGE_REFRESH_INTERVAL_MS, signal);
    }
    await this.stop();
  }

  async authenticate(request: Request): Promise<string | null> {
    const token =
      request.headers.get("x-bb-account-pool-token") ??
      readBearer(request.headers.get("authorization"));
    return this.options.hubTokens.authenticate(token);
  }

  async importAccount(
    provider: PoolProvider,
  ): Promise<ImportedProviderAccount> {
    return this.adapter(provider).importAccount();
  }

  // Advisor route. One account, one upstream POST, and no account-health writes. Only header quota
  // observations and the shared near-expiry credential preparation touch shared state. Every
  // response the advisor handler returns says whether a vendor POST was started. BB's own
  // pre-handler rejections and its post-handler "plugin route failed" 500 never carry the header.
  async handleAdvisor(
    request: Request,
    provider: PoolProvider,
  ): Promise<Response> {
    const dispatch = { sent: false };
    const response = await this.advisorResponse(request, provider, dispatch);
    response.headers.set(
      ADVISOR_DISPATCH_HEADER,
      dispatch.sent ? "sent" : "none",
    );
    return response;
  }

  private async advisorResponse(
    request: Request,
    provider: PoolProvider,
    dispatch: { sent: boolean },
  ): Promise<Response> {
    const adapter = this.adapter(provider);
    if (!this.accepting)
      return adapter.errorResponse(
        503,
        "Account Pooler is not accepting requests.",
      );
    // The switch and reserve come from the separate advisor-config record. An invalid record
    // answers every advisor request with its error; native routes never read it.
    const advisorConfig = this.options.getAdvisorConfig();
    if (!advisorRouteEnabled(advisorConfig, provider))
      return adapter.errorResponse(
        403,
        advisorConfig.ok
          ? `Account Pooler advisor route for ${provider} is off.`
          : advisorConfig.error,
      );
    // The size cap and model-family parse apply to the bytes as received, so a compressed body is
    // refused before any POST rather than forwarded without its encoding.
    const encoding = request.headers
      .get("content-encoding")
      ?.trim()
      .toLowerCase();
    if (encoding !== undefined && encoding !== "" && encoding !== "identity")
      return adapter.errorResponse(
        415,
        "Advisor request bodies must be uncompressed.",
      );
    // The cap holds before buffering: a declared length over it is refused unread, and a streamed
    // body is read only up to the first chunk past it.
    const declared = Number(request.headers.get("content-length") ?? Number.NaN);
    if (declared > ADVISOR_MAX_BODY_BYTES)
      return adapter.errorResponse(413, "Advisor request body is too large.");
    let body: Uint8Array | null;
    try {
      body = await readBoundedBytes(request.body, ADVISOR_MAX_BODY_BYTES);
    } catch (error) {
      if (!request.signal.aborted) throw error;
      return adapter.errorResponse(499, "Account Pooler request was canceled.");
    }
    if (body === null)
      return adapter.errorResponse(413, "Advisor request body is too large.");
    // /http/advisor/v1/... maps to the vendor's /v1/...; mountedUpstreamUrl alone would keep
    // "advisor/". Like mountedUpstreamUrl, also accept the unmounted /advisor/v1/... path (the SDK
    // test host). BB also accepts the plugin token as ?token=, which must never reach the vendor.
    const url = new URL(request.url);
    url.pathname = url.pathname.replace(/(^|\/http)\/advisor\//u, "$1/");
    url.searchParams.delete("token");
    return this.forwardAdvisor(
      new Request(url, {
        method: request.method,
        headers: request.headers,
        signal: request.signal,
      }),
      body,
      adapter,
      dispatch,
      effectiveAdvisorMaxUtilization(
        advisorConfig,
        this.options.getSettings().switchThreshold,
      ),
    );
  }

  private async forwardAdvisor(
    request: Request,
    body: Uint8Array,
    adapter: ProviderAdapter,
    dispatch: { sent: boolean },
    reserve: number,
  ): Promise<Response> {
    const link = linkSignals([request.signal, this.stopped.signal]);
    const signal = link.signal;
    try {
      const parsed = adapter.parseRequest(body, request.headers);
      const selected = await this.pickIsolatedAccount(
        adapter.provider,
        parsed.family,
        reserve,
      );
      if (selected === null)
        return adapter.errorResponse(
          429,
          "No Account Pooler account is currently eligible for advisor traffic.",
        );
      const changed = await this.options.accounts.recordUsed(
        selected.id,
        this.options.now(),
        "advisor",
      );
      if (changed) this.options.onAccountsChanged();
      let secret: AccountSecret;
      try {
        secret = await abortable(
          this.freshSecret(selected, adapter, { kind: "isolated" }),
          signal,
        );
      } catch {
        signal.throwIfAborted();
        // No markError: credential repair stays with native traffic and the usage loop.
        return adapter.errorResponse(
          503,
          "Account Pooler could not prepare a credential for advisor traffic.",
        );
      }
      let upstream: UpstreamResult;
      dispatch.sent = true;
      const upstreamBody = parsed.forAccount(selected);
      const startedAt = this.options.now();
      const attempt = this.ledgerAttempt(
        {
          kind: "advisor",
          provider: adapter.provider,
          sessionKey: null,
          accountId: selected.id,
          family: parsed.family,
          model: parsed.model,
          body: upstreamBody,
          attribution: advisorAttribution(request.headers),
        },
        startedAt,
      );
      try {
        upstream = await this.fetchUpstream(
          request,
          upstreamBody,
          selected,
          secret,
          adapter,
          startedAt,
          (headers) => advisorRequestHeaders(adapter.provider, headers, secret),
        );
      } catch (error) {
        if (error instanceof UpstreamConnectionError)
          attempt.finish(null, false, null);
        signal.throwIfAborted();
        if (!(error instanceof UpstreamConnectionError)) throw error;
        return adapter.errorResponse(
          502,
          "Account Pooler could not reach " + adapter.upstreamName + ".",
        );
      }
      if (request.signal.aborted) {
        attempt.finish(upstream.response.status, false, null);
        await this.discardUpstream(upstream, false);
        signal.throwIfAborted();
      }
      // The one shared write a vendor response may cause: what it says about the quota.
      this.observeQuota(selected.id, adapter, upstream.response, parsed.family);
      return this.clientResponse(upstream, attempt.tap(upstream.response));
    } catch (error) {
      if (!signal.aborted) throw error;
      return adapter.errorResponse(
        request.signal.aborted ? 499 : 503,
        request.signal.aborted
          ? "Account Pooler request was canceled."
          : "Account Pooler stopped accepting requests.",
      );
    } finally {
      link.dispose();
    }
  }

  // Read-only eligibility for advisor and cache-warming traffic: the same filters as select(), plus
  // OAuth-only (subscription billing) and an isolated reserve,
  // min(configured ?? switchThreshold, switchThreshold). Prefers the provider's current active
  // account. Writes nothing.
  private isolatedEligible(
    account: Account,
    family: ModelFamily,
    reserve: number,
    now: number,
  ): boolean {
    if (!account.enabled || account.kind !== "oauth") return false;
    const quota = this.options.quotas.get(account.id);
    return (
      quota.error === null &&
      (quota.heldUntil === null || quota.heldUntil <= now) &&
      !isSharedQuotaExhausted(quota, reserve, now) &&
      !isQuotaExhausted(quota, family, reserve, now)
    );
  }

  private async pickIsolatedAccount(
    provider: PoolProvider,
    family: ModelFamily,
    reserve: number,
  ): Promise<Account | null> {
    const now = this.options.now();
    const eligible = (await this.options.accounts.list())
      .filter((account) => account.provider === provider)
      .sort((left, right) => left.priority - right.priority)
      .filter((account) =>
        this.isolatedEligible(account, family, reserve, now),
      );
    const active = this.activeAccounts.get(provider)?.accountId;
    return (
      eligible.find((account) => account.id === active) ?? eligible[0] ?? null
    );
  }

  async handle(request: Request, provider: PoolProvider): Promise<Response> {
    const adapter = this.adapter(provider);
    const hostId = await this.authenticate(request);
    if (hostId === null) {
      return adapter.errorResponse(401, "Invalid Account Pooler bearer token.");
    }
    if (!this.accepting)
      return adapter.errorResponse(
        503,
        "Account Pooler is not accepting requests.",
      );
    return this.forward(
      request,
      await readRequestBytes(request),
      adapter,
      hostId,
    );
  }

  async refreshUsage(accountId?: string, force = false): Promise<void> {
    const accounts = (await this.options.accounts.list()).filter(
      (account) =>
        account.enabled &&
        account.kind === "oauth" &&
        (accountId === undefined || account.id === accountId),
    );
    await Promise.all(
      accounts.map((account) => this.refreshAccountUsage(account, force)),
    );
  }

  private async refreshAccountUsage(
    account: Account,
    force: boolean,
  ): Promise<void> {
    const adapter = this.adapter(account.provider);
    if ((this.inFlightByAccount.get(account.id) ?? 0) > 0) return;
    const now = this.options.now();
    const last = this.lastUsageRefreshAt.get(account.id);
    if (
      !force &&
      last !== undefined &&
      now - last < DEFAULT_USAGE_REFRESH_INTERVAL_MS
    )
      return;
    const running = this.usageRefreshes.get(account.id);
    if (running !== undefined) return running;
    this.lastUsageRefreshAt.set(account.id, now);
    const refresh = adapter
      .refreshUsage(this.usageContext(account, adapter))
      .catch(() => undefined)
      .finally(() => this.usageRefreshes.delete(account.id));
    this.usageRefreshes.set(account.id, refresh);
    return refresh;
  }

  private usageContext(account: Account, adapter: ProviderAdapter) {
    return {
      account,
      freshSecret: () => this.freshSecret(account, adapter, { kind: "normal" }),
      accounts: this.options.accounts,
      quotas: this.options.quotas,
      fetch: this.options.fetch,
      now: this.options.now,
    };
  }

  // A usage read that runs even while the account serves, and fails when it fails: a claim must
  // judge from a reading taken now.
  private async readUsageNow(account: Account): Promise<void> {
    await this.usageRefreshes.get(account.id);
    const adapter = this.adapter(account.provider);
    this.lastUsageRefreshAt.set(account.id, this.options.now());
    const read = adapter.refreshUsage(this.usageContext(account, adapter));
    const tracked = read
      .catch(() => undefined)
      .finally(() => {
        if (this.usageRefreshes.get(account.id) === tracked)
          this.usageRefreshes.delete(account.id);
      });
    this.usageRefreshes.set(account.id, tracked);
    await read;
  }

  // Spends one usage reset of the kind on the account: bb pool-local account reset, never on its own.
  async claimReset(accountId: string, kind: ResetKind): Promise<ResetClaimOutcome | null> {
    const account = (await this.options.accounts.list()).find((candidate) => candidate.id === accountId);
    if (account === undefined) return null;
    return (await this.claim(account, { kind }, "manual")).outcome;
  }

  // One claim, as Claude Code makes it: from a status read taken now, with a request id kept until
  // the claim settles, so a resend after an ambiguous answer can only spend the reset once. A read
  // after the claim releases the holds it lifted (quotaFromUsage) and settles an ambiguous answer.
  // Claims on one account run one at a time.
  private claim(account: Account, target: ClaimTarget, trigger: "manual" | "auto"): Promise<ClaimResult> {
    const running = this.resetClaimFlights.get(account.id) ?? Promise.resolve(null);
    const next = running
      .catch(() => null)
      .then(() => this.claimNow(account, target, trigger))
      .finally(() => {
        if (this.resetClaimFlights.get(account.id) === next) this.resetClaimFlights.delete(account.id);
      });
    this.resetClaimFlights.set(account.id, next);
    return next;
  }

  private async claimNow(account: Account, target: ClaimTarget, trigger: "manual" | "auto"): Promise<ClaimResult> {
    const name = account.email ?? account.label;
    const store = this.options.resetClaims;
    const adapter = this.adapter(account.provider);
    // Every refusal before the POST: nothing was sent.
    const refused = (reason: string): ClaimResult => ({ outcome: { status: "refused", reason }, delivery: "not-sent" });
    if (store === null || adapter.claimReset === undefined || account.kind !== "oauth")
      return refused("only Claude subscription (OAuth) accounts hold usage resets");
    const readAt = this.options.now();
    const read = await this.readUsageNow(account).then(
      () => true,
      () => false,
    );
    const resets = this.options.quotas.getResets(account.id);
    if (!read || resets === null || resets.observedAt < readAt)
      return refused(`the usage read of ${name} failed; nothing was sent`);
    const now = this.options.now();
    // Settle the account's earlier unsettled claim first: one per account, as in Claude Code.
    const pending = await store.pending(account.id);
    if (pending === "unreadable")
      return refused(
        `its unsettled-claim record (KV reset-claim:${account.id}) does not parse, and its request id may be the only safe one to resend; nothing was sent, and the record is left as it is`,
      );
    let resend: PendingClaim | null = null;
    if (pending !== null) {
      const listed = resets.grants.find((candidate) => candidate.id === pending.grantId);
      const until = new Date(pending.at + UNSETTLED_HORIZON_MS).toISOString();
      if (listed !== undefined && claimLanded(pending, resets)) {
        await store.clearPending(account.id);
        this.options.logReset(`Account Pooler found its earlier claim of ${pending.grantId} on ${name} used.`, "info");
        // The claim asked for again landed: report it and send nothing. A claim of another grant
        // or kind proceeds.
        if ("kind" in target ? listed.kind === target.kind : listed.id === target.grantId)
          return {
            outcome: {
              status: "answered",
              grantId: listed.id,
              kind: listed.kind,
              result: "reset",
              reason: "an earlier claim with an ambiguous answer was used; nothing new was sent",
              resetsLeft: listed.resetsLeft,
              cleared: listed.clears,
            },
            delivery: "not-sent",
          };
      } else if (now - pending.at < UNSETTLED_HORIZON_MS) {
        if (listed === undefined)
          return refused(
            `grant ${pending.grantId} of an earlier unsettled claim is no longer listed; that claim's state is unknown until ${until}`,
          );
        resend = pending;
      } else {
        await store.clearPending(account.id);
        this.options.logReset(
          `Account Pooler dropped its unsettled claim of ${pending.grantId} on ${name}: ${listed === undefined ? "the grant is no longer listed" : "no read showed it used"} within ${UNSETTLED_HORIZON_MS / 60_000} minutes.`,
          "info",
        );
      }
    }
    const chosen = "kind" in target ? pickGrant(resets, target.kind, now) : autoUseGrant(resets, target.grantId, this.options.quotas.get(account.id), now);
    if ("refused" in chosen) return refused(chosen.refused);
    const { grant } = chosen;
    // The last check before an automatic POST: a claim by hand that landed meanwhile (on this
    // account during this read, or on another) leaves nothing to spend. One POSTing at this same
    // instant elsewhere cannot be seen, and stays possible.
    if (trigger === "auto") {
      const serving = await this.servingClaudeAccount();
      if (serving !== undefined)
        return {
          outcome: { status: "refused", reason: `${serving.email ?? serving.label} can serve now` },
          delivery: "pool-serves",
        };
    }
    // A new claim on another grant could double-spend if the earlier one landed after all.
    if (resend !== null && resend.grantId !== grant.id)
      return refused(
        `an earlier claim of ${resend.grantId} on ${name} is unsettled; claim it again to resend it, or wait until ${new Date(resend.at + UNSETTLED_HORIZON_MS).toISOString()}`,
      );
    // A resend keeps its request id and baseline; its time moves, so the horizon counts from the
    // last send.
    const claim: PendingClaim = resend === null
      ? { grantId: grant.id, requestId: newRequestId(), resetsLeftBefore: grant.resetsLeft, at: now }
      : { ...resend, at: now };
    await store.setPending(account.id, claim);
    // An automatic claim marks the wall before it is sent: a reload during the send or the read
    // after it must not spend a second flagged grant at the same wall.
    if (trigger === "auto") await store.setWallClaimed(true);
    const answer: ClaimAnswer = await adapter
      .claimReset(this.usageContext(account, adapter), claim)
      .catch((error: unknown) => ({ kind: "ambiguous" as const, reason: errorMessage(error) }));
    if (answer.kind === "unsent") {
      if (resend === null) await store.clearPending(account.id);
      else await store.setPending(account.id, resend);
      if (trigger === "auto") await store.setWallClaimed(false);
      return refused(`${answer.reason}; nothing was sent`);
    }
    if (answer.kind === "answered") await store.clearPending(account.id);
    const reread = await this.readUsageNow(account).then(
      () => true,
      () => false,
    );
    this.options.onAccountsChanged();
    const after = reread ? this.options.quotas.getResets(account.id) : null;
    // A rejection (a duplicate request id after a send that landed, say) or an ambiguous answer
    // settles as used when the read shows it.
    const settled = answer.kind !== "answered" && after !== null && claimLanded(claim, after);
    if (settled || answer.kind === "rejected") await store.clearPending(account.id);
    const left = after?.grants.find((candidate) => candidate.id === grant.id)?.resetsLeft ?? null;
    const outcome: ResetClaimOutcome =
      answer.kind === "answered"
        ? {
            status: "answered",
            grantId: grant.id,
            kind: grant.kind,
            result: answer.result,
            reason: answer.reason,
            resetsLeft: answer.resetsLeft ?? left,
            cleared: answer.cleared,
          }
        : settled
          ? {
              status: "answered",
              grantId: grant.id,
              kind: grant.kind,
              result: "reset",
              reason: `the claim got ${answer.reason}, and a status read shows the reset used`,
              resetsLeft: left,
              cleared: grant.clears,
              }
          : answer.kind === "rejected"
            ? { status: "refused", reason: `the server refused the claim of ${grant.id} (${answer.reason})` }
            : {
                status: "unsettled",
                grantId: grant.id,
                kind: grant.kind,
                reason: `the claim got ${answer.reason}; claim again to resend it with the same request id`,
              };
    this.options.logReset(
      `Account Pooler ${trigger} claim of ${grant.kind} reset ${grant.id} on ${name}: ${describeClaimOutcome(outcome)}.`,
      "info",
    );
    return { outcome, delivery: "sent" };
  }

  // At a wall (no Claude account can serve any model), spends one flagged grant, once per wall:
  // only when fresh reads of every Claude account show none freeing up within
  // AUTO_RESET_MIN_WAIT_MS (an unknown free-up never counts as far), no claim is unsettled, and the
  // grant is claimable and blocked by nothing. True when selection should run again: a reset was
  // claimed, or a fresh read shows an account that can serve. Concurrent walled requests share one
  // run; after a decline or a sent claim, walled requests skip the probing for
  // AUTO_RESET_QUIET_MS. Without a flag it does nothing and logs nothing.
  private autoReset(accounts: readonly Account[]): Promise<boolean> {
    this.autoResetFlight ??= this.tryAutoReset(accounts)
      .catch((error: unknown) => {
        this.logAutoReset(`Account Pooler could not auto-claim a usage reset: ${errorMessage(error)}`);
        return false;
      })
      .finally(() => {
        this.autoResetFlight = null;
      });
    return this.autoResetFlight;
  }

  private async tryAutoReset(accounts: readonly Account[]): Promise<boolean> {
    const store = this.options.resetClaims;
    const flags = (await store?.autoUse()) ?? [];
    if (store === null || flags.length === 0) return false;
    const decline = (reason: string) => {
      this.logAutoReset(`Account Pooler does not auto-claim a usage reset: ${reason}.`);
      return false;
    };
    const probed = (reason: string) => {
      this.autoResetQuietUntil = this.options.now() + AUTO_RESET_QUIET_MS;
      return decline(reason);
    };
    const threshold = this.options.getSettings().switchThreshold;
    const claude = accounts.filter((account) => account.provider === "claude" && account.enabled);
    const cachedFreeAt = this.usableTimes(claude, null, this.options.now())[0];
    if (cachedFreeAt !== undefined && cachedFreeAt <= this.options.now())
      return decline("an account can still serve other models");
    if (await store.wallClaimed()) return decline("one was claimed at this wall and no account has served since");
    if (this.options.now() < this.autoResetQuietUntil)
      return decline(`the last decision was less than ${AUTO_RESET_QUIET_MS / 1_000} s ago`);
    // Judged from reads taken now: a cached reading misses a reset claimed by hand elsewhere. An
    // account in error is judged before any read.
    const oauth = claude.filter((account) => account.kind === "oauth");
    const broken = oauth.find((account) => this.options.quotas.get(account.id).error !== null);
    if (broken !== undefined) return probed(`${broken.email ?? broken.label} is in error`);
    const readAt = this.options.now();
    const failed = (
      await Promise.all(oauth.map((account) => this.readUsageNow(account).then(() => null, () => account)))
    ).find((account) => account !== null);
    if (failed !== undefined) return probed(`the usage read of ${failed.email ?? failed.label} failed`);
    // The reads take seconds: judge and claim from the accounts and flags as they are now, so a
    // flag cleared or an account added meanwhile counts.
    const current = (await this.options.accounts.list()).filter(
      (account) => account.provider === "claude" && account.enabled,
    );
    const currentOauth = current.filter((account) => account.kind === "oauth");
    const currentFlags = await store.autoUse();
    if (currentFlags.length === 0) return probed("no grant is flagged any more");
    // A read that answered 200 with a payload the parse rejects stores nothing. The reset reading
    // dates the read: a vendor response landing meanwhile moves the quota's observedAt too.
    const stale = currentOauth.find(
      (account) => (this.options.quotas.getResets(account.id)?.observedAt ?? -Infinity) < readAt,
    );
    if (stale !== undefined) return probed(`the usage read of ${stale.email ?? stale.label} returned no usage reading`);
    const now = this.options.now();
    let freeAt = Number.POSITIVE_INFINITY;
    for (const account of current) {
      const quota = this.options.quotas.get(account.id);
      const name = account.email ?? account.label;
      if (quota.error !== null) {
        if (account.kind === "oauth") return probed(`${name} is in error`);
        continue;
      }
      const at = usableAt(quota, null, threshold, now);
      if (at === null) return probed(`${name} is at a limit with no known free-up time`);
      if (at <= now) {
        this.logAutoReset(`Account Pooler does not auto-claim a usage reset: a fresh read shows ${name} can serve.`);
        return true;
      }
      freeAt = Math.min(freeAt, at);
    }
    if (freeAt - now <= AUTO_RESET_MIN_WAIT_MS)
      return probed(`an account frees up on its own at ${new Date(freeAt).toISOString()}, within an hour`);
    // An unsettled claim anywhere could still land; one past the horizon is taken as never applied
    // (claimNow drops it at that account's next claim).
    for (const { accountId, claim } of await store.allPending()) {
      const owner = current.find((account) => account.id === accountId);
      const name = owner === undefined ? accountId : (owner.email ?? owner.label);
      if (claim === "unreadable") return probed(`the unsettled-claim record of ${name} does not parse`);
      if (now - claim.at < UNSETTLED_HORIZON_MS)
        return probed(
          `an earlier claim of ${claim.grantId} on ${name} is unsettled until ${new Date(claim.at + UNSETTLED_HORIZON_MS).toISOString()}`,
        );
    }
    const declined: string[] = [];
    for (const account of currentOauth) {
      for (const flag of currentFlags.filter((candidate) => candidate.accountId === account.id)) {
        // Re-judged before each flag from the live quotas: a claim by hand that landed during the
        // probe or the previous flag's claim frees an account, and then nothing is spent.
        const serving = await this.servingClaudeAccount();
        if (serving !== undefined) {
          this.logAutoReset(`Account Pooler does not auto-claim a usage reset: ${serving.email ?? serving.label} can serve now.`);
          return true;
        }
        const { outcome, delivery } = await this.claim(account, { grantId: flag.grantId }, "auto");
        if (delivery === "pool-serves") {
          this.logAutoReset(`Account Pooler does not auto-claim a usage reset: ${outcome.status === "refused" ? outcome.reason : "an account can serve now"}.`);
          return true;
        }
        // A reset, sent now or an earlier claim a read shows used, is this wall's success: select
        // again. An unsent one was spent by hand, so the wall is not marked for it.
        if (outcome.status === "answered" && outcome.result === "reset") {
          this.autoResetQuietUntil = this.options.now() + AUTO_RESET_QUIET_MS;
          return true;
        }
        // A sent claim is this wall's one, whatever the wall record says by now (a served response
        // may have cleared it meanwhile). One answered otherwise ("not_limited", say) leaves
        // re-read quotas that may serve: select once more. Unsettled or refused after the send:
        // the request waits.
        if (delivery === "sent") {
          this.autoResetQuietUntil = this.options.now() + AUTO_RESET_QUIET_MS;
          return outcome.status === "answered";
        }
        declined.push(`${account.email ?? account.label} ${flag.grantId}: ${outcome.status === "refused" ? outcome.reason : outcome.status}`);
      }
    }
    return probed(
      declined.length === 0 ? "no flagged grant is on an enabled Claude account" : `no flagged grant is usable (${declined.join("; ")})`,
    );
  }

  // An enabled Claude account that can serve some model now, by its live quota; undefined when none.
  private async servingClaudeAccount(): Promise<Account | undefined> {
    const now = this.options.now();
    const threshold = this.options.getSettings().switchThreshold;
    return (await this.options.accounts.list()).find((account) => {
      if (account.provider !== "claude" || !account.enabled) return false;
      const quota = this.options.quotas.get(account.id);
      if (quota.error !== null) return false;
      const at = usableAt(quota, null, threshold, now);
      return at !== null && at <= now;
    });
  }

  // Declines repeat on every request at a wall; each distinct one is logged once in a row.
  private logAutoReset(message: string): void {
    if (message === this.lastAutoResetLog) return;
    this.lastAutoResetLog = message;
    this.options.logReset(message, "debug");
  }

  async stop(): Promise<void> {
    this.accepting = false;
    this.stopped.abort(new Error("Account Pooler stopped accepting requests."));
    if (this.inFlightCount() === 0) return;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      new Promise<void>((resolve) => this.drainWaiters.add(resolve)),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, this.options.drainTimeoutMs);
      }),
    ]);
    if (timeout !== null) clearTimeout(timeout);
    if (this.inFlightCount() === 0) return;
    for (const controller of this.activeControllers.keys()) {
      controller.abort(
        new Error(
          "Account Pooler stopped before the upstream response completed.",
        ),
      );
    }
  }

  // The start of the oldest upstream request still open, or null: no request that started before
  // it can still add a ledger row. A stalled stream ends at the transport's body timeout.
  openSince(): number | null {
    let oldest: number | null = null;
    for (const startedAt of this.activeControllers.values())
      if (oldest === null || startedAt < oldest) oldest = startedAt;
    return oldest;
  }

  async status(): Promise<Omit<PoolStatus, "routing">> {
    const settings = this.options.getSettings();
    const now = this.options.now();
    const accounts = (await this.options.accounts.list()).sort(
      (left, right) => left.priority - right.priority,
    );
    const autoUse = (await this.options.resetClaims?.autoUse()) ?? [];
    return {
      route: ROUTE,
      enabledAccountCount: accounts.filter((account) => account.enabled).length,
      inFlight: this.inFlightCount(),
      accepting: this.accepting,
      hosts: await this.options.hubTokens.list(),
      accounts: accounts.map((account) => {
        const quota = this.options.quotas.get(account.id);
        const { accountId: _accountId, ...quotaFields } = quota;
        const status = accountStatus(account, quota, settings.switchThreshold, now);
        return {
          ...account,
          lastUsedHostName: null,
          ...quotaFields,
          inFlight: this.inFlightByAccount.get(account.id) ?? 0,
          status,
          active: this.activeAccounts.get(account.provider)?.accountId === account.id,
          availableAt:
            status === "held" || status === "exhausted"
              ? futureOrNull(usableAt(quota, null, settings.switchThreshold, now), now)
              : null,
          resets: this.options.quotas.getResets(account.id),
          autoUseGrantIds: autoUse
            .filter((flag) => flag.accountId === account.id)
            .map((flag) => flag.grantId),
        };
      }),
    };
  }

  private async forward(
    request: Request,
    body: Uint8Array,
    adapter: ProviderAdapter,
    hostId: string,
  ): Promise<Response> {
    const parsed = adapter.parseRequest(body, request.headers);
    const response = await this.route(request, adapter, hostId, parsed);
    const sessionId = sessionIdOf(parsed.affinityId);
    if (response.status === 429 && sessionId !== null)
      this.noteSessionRejection(adapter.provider, sessionId, response);
    // After the note, which keeps the full wait for the turn's retry.
    const limit = adapter.retryAfterLimitSeconds;
    const retryAfter = response.headers.get("retry-after");
    if (
      limit !== null &&
      retryAfter !== null &&
      retryAfterMilliseconds(retryAfter, this.options.now()) > limit * 1_000
    )
      response.headers.set("retry-after", String(limit));
    return response;
  }

  // When the hub last told a session to come back after a 429, kept briefly so a retry of the turn
  // that failed on it waits as long (sessionRetryAt). That time can be later than the next eligible
  // account: a session pinned to a held account waits for that account.
  private noteSessionRejection(
    provider: PoolProvider,
    sessionId: string,
    response: Response,
  ): void {
    const now = this.options.now();
    const key = JSON.stringify([provider, sessionId]);
    this.sessionRejections.delete(key);
    this.sessionRejections.set(key, {
      answeredAt: now,
      retryAt:
        now + retryAfterMilliseconds(response.headers.get("retry-after"), now),
    });
    while (this.sessionRejections.size > MAX_SESSION_REJECTIONS) {
      const oldest = this.sessionRejections.keys().next();
      if (!oldest.done) this.sessionRejections.delete(oldest.value);
    }
  }

  // The time the hub's latest 429 to this session named, if it answered one in the last
  // SESSION_REJECTION_TTL_MS; null otherwise.
  sessionRetryAt(provider: PoolProvider, sessionId: string): number | null {
    const rejection = this.sessionRejections.get(
      JSON.stringify([provider, sessionId]),
    );
    return rejection !== undefined &&
      this.options.now() - rejection.answeredAt <= SESSION_REJECTION_TTL_MS
      ? rejection.retryAt
      : null;
  }

  private async route(
    request: Request,
    adapter: ProviderAdapter,
    hostId: string,
    parsed: ReturnType<ProviderAdapter["parseRequest"]>,
  ): Promise<Response> {
    const attempted = new Set<string>();
    const waited = new Set<string>();
    const routing: RoutingAttempt = {
      binding: null,
      active: null,
      pinnedAccountId: null,
    };
    let previousAccountId: string | null = null;
    let failure: FailureSummary | null = null;
    const accounts = (await this.options.accounts.list()).filter(
      (account) => account.provider === adapter.provider,
    );
    const candidateIds = new Set(accounts.map((account) => account.id));
    const family = parsed.family;
    const affinityKey =
      parsed.affinityId === null
        ? null
        : JSON.stringify([adapter.provider, hostId, parsed.affinityId]);
    const parentAffinityKey =
      affinityKey === null || parsed.parentAffinityId === null
        ? null
        : JSON.stringify([adapter.provider, hostId, parsed.parentAffinityId]);
    const observation = this.observeNative(request, adapter, parsed);
    const ledgerKind = ledgerKindOf(request);
    let respondedToClient = false;
    let autoResetTried = false;
    const link = linkSignals([request.signal, this.stopped.signal]);
    const signal = link.signal;
    try {
      while (attempted.size < candidateIds.size) {
        signal.throwIfAborted();
        const selected = await this.select(
          adapter.provider,
          candidateIds,
          attempted,
          family,
          affinityKey,
          parentAffinityKey,
          previousAccountId,
          routing,
          signal,
        );
        if (selected === null) {
          if (adapter.provider === "claude" && !autoResetTried) {
            autoResetTried = true;
            if (await abortable(this.autoReset(accounts), signal)) continue;
          }
          break;
        }
        let pacing: PacingFlight | null = null;
        const heldMs = (selected.quota.heldUntil ?? 0) - this.options.now();
        let activePacing = this.pacingByAccount.get(selected.account.id);
        if (
          activePacing !== undefined &&
          (activePacing.heldUntil !== selected.quota.heldUntil || heldMs <= 0)
        ) {
          this.releasePacing(selected.account.id, activePacing);
          activePacing = undefined;
        }
        if (heldMs > 0) {
          if (activePacing !== undefined) {
            pacing = activePacing;
            waited.add(selected.account.id);
            await abortable(activePacing.result, signal);
          } else if (
            heldMs > MAX_INLINE_HOLD_MS ||
            waited.has(selected.account.id)
          ) {
            failure = {
              status: 429,
              message:
                "The current Account Pooler account is temporarily rate limited.",
              headers: { "retry-after": String(Math.ceil(heldMs / 1_000)) },
            };
            if (selected.keepAffinity)
              return adapter.errorResponse(
                failure.status,
                failure.message,
                failure.headers,
              );
            attempted.add(selected.account.id);
            previousAccountId = selected.account.id;
            continue;
          } else {
            waited.add(selected.account.id);
            await waitForDelay(heldMs, signal);
            continue;
          }
        }
        previousAccountId = selected.account.id;
        attempted.add(selected.account.id);
        const changed = await this.options.accounts.recordUsed(
          selected.account.id,
          this.options.now(),
          hostId,
        );
        if (changed) this.options.onAccountsChanged();
        let secret: AccountSecret;
        try {
          signal.throwIfAborted();
          secret = await abortable(
            this.freshSecret(selected.account, adapter, { kind: "normal" }),
            signal,
          );
        } catch (error) {
          if (pacing !== null) {
            this.releasePacing(selected.account.id, pacing);
            pacing = null;
          }
          signal.throwIfAborted();
          if (error instanceof TransientOAuthRefreshError) {
            failure = { status: 503, message: error.message, headers: {} };
          } else {
            this.markError(selected.account.id, errorMessage(error));
          }
          continue;
        }
        let authRetried = false;
        let paced = waited.has(selected.account.id);
        const upstreamBody = parsed.forAccount(selected.account);
        while (true) {
          signal.throwIfAborted();
          let upstream: UpstreamResult;
          const attemptStartedAt = this.options.now();
          const attempt = this.ledgerAttempt(
            ledgerKind === null
              ? null
              : {
                  kind: ledgerKind,
                  provider: adapter.provider,
                  sessionKey: parsed.affinityId,
                  accountId: selected.account.id,
                  family,
                  model: parsed.model,
                  body: upstreamBody,
                },
            attemptStartedAt,
          );
          try {
            upstream = await this.fetchUpstream(
              request,
              upstreamBody,
              selected.account,
              secret,
              adapter,
              attemptStartedAt,
            );
          } catch (error) {
            if (error instanceof UpstreamConnectionError)
              attempt.finish(null, false, null);
            if (pacing !== null) {
              this.releasePacing(selected.account.id, pacing);
              pacing = null;
            }
            signal.throwIfAborted();
            if (!(error instanceof UpstreamConnectionError)) throw error;
            failure = {
              status: 502,
              message:
                "Account Pooler could not reach " + adapter.upstreamName + ".",
              headers: {},
            };
            break;
          }
          if (request.signal.aborted) {
            attempt.finish(upstream.response.status, false, null);
            await this.discardUpstream(upstream, false);
            signal.throwIfAborted();
          }
          const { response } = upstream;
          const { quota: observed, quotaRejected } = this.observeQuota(
            selected.account.id,
            adapter,
            response,
            family,
          );
          // A response that is not 2xx carries no usage, and may be retried on another account:
          // its row is written now, whether or not the client sees it.
          if (!response.ok) attempt.finish(response.status, true, null);
          if (pacing !== null && !response.ok) {
            this.releasePacing(selected.account.id, pacing);
            pacing = null;
          }
          if (response.status === 429) {
            if (quotaRejected) {
              await this.discardUpstream(upstream, false);
              break;
            }
            const waitMs = retryAfterMilliseconds(
              response.headers.get("retry-after"),
              this.options.now(),
            );
            const heldUntil = this.options.now() + waitMs;
            this.options.quotas.put({
              ...observed,
              heldUntil,
            });
            if (!paced && waitMs <= MAX_INLINE_HOLD_MS) {
              paced = true;
              pacing = {
                heldUntil,
                result: waitForDelay(waitMs, this.stopped.signal),
              };
              this.pacingByAccount.set(selected.account.id, pacing);
              await this.discardUpstream(upstream, false);
              await abortable(pacing.result, signal);
              continue;
            }
            if (!selected.keepAffinity) {
              failure = {
                status: 429,
                message: await this.discardUpstream(upstream, true),
                headers: { "retry-after": String(Math.ceil(waitMs / 1_000)) },
              };
              break;
            }
          }
          if (
            response.status === 401 ||
            response.status === 403 ||
            response.status === 408 ||
            response.status === 500 ||
            response.status === 502 ||
            response.status === 503 ||
            response.status === 504 ||
            response.status === 529
          ) {
            const retryAfter = response.headers.get("retry-after");
            const detail = await this.discardUpstream(upstream, true);
            signal.throwIfAborted();
            failure = {
              status: response.status,
              message:
                detail ||
                adapter.upstreamName +
                  " returned HTTP " +
                  response.status +
                  ".",
              headers: retryAfter === null ? {} : { "retry-after": retryAfter },
            };
            if (
              response.status === 401 &&
              secret.kind === "oauth" &&
              !authRetried
            ) {
              authRetried = true;
              try {
                secret = await abortable(
                  this.freshSecret(selected.account, adapter, {
                    kind: "rejected",
                    accessToken: secret.accessToken,
                  }),
                  signal,
                );
              } catch (error) {
                signal.throwIfAborted();
                if (error instanceof TransientOAuthRefreshError) {
                  failure = {
                    status: 503,
                    message: error.message,
                    headers: {},
                  };
                } else {
                  await this.markAuthError(
                    selected.account,
                    secret,
                    errorMessage(error),
                    signal,
                  );
                }
                break;
              }
              continue;
            }
            if (response.status === 401 || response.status === 403) {
              await this.markAuthError(
                selected.account,
                secret,
                failure.message,
                signal,
              );
            }
            break;
          }
          if (response.ok) {
            selected.accept();
            // An account served: the wall, if any, is over.
            if (adapter.provider === "claude")
              void this.options.resetClaims?.setWallClaimed(false).catch(() => undefined);
          }
          respondedToClient = true;
          const warmingTap = observation?.responded({
              accountId: selected.account.id,
              url: adapter
                .upstreamUrl(request, this.options.getSettings())
                .toString(),
              body: upstreamBody,
              headers: replayableHeaders(request.headers),
              startedAt: attemptStartedAt,
              status: response.status,
              contentType: response.headers.get("content-type"),
            });
          return this.clientResponse(
            upstream,
            bothTaps(warmingTap, attempt.tap(response)),
          );
        }
      }
      signal.throwIfAborted();
      return failure === null
        ? this.noEligibleResponse(accounts, family, adapter)
        : adapter.errorResponse(
            failure.status,
            failure.message,
            failure.headers,
          );
    } catch (error) {
      if (!signal.aborted) throw error;
      return adapter.errorResponse(
        request.signal.aborted ? 499 : 503,
        request.signal.aborted
          ? "Account Pooler request was canceled."
          : "Account Pooler stopped accepting requests.",
      );
    } finally {
      link.dispose();
      if (!respondedToClient) observation?.abandon();
    }
  }

  // Native Claude Messages requests are reported to the cache warmer; count_tokens and Codex
  // traffic are not, because they neither read nor write the prompt cache entry it maintains. The
  // session of any native request is linked to its thread, which the usage ledger labels it with.
  private observeNative(
    request: Request,
    adapter: ProviderAdapter,
    parsed: ReturnType<ProviderAdapter["parseRequest"]>,
  ): NativeObservation | null {
    if (this.options.warming === null) return null;
    const sessionId = sessionIdOf(parsed.affinityId);
    if (sessionId !== null) this.options.warming.lookUpSession(sessionId);
    if (
      adapter.provider !== "claude" ||
      !new URL(request.url).pathname.endsWith("/v1/messages")
    )
      return null;
    return this.options.warming.observe({
      sessionId,
      parentSessionId: sessionIdOf(parsed.parentAffinityId),
      family: parsed.family,
    });
  }

  // One max_tokens 0 re-send of a native request, for the cache warmer. It goes to the named
  // account only and never elsewhere; it never retries, holds, marks an error, forces a credential
  // refresh, or touches affinity, the active account, lastUsed or the in-flight count. Like advisor
  // traffic, it may record what the response's quota headers say.
  async keepAlive(
    request: KeepAliveRequest,
    signal: AbortSignal,
  ): Promise<KeepAliveResult> {
    if (!this.accepting)
      return {
        kind: "skipped",
        reason: "Account Pooler is not accepting requests",
      };
    const adapter = this.adapter("claude");
    const account = (await this.options.accounts.list()).find(
      (candidate) => candidate.id === request.accountId,
    );
    if (account === undefined || account.provider !== "claude")
      return { kind: "skipped", reason: "the account no longer exists" };
    const now = this.options.now();
    if (!this.isolatedEligible(account, request.family, request.reserve, now))
      return {
        kind: "skipped",
        reason:
          "the account is not eligible (disabled, not OAuth, error, held, or at the warming reserve)",
      };
    if (this.options.quotas.get(account.id).observedAt === null)
      return { kind: "skipped", reason: "the account's quota is unknown" };
    const link = linkSignals([signal, this.stopped.signal], request.timeoutMs);
    const aborted = link.signal;
    try {
      let secret: AccountSecret;
      try {
        secret = await abortable(
          this.freshSecret(account, adapter, { kind: "isolated" }),
          aborted,
        );
      } catch {
        return {
          kind: "skipped",
          reason: aborted.aborted
            ? "canceled before sending"
            : "no credential is ready without native repair",
        };
      }
      let refused: string | null;
      try {
        refused = await abortable(request.confirm(aborted), aborted);
      } catch {
        return {
          kind: "skipped",
          reason: aborted.aborted
            ? "canceled before sending"
            : "the send-time check failed",
        };
      }
      if (refused !== null) return { kind: "skipped", reason: refused };
      const headers = new Headers(request.headers);
      if (secret.kind === "oauth") {
        headers.set("authorization", `Bearer ${secret.accessToken}`);
        const betas = (headers.get("anthropic-beta") ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value !== "");
        if (!betas.includes(OAUTH_BETA)) betas.push(OAUTH_BETA);
        headers.set("anthropic-beta", betas.join(","));
      } else headers.set("x-api-key", secret.apiKey);
      headers.set("user-agent", WARMING_CLIENT);
      const startedAt = this.options.now();
      let response: Response;
      const ledgerStart: LedgerStart = {
        kind: "refresh",
        provider: "claude",
        sessionKey: `session:${request.sessionId}`,
        accountId: account.id,
        family: request.family,
        body: request.body,
      };
      try {
        response = await this.options.fetch(request.url, {
          method: "POST",
          headers,
          body: fetchBody(request.body),
          signal: aborted,
        });
      } catch {
        // Whether anything reached Anthropic is unknown: the row has no status.
        this.recordRequest(ledgerStart, startedAt, null, false, null);
        return {
          kind: "failed",
          reason: aborted.aborted
            ? "canceled or timed out"
            : "could not reach Anthropic",
          startedAt,
        };
      }
      this.observeQuota(account.id, adapter, response, request.family);
      const text = await readBounded(response, MAX_KEEP_ALIVE_RESPONSE_BYTES);
      let payload: unknown = null;
      try {
        payload = text === null ? null : JSON.parse(text);
      } catch {}
      const object =
        typeof payload === "object" && payload !== null
          ? (payload as Record<string, unknown>)
          : null;
      const usage = cacheUsageFrom(object?.usage);
      this.recordRequest(
        ledgerStart,
        startedAt,
        response.status,
        text !== null,
        usage,
      );
      return {
        kind: "response",
        status: response.status,
        usage,
        outputEmpty: Array.isArray(object?.content)
          ? object.content.length === 0
          : null,
        startedAt,
      };
    } finally {
      link.dispose();
    }
  }

  // One upstream attempt in the usage ledger, recorded exactly once: from its response stream's
  // end (tap), or at once (finish) when it failed to connect, was canceled after it was sent, or
  // is not 2xx. A null start records nothing.
  private ledgerAttempt(start: LedgerStart | null, startedAt: number) {
    let done = start === null || this.options.ledger === null;
    const finish = (
      status: number | null,
      completed: boolean,
      usage: RequestRecord["usage"],
    ) => {
      if (done || start === null) return;
      done = true;
      this.recordRequest(start, startedAt, status, completed, usage);
    };
    const tap = (response: Response): ResponseTap | undefined => {
      if (done || start === null) return undefined;
      const contentType = response.headers.get("content-type");
      const usage =
        start.provider === "claude"
          ? createUsageTap(contentType)
          : createCodexUsageTap();
      // Nothing here may reach the client's stream: a tap that fails records no usage.
      let failed = false;
      return {
        push: (chunk) => {
          if (done || failed) return;
          try {
            usage.push(chunk);
          } catch {
            failed = true;
          }
        },
        finish: (completed) => {
          let read: RequestRecord["usage"] = null;
          try {
            if (!failed && !done) read = usage.usage();
          } catch {}
          finish(response.status, completed, read);
        },
      };
    };
    return { finish, tap };
  }

  private recordRequest(
    start: LedgerStart,
    startedAt: number,
    status: number | null,
    completed: boolean,
    usage: RequestRecord["usage"],
  ): void {
    try {
      this.options.ledger?.request({
        ...start,
        startedAt,
        finishedAt: this.options.now(),
        status,
        completed,
        usage,
      });
    } catch {}
  }

  private async discardUpstream(
    upstream: UpstreamResult,
    readDetail: boolean,
  ): Promise<string> {
    const reader = upstream.response.body?.getReader();
    if (reader === undefined) {
      upstream.controller.abort();
      upstream.release();
      return "";
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<string>((resolve) => {
      timeout = setTimeout(() => resolve(""), FAILURE_DISPOSAL_TIMEOUT_MS);
    });
    let detail = "";
    try {
      if (!readDetail) return detail;
      return await Promise.race([
        (async () => {
          const decoder = new TextDecoder();
          let bytes = 0;
          while (bytes < MAX_FAILURE_DETAIL_BYTES) {
            const chunk = await reader.read();
            if (chunk.done) break;
            const part = chunk.value.subarray(
              0,
              MAX_FAILURE_DETAIL_BYTES - bytes,
            );
            bytes += part.byteLength;
            detail += decoder.decode(part, { stream: true });
          }
          return (detail + decoder.decode()).trim();
        })().catch(() => detail.trim()),
        deadline,
      ]);
    } finally {
      upstream.controller.abort();
      await Promise.race([reader.cancel().catch(() => undefined), deadline]);
      clearTimeout(timeout);
      upstream.release();
    }
  }

  private async markAuthError(
    account: Account,
    rejected: AccountSecret,
    message: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (rejected.kind !== "oauth") {
      this.markError(account.id, message);
      return;
    }
    while (true) {
      signal.throwIfAborted();
      const existing = this.refreshes.get(account.id);
      if (existing !== undefined) {
        await abortable(
          existing.result.then(
            () => undefined,
            () => undefined,
          ),
          signal,
        );
        continue;
      }
      const flight: SecretFlight = {
        kind: "rejection-check",
        result: this.options.accounts
          .readSecret(account.id)
          .then((current) => {
            const backoff = this.refreshBackoffs.get(account.id);
            if (
              !signal.aborted &&
              current.kind === "oauth" &&
              current.accessToken === rejected.accessToken &&
              !(
                backoff?.kind === "rejected" &&
                backoff.accessToken === current.accessToken
              )
            ) {
              this.markError(account.id, message);
            }
          })
          .finally(() => {
            if (this.refreshes.get(account.id) === flight)
              this.refreshes.delete(account.id);
          }),
      };
      this.refreshes.set(account.id, flight);
      await abortable(flight.result, signal);
      return;
    }
  }

  private async select(
    provider: PoolProvider,
    candidateIds: ReadonlySet<string>,
    attempted: ReadonlySet<string>,
    family: ModelFamily,
    affinityKey: string | null,
    parentAffinityKey: string | null,
    previousAccountId: string | null,
    routing: RoutingAttempt,
    signal: AbortSignal,
  ): Promise<SelectedAccount | null> {
    const accounts = (await this.options.accounts.list()).sort(
      (left, right) => left.priority - right.priority,
    );
    signal.throwIfAborted();
    const now = this.options.now();
    const threshold = this.options.getSettings().switchThreshold;
    const available = accounts
      .filter((account) => account.provider === provider && account.enabled)
      .map((account) => ({
        account,
        quota: this.options.quotas.get(account.id),
      }))
      .filter(({ quota }) => quota.error === null)
      .filter(({ quota }) => !isSharedQuotaExhausted(quota, threshold, now));
    const eligible = available.filter(
      ({ quota }) => !isQuotaExhausted(quota, family, threshold, now),
    );
    const unattempted = eligible.filter(
      ({ account }) =>
        candidateIds.has(account.id) && !attempted.has(account.id),
    );
    const candidates = unattempted.filter(
      ({ quota }) => quota.heldUntil === null || quota.heldUntil <= now,
    );
    let binding =
      affinityKey === null ? undefined : this.affinityBindings.get(affinityKey);
    const boundAccountId =
      binding !== undefined &&
      now - binding.lastUsedAt < this.affinityIdleTtlMs()
        ? binding.accountId
        : null;
    const bound =
      boundAccountId !== null
        ? eligible.find(({ account }) => account.id === boundAccountId)
        : undefined;
    let inherited: (typeof candidates)[number] | undefined;
    if (bound === undefined && parentAffinityKey !== null) {
      const parent = this.affinityBindings.get(parentAffinityKey);
      if (
        parent !== undefined &&
        now - parent.lastUsedAt < this.affinityIdleTtlMs()
      ) {
        inherited = unattempted.find(
          ({ account }) => account.id === parent.accountId,
        );
      }
    }
    let active = this.activeAccounts.get(provider);
    const activeAccount = eligible.find(
      ({ account }) => account.id === active?.accountId,
    );
    const anchorId = previousAccountId ?? boundAccountId ?? active?.accountId;
    const anchorIndex = accounts.findIndex(
      (account) => account.id === anchorId,
    );
    const ordered = [
      ...accounts.slice(anchorIndex + 1),
      ...accounts.slice(0, anchorIndex + 1),
    ];
    const next = ordered
      .map((account) =>
        candidates.find((candidate) => candidate.account.id === account.id),
      )
      .find((candidate) => candidate !== undefined);
    const usual =
      bound !== undefined && unattempted.includes(bound)
        ? bound
        : (inherited ??
          (boundAccountId === null &&
          previousAccountId === null &&
          activeAccount !== undefined &&
          unattempted.includes(activeAccount)
            ? activeAccount
            : next) ??
          null);
    // Fable requests go to one account while it can serve them: the one holding a Fable reset
    // whose Fable limit is the most used, so the reset, which gives back half of that use, is worth
    // the most when spent. A detour there never moves the session's pin or the provider's cursor.
    const preferred = family === "fable" ? this.preferredFableAccount(candidates, now) : undefined;
    const detour = preferred !== undefined && preferred !== usual;
    const selected = detour ? preferred : usual;
    if (selected === null) return null;
    if (routing.active === null)
      routing.pinnedAccountId = boundAccountId ?? inherited?.account.id ?? null;
    if (affinityKey !== null && binding === undefined && !detour) {
      binding = { accountId: selected.account.id, lastUsedAt: now };
      this.affinityBindings.set(affinityKey, binding);
    }
    if (binding !== undefined && binding.accountId === selected.account.id) {
      binding.lastUsedAt = now;
      if (affinityKey !== null) {
        this.affinityBindings.delete(affinityKey);
        this.affinityBindings.set(affinityKey, binding);
      }
    }
    while (this.affinityBindings.size > this.options.maxAffinityBindings) {
      const oldest = this.affinityBindings.keys().next();
      if (!oldest.done) {
        this.affinityBindings.delete(oldest.value);
        this.options.affinity.removeBinding(oldest.value);
      }
    }
    if (active === undefined) {
      active = { accountId: (detour ? (usual ?? selected) : selected).account.id };
      this.activeAccounts.set(provider, active);
    }
    routing.binding ??= binding ?? null;
    routing.active ??= active;
    const familyDetour = (accountId: string | null) =>
      available.some(({ account }) => account.id === accountId) &&
      !eligible.some(({ account }) => account.id === accountId);
    const rebind =
      !detour &&
      affinityKey !== null &&
      !familyDetour(boundAccountId) &&
      (bound === undefined ||
        bound.account.id === selected.account.id ||
        (binding === routing.binding && attempted.has(bound.account.id)));
    const advance =
      !detour &&
      !familyDetour(active.accountId) &&
      (activeAccount === undefined ||
        active.accountId === selected.account.id ||
        (active === routing.active && attempted.has(active.accountId)));
    return {
      ...selected,
      keepAffinity: selected.account.id === routing.pinnedAccountId,
      accept: () => {
        if (rebind && this.affinityBindings.get(affinityKey) === binding) {
          const accepted = {
            accountId: selected.account.id,
            lastUsedAt: this.options.now(),
          };
          this.options.affinity.putBinding(affinityKey, accepted);
          this.affinityBindings.delete(affinityKey);
          this.affinityBindings.set(affinityKey, accepted);
        }
        if (advance && this.activeAccounts.get(provider) === active) {
          this.options.affinity.putActiveAccount(provider, selected.account.id);
          this.activeAccounts.set(provider, { accountId: selected.account.id });
        }
      },
    };
  }

  private preferredFableAccount<T extends { account: Account; quota: AccountQuota }>(
    candidates: readonly T[],
    now: number,
  ): T | undefined {
    const fableUse = ({ quota }: T) => quota.familyWeekly.fable?.utilization ?? -1;
    let best: T | undefined;
    for (const candidate of candidates) {
      const resets = this.options.quotas.getResets(candidate.account.id);
      const holds =
        resets?.eligible === true &&
        resets.grants.some((grant) => grant.kind === "fable" && holdsGrant(grant, now));
      if (holds === true && (best === undefined || fableUse(candidate) > fableUse(best))) best = candidate;
    }
    return best;
  }

  private async freshSecret(
    account: Account,
    adapter: ProviderAdapter,
    use: SecretUse,
  ): Promise<AccountSecret> {
    while (true) {
      const existing = this.refreshes.get(account.id);
      if (existing !== undefined) {
        // Native traffic is checking a 401 or running a forced refresh: that repair is not the
        // advisor's to wait for or to finish.
        if (
          use.kind === "isolated" &&
          (existing.kind === "rejection-check" || existing.use.kind === "rejected")
        )
          throw new IsolatedCredentialUnavailable();
        if (existing.kind === "rejection-check") {
          await existing.result;
          continue;
        }
        let secret: AccountSecret;
        try {
          secret = await existing.result;
        } catch (error) {
          const current = this.refreshes.get(account.id);
          if (current !== undefined && current !== existing) continue;
          throw error;
        }
        const current = this.refreshes.get(account.id);
        if (current !== undefined && current !== existing) continue;
        const backoff = this.refreshBackoffs.get(account.id);
        if (
          secret.kind === "oauth" &&
          backoff?.accessToken === secret.accessToken &&
          backoff.kind === "rejected"
        ) {
          if (use.kind === "isolated") throw new IsolatedCredentialUnavailable();
          continue;
        }
        // The joined flight turned into a forced refresh after the advisor joined it.
        if (use.kind === "isolated" && existing.use.kind === "rejected")
          throw new IsolatedCredentialUnavailable();
        if (
          use.kind !== "rejected" ||
          secret.kind !== "oauth" ||
          secret.accessToken !== use.accessToken ||
          (existing.use.kind === "rejected" &&
            existing.use.accessToken === use.accessToken)
        ) {
          return secret;
        }
        continue;
      }
      // Backoffs change only inside a flight, and none is running, so this check holds for the
      // whole advisor flight: it can never compute forceRefresh. A rejected backoff for a stale
      // token also refuses; native's next flight removes it.
      if (
        use.kind === "isolated" &&
        this.refreshBackoffs.get(account.id)?.kind === "rejected"
      )
        throw new IsolatedCredentialUnavailable();
      const flight: Extract<SecretFlight, { kind: "refresh" }> = {
        kind: "refresh",
        use,
        result: this.options.accounts
          .readSecret(account.id)
          .then(async (secret) => {
            let backoff = this.refreshBackoffs.get(account.id);
            if (
              secret.kind !== "oauth" ||
              backoff?.accessToken !== secret.accessToken
            ) {
              this.refreshBackoffs.delete(account.id);
              backoff = undefined;
            }
            const explicitlyRejected =
              secret.kind === "oauth" &&
              use.kind === "rejected" &&
              secret.accessToken === use.accessToken;
            const forceRefresh =
              explicitlyRejected || backoff?.kind === "rejected";
            if (forceRefresh && secret.kind === "oauth") {
              flight.use = {
                kind: "rejected",
                accessToken: secret.accessToken,
              };
            }
            const error = this.options.quotas.get(account.id).error;
            if (error !== null) throw new Error(error);
            if (
              backoff !== undefined &&
              this.options.now() < backoff.retryAt &&
              (!explicitlyRejected || backoff.kind === "rejected")
            ) {
              if (
                !forceRefresh &&
                secret.kind === "oauth" &&
                secret.expiresAt !== null &&
                secret.expiresAt > this.options.now()
              ) {
                return secret;
              }
              throw backoff.error;
            }
            try {
              const result = await adapter.refreshSecret({
                account,
                secret,
                accounts: this.options.accounts,
                quotas: this.options.quotas,
                fetch: this.options.fetch,
                now: this.options.now,
                forceRefresh,
              });
              this.refreshBackoffs.delete(account.id);
              if (result.refreshed) {
                const quota = this.options.quotas.get(account.id);
                this.options.quotas.put({ ...quota, error: null });
              }
              return result.secret;
            } catch (error) {
              if (
                !(error instanceof TransientOAuthRefreshError) ||
                secret.kind !== "oauth"
              ) {
                this.refreshBackoffs.delete(account.id);
                throw error;
              }
              const delayMs = Math.min(
                MAX_REFRESH_BACKOFF_MS,
                Math.max(
                  backoff === undefined ? 1_000 : backoff.delayMs * 2,
                  error.retryAfterMs,
                ),
              );
              this.refreshBackoffs.delete(account.id);
              this.refreshBackoffs.set(account.id, {
                kind: forceRefresh ? "rejected" : "proactive",
                accessToken: secret.accessToken,
                retryAt: this.options.now() + delayMs,
                delayMs,
                error,
              });
              while (this.refreshBackoffs.size > MAX_REFRESH_BACKOFFS) {
                const oldest = this.refreshBackoffs.keys().next();
                if (!oldest.done) this.refreshBackoffs.delete(oldest.value);
              }
              if (
                !forceRefresh &&
                secret.expiresAt !== null &&
                secret.expiresAt > this.options.now()
              ) {
                return secret;
              }
              throw error;
            }
          })
          .finally(() => {
            if (this.refreshes.get(account.id) === flight)
              this.refreshes.delete(account.id);
          }),
      };
      this.refreshes.set(account.id, flight);
      return flight.result;
    }
  }

  private async fetchUpstream(
    request: Request,
    body: Uint8Array,
    account: Account,
    secret: AccountSecret,
    adapter: ProviderAdapter,
    startedAt: number,
    isolatedHeaders?: (headers: Headers) => Headers,
  ): Promise<UpstreamResult> {
    const controller = new AbortController();
    const abortFromRequest = () => controller.abort(request.signal.reason);
    this.activeControllers.set(controller, startedAt);
    this.increment(account.id);
    if (request.signal.aborted) abortFromRequest();
    else
      request.signal.addEventListener("abort", abortFromRequest, {
        once: true,
      });
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      request.signal.removeEventListener("abort", abortFromRequest);
      this.activeControllers.delete(controller);
      this.decrement(account.id);
    };
    try {
      const url = adapter.upstreamUrl(request, this.options.getSettings());
      const headers = adapter.requestHeaders(request.headers, account, secret);
      isolatedHeaders?.(headers);
      const response = await this.options
        .fetch(url, {
          method: request.method,
          headers,
          ...(request.method === "GET" || request.method === "HEAD"
            ? {}
            : { body: fetchBody(body) }),
          signal: controller.signal,
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted)
            this.options.onUpstreamError(adapter.provider, cause);
          throw new UpstreamConnectionError("Upstream connection failed.", {
            cause,
          });
        });
      return { response, controller, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  private clientResponse(
    upstream: UpstreamResult,
    tap?: ResponseTap,
  ): Response {
    const headers = new Headers();
    for (const [name, value] of upstream.response.headers) {
      if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase()))
        headers.append(name, value);
    }
    if (upstream.response.body === null) {
      upstream.release();
      tap?.finish(true);
      return new Response(null, {
        status: upstream.response.status,
        statusText: upstream.response.statusText,
        headers,
      });
    }
    const reader = upstream.response.body.getReader();
    const eventStream =
      upstream.response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase() === "text/event-stream";
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            upstream.release();
            tap?.finish(true);
            controller.close();
          } else {
            tap?.push(chunk.value);
            controller.enqueue(chunk.value);
          }
        } catch (error) {
          upstream.release();
          tap?.finish(false);
          if (!eventStream) {
            controller.error(
              error instanceof Error ? error : new Error(String(error)),
            );
            return;
          }
          controller.enqueue(
            new TextEncoder().encode(
              `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: errorMessage(error) } })}\n\n`,
            ),
          );
          controller.close();
        }
      },
      async cancel() {
        tap?.finish(false);
        upstream.controller.abort();
        await reader.cancel().catch(() => undefined);
        upstream.release();
      },
    });
    return new Response(body, {
      status: upstream.response.status,
      statusText: upstream.response.statusText,
      headers,
    });
  }

  // When an enabled account of the provider can next serve the family: at or before now when one
  // can already, null when none can and no reset is known (no enabled account, or only accounts in
  // error or with an exhausted window of unknown reset).
  async nextEligibleAt(
    provider: PoolProvider,
    family: ModelFamily,
  ): Promise<number | null> {
    const accounts = (await this.options.accounts.list()).filter(
      (account) => account.provider === provider,
    );
    return this.usableTimes(accounts, family, this.options.now())[0] ?? null;
  }

  // When each enabled account without an error can serve the family again, earliest first.
  private usableTimes(
    accounts: readonly Account[],
    family: ModelFamily | null,
    now: number,
  ): number[] {
    const threshold = this.options.getSettings().switchThreshold;
    return accounts
      .filter((account) => account.enabled)
      .flatMap((account) => {
        const quota = this.options.quotas.get(account.id);
        if (quota.error !== null) return [];
        const at = usableAt(quota, family, threshold, now);
        return at === null ? [] : [at];
      })
      .sort((left, right) => left - right);
  }

  private noEligibleResponse(
    accounts: readonly Account[],
    family: ModelFamily,
    adapter: ProviderAdapter,
  ): Response {
    if (!accounts.some((account) => account.enabled)) {
      return adapter.errorResponse(
        503,
        "Account Pooler has no enabled account",
      );
    }
    const now = this.options.now();
    // Accounts that could serve now were tried and failed; the client waits for the next reset.
    const next = this.usableTimes(accounts, family, now).find((at) => at > now);
    const retryAfter = Math.max(
      1,
      Math.ceil(((next ?? now + 1_000) - now) / 1_000),
    );
    return adapter.errorResponse(
      429,
      "No Account Pooler account is currently eligible.",
      { "retry-after": String(retryAfter) },
    );
  }

  // Writes what a vendor response says about the account's quota. A quota 429 its own windows do
  // not hold (Claude's overall verdict, which may come from its untracked 5h window) also takes the
  // whole account out of rotation until the later of its reset and Retry-After, never sooner than
  // a rejection already recorded. The windows hold a tracked one, as they always have. A usage
  // reading taken after the latest such 429 releases it (quotaFromUsage). One that adds to a live
  // hold from another limit names none, so room under the 5-hour and weekly limits alone releases
  // both: weaker than either named hold, accepted because a wrong release costs one 429 and a
  // failover before the hold returns.
  private observeQuota(
    accountId: string,
    adapter: ProviderAdapter,
    response: Response,
    family: ModelFamily,
  ): { quota: AccountQuota; quotaRejected: boolean } {
    const now = this.options.now();
    const observed = adapter.quotaFromHeaders(
      accountId,
      response.headers,
      this.options.quotas.get(accountId),
      family,
      now,
    );
    const rejection =
      response.status === 429
        ? adapter.quotaRejection(response.headers, family)
        : null;
    const quota =
      rejection === null || rejection.tracked
        ? observed
        : {
            ...observed,
            rejectedUntil: Math.max(
              observed.rejectedUntil ?? 0,
              rejection.resetAt ?? 0,
              now +
                retryAfterMilliseconds(response.headers.get("retry-after"), now),
            ),
            rejectedAt: now,
            rejectedLimit:
              (observed.rejectedUntil ?? 0) > now &&
              observed.rejectedLimit !== rejection.limit
                ? null
                : rejection.limit,
          };
    this.options.quotas.put(quota);
    return { quota, quotaRejected: rejection !== null };
  }

  private markError(accountId: string, message: string): void {
    const quota = this.options.quotas.get(accountId);
    this.options.quotas.put({ ...quota, error: message.slice(0, 1_000) });
  }

  private releasePacing(accountId: string, pacing: PacingFlight): void {
    if (this.pacingByAccount.get(accountId) === pacing)
      this.pacingByAccount.delete(accountId);
  }

  private adapter(provider: PoolProvider): ProviderAdapter {
    const adapter = this.options.adapters.get(provider);
    if (adapter === undefined)
      throw new Error(`Missing ${provider} Account Pooler adapter.`);
    return adapter;
  }

  private increment(accountId: string): void {
    this.inFlightByAccount.set(
      accountId,
      (this.inFlightByAccount.get(accountId) ?? 0) + 1,
    );
  }

  private decrement(accountId: string): void {
    const next = Math.max(0, (this.inFlightByAccount.get(accountId) ?? 1) - 1);
    if (next === 0) this.inFlightByAccount.delete(accountId);
    else this.inFlightByAccount.set(accountId, next);
    if (this.inFlightCount() !== 0) return;
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }

  private inFlightCount(): number {
    let total = 0;
    for (const count of this.inFlightByAccount.values()) total += count;
    return total;
  }
}

export function createHub(options: {
  accounts: AccountStore;
  quotas: QuotaStore;
  affinity: PoolAffinityStore;
  hubTokens: HubTokenStore;
  getSettings: () => AccountPoolConfig;
  getAdvisorConfig?: () => AdvisorConfigState;
  fetch?: typeof fetch;
  now?: () => number;
  refreshUrl?: string;
  codexRefreshUrl?: string;
  codexUsageUrl?: string;
  importClaudeCredentials?: () => Promise<ImportedClaudeCredentials>;
  importCodexCredentials?: () => Promise<ImportedCodexCredentials>;
  usageUrl?: string;
  profileUrl?: string;
  drainTimeoutMs?: number;
  maxAffinityBindings?: number;
  onAccountsChanged?: () => void;
  onUpstreamError?: (provider: PoolProvider, error: unknown) => void;
  warming?: WarmingHooks;
  ledger?: LedgerHooks;
  resetClaims?: ResetClaimStore;
  resetUrl?: (organizationUuid: string) => string;
  logReset?: (message: string, level: "info" | "debug") => void;
}): AccountPoolHub {
  const adapters: ReadonlyMap<PoolProvider, ProviderAdapter> = new Map([
    [
      "claude",
      createClaudeAdapter({
        refreshUrl: options.refreshUrl ?? DEFAULT_REFRESH_URL,
        usageUrl: options.usageUrl ?? DEFAULT_USAGE_URL,
        profileUrl: options.profileUrl ?? DEFAULT_PROFILE_URL,
        resetUrl: options.resetUrl,
        importCredentials: options.importClaudeCredentials,
      }),
    ],
    [
      "codex",
      createCodexAdapter({
        refreshUrl: options.codexRefreshUrl ?? DEFAULT_CODEX_REFRESH_URL,
        usageUrl: options.codexUsageUrl ?? DEFAULT_CODEX_USAGE_URL,
        importCredentials: options.importCodexCredentials,
        now: options.now,
      }),
    ],
  ]);
  return new AccountPoolHub({
    accounts: options.accounts,
    quotas: options.quotas,
    affinity: options.affinity,
    maxAffinityBindings: options.maxAffinityBindings ?? MAX_AFFINITY_BINDINGS,
    hubTokens: options.hubTokens,
    getSettings: options.getSettings,
    // Off unless the plugin passes its loaded advisor-config: a hub without one never forwards
    // advisor traffic.
    getAdvisorConfig:
      options.getAdvisorConfig ??
      (() => ({
        ok: true,
        config: { routes: { claude: false, codex: false }, maxUtilization: null },
      })),
    adapters,
    fetch: options.fetch ?? fetch,
    now: options.now ?? Date.now,
    drainTimeoutMs: options.drainTimeoutMs ?? 60_000,
    onAccountsChanged: options.onAccountsChanged ?? (() => {}),
    onUpstreamError: options.onUpstreamError ?? (() => {}),
    warming: options.warming ?? null,
    ledger: options.ledger ?? null,
    resetClaims: options.resetClaims ?? null,
    logReset: options.logReset ?? (() => {}),
  });
}

function readBearer(value: string | null): string | null {
  if (value === null) return null;
  return /^Bearer\s+(.+)$/iu.exec(value)?.[1] ?? null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitForDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    timeout.unref();
    const abort = () => {
      clearTimeout(timeout);
      resolve();
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

// Advisor routes carry no client identity. Only these caller headers reach the vendor; the
// adapter's credential headers stay. The Pooler names the client itself, so no caller can present
// Claude Code or Codex CLI identity. Claude: claude-code-* beta values are dropped and the OAuth
// beta is merged for OAuth secrets only. Codex: session_id is no identity but the prompt-cache
// routing key; without it a caller's repeated prefix is never served from cache (W216, W220).
const ADVISOR_CALLER_HEADERS: Record<PoolProvider, ReadonlySet<string>> = {
  claude: new Set([
    "accept",
    "content-type",
    "anthropic-version",
    "anthropic-beta",
  ]),
  codex: new Set(["accept", "content-type", "session_id"]),
};
const CREDENTIAL_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "chatgpt-account-id",
]);
const ADVISOR_CLIENT = "bb-advisor";
// Who an advisor caller says its request is for. They are not in ADVISOR_CALLER_HEADERS, so they
// never reach the vendor; the usage ledger keeps them (ledger.ts RequestAttribution).
const MAX_ATTRIBUTION_CHARS = 128;

export function advisorAttribution(headers: Headers): RequestAttribution | null {
  const read = (name: string) => {
    // Printable ASCII only: the values end up in reports and database rows.
    const value = headers.get(name)?.trim() ?? "";
    return value !== "" && value.length <= MAX_ATTRIBUTION_CHARS && /^[\x20-\x7e]+$/u.test(value)
      ? value
      : null;
  };
  const attribution = {
    initiative: read("x-bb-initiative"),
    threadId: read("x-bb-thread"),
    purpose: read("x-bb-purpose"),
  };
  return Object.values(attribution).some((value) => value !== null) ? attribution : null;
}
const WARMING_CLIENT = "bb-account-pool-warming";
// A keep-alive replays the native request's protocol headers, so the vendor renders the same
// prompt (anthropic-beta selects features that change it), and nothing else: no credential, no
// client identity, no SDK telemetry.
const REPLAYABLE_HEADERS = new Set(["accept", "content-type"]);

export function replayableHeaders(inbound: Headers): Headers {
  const headers = new Headers();
  for (const [name, value] of inbound) {
    const normalized = name.toLowerCase();
    if (
      REPLAYABLE_HEADERS.has(normalized) ||
      normalized.startsWith("anthropic-")
    )
      headers.append(normalized, value);
  }
  return headers;
}

// Model requests go to the usage ledger; token counting and model lists do not.
function futureOrNull(at: number | null, now: number): number | null {
  return at !== null && at > now ? at : null;
}

function ledgerKindOf(request: Request): RequestKind | null {
  if (request.method !== "POST") return null;
  return new URL(request.url).pathname.endsWith("/count_tokens")
    ? null
    : "native";
}

function bothTaps(
  first: ResponseTap | undefined,
  second: ResponseTap | undefined,
): ResponseTap | undefined {
  if (first === undefined || second === undefined) return first ?? second;
  return {
    push: (chunk) => {
      first.push(chunk);
      second.push(chunk);
    },
    finish: (completed) => {
      first.finish(completed);
      second.finish(completed);
    },
  };
}

// The request parsers name a session "session:<id>" (Claude: metadata.user_id; Codex: thread-id).
function sessionIdOf(affinityId: string | null): string | null {
  return affinityId?.startsWith("session:") ? affinityId.slice(8) : null;
}

async function readBounded(
  response: Response,
  limit: number,
): Promise<string | null> {
  if (response.body === null) return null;
  try {
    const body = await readBoundedBytes(response.body, limit);
    return body === null ? null : new TextDecoder().decode(body);
  } catch {
    return null;
  }
}

// The request body, copied into one buffer chunk by chunk as it arrives. Request.arrayBuffer()
// would instead copy a multi-MB body in a single event-loop turn at the end. The buffer is sized
// from content-length when it is declared, and doubles when a chunk does not fit. JSON strings
// are checked chunk by chunk too, so the parse that follows need not check them in one turn.
async function readRequestBytes(request: Request): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (reader === undefined) return new Uint8Array(0);
  const declared = Number(request.headers.get("content-length"));
  let buffer = new Uint8Array(
    Number.isSafeInteger(declared) &&
      declared > 0 &&
      declared <= MAX_PREALLOCATED_BODY_BYTES
      ? declared
      : 64 * 1024,
  );
  let length = 0;
  const strings = new StringCheck();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    strings.push(chunk.value);
    if (length + chunk.value.byteLength > buffer.byteLength) {
      const grown = new Uint8Array(
        Math.max(buffer.byteLength * 2, length + chunk.value.byteLength),
      );
      grown.set(buffer.subarray(0, length));
      buffer = grown;
    }
    buffer.set(chunk.value, length);
    length += chunk.value.byteLength;
  }
  const body = buffer.subarray(0, length);
  strings.finish(body);
  return body;
}

// The body as an ArrayBuffer for fetch, which copies it anyway: a body that fills its own buffer
// (the usual case) is passed without another copy.
function fetchBody(body: Uint8Array): ArrayBuffer {
  if (
    body.buffer instanceof ArrayBuffer &&
    body.byteOffset === 0 &&
    body.byteLength === body.buffer.byteLength
  )
    return body.buffer;
  const copy = new ArrayBuffer(body.byteLength);
  new Uint8Array(copy).set(body);
  return copy;
}

// Reads a body of at most limit bytes. Past the limit it stops, cancels the stream and returns
// null; a stream error is thrown. A missing body is empty.
async function readBoundedBytes(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array | null> {
  const reader = stream?.getReader();
  if (reader === undefined) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) return null;
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function advisorRequestHeaders(
  provider: PoolProvider,
  headers: Headers,
  secret: AccountSecret,
): Headers {
  for (const name of [...headers.keys()]) {
    if (
      !ADVISOR_CALLER_HEADERS[provider].has(name) &&
      !CREDENTIAL_HEADERS.has(name)
    )
      headers.delete(name);
  }
  headers.set("user-agent", ADVISOR_CLIENT);
  if (provider === "codex") {
    headers.set("originator", ADVISOR_CLIENT);
    return headers;
  }
  const values = (headers.get("anthropic-beta") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(
      (value) =>
        value !== "" && !value.toLowerCase().startsWith("claude-code-"),
    );
  if (secret.kind === "oauth" && !values.includes(OAUTH_BETA))
    values.push(OAUTH_BETA);
  if (values.length === 0) headers.delete("anthropic-beta");
  else headers.set("anthropic-beta", values.join(","));
  return headers;
}
