import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Manager } from "../src/manager";
import { Store } from "../src/store";
import { computeSurface } from "../src/surface";
import { modernServer, oauthServer, type FixtureTool } from "./fixtures";

const search: FixtureTool = { name: "search", description: "Search.", inputSchema: { type: "object" } };
const ORIGIN = "https://bb.example.test";
const CALLBACK = `${ORIGIN}/api/v1/plugins/mcp-servers/http/oauth/callback`;

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

async function setup(options: { supportsIss?: boolean } = {}) {
  const as = await oauthServer(options);
  const resource = await modernServer({ tools: [search] }, { guard: as.guard, issuer: () => as.issuer });
  const dir = mkdtempSync(join(tmpdir(), "mcp-servers-oauth-"));
  const store = new Store(dir);
  const logs: string[] = [];
  const manager = new Manager({
    store,
    pluginId: "mcp-servers",
    fetchImpl: fetch,
    log: (message) => logs.push(message),
    publish: () => {},
    requestReload: () => {},
    registered: { surface: computeSurface([]), names: new Set() },
  });
  cleanups.push(
    () => as.close(),
    () => resource.close(),
    () => manager.close(),
    () => rmSync(dir, { recursive: true, force: true }),
  );
  return { as, resource, store, manager, dir, logs };
}

const state = (manager: Manager, id: string) => manager.list().servers.find((server) => server.id === id)?.state;

describe("OAuth", () => {
  it("runs discovery, dynamic registration, PKCE and the redirect, then calls with the token", async () => {
    const { as, resource, store, manager, dir, logs } = await setup({ supportsIss: true });
    const { id } = manager.add({ name: "Secure", prefix: "secure", url: resource.url, auth: { kind: "oauth" } });
    await until(() => state(manager, id) === "needs-auth");

    const { authorizationUrl, redirectUri } = await manager.startAuth(id, ORIGIN);
    expect(redirectUri).toBe(CALLBACK);
    const authorize = new URL(authorizationUrl!);
    expect(authorize.origin).toBe(as.issuer);
    expect(authorize.searchParams.get("resource")).toBe(resource.url);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("scope")).toContain("tools:read");
    expect([...as.clients.values()][0]).toMatchObject({ redirect_uris: [CALLBACK], token_endpoint_auth_method: "none" });
    expect(manager.list().servers[0]!.auth.pending).toBe(true);

    const redirect = await as.approve(authorizationUrl!);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(CALLBACK);
    await expect(manager.finishAuth(redirect.searchParams)).resolves.toBe("Secure");
    await until(() => state(manager, id) === "connected");

    const view = manager.list().servers[0]!;
    expect(view.auth).toMatchObject({ authorized: true, pending: false });
    const result = await manager.callTool(id, "search", {}, AbortSignal.timeout(10_000));
    expect(result).toMatchObject({ isError: false });

    // Tokens stay server-side, in a 600 file, out of views and logs.
    const tokens = store.secretsFor(id).oauth?.tokens as { access_token: string; refresh_token: string };
    expect(statSync(join(dir, "secrets.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, "servers.json"), "utf8")).not.toContain(tokens.access_token);
    for (const text of [JSON.stringify(manager.list()), logs.join("\n")]) {
      expect(text).not.toContain(tokens.access_token);
      expect(text).not.toContain(tokens.refresh_token);
    }
  });

  it("refreshes an expired access token on 401 and keeps the call", async () => {
    const { as, resource, store, manager } = await setup();
    const { id } = manager.add({ name: "Secure", prefix: "secure", url: resource.url, auth: { kind: "oauth" } });
    const { authorizationUrl } = await manager.startAuth(id, ORIGIN);
    await manager.finishAuth((await as.approve(authorizationUrl!)).searchParams);
    await until(() => state(manager, id) === "connected");
    const before = store.secretsFor(id).oauth?.tokens as { refresh_token: string };

    as.expireAccessTokens();
    const result = await manager.callTool(id, "search", {}, AbortSignal.timeout(10_000));
    expect(result).toMatchObject({ isError: false });
    const after = store.secretsFor(id).oauth?.tokens as { refresh_token: string };
    expect(after.refresh_token).not.toBe(before.refresh_token);
    expect(as.tokenRequests.map((params) => params.get("grant_type"))).toEqual(["authorization_code", "refresh_token"]);
    expect(as.tokenRequests[1]!.get("resource")).toBe(resource.url);
  });

  it("refreshes ahead of the stated expiry, and never a fresh short-lived token", async () => {
    const { as, resource, store, manager } = await setup();
    as.accessTokenTtlS = 30;
    const { id } = manager.add({ name: "Secure", prefix: "secure", url: resource.url, auth: { kind: "oauth" } });
    const { authorizationUrl } = await manager.startAuth(id, ORIGIN);
    await manager.finishAuth((await as.approve(authorizationUrl!)).searchParams);
    await until(() => state(manager, id) === "connected");
    const refreshes = () => as.tokenRequests.filter((params) => params.get("grant_type") === "refresh_token").length;

    // Fresh 30 s token: three calls, no refresh.
    for (let i = 0; i < 3; i += 1) await manager.callTool(id, "search", {}, AbortSignal.timeout(10_000));
    expect(refreshes()).toBe(0);

    // Within the last quarter of its life (here 25 s old): refreshed once.
    store.updateSecrets(id, (secrets) => ({ ...secrets, oauth: { ...secrets.oauth, tokensSavedAt: Date.now() - 25_000 } }));
    await manager.callTool(id, "search", {}, AbortSignal.timeout(10_000));
    await manager.callTool(id, "search", {}, AbortSignal.timeout(10_000));
    expect(refreshes()).toBe(1);
  });

  it("asks for the user when the refresh token is dead, without starting a flow of its own", async () => {
    const { as, resource, store, manager } = await setup();
    const { id } = manager.add({ name: "Secure", prefix: "secure", url: resource.url, auth: { kind: "oauth" } });
    const { authorizationUrl } = await manager.startAuth(id, ORIGIN);
    await manager.finishAuth((await as.approve(authorizationUrl!)).searchParams);
    await until(() => state(manager, id) === "connected");

    as.expireAccessTokens();
    as.refreshTokens.clear();
    const clients = as.clients.size;
    const result = await manager.callTool(id, "search", {}, AbortSignal.timeout(10_000));
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("needs authorization");
    expect(state(manager, id)).toBe("needs-auth");
    expect(as.clients.size).toBe(clients);
    expect(store.secretsFor(id).oauth?.pending).toBeUndefined();
  });

  it("finishes from a pasted redirect URL and refuses a foreign or replayed state", async () => {
    const { as, resource, manager } = await setup();
    const { id } = manager.add({ name: "Secure", prefix: "secure", url: resource.url, auth: { kind: "oauth" } });
    const { authorizationUrl } = await manager.startAuth(id, ORIGIN);
    const redirect = await as.approve(authorizationUrl!);

    const forged = new URL(redirect);
    forged.searchParams.set("state", "not-the-state");
    await expect(manager.completeAuth(id, forged.toString())).rejects.toThrow(/does not match/);

    await manager.completeAuth(id, redirect.toString());
    await until(() => state(manager, id) === "connected");
    await expect(manager.completeAuth(id, redirect.toString())).rejects.toThrow(/does not match/);
  });

  it("drops the flow on an authorization error without echoing its description", async () => {
    const { resource, manager } = await setup();
    const { id } = manager.add({ name: "Secure", prefix: "secure", url: resource.url, auth: { kind: "oauth" } });
    const { authorizationUrl } = await manager.startAuth(id, ORIGIN);
    const stateParam = new URL(authorizationUrl!).searchParams.get("state")!;
    const params = new URLSearchParams({ state: stateParam, error: "access_denied", error_description: "<script>evil</script>" });
    const error = await manager.finishAuth(params).catch((caught: Error) => caught);
    expect(String(error)).toContain("access_denied");
    expect(String(error)).not.toContain("evil");
    expect(manager.list().servers[0]!.auth.pending).toBe(false);
  });

  it("uses a pre-registered client without registering one", async () => {
    const { as, resource, store, manager } = await setup();
    as.clients.set("pre-registered", { redirect_uris: [CALLBACK], token_endpoint_auth_method: "client_secret_basic" });
    const { id } = manager.add({
      name: "Secure",
      prefix: "secure",
      url: resource.url,
      auth: { kind: "oauth", clientId: "pre-registered", clientSecret: "s3cret-value" },
    });
    const { authorizationUrl } = await manager.startAuth(id, ORIGIN);
    expect(new URL(authorizationUrl!).searchParams.get("client_id")).toBe("pre-registered");
    expect(as.clients.size).toBe(1);
    await manager.finishAuth((await as.approve(authorizationUrl!)).searchParams);
    await until(() => state(manager, id) === "connected");
    expect(store.secretsFor(id).oauth?.clientSecret).toBe("s3cret-value");
    expect(JSON.stringify(manager.list())).not.toContain("s3cret-value");
    expect(manager.list().servers[0]!.auth).toMatchObject({ clientId: "pre-registered", clientSecretSet: true });
  });

  it("registers again when the BB origin (and so the redirect URI) changes", async () => {
    const { as, resource, manager } = await setup();
    const { id } = manager.add({ name: "Secure", prefix: "secure", url: resource.url, auth: { kind: "oauth" } });
    await manager.startAuth(id, ORIGIN);
    await manager.startAuth(id, "http://localhost:38886");
    expect([...as.clients.values()].map((client) => client.redirect_uris[0])).toEqual([
      CALLBACK,
      "http://localhost:38886/api/v1/plugins/mcp-servers/http/oauth/callback",
    ]);
  });
});
