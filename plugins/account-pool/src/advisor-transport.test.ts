// Advisor transport regressions, ported from the accepted T76 probes (A154/A168 isolation, A161
// credential-repair boundary and header hygiene, A166 joining races). The real hub runs over fake
// stores; nothing reaches a network.
import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Account, AccountQuota, AccountSecret } from "./contracts.js";
import type { AdvisorConfigState } from "./advisor-config.js";
import { advisorRequestHeaders, createHub, type LedgerHooks } from "./hub.js";
import type { RequestRecord } from "./ledger.js";
import type {
  AccountStore,
  HubTokenStore,
  PoolAffinityStore,
  QuotaStore,
} from "./store.js";
import { dependantsOf } from "./testing/signals.js";

const START = Date.UTC(2026, 9, 4, 12);
const EMPTY_FAMILY = { fable: null, sonnet: null, opus: null, haiku: null, other: null };
const ON: AdvisorConfigState = {
  ok: true,
  config: { routes: { claude: true, codex: true }, maxUtilization: null },
};

function emptyQuota(accountId: string): AccountQuota {
  return {
    accountId,
    fiveHourUtilization: null,
    fiveHourResetAt: null,
    fiveHourStatus: null,
    sevenDayUtilization: null,
    sevenDayResetAt: null,
    sevenDayStatus: null,
    representativeClaim: null,
    familyWeekly: EMPTY_FAMILY,
    limitWindows: [],
    observedAt: null,
    heldUntil: null,
    error: null,
  };
}

function account(
  id: string,
  provider: "claude" | "codex" = "claude",
  kind: "oauth" | "api-key" = "oauth",
  priority = 0,
): Account {
  return {
    id,
    provider,
    kind,
    label: id,
    email: null,
    accountUuid: null,
    subscriptionType: null,
    rateLimitTier: null,
    enabled: true,
    priority,
    createdAt: 0,
    lastUsedAt: null,
    lastUsedHostId: null,
    ...(provider === "codex" ? { codexAccountId: `acct-${id}` } : {}),
  };
}

const oauth = (token = "tok-0", expiresAt = START + 86_400_000): AccountSecret => ({
  kind: "oauth",
  accessToken: token,
  refreshToken: "rt",
  expiresAt,
});

const gate = () => {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

type Reply = number | { status: number; headers?: Record<string, string>; body?: string } | "hang" | "fail" | { gate: ReturnType<typeof gate>; status: number };
type RefreshStep = number | { gate: ReturnType<typeof gate>; status: number };

// The log tags advisor POSTs "adv-": native requests never carry the OAuth beta or bb-advisor.
function makeHub(options: {
  accounts?: Account[];
  secrets?: Map<string, AccountSecret>;
  script?: Reply[];
  refresh?: RefreshStep[];
  advisor?: AdvisorConfigState;
  settings?: { switchThreshold?: number };
  ledger?: LedgerHooks;
}) {
  let clock = START;
  const accounts = options.accounts ?? [account("A")];
  const secrets = options.secrets ?? new Map([["A", oauth()]]);
  const quotas = new Map<string, AccountQuota>();
  const log: string[] = [];
  const sent: Array<Record<string, string> & { url: string }> = [];
  const used: Array<[string, string]> = [];
  const readGates: Array<ReturnType<typeof gate> | undefined> = [];
  const upstreamAborted: boolean[] = [];
  let posts = 0;
  let refreshes = 0;
  const script = options.script ?? [];
  const refresh = options.refresh ?? [];
  const hub = createHub({
    accounts: {
      list: async () => accounts.map((entry) => ({ ...entry })),
      recordUsed: async (id: string, _at: number, host: string) => {
        used.push([id, host]);
        return false;
      },
      readSecret: async (id: string) => {
        const held = readGates.shift();
        if (held !== undefined) {
          log.push("read:held");
          await held.promise;
        }
        const secret = secrets.get(id);
        if (secret === undefined) throw new Error("missing secret");
        return secret;
      },
      writeSecret: async (id: string, secret: AccountSecret) => {
        secrets.set(id, secret);
      },
      setAccountUuid: async () => {},
    } as unknown as AccountStore,
    quotas: {
      get: (id: string) => quotas.get(id) ?? emptyQuota(id),
      put: (quota: AccountQuota) => {
        quotas.set(quota.accountId, quota);
      },
    } as unknown as QuotaStore,
    affinity: {
      loadBindings: () => new Map(),
      loadActiveAccounts: () => new Map(),
      putBinding() {},
      putActiveAccount() {},
      removeBinding() {},
    } as unknown as PoolAffinityStore,
    hubTokens: {
      authenticate: async (token: string | null) => (token === "hub" ? "host-one" : null),
      list: async () => [],
    } as unknown as HubTokenStore,
    getSettings: () => ({
      anthropicUpstreamBaseUrl: "https://u.invalid/a",
      codexUpstreamBaseUrl: "https://u.invalid/c",
      switchThreshold: options.settings?.switchThreshold ?? 0.98,
      claudeMainCacheTtl: "1h",
      sessionAffinityIdleMinutes: 60,
    }),
    getAdvisorConfig: () => options.advisor ?? ON,
    ledger: options.ledger,
    now: () => clock,
    refreshUrl: "https://u.invalid/oauth/token",
    codexRefreshUrl: "https://u.invalid/c/oauth/token",
    fetch: async (input, init) => {
      const url = String(input);
      if (url.includes("oauth/token")) {
        const step = refresh[refreshes++] ?? 200;
        if (typeof step === "object") {
          log.push("refresh:held");
          await step.gate.promise;
        }
        const status = typeof step === "number" ? step : step.status;
        log.push(`refresh:${status}`);
        return status === 200
          ? Response.json({ access_token: `tok-r${refreshes}`, expires_in: 3600 })
          : new Response("{}", { status });
      }
      const headers = new Headers(init?.headers);
      sent.push({ url, ...Object.fromEntries(headers) });
      const advisor =
        headers.get("user-agent") === "bb-advisor" ? "adv-" : "";
      const reply = script[posts++] ?? 200;
      if (reply === "fail") {
        log.push(`${advisor}post:fail`);
        throw new TypeError("fetch failed");
      }
      if (reply === "hang") {
        log.push(`${advisor}post:hang`);
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            upstreamAborted.push(true);
            reject(init.signal?.reason);
          }, { once: true });
        });
      }
      if (typeof reply === "object" && "gate" in reply) {
        log.push(`${advisor}post:held`);
        await reply.gate.promise;
      }
      const status = typeof reply === "number" ? reply : reply.status;
      log.push(`${advisor}post:${status}:${headers.get("authorization")?.slice(7) ?? "-"}`);
      const body =
        typeof reply === "object" && "body" in reply && reply.body !== undefined
          ? reply.body
          : JSON.stringify({ model: "claude-sonnet-5-5" });
      return new Response(body, {
        status,
        headers: {
          "content-type": "application/json",
          ...(typeof reply === "object" && "headers" in reply ? reply.headers : {}),
        },
      });
    },
  });
  (hub as unknown as { accepting: boolean }).accepting = true;
  const internals = hub as unknown as {
    refreshBackoffs: Map<string, { kind: string; accessToken: string }>;
    refreshes: Map<string, { use: { kind: string } }>;
  };
  return {
    hub,
    log,
    sent,
    used,
    quotas,
    secrets,
    readGates,
    upstreamAborted,
    advance: (ms: number) => {
      clock += ms;
    },
    backoff: () => {
      const backoff = internals.refreshBackoffs.get("A");
      return backoff === undefined ? null : { kind: backoff.kind, token: backoff.accessToken };
    },
    flightUse: () => internals.refreshes.get("A")?.use.kind,
  };
}

type Env = ReturnType<typeof makeHub>;

const claudeBody = JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 10, messages: [{ role: "user", content: "x" }] });
const codexBody = JSON.stringify({ model: "gpt-6-luna", instructions: "x", input: [], stream: true });
const ROUTE = "http://127.0.0.1:1/api/v1/plugins/account-pool-local/http";

function advisorRequest(
  provider: "claude" | "codex" = "claude",
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Request {
  return new Request(`${ROUTE}/advisor/v1/${provider === "codex" ? "responses" : "messages"}`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(provider === "claude" ? { "anthropic-version": "2023-06-01" } : {}),
      ...headers,
    },
    body: provider === "codex" ? codexBody : claudeBody,
  });
}

function nativeRequest(headers: Record<string, string> = {}): Request {
  return new Request(`${ROUTE}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer hub",
      "anthropic-version": "2023-06-01",
      ...headers,
    },
    body: claudeBody,
  });
}

async function advise(env: Env, request = advisorRequest()) {
  const start = env.log.length;
  const response = await env.hub.handleAdvisor(
    request,
    request.url.includes("/responses") ? "codex" : "claude",
  );
  await response.text();
  return {
    status: response.status,
    stamp: response.headers.get("x-account-pool-dispatch"),
    log: env.log.slice(start),
  };
}

async function native(env: Env, request = nativeRequest()) {
  const start = env.log.length;
  const response = await env.hub.handle(request, "claude");
  await response.text();
  return { status: response.status, log: env.log.slice(start) };
}

const posts = (log: string[]) => log.filter((entry) => /^(adv-)?post:/u.test(entry)).length;
const refreshCount = (log: string[]) => log.filter((entry) => /^refresh:\d/u.test(entry)).length;
const errorOf = (env: Env, id = "A") => env.quotas.get(id)?.error ?? null;
const heldOf = (env: Env, id = "A") => env.quotas.get(id)?.heldUntil ?? null;

describe("advisor isolation (A154/A168)", () => {
  it.each([
    ["vendor 403", [403, 200]],
    ["vendor 401", [401, 401, 200]],
    ["vendor 429 with retry-after", [{ status: 429, headers: { "retry-after": "30" } }, 200]],
  ] as const)("%s: one POST, no refresh, no shared error or hold, native still routes", async (_name, script) => {
    const env = makeHub({ script: [...script] });
    const result = await advise(env);
    expect(result.stamp).toBe("sent");
    expect(posts(result.log)).toBe(1);
    expect(refreshCount(result.log)).toBe(0);
    expect(result.status).toBe(typeof script[0] === "number" ? script[0] : script[0].status);
    expect([errorOf(env), heldOf(env)]).toEqual([null, null]);
    expect(env.used[0]).toEqual(["A", "advisor"]);
    expect((await native(env)).status).toBe(200);
  });

  it("vendor 529 on two accounts: one POST, no failover", async () => {
    const env = makeHub({
      accounts: [account("A"), account("B", "claude", "oauth", 1)],
      secrets: new Map([["A", oauth()], ["B", oauth("tok-b")]]),
      script: [529, 529],
    });
    const result = await advise(env);
    expect([result.status, result.stamp, posts(result.log)]).toEqual([529, "sent", 1]);
  });

  it("codex vendor 401: one POST, no shared error, native codex unaffected", async () => {
    const env = makeHub({
      accounts: [account("C", "codex")],
      secrets: new Map([["C", oauth("tok-c")]]),
      script: [401],
    });
    const result = await advise(env, advisorRequest("codex"));
    expect([result.status, result.stamp, posts(result.log), refreshCount(result.log)]).toEqual([401, "sent", 1, 0]);
    expect(errorOf(env, "C")).toBeNull();
  });

  it("revoked token: one advisor POST, then native does its own refresh-and-resend", async () => {
    const env = makeHub({ script: [401, 401, 200] });
    await advise(env);
    const next = await native(env);
    expect(env.log).toEqual(["adv-post:401:tok-0", "post:401:tok-0", "refresh:200", "post:200:tok-r1"]);
    expect([next.status, errorOf(env)]).toEqual([200, null]);
  });

  it("near expiry: the shared normal refresh runs once before the single POST", async () => {
    const env = makeHub({ secrets: new Map([["A", oauth("tok-0", START + 60_000)]]) });
    const result = await advise(env);
    expect(result.log).toEqual(["refresh:200", "adv-post:200:tok-r1"]);
  });

  it("near-expiry refresh failure: 503 none, no POST, no advisor-made error; native then marks it itself", async () => {
    const env = makeHub({ secrets: new Map([["A", oauth("tok-0", START + 60_000)]]), refresh: [400, 400] });
    const result = await advise(env);
    expect([result.status, result.stamp, posts(result.log)]).toEqual([503, "none", 0]);
    expect(errorOf(env)).toBeNull();
    const next = await native(env);
    expect(next.status).not.toBe(200);
    expect(errorOf(env)).not.toBeNull();
  });

  it("records quota headers from the advisor response and nothing else", async () => {
    const env = makeHub({
      script: [{ status: 200, headers: { "anthropic-ratelimit-unified-5h-utilization": "0.42", "anthropic-ratelimit-unified-5h-status": "allowed" } }],
    });
    await advise(env);
    expect(env.quotas.get("A")).toMatchObject({ fiveHourUtilization: 0.42, fiveHourStatus: "allowed", error: null, heldUntil: null });
  });

  it("caller cancel in flight: 499, the upstream fetch aborted, no error", async () => {
    const env = makeHub({ script: ["hang"] });
    const controller = new AbortController();
    const pending = env.hub.handleAdvisor(advisorRequest("claude", {}, controller.signal), "claude");
    while (env.log.length === 0) await tick();
    controller.abort();
    const response = await pending;
    expect([response.status, response.headers.get("x-account-pool-dispatch")]).toEqual([499, "sent"]);
    expect(env.upstreamAborted).toEqual([true]);
    expect(errorOf(env)).toBeNull();
  });

  it("never uses an API-key Pooler account", async () => {
    const env = makeHub({ accounts: [account("K", "claude", "api-key")], secrets: new Map([["K", { kind: "api-key", apiKey: "k" }]]) });
    const result = await advise(env);
    expect([result.status, result.stamp, posts(result.log)]).toEqual([429, "none", 0]);
  });

  it("refuses when the Pooler is not accepting, and every refusal is stamped none", async () => {
    const env = makeHub({});
    (env.hub as unknown as { accepting: boolean }).accepting = false;
    expect(await advise(env)).toMatchObject({ status: 503, stamp: "none" });
    const off = makeHub({ advisor: { ok: true, config: { routes: { claude: false, codex: true }, maxUtilization: null } } });
    expect(await advise(off)).toMatchObject({ status: 403, stamp: "none" });
    const large = makeHub({});
    const big = new Request(`${ROUTE}/advisor/v1/messages`, { method: "POST", body: "x".repeat(256 * 1024 + 1) });
    expect(await advise(large, big)).toMatchObject({ status: 413, stamp: "none" });
    expect([off.sent, large.sent, env.sent]).toEqual([[], [], []]);
  });

  it("the effective reserve is min(maxUtilization, switchThreshold)", async () => {
    const at = (utilization: number, reserve: number | null, threshold: number) => {
      const env = makeHub({
        advisor: { ok: true, config: { routes: { claude: true, codex: false }, maxUtilization: reserve } },
        settings: { switchThreshold: threshold },
      });
      env.quotas.set("A", { ...emptyQuota("A"), fiveHourUtilization: utilization, observedAt: START });
      return advise(env);
    };
    expect((await at(0.96, 0.95, 0.98)).status).toBe(429);
    expect((await at(0.94, 0.95, 0.98)).status).toBe(200);
    expect((await at(0.92, 0.95, 0.9)).status).toBe(429);
    expect((await at(0.89, null, 0.9)).status).toBe(200);
    expect((await at(0.9, null, 0.9)).status).toBe(429);
  });
});

describe("advisor header hygiene (A161 F2 / D337)", () => {
  it("names the client and keeps only allowed caller headers", async () => {
    const env = makeHub({});
    await advise(env, advisorRequest("claude", {
      "x-app": "cli",
      "user-agent": "claude-cli/2.1.287 (external, cli)",
      "anthropic-beta": "claude-code-20250219, interleaved-thinking-2025-05-14,Claude-Code-Extra",
      "x-stainless-lang": "js",
      "anthropic-dangerous-direct-browser-access": "true",
      "x-api-key": "caller-key",
      authorization: "Bearer caller",
    }));
    const headers = env.sent[0] ?? { url: "" };
    expect(headers.url).toBe("https://u.invalid/a/v1/messages");
    expect(headers).toEqual({
      url: "https://u.invalid/a/v1/messages",
      accept: headers.accept,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "interleaved-thinking-2025-05-14,oauth-2025-04-20",
      authorization: "Bearer tok-0",
      "user-agent": "bb-advisor",
    });
  });

  it("merges the OAuth beta without duplicating it", async () => {
    const plain = makeHub({});
    await advise(plain);
    expect(plain.sent[0]?.["anthropic-beta"]).toBe("oauth-2025-04-20");
    const merged = makeHub({});
    await advise(merged, advisorRequest("claude", { "anthropic-beta": "context-1m-2025-08-07" }));
    expect(merged.sent[0]?.["anthropic-beta"]).toBe("context-1m-2025-08-07,oauth-2025-04-20");
    const duplicate = makeHub({});
    await advise(duplicate, advisorRequest("claude", { "anthropic-beta": "oauth-2025-04-20" }));
    expect(duplicate.sent[0]?.["anthropic-beta"]).toBe("oauth-2025-04-20");
    const apiKey = advisorRequestHeaders("claude", new Headers({ "anthropic-beta": "claude-code-20250219", "x-api-key": "k", "x-app": "cli" }), { kind: "api-key", apiKey: "k" });
    expect(Object.fromEntries(apiKey)).toEqual({ "x-api-key": "k", "user-agent": "bb-advisor" });
  });

  it("codex: Pooler originator and user-agent, codex identity and session headers dropped", async () => {
    const env = makeHub({ accounts: [account("A", "codex")] });
    await advise(env, advisorRequest("codex", {
      originator: "codex_cli_rs",
      "user-agent": "codex_cli_rs/0.144.3",
      "x-codex-turn-metadata": "{}",
      session_id: "s",
      "x-stainless-os": "Linux",
      accept: "text/event-stream",
    }));
    const headers = env.sent[0] ?? { url: "" };
    expect(headers.url).toBe("https://u.invalid/c/responses");
    expect(headers).toMatchObject({
      originator: "bb-advisor",
      "user-agent": "bb-advisor",
      "chatgpt-account-id": "acct-A",
      authorization: "Bearer tok-0",
      accept: "text/event-stream",
    });
    expect(Object.keys(headers).filter((name) => /^(x-codex-|x-stainless-|session_id|anthropic-beta)/u.test(name))).toEqual([]);
  });

  it("leaves native hub-token traffic exactly as before", async () => {
    const env = makeHub({});
    await native(env, nativeRequest({ "x-app": "cli", "user-agent": "claude-cli/2.1.287 (external, cli)", "anthropic-beta": "claude-code-20250219", "x-stainless-lang": "js" }));
    expect(env.sent[0]).toMatchObject({
      "x-app": "cli",
      "user-agent": "claude-cli/2.1.287 (external, cli)",
      "anthropic-beta": "claude-code-20250219",
      "x-stainless-lang": "js",
    });
  });

  it("refuses compressed bodies before reading them, on both providers", async () => {
    for (const provider of ["claude", "codex"] as const) {
      for (const encoding of ["gzip", "br", "zstd", "deflate"]) {
        const env = makeHub({ accounts: [account("A", provider)] });
        const result = await advise(env, advisorRequest(provider, { "content-encoding": encoding }));
        expect([result.status, result.stamp, env.sent.length]).toEqual([415, "none", 0]);
      }
    }
    const identity = makeHub({});
    const result = await advise(identity, advisorRequest("claude", { "content-encoding": "identity" }));
    expect([result.status, identity.sent[0]?.["content-encoding"]]).toEqual([200, undefined]);
  });
});

describe("advisor credential-repair boundary (A161 F1)", () => {
  // Native leaves a rejected backoff on tok-0: 401, then a transient (503) forced-refresh failure.
  async function rejectedBackoff(refreshAfter: number[]) {
    const env = makeHub({ script: [401, 200, 200, 200, 200], refresh: [503, ...refreshAfter] });
    await native(env);
    env.advance(120_000);
    return env;
  }

  it.each([400, 200])("a pending rejected backoff: advisor 503 none, no refresh, backoff intact; native then repairs (%d)", async (second) => {
    const env = await rejectedBackoff([second, 200]);
    expect(env.backoff()).toEqual({ kind: "rejected", token: "tok-0" });
    const result = await advise(env);
    expect([result.status, result.stamp, refreshCount(result.log), posts(result.log)]).toEqual([503, "none", 0, 0]);
    expect(env.backoff()).toEqual({ kind: "rejected", token: "tok-0" });
    const next = await native(env);
    if (second === 400) {
      expect([next.log.join(), next.status]).toEqual(["refresh:400", 429]);
      expect(errorOf(env)).not.toBeNull();
    } else expect([next.log.join(), next.status]).toEqual(["refresh:200,post:200:tok-r2", 200]);
  });

  it("does not wait for a native forced refresh in flight", async () => {
    const held = gate();
    const env = makeHub({ script: [401, 200, 200], refresh: [{ gate: held, status: 200 }] });
    const nativePending = native(env);
    await tick();
    const advisorPending = advise(env);
    const raced = await Promise.race([
      advisorPending.then(() => "returned"),
      tick().then(tick).then(() => "waiting"),
    ]);
    held.open();
    const result = await advisorPending;
    expect(raced).toBe("returned");
    expect([result.status, result.stamp, posts(result.log), refreshCount(result.log)]).toEqual([503, "none", 0, 0]);
    expect((await nativePending).status).toBe(200);
  });

  it("refuses when a joined normal flight turns into a forced refresh", async () => {
    const env = await rejectedBackoff([200]);
    const held = gate();
    env.readGates.push(held);
    const nativePending = native(env);
    await tick();
    const advisorPending = advise(env);
    await tick();
    held.open();
    const result = await advisorPending;
    const next = await nativePending;
    expect([result.status, result.stamp]).toEqual([503, "none"]);
    expect(env.log.filter((entry) => entry.startsWith("adv-post:"))).toEqual([]);
    expect(next.status).toBe(200);
  });

  it("does not wait behind native's 401 rejection check", async () => {
    const env = makeHub({ script: [401, 200], refresh: [400] });
    const held = gate();
    env.readGates.push(undefined, held);
    const nativePending = native(env);
    for (let index = 0; index < 4 && !env.log.includes("read:held"); index += 1) await tick();
    const advisorPending = advise(env);
    const raced = await Promise.race([
      advisorPending.then(() => "returned"),
      tick().then(tick).then(() => "waiting"),
    ]);
    held.open();
    const result = await advisorPending;
    await nativePending;
    expect(env.log).toContain("read:held");
    expect(raced).toBe("returned");
    expect([result.status, result.stamp, posts(result.log), refreshCount(result.log)]).toEqual([503, "none", 0, 0]);
    expect(errorOf(env)).not.toBeNull();
  });

  it("a replacement token with a stale rejected backoff: refuse, native clears it, then the advisor posts", async () => {
    const env = await rejectedBackoff([200]);
    env.secrets.set("A", oauth("tok-new"));
    const stale = await advise(env);
    expect([stale.status, stale.stamp, posts(stale.log), refreshCount(stale.log)]).toEqual([503, "none", 0, 0]);
    expect((await native(env)).log.join()).toBe("post:200:tok-new");
    expect(env.backoff()).toBeNull();
    expect((await advise(env)).log.join()).toBe("adv-post:200:tok-new");
  });

  it("near expiry: advisor and native share one normal refresh", async () => {
    const held = gate();
    const env = makeHub({ secrets: new Map([["A", oauth("tok-0", START + 60_000)]]), refresh: [{ gate: held, status: 200 }] });
    const advisorPending = advise(env);
    await tick();
    const nativePending = native(env);
    await tick();
    held.open();
    const [result, next] = await Promise.all([advisorPending, nativePending]);
    expect([result.status, next.status, refreshCount(env.log)]).toEqual([200, 200, 1]);
  });

  it("near-expiry transient failure leaves only a proactive backoff and no error", async () => {
    const env = makeHub({ secrets: new Map([["A", oauth("tok-0", START + 60_000)]]), refresh: [503] });
    const result = await advise(env);
    expect(result.status).toBe(200);
    expect(env.backoff()).toEqual({ kind: "proactive", token: "tok-0" });
    expect(errorOf(env)).toBeNull();
  });
});

describe("native joining an advisor flight (A166 J1-J4)", () => {
  async function joined(options: { expiresIn: number; refresh: number[]; advanceAfterNative?: number }) {
    const nativePost = gate();
    const advisorRead = gate();
    const env = makeHub({
      secrets: new Map([["A", oauth("tok-0", START + options.expiresIn)]]),
      script: [{ gate: nativePost, status: 401 }, 200, 200],
      refresh: options.refresh,
    });
    const nativePending = env.hub.handle(nativeRequest(), "claude");
    await tick();
    if (options.advanceAfterNative) env.advance(options.advanceAfterNative);
    env.readGates.push(advisorRead);
    const advisorPending = env.hub.handleAdvisor(advisorRequest(), "claude");
    await tick();
    expect(env.flightUse()).toBe("isolated");
    nativePost.open();
    await tick();
    advisorRead.open();
    const [nativeResponse, advisorResponse] = await Promise.all([nativePending, advisorPending]);
    await nativeResponse.text();
    await advisorResponse.text();
    return {
      native: nativeResponse.status,
      advisor: advisorResponse.status,
      stamp: advisorResponse.headers.get("x-account-pool-dispatch"),
      log: env.log,
      backoff: env.backoff(),
      error: errorOf(env),
    };
  }

  it("J1 no refresh due: the advisor flight returns tok-0; native starts its own forced refresh", async () => {
    expect(await joined({ expiresIn: 86_400_000, refresh: [200] })).toEqual({
      native: 200, advisor: 200, stamp: "sent", backoff: null, error: null,
      log: ["post:held", "read:held", "post:401:tok-0", "refresh:200", "adv-post:200:tok-0", "post:200:tok-r1"],
    });
  });

  it("J2 the advisor flight refreshes: native gets tok-r1 from the one refresh", async () => {
    expect(await joined({ expiresIn: 20 * 60_000, advanceAfterNative: 18 * 60_000, refresh: [200] })).toEqual({
      native: 200, advisor: 200, stamp: "sent", backoff: null, error: null,
      log: ["post:held", "read:held", "post:401:tok-0", "refresh:200", "adv-post:200:tok-r1", "post:200:tok-r1"],
    });
  });

  it("J3 transient advisor-flight failure: proactive backoff, then native's own forced refresh", async () => {
    expect(await joined({ expiresIn: 20 * 60_000, advanceAfterNative: 18 * 60_000, refresh: [503, 200] })).toEqual({
      native: 200, advisor: 200, stamp: "sent", backoff: null, error: null,
      log: ["post:held", "read:held", "post:401:tok-0", "refresh:503", "refresh:200", "adv-post:200:tok-0", "post:200:tok-r2"],
    });
  });

  it("J4 advisor-flight refresh 400: native gets the error, runs its rejection check, marks as today", async () => {
    expect(await joined({ expiresIn: 20 * 60_000, advanceAfterNative: 18 * 60_000, refresh: [400] })).toEqual({
      native: 401, advisor: 503, stamp: "none", backoff: null, error: "OAuth refresh failed with HTTP 400.",
      log: ["post:held", "read:held", "post:401:tok-0", "refresh:400"],
    });
  });
});

describe("advisor body read", () => {
  it("a caller abort before the body is read is a 499 stamped none", async () => {
    const env = makeHub({});
    const controller = new AbortController();
    // A closed client socket errors the request body stream and aborts the request signal.
    const body = new ReadableStream<Uint8Array>({
      pull: (stream) =>
        new Promise((resolve) => {
          controller.signal.addEventListener("abort", () => {
            stream.error(new Error("socket closed"));
            resolve();
          });
        }),
    });
    const request = new Request(`${ROUTE}/advisor/v1/messages`, {
      method: "POST",
      body,
      signal: controller.signal,
      duplex: "half",
    } as RequestInit);
    const pending = env.hub.handleAdvisor(request, "claude");
    await tick();
    controller.abort();
    const response = await pending;
    expect([response.status, response.headers.get("x-account-pool-dispatch"), env.sent.length]).toEqual([499, "none", 0]);
  });
});


// A229 finding 2: the 256 KiB cap holds before the body is buffered.
describe("advisor body bound (A229)", () => {
  function streamed(total: number) {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(stream) {
        if (pulled >= total) return stream.close();
        pulled += 65_536;
        stream.enqueue(new Uint8Array(65_536));
      },
    });
    return { body, pulled: () => pulled };
  }

  it("refuses a declared Content-Length over the cap without reading the body", async () => {
    const env = makeHub({});
    const source = streamed(10 * 1024 * 1024);
    const request = new Request(`${ROUTE}/advisor/v1/messages`, {
      method: "POST",
      body: source.body,
      headers: { "content-type": "application/json", "content-length": String(300 * 1024) },
      duplex: "half",
    } as RequestInit);
    const response = await env.hub.handleAdvisor(request, "claude");
    expect([response.status, response.headers.get("x-account-pool-dispatch"), env.sent.length]).toEqual([413, "none", 0]);
    expect(source.pulled()).toBeLessThanOrEqual(65_536);
  });

  it("stops reading a streamed body just past the cap and sends nothing", async () => {
    const env = makeHub({});
    const source = streamed(10 * 1024 * 1024);
    const request = new Request(`${ROUTE}/advisor/v1/messages`, {
      method: "POST",
      body: source.body,
      headers: { "content-type": "application/json" },
      duplex: "half",
    } as RequestInit);
    const response = await env.hub.handleAdvisor(request, "claude");
    expect([response.status, response.headers.get("x-account-pool-dispatch"), env.sent.length]).toEqual([413, "none", 0]);
    // The reader cancels after the first chunk past 256 KiB (a few 64 KiB chunks of slack for the
    // stream's own read-ahead), far from the 10 MiB on offer.
    expect(source.pulled()).toBeLessThan(512 * 1024);
  });

  it("still forwards a body at the cap", async () => {
    const env = makeHub({});
    const text = JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 1, messages: [{ role: "user", content: "x".repeat(256 * 1024 - 200) }] });
    const body = new TextEncoder().encode(text);
    expect(body.byteLength).toBeLessThanOrEqual(256 * 1024);
    const response = await env.hub.handleAdvisor(
      new Request(`${ROUTE}/advisor/v1/messages`, { method: "POST", body, headers: { "content-type": "application/json" } }),
      "claude",
    );
    expect(response.headers.get("x-account-pool-dispatch")).toBe("sent");
    expect(env.sent).toHaveLength(1);
  });
});

describe("usage ledger records (T102)", () => {
  const recorder = () => {
    const records: RequestRecord[] = [];
    return { records, ledger: { request: (record: RequestRecord) => records.push(record) } };
  };
  const summary = (record: RequestRecord) => ({
    kind: record.kind,
    provider: record.provider,
    sessionKey: record.sessionKey,
    accountId: record.accountId,
    status: record.status,
    completed: record.completed,
    usage: record.usage,
  });

  it("tags advisor traffic separately, with the usage of its response", async () => {
    const { records, ledger } = recorder();
    const usage = { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const env = makeHub({ ledger, script: [{ status: 200, body: JSON.stringify({ model: "claude-sonnet-5-5", usage }) }, 200] });
    expect((await advise(env)).status).toBe(200);
    expect((await native(env)).status).toBe(200);
    expect(records.map(summary)).toEqual([
      {
        kind: "advisor", provider: "claude", sessionKey: null, accountId: "A", status: 200, completed: true,
        usage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite5mTokens: null, cacheWrite1hTokens: null },
      },
      { kind: "native", provider: "claude", sessionKey: null, accountId: "A", status: 200, completed: true, usage: null },
    ]);
    expect(new TextDecoder().decode(records[0]?.body)).toContain("claude-sonnet-5-5");
  });

  it("records a failed attempt that is retried on another account, and the one that answered", async () => {
    const { records, ledger } = recorder();
    const env = makeHub({
      ledger,
      accounts: [account("A", "claude", "oauth", 0), account("B", "claude", "oauth", 1)],
      secrets: new Map([["A", oauth()], ["B", oauth("tok-b")]]),
      script: [529, 200],
    });
    expect((await native(env)).status).toBe(200);
    expect(records.map((record) => [record.accountId, record.status])).toEqual([["A", 529], ["B", 200]]);
  });

  it("reads Codex usage from the streamed response.completed event", async () => {
    const { records, ledger } = recorder();
    const completed = {
      type: "response.completed",
      response: { id: "r", output: [{ type: "message", content: "x".repeat(100_000) }], usage: { input_tokens: 1_000, input_tokens_details: { cached_tokens: 900 }, output_tokens: 20 } },
    };
    const sse = `event: response.created\ndata: {"type":"response.created"}\n\nevent: response.completed\ndata: ${JSON.stringify(completed)}\n\n`;
    const env = makeHub({
      ledger,
      accounts: [account("C", "codex")],
      secrets: new Map([["C", oauth()]]),
      script: [{ status: 200, headers: { "content-type": "text/event-stream" }, body: sse }],
    });
    const response = await env.hub.handle(
      new Request(`${ROUTE}/v1/responses`, {
        method: "POST",
        headers: { authorization: "Bearer hub", "content-type": "application/json", "thread-id": "codex-thread" },
        body: codexBody,
      }),
      "codex",
    );
    await response.text();
    expect(records.map(summary)).toEqual([
      {
        kind: "native", provider: "codex", sessionKey: "session:codex-thread", accountId: "C", status: 200, completed: true,
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 0, cacheWrite5mTokens: null, cacheWrite1hTokens: null },
      },
    ]);
  });

  it("records a send that failed to connect, and one canceled before its headers, exactly once", async () => {
    const { records, ledger } = recorder();
    const env = makeHub({
      ledger,
      accounts: [account("A", "claude", "oauth", 0), account("B", "claude", "oauth", 1)],
      secrets: new Map([["A", oauth()], ["B", oauth("tok-b")]]),
      script: ["fail", 200, "hang"],
    });
    expect((await native(env)).status).toBe(200);
    const controller = new AbortController();
    const pending = env.hub.handleAdvisor(advisorRequest("claude", {}, controller.signal), "claude");
    await tick();
    controller.abort();
    expect((await pending).status).toBe(499);
    expect(records.map((record) => [record.kind, record.accountId, record.status, record.completed, record.usage])).toEqual([
      ["native", "A", null, false, null],
      ["native", "B", 200, true, null],
      // The advisor prefers the active account, which the failover moved to B.
      ["advisor", "B", null, false, null],
    ]);
  });

  it("a ledger that throws never fails a request", async () => {
    const env = makeHub({
      ledger: {
        request: () => {
          throw new Error("ledger broken");
        },
      },
      script: [200, 500, 200],
    });
    expect((await native(env)).status).toBe(200);
    expect((await advise(env)).status).toBe(500);
    expect((await advise(env)).status).toBe(200);
  });
});

// Node 22's AbortSignal.any records each composite on every source and, whenever one is collected,
// walks all composites still recorded there. Per-request composites of the hub's lifetime signal
// made those walks quadratic and froze the BB server for seconds; requests now link to it with
// listeners they remove.
describe("hub lifetime signal", () => {
  const keepAliveRequest = (confirm: string | null = null) => ({
    sessionId: "s",
    accountId: "A",
    family: "sonnet" as const,
    url: "https://u.invalid/a/v1/messages",
    body: new TextEncoder().encode(claudeBody),
    headers: new Headers({ "anthropic-version": "2023-06-01" }),
    reserve: 0,
    timeoutMs: 60_000,
    confirm: async () => confirm,
  });

  it("is left with no dependants or listeners after thousands of requests", async () => {
    const env = makeHub({
      script: [
        ...Array<Reply>(1_500).fill(200),
        ...Array<Reply>(300).fill(503),
        ...Array<Reply>(100).fill("hang"),
      ],
    });
    env.quotas.set("A", { ...emptyQuota("A"), observedAt: START });
    const lifetime = (env.hub as unknown as { stopped: AbortController })
      .stopped.signal;
    const any = vi.spyOn(AbortSignal, "any");
    try {
      const statuses = new Map<number | string, number>();
      const count = (key: number | string) =>
        statuses.set(key, (statuses.get(key) ?? 0) + 1);
      for (let i = 0; i < 500; i++) count((await native(env)).status);
      for (let i = 0; i < 500; i++) count((await advise(env)).status);
      for (let i = 0; i < 500; i++)
        count((await env.hub.keepAlive(keepAliveRequest(), new AbortController().signal)).kind);
      for (let i = 0; i < 300; i++) count((await advise(env)).status);
      for (let i = 0; i < 100; i++) {
        const client = new AbortController();
        const pending = env.hub.handleAdvisor(advisorRequest("claude", {}, client.signal), "claude");
        await Promise.resolve();
        client.abort();
        count((await pending).status);
      }
      for (let i = 0; i < 100; i++)
        count((await env.hub.keepAlive(keepAliveRequest("refused"), new AbortController().signal)).kind);
      expect(Object.fromEntries(statuses)).toEqual({ 200: 1_000, response: 500, 503: 300, 499: 100, skipped: 100 });
      expect(any.mock.calls.filter(([signals]) => [...signals].includes(lifetime)).length).toBe(0);
      expect(getEventListeners(lifetime, "abort")).toEqual([]);
      expect(dependantsOf(lifetime)).toBe(0);
    } finally {
      any.mockRestore();
    }
  });

  // W195: a client listener that stops immediate propagation must not hide the abort from the hub.
  it("returns 499 for a client abort during a credential wait, despite stopImmediatePropagation", async () => {
    const env = makeHub({});
    const held = gate();
    env.readGates.push(held);
    const client = new AbortController();
    const request = new Request(nativeRequest(), { signal: client.signal });
    request.signal.addEventListener("abort", (event) => event.stopImmediatePropagation());
    const pending = env.hub.handle(request, "claude");
    await tick();
    client.abort();
    const response = await Promise.race([
      pending,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 200)),
    ]);
    expect(response?.status).toBe(499);
    held.open();
  });

  it("stop() still cancels a request waiting on its credential, and leaves no listener", async () => {
    const env = makeHub({});
    const lifetime = (env.hub as unknown as { stopped: AbortController })
      .stopped.signal;
    const held = gate();
    env.readGates.push(held);
    const pending = native(env);
    await tick();
    await env.hub.stop();
    const response = await pending;
    expect(response.status).toBe(503);
    expect(response.log).toEqual(["read:held"]);
    expect(getEventListeners(lifetime, "abort")).toEqual([]);
    held.open();
  });
});
