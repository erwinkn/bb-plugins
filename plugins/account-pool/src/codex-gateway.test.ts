// A Codex API-key account behind a gateway that speaks the OpenAI Responses API (account.baseUrl),
// scoped to some BB projects (account.projects), next to ChatGPT OAuth accounts, over the real hub
// and quota store. No request leaves the process.
import Database from "better-sqlite3";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { Account, AccountSecret } from "./contracts.js";
import { createHub } from "./hub.js";
import type { RequestRecord } from "./ledger.js";
import { PoolAffinityStore, QUOTA_MIGRATIONS, QuotaStore, type AccountStore, type HubTokenStore } from "./store.js";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const MINUTE = 60_000;
const GATEWAY_URL = "https://gateway.test/llm";
const CHATGPT_URL = "https://chatgpt.test/backend-api/codex";
const EQUISAFE = "proj_equisafe";
const SOL = "gpt-6.1-sol";
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

function oauthAccount(index: number): Account {
  return {
    id: `cccccccc-0000-4000-8000-00000000000${index}`,
    provider: "codex",
    kind: "oauth",
    label: `chatgpt ${index}`,
    email: null,
    accountUuid: null,
    codexAccountId: `chatgpt-account-${index}`,
    subscriptionType: null,
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
  id: "cccccccc-0000-4000-8000-000000000009",
  provider: "codex",
  kind: "api-key",
  label: "Equisafe gateway",
  email: null,
  accountUuid: null,
  subscriptionType: null,
  rateLimitTier: null,
  enabled: true,
  priority: 0,
  createdAt: 0,
  lastUsedAt: null,
  lastUsedHostId: null,
  baseUrl: GATEWAY_URL,
  projects: [EQUISAFE],
};

// A Codex CLI turn: the turn metadata header names the model (a zstd body reads as nothing).
function turnHeaders(session: string | undefined, model: string): Record<string, string> {
  return {
    authorization: "Bearer hub",
    "content-type": "application/json",
    accept: "text/event-stream",
    originator: "codex_cli_rs",
    "x-openai-internal-codex-responses-lite": "true",
    "x-codex-turn-metadata": JSON.stringify({ model, ...(session === undefined ? {} : { session_id: session }) }),
    ...(session === undefined ? {} : { session_id: session }),
  };
}

function completedStream(model: string): Response {
  const usage = { input_tokens: 120, input_tokens_details: { cached_tokens: 100 }, output_tokens: 7 };
  return new Response(
    [
      `event: response.created\ndata: {"type":"response.created","response":{"model":"${model}"}}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { model, usage } })}\n\n`,
    ].join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

async function makePool() {
  let clock = NOW;
  const db = new Database(":memory:");
  for (const statement of QUOTA_MIGRATIONS) db.exec(statement);
  const quotas = new QuotaStore(db);
  const accounts = [oauthAccount(1), oauthAccount(2), GATEWAY];
  // The project of each session's thread, as the plugin has it cached; absent: not resolved.
  const projects = new Map<string, string>();
  const calls: Array<{ url: string; headers: Headers; body: Uint8Array }> = [];
  // What the gateway and ChatGPT answer next; a completed stream when empty.
  const gatewayReplies: Array<() => Response> = [];
  const chatgptReplies: Array<() => Response> = [];
  const rejections: Array<[string, string]> = [];
  const records: RequestRecord[] = [];
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
      codexUpstreamBaseUrl: CHATGPT_URL,
      switchThreshold: 0.98,
      claudeMainCacheTtl: "1h",
      sessionAffinityIdleMinutes: 60,
    }),
    now: () => clock,
    usageUrl: "https://api.test/usage",
    profileUrl: "https://api.test/profile",
    codexUsageUrl: "https://api.test/codex-usage",
    codexRefreshUrl: "https://api.test/codex-refresh",
    sessionProject: (session) => projects.get(session) ?? null,
    onAccountRejected: (account, message) => rejections.push([account.label, message]),
    ledger: { request: (record) => records.push(record) },
    fetch: async (input, init) => {
      const url = String(input);
      const body = init?.body instanceof Uint8Array ? init.body : new Uint8Array(await new Response(init?.body ?? null).arrayBuffer());
      calls.push({ url, headers: new Headers(init?.headers), body });
      if (url.startsWith("https://api.test/")) return Response.json({});
      if (url === `${GATEWAY_URL}/v1/responses`) return gatewayReplies.shift()?.() ?? completedStream(SOL);
      if (url === `${CHATGPT_URL}/responses`) return chatgptReplies.shift()?.() ?? completedStream(SOL);
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
  const last = { body: "", retryAfter: null as string | null };
  // Who served a /responses request: "gateway", or the ChatGPT account's token.
  const send = async (
    session?: string,
    options: { model?: string; body?: Uint8Array; headers?: Record<string, string> } = {},
  ) => {
    const model = options.model ?? SOL;
    const before = calls.length;
    const response = await hub.handle(
      new Request("https://hub.test/api/v1/plugins/account-pool-local/http/v1/responses", {
        method: "POST",
        headers: { ...turnHeaders(session, model), ...options.headers },
        body: options.body === undefined ? JSON.stringify({ model, input: [], stream: true }) : new Blob([new Uint8Array(options.body)]),
      }),
      "codex",
    );
    last.body = await response.text();
    last.retryAfter = response.headers.get("retry-after");
    const sent = calls.slice(before).filter(({ url }) => url.endsWith("/responses"));
    const tried = sent.map(({ url, headers }) => (url.startsWith(GATEWAY_URL) ? "gateway" : headers.get("authorization")));
    return { status: response.status, tried, sent };
  };
  return {
    hub,
    quotas,
    projects,
    gatewayReplies,
    chatgptReplies,
    rejections,
    records,
    last,
    send,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

// Both ChatGPT accounts out for two hours, so only the gateway may serve.
function exhaustChatGpt(pool: Awaited<ReturnType<typeof makePool>>) {
  for (const index of [1, 2]) {
    const id = oauthAccount(index).id;
    pool.quotas.put({ ...pool.quotas.get(id), heldUntil: NOW + 120 * MINUTE });
  }
}

describe("a Codex API-key account behind a gateway, scoped to some projects", () => {
  it("sends an Equisafe thread to <baseUrl>/v1/responses with the key as a bearer token and no ChatGPT header", async () => {
    const pool = await makePool();
    pool.projects.set("s1", EQUISAFE);
    const { status, tried, sent } = await pool.send("s1");
    expect({ status, tried }).toEqual({ status: 200, tried: ["gateway"] });
    const headers = sent[0]!.headers;
    expect(headers.get("authorization")).toBe("Bearer sk-gateway");
    expect(headers.get("chatgpt-account-id")).toBeNull();
    expect(headers.get("x-openai-internal-codex-responses-lite")).toBeNull();
    // What the gateway may use stays: the session (its prompt-cache key), the turn metadata.
    expect(headers.get("session_id")).toBe("s1");
    expect(headers.get("x-codex-turn-metadata")).toContain(SOL);
  });

  it("forwards a zstd body byte for byte, with its content-encoding", async () => {
    const pool = await makePool();
    pool.projects.set("s1", EQUISAFE);
    const body = zstdCompressSync(Buffer.from(JSON.stringify({ model: SOL, input: [], stream: true })));
    const { tried, sent } = await pool.send("s1", { body, headers: { "content-encoding": "zstd" } });
    expect(tried).toEqual(["gateway"]);
    expect(Buffer.from(sent[0]!.body).equals(body)).toBe(true);
    expect(sent[0]!.headers.get("content-encoding")).toBe("zstd");
  });

  it("records the gateway's usage in the ledger, with the request's model", async () => {
    const pool = await makePool();
    pool.projects.set("s1", EQUISAFE);
    await pool.send("s1");
    expect(pool.records).toHaveLength(1);
    expect(pool.records[0]).toMatchObject({
      provider: "codex",
      accountId: GATEWAY.id,
      model: SOL,
      status: 200,
      completed: true,
      usage: { inputTokens: 20, cacheReadTokens: 100, outputTokens: 7 },
    });
  });

  it("serves another project, an unresolved thread and a request without a session from ChatGPT", async () => {
    const pool = await makePool();
    pool.projects.set("other", "proj_other");
    for (const session of ["other", "unresolved", undefined]) {
      const { tried, sent } = await pool.send(session);
      expect(tried).toEqual(["Bearer tok-1"]);
      expect(sent[0]!.headers.get("chatgpt-account-id")).toBe("chatgpt-account-1");
    }
  });

  it("holds a model the gateway does not serve for 15 minutes; other models keep using it", async () => {
    const pool = await makePool();
    pool.projects.set("s1", EQUISAFE);
    const unknown = "gpt-9-nova";
    pool.gatewayReplies.push(() =>
      Response.json(
        { error: { code: "model_not_found", message: `unknown provider for model ${unknown}` } },
        { status: 400 },
      ),
    );
    expect((await pool.send("s1", { model: unknown })).tried).toEqual(["gateway", "Bearer tok-1"]);
    expect(pool.quotas.get(GATEWAY.id)?.heldUntil).toBeNull();
    expect(pool.rejections).toEqual([]);
    expect((await pool.send("s1", { model: unknown })).tried).toEqual(["Bearer tok-1"]);
    expect((await pool.send("s1")).tried).toEqual(["gateway"]);
    pool.advance(15 * MINUTE + 1);
    expect((await pool.send("s1", { model: unknown })).tried).toEqual(["gateway"]);
  });

  it("holds the gateway 15 minutes on a 401, fails over and reports it, then probes it again", async () => {
    const pool = await makePool();
    pool.projects.set("s1", EQUISAFE);
    // The gateway's own answer to a bad key.
    pool.gatewayReplies.push(() => Response.json({ error: "Invalid API key" }, { status: 401 }));
    expect(await pool.send("s1")).toMatchObject({ status: 200, tried: ["gateway", "Bearer tok-1"] });
    expect(pool.quotas.get(GATEWAY.id)?.heldUntil).toBe(NOW + 15 * MINUTE);
    expect(pool.quotas.get(GATEWAY.id)?.error).toBeNull();
    expect(pool.rejections).toEqual([["Equisafe gateway", "Invalid API key"]]);
    expect((await pool.send("s1", { model: "gpt-6-luna" })).tried).toEqual(["Bearer tok-1"]);
    pool.advance(15 * MINUTE);
    expect((await pool.send("s1")).tried).toEqual(["gateway"]);
  });

  it("holds the gateway on a 429 insufficient_quota at once, with no pacing retry", async () => {
    const pool = await makePool();
    pool.projects.set("s1", EQUISAFE);
    const message = "You exceeded your current quota, please check your plan and billing details.";
    pool.gatewayReplies.push(() =>
      Response.json(
        { error: { message, type: "insufficient_quota", param: null, code: "insufficient_quota" } },
        { status: 429 },
      ),
    );
    expect(await pool.send("s1")).toMatchObject({ status: 200, tried: ["gateway", "Bearer tok-1"] });
    expect(pool.quotas.get(GATEWAY.id)?.heldUntil).toBe(NOW + 15 * MINUTE);
    expect(pool.rejections).toEqual([["Equisafe gateway", message]]);
  });

  it("paces out a plain 429 rate limit, then fails over without reporting it", async () => {
    const pool = await makePool();
    pool.projects.set("s1", EQUISAFE);
    const limited = () =>
      Response.json(
        { error: { message: "Rate limit reached for gpt-6.1-sol on tokens per min.", type: "requests", code: "rate_limit_exceeded" } },
        { status: 429, headers: { "retry-after": "0" } },
      );
    pool.gatewayReplies.push(limited, limited);
    expect(await pool.send("s1")).toMatchObject({ status: 200, tried: ["gateway", "gateway", "Bearer tok-1"] });
    expect(pool.rejections).toEqual([]);
  });

  it("caps a gateway answer's Retry-After to the 60 seconds Codex sleeps out", async () => {
    const pool = await makePool();
    exhaustChatGpt(pool);
    pool.projects.set("s1", EQUISAFE);
    pool.gatewayReplies.push(() => new Response('{"error":"overloaded"}', { status: 503, headers: { "retry-after": "300" } }));
    expect(await pool.send("s1")).toMatchObject({ status: 503, tried: ["gateway"] });
    expect(pool.last.retryAfter).toBe("60");
    // A short one is kept as it is.
    pool.gatewayReplies.push(() => new Response('{"error":"overloaded"}', { status: 503, headers: { "retry-after": "20" } }));
    expect(await pool.send("s1")).toMatchObject({ status: 503, tried: ["gateway"] });
    expect(pool.last.retryAfter).toBe("20");
  });

  // Probed on 2026-11-18: ChatGPT and the Equisafe gateway each accept the encrypted reasoning the
  // other produced (and each refuses a tampered one with a 400), so a session may move between them
  // mid-conversation. The hub therefore forwards the same bytes to whichever side serves a turn.
  it("moves a session between the gateway and ChatGPT with the same body, encrypted reasoning untouched", async () => {
    const pool = await makePool();
    pool.projects.set("s1", EQUISAFE);
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: SOL,
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
          { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "gAAAAB-from-chatgpt" },
          { type: "message", role: "user", content: [{ type: "input_text", text: "and then?" }] },
        ],
        include: ["reasoning.encrypted_content"],
        store: false,
        stream: true,
      }),
    );
    const first = await pool.send("s1", { body });
    expect(first.tried).toEqual(["gateway"]);
    // The gateway is held (a 429 with a Retry-After): the same turn goes to ChatGPT, as sent.
    pool.gatewayReplies.push(() => new Response("", { status: 429, headers: { "retry-after": "120" } }));
    const second = await pool.send("s1", { body });
    expect(second.tried).toEqual(["gateway", "Bearer tok-1"]);
    for (const { body: forwarded } of [...first.sent, ...second.sent])
      expect(Buffer.from(forwarded).equals(Buffer.from(body))).toBe(true);
    // Once the hold ends, the session comes back to the gateway.
    pool.advance(2 * MINUTE + 1);
    expect((await pool.send("s1", { body })).tried).toEqual(["gateway"]);
  });
});
