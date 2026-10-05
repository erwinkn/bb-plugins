// Cache warming through the real plugin factory on the SDK fake host: session attribution through
// thread events, native request observation, the keep-alive request itself, send-time refusals,
// account-health isolation, lifecycle cancellation, invalid settings and reload. The vendor is a
// fake fetch; BB's threads.context and the Projects context route (binding contract v1, root's
// frozen copy sha256 664c3dbe) are stubbed with their exact shapes. Nothing reaches a network or a
// model.
import fs from "node:fs/promises";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accountPoolConfigSchema, statusReportSchema } from "./contracts.js";
import {
  createAccountPoolPlugin,
  type AccountPoolPluginOptions,
} from "./server.js";
import { fakeClock } from "./testing/fake-clock.js";
import { warmingStatusSchema } from "./warming.js";
import { warmingConfigViewSchema } from "./warming-config.js";

type Host = ReturnType<typeof createFakePluginHost>;

const UPSTREAM = "https://upstream.example";
const EMPTY_USAGE_URL = "data:application/json,{}";
const MINUTE = 60_000;
const SESSION = "6f1d3c1e-1111-4111-8111-111111111111";
const CONTEXT_ROUTE = "http://127.0.0.1:38886/api/v1/plugins/projects/http/context/v1/thread";
const NATIVE_KEYS = [
  "anthropicUpstreamBaseUrl",
  "claudeMainCacheTtl",
  "codexUpstreamBaseUrl",
  "sessionAffinityIdleMinutes",
  "switchThreshold",
];
const QUOTA_HEADERS = {
  "anthropic-ratelimit-unified-5h-utilization": "0.10",
  "anthropic-ratelimit-unified-5h-status": "allowed",
};
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function nativeBody(
  ttl: "5m" | "1h" = "5m",
  turn = "first turn",
  model = "claude-opus-5-5",
  session = SESSION,
): string {
  const cacheControl =
    ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
  return JSON.stringify({
    model,
    max_tokens: 32_000,
    stream: true,
    thinking: { type: "adaptive" },
    system: [{ type: "text", text: "system", cache_control: cacheControl }],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: turn, cache_control: cacheControl }],
      },
    ],
    metadata: {
      user_id: JSON.stringify({
        device_id: "d",
        account_uuid: "11111111-1111-4111-8111-111111111111",
        session_id: session,
      }),
    },
  });
}

function sseResponse(): Response {
  const start = {
    type: "message_start",
    message: {
      id: "msg",
      model: "claude-opus-5-5",
      usage: {
        input_tokens: 4,
        cache_read_input_tokens: 80_000,
        cache_creation_input_tokens: 20_000,
        cache_creation: { ephemeral_5m_input_tokens: 20_000, ephemeral_1h_input_tokens: 0 },
        output_tokens: 1,
      },
    },
  };
  return new Response(
    `event: message_start\ndata: ${JSON.stringify(start)}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`,
    { headers: { "content-type": "text/event-stream", ...QUOTA_HEADERS } },
  );
}

interface VendorCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

type KeepAliveReply = () => Response;

function vendor() {
  const native: VendorCall[] = [];
  const keepAlive: VendorCall[] = [];
  const refreshes: string[] = [];
  const keepAliveReplies: KeepAliveReply[] = [];
  // When set, a native request waits on it before the vendor answers, so tests can overlap requests.
  const control: { holdNative: ((body: Record<string, unknown>) => Promise<void> | null) | null } = {
    holdNative: null,
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === EMPTY_USAGE_URL) return Response.json({});
    if (url.includes("/oauth/token")) {
      refreshes.push(url);
      return Response.json({ access_token: "refreshed", expires_in: 3600 });
    }
    const request = new Request(input, init);
    const body = JSON.parse(await request.text()) as Record<string, unknown>;
    const call = { url, headers: Object.fromEntries(request.headers), body };
    if (body.max_tokens === 0) {
      keepAlive.push(call);
      const reply = keepAliveReplies.shift();
      if (reply !== undefined) return reply();
      return Response.json(
        {
          id: "msg",
          type: "message",
          content: [],
          stop_reason: "max_tokens",
          usage: { input_tokens: 4, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 0, output_tokens: 0 },
        },
        { headers: QUOTA_HEADERS },
      );
    }
    native.push(call);
    await control.holdNative?.(body);
    return sseResponse();
  };
  return { native, keepAlive, refreshes, keepAliveReplies, fetch, control };
}

type Membership = Record<string, unknown> | null;

// The Projects route answers only its exact v1 path; anything else gets BB's own 404 (no version).
// A context value may be a list, consumed one read at a time (the last one repeats).
function projects(contexts: Record<string, Membership | Membership[]>) {
  const reads: Array<{ url: string; token: string | null }> = [];
  const served = new Map<string, number>();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    reads.push({ url: String(input), token: new Headers(init?.headers).get("x-bb-plugin-token") });
    if (`${url.origin}${url.pathname}` !== CONTEXT_ROUTE)
      return Response.json({ ok: false, error: "plugin \"projects\" has no GET route" }, { status: 404 });
    const threadId = url.searchParams.get("threadId") ?? "";
    const entry = contexts[threadId];
    const count = served.get(threadId) ?? 0;
    served.set(threadId, count + 1);
    const membership = Array.isArray(entry)
      ? (entry[Math.min(count, entry.length - 1)] ?? null)
      : (entry ?? null);
    return Response.json({ version: 1, threadId, observedAt: 1, membership });
  };
  return { reads, fetch };
}

function assignment(phase: string, ref = "A1") {
  return {
    ref, tasks: ["T1"], role: "work", access: "write", route: "fresh", phase, state: phase,
    cancelRequested: false, outcome: null, reportVersion: null, reportedAt: null,
    updatedAt: 1791189116571, briefChars: 10, handoff: false,
  };
}

function membership(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    initiativeId: "prj_1", initiativeName: "bb-plugins", archived: false, paused: false,
    coordinator: { threadId: "thr_coord", generation: 1 }, kind: "coordinator", role: "coordinator",
    worker: null, generation: 1, currentGeneration: 1, state: "active", former: false,
    retired: false, stopped: false, parent: null, assignment: null, next: null,
    ...overrides,
  };
}

const COORDINATOR = membership();
const WORKER = (phase: string, overrides: Record<string, unknown> = {}) =>
  membership({
    kind: "worker", role: "work", worker: "W1", parent: { forkedFrom: null, nativeParent: true },
    assignment: assignment(phase), ...overrides,
  });

interface Fixture {
  host: Host;
  clock: ReturnType<typeof fakeClock>;
  upstream: ReturnType<typeof vendor>;
  projectReads: ReturnType<typeof projects>["reads"];
  options: AccountPoolPluginOptions;
  stop: () => Promise<void>;
  sessions: Map<string, string>;
}

async function fixture(args: {
  seed?: Record<string, unknown>;
  contexts?: Record<string, Membership | Membership[]>;
  accounts?: number;
  // BB's provider session per thread, as threads.context reports it.
  sessions?: Record<string, string>;
} = {}): Promise<Fixture> {
  const sessions = new Map(Object.entries(args.sessions ?? { thr_coord: SESSION }));
  const start = Date.now();
  const clock = fakeClock(start);
  const upstream = vendor();
  const projectContext = projects(args.contexts ?? { thr_coord: COORDINATOR });
  const dataDir = await mkdtemp(path.join(tmpdir(), "bb-warming-"));
  const host = createFakePluginHost({
    pluginId: "account-pool-local",
    dataDir,
    sdk: {
      hosts: { list: async () => [{ id: "host-one", name: "One" }] },
      system: { providerStates: async () => ({ providers: [] }) },
      plugins: {
        list: async () => ({ plugins: [{ id: "account-pool-local", enabled: true }] }),
        token: async () => ({ token: "projects-token" }),
      },
      threads: {
        context: async ({ threadId }: { threadId: string }) => {
          const session = sessions.get(threadId);
          return {
            usage:
              session === undefined
                ? null
                : {
                    estimated: false,
                    modelContextWindow: 1_000_000,
                    usedTokens: 100_000,
                    snapshot: {
                      autoCompactAtTokens: null,
                      capturedAt: "2026-10-05T12:00:00.000Z",
                      categories: [],
                      contextWindowTokens: 1_000_000,
                      estimated: false,
                      model: "claude-opus-5-5",
                      providerSessionId: session,
                      providerTurnId: null,
                      usedTokens: 100_000,
                    },
                  },
          };
        },
      },
    } as never,
  });
  await host.bb.storage.kv.set("config", {
    anthropicUpstreamBaseUrl: UPSTREAM,
    codexUpstreamBaseUrl: UPSTREAM,
  });
  for (const [key, value] of Object.entries(args.seed ?? {}))
    await host.bb.storage.kv.set(key, value);
  const options: AccountPoolPluginOptions = {
    fetch: upstream.fetch,
    now: clock.now,
    warmingTimers: clock.timers,
    projectsFetch: projectContext.fetch,
    usageUrl: EMPTY_USAGE_URL,
    refreshUrl: `${UPSTREAM}/oauth/token`,
    importCredentials: async () => ({
      accessToken: "oauth-access",
      refreshToken: "oauth-refresh",
      expiresAt: start + 24 * 60 * MINUTE,
      subscriptionType: "max",
      rateLimitTier: "max_5x",
      email: "pool@example.com",
      accountUuid: "11111111-1111-4111-8111-111111111111",
    }),
  };
  await createAccountPoolPlugin(options)(host.bb);
  for (let index = 0; index < (args.accounts ?? 1); index += 1)
    await host.harness.behavior.callRpc("account.add", {
      provider: "claude",
      source: { kind: "import" },
      label: `account ${index}`,
      priority: 100 + index,
    });
  const service = host.harness.behavior.runService("hub");
  await vi.waitFor(async () => {
    const result = await host.harness.behavior.runCli(["status", "--json"]);
    expect(statusReportSchema.parse(JSON.parse(result.stdout)).accepting).toBe(true);
  });
  const stop = async () => {
    service.controller.abort();
    await service.done;
  };
  cleanups.push(async () => {
    await stop();
    await host.harness.lifecycle.dispose();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { host, clock, upstream, projectReads: projectContext.reads, options, stop, sessions };
}

// What BB does when a Claude thread starts a turn.
async function active(host: Host, threadId = "thr_coord") {
  const result = await host.harness.behavior.emitThreadEvent("thread.active", {
    thread: { id: threadId, providerId: "claude-code" } as never,
  });
  expect(result.errors).toEqual([]);
}

// What BB does on a Claude thread's lifecycle event; the plugin links the thread to its session.
async function idle(host: Host, threadId = "thr_coord") {
  const result = await host.harness.behavior.emitThreadEvent("thread.idle", {
    thread: { id: threadId, providerId: "claude-code" } as never,
    lastAssistantText: null,
  });
  expect(result.errors).toEqual([]);
}

async function env(host: Host, threadId = "thr_coord") {
  return host.harness.behavior.resolveProviderEnv("claude-code", {
    threadId,
    projectId: "project-one",
    hostId: "host-one",
  });
}

async function nativeRequest(
  host: Host,
  options: { ttl?: "5m" | "1h"; path?: string; turn?: string; model?: string; session?: string } = {},
): Promise<number> {
  const token = (await env(host)).find((entry) => entry.name === "ANTHROPIC_AUTH_TOKEN");
  if (token === undefined || typeof token.value !== "string") throw new Error("no token");
  const response = await host.harness.behavior.fetchHttp(
    "POST",
    options.path ?? "/v1/messages",
    {
      headers: {
        authorization: `Bearer ${token.value}`,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14",
        "user-agent": "claude-cli/2.1.287 (external, cli)",
        "x-app": "cli",
        "x-stainless-retry-count": "0",
      },
      body: nativeBody(options.ttl, options.turn, options.model, options.session),
    },
  );
  await response.text();
  return response.status;
}

async function warmingStatus(host: Host) {
  return warmingStatusSchema.parse(await host.harness.behavior.callRpc("warming.status", null));
}

// A lease starts only after the link and classification reads settle; wait for it before moving
// the fake clock.
async function leased(host: Host, count = 1) {
  await vi.waitFor(async () => expect((await warmingStatus(host)).leases).toHaveLength(count));
}

async function setMode(host: Host, mode: "off" | "observe" | "warm") {
  const result = await host.harness.behavior.runCli(["warming", "set", "mode", mode]);
  expect(result.exitCode).toBe(0);
}

async function quota(host: Host) {
  const status = statusReportSchema.parse(
    JSON.parse((await host.harness.behavior.runCli(["status", "--json"])).stdout),
  );
  return status.accounts;
}

// BB 0.43.1's merge of host and plugin env entries, copied from server/dist/start-server.js
// (sha256 2265fa22): a plugin entry replaces a host entry of the same name. The claude-code
// provider then spreads plugin entries over the daemon's process.env (buildSessionEnv).
function mergeHostAndProviderEnvironment(
  host: Array<{ name: string }>,
  provider: Array<{ name: string }>,
) {
  const providerNames = new Set(provider.map((entry) => entry.name));
  return [...host.filter((entry) => !providerNames.has(entry.name)), ...provider];
}

describe("cache warming defaults and native environment", () => {
  it("is off on install: no observation, native traffic unchanged", async () => {
    const f = await fixture();
    expect(warmingConfigViewSchema.parse(await f.host.harness.behavior.callRpc("warming.get", null))).toMatchObject({
      config: { mode: "off", coordinatorMinutes: 20, workerActiveMinutes: 15, workerReportedMinutes: 10, workerAcceptedMinutes: 0, workerEndedMinutes: 0, standaloneMinutes: 0 },
      error: null,
    });
    expect(await nativeRequest(f.host)).toBe(200);
    await idle(f.host);
    expect((await warmingStatus(f.host)).totals.nativeObserved).toBe(0);
    await f.clock.advanceTo(60 * MINUTE);
    expect(f.upstream.keepAlive).toHaveLength(0);
    expect(f.projectReads).toHaveLength(0);
    expect((await f.host.harness.behavior.runCli(["status"])).stdout).toContain("Cache warming: off");
    expect(await f.host.bb.storage.kv.get("warming-config")).toBeUndefined();
  });

  it("adds no environment entry in any mode, so a configured ANTHROPIC_CUSTOM_HEADERS survives", async () => {
    const f = await fixture();
    const strip = (entries: Awaited<ReturnType<typeof env>>) =>
      entries.map((entry) => ({ name: entry.name, value: entry.value }));
    const off = strip(await env(f.host));
    for (const mode of ["observe", "warm"] as const) {
      await setMode(f.host, mode);
      expect(strip(await env(f.host))).toEqual(off);
    }
    expect(off.map((entry) => entry.name)).not.toContain("ANTHROPIC_CUSTOM_HEADERS");
    const hostSetting = { name: "ANTHROPIC_CUSTOM_HEADERS", value: "X-Team: platform" };
    expect(mergeHostAndProviderEnvironment([hostSetting], await env(f.host))).toContainEqual(hostSetting);
  });
});

describe("cache warming through the hub", () => {
  it("links the thread from BB's session record and sends one keep-alive per due time", async () => {
    const f = await fixture();
    await setMode(f.host, "warm");
    expect(await nativeRequest(f.host)).toBe(200);
    // Until BB links the session, the request waits without a lease slot.
    await vi.waitFor(async () =>
      expect((await warmingStatus(f.host)).admissions).toMatchObject([{ sessionId: SESSION, threadId: null, state: "linking" }]),
    );
    expect((await warmingStatus(f.host)).leases).toEqual([]);
    await idle(f.host);
    await leased(f.host);
    expect((await warmingStatus(f.host)).leases[0]).toMatchObject({
      sessionId: SESSION, threadId: "thr_coord", ttl: "5m", prefixTokens: 100_000, dryRun: false,
    });

    await f.clock.advanceTo(4 * MINUTE);
    await vi.waitFor(() => expect(f.upstream.keepAlive).toHaveLength(1));
    const call = f.upstream.keepAlive[0];
    const { stream: _stream, max_tokens: _max, ...prefix } = JSON.parse(nativeBody()) as Record<string, unknown>;
    expect(call?.url).toBe(f.upstream.native[0]?.url);
    expect(call?.body).toEqual({ ...prefix, max_tokens: 0 });
    expect(call?.headers).toEqual({
      accept: call?.headers.accept,
      "content-type": "application/json",
      "content-length": call?.headers["content-length"],
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14",
      authorization: "Bearer oauth-access",
      "user-agent": "bb-account-pool-warming",
    });
    // Exact v1 route and token: once to admit the lease, once at the timer (the 30 s cache has
    // expired by then) and once fresh right before the send.
    expect(f.projectReads).toEqual([
      { url: `${CONTEXT_ROUTE}?threadId=thr_coord`, token: "projects-token" },
      { url: `${CONTEXT_ROUTE}?threadId=thr_coord`, token: "projects-token" },
      { url: `${CONTEXT_ROUTE}?threadId=thr_coord`, token: "projects-token" },
    ]);
    await vi.waitFor(async () =>
      expect((await warmingStatus(f.host)).totals.refreshesConfirmed).toBe(1),
    );
    const [account] = await quota(f.host);
    expect(account?.lastUsedHostId).toBe("host-one");
  });

  it("does not observe count_tokens, and a 1h native entry never leases", async () => {
    const f = await fixture();
    await setMode(f.host, "warm");
    expect(await nativeRequest(f.host, { path: "/v1/messages/count_tokens" })).toBe(200);
    expect((await warmingStatus(f.host)).totals.nativeObserved).toBe(0);
    expect(await nativeRequest(f.host, { ttl: "1h" })).toBe(200);
    await vi.waitFor(async () =>
      expect((await warmingStatus(f.host)).events.map((event) => event.message)).toContain(
        "the 1h cache entry already outlasts every warming window",
      ),
    );
    await f.clock.advanceTo(60 * MINUTE);
    expect(f.upstream.keepAlive).toHaveLength(0);
  });

  it.each([
    ["401", () => Response.json({ type: "error", error: { type: "authentication_error", message: "x" } }, { status: 401 })],
    ["429 with retry-after", () => Response.json({ type: "error", error: { type: "rate_limit_error", message: "x" } }, { status: 429, headers: { "retry-after": "120" } })],
    ["529", () => new Response("overloaded", { status: 529 })],
  ])("a keep-alive %s never marks, holds or repairs the account", async (_name, reply) => {
    const f = await fixture();
    await setMode(f.host, "warm");
    f.upstream.keepAliveReplies.push(reply);
    await nativeRequest(f.host);
    await idle(f.host);
    await vi.waitFor(async () => expect((await warmingStatus(f.host)).leases).toHaveLength(1));
    await f.clock.advanceTo(4 * MINUTE);
    await vi.waitFor(() => expect(f.upstream.keepAlive).toHaveLength(1));
    await vi.waitFor(async () => expect((await warmingStatus(f.host)).leases).toHaveLength(0));
    await f.clock.advanceTo(60 * MINUTE);
    expect(f.upstream.keepAlive).toHaveLength(1);
    expect(f.upstream.refreshes).toHaveLength(0);
    const [account] = await quota(f.host);
    expect([account?.error, account?.heldUntil, account?.status]).toEqual([null, null, "ready"]);
    expect(await nativeRequest(f.host, { turn: "next turn" })).toBe(200);
  });

  it("never re-sends to another account when the lease's account becomes ineligible", async () => {
    const f = await fixture({ accounts: 2 });
    await setMode(f.host, "warm");
    await nativeRequest(f.host);
    await idle(f.host);
    await vi.waitFor(async () => expect((await warmingStatus(f.host)).leases).toHaveLength(1));
    const leaseAccount = (await warmingStatus(f.host)).leases[0]?.accountId;
    await f.host.harness.behavior.callRpc("account.disable", { id: leaseAccount });
    await f.clock.advanceTo(30 * MINUTE);
    expect(f.upstream.keepAlive).toHaveLength(0);
    await vi.waitFor(async () =>
      expect((await warmingStatus(f.host)).events.at(-1)?.message).toBe(
        "refresh not sent: the account is not eligible (disabled, not OAuth, error, held, or at the warming reserve)",
      ),
    );
  });

  it.each([
    ["no Projects record (standalone or unlinked)", null, "skipped: Projects has no record of this thread; a standalone thread cannot be told from an unknown or unlinked one"],
    ["an adhoc thread", membership({ kind: "adhoc", role: "adhoc", generation: null, currentGeneration: null }), "no warming window for adhoc Initiative thread"],
    ["an archived Initiative", membership({ archived: true }), "no warming window for archived Initiative"],
    ["a delivered assignment pending", WORKER("pending"), "no warming window for assignment A1 pending delivery"],
    ["an undelivered next assignment", WORKER("reported", { next: assignment("pending", "A2") }), "no warming window for next assignment A2 not delivered yet"],
    ["a former coordinator", membership({ state: "former", former: true }), "no warming window for coordinator former"],
  ])("sends nothing for %s", async (_name, context, message) => {
    const f = await fixture({ contexts: { thr_coord: context }, seed: { "warming-config": { mode: "warm", standaloneMinutes: 30 } } });
    await nativeRequest(f.host);
    await idle(f.host);
    // Classified at admission: no lease slot, no retained body.
    await vi.waitFor(async () =>
      expect((await warmingStatus(f.host)).events.at(-1)?.message).toBe(message),
    );
    expect(await warmingStatus(f.host)).toMatchObject({ leases: [], admissions: [], retainedBodyBytes: 0 });
    await f.clock.advanceTo(30 * MINUTE);
    expect(f.upstream.keepAlive).toHaveLength(0);
  });

  it("refuses at send time when the cached classification said reported but the fresh read says retired", async () => {
    const f = await fixture({
      contexts: { thr_coord: [WORKER("reported"), WORKER("reported"), WORKER("reported", { state: "retired", retired: true })] },
    });
    await setMode(f.host, "warm");
    await nativeRequest(f.host);
    await idle(f.host);
    await leased(f.host);
    await f.clock.advanceTo(30 * MINUTE);
    expect(f.upstream.keepAlive).toHaveLength(0);
    await vi.waitFor(async () =>
      expect((await warmingStatus(f.host)).events.at(-1)?.message).toBe(
        "refresh not sent: no warming window for work retired",
      ),
    );
    // Admission, timer classification, then the fresh send-time read that refuses.
    expect(f.projectReads).toHaveLength(3);
  });

  it("a thread with no record first, then linked, warms only once Projects has the record", async () => {
    const f = await fixture({ contexts: { thr_coord: [null, COORDINATOR] } });
    await setMode(f.host, "warm");
    await nativeRequest(f.host);
    await idle(f.host);
    await f.clock.advanceTo(10 * MINUTE);
    expect(f.upstream.keepAlive).toHaveLength(0);
    await nativeRequest(f.host, { turn: "second turn" });
    await idle(f.host);
    await f.clock.advanceTo(15 * MINUTE);
    await vi.waitFor(() => expect(f.upstream.keepAlive).toHaveLength(1));
    expect(JSON.stringify(f.upstream.keepAlive[0]?.body)).toContain("second turn");
  });

  it("refuses at send time when BB reports a newer session for the thread", async () => {
    const f = await fixture();
    await setMode(f.host, "warm");
    await nativeRequest(f.host);
    await idle(f.host);
    await leased(f.host);
    f.sessions.set("thr_coord", "7f1d3c1e-2222-4222-8222-222222222222");
    await f.clock.advanceTo(30 * MINUTE);
    expect(f.upstream.keepAlive).toHaveLength(0);
    await vi.waitFor(async () =>
      expect((await warmingStatus(f.host)).events.at(-1)?.message).toBe(
        "refresh not sent: the thread moved to a newer Claude session",
      ),
    );
  });

  it("observe mode links and plans but never sends a keep-alive", async () => {
    const f = await fixture();
    await setMode(f.host, "observe");
    await nativeRequest(f.host);
    await idle(f.host);
    await vi.waitFor(async () => expect((await warmingStatus(f.host)).leases[0]?.dryRun).toBe(true));
    await f.clock.advanceTo(60 * MINUTE);
    await vi.waitFor(async () => expect((await warmingStatus(f.host)).totals.refreshesPlanned).toBe(4));
    expect(f.upstream.keepAlive).toHaveLength(0);
    expect((await warmingStatus(f.host)).retainedBodyBytes).toBe(0);
  });
});

describe("cache warming lifecycle", () => {
  it("thread archival and turning warming off cancel leases", async () => {
    const f = await fixture();
    await setMode(f.host, "warm");
    await nativeRequest(f.host);
    await idle(f.host);
    await vi.waitFor(async () => expect((await warmingStatus(f.host)).leases).toHaveLength(1));
    await f.host.harness.behavior.emitThreadEvent("thread.archived", {
      thread: { id: "thr_coord", providerId: "claude-code" } as never,
    });
    expect((await warmingStatus(f.host)).leases).toHaveLength(0);
    expect((await warmingStatus(f.host)).events.at(-1)?.message).toBe("thread archived");
    await nativeRequest(f.host, { turn: "again" });
    await idle(f.host);
    await leased(f.host);
    await setMode(f.host, "off");
    expect((await warmingStatus(f.host)).leases).toHaveLength(0);
    await f.clock.advanceTo(60 * MINUTE);
    expect(f.upstream.keepAlive).toHaveLength(0);
  });

  it("reload disposes timers and request bodies; the new instance starts empty", async () => {
    const f = await fixture();
    await setMode(f.host, "warm");
    await nativeRequest(f.host);
    await idle(f.host);
    await leased(f.host);
    expect((await warmingStatus(f.host)).retainedBodyBytes).toBeGreaterThan(0);
    expect(f.clock.pendingAt()).toHaveLength(1);
    await f.stop();
    const reloaded = await f.host.harness.lifecycle.reload(createAccountPoolPlugin(f.options));
    expect(f.clock.pendingAt()).toEqual([]);
    expect(await warmingStatus(reloaded)).toMatchObject({ mode: "warm", leases: [], retainedBodyBytes: 0 });
    await f.clock.advanceTo(60 * MINUTE);
    expect(f.upstream.keepAlive).toHaveLength(0);
  });
});

describe("cache warming settings", () => {
  it("an invalid stored record turns warming off visibly and native keeps running", async () => {
    const f = await fixture({ seed: { "warming-config": { mode: "warm", coordinatorMinutes: 90 } } });
    const view = warmingConfigViewSchema.parse(await f.host.harness.behavior.callRpc("warming.get", null));
    expect(view.config.mode).toBe("off");
    expect(view.error).toBe(
      "Stored warming-config is invalid, so cache warming is off: coordinatorMinutes: Must be at most 60.",
    );
    expect(f.host.harness.inspection.logEntries).toContainEqual({ level: "warn", message: view.error });
    expect((await f.host.harness.behavior.runCli(["status"])).stdout).toContain(`Cache warming: off (${view.error})`);
    expect(await nativeRequest(f.host)).toBe(200);
    expect(await f.host.bb.storage.kv.get("warming-config")).toEqual({ mode: "warm", coordinatorMinutes: 90 });
    // A set over the invalid record starts from the defaults, so warming stays off.
    const repaired = await f.host.harness.behavior.runCli(["warming", "set", "coordinatorMinutes", "25"]);
    expect(repaired.exitCode).toBe(0);
    expect(warmingConfigViewSchema.parse(await f.host.harness.behavior.callRpc("warming.get", null))).toMatchObject({
      config: { mode: "off", coordinatorMinutes: 25 },
      error: null,
    });
  });

  it("CLI and RPC apply the same validation, and native config keeps its five keys", async () => {
    const f = await fixture();
    const cli = await f.host.harness.behavior.runCli(["warming", "set", "coordinatorMinutes", "61"]);
    expect(cli.exitCode).toBe(1);
    expect(cli.stderr).toContain("Must be at most 60.");
    await expect(f.host.harness.behavior.callRpc("warming.set", { coordinatorMinutes: 61 })).rejects.toThrow();
    const families = await f.host.harness.behavior.runCli(["warming", "set", "families", "opus,sonnet"]);
    expect(families.stdout).toContain("families: opus,sonnet");
    const bad = await f.host.harness.behavior.runCli(["warming", "set", "families", "opus,gpt"]);
    expect(bad.exitCode).toBe(1);
    const reserve = await f.host.harness.behavior.runCli(["warming", "set", "quotaReserve", "null"]);
    expect(reserve.stdout).toContain("effectiveQuotaReserve: 0.98");
    await f.host.harness.behavior.runCli(["config", "set", "switchThreshold", "0.9"]);
    const record = (await f.host.bb.storage.kv.get("config")) as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual(NATIVE_KEYS);
    expect(accountPoolConfigSchema.safeParse(record).success).toBe(true);
    expect((await f.host.harness.behavior.runCli(["warming", "status"])).stdout).toContain("No active leases.");
  });
});

// A231: the A227 findings through the real factory, hub and thread events. Each failed on A224.
const REVIEWER = (phase: string) =>
  membership({
    kind: "worker", role: "review", worker: "W2", parent: { forkedFrom: null, nativeParent: true },
    assignment: { ...assignment(phase), role: "review", access: "read-only" },
  });
const OTHER_SESSION = "7f1d3c1e-2222-4222-8222-222222222222";

async function lastMessage(host: Host) {
  return (await warmingStatus(host)).events.at(-1)?.message;
}

describe("A227 corrections through the hub", () => {
  it("1: a same-session Sonnet request ends the Opus lease, so the old body is never re-sent", async () => {
    const f = await fixture();
    await setMode(f.host, "warm");
    await nativeRequest(f.host);
    await idle(f.host);
    await vi.waitFor(async () => expect((await warmingStatus(f.host)).leases).toHaveLength(1));
    expect(await nativeRequest(f.host, { model: "claude-sonnet-5-5", turn: "sonnet turn" })).toBe(200);
    await vi.waitFor(async () => expect((await warmingStatus(f.host)).leases).toHaveLength(0));
    await f.clock.advanceTo(30 * MINUTE);
    expect(f.upstream.keepAlive).toHaveLength(0);
  });

  it("2: a reviewer gets reviewerMinutes (default 0), not the worker windows", async () => {
    const f = await fixture({ contexts: { thr_coord: REVIEWER("active") } });
    await setMode(f.host, "warm");
    await nativeRequest(f.host);
    await idle(f.host);
    await vi.waitFor(async () => expect(await lastMessage(f.host)).toBe("no warming window for reviewer mid-assignment"));
    await f.clock.advanceTo(30 * MINUTE);
    expect(f.upstream.keepAlive).toHaveLength(0);
    expect((await f.host.harness.behavior.runCli(["warming", "set", "reviewerMinutes", "10"])).exitCode).toBe(0);
    await nativeRequest(f.host, { turn: "second" });
    await idle(f.host);
    await leased(f.host);
    // A 10-minute window from the 30-minute request: refreshes at 34 and 38 minutes.
    await f.clock.advanceTo(34 * MINUTE);
    await vi.waitFor(async () => expect((await warmingStatus(f.host)).totals.refreshesConfirmed).toBe(1));
    await f.clock.advanceTo(60 * MINUTE);
    await vi.waitFor(async () => expect((await warmingStatus(f.host)).totals.refreshesConfirmed).toBe(2));
    await f.clock.advanceTo(90 * MINUTE);
    expect(f.upstream.keepAlive).toHaveLength(2);
  });

  it("4: a thread that can never warm does not take the only lease slot from the coordinator", async () => {
    const f = await fixture({
      seed: { "warming-config": { mode: "warm", maxLeases: 1, standaloneMinutes: 30 } },
      contexts: { thr_solo: null, thr_coord: COORDINATOR },
      sessions: { thr_solo: OTHER_SESSION, thr_coord: SESSION },
    });
    await nativeRequest(f.host, { session: OTHER_SESSION, turn: "solo" });
    await idle(f.host, "thr_solo");
    await nativeRequest(f.host, { turn: "coordinator" });
    await idle(f.host);
    await vi.waitFor(async () =>
      expect((await warmingStatus(f.host)).leases.map((lease) => lease.threadId)).toEqual(["thr_coord"]),
    );
    await f.clock.advanceTo(4 * MINUTE);
    await vi.waitFor(() => expect(f.upstream.keepAlive).toHaveLength(1));
    expect(JSON.stringify(f.upstream.keepAlive[0]?.body)).toContain("coordinator");
  });

  it("5: removing the family in Settings ends the lease at once", async () => {
    const f = await fixture();
    await setMode(f.host, "warm");
    await nativeRequest(f.host);
    await idle(f.host);
    await vi.waitFor(async () => expect((await warmingStatus(f.host)).leases).toHaveLength(1));
    expect((await f.host.harness.behavior.runCli(["warming", "set", "families", "sonnet"])).exitCode).toBe(0);
    expect((await warmingStatus(f.host)).leases).toHaveLength(0);
    expect(await lastMessage(f.host)).toBe("model family opus is no longer enabled for warming");
    await f.clock.advanceTo(30 * MINUTE);
    expect(f.upstream.keepAlive).toHaveLength(0);
  });

  it("7: thread.active ends the lease before the stale snapshot re-links; a new unlinked session never revives it", async () => {
    const f = await fixture();
    await setMode(f.host, "warm");
    await nativeRequest(f.host);
    await idle(f.host);
    await vi.waitFor(async () => expect((await warmingStatus(f.host)).leases).toHaveLength(1));
    // BB's snapshot still names the old session while the new turn runs on another one.
    await active(f.host);
    expect((await warmingStatus(f.host)).leases).toHaveLength(0);
    await nativeRequest(f.host, { session: OTHER_SESSION, turn: "new session" });
    await f.clock.advanceTo(30 * MINUTE);
    expect(f.upstream.keepAlive).toHaveLength(0);
  });

  it("D357: a paused Initiative is not warmed by default", async () => {
    const f = await fixture({ contexts: { thr_coord: membership({ paused: true }) } });
    await setMode(f.host, "warm");
    await nativeRequest(f.host);
    await idle(f.host);
    await vi.waitFor(async () => expect(await lastMessage(f.host)).toBe("no warming window for paused Initiative"));
    await f.clock.advanceTo(30 * MINUTE);
    expect(f.upstream.keepAlive).toHaveLength(0);
  });

  it("settings: an older record gains the new defaults; CLI and RPC validate the new keys", async () => {
    const f = await fixture({ seed: { "warming-config": { mode: "observe", coordinatorMinutes: 20 } } });
    expect(warmingConfigViewSchema.parse(await f.host.harness.behavior.callRpc("warming.get", null))).toMatchObject({
      config: { mode: "observe", reviewerMinutes: 0, pauseStopsWarming: true },
      error: null,
    });
    const off = await f.host.harness.behavior.runCli(["warming", "set", "pauseStopsWarming", "off"]);
    expect(off.stdout).toContain("pauseStopsWarming: false");
    expect((await f.host.harness.behavior.runCli(["warming", "set", "pauseStopsWarming", "maybe"])).exitCode).toBe(1);
    expect((await f.host.harness.behavior.runCli(["warming", "set", "reviewerMinutes", "61"])).exitCode).toBe(1);
    await expect(f.host.harness.behavior.callRpc("warming.set", { reviewerMinutes: -1 })).rejects.toThrow();
    await f.host.harness.behavior.callRpc("warming.set", { reviewerMinutes: 5 });
    expect(await f.host.bb.storage.kv.get("warming-config")).toMatchObject({ reviewerMinutes: 5, pauseStopsWarming: false });
  });
});

describe("D362: reviewerAcceptedMinutes through the hub", () => {
  it("an old record defaults it to 0; worker grace leaves accepted reviewers cold; CLI, RPC and storage set it", async () => {
    const f = await fixture({
      seed: { "warming-config": { mode: "warm", workerAcceptedMinutes: 10 } },
      contexts: { thr_coord: REVIEWER("accepted") },
    });
    expect(warmingConfigViewSchema.parse(await f.host.harness.behavior.callRpc("warming.get", null))).toMatchObject({
      config: { workerAcceptedMinutes: 10, reviewerAcceptedMinutes: 0 },
      error: null,
    });
    await nativeRequest(f.host);
    await idle(f.host);
    await vi.waitFor(async () => expect(await lastMessage(f.host)).toBe("no warming window for reviewer accepted"));
    expect((await f.host.harness.behavior.runCli(["warming", "set", "reviewerAcceptedMinutes", "61"])).exitCode).toBe(1);
    const set = await f.host.harness.behavior.runCli(["warming", "set", "reviewerAcceptedMinutes", "10"]);
    expect(set.stdout).toContain("reviewerAcceptedMinutes: 10");
    expect(await f.host.bb.storage.kv.get("warming-config")).toMatchObject({ workerAcceptedMinutes: 10, reviewerAcceptedMinutes: 10 });
    await nativeRequest(f.host, { turn: "second" });
    await idle(f.host);
    await leased(f.host);
    await f.clock.advanceTo(4 * MINUTE);
    await vi.waitFor(async () => expect((await warmingStatus(f.host)).totals.refreshesConfirmed).toBe(1));
    // A hot change back to 0 refuses the next refresh.
    await f.host.harness.behavior.callRpc("warming.set", { reviewerAcceptedMinutes: 0 });
    await f.clock.advanceTo(30 * MINUTE);
    await vi.waitFor(async () => expect((await warmingStatus(f.host)).leases).toHaveLength(0));
    expect(f.upstream.keepAlive).toHaveLength(1);
  });
});

describe("A234 1 through the hub: a finished helper does not suppress the final Opus lease", () => {
  for (const order of ["helper starts after Opus", "helper starts first"] as const) {
    it(order, async () => {
      const f = await fixture();
      await setMode(f.host, "warm");
      await idle(f.host);
      let release = () => undefined as void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.upstream.control.holdNative = (body) =>
        String(body.model).startsWith("claude-opus") ? held : null;
      const haiku = () => nativeRequest(f.host, { model: "claude-haiku-4-5", turn: "tool summary" });
      let opus: Promise<number>;
      if (order === "helper starts first") {
        const helper = haiku();
        opus = nativeRequest(f.host, { turn: "final" });
        await vi.waitFor(() => expect(f.upstream.native).toHaveLength(2));
        expect(await helper).toBe(200);
      } else {
        opus = nativeRequest(f.host, { turn: "final" });
        await vi.waitFor(() => expect(f.upstream.native).toHaveLength(1));
        expect(await haiku()).toBe(200);
      }
      expect((await warmingStatus(f.host)).leases).toHaveLength(0);
      release();
      expect(await opus).toBe(200);
      await idle(f.host);
      await leased(f.host);
      await f.clock.advanceTo(4 * MINUTE);
      await vi.waitFor(() => expect(f.upstream.keepAlive).toHaveLength(1));
      expect(JSON.stringify(f.upstream.keepAlive[0]?.body)).toContain("final");
    });
  }
});

describe("usage ledger through the plugin", () => {
  type Row = Record<string, unknown>;
  const rows = (f: Fixture, table: string): Row[] =>
    f.host.bb.storage.database().prepare(`SELECT * FROM ${table} ORDER BY at, rowid`).all() as Row[];

  it("records native and refresh requests, settings and quota history, and reports them", async () => {
    const f = await fixture();
    const start = f.clock.now();
    await setMode(f.host, "warm");
    expect(await nativeRequest(f.host)).toBe(200);
    await idle(f.host);
    await leased(f.host);
    await f.clock.advanceTo(4 * MINUTE);
    await vi.waitFor(async () => expect((await warmingStatus(f.host)).totals.refreshesConfirmed).toBe(1));
    // The second refresh would be due at 8 minutes; the next turn comes first.
    await f.clock.advanceTo(7 * MINUTE);
    await active(f.host);
    expect(await nativeRequest(f.host, { turn: "second turn" })).toBe(200);
    // Token counting is not a model request.
    expect(await nativeRequest(f.host, { path: "/v1/messages/count_tokens" })).toBe(200);
    await vi.waitFor(() => expect(rows(f, "usage_requests")).toHaveLength(3));
    const shared = {
      provider: "claude", session_key: `session:${SESSION}`, model: "claude-opus-5-5", family: "opus",
      ttl: "5m", status: 200, completed: 1,
    };
    expect(rows(f, "usage_requests")).toMatchObject([
      { ...shared, at: start, kind: "native", idle_gap_ms: null,
        input_tokens: 4, output_tokens: 9, cache_read_tokens: 80_000, cache_write_tokens: 20_000,
        cache_write_5m_tokens: 20_000, cache_write_1h_tokens: 0 },
      { ...shared, kind: "refresh", thread_id: "thr_coord", role: "coordinator", idle_gap_ms: null,
        output_tokens: 0, cache_read_tokens: 100_000, cache_write_tokens: 0 },
      { ...shared, at: start + 7 * MINUTE, kind: "native", thread_id: "thr_coord", role: "coordinator",
        idle_gap_ms: 7 * MINUTE },
    ]);
    // Every response carried the same quota headers: one history row.
    expect(rows(f, "usage_quota")).toMatchObject([{ five_hour_utilization: 0.1 }]);
    await f.clock.advanceTo(10 * MINUTE);
    expect((await f.host.harness.behavior.runCli(["config", "set", "claudeMainCacheTtl", "5m"])).exitCode).toBe(0);
    await vi.waitFor(() =>
      expect(
        rows(f, "usage_settings").map((row) => {
          const settings = JSON.parse(String(row.settings_json));
          return [settings.claudeMainCacheTtl, settings.warming.mode];
        }),
      ).toEqual([["1h", "off"], ["1h", "warm"], ["5m", "warm"]]),
    );

    const report = JSON.parse((await f.host.harness.behavior.runCli(["usage", "report", "--json"])).stdout);
    expect(report.total.claude.native.requests).toBe(2);
    expect(report.total.claude.refresh.requests).toBe(1);
    expect(report.total.idle).toMatchObject({ afterExpiry: 1, rewritesAvoided: 1, rewriteTokensAvoided: 80_000 });
    expect(report.periods.map((period: { settings: { warming: { mode: string } } }) => period.settings.warming.mode)).toEqual(["warm"]);
    expect(report.ledger).toMatchObject({ writeErrors: 0, retentionDays: 30 });
    const text = (await f.host.harness.behavior.runCli(["usage", "report", "--since", "1h"])).stdout;
    expect(text).toContain("ttl 1h · warming warm (opus; coordinator 20m, worker 15/10m)");
    expect(text).toContain("account 0: 3 req");
  });

  it("a failing ledger write never fails or changes a request", async () => {
    const f = await fixture();
    f.host.bb.storage
      .database()
      .exec("CREATE TRIGGER usage_full BEFORE INSERT ON usage_requests BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    expect(await nativeRequest(f.host)).toBe(200);
    expect(await nativeRequest(f.host, { turn: "next" })).toBe(200);
    await vi.waitFor(async () => {
      const report = JSON.parse((await f.host.harness.behavior.runCli(["usage", "report", "--json"])).stdout);
      expect(report.ledger).toMatchObject({ writeErrors: 2, lastError: "disk full" });
    });
    expect(f.upstream.native).toHaveLength(2);
    // Logged once: the second failure falls inside the same minute.
    expect(
      f.host.harness.inspection.logEntries.filter((entry) => entry.message.includes("usage ledger")),
    ).toEqual([{ level: "warn", message: "Account Pooler usage ledger write failed (1 so far): disk full" }]);
  });

  it("retention is shown and set through the CLI with the shared validation", async () => {
    const f = await fixture();
    expect((await f.host.harness.behavior.runCli(["usage", "retention"])).stdout).toBe("retentionDays: 30\n");
    expect((await f.host.harness.behavior.runCli(["usage", "retention", "7"])).stdout).toBe("retentionDays: 7\n");
    expect(await f.host.bb.storage.kv.get("usage-ledger")).toEqual({ retentionDays: 7 });
    const invalid = await f.host.harness.behavior.runCli(["usage", "retention", "0"]);
    expect(invalid).toMatchObject({ exitCode: 1, stderr: "retentionDays: Must be at least 1.\n" });
  });
});
