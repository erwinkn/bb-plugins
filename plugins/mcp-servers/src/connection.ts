// One live MCP client per server, built on the official SDK (v2):
//
//   - Streamable HTTP with era negotiation (`versionNegotiation: auto`): the
//     2026-07-28 `server/discover` probe, falling back to the 2025
//     `initialize` handshake. Every connect probes afresh: connects are rare
//     (a client lives until it drops), and a cached verdict would also
//     freeze the server's discovery data (instructions) until it expired.
//   - The legacy HTTP+SSE transport (2024-11-05) when Streamable HTTP is
//     refused outright (404/405) or the server is known to speak only SSE.
//   - `tools/list_changed` in both eras (legacy notifications, 2026
//     `subscriptions/listen`), through the SDK's `listChanged` option.
//   - An expired session or a dropped connection rebuilds the client. A call
//     is retried on the new one only when it provably never ran: a 404 to a
//     request that carried an `mcp-session-id` (the spec's "session
//     terminated" answer), or no transport at all.

import {
  Client,
  SSEClientTransport,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type AuthProvider,
  type Tool,
  type Transport,
} from "@modelcontextprotocol/client";
import { NeedsAuthorizationError, transportAuth, type OAuthDeps } from "./oauth";
import type { CachedTool, ServerCache, ServerConfig, Store } from "./store";
import type { McpCallResult } from "./results";

export const CLIENT_INFO = { name: "bb-mcp-servers", version: "0.1.0" };
export const CONNECT_TIMEOUT_MS = 20_000;
export const CALL_TIMEOUT_MS = 5 * 60_000;

export type ConnectionState = "idle" | "connecting" | "connected" | "needs-auth" | "error";

export interface ConnectionEvents {
  /** The state or its error changed. */
  onState(state: ConnectionState, error: string | null): void;
  /** A fresh description of the server: on connect and on list_changed. */
  onSnapshot(cache: ServerCache): void;
}

/** Error text before redaction (manager.ts redacts and bounds it). */
function errorText(error: unknown): string {
  if (error instanceof NeedsAuthorizationError) return error.message;
  if (error instanceof UnauthorizedError) return new NeedsAuthorizationError().message;
  if (error instanceof SdkHttpError) return `HTTP ${error.status}${error.statusText ? ` ${error.statusText}` : ""}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/** The SDK's only signal that a Streamable HTTP notification stream gave up. */
function streamGaveUp(error: Error): boolean {
  return /^Maximum reconnection attempts \(\d+\) exceeded/.test(error.message);
}

export function isAuthError(error: unknown): boolean {
  if (error instanceof NeedsAuthorizationError || error instanceof UnauthorizedError) return true;
  if (error instanceof SdkHttpError) return error.status === 401;
  return false;
}

/** A 401 that only the user can fix by changing the server's settings. */
export function unauthorizedText(auth: "none" | "header"): string {
  return auth === "header"
    ? "The server refused the header (401 Unauthorized). Check its name and value."
    : "The server requires authentication (401 Unauthorized). Edit it and choose Header or OAuth.";
}

/** Statuses that mean "this URL does not speak Streamable HTTP" (2024-11-05 servers). */
function refusesStreamable(error: unknown): boolean {
  if (!(error instanceof SdkHttpError)) return false;
  return error.status === 404 || error.status === 405 || error.status === 400;
}

/** A 404 to a request that carried a session ID: the session is gone and nothing ran. */
function sessionExpired(error: unknown, sentSessionId: string | undefined): boolean {
  return sentSessionId !== undefined && error instanceof SdkHttpError && error.status === 404;
}

/** The client had no open transport, so the request was never sent. */
function notConnected(error: unknown): boolean {
  return error instanceof SdkError && error.code === SdkErrorCode.NotConnected;
}

export function toCachedTool(tool: Tool): CachedTool {
  return {
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema as Record<string, unknown>,
    ...(tool.annotations ? { annotations: tool.annotations as Record<string, unknown> } : {}),
  };
}

export class ServerConnection {
  private client: Client | null = null;
  private transportOf = new WeakMap<Client, Transport>();
  /** Clients whose subscription stream the server ended. */
  private ended = new WeakSet<Client>();
  private connecting: Promise<Client> | null = null;
  private state: ConnectionState = "idle";
  private closed = false;
  private generation = 0;
  private readonly auth: AuthProvider | undefined;

  constructor(
    private readonly getServer: () => ServerConfig,
    private readonly store: Store,
    private readonly deps: OAuthDeps,
    private readonly events: ConnectionEvents,
  ) {
    this.auth = getServer().auth.kind === "oauth" ? transportAuth(deps, getServer) : undefined;
  }

  get currentState(): ConnectionState {
    return this.state;
  }

  private setState(state: ConnectionState, error: string | null = null): void {
    this.state = state;
    this.events.onState(state, error);
  }

  private headers(): Record<string, string> {
    const server = this.getServer();
    if (server.auth.kind !== "header") return {};
    const value = this.store.secretsFor(server.id).headerValue;
    return value ? { [server.auth.headerName]: value } : {};
  }

  private transport(kind: ServerCache["transport"]): Transport {
    const url = new URL(this.getServer().url);
    const requestInit = { headers: this.headers() };
    const fetchImpl = this.deps.fetchImpl;
    if (kind === "sse")
      return new SSEClientTransport(url, {
        requestInit,
        fetch: fetchImpl,
        ...(this.auth ? { authProvider: this.auth } : {}),
      });
    return new StreamableHTTPClientTransport(url, {
      requestInit,
      fetch: fetchImpl,
      ...(this.auth ? { authProvider: this.auth } : {}),
    });
  }

  private newClient(generation: number): Client {
    return new Client(CLIENT_INFO, {
      versionNegotiation: { mode: "auto", probe: { timeoutMs: CONNECT_TIMEOUT_MS } },
      listChanged: {
        tools: {
          onChanged: (error, tools) => {
            if (generation !== this.generation || this.closed) return;
            if (error || !tools) {
              void this.refresh().catch(() => {});
              return;
            }
            this.snapshot(this.client, tools);
          },
        },
      },
    });
  }

  private snapshot(client: Client | null, tools: Tool[], transport?: ServerCache["transport"]): void {
    if (!client) return;
    const previous = this.getServer().cache;
    const version = client.getServerVersion();
    const instructions = client.getInstructions();
    const protocolVersion = client.getNegotiatedProtocolVersion();
    this.events.onSnapshot({
      ...(version?.name ? { serverName: version.name } : {}),
      ...(version?.version ? { serverVersion: version.version } : {}),
      ...(protocolVersion ? { protocolVersion } : {}),
      transport: transport ?? previous?.transport ?? "streamable-http",
      ...(instructions ? { instructions } : {}),
      tools: tools.map(toCachedTool),
      fetchedAt: Date.now(),
    });
  }

  private async attempt(generation: number, kind: ServerCache["transport"]): Promise<Client> {
    const client = this.newClient(generation);
    const transport = this.transport(kind);
    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
      const { tools } = await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS, cacheMode: "refresh" });
      const live = () => generation === this.generation && !this.closed;
      client.onclose = () => {
        if (live()) this.dropClient(client);
      };
      // A notification stream that exhausted its retries leaves the client
      // open but deaf to list_changed: start over.
      client.onerror = (error) => {
        if (live() && streamGaveUp(error)) {
          this.dropClient(client);
          void client.close().catch(() => {});
        }
      };
      // On a 2026 connection list_changed arrives on a subscriptions/listen
      // stream; one the server ended (gracefully or not) means start over.
      // Ending before connect() adopts the client fails the attempt (see
      // connect), so the usual backoff runs instead of a dead "connected".
      void client.autoOpenedSubscription?.closed.then((reason) => {
        if (reason === "local" || !live()) return;
        this.ended.add(client);
        this.dropClient(client);
        void client.close().catch(() => {});
      });
      this.transportOf.set(client, transport);
      this.snapshot(client, tools, kind);
      // Let a subscription that already ended report it before adoption.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (this.ended.has(client)) throw new Error("The server ended its notification stream while connecting.");
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }

  private async open(generation: number): Promise<Client> {
    const cache = this.getServer().cache;
    const order: ServerCache["transport"][] = cache?.transport === "sse" ? ["sse", "streamable-http"] : ["streamable-http", "sse"];
    const errors = new Map<ServerCache["transport"], unknown>();
    for (const kind of order) {
      try {
        return await this.attempt(generation, kind);
      } catch (error) {
        if (isAuthError(error)) throw error;
        errors.set(kind, error);
        // Only a refusal of Streamable HTTP itself sends us to SSE.
        if (kind === "streamable-http" && !refusesStreamable(error)) break;
      }
    }
    // A refusal of Streamable HTTP says little; SSE's own failure explains.
    const streamable = errors.get("streamable-http");
    throw errors.has("sse") && (!errors.has("streamable-http") || refusesStreamable(streamable)) ? errors.get("sse") : streamable;
  }

  private dropClient(client: Client): void {
    if (this.client !== client) return;
    this.client = null;
    this.setState("idle");
  }

  /** The live client, connecting first when there is none. */
  async connect(): Promise<Client> {
    if (this.closed) throw new Error("This server was removed or disabled.");
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    const generation = ++this.generation;
    this.setState("connecting");
    this.connecting = this.open(generation)
      .then((client) => {
        if (this.ended.has(client)) throw new Error("The server ended its notification stream while connecting.");
        if (generation !== this.generation || this.closed) {
          void client.close().catch(() => {});
          throw new Error("This server's connection was replaced.");
        }
        this.client = client;
        this.setState("connected");
        return client;
      })
      .catch((error: unknown) => {
        if (generation === this.generation && !this.closed) {
          const auth = this.getServer().auth.kind;
          if (!isAuthError(error)) this.setState("error", errorText(error));
          else if (auth === "oauth") this.setState("needs-auth", errorText(error));
          else this.setState("error", unauthorizedText(auth));
        }
        throw error;
      })
      .finally(() => {
        if (generation === this.generation) this.connecting = null;
      });
    return this.connecting;
  }

  /** Drop the current client (if any) and connect again. */
  async reconnect(): Promise<Client> {
    const old = this.client;
    this.client = null;
    this.connecting = null;
    this.generation += 1;
    await old?.close().catch(() => {});
    return this.connect();
  }

  /** Re-read the tool list (and everything else) by reconnecting. */
  async refresh(): Promise<void> {
    await this.reconnect();
  }

  async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult> {
    const call = (client: Client) =>
      client.callTool(
        { name, arguments: args },
        { signal, timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true, onprogress: () => {} },
      );
    const client = await this.connect();
    const transport = this.transportOf.get(client);
    const sentSessionId = transport instanceof StreamableHTTPClientTransport ? transport.sessionId : undefined;
    try {
      return await call(client);
    } catch (error) {
      if (signal.aborted) throw error;
      if (!sessionExpired(error, sentSessionId) && !notConnected(error)) throw error;
      // Another call may have rebuilt the client already: use that one.
      return await call(this.client === client ? await this.reconnect() : await this.connect());
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.generation += 1;
    const client = this.client;
    this.client = null;
    this.connecting = null;
    await client?.close().catch(() => {});
  }
}

export { errorText };
