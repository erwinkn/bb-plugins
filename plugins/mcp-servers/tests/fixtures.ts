// Local MCP servers for the tests, one per transport era, plus a mock OAuth
// authorization server:
//
//   modernServer       2026-07-28 (server/discover, subscriptions/listen) via
//                      the v2 SDK's createMcpHandler, which also answers
//                      2025 clients statelessly.
//   legacySessionServer 2025 sessionful Streamable HTTP (mcp-session-id,
//                      GET notification stream) via the v1 SDK.
//   sseServer          2024-11-05 HTTP+SSE via the v1 SDK.
//   oauthServer        RFC 9728 + RFC 8414 + DCR + PKCE + refresh, guarding
//                      any of the above with bearer tokens.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createMcpHandler, Server as ModernServer } from "@modelcontextprotocol/server";
import { Server as LegacyServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export interface FixtureTool {
  name: string;
  description?: string;
  title?: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolBehaviour {
  tools: FixtureTool[];
  instructions?: string;
  call?: (name: string, args: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

const echo = (name: string, args: Record<string, unknown>) => ({
  content: [{ type: "text", text: `${name}:${JSON.stringify(args)}` }],
});

type NodeHandler = (req: IncomingMessage, res: ServerResponse) => unknown;

export interface Running {
  url: string;
  origin: string;
  close(): Promise<void>;
  requests: Array<{ method: string; path: string; authorization: string | null }>;
  /** Cut every open connection (streams included) but keep listening. */
  dropConnections(): void;
}

export async function listen(handler: NodeHandler, path = "/mcp"): Promise<Running> {
  const requests: Running["requests"] = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? "", path: req.url ?? "", authorization: req.headers.authorization ?? null });
    Promise.resolve(handler(req, res)).catch((error) => {
      if (!res.headersSent) res.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    url: `${origin}${path}`,
    origin,
    requests,
    dropConnections: () => server.closeAllConnections(),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Node request → fetch Request, fetch Response → node response. */
async function bridge(req: IncomingMessage, res: ServerResponse, handle: (request: Request) => Promise<Response>, origin: string, preread?: Buffer) {
  const method = req.method ?? "GET";
  const data = method === "GET" || method === "HEAD" ? undefined : (preread ?? (await body(req)));
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(key, value);
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  const response = await handle(new Request(`${origin}${req.url}`, { method, headers, body: data ? new Uint8Array(data) : undefined, signal: controller.signal }));
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (!response.body) return void res.end();
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch {
    // client went away
  }
  res.end();
}

// ---- 2026-07-28 ---------------------------------------------------------------

export async function modernServer(
  behaviour: ToolBehaviour,
  auth?: { guard: (req: IncomingMessage) => boolean; issuer: () => string },
  /** Answer a JSON-RPC method with this HTTP status (and body) instead of serving it. */
  intercept?: (rpcMethod: string, req: IncomingMessage) => number | { status: number; body: string } | undefined,
) {
  const state = { ...behaviour };
  const handler = createMcpHandler(() => {
    const server = new ModernServer(
      { name: "modern-fixture", version: "1.0.0" },
      { capabilities: { tools: { listChanged: true } }, ...(state.instructions ? { instructions: state.instructions } : {}) },
    );
    server.setRequestHandler("tools/list", () => ({ tools: state.tools }) as never);
    server.setRequestHandler("tools/call", async (request) => {
      const params = request.params as { name: string; arguments?: Record<string, unknown> };
      return (await (state.call ?? echo)(params.name, params.arguments ?? {})) as never;
    });
    return server;
  });
  let origin = "";
  const running = await listen(async (req, res) => {
    if (auth && req.url?.startsWith("/.well-known/oauth-protected-resource")) {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [auth.issuer()], scopes_supported: ["tools:read"] }),
      );
      return;
    }
    if (auth && !auth.guard(req)) return guardReject(res, origin);
    if (intercept && req.method === "POST") {
      const data = await body(req);
      let rpcMethod = "";
      try {
        rpcMethod = String(JSON.parse(data.toString("utf8")).method ?? "");
      } catch {
        // not JSON-RPC
      }
      const answer = intercept(rpcMethod, req);
      if (answer !== undefined) {
        const { status, body: text } = typeof answer === "number" ? { status: answer, body: "intercepted" } : answer;
        return void res.writeHead(status, { "content-type": "text/plain" }).end(text);
      }
      return bridge(req, res, (request) => handler.fetch(request), origin, data);
    }
    await bridge(req, res, (request) => handler.fetch(request), origin);
  });
  origin = running.origin;
  return {
    ...running,
    setTools(tools: FixtureTool[]) {
      state.tools = tools;
      handler.notify.toolsChanged();
    },
    /** End every open stream (subscriptions/listen included), as a restart would. */
    async endStreams() {
      running.dropConnections();
    },
    async close() {
      await handler.close();
      await running.close();
    },
  };
}

// ---- 2025 sessionful Streamable HTTP ---------------------------------------------

function legacyServerFor(state: ToolBehaviour): LegacyServer {
  const server = new LegacyServer(
    { name: "legacy-fixture", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } }, ...(state.instructions ? { instructions: state.instructions } : {}) },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: state.tools }) as never);
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return (await (state.call ?? echo)(request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>)) as never;
  });
  return server;
}

export async function legacySessionServer(behaviour: ToolBehaviour) {
  const state = { ...behaviour };
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: LegacyServer }>();
  const running = await listen(async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId === "string") {
      const session = sessions.get(sessionId);
      if (!session) {
        res.writeHead(404, { "content-type": "application/json" }).end(
          JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }),
        );
        return;
      }
      await session.transport.handleRequest(req, res);
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const parsed = JSON.parse((await body(req)).toString("utf8"));
    const server = legacyServerFor(state);
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server });
      },
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, parsed);
  });
  return {
    ...running,
    sessions,
    /** Forget every session, as a restarted server would. */
    expireSessions() {
      for (const { server } of sessions.values()) void server.close();
      sessions.clear();
    },
    async setTools(tools: FixtureTool[]) {
      state.tools = tools;
      await Promise.all([...sessions.values()].map(({ server }) => server.sendToolListChanged().catch(() => {})));
    },
  };
}

// ---- 2024-11-05 HTTP+SSE ---------------------------------------------------------

export async function sseServer(behaviour: ToolBehaviour) {
  const state = { ...behaviour };
  const transports = new Map<string, SSEServerTransport>();
  const running = await listen(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && url.pathname === "/sse") {
      const transport = new SSEServerTransport("/messages", res);
      transports.set(transport.sessionId, transport);
      res.on("close", () => transports.delete(transport.sessionId));
      await legacyServerFor(state).connect(transport);
      return;
    }
    if (req.method === "POST" && url.pathname === "/messages") {
      const transport = transports.get(url.searchParams.get("sessionId") ?? "");
      if (!transport) return void res.writeHead(404).end();
      await transport.handlePostMessage(req, res);
      return;
    }
    // Like a 2024 server: no Streamable HTTP here.
    res.writeHead(405).end();
  }, "/sse");
  return running;
}

// ---- OAuth -----------------------------------------------------------------------

function guardReject(res: ServerResponse, origin: string) {
  res
    .writeHead(401, {
      "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="tools:read"`,
      "content-type": "application/json",
    })
    .end(JSON.stringify({ error: "invalid_token" }));
}

export interface OAuthFixture {
  issuer: string;
  /** Bearer check for a resource server. */
  guard: (req: IncomingMessage) => boolean;
  clients: Map<string, { redirect_uris: string[]; token_endpoint_auth_method: string }>;
  tokens: Map<string, { expiresAt: number; resource: string | null }>;
  refreshTokens: Map<string, { clientId: string; resource: string | null }>;
  /** Simulate the user approving: GET the authorization URL, return the redirect. */
  approve(authorizationUrl: string): Promise<URL>;
  /** Expire every access token now. */
  expireAccessTokens(): void;
  close(): Promise<void>;
  tokenRequests: URLSearchParams[];
  accessTokenTtlS: number;
  /** While set, the token endpoint waits for it before answering. */
  tokenGate: Promise<void> | null;
  /** Requests to the token endpoint that carried client credentials. */
  credentialedRequests: number;
}

/** An authorization server; the resource server publishes the metadata pointing here. */
export async function oauthServer(options: { supportsIss?: boolean } = {}): Promise<OAuthFixture> {
  const clients: OAuthFixture["clients"] = new Map();
  const codes = new Map<string, { clientId: string; challenge: string; redirectUri: string; resource: string | null }>();
  const tokens: OAuthFixture["tokens"] = new Map();
  const refreshTokens: OAuthFixture["refreshTokens"] = new Map();
  const tokenRequests: URLSearchParams[] = [];
  let issuer = "";
  const fixture = { accessTokenTtlS: 3600, tokenGate: null, credentialedRequests: 0 } as OAuthFixture;
  const json = (res: ServerResponse, status: number, value: unknown) =>
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
  const issue = (clientId: string, resource: string | null) => {
    const access = randomBytes(16).toString("hex");
    const refresh = randomBytes(16).toString("hex");
    tokens.set(access, { expiresAt: Date.now() + fixture.accessTokenTtlS * 1000, resource });
    refreshTokens.set(refresh, { clientId, resource });
    return { access_token: access, token_type: "Bearer", expires_in: fixture.accessTokenTtlS, refresh_token: refresh, scope: "tools:read" };
  };
  const running = await listen(async (req, res) => {
    const url = new URL(req.url ?? "/", issuer || "http://x");
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
        scopes_supported: ["tools:read", "offline_access"],
        ...(options.supportsIss ? { authorization_response_iss_parameter_supported: true } : {}),
      });
    }
    if (url.pathname === "/register" && req.method === "POST") {
      const metadata = JSON.parse((await body(req)).toString("utf8"));
      const clientId = `client-${randomBytes(4).toString("hex")}`;
      clients.set(clientId, { redirect_uris: metadata.redirect_uris, token_endpoint_auth_method: metadata.token_endpoint_auth_method });
      return json(res, 201, { ...metadata, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) });
    }
    if (url.pathname === "/authorize") {
      const clientId = url.searchParams.get("client_id") ?? "";
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const client = clients.get(clientId);
      if (!client || !client.redirect_uris.includes(redirectUri)) return json(res, 400, { error: "invalid_request" });
      if (url.searchParams.get("code_challenge_method") !== "S256") return json(res, 400, { error: "invalid_request" });
      const code = randomBytes(8).toString("hex");
      codes.set(code, {
        clientId,
        challenge: url.searchParams.get("code_challenge") ?? "",
        redirectUri,
        resource: url.searchParams.get("resource"),
      });
      const target = new URL(redirectUri);
      target.searchParams.set("code", code);
      target.searchParams.set("state", url.searchParams.get("state") ?? "");
      if (options.supportsIss) target.searchParams.set("iss", issuer);
      res.writeHead(302, { location: target.toString() }).end();
      return;
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const params = new URLSearchParams((await body(req)).toString("utf8"));
      tokenRequests.push(params);
      if (req.headers.authorization?.startsWith("Basic ") || params.has("client_secret")) fixture.credentialedRequests += 1;
      if (fixture.tokenGate) await fixture.tokenGate;
      if (params.get("grant_type") === "authorization_code") {
        const code = codes.get(params.get("code") ?? "");
        codes.delete(params.get("code") ?? "");
        if (!code) return json(res, 400, { error: "invalid_grant" });
        const verifier = params.get("code_verifier") ?? "";
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (challenge !== code.challenge || params.get("redirect_uri") !== code.redirectUri)
          return json(res, 400, { error: "invalid_grant" });
        return json(res, 200, issue(code.clientId, code.resource));
      }
      if (params.get("grant_type") === "refresh_token") {
        const refresh = refreshTokens.get(params.get("refresh_token") ?? "");
        if (!refresh) return json(res, 400, { error: "invalid_grant" });
        refreshTokens.delete(params.get("refresh_token") ?? "");
        return json(res, 200, issue(refresh.clientId, refresh.resource));
      }
      return json(res, 400, { error: "unsupported_grant_type" });
    }
    res.writeHead(404).end();
  }, "");
  issuer = running.origin;
  return Object.assign(fixture, {
    issuer,
    clients,
    tokens,
    refreshTokens,
    tokenRequests,
    guard(req: IncomingMessage) {
      const header = req.headers.authorization ?? "";
      const token = tokens.get(header.replace(/^Bearer /, ""));
      return Boolean(token && token.expiresAt > Date.now());
    },
    async approve(authorizationUrl: string) {
      const response = await fetch(authorizationUrl, { redirect: "manual" });
      const location = response.headers.get("location");
      if (response.status !== 302 || !location) throw new Error(`authorize answered ${response.status}`);
      return new URL(location);
    },
    expireAccessTokens() {
      for (const token of tokens.values()) token.expiresAt = 0;
    },
    close: running.close,
  });
}
