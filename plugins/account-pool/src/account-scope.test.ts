// Accounts with their own base URL and project scope, over the real hub and quota store: an
// API-key gateway (account.baseUrl) that serves the threads of some BB projects only
// (account.projects), next to unscoped OAuth accounts. No request leaves the process.
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { Account, AccountSecret } from "./contracts.js";
import { createHub } from "./hub.js";
import { PoolAffinityStore, QUOTA_MIGRATIONS, QuotaStore, type AccountStore, type HubTokenStore } from "./store.js";

const NOW = Date.parse("2026-11-13T12:00:00Z");
const GATEWAY_URL = "https://gateway.test/llm";
const EQUISAFE = "proj_equisafe";
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

function oauthAccount(index: number): Account {
  return {
    id: `aaaaaaaa-0000-4000-8000-00000000000${index}`,
    provider: "claude",
    kind: "oauth",
    label: `oauth ${index}`,
    email: null,
    accountUuid: null,
    subscriptionType: "max",
    rateLimitTier: null,
    enabled: true,
    priority: index,
    createdAt: 0,
    lastUsedAt: null,
    lastUsedHostId: null,
  };
}

// First in priority order, so only its scope keeps other threads off it.
const GATEWAY: Account = {
  ...oauthAccount(9),
  kind: "api-key",
  label: "Equisafe gateway",
  subscriptionType: null,
  priority: 0,
  baseUrl: GATEWAY_URL,
  projects: [EQUISAFE],
};

async function makePool(gatewayAccount: Account = GATEWAY) {
  let clock = NOW;
  const db = new Database(":memory:");
  for (const statement of QUOTA_MIGRATIONS) db.exec(statement);
  const quotas = new QuotaStore(db);
  const accounts = [oauthAccount(1), oauthAccount(2), gatewayAccount];
  // The project of each session's thread, as the plugin has it cached; absent: not resolved.
  const projects = new Map<string, string>();
  const calls: Array<{ url: string; headers: Headers }> = [];
  // What the gateway answers next; 200 when empty.
  const gatewayReplies: Array<() => Response> = [];
  // What the Anthropic upstream answers next; 200 when empty.
  const upstreamReplies: Array<() => Response> = [];
  const hub = createHub({
    accounts: {
      list: async () => accounts.map((account) => ({ ...account })),
      recordUsed: async () => false,
      readSecret: async (id: string): Promise<AccountSecret> =>
        accounts.find((account) => account.id === id)?.kind === "api-key"
          ? { kind: "api-key", apiKey: "sk-gateway" }
          : { kind: "oauth", accessToken: `tok-${id.slice(-1)}`, refreshToken: "rt", expiresAt: NOW + 86_400_000 },
      writeSecret: async () => {},
      setAccountUuid: async () => {},
    } as unknown as AccountStore,
    quotas,
    affinity: new PoolAffinityStore(db),
    hubTokens: {
      authenticate: async (token: string | null) => (token === "hub" ? "host-one" : null),
      list: async () => [],
    } as unknown as HubTokenStore,
    getSettings: () => ({
      anthropicUpstreamBaseUrl: "https://upstream.test",
      codexUpstreamBaseUrl: "https://upstream.test/codex",
      switchThreshold: 0.98,
      claudeMainCacheTtl: "1h",
      sessionAffinityIdleMinutes: 60,
    }),
    now: () => clock,
    usageUrl: "https://api.test/usage",
    profileUrl: "https://api.test/profile",
    sessionProject: (session) => projects.get(session) ?? null,
    fetch: async (input, init) => {
      const url = String(input);
      calls.push({ url, headers: new Headers(init?.headers) });
      if (url.startsWith("https://api.test/")) return Response.json({});
      if (url.startsWith(GATEWAY_URL)) return gatewayReplies.shift()?.() ?? Response.json({ ok: true });
      if (url === "https://upstream.test/v1/messages") return upstreamReplies.shift()?.() ?? Response.json({ ok: true });
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  const controller = new AbortController();
  const started = hub.start(controller.signal);
  closers.push(async () => {
    controller.abort();
    await started;
    db.close();
  });
  // Who served a Messages request: "gateway", or the OAuth account's token.
  const send = async (session?: string, model: string | null = "claude-opus-5-5") => {
    const before = calls.length;
    const response = await hub.handle(
      new Request("https://hub.test/api/v1/plugins/account-pool-local/http/v1/messages", {
        method: "POST",
        headers: { authorization: "Bearer hub", "content-type": "application/json" },
        body: JSON.stringify({
          ...(model === null ? {} : { model }),
          ...(session === undefined ? {} : { metadata: { user_id: JSON.stringify({ session_id: session }) } }),
        }),
      }),
      "claude",
    );
    await response.text();
    const tried = calls
      .slice(before)
      .filter(({ url }) => url.endsWith("/v1/messages"))
      .map(({ url, headers }) => (url.startsWith(GATEWAY_URL) ? "gateway" : headers.get("authorization")));
    return { status: response.status, tried };
  };
  return {
    hub,
    accounts,
    quotas,
    calls,
    projects,
    gatewayReplies,
    upstreamReplies,
    send,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("an account scoped to some projects, behind its own base URL", () => {
  it("serves an Equisafe thread from the gateway, with its API key and no OAuth token", async () => {
    const pool = await makePool();
    pool.projects.set("s1", EQUISAFE);
    expect(await pool.send("s1")).toEqual({ status: 200, tried: ["gateway"] });
    const sent = pool.calls.find(({ url }) => url.startsWith(GATEWAY_URL))!;
    expect(sent.url).toBe(`${GATEWAY_URL}/v1/messages`);
    expect(sent.headers.get("x-api-key")).toBe("sk-gateway");
    expect(sent.headers.get("authorization")).toBeNull();
  });

  it("never serves another project, an unresolved thread or a request without a session", async () => {
    const pool = await makePool();
    pool.projects.set("other", "proj_other");
    expect(await pool.send("other")).toEqual({ status: 200, tried: ["Bearer tok-1"] });
    expect(await pool.send("unresolved")).toEqual({ status: 200, tried: ["Bearer tok-1"] });
    expect(await pool.send()).toEqual({ status: 200, tried: ["Bearer tok-1"] });
    expect(pool.calls.some(({ url }) => url.startsWith(GATEWAY_URL))).toBe(false);
  });

  it("takes over once the thread's project resolves, without moving the session pin or the provider cursor", async () => {
    const pool = await makePool();
    expect((await pool.send("s1")).tried).toEqual(["Bearer tok-1"]);
    pool.projects.set("s1", EQUISAFE);
    expect((await pool.send("s1")).tried).toEqual(["gateway"]);
    // Held now: the session goes back to the account it was pinned to, and other threads keep the
    // provider's active account.
    pool.gatewayReplies.push(() => new Response("{}", { status: 429, headers: { "retry-after": "3600" } }));
    expect(await pool.send("s1")).toEqual({ status: 200, tried: ["gateway", "Bearer tok-1"] });
    expect((await pool.send("s2")).tried).toEqual(["Bearer tok-1"]);
  });

  it("falls back to the normal accounts while the gateway is held, and returns to it after", async () => {
    const pool = await makePool();
    pool.projects.set("s1", EQUISAFE);
    pool.gatewayReplies.push(() => new Response("{}", { status: 429, headers: { "retry-after": "600" } }));
    expect(await pool.send("s1")).toEqual({ status: 200, tried: ["gateway", "Bearer tok-1"] });
    expect(await pool.send("s1")).toEqual({ status: 200, tried: ["Bearer tok-1"] });
    pool.advance(601_000);
    expect(await pool.send("s1")).toEqual({ status: 200, tried: ["gateway"] });
  });

  it("falls back to the normal accounts when the gateway fails", async () => {
    const pool = await makePool();
    pool.projects.set("s1", EQUISAFE);
    pool.gatewayReplies.push(() => new Response('{"error":"upstream"}', { status: 502 }));
    expect(await pool.send("s1")).toEqual({ status: 200, tried: ["gateway", "Bearer tok-1"] });
  });

  it("holds a gateway that answers 400 for a request with no model for 15 minutes, whatever the model", async () => {
    const pool = await makePool();
    pool.projects.set("s1", EQUISAFE);
    pool.gatewayReplies.push(() => Response.json({ error: "bad request" }, { status: 400 }));
    expect(await pool.send("s1", null)).toEqual({ status: 200, tried: ["gateway", "Bearer tok-1"] });
    expect(pool.quotas.get(GATEWAY.id)?.heldUntil).toBe(NOW + 15 * 60_000);
    // Held: no request reaches it, however many come.
    pool.advance(14 * 60_000);
    expect(await pool.send("s1")).toEqual({ status: 200, tried: ["Bearer tok-1"] });
    expect(await pool.send("s1")).toEqual({ status: 200, tried: ["Bearer tok-1"] });
  });

  it("holds a model the gateway rejects, not the gateway: other models keep using it", async () => {
    const pool = await makePool();
    pool.projects.set("s1", EQUISAFE);
    const fable = "claude-fable-5-2";
    pool.gatewayReplies.push(() => Response.json({ error: `unknown provider for model ${fable}` }, { status: 400 }));
    expect(await pool.send("s1", fable)).toEqual({ status: 200, tried: ["gateway", "Bearer tok-1"] });
    expect(pool.quotas.get(GATEWAY.id)?.heldUntil).toBeNull();
    // The next Fable request skips the gateway; Opus still goes to it.
    expect(await pool.send("s1", fable)).toEqual({ status: 200, tried: ["Bearer tok-1"] });
    expect(await pool.send("s1")).toEqual({ status: 200, tried: ["gateway"] });
    // The hold expires after 15 minutes: the gateway is tried for Fable again.
    pool.advance(15 * 60_000 + 1);
    expect(await pool.send("s1", fable)).toEqual({ status: 200, tried: ["gateway"] });
  });

  it("tries the gateway again once its hold has expired", async () => {
    const pool = await makePool();
    pool.projects.set("s1", EQUISAFE);
    pool.gatewayReplies.push(() => new Response("{}", { status: 422 }));
    expect((await pool.send("s1")).tried).toEqual(["gateway", "Bearer tok-1"]);
    pool.advance(15 * 60_000 + 1);
    expect(await pool.send("s1")).toEqual({ status: 200, tried: ["gateway"] });
  });

  it("hands a 400 from an unscoped account to the client, with no fallback", async () => {
    const pool = await makePool();
    pool.upstreamReplies.push(() => Response.json({ error: "bad request" }, { status: 400 }));
    expect(await pool.send("other")).toEqual({ status: 400, tried: ["Bearer tok-1"] });
  });

  it("resumes the normal rotation where it stood when the gateway fails, not at the first account", async () => {
    const pool = await makePool();
    // oauth 1 held for a minute: another thread moves the provider's active account to oauth 2.
    const first = oauthAccount(1).id;
    pool.quotas.put({ ...pool.quotas.get(first), heldUntil: NOW + 60_000 });
    expect((await pool.send("other")).tried).toEqual(["Bearer tok-2"]);
    pool.advance(61_000);
    pool.projects.set("s1", EQUISAFE);
    pool.gatewayReplies.push(() => new Response('{"error":"upstream"}', { status: 502 }));
    expect(await pool.send("s1")).toEqual({ status: 200, tried: ["gateway", "Bearer tok-2"] });
    // The fallback pinned the session there: with the gateway held, it stays on oauth 2.
    pool.gatewayReplies.push(() => new Response("{}", { status: 429, headers: { "retry-after": "600" } }));
    expect(await pool.send("s1")).toEqual({ status: 200, tried: ["gateway", "Bearer tok-2"] });
  });

  it("ignores the session pin a gateway took before it was scoped", async () => {
    const { projects: _projects, ...unscoped } = GATEWAY;
    const pool = await makePool(unscoped);
    // Unscoped and first in priority order, the gateway takes the session and its pin.
    expect((await pool.send("s1")).tried).toEqual(["gateway"]);
    pool.accounts[2]!.projects = [EQUISAFE];
    pool.projects.set("s1", EQUISAFE);
    // Scoped now, it only ever serves as a detour: held, the session falls back to the normal
    // accounts instead of getting the 429 its old pin would hand back.
    pool.gatewayReplies.push(() => new Response("{}", { status: 429, headers: { "retry-after": "600" } }));
    expect(await pool.send("s1")).toEqual({ status: 200, tried: ["gateway", "Bearer tok-1"] });
    expect(await pool.send("s1")).toEqual({ status: 200, tried: ["Bearer tok-1"] });
  });

  it("never sends an OAuth call (usage, profile) to the gateway", async () => {
    const pool = await makePool();
    await pool.hub.refreshUsage(undefined, true);
    await pool.hub.refreshUsage(GATEWAY.id, true);
    const oauthCalls = pool.calls.filter(({ url }) => !url.endsWith("/v1/messages"));
    expect(oauthCalls.length).toBeGreaterThan(0);
    expect(oauthCalls.every(({ url }) => url.startsWith("https://api.test/"))).toBe(true);
    expect(oauthCalls.every(({ headers }) => headers.get("authorization")?.startsWith("Bearer tok-"))).toBe(true);
  });

  it("sends an OAuth account to Anthropic even if it carries a base URL", async () => {
    const { projects: _projects, ...unscoped } = GATEWAY;
    const pool = await makePool({ ...unscoped, kind: "oauth" });
    expect(await pool.send("s1")).toEqual({ status: 200, tried: ["Bearer tok-9"] });
    expect(pool.calls.some(({ url }) => url.startsWith(GATEWAY_URL))).toBe(false);
  });

  it("does not count the gateway as capacity the rest of the pool can wait for", async () => {
    const pool = await makePool();
    for (const index of [1, 2]) {
      const id = oauthAccount(index).id;
      pool.quotas.put({ ...pool.quotas.get(id), heldUntil: NOW + 600_000 });
    }
    expect(await pool.hub.nextEligibleAt("claude", "opus")).toBe(NOW + 600_000);
    pool.projects.set("s1", EQUISAFE);
    expect(await pool.send("s1")).toEqual({ status: 200, tried: ["gateway"] });
    expect((await pool.send("other")).status).toBe(429);
  });
});
