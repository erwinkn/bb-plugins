// OAuth 2.1 for one MCP server, per the MCP authorization spec. The SDK's
// `auth()` does the protocol work: protected-resource metadata (RFC 9728)
// from the 401, authorization-server metadata (RFC 8414 / OIDC), PKCE,
// resource indicators (RFC 8707), dynamic client registration (RFC 7591) or
// a client ID metadata document, issuer checks (RFC 9207, SEP-2352) and
// refresh. This file is the provider it reads and writes through, in two
// roles that never share in-flight state:
//
//   interactive  started by the user (Connect / Re-authorize). Registers the
//                client if needed and returns the authorization URL; the
//                redirect (or a pasted URL) finishes it.
//   background   behind the MCP transport. Hands out the access token and
//                refreshes it; when only the user can fix things it reports
//                "needs authorization" instead of starting a flow, so it can
//                never overwrite the verifier of one the user is in.

import { randomBytes } from "node:crypto";
import {
  auth,
  extractWWWAuthenticateParams,
  type AuthProvider,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import type { ServerConfig, Store, OAuthSecrets } from "./store";

export const CALLBACK_PATH = "/oauth/callback";
/** An authorization the user has not finished within this window is dropped. */
export const PENDING_TTL_MS = 30 * 60_000;
/** Refresh this long before the stated expiry (at most; see token()). */
const EXPIRY_MARGIN_MS = 60_000;
/** A refresh that has not finished by then is abandoned. */
const REFRESH_TIMEOUT_MS = 30_000;
const CLIENT_NAME = "BB";

export class NeedsAuthorizationError extends Error {
  constructor(message = "This server needs authorization: open Settings → Plugins → MCP servers and click Connect.") {
    super(message);
    this.name = "NeedsAuthorizationError";
  }
}

/** The user reset this server's authorization while the operation ran; its result is discarded. */
export class StaleAuthorizationError extends Error {
  constructor() {
    super("The authorization was reset while this operation ran. Click Connect again.");
    this.name = "StaleAuthorizationError";
  }
}

type Mode = "interactive" | "background";

/** The flow an interactive operation belongs to: fixed when it starts. */
interface Flow {
  state: string;
  codeVerifier?: string;
}

/** The OAuthClientProvider `auth()` talks to. One instance per operation. */
class Provider implements OAuthClientProvider {
  authorizationUrl: URL | null = null;
  private memoryVerifier: string | null = null;
  private readonly epoch: number;

  /** Background only: the refresh token this refresh started from. */
  private readonly refreshingFrom: string | undefined;

  constructor(
    private readonly store: Store,
    private readonly server: ServerConfig,
    private readonly mode: Mode,
    private readonly redirectUri: string,
    private readonly flow: Flow | null,
    /** The epoch when the operation was submitted, not when it ran. */
    epoch: number,
  ) {
    this.epoch = epoch;
    const tokens = this.oauth.tokens as StoredOAuthTokens | undefined;
    this.refreshingFrom = mode === "background" ? tokens?.refresh_token : undefined;
  }

  private get oauth(): OAuthSecrets {
    return this.store.secretsFor(this.server.id).oauth ?? {};
  }

  /** Every write checks the epoch: a reset since this operation began wins. */
  private patch(update: (current: OAuthSecrets) => OAuthSecrets): void {
    if (this.store.epoch(this.server.id) !== this.epoch || !this.store.get(this.server.id)) throw new StaleAuthorizationError();
    this.store.updateSecrets(this.server.id, (secrets) => ({ ...secrets, oauth: update(secrets.oauth ?? {}) }));
  }

  private get config() {
    return this.server.auth.kind === "oauth" ? this.server.auth : null;
  }

  get redirectUrl(): string {
    return this.redirectUri;
  }

  get clientMetadataUrl(): string | undefined {
    return this.config?.clientMetadataUrl || undefined;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: CLIENT_NAME,
      redirect_uris: [this.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // A public client with PKCE: what MCP authorization servers support
      // most widely. A server that issues a secret anyway gets it back.
      token_endpoint_auth_method: "none",
      ...(this.config?.scope ? { scope: this.config.scope } : {}),
    };
  }

  state(): string {
    return this.flow?.state ?? randomBytes(16).toString("base64url");
  }

  clientInformation(): StoredOAuthClientInformation | undefined {
    const config = this.config;
    if (config?.clientId) {
      const { clientSecret, clientIssuer } = this.oauth;
      // The issuer stamp binds the client (and its secret) to the first
      // authorization server it was used with; the SDK discards it for
      // any other (SEP-2352), and saveClientInformation refuses the swap.
      return {
        client_id: config.clientId,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
        ...(clientIssuer ? { issuer: clientIssuer } : {}),
      };
    }
    // A registration is only good for the redirect URI it named.
    return this.oauth.clients?.[this.redirectUri] as StoredOAuthClientInformation | undefined;
  }

  saveClientInformation(info: StoredOAuthClientInformation): void {
    const config = this.config;
    if (config?.clientId) {
      if (info.client_id !== config.clientId)
        throw new Error(
          "This server's authorization server is not the one its pre-registered client belongs to. Edit the server to confirm the client ID (or clear it to register automatically).",
        );
      const issuer = typeof info.issuer === "string" ? info.issuer : undefined;
      const bound = this.oauth.clientIssuer;
      if (bound && issuer && bound !== issuer) throw new Error("The pre-registered client belongs to another authorization server.");
      if (issuer && !bound) this.patch((oauth) => ({ ...oauth, clientIssuer: issuer }));
      return;
    }
    if (this.mode === "background") throw new NeedsAuthorizationError();
    this.patch((oauth) => ({ ...oauth, clients: { ...oauth.clients, [this.redirectUri]: { ...info } } }));
  }

  tokens(): StoredOAuthTokens | undefined {
    return this.oauth.tokens as StoredOAuthTokens | undefined;
  }

  saveTokens(tokens: StoredOAuthTokens): void {
    this.patch((oauth) => ({ ...oauth, tokens: { ...tokens }, tokensSavedAt: Date.now(), tokensRedirectUri: this.redirectUri }));
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.patch((oauth) => ({ ...oauth, discovery: JSON.parse(JSON.stringify(state)) }));
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.oauth.discovery as OAuthDiscoveryState | undefined;
  }

  redirectToAuthorization(url: URL): void {
    if (this.mode === "background") throw new NeedsAuthorizationError();
    this.authorizationUrl = url;
  }

  saveCodeVerifier(verifier: string): void {
    this.memoryVerifier = verifier;
  }

  codeVerifier(): string {
    const verifier = this.memoryVerifier ?? this.flow?.codeVerifier;
    if (!verifier) throw new Error("No authorization is in progress for this server.");
    return verifier;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (this.mode === "background" && (scope === "all" || scope === "client")) throw new NeedsAuthorizationError();
    this.patch((oauth) => {
      const next = { ...oauth };
      // A refresh that failed only knows its own tokens are bad: if another
      // refresh replaced them meanwhile, the new ones stay.
      const ownTokens =
        this.mode !== "background" || (oauth.tokens as StoredOAuthTokens | undefined)?.refresh_token === this.refreshingFrom;
      if ((scope === "all" || scope === "tokens") && ownTokens) {
        delete next.tokens;
        delete next.tokensSavedAt;
        delete next.tokensRedirectUri;
      }
      if ((scope === "all" || scope === "client") && next.clients) {
        const { [this.redirectUri]: _dropped, ...rest } = next.clients;
        next.clients = rest;
      }
      if (scope === "all" || scope === "discovery") delete next.discovery;
      return next;
    });
  }
}

/** The redirect URI for a BB origin, e.g. https://erwin.getbb.app. */
export function callbackUrl(origin: string, pluginId: string): string {
  return `${new URL(origin).origin}/api/v1/plugins/${pluginId}/http${CALLBACK_PATH}`;
}

/**
 * What an unauthenticated request learns from the server's 401: the
 * protected-resource metadata URL and the scope it asks for, which the spec
 * says to prefer over the well-known locations and advertised scopes.
 */
async function challenge(serverUrl: string, fetchImpl: typeof fetch, signal: AbortSignal) {
  try {
    const response = await fetchImpl(serverUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
      signal,
    });
    await response.body?.cancel().catch(() => {});
    if (response.status !== 401) return {};
    const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
    return { resourceMetadataUrl, scope };
  } catch {
    return {};
  }
}

export interface OAuthDeps {
  store: Store;
  fetchImpl: typeof fetch;
  /** One refresh per server at a time, whichever connection asks (manager-owned). */
  refreshes: Map<string, Promise<void>>;
  /**
   * Per server, the tail of the queue of token-changing operations (refresh,
   * start, finish). They run one at a time, so none can read tokens that
   * another is about to replace, or overwrite what another just wrote.
   */
  locks: Map<string, Promise<unknown>>;
  /** Marks an authorization operation as running, so a self-reload waits for it. */
  busy: <T>(work: Promise<T>) => Promise<T>;
}

/**
 * Run `work` after every token-changing operation already queued for this
 * server. The epoch is taken at submission: if the authorization was reset
 * while the work waited its turn, it is dropped unrun.
 */
function serialized<T>(deps: OAuthDeps, serverId: string, work: (epoch: number) => Promise<T>): Promise<T> {
  const epoch = deps.store.epoch(serverId);
  const previous = deps.locks.get(serverId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => {
      if (deps.store.epoch(serverId) !== epoch) throw new StaleAuthorizationError();
      return work(epoch);
    });
  const tail = next.catch(() => {});
  deps.locks.set(serverId, tail);
  void tail.then(() => {
    if (deps.locks.get(serverId) === tail) deps.locks.delete(serverId);
  });
  return next;
}

/**
 * Start an authorization: returns the URL to open. An explicit Connect is a
 * request for a new login, so stored tokens are not refreshed here
 * (`forceReauthorization`); the background refresh owns that.
 */
export async function startAuthorization(
  deps: OAuthDeps,
  server: ServerConfig,
  redirectUri: string,
  signal: AbortSignal,
): Promise<string | null> {
  return serialized(deps, server.id, (epoch) => startUnlocked(deps, server, redirectUri, signal, epoch));
}

async function startUnlocked(
  deps: OAuthDeps,
  server: ServerConfig,
  redirectUri: string,
  signal: AbortSignal,
  epoch: number,
): Promise<string | null> {
  const state = randomBytes(24).toString("base64url");
  const provider = new Provider(deps.store, server, "interactive", redirectUri, { state }, epoch);
  const hint = await challenge(server.url, deps.fetchImpl, signal);
  const config = server.auth.kind === "oauth" ? server.auth : null;
  const result = await auth(provider, {
    serverUrl: server.url,
    forceReauthorization: true,
    fetchFn: (url, init) => deps.fetchImpl(url, { ...init, signal }),
    ...(hint.resourceMetadataUrl ? { resourceMetadataUrl: hint.resourceMetadataUrl } : {}),
    ...(config?.scope ? { scope: config.scope } : hint.scope ? { scope: hint.scope } : {}),
  });
  if (result === "AUTHORIZED" || !provider.authorizationUrl) return null;
  if (deps.store.epoch(server.id) !== epoch) throw new StaleAuthorizationError();
  const codeVerifier = provider.codeVerifier();
  deps.store.updateSecrets(server.id, (secrets) => ({
    ...secrets,
    oauth: { ...secrets.oauth, pending: { state, codeVerifier, redirectUri, createdAt: Date.now() } },
  }));
  return provider.authorizationUrl.toString();
}

/** The server whose in-progress authorization issued `state`, if still valid. */
export function findPending(store: Store, state: string, now = Date.now()): ServerConfig | undefined {
  if (!state) return undefined;
  return store.list().find((server) => {
    const pending = store.secretsFor(server.id).oauth?.pending;
    return pending !== undefined && pending.state === state && now - pending.createdAt < PENDING_TTL_MS;
  });
}

/**
 * Finish an authorization from the redirect's query parameters. The state
 * must match the one this server's flow issued; it is used once. The flow
 * (state, verifier, redirect URI) is fixed here, so one started meanwhile
 * neither changes this exchange nor is cleared by it.
 */
export async function finishAuthorization(
  deps: OAuthDeps,
  server: ServerConfig,
  params: URLSearchParams,
  signal: AbortSignal,
): Promise<void> {
  const pending = deps.store.secretsFor(server.id).oauth?.pending;
  if (!pending || Date.now() - pending.createdAt >= PENDING_TTL_MS)
    throw new Error("No authorization is in progress for this server (or it expired). Click Connect again.");
  if (params.get("state") !== pending.state) throw new Error("The redirect does not belong to this authorization (state mismatch).");
  const clearPending = () =>
    deps.store.updateSecrets(server.id, (secrets) => {
      if (secrets.oauth?.pending?.state !== pending.state) return secrets;
      const { pending: _pending, ...oauth } = secrets.oauth;
      return { ...secrets, oauth };
    });
  // Used once, whatever happens next.
  clearPending();
  const error = params.get("error");
  if (error) {
    // Never echo error_description: a mix-up attacker controls it.
    throw new Error(`The authorization server refused: ${error.replace(/[^a-z_]/gi, "").slice(0, 64)}.`);
  }
  const code = params.get("code");
  if (!code) throw new Error("The redirect carries no authorization code.");
  await serialized(deps, server.id, async (epoch) => {
    const provider = new Provider(deps.store, server, "interactive", pending.redirectUri, pending, epoch);
    await auth(provider, {
      serverUrl: server.url,
      authorizationCode: code,
      ...(params.has("iss") ? { iss: params.get("iss")! } : {}),
      fetchFn: (url, init) => deps.fetchImpl(url, { ...init, signal }),
    });
  });
}

/**
 * Forget tokens and any flow in progress (Forget tokens, a new URL, new
 * OAuth settings). `keepClient` keeps the client (pre-registered secret and
 * its issuer binding, dynamic registrations): false when the client itself
 * changed. Bumps the epoch, so an operation still running cannot write back.
 */
export function forgetAuthorization(store: Store, serverId: string, options: { keepClient: boolean }): void {
  store.bumpEpoch(serverId);
  store.updateSecrets(serverId, (secrets) => {
    if (!secrets.oauth) return secrets;
    const { clientSecret, clientIssuer, clients } = secrets.oauth;
    const oauth: OAuthSecrets = options.keepClient
      ? {
          ...(clientSecret ? { clientSecret } : {}),
          ...(clientIssuer ? { clientIssuer } : {}),
          ...(clients ? { clients } : {}),
        }
      : {};
    return { ...secrets, oauth };
  });
}

export function hasTokens(store: Store, serverId: string): boolean {
  return Boolean(store.secretsFor(serverId).oauth?.tokens);
}

/**
 * The transport's token source. Hands out the stored access token,
 * refreshing it ahead of its expiry and on a 401; anything a refresh cannot
 * fix surfaces as NeedsAuthorizationError.
 */
export function transportAuth(deps: OAuthDeps, getServer: () => ServerConfig): AuthProvider {
  const refresh = () => {
    const id = getServer().id;
    const running = deps.refreshes.get(id);
    if (running) return running;
    const work = deps.busy(
      serialized(deps, id, async (epoch) => {
        const server = getServer();
        const oauth = deps.store.secretsFor(server.id).oauth;
        const tokens = oauth?.tokens as StoredOAuthTokens | undefined;
        // The client the tokens were issued to is the one that may refresh them.
        const redirectUri = oauth?.tokensRedirectUri;
        if (!tokens?.refresh_token || !redirectUri) throw new NeedsAuthorizationError();
        const provider = new Provider(deps.store, server, "background", redirectUri, null, epoch);
        // A stalled authorization server must not hold every later call.
        const signal = AbortSignal.timeout(REFRESH_TIMEOUT_MS);
        const result = await auth(provider, {
          serverUrl: server.url,
          fetchFn: (url, init) => deps.fetchImpl(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal }),
        });
        if (result !== "AUTHORIZED") throw new NeedsAuthorizationError();
      }),
    ).finally(() => {
      if (deps.refreshes.get(id) === work) deps.refreshes.delete(id);
    });
    deps.refreshes.set(id, work);
    return work;
  };
  const current = () => deps.store.secretsFor(getServer().id).oauth;
  return {
    async token() {
      const oauth = current();
      const tokens = oauth?.tokens as StoredOAuthTokens | undefined;
      if (!tokens?.access_token) return undefined;
      const expiresIn = typeof tokens.expires_in === "number" ? tokens.expires_in : undefined;
      if (expiresIn !== undefined && oauth?.tokensSavedAt !== undefined && tokens.refresh_token) {
        // Refresh a little before expiry: a minute, or a quarter of a
        // short-lived token's life, so a fresh token is never refreshed.
        const lifetimeMs = expiresIn * 1000;
        const expiresAt = oauth.tokensSavedAt + lifetimeMs;
        if (Date.now() >= expiresAt - Math.min(EXPIRY_MARGIN_MS, lifetimeMs / 4)) {
          await refresh().catch(() => {});
          return (current()?.tokens as StoredOAuthTokens | undefined)?.access_token;
        }
      }
      return tokens.access_token;
    },
    async onUnauthorized() {
      try {
        await refresh();
      } catch (error) {
        throw error instanceof StaleAuthorizationError ? new NeedsAuthorizationError() : error;
      }
    },
  };
}
