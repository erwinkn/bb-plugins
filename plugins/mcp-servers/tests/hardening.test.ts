// Regressions from review round 1: secrets in error text, stale OAuth
// writes, issuer binding of a pre-registered client, unsafe replay, an
// unreadable store, overlapping flows, and the reload cooldown.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Manager } from "../src/manager";
import { Store, StoreReadError } from "../src/store";
import { serverInputSchema } from "../src/schemas";
import { splitText } from "../src/surface";
import { computeSurface } from "../src/surface";
import { listen, modernServer, oauthServer, type FixtureTool } from "./fixtures";

const search: FixtureTool = { name: "search", description: "Search.", inputSchema: { type: "object" } };
const ORIGIN = "https://bb.example.test";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until<T>(read: () => T | undefined | false, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function harness(dir = mkdtempSync(join(tmpdir(), "mcp-servers-hard-"))) {
  const store = new Store(dir);
  const logs: string[] = [];
  const reloads: number[] = [];
  const manager = new Manager({
    store,
    pluginId: "mcp-servers",
    fetchImpl: fetch,
    log: (message) => logs.push(message),
    publish: () => {},
    requestReload: () => reloads.push(Date.now()),
    registered: { surface: computeSurface([]), names: new Set() },
  });
  cleanups.push(() => manager.close(), () => rmSync(dir, { recursive: true, force: true }));
  return { store, manager, logs, reloads, dir };
}

const stateOf = (manager: Manager, id: string) => manager.list().servers.find((server) => server.id === id);

describe("hardening", () => {
  it("never shows a credential the server echoes back in an error or a result", async () => {
    const secret = "sk-live-0123456789abcdef";
    const header = { kind: "header" as const, headerName: "X-Api-Key", headerValue: secret };
    const failing = await modernServer({ tools: [search] }, undefined, (method, req) =>
      method === "tools/call" ? { status: 500, body: `upstream failed for key ${String(req.headers["x-api-key"])}` } : undefined,
    );
    const unreachable = await listen((req, res) => {
      res.writeHead(500, { "content-type": "text/plain" }).end(`upstream failed for ${String(req.headers["x-api-key"])}`);
    });
    const echoing = await modernServer({ tools: [search], call: () => ({ content: [{ type: "text", text: `you sent ${secret}` }] }) });
    cleanups.push(() => failing.close(), () => unreachable.close(), () => echoing.close());
    const { manager, logs } = harness();

    const a = manager.add({ name: "Failing", prefix: "failing", url: failing.url, auth: header });
    await until(() => stateOf(manager, a.id)?.state === "connected");
    const failed = JSON.stringify(await manager.callTool(a.id, "search", {}, AbortSignal.timeout(10_000)));
    expect(failed).toContain("upstream failed for key [redacted]");

    const b = manager.add({ name: "Down", prefix: "down", url: unreachable.url, auth: header });
    await until(() => stateOf(manager, b.id)?.state === "error");
    const down = JSON.stringify(await manager.callTool(b.id, "search", {}, AbortSignal.timeout(10_000)));

    const c = manager.add({ name: "Echo", prefix: "echo", url: echoing.url, auth: header });
    await until(() => stateOf(manager, c.id)?.state === "connected");
    const echoed = JSON.stringify(await manager.callTool(c.id, "search", {}, AbortSignal.timeout(10_000)));
    expect(echoed).toContain("you sent [redacted]");

    for (const text of [failed, down, echoed, JSON.stringify(manager.list()), logs.join("\n")]) expect(text).not.toContain(secret);
  });

  it("does not let a refresh that outlives Forget tokens write them back", async () => {
    const as = await oauthServer();
    const resource = await modernServer({ tools: [search] }, { guard: as.guard, issuer: () => as.issuer });
    cleanups.push(() => as.close(), () => resource.close());
    const { manager, store } = harness();
    const { id } = manager.add({ name: "Secure", prefix: "secure", url: resource.url, auth: { kind: "oauth" } });
    const { authorizationUrl } = await manager.startAuth(id, ORIGIN);
    await manager.finishAuth((await as.approve(authorizationUrl!)).searchParams);
    await until(() => stateOf(manager, id)?.state === "connected");

    let release!: () => void;
    as.tokenGate = new Promise<void>((resolve) => (release = resolve));
    as.expireAccessTokens();
    const call = manager.callTool(id, "search", {}, AbortSignal.timeout(10_000));
    await until(() => as.tokenRequests.some((params) => params.get("grant_type") === "refresh_token"));
    manager.disconnect(id);
    release();
    as.tokenGate = null;
    await call;
    expect(store.secretsFor(id).oauth?.tokens).toBeUndefined();
    expect(stateOf(manager, id)?.auth.authorized).toBe(false);
  });

  it("keeps a pre-registered client's secret bound to its authorization server", async () => {
    const first = await oauthServer();
    const second = await oauthServer();
    let issuer = first.issuer;
    const resource = await modernServer({ tools: [search] }, { guard: (req) => first.guard(req) || second.guard(req), issuer: () => issuer });
    cleanups.push(() => first.close(), () => second.close(), () => resource.close());
    const callback = `${ORIGIN}/api/v1/plugins/mcp-servers/http/oauth/callback`;
    first.clients.set("pre", { redirect_uris: [callback], token_endpoint_auth_method: "client_secret_basic" });
    const { manager } = harness();
    const input = { name: "Secure", prefix: "secure", url: resource.url };
    const { id } = manager.add({ ...input, auth: { kind: "oauth", clientId: "pre", clientSecret: "pre-secret-value" } });
    const { authorizationUrl } = await manager.startAuth(id, ORIGIN);
    await manager.finishAuth((await first.approve(authorizationUrl!)).searchParams);
    expect(first.credentialedRequests).toBe(1);

    // A scope edit keeps the client; then the resource points elsewhere.
    manager.update(id, { ...input, auth: { kind: "oauth", clientId: "pre", scope: "tools:read" } });
    issuer = second.issuer;
    await expect(manager.startAuth(id, ORIGIN)).rejects.toThrow(/pre-registered client/);
    expect(second.credentialedRequests).toBe(0);
    expect(second.tokenRequests).toHaveLength(0);
  });

  it("does not replay a call after a 404 that carried no session", async () => {
    let calls = 0;
    const server = await modernServer({ tools: [search] }, undefined, (method) => {
      if (method !== "tools/call") return undefined;
      calls += 1;
      return 404;
    });
    cleanups.push(() => server.close());
    const { manager } = harness();
    const { id } = manager.add({ name: "Stateless", prefix: "stateless", url: server.url, auth: { kind: "none" } });
    await until(() => stateOf(manager, id)?.state === "connected");
    const result = await manager.callTool(id, "search", {}, AbortSignal.timeout(10_000));
    expect(result).toMatchObject({ isError: true });
    expect(calls).toBe(1);
  });

  it("refuses to start over an unreadable store and leaves the file as it was", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-servers-corrupt-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "secrets.json"), '{"version":1,"servers":{"a":{"headerValue":"sk-secret-xyz"}');
    let error: unknown;
    try {
      new Store(dir);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(StoreReadError);
    expect(String(error)).not.toContain("sk-secret-xyz");
    expect(readFileSync(join(dir, "secrets.json"), "utf8")).toContain("sk-secret-xyz");
  });

  it("lets a finished flow clear only its own pending state", async () => {
    const as = await oauthServer();
    const resource = await modernServer({ tools: [search] }, { guard: as.guard, issuer: () => as.issuer });
    cleanups.push(() => as.close(), () => resource.close());
    const { manager } = harness();
    const { id } = manager.add({ name: "Secure", prefix: "secure", url: resource.url, auth: { kind: "oauth" } });
    const a = await manager.startAuth(id, ORIGIN);
    const redirectA = await as.approve(a.authorizationUrl!);
    let release!: () => void;
    as.tokenGate = new Promise<void>((resolve) => (release = resolve));
    const finishA = manager.finishAuth(redirectA.searchParams).catch((error: Error) => error);
    await until(() => as.tokenRequests.length === 1);
    // B queues behind A's exchange (one token-changing operation at a time).
    const starting = manager.startAuth(id, ORIGIN);
    release();
    as.tokenGate = null;
    await finishA;
    const b = await starting;
    const redirectB = await as.approve(b.authorizationUrl!);
    await expect(manager.finishAuth(redirectB.searchParams)).resolves.toBe("Secure");
  });

  it("keeps the reload cooldown across plugin loads", async () => {
    const server = await modernServer({ tools: [search] });
    cleanups.push(() => server.close());
    const dir = mkdtempSync(join(tmpdir(), "mcp-servers-cooldown-"));
    new Store(dir).setLastReloadAt(Date.now());
    const { manager, reloads } = harness(dir);
    manager.add({ name: "Docs", prefix: "docs", url: server.url, auth: { kind: "none" } });
    await until(() => manager.list().reloadPending);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(reloads).toHaveLength(0);
  });

  it("masks a credential echoed in tool metadata before caching, publishing or registering it", async () => {
    const secret = "sk-meta-0123456789";
    const server = await modernServer({
      tools: [{ name: "leaky", description: `Uses key ${secret}`, inputSchema: { type: "object", properties: { k: { type: "string", default: secret } } } }],
      instructions: `Authenticate with ${secret}.`,
    });
    cleanups.push(() => server.close());
    const { manager, store, dir } = harness();
    const { id } = manager.add({ name: "Leaky", prefix: "leaky", url: server.url, auth: { kind: "header", headerName: "X-Api-Key", headerValue: secret } });
    await until(() => stateOf(manager, id)?.state === "connected");
    const surface = computeSurface(store.list());
    for (const text of [JSON.stringify(manager.list()), readFileSync(join(dir, "servers.json"), "utf8"), JSON.stringify(surface.tools)])
      expect(text).not.toContain(secret);
    expect(surface.tools[0]!.description).toBe("Uses key [redacted]");
  });

  it("masks the forms a credential is sent in, and tokens that were just rotated", () => {
    const { manager, store } = harness();
    const { id } = manager.add({
      name: "Pre",
      prefix: "pre",
      url: "http://127.0.0.1:9/mcp",
      auth: { kind: "oauth", clientId: "client:1", clientSecret: "s3cret/value+x" },
    });
    const basic = Buffer.from(`${encodeURIComponent("client:1")}:${encodeURIComponent("s3cret/value+x")}`).toString("base64");
    expect(manager.safe(`echo Authorization: Basic ${basic}`)).toBe("echo Authorization: Basic [redacted]");
    expect(manager.safe(`secret=${encodeURIComponent("s3cret/value+x")}`)).toBe("secret=[redacted]");

    store.updateSecrets(id, (secrets) => ({ ...secrets, oauth: { ...secrets.oauth, tokens: { access_token: "old-access-token-1", token_type: "Bearer" } } }));
    store.updateSecrets(id, (secrets) => ({ ...secrets, oauth: { ...secrets.oauth, tokens: { access_token: "new-access-token-2", token_type: "Bearer" } } }));
    expect(manager.safe("sent old-access-token-1 and new-access-token-2")).toBe("sent [redacted] and [redacted]");
  });

  it("refuses credentials too short to mask", () => {
    const base = { name: "x", prefix: "x", url: "https://x.example/mcp" };
    expect(serverInputSchema.safeParse({ ...base, auth: { kind: "header", headerName: "X-Key", headerValue: "abc12" } }).success).toBe(false);
    expect(serverInputSchema.safeParse({ ...base, auth: { kind: "oauth", clientId: "c", clientSecret: "short" } }).success).toBe(false);
    expect(serverInputSchema.safeParse({ ...base, auth: { kind: "oauth", clientId: "c", clientSecret: "" } }).success).toBe(true);
  });

  it("runs one refresh per server, so a replaced connection's refresh cannot void the new tokens", async () => {
    const as = await oauthServer();
    const resource = await modernServer({ tools: [search] }, { guard: as.guard, issuer: () => as.issuer });
    cleanups.push(() => as.close(), () => resource.close());
    const { manager, store } = harness();
    const { id } = manager.add({ name: "Secure", prefix: "secure", url: resource.url, auth: { kind: "oauth" } });
    const { authorizationUrl } = await manager.startAuth(id, ORIGIN);
    await manager.finishAuth((await as.approve(authorizationUrl!)).searchParams);
    await until(() => stateOf(manager, id)?.state === "connected");

    let release!: () => void;
    as.tokenGate = new Promise<void>((resolve) => (release = resolve));
    as.expireAccessTokens();
    const first = manager.callTool(id, "search", {}, AbortSignal.timeout(10_000));
    await until(() => as.tokenRequests.some((params) => params.get("grant_type") === "refresh_token"));
    manager.reconnect(id);
    const second = manager.callTool(id, "search", {}, AbortSignal.timeout(10_000));
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    as.tokenGate = null;
    // Reconnect closed the first call's connection: it fails, and is not replayed.
    expect(await first).toMatchObject({ isError: true, content: [{ text: 'MCP server "Secure": Connection closed' }] });
    expect(await second).toMatchObject({ isError: false });
    expect(as.tokenRequests.filter((params) => params.get("grant_type") === "refresh_token")).toHaveLength(1);
    expect(store.secretsFor(id).oauth?.tokens).toBeDefined();
  });

  it("holds a self-reload until a token exchange finishes", async () => {
    const as = await oauthServer();
    const resource = await modernServer({ tools: [search] }, { guard: as.guard, issuer: () => as.issuer });
    const open = await modernServer({ tools: [search] });
    cleanups.push(() => as.close(), () => resource.close(), () => open.close());
    const { manager, reloads } = harness();
    const { id } = manager.add({ name: "Secure", prefix: "secure", url: resource.url, auth: { kind: "oauth" } });
    const { authorizationUrl } = await manager.startAuth(id, ORIGIN);
    const redirect = await as.approve(authorizationUrl!);
    let release!: () => void;
    as.tokenGate = new Promise<void>((resolve) => (release = resolve));
    const finishing = manager.finishAuth(redirect.searchParams);
    manager.add({ name: "Open", prefix: "open", url: open.url, auth: { kind: "none" } });
    await until(() => manager.list().reloadPending);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(reloads).toHaveLength(0);
    release();
    as.tokenGate = null;
    await finishing;
    await until(() => reloads.length === 1, 5_000);
  });
});

describe("round 3", () => {
  async function authorized() {
    const as = await oauthServer();
    const resource = await modernServer({ tools: [search] }, { guard: as.guard, issuer: () => as.issuer });
    cleanups.push(() => as.close(), () => resource.close());
    const h = harness();
    const { id } = h.manager.add({ name: "Secure", prefix: "secure", url: resource.url, auth: { kind: "oauth" } });
    const { authorizationUrl } = await h.manager.startAuth(id, ORIGIN);
    await h.manager.finishAuth((await as.approve(authorizationUrl!)).searchParams);
    await until(() => stateOf(h.manager, id)?.state === "connected");
    return { ...h, as, resource, id };
  }
  const grants = (as: { tokenRequests: URLSearchParams[] }) => as.tokenRequests.map((params) => params.get("grant_type"));

  it("runs a login after a refresh already in flight, never under it", async () => {
    const { as, manager, store, id } = await authorized();
    const { authorizationUrl } = await manager.startAuth(id, ORIGIN);
    const redirect = await as.approve(authorizationUrl!);
    let release!: () => void;
    as.tokenGate = new Promise<void>((resolve) => (release = resolve));
    as.expireAccessTokens();
    const call = manager.callTool(id, "search", {}, AbortSignal.timeout(10_000));
    await until(() => grants(as).includes("refresh_token"));
    const login = manager.finishAuth(redirect.searchParams);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(grants(as)).toEqual(["authorization_code", "refresh_token"]);
    release();
    as.tokenGate = null;
    await call;
    await login;
    expect(grants(as)).toEqual(["authorization_code", "refresh_token", "authorization_code"]);
    // The login's tokens are the ones kept.
    const stored = store.secretsFor(id).oauth?.tokens as { refresh_token: string };
    expect(as.refreshTokens.has(stored.refresh_token)).toBe(true);
  });

  it("does not refresh on an explicit Connect", async () => {
    const { as, manager, id } = await authorized();
    const { authorizationUrl } = await manager.startAuth(id, ORIGIN);
    expect(authorizationUrl).toBeTruthy();
    expect(grants(as)).toEqual(["authorization_code"]);
  });

  it("masks form-encoded and JSON-escaped forms, and short issued tokens", () => {
    const { manager, store } = harness();
    const { id } = manager.add({ name: "H", prefix: "h", url: "http://127.0.0.1:9/mcp", auth: { kind: "oauth", clientId: "c", clientSecret: 's3cr et!"va\\lue' } });
    const secret = 's3cr et!"va\\lue';
    expect(manager.safe(`client_secret=${new URLSearchParams({ v: secret }).toString().slice(2)}`)).toBe("client_secret=[redacted]");
    expect(manager.safe(JSON.stringify({ error: `bad ${secret}` }))).toBe('{"error":"bad [redacted]"}');
    store.updateSecrets(id, (secrets) => ({ ...secrets, oauth: { ...secrets.oauth, tokens: { access_token: "t0k5", token_type: "Bearer" } } }));
    expect(manager.safe("token t0k5")).toBe("token [redacted]");
    const base = { name: "x", prefix: "x", url: "https://x.example/mcp" };
    expect(serverInputSchema.safeParse({ ...base, auth: { kind: "header", headerName: "Authorization", headerValue: "Bearer tiny" } }).success).toBe(false);
    expect(serverInputSchema.safeParse({ ...base, auth: { kind: "header", headerName: "Authorization", headerValue: "Bearer long-enough-1" } }).success).toBe(true);
  });

  it("masks before cutting to size, and refuses image types that carry text", async () => {
    const secret = "sk-boundary-123456789";
    const server = await modernServer({
      tools: [search],
      call: () => ({
        content: [
          { type: "text", text: `${"x".repeat(100 * 1024 - 10)}${secret}` },
          { type: "image", data: "aGk=", mimeType: `image/png; key=${secret}` },
        ],
      }),
    });
    cleanups.push(() => server.close());
    const { manager } = harness();
    const { id } = manager.add({ name: "B", prefix: "b", url: server.url, auth: { kind: "header", headerName: "X-Key", headerValue: secret } });
    await until(() => stateOf(manager, id)?.state === "connected");
    const text = JSON.stringify(await manager.callTool(id, "search", {}, AbortSignal.timeout(10_000)));
    expect(text).not.toContain(secret.slice(0, 12));
    expect(text).toContain("not a plain image MIME type");
  });

  it("reconnects when a 2026 server ends its subscription stream", async () => {
    const server = await modernServer({ tools: [search] });
    cleanups.push(() => server.close());
    const { manager, store } = harness();
    const { id } = manager.add({ name: "Sub", prefix: "sub", url: server.url, auth: { kind: "none" } });
    await until(() => stateOf(manager, id)?.state === "connected");
    const states: string[] = [];
    const watch = setInterval(() => states.push(stateOf(manager, id)!.state), 5);
    await server.endStreams();
    await until(() => states.some((state) => state !== "connected") && stateOf(manager, id)?.state === "connected");
    clearInterval(watch);
    await server.setTools([search, { name: "more", description: "More.", inputSchema: { type: "object" } }]);
    await until(() => store.get(id)?.cache?.tools.length === 2);
  });
});

describe("round 4", () => {
  it("drops OAuth work that was queued before Forget tokens", async () => {
    const as = await oauthServer();
    const resource = await modernServer({ tools: [search] }, { guard: as.guard, issuer: () => as.issuer });
    cleanups.push(() => as.close(), () => resource.close());
    const { manager, store } = harness();
    const { id } = manager.add({ name: "Secure", prefix: "secure", url: resource.url, auth: { kind: "oauth" } });
    const first = await manager.startAuth(id, ORIGIN);
    await manager.finishAuth((await as.approve(first.authorizationUrl!)).searchParams);
    await until(() => stateOf(manager, id)?.state === "connected");
    const pendingA = await manager.startAuth(id, ORIGIN);
    const redirectA = await as.approve(pendingA.authorizationUrl!);

    let release!: () => void;
    as.tokenGate = new Promise<void>((resolve) => (release = resolve));
    as.expireAccessTokens();
    const call = manager.callTool(id, "search", {}, AbortSignal.timeout(10_000));
    await until(() => as.tokenRequests.some((params) => params.get("grant_type") === "refresh_token"));
    const connectB = manager.startAuth(id, ORIGIN).catch((error: Error) => error);
    const callbackA = manager.finishAuth(redirectA.searchParams).catch((error: Error) => error);
    manager.disconnect(id);
    release();
    as.tokenGate = null;
    await call;
    expect(String(await connectB)).toMatch(/reset/);
    expect(String(await callbackA)).toMatch(/reset|does not match/);
    expect(store.secretsFor(id).oauth?.tokens).toBeUndefined();
    expect(store.secretsFor(id).oauth?.discovery).toBeUndefined();
    expect(stateOf(manager, id)?.auth.authorized).toBe(false);
  });

  it("masks twice-escaped secrets and numeric echoes", async () => {
    const server = await modernServer({
      tools: [{ name: "n", description: "N.", inputSchema: { type: "object", properties: { k: { type: "number", default: 12345678 } } } }],
      call: () => ({ content: [], structuredContent: { api_key: 12345678, big: 9912345678 } }),
    });
    cleanups.push(() => server.close());
    const { manager, dir } = harness();
    const { id } = manager.add({ name: "Num", prefix: "num", url: server.url, auth: { kind: "header", headerName: "X-Key", headerValue: "12345678" } });
    await until(() => stateOf(manager, id)?.state === "connected");
    const text = JSON.stringify(await manager.callTool(id, "search", {}, AbortSignal.timeout(10_000)));
    expect(text).not.toContain("12345678");
    expect(readFileSync(join(dir, "servers.json"), "utf8")).not.toContain("12345678");

    const quoted = 'pa"ss\\word-123';
    const other = manager.add({ name: "Q", prefix: "q", url: "http://127.0.0.1:9/mcp", auth: { kind: "header", headerName: "X-Key", headerValue: quoted } });
    expect(other.id).toBeTruthy();
    const twice = JSON.stringify(JSON.stringify({ error: `echo ${quoted}` }));
    expect(manager.safe(twice)).not.toContain("word-123");
  });
});

describe("text and metadata edges", () => {
  it("keeps indentation when instructions are split", () => {
    const code = ["def f():", "    if x:", "        return 1", "    return 2"].join("\n");
    const pieces = splitText(`${"intro ".repeat(12)}\n${code}`, 80);
    expect(pieces.some((piece) => piece.startsWith("    ") || piece.includes("\n    if x:"))).toBe(true);
    expect(pieces.join("\n")).toContain(code);
  });

  it("falls back from a blank title to a generated description", () => {
    const surface = computeSurface([
      {
        id: "s",
        name: "S",
        prefix: "s",
        url: "https://s.example/mcp",
        enabled: true,
        auth: { kind: "none" },
        createdAt: 0,
        cache: { transport: "streamable-http", fetchedAt: 0, tools: [{ name: "t", title: "  ", inputSchema: { type: "object" } }] },
      },
    ]);
    expect(surface.tools[0]!.description).toBe("t (S)");
  });
});
