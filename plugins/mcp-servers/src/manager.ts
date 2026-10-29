// The servers, their live connections, and what the UI and agents see.
//
// Reads (`list`) answer from memory. Connections are made in the
// background: at start, after an edit, and again with backoff after a
// failure, so status stays current and `list_changed` streams stay open.
// When the tool surface a server serves stops matching the one registered
// at this plugin load, the manager asks for one plugin reload: after a
// short settle, once no tool call is in flight, and at most once per
// RELOAD_MIN_INTERVAL_MS.

import { randomBytes } from "node:crypto";
import type { PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { errorText, isAuthError, ServerConnection, unauthorizedText, type ConnectionState } from "./connection";
import type { AuthInput, ListResult, ServerInput, ServerView } from "./contract";
import {
  type OAuthDeps,
  callbackUrl,
  findPending,
  finishAuthorization,
  forgetAuthorization,
  hasTokens,
  NeedsAuthorizationError,
  PENDING_TTL_MS,
  startAuthorization,
} from "./oauth";
import { suggestPrefix, validPrefix } from "./names";
import { toBbResult } from "./results";
import type { AuthConfig, ServerCache, ServerConfig, Store } from "./store";
import { computeSurface, type Surface } from "./surface";

const RELOAD_SETTLE_MS = 1_500;
const RELOAD_MIN_INTERVAL_MS = 20_000;
/** Give up waiting for in-flight calls after this; they are aborted by the reload. */
const RELOAD_MAX_WAIT_MS = 2 * 60_000;
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 5 * 60_000;
const AUTH_TIMEOUT_MS = 30_000;
const MAX_ERROR_CHARS = 500;
/** A connection up this long counts as healthy: its drop reconnects at once. */
const STABLE_CONNECTION_MS = 30_000;

export interface ManagerDeps {
  store: Store;
  pluginId: string;
  fetchImpl: typeof fetch;
  log: (message: string) => void;
  /** Publish the new list to every open UI. */
  publish: (list: ListResult) => void;
  /** Reload this plugin (fire and forget). */
  requestReload: () => void;
  /** The surface registered at this load, and the names BB actually took. */
  registered: { surface: Surface; names: ReadonlySet<string> };
  now?: () => number;
}

interface Status {
  state: ConnectionState | "disabled";
  error: string | null;
}

export class UserError extends Error {}

function validUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UserError("Enter a full URL, e.g. https://mcp.example.com/mcp.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    throw new UserError("Use an https:// URL (http:// only for localhost).");
  if (url.username || url.password) throw new UserError("Put credentials in the auth settings, not in the URL.");
  if (url.hash) throw new UserError("Remove the #fragment from the URL.");
  return url;
}

function validOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new UserError("Unsupported BB origin.");
  return url.origin;
}

export class Manager {
  private readonly connections = new Map<string, ServerConnection>();
  private readonly status = new Map<string, Status>();
  private readonly retries = new Map<string, { timer: ReturnType<typeof setTimeout>; delay: number }>();
  private readonly connectedAt = new Map<string, number>();
  private inFlight = 0;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private reloadWaitStarted: number | null = null;
  private reloadPending = false;
  private closed = false;
  /** Tool names other plugins own, from the last check. */
  private foreignNames = new Map<string, string>();
  /** Starts at the clock so a later plugin load continues upward. */
  private revision = Date.now();

  /** What the OAuth layer needs: the store, fetch, and this manager's coordination. */
  private readonly oauth: OAuthDeps;

  constructor(private readonly deps: ManagerDeps) {
    this.oauth = {
      store: deps.store,
      fetchImpl: deps.fetchImpl,
      refreshes: new Map(),
      locks: new Map(),
      busy: (work) => this.busy(work),
    };
  }

  /** Count `work` as in flight: a self-reload waits for it. */
  private async busy<T>(work: Promise<T>): Promise<T> {
    this.inFlight += 1;
    try {
      return await work;
    } finally {
      this.inFlight -= 1;
    }
  }

  private get now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  // ---- lifecycle -----------------------------------------------------------

  start(): void {
    for (const server of this.deps.store.list()) if (server.enabled) this.connectInBackground(server.id);
    // A cache edited by an older load (or by hand) may already differ.
    this.checkSurface();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    for (const retry of this.retries.values()) clearTimeout(retry.timer);
    this.retries.clear();
    await Promise.all([...this.connections.values()].map((connection) => connection.close()));
    this.connections.clear();
  }

  /** Names other plugins already registered (from bb.sdk.plugins.list). */
  setForeignToolNames(names: Map<string, string>): void {
    this.foreignNames = names;
    this.changed();
  }

  /**
   * Error text fit for the UI, logs and agents: an error can quote the
   * server's response, and a server can echo the credential it was sent.
   * Every stored secret is masked and the text is bounded.
   */
  safe(text: string): string {
    const out = this.redact(text);
    return out.length > MAX_ERROR_CHARS ? `${out.slice(0, MAX_ERROR_CHARS)}…` : out;
  }

  /** `redact` applied to every string inside a JSON value (keys included). */
  redactDeep<T>(value: T): T {
    const secrets = this.deps.store.allSecretValues().sort((a, b) => b.length - a.length);
    const mask = (text: string) => {
      let out = text;
      for (const secret of secrets) if (out.includes(secret)) out = out.split(secret).join("[redacted]");
      return out;
    };
    const walk = (node: unknown): unknown => {
      if (typeof node === "string") return mask(node);
      // A credential of digits can come back as a number (or inside one).
      if (typeof node === "number" || typeof node === "bigint") {
        const text = String(node);
        return mask(text) === text ? node : "[redacted]";
      }
      if (Array.isArray(node)) return node.map(walk);
      if (node && typeof node === "object")
        return Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([key, child]) => [mask(key), walk(child)]));
      return node;
    };
    return walk(value) as T;
  }

  /** Mask every stored secret in `text` (longest first, so a token inside a header value goes too). */
  redact(text: string): string {
    return this.redactDeep(text);
  }

  // ---- reads ---------------------------------------------------------------

  list(): ListResult {
    const surface = computeSurface(this.deps.store.list());
    const registered = this.deps.registered;
    return {
      revision: this.revision,
      reloadPending: this.reloadPending,
      servers: this.deps.store.list().map((server) => this.view(server, surface, registered.names)),
    };
  }

  private view(server: ServerConfig, surface: Surface, registeredNames: ReadonlySet<string>): ServerView {
    const secrets = this.deps.store.secretsFor(server.id);
    const status = this.status.get(server.id) ?? { state: server.enabled ? "idle" : "disabled", error: null };
    const tools = surface.tools.filter((tool) => tool.serverId === server.id);
    const changes = surface.schemaChanges.get(server.id);
    const cache = server.cache;
    const auth = server.auth;
    return {
      id: server.id,
      name: server.name,
      prefix: server.prefix,
      url: server.url,
      enabled: server.enabled,
      auth: {
        kind: auth.kind,
        headerName: auth.kind === "header" ? auth.headerName : null,
        headerValueSet: Boolean(secrets.headerValue),
        clientId: auth.kind === "oauth" ? (auth.clientId ?? null) : null,
        clientSecretSet: Boolean(secrets.oauth?.clientSecret),
        scope: auth.kind === "oauth" ? (auth.scope ?? null) : null,
        clientMetadataUrl: auth.kind === "oauth" ? (auth.clientMetadataUrl ?? null) : null,
        authorized: hasTokens(this.deps.store, server.id),
        pending: Boolean(secrets.oauth?.pending && this.now - secrets.oauth.pending.createdAt < PENDING_TTL_MS),
      },
      state: server.enabled ? status.state : "disabled",
      error: status.error,
      server: cache
        ? {
            name: cache.serverName ?? null,
            version: cache.serverVersion ?? null,
            protocolVersion: cache.protocolVersion ?? null,
            transport: cache.transport,
            instructionsChars: cache.instructions?.length ?? 0,
            fetchedAt: cache.fetchedAt,
          }
        : null,
      tools: (cache?.tools ?? []).map((tool) => {
        const bb = tools.find((entry) => entry.upstreamName === tool.name);
        return {
          name: bb?.name ?? tool.name,
          upstreamName: tool.name,
          title: tool.title ?? null,
          description: (tool.description ?? "").slice(0, 400),
          schemaChanges: changes?.get(tool.name) ?? [],
        };
      }),
      liveToolCount: this.deps.registered.surface.tools.filter(
        (tool) => tool.serverId === server.id && registeredNames.has(tool.name),
      ).length,
      conflicts: tools.filter((tool) => this.foreignNames.has(tool.name)).map((tool) => tool.name),
    };
  }

  private changed(): void {
    if (this.closed) return;
    this.revision += 1;
    this.deps.publish(this.list());
  }

  // ---- writes --------------------------------------------------------------

  private checkPrefix(prefix: string, exceptId?: string): void {
    if (!validPrefix(prefix)) throw new UserError("Prefix: lowercase letters, digits and dashes, up to 20 characters.");
    if (this.deps.store.list().some((server) => server.prefix === prefix && server.id !== exceptId))
      throw new UserError(`Another server already uses the prefix "${prefix}".`);
    for (const [name, plugin] of this.foreignNames)
      if (name.startsWith(`${prefix}_`)) throw new UserError(`The prefix "${prefix}" would collide with ${name} from the ${plugin} plugin.`);
  }

  private authConfig(input: AuthInput, previous?: AuthConfig): AuthConfig {
    if (input.kind === "none") return { kind: "none" };
    if (input.kind === "header") return { kind: "header", headerName: input.headerName };
    if (input.clientMetadataUrl) {
      const url = validUrl(input.clientMetadataUrl);
      if (url.protocol !== "https:" || url.pathname === "/") throw new UserError("The client metadata URL must be https:// with a path.");
    }
    if (input.clientSecret && !input.clientId && !(previous?.kind === "oauth" && previous.clientId))
      throw new UserError("A client secret needs its client ID.");
    return {
      kind: "oauth",
      ...(input.clientId ? { clientId: input.clientId } : {}),
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.clientMetadataUrl ? { clientMetadataUrl: input.clientMetadataUrl } : {}),
    };
  }

  private saveSecrets(id: string, input: AuthInput): void {
    this.deps.store.updateSecrets(id, (secrets) => {
      const next = { ...secrets };
      if (input.kind === "header") {
        if (input.headerValue !== undefined) next.headerValue = input.headerValue;
      } else {
        delete next.headerValue;
      }
      if (input.kind === "oauth") {
        if (input.clientSecret !== undefined) {
          const oauth = { ...next.oauth };
          if (input.clientSecret) oauth.clientSecret = input.clientSecret;
          else delete oauth.clientSecret;
          next.oauth = oauth;
        }
      } else {
        delete next.oauth;
      }
      return next;
    });
  }

  add(input: ServerInput): { id: string } {
    const url = validUrl(input.url);
    const prefix = input.prefix || suggestPrefix(input.name);
    this.checkPrefix(prefix);
    if (input.auth.kind === "header" && !input.auth.headerValue) throw new UserError("Enter the header value.");
    const server: ServerConfig = {
      id: randomBytes(6).toString("hex"),
      name: input.name,
      prefix,
      url: url.toString(),
      enabled: true,
      auth: this.authConfig(input.auth),
      createdAt: this.now,
    };
    this.deps.store.put(server);
    this.saveSecrets(server.id, input.auth);
    this.deps.log(`added MCP server ${server.name} (${url.origin})`);
    this.connectInBackground(server.id);
    this.changed();
    return { id: server.id };
  }

  update(id: string, input: ServerInput): void {
    const server = this.require(id);
    const url = validUrl(input.url).toString();
    this.checkPrefix(input.prefix, id);
    const auth = this.authConfig(input.auth, server.auth);
    const endpointChanged = url !== server.url;
    const authChanged = JSON.stringify(auth) !== JSON.stringify(server.auth);
    // Tokens are bound to the resource and the client: a new URL or new
    // OAuth settings mean authorizing again. The client (a pre-registered
    // secret and the issuer it is bound to, dynamic registrations) survives
    // unless the client itself changed.
    const sameClient =
      server.auth.kind === "oauth" &&
      auth.kind === "oauth" &&
      server.auth.clientId === auth.clientId &&
      server.auth.clientMetadataUrl === auth.clientMetadataUrl;
    if (endpointChanged || authChanged) forgetAuthorization(this.deps.store, id, { keepClient: sameClient });
    this.deps.store.put({
      ...server,
      name: input.name,
      prefix: input.prefix,
      url,
      auth,
      ...(endpointChanged ? { cache: undefined } : {}),
    });
    this.saveSecrets(id, input.auth);
    this.dropConnection(id);
    if (server.enabled) this.connectInBackground(id);
    this.checkSurface();
    this.changed();
  }

  remove(id: string): void {
    this.require(id);
    this.dropConnection(id);
    this.status.delete(id);
    this.deps.store.remove(id);
    this.checkSurface();
    this.changed();
  }

  setEnabled(id: string, enabled: boolean): void {
    const server = this.require(id);
    if (server.enabled === enabled) return;
    this.deps.store.put({ ...server, enabled });
    if (enabled) this.connectInBackground(id);
    else {
      this.dropConnection(id);
      this.status.set(id, { state: "disabled", error: null });
    }
    this.checkSurface();
    this.changed();
  }

  reconnect(id: string): void {
    const server = this.require(id);
    if (!server.enabled) throw new UserError("Enable the server first.");
    this.dropConnection(id);
    this.connectInBackground(id);
  }

  disconnect(id: string): void {
    this.require(id);
    forgetAuthorization(this.deps.store, id, { keepClient: true });
    this.dropConnection(id);
    this.status.set(id, { state: "needs-auth", error: new NeedsAuthorizationError().message });
    this.changed();
  }

  // ---- OAuth ---------------------------------------------------------------

  async startAuth(id: string, origin: string): Promise<{ authorizationUrl: string | null; redirectUri: string }> {
    const server = this.require(id);
    if (server.auth.kind !== "oauth") throw new UserError("This server does not use OAuth.");
    const redirectUri = callbackUrl(validOrigin(origin), this.deps.pluginId);
    const signal = AbortSignal.timeout(AUTH_TIMEOUT_MS);
    let authorizationUrl: string | null;
    try {
      authorizationUrl = await this.busy(startAuthorization(this.oauth, server, redirectUri, signal));
    } catch (error) {
      const text = this.safe(errorText(error));
      this.deps.log(`authorization of ${server.name} could not start: ${text}`);
      throw new UserError(`Could not start authorization: ${text}`);
    }
    if (authorizationUrl === null && this.require(id).enabled) this.reconnect(id);
    this.changed();
    return { authorizationUrl, redirectUri };
  }

  /** Finish from the redirect's parameters; resolves to the server's name. */
  async finishAuth(params: URLSearchParams, expectedId?: string): Promise<string> {
    const server = findPending(this.deps.store, params.get("state") ?? "", this.now);
    if (!server || (expectedId !== undefined && server.id !== expectedId))
      throw new UserError("This redirect does not match an authorization in progress (or it expired). Click Connect again.");
    try {
      await this.busy(finishAuthorization(this.oauth, server, params, AbortSignal.timeout(AUTH_TIMEOUT_MS)));
    } catch (error) {
      const text = this.safe(errorText(error));
      this.deps.log(`authorization of ${server.name} failed: ${text}`);
      this.changed();
      throw new UserError(text);
    }
    this.deps.log(`authorized MCP server ${server.name}`);
    if (server.enabled) this.reconnect(server.id);
    this.changed();
    return server.name;
  }

  async completeAuth(id: string, redirectedUrl: string): Promise<void> {
    this.require(id);
    let params: URLSearchParams;
    try {
      params = new URL(redirectedUrl.trim()).searchParams;
    } catch {
      throw new UserError("Paste the full address of the page you were sent to.");
    }
    await this.finishAuth(params, id);
  }

  // ---- connections -----------------------------------------------------------

  private require(id: string): ServerConfig {
    const server = this.deps.store.get(id);
    if (!server) throw new UserError("No such server.");
    return server;
  }

  private connection(id: string): ServerConnection {
    let connection = this.connections.get(id);
    if (!connection) {
      // Events from a connection that was since replaced or dropped are stale.
      const current = () => this.connections.get(id) === created;
      const created: ServerConnection = new ServerConnection(() => this.require(id), this.deps.store, this.oauth, {
        onState: (state, error) => {
          if (current()) this.onState(id, state, error);
        },
        onSnapshot: (cache) => {
          if (current()) this.onSnapshot(id, cache);
        },
      });
      connection = created;
      this.connections.set(id, connection);
    }
    return connection;
  }

  private dropConnection(id: string): void {
    const retry = this.retries.get(id);
    if (retry) clearTimeout(retry.timer);
    this.retries.delete(id);
    const connection = this.connections.get(id);
    this.connections.delete(id);
    void connection?.close();
  }

  private connectInBackground(id: string): void {
    if (this.closed) return;
    const server = this.deps.store.get(id);
    if (!server?.enabled) return;
    this.connection(id)
      .connect()
      .catch(() => {
        // onState recorded the failure and scheduled the retry.
      });
  }

  private onState(id: string, state: ConnectionState, error: string | null): void {
    if (this.closed) return;
    this.status.set(id, { state, error: error === null ? null : this.safe(error) });
    if (state === "connected") {
      this.connectedAt.set(id, this.now);
      // The backoff resets when a connection that stayed up drops (below).
    } else if (state === "error" || state === "idle") {
      // idle after connected: the connection dropped (a server restart).
      // Reconnect at once if it had been up a while; a server that drops
      // every connection right away gets the backoff instead.
      const upFor = this.now - (this.connectedAt.get(id) ?? this.now);
      if (state === "idle" && upFor >= STABLE_CONNECTION_MS) this.retries.delete(id);
      this.scheduleRetry(id, state === "idle" && upFor >= STABLE_CONNECTION_MS);
    }
    this.changed();
  }

  private scheduleRetry(id: string, soon: boolean): void {
    const previous = this.retries.get(id);
    if (previous) clearTimeout(previous.timer);
    const delay = soon ? RETRY_MIN_MS / 2 : Math.min(RETRY_MAX_MS, previous ? previous.delay * 2 : RETRY_MIN_MS);
    const timer = setTimeout(() => this.connectInBackground(id), delay);
    timer.unref?.();
    this.retries.set(id, { timer, delay });
  }

  private onSnapshot(id: string, raw: ServerCache): void {
    const server = this.deps.store.get(id);
    if (!server || this.closed) return;
    // Tool metadata is server text too: mask it before it is cached (a
    // 644 file), published, or registered as an agent tool.
    const cache = this.redactDeep(raw);
    const before = JSON.stringify(server.cache ?? null);
    const next = { ...server, cache };
    // fetchedAt changes on every connect; only rewrite the file when
    // something else did, or once a day to keep fetchedAt honest.
    const comparable = (value: ServerCache | undefined) => JSON.stringify(value ? { ...value, fetchedAt: 0 } : null);
    if (comparable(server.cache) !== comparable(cache) || before === "null" || this.now - (server.cache?.fetchedAt ?? 0) > 24 * 60 * 60_000)
      this.deps.store.put(next);
    this.checkSurface();
    this.changed();
  }

  // ---- tool calls ------------------------------------------------------------

  async callTool(serverId: string, upstreamName: string, params: unknown, signal: AbortSignal): Promise<PluginAgentToolResult> {
    const server = this.deps.store.get(serverId);
    const label = server ? `MCP server "${server.name}"` : "MCP server";
    if (!server) return failure(`${label} was removed from BB. Its tools stop appearing in new sessions.`);
    if (!server.enabled) return failure(`${label} is disabled in Settings → Plugins → MCP servers.`);
    const args = params === undefined || params === null ? {} : params;
    if (typeof args !== "object" || Array.isArray(args)) return failure("Tool arguments must be a JSON object.");
    this.inFlight += 1;
    try {
      const raw = await this.connection(serverId).callTool(upstreamName, args as Record<string, unknown>, signal);
      // A server may echo the credential it was sent; agents never see one.
      // Mask the whole result, every field, before anything is cut to size.
      return toBbResult(this.redactDeep(raw));
    } catch (error) {
      if (isAuthError(error)) {
        if (server.auth.kind !== "oauth") return failure(`${label}: ${unauthorizedText(server.auth.kind)} Ask the user to fix it in Settings → Plugins → MCP servers.`);
        this.status.set(serverId, { state: "needs-auth", error: new NeedsAuthorizationError().message });
        this.changed();
        return failure(`${label} needs authorization. Ask the user to open Settings → Plugins → MCP servers and click Connect on "${server.name}".`);
      }
      return failure(`${label}: ${this.safe(errorText(error))}`);
    } finally {
      this.inFlight -= 1;
    }
  }

  // ---- self-reload -----------------------------------------------------------

  private checkSurface(): void {
    const desired = computeSurface(this.deps.store.list());
    const pending = desired.signature !== this.deps.registered.surface.signature;
    if (pending === this.reloadPending) {
      if (pending) this.scheduleReload();
      return;
    }
    this.reloadPending = pending;
    if (pending) this.scheduleReload();
    else if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
      this.reloadWaitStarted = null;
    }
  }

  private scheduleReload(): void {
    if (this.closed || this.reloadTimer) return;
    // The last reload is read from disk: each reload starts a new manager.
    const wait = Math.max(RELOAD_SETTLE_MS, this.deps.store.getLastReloadAt() + RELOAD_MIN_INTERVAL_MS - this.now);
    this.reloadTimer = setTimeout(() => this.tryReload(), wait);
    this.reloadTimer.unref?.();
  }

  private tryReload(): void {
    this.reloadTimer = null;
    if (this.closed || !this.reloadPending) return;
    this.reloadWaitStarted ??= this.now;
    if (this.inFlight > 0 && this.now - this.reloadWaitStarted < RELOAD_MAX_WAIT_MS) {
      this.reloadTimer = setTimeout(() => this.tryReload(), 1_000);
      this.reloadTimer.unref?.();
      return;
    }
    this.deps.store.setLastReloadAt(this.now);
    this.reloadWaitStarted = null;
    this.deps.log("tool surface changed; reloading to register it");
    this.deps.requestReload();
  }
}

function failure(text: string): PluginAgentToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
