import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse, experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import plugin from "../server";
import { shareSchema, statusSchema, REALTIME_CHANNEL, type Visibility } from "../lib/model";
import { createAccessVerifier } from "../server/access-jwt";
import { ShareStore } from "../server/store";
import { SECURITY_HEADERS, CSP } from "../server/service";
import { rows, page, NOW } from "./fixtures";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let wrongKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let resolver: JWTVerifyGetKey;
beforeAll(async () => {
  keys = await generateKeyPair("RS256"); wrongKeys = await generateKeyPair("RS256");
  resolver = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: "test", alg: "RS256" }] });
});
async function token(options: { email?: string | null; audience?: string; issuer?: string; expires?: string; wrongKey?: boolean } = {}) {
  return new SignJWT(options.email === null ? {} : { email: options.email ?? "Person@Example.com" }).setProtectedHeader({ alg: "RS256", kid: "test" })
    .setSubject("identity").setIssuer(options.issuer ?? "https://team.cloudflareaccess.com")
    .setAudience(options.audience ?? "app-aud").setExpirationTime(options.expires ?? "1h")
    .sign(options.wrongKey ? wrongKeys.privateKey : keys.privateKey);
}
async function setup(settings: Record<string, string | number | boolean> = {}) {
  let now = NOW;
  const verify = vi.fn(createAccessVerifier(resolver));
  const host = createFakePluginHost({ pluginId: "share", settings: {
    publicBaseUrl: "https://bb.example.com/", accessTeamDomain: "team.cloudflareaccess.com", accessAudience: "app-aud", ...settings,
  }, sdk: { threads: {
    get: async ({ threadId }) => makeThreadResponse({ id: threadId, title: "Shared fixture" }),
    timeline: async () => page(rows), timelineTurnSummaryDetails: async () => ({ rows: [] }),
  } } });
  hosts.push(host);
  await plugin(host.bb, { now: () => now, verifyAccess: verify });
  const rpc = host.harness.behavior.callRpc;
  const create = async (visibility: Visibility = "access", extra: Record<string, unknown> = {}) => {
    const result = await rpc("share_create", { threadId: "t", visibility, ...extra }) as { share: unknown };
    return shareSchema.parse(result.share);
  };
  async function fetch(path: string, slug?: string, jwt?: string, ip = "1.2.3.4") {
    const response = await host.harness.behavior.fetchHttp("GET", `${path}${slug === undefined ? "" : `?k=${encodeURIComponent(slug)}`}`, {
      headers: { "cf-connecting-ip": ip, ...(jwt === undefined ? {} : { "cf-access-jwt-assertion": jwt }) },
    });
    for (const [header, value] of Object.entries(SECURITY_HEADERS)) expect(response.headers.get(header)).toBe(value);
    if (response.headers.get("content-type")?.startsWith("text/html")) expect(response.headers.get("content-security-policy")).toBe(CSP);
    return response;
  }
  return { ...host, rpc, create, fetch, verify, store: new ShareStore(host.bb.storage.database()), setNow: (value: number) => { now = value; } };
}
const slugOf = (url: string) => new URL(url).searchParams.get("k")!;

describe("HTTP pipeline", () => {
  it.each(["/s", "/p"])("%s gives 503 before slug or identity checks when unconfigured", async (route) => {
    const h = await setup({ publicBaseUrl: "" });
    const res = await h.fetch(route);
    expect(res.status).toBe(503); expect(await res.text()).toBe("share plugin is not configured");
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.harness.inspection.needsConfigurationMessages).toEqual([expect.stringContaining("publicBaseUrl")]);
  });
  it.each([undefined, "", "short", "a".repeat(49), "!".repeat(43)])("rejects malformed slug %j before checking JWT", async (slug) => {
    const h = await setup();
    for (const route of ["/s", "/p"]) {
      const res = await h.fetch(route, slug); expect(res.status).toBe(404); expect(await res.text()).toBe("not found");
    }
    expect(h.verify).not.toHaveBeenCalled();
  });
  it.each(["missing", "malformed", "signature", "audience", "issuer", "expired"])("/s returns 401 for %s JWT", async (failure) => {
    const h = await setup(); const share = await h.create();
    const jwt = failure === "missing" ? undefined : failure === "malformed" ? "not-a-jwt" : await token({
      wrongKey: failure === "signature", audience: failure === "audience" ? "wrong" : undefined,
      issuer: failure === "issuer" ? "https://wrong.cloudflareaccess.com" : undefined, expires: failure === "expired" ? "-1h" : undefined,
    });
    const res = await h.fetch("/s", slugOf(share.url), jwt);
    expect(res.status).toBe(401); expect(await res.text()).toContain("Sign-in required");
    expect(h.harness.inspection.sdk.callsTo("threads.timeline")).toHaveLength(0);
    expect(h.store.get(share.id)?.viewCount).toBe(0);
  });
  it("/s checks allow lists against the verified email and escapes the rejected email", async () => {
    const h = await setup(); const share = await h.create("access", { allowedEmails: ["@allowed.com"] });
    const res = await h.fetch("/s", slugOf(share.url), await token({ email: "Stranger@Example.com" }));
    expect(res.status).toBe(403); const html = await res.text();
    expect(html).toContain("owner has not granted access"); expect(html).toContain("stranger@example.com");
    const malicious = await h.fetch("/s", slugOf(share.url), await token({ email: "<script>evil</script>@example.com" }));
    expect(await malicious.text()).not.toContain("<script>");
    expect(h.store.get(share.id)?.viewCount).toBe(0);
    const accepted = await h.fetch("/s", slugOf(share.url), await token({ email: "Person@Allowed.com" }));
    expect(accepted.status).toBe(200);
  });
  it.each(["/s", "/p"])("%s returns indistinguishable 404s for unknown, revoked, expired, and cross-mode slugs", async (route) => {
    const h = await setup(); const mode = route === "/s" ? "access" : "public"; const jwt = await token();
    const revoked = await h.create(mode); await h.rpc("share_revoke", { threadId: "t", shareId: revoked.id });
    const expired = await h.create(mode, { expiresInDays: 1 }); h.setNow(NOW + 86_400_000);
    const wrong = await h.create(mode === "access" ? "public" : "access");
    for (const slug of ["a".repeat(43), slugOf(revoked.url), slugOf(expired.url), slugOf(wrong.url)]) {
      const res = await h.fetch(route, slug, jwt); expect(res.status).toBe(404); expect(await res.text()).toBe("not found");
    }
    expect(h.harness.inspection.sdk.callsTo("threads.timeline")).toHaveLength(0);
  });
  it.each(["/s", "/p"])("%s rate-limits after 60 requests per IP and refills", async (route) => {
    const h = await setup();
    for (let i = 0; i < 60; i++) expect((await h.fetch(route)).status).toBe(404);
    const res = await h.fetch(route); expect(res.status).toBe(429); expect(res.headers.get("retry-after")).toBe("60");
    expect((await h.fetch(route, undefined, undefined, "5.6.7.8")).status).toBe(404);
    h.setNow(NOW + 1000); expect((await h.fetch(route)).status).toBe(404);
  });
  it("shares a bucket across both routes and rate-limits before configuration", async () => {
    const h = await setup({ publicBaseUrl: "" });
    for (let i = 0; i < 60; i++) expect((await h.fetch(i % 2 ? "/s" : "/p")).status).toBe(503);
    expect((await h.fetch("/p")).status).toBe(429);
  });
  it("/s succeeds with headers, live content, default tool exclusion, and recorded views", async () => {
    const h = await setup(); const share = await h.create(); const jwt = await token();
    const res = await h.fetch("/s", slugOf(share.url), jwt);
    expect(res.status).toBe(200); expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await res.text(); expect(html).toContain("Shared fixture"); expect(html).toContain("Shared with sign-in");
    expect(html).toContain("Read only"); expect(html).not.toContain("<details>");
    expect(h.store.get(share.id)).toMatchObject({ viewCount: 1, lastViewedAt: NOW });
    expect(h.harness.inspection.realtimeSignals.at(-1)).toEqual({ channel: REALTIME_CHANNEL, payload: { threadId: "t" } });
    h.harness.sdk.stub("threads.get", async () => makeThreadResponse({ title: "Updated title" }));
    expect(await (await h.fetch("/s", slugOf(share.url), jwt)).text()).toContain("Updated title");
    expect(h.store.get(share.id)?.viewCount).toBe(2);
  });
  it("/s unverified mode never trusts an email header or unverified JWT", async () => {
    const h = await setup({ requireAccessJwt: false }); const share = await h.create();
    const res = await h.fetch("/s", slugOf(share.url), "invalid");
    expect(res.status).toBe(200); expect(await res.text()).toContain("Unverified mode: Access JWT check is disabled");
    await h.rpc("share_update", { threadId: "t", shareId: share.id, allowedEmails: ["person@example.com"] });
    expect((await h.fetch("/s", slugOf(share.url), await token())).status).toBe(403);
    expect(h.verify).not.toHaveBeenCalled();
  });
  it("/p ignores JWT and responds to the public kill switch immediately", async () => {
    const h = await setup(); const share = await h.create("public", { includeTools: true });
    const res = await h.fetch("/p", slugOf(share.url), "invalid");
    expect(res.status).toBe(200); const html = await res.text(); expect(html).toContain("Public link"); expect(html).toContain("<details>");
    expect(html).not.toContain("abcdefghijklmnop"); expect(h.verify).not.toHaveBeenCalled();
    await h.harness.behavior.setSettings({ publicLinksEnabled: false });
    expect((await h.fetch("/p", slugOf(share.url))).status).toBe(404);
    await h.harness.behavior.setSettings({ publicLinksEnabled: true });
    expect((await h.fetch("/p", slugOf(share.url))).status).toBe(200);
    expect(h.store.get(share.id)?.viewCount).toBe(2);
  });
  it("returns safe headers and no internals when timeline reading fails", async () => {
    const h = await setup(); const share = await h.create("public");
    h.harness.sdk.stub("threads.timeline", async () => { throw new Error("private error"); });
    const res = await h.fetch("/p", slugOf(share.url)); expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("private error");
    expect(JSON.stringify(h.harness.inspection.logEntries)).not.toContain(slugOf(share.url));
  });
});

describe("RPC and lifecycle", () => {
  it("refuses unconfigured and disabled create modes", async () => {
    const h = await setup({ publicBaseUrl: "" }); await expect(h.create()).rejects.toThrow("publicBaseUrl");
    await h.harness.behavior.setSettings({ publicBaseUrl: "https://bb.example.com", publicLinksEnabled: false });
    await expect(h.create("public")).rejects.toThrow("Public links are disabled");
    await h.harness.behavior.setSettings({ accessAudience: "" }); await expect(h.create()).rejects.toThrow("accessAudience");
    await h.harness.behavior.setSettings({ publicLinksEnabled: true }); expect((await h.create("public")).visibility).toBe("public");
  });
  it("normalizes settings, reports missing fields, and validates settings saves", async () => {
    const h = await setup({ accessTeamDomain: "", accessAudience: "" });
    expect(statusSchema.parse(await h.rpc("share_status", {}))).toMatchObject({ configured: true, accessConfigured: false, publicBaseUrl: "https://bb.example.com", missing: ["accessTeamDomain", "accessAudience"] });
    for (const bad of ["ftp://example.com", "https://example.com/path", "https://user:pass@example.com", "https://example.com?x=1", "https://example.com#x"]) {
      await expect(h.harness.behavior.setSettings({ publicBaseUrl: bad })).rejects.toThrow();
    }
    await expect(h.harness.behavior.setSettings({ defaultExpiryDays: -1 })).rejects.toThrow();
    await h.harness.behavior.setSettings({ publicBaseUrl: "" }); expect((await h.fetch("/p")).status).toBe(503);
  });
  it("honors default, explicit never, zero, and custom expiry", async () => {
    const h = await setup({ defaultExpiryDays: 7 });
    expect((await h.create()).expiresAt).toBe(NOW + 7 * 86_400_000);
    expect((await h.create("access", { expiresInDays: null })).expiresAt).toBeNull();
    expect((await h.create("access", { expiresInDays: 0 })).expiresAt).toBeNull();
    expect((await h.create("access", { expiresInDays: 0.5 })).expiresAt).toBe(NOW + 43_200_000);
  });
  it("validates allow lists, ignores them for public shares, scopes mutations, and publishes", async () => {
    const h = await setup();
    await expect(h.create("access", { allowedEmails: ["bad-entry"] })).rejects.toMatchObject({ issues: [expect.objectContaining({ message: expect.stringContaining("bad-entry") })] });
    const share = await h.create("public", { allowedEmails: ["Person@Example.com"] }); expect(share.allowedEmails).toEqual([]);
    for (const method of ["share_update", "share_revoke"]) await expect(h.rpc(method, { threadId: "other", shareId: share.id })).rejects.toThrow("Unknown share");
    const updated = await h.rpc("share_update", { threadId: "t", shareId: share.id, allowedEmails: ["@example.com"], includeTools: true }) as { share: unknown };
    expect(shareSchema.parse(updated.share)).toMatchObject({ allowedEmails: [], includeTools: true });
    await h.rpc("share_revoke", { threadId: "t", shareId: share.id });
    expect(h.harness.inspection.realtimeSignals).toEqual(Array.from({ length: 3 }, () => ({ channel: REALTIME_CHANNEL, payload: { threadId: "t" } })));
  });
  it("thread deletion revokes shares and reload preserves records", async () => {
    const h = await setup(); const share = await h.create("public"); const other = await h.create("public", { threadId: "other" });
    await h.harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "t" }) });
    expect(h.store.get(share.id)?.revokedAt).toBe(NOW); expect(h.store.get(other.id)?.revokedAt).toBeNull();
    expect(h.harness.inspection.realtimeSignals.at(-1)).toEqual({ channel: REALTIME_CHANNEL, payload: { threadId: "t" } });
    const next = await h.harness.lifecycle.reload(plugin); hosts.push(next);
    const listed = await next.harness.behavior.callRpc("share_list", { threadId: "t" }) as { shares: unknown[] };
    expect(shareSchema.parse(listed.shares[0]).state).toBe("revoked");
  });
  it("uses only public SDK imports", () => {
    const scan = experimental_scanPublicSdkOnly(new URL("..", import.meta.url).pathname, { allow: [/^(?:jose|marked|better-sqlite3)$/, /^vitest(?:\/.*)?$/] });
    expect(scan.violations).toEqual([]); expect(scan.privateDependencies).toEqual([]);
  });
});

describe("CLI", () => {
  it("creates a URL, lists it, and prints status JSON", async () => {
    const h = await setup(); const cli = h.harness.behavior.runCli;
    const created = await cli(["create", "--public", "--tools", "--expires", "never"], { threadId: "t" });
    expect(created.exitCode).toBe(0); expect(created.stdout).toMatch(/^https:\/\/bb.example.com\/api\/v1\/plugins\/share\/http\/p\?k=/);
    const listed = await cli(["list", "t"]); expect(listed.exitCode).toBe(0); expect(listed.stdout).toContain(created.stdout);
    const status = await cli(["status", "--json"]); expect(status.exitCode).toBe(0); expect(statusSchema.parse(JSON.parse(status.stdout)).configured).toBe(true);
    const json = await cli(["create", "t", "--allow", "Person@Example.com", "--allow", "@allowed.com", "--json"]);
    expect(json.exitCode).toBe(0); const share = shareSchema.parse(JSON.parse(json.stdout).share);
    expect(share.allowedEmails).toEqual(["person@example.com", "@allowed.com"]);
    expect((await cli(["allow", share.id, "Other@Example.com"])).exitCode).toBe(0);
    expect((await cli(["disallow", share.id, "PERSON@example.com"])).exitCode).toBe(0);
    expect(h.store.get(share.id)?.allowedEmails).toEqual(["@allowed.com", "other@example.com"]);
    expect((await cli(["revoke", share.id])).exitCode).toBe(0); expect(h.store.get(share.id)?.revokedAt).toBe(NOW);
  });
  it.each([["create"], ["create", "t", "--allow", "bad\nentry"], ["create", "t", "--expires", "NaN"], ["create", "t", "--allow"], ["list", "t", "--public"], ["status", "extra"], ["revoke", "unknown"], ["nope"]])("returns a one-line non-zero error for %j", async (...argv) => {
    const h = await setup(); const res = await h.harness.behavior.runCli(argv);
    expect(res.exitCode).toBe(1); expect(res.stderr).not.toMatch(/[\r\n]/); expect(res.stderr.length).toBeLessThanOrEqual(1000);
  });
});
