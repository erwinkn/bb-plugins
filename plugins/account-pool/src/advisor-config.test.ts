// Advisor-config isolation against the real plugin factory and the fake host's kv. Ported from the
// accepted T76/A168 prototype tests (S1-S6). The full rollback to the pre-advisor build runs
// against a frozen copy of that build outside the plugin; here the contract it relies on is
// asserted directly: the native "config" record keeps exactly its five keys and still parses
// with the unchanged native schema.
import fs from "node:fs/promises";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  advisorConfigView,
  advisorConfigViewSchema,
  loadAdvisorConfig,
  mergeAdvisorConfig,
} from "./advisor-config.js";
import {
  accountPoolConfigSchema,
  statusReportSchema,
} from "./contracts.js";
import {
  createAccountPoolPlugin,
  type AccountPoolPluginOptions,
} from "./server.js";

type Host = ReturnType<typeof createFakePluginHost>;

const UPSTREAM = "https://upstream.example";
const EMPTY_USAGE_URL = "data:application/json,{}";
const NATIVE_KEYS = [
  "anthropicUpstreamBaseUrl",
  "claudeMainCacheTtl",
  "codexUpstreamBaseUrl",
  "sessionAffinityIdleMinutes",
  "switchThreshold",
];
const CLAUDE_BODY = JSON.stringify({
  model: "claude-sonnet-5-5",
  max_tokens: 10,
  messages: [{ role: "user", content: "x" }],
});
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function sdkStubs() {
  return {
    hosts: { list: async () => [{ id: "host-one", name: "One" }] },
    system: { providerStates: async () => ({ providers: [] }) },
    plugins: {
      list: async () => ({
        plugins: [{ id: "account-pool-local", enabled: true }],
      }),
    },
  };
}

// Vendor POSTs only: usage reads go to a data: URL and are not counted.
function vendor(reply: () => Response = () => Response.json({ model: "claude-sonnet-5-5" })) {
  const posts: Array<{ url: string; userAgent: string | null }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (String(input) === EMPTY_USAGE_URL) return Response.json({});
    const request = new Request(input, init);
    posts.push({
      url: request.url,
      userAgent: request.headers.get("user-agent"),
    });
    return reply();
  };
  return { posts, fetch };
}

function pluginOptions(
  fetch: typeof globalThis.fetch,
): AccountPoolPluginOptions {
  return {
    fetch,
    usageUrl: EMPTY_USAGE_URL,
    refreshUrl: `${UPSTREAM}/oauth/token`,
    importCredentials: async () => ({
      accessToken: "oauth-access",
      refreshToken: "oauth-refresh",
      expiresAt: Date.now() + 60 * 60 * 1_000,
      subscriptionType: "max",
      rateLimitTier: "max_5x",
      email: "pool@example.com",
      accountUuid: "11111111-1111-4111-8111-111111111111",
    }),
  };
}

async function newHost(seed: Record<string, unknown>): Promise<Host> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bb-advisor-config-"));
  const host = createFakePluginHost({
    pluginId: "account-pool-local",
    dataDir,
    sdk: sdkStubs(),
  });
  for (const [key, value] of Object.entries(seed))
    await host.bb.storage.kv.set(key, value);
  cleanups.push(async () => {
    await host.harness.lifecycle.dispose();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return host;
}

// Starts the hub service and waits until it accepts; returns a stop function.
async function serve(host: Host): Promise<() => Promise<void>> {
  const service = host.harness.behavior.runService("hub");
  await vi.waitFor(async () => {
    const result = await host.harness.behavior.runCli(["status", "--json"]);
    expect(statusReportSchema.parse(JSON.parse(result.stdout)).accepting).toBe(
      true,
    );
  });
  return async () => {
    service.controller.abort();
    await service.done;
  };
}

async function addClaudeAccount(host: Host): Promise<void> {
  await host.harness.behavior.callRpc("account.add", {
    provider: "claude",
    source: { kind: "import" },
    label: null,
    priority: 100,
  });
}

async function nativeMessage(host: Host): Promise<number> {
  const entries = await host.harness.behavior.resolveProviderEnv(
    "claude-code",
    { threadId: "thread-one", projectId: "project-one", hostId: "host-one" },
  );
  const token = entries.find((entry) => entry.name === "ANTHROPIC_AUTH_TOKEN");
  if (token === undefined || typeof token.value !== "string")
    throw new Error("No pool token resolved.");
  const response = await host.harness.behavior.fetchHttp(
    "POST",
    "/v1/messages",
    {
      headers: {
        authorization: `Bearer ${token.value}`,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: CLAUDE_BODY,
    },
  );
  await response.text();
  return response.status;
}

async function advisorMessage(
  host: Host,
  route: "messages" | "responses" = "messages",
  headers: Record<string, string> = {},
  query = "",
) {
  const response = await host.harness.behavior.fetchHttp(
    "POST",
    `/advisor/v1/${route}${query}`,
    {
      headers: { "content-type": "application/json", ...headers },
      body: CLAUDE_BODY,
    },
  );
  return {
    status: response.status,
    stamp: response.headers.get("x-account-pool-dispatch"),
    text: await response.text(),
  };
}

const advisorView = async (host: Host) =>
  advisorConfigViewSchema.parse(
    await host.harness.behavior.callRpc("advisor.get", null),
  );

describe("advisor-config isolation", () => {
  it("S1 loads a pre-advisor stored record unchanged with advisor routes off", async () => {
    const { posts, fetch } = vendor();
    const stored = {
      switchThreshold: 0.75,
      anthropicUpstreamBaseUrl: UPSTREAM,
      codexUpstreamBaseUrl: UPSTREAM,
    };
    const host = await newHost({ config: stored });
    await createAccountPoolPlugin(pluginOptions(fetch))(host.bb);
    await addClaudeAccount(host);
    const stop = await serve(host);

    expect(await host.harness.behavior.callRpc("config.get", null)).toEqual(
      accountPoolConfigSchema.parse(stored),
    );
    expect(await host.bb.storage.kv.get("advisor-config")).toBeUndefined();
    expect(await advisorView(host)).toEqual({
      routes: { claude: false, codex: false },
      maxUtilization: null,
      effectiveMaxUtilization: 0.75,
      error: null,
    });
    for (const route of ["messages", "responses"] as const) {
      const result = await advisorMessage(host, route);
      expect([result.status, result.stamp]).toEqual([403, "none"]);
    }
    expect(posts).toHaveLength(0);
    expect(await nativeMessage(host)).toBe(200);
    expect(posts).toHaveLength(1);
    await stop();
  });

  it.each([
    ["a string", "garbage"],
    ["an unknown provider", { routes: { claude: true, gemini: true } }],
    ["a reserve above 1", { routes: { claude: true }, maxUtilization: 1.5 }],
    ["a reserve of 0", { routes: { claude: true }, maxUtilization: 0 }],
  ])(
    "S2 a malformed advisor record (%s) turns advisor routes off visibly and native keeps running",
    async (_name, malformed) => {
      const { posts, fetch } = vendor();
      const host = await newHost({
        config: {
          anthropicUpstreamBaseUrl: UPSTREAM,
          codexUpstreamBaseUrl: UPSTREAM,
        },
        "advisor-config": malformed,
      });
      await createAccountPoolPlugin(pluginOptions(fetch))(host.bb);
      await addClaudeAccount(host);
      const stop = await serve(host);

      const view = await advisorView(host);
      expect(view.routes).toEqual({ claude: false, codex: false });
      expect(view.error).toMatch(
        /^Stored advisor-config is invalid, so advisor routes are off: /,
      );
      expect(host.harness.inspection.logEntries).toContainEqual({
        level: "warn",
        message: view.error,
      });
      const status = await host.harness.behavior.runCli(["status"]);
      expect(status.stdout).toContain(`Advisor routes: off (${view.error})`);
      expect(
        (await host.harness.behavior.runCli(["advisor"])).stdout,
      ).toContain(`error: ${view.error}`);

      const advisor = await advisorMessage(host);
      expect([advisor.status, advisor.stamp]).toEqual([403, "none"]);
      expect(advisor.text).toContain("advisor-config is invalid");
      expect(posts).toHaveLength(0);
      expect(await nativeMessage(host)).toBe(200);
      expect(posts).toHaveLength(1);
      // The stored record stays as it was until the owner sets a new one.
      expect(await host.bb.storage.kv.get("advisor-config")).toEqual(malformed);
      const repaired = advisorConfigViewSchema.parse(
        await host.harness.behavior.callRpc("advisor.set", {
          routes: { claude: true },
        }),
      );
      expect(repaired).toMatchObject({
        routes: { claude: true, codex: false },
        error: null,
      });
      await stop();
    },
  );

  it("S3 advisor and warming sets leave the native record with its five keys and today's schema", async () => {
    const { fetch } = vendor();
    const host = await newHost({
      config: {
        anthropicUpstreamBaseUrl: UPSTREAM,
        codexUpstreamBaseUrl: UPSTREAM,
      },
    });
    await createAccountPoolPlugin(pluginOptions(fetch))(host.bb);
    await host.harness.behavior.callRpc("advisor.set", {
      routes: { claude: true, codex: true },
      maxUtilization: 0.9,
    });
    await host.harness.behavior.callRpc("warming.set", {
      mode: "observe",
      coordinatorMinutes: 25,
    });
    const set = await host.harness.behavior.runCli([
      "config",
      "set",
      "switchThreshold",
      "0.95",
    ]);
    expect(set.exitCode).toBe(0);
    const nativeRecord = (await host.bb.storage.kv.get("config")) as Record<
      string,
      unknown
    >;
    expect(Object.keys(nativeRecord).sort()).toEqual(NATIVE_KEYS);
    expect(accountPoolConfigSchema.safeParse(nativeRecord).success).toBe(true);
    expect(await host.bb.storage.kv.get("advisor-config")).toEqual({
      routes: { claude: true, codex: true },
      maxUtilization: 0.9,
    });
    expect(await host.bb.storage.kv.get("warming-config")).toMatchObject({
      mode: "observe",
      coordinatorMinutes: 25,
    });

    // Reload the same build over the same kv: everything survives, and a native edit lowers the
    // effective reserve without touching the stored one.
    const reloaded = await host.harness.lifecycle.reload(
      createAccountPoolPlugin(pluginOptions(fetch)),
    );
    await reloaded.harness.behavior.runCli([
      "config",
      "set",
      "switchThreshold",
      "0.8",
    ]);
    expect(await advisorView(reloaded)).toEqual({
      routes: { claude: true, codex: true },
      maxUtilization: 0.9,
      effectiveMaxUtilization: 0.8,
      error: null,
    });
  });

  it("S4 lowering switchThreshold under a stored reserve is accepted and the effective reserve is shown", async () => {
    const { fetch } = vendor();
    const host = await newHost({});
    await createAccountPoolPlugin(pluginOptions(fetch))(host.bb);
    await host.harness.behavior.callRpc("advisor.set", {
      maxUtilization: 0.95,
    });
    const lowered = await host.harness.behavior.runCli([
      "config",
      "set",
      "switchThreshold",
      "0.9",
    ]);
    expect(lowered.exitCode).toBe(0);
    expect(await advisorView(host)).toMatchObject({
      maxUtilization: 0.95,
      effectiveMaxUtilization: 0.9,
    });
    expect(
      (await host.harness.behavior.runCli(["advisor"])).stdout,
    ).toContain("effectiveMaxUtilization: 0.9");

    const rejected = await host.harness.behavior.runCli([
      "advisor",
      "set",
      "maxUtilization",
      "0.95",
    ]);
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr).toContain("Must be at most switchThreshold (0.9).");
    await expect(
      host.harness.behavior.callRpc("advisor.set", { maxUtilization: 0.95 }),
    ).rejects.toThrow();
    const accepted = await host.harness.behavior.runCli([
      "advisor",
      "set",
      "maxUtilization",
      "0.85",
    ]);
    expect(accepted.exitCode).toBe(0);
    expect(accepted.stdout).toContain("effectiveMaxUtilization: 0.85");
  });

  it("S5 disabled routes, a disabled provider and compressed bodies make no vendor POST", async () => {
    const { posts, fetch } = vendor();
    const host = await newHost({
      config: {
        anthropicUpstreamBaseUrl: UPSTREAM,
        codexUpstreamBaseUrl: UPSTREAM,
      },
    });
    await createAccountPoolPlugin(pluginOptions(fetch))(host.bb);
    await addClaudeAccount(host);
    const stop = await serve(host);
    await host.harness.behavior.runCli(["advisor", "set", "claude", "on"]);

    const codexOff = await advisorMessage(host, "responses");
    expect([codexOff.status, codexOff.stamp]).toEqual([403, "none"]);
    const compressed = await advisorMessage(host, "messages", {
      "content-encoding": "gzip",
    });
    expect([compressed.status, compressed.stamp]).toEqual([415, "none"]);
    expect(posts).toHaveLength(0);

    const sent = await advisorMessage(host, "messages", {
      "user-agent": "claude-cli/2.1.287 (external, cli)",
      "x-app": "cli",
    });
    expect([sent.status, sent.stamp]).toEqual([200, "sent"]);
    expect(posts).toEqual([
      { url: `${UPSTREAM}/v1/messages`, userAgent: "bb-advisor" },
    ]);

    await host.harness.behavior.runCli(["advisor", "set", "claude", "off"]);
    const off = await advisorMessage(host);
    expect([off.status, off.stamp]).toEqual([403, "none"]);
    expect(posts).toHaveLength(1);
    expect(
      (await host.harness.behavior.runCli(["status"])).stdout,
    ).toContain("Advisor routes: off");
    await stop();
  });

  it("S5 the plugin token never reaches the vendor, and other query parameters still do", async () => {
    const { posts, fetch } = vendor();
    const host = await newHost({
      config: {
        anthropicUpstreamBaseUrl: UPSTREAM,
        codexUpstreamBaseUrl: UPSTREAM,
      },
    });
    await createAccountPoolPlugin(pluginOptions(fetch))(host.bb);
    await addClaudeAccount(host);
    const stop = await serve(host);
    await host.harness.behavior.runCli(["advisor", "set", "claude", "on"]);
    const sent = await advisorMessage(
      host,
      "messages",
      {},
      "?token=plugin-secret&beta=true",
    );
    expect([sent.status, sent.stamp]).toEqual([200, "sent"]);
    expect(posts.map((post) => post.url)).toEqual([
      `${UPSTREAM}/v1/messages?beta=true`,
    ]);
    await stop();
  });

  it("S5 the dispatch stamp overwrites a same-named vendor header", async () => {
    const { fetch } = vendor(() =>
      Response.json(
        { model: "claude-sonnet-5-5" },
        { headers: { "x-account-pool-dispatch": "none" } },
      ),
    );
    const host = await newHost({
      config: {
        anthropicUpstreamBaseUrl: UPSTREAM,
        codexUpstreamBaseUrl: UPSTREAM,
      },
      "advisor-config": { routes: { claude: true } },
    });
    await createAccountPoolPlugin(pluginOptions(fetch))(host.bb);
    await addClaudeAccount(host);
    const stop = await serve(host);
    const sent = await advisorMessage(host);
    expect([sent.status, sent.stamp]).toEqual([200, "sent"]);
    await stop();
  });

  it("S6 an invalid native record fails startup with exactly the native schema's error", async () => {
    const host = await newHost({ config: { switchThreshold: 2 } });
    const error = await createAccountPoolPlugin(pluginOptions(vendor().fetch))(
      host.bb,
    ).then(
      () => "loaded",
      (caught: unknown) =>
        caught instanceof Error ? caught.message : String(caught),
    );
    const expected = accountPoolConfigSchema.safeParse({ switchThreshold: 2 });
    expect(expected.success).toBe(false);
    expect(error).toContain("Must be at most 1.");
    expect(error).toBe(expected.error?.message);
  });
});

describe("advisor-config record rules", () => {
  it("C9 loads, merges and views records without throwing", () => {
    const empty = loadAdvisorConfig(undefined);
    expect(empty).toEqual({
      ok: true,
      config: { routes: { claude: false, codex: false }, maxUtilization: null },
    });
    for (const malformed of ["x", { routes: { gemini: true } }, { maxUtilization: 0 }]) {
      const state = loadAdvisorConfig(malformed);
      expect(state.ok).toBe(false);
      if (!state.ok) expect(state.error).toMatch(/advisor-config is invalid/);
    }
    expect(() =>
      mergeAdvisorConfig(empty, { maxUtilization: 0.95 }, 0.9),
    ).toThrow("Must be at most switchThreshold (0.9).");
    const merged = mergeAdvisorConfig(
      { ok: true, config: { routes: { claude: true, codex: false }, maxUtilization: 0.8 } },
      { routes: { codex: true } },
      0.98,
    );
    expect(merged).toEqual({ routes: { claude: true, codex: true }, maxUtilization: 0.8 });
    // An invalid stored record is replaced from defaults: routes stay off.
    expect(
      mergeAdvisorConfig({ ok: false, error: "bad" }, { maxUtilization: 0.9 }, 0.98),
    ).toEqual({ routes: { claude: false, codex: false }, maxUtilization: 0.9 });
  });
});

// A229 finding 1: a stored reserve above a later, lower switchThreshold must not lock the
// settings. Finding 3: the handler's error is plain readable text.
describe("advisor-config after the threshold drops (A229)", () => {
  const stored = {
    ok: true as const,
    config: { routes: { claude: true, codex: false }, maxUtilization: 0.9 },
  };

  it("C10 route toggles and unrelated updates still apply; only a new numeric reserve is bounded", () => {
    expect(mergeAdvisorConfig(stored, { routes: { claude: false } }, 0.8)).toEqual({
      routes: { claude: false, codex: false },
      maxUtilization: 0.9,
    });
    expect(mergeAdvisorConfig(stored, { routes: { codex: true } }, 0.8).routes).toEqual({ claude: true, codex: true });
    expect(mergeAdvisorConfig(stored, { maxUtilization: null }, 0.8).maxUtilization).toBeNull();
    expect(mergeAdvisorConfig(stored, { maxUtilization: 0.75 }, 0.8).maxUtilization).toBe(0.75);
    expect(() => mergeAdvisorConfig(stored, { maxUtilization: 0.85 }, 0.8)).toThrow(
      new Error("Must be at most switchThreshold (0.8)."),
    );
    // The effective reserve still clamps the stored 0.9.
    expect(advisorConfigView(stored, 0.8).effectiveMaxUtilization).toBe(0.8);
  });

  it("C11 rejects invalid input with readable text, not a JSON issue list", () => {
    expect(() => mergeAdvisorConfig(stored, { maxUtilization: 2 }, 0.98)).toThrow(new Error("maxUtilization: Must be at most 1."));
    expect(() =>
      mergeAdvisorConfig(stored, { routes: { gemini: true } } as never, 0.98),
    ).toThrow(new Error('routes: Unrecognized key: "gemini"'));
  });

  it("S7 the kill switch works through RPC and CLI after lowering switchThreshold", async () => {
    const { fetch } = vendor();
    const host = await newHost({});
    await createAccountPoolPlugin(pluginOptions(fetch))(host.bb);
    await host.harness.behavior.callRpc("advisor.set", { routes: { claude: true, codex: true }, maxUtilization: 0.9 });
    expect((await host.harness.behavior.runCli(["config", "set", "switchThreshold", "0.8"])).exitCode).toBe(0);
    await host.harness.behavior.callRpc("advisor.set", { routes: { claude: false } });
    const cli = await host.harness.behavior.runCli(["advisor", "set", "codex", "off"]);
    expect([cli.exitCode, cli.stderr]).toEqual([0, ""]);
    expect(await advisorView(host)).toMatchObject({
      routes: { claude: false, codex: false },
      maxUtilization: 0.9,
      effectiveMaxUtilization: 0.8,
    });
    const rejected = await host.harness.behavior.runCli(["advisor", "set", "maxUtilization", "0.85"]);
    expect([rejected.exitCode, rejected.stderr.trim()]).toEqual([1, "Must be at most switchThreshold (0.8)."]);
  });
});

describe("A234 2: readable validation through the real CLI and RPC", () => {
  const rpcError = async (host: Host, method: "advisor.set" | "warming.set", input: unknown) => {
    try {
      await host.harness.behavior.callRpc(method, input as never);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error(`${method} accepted ${JSON.stringify(input)}`);
  };

  it("structural Advisor errors read the same in the CLI and RPC, and nothing is stored", async () => {
    const { fetch } = vendor();
    const host = await newHost({});
    await createAccountPoolPlugin(pluginOptions(fetch))(host.bb);
    const cli = await host.harness.behavior.runCli(["advisor", "set", "maxUtilization", "2"]);
    expect([cli.exitCode, cli.stderr.trim()]).toEqual([1, "maxUtilization: Must be at most 1."]);
    const nan = await host.harness.behavior.runCli(["advisor", "set", "maxUtilization", "abc"]);
    expect(nan.exitCode).toBe(1);
    expect(nan.stderr).toMatch(/^maxUtilization: /u);
    expect(await rpcError(host, "advisor.set", { maxUtilization: 2 })).toBe("maxUtilization: Must be at most 1.");
    expect(await rpcError(host, "advisor.set", { maxUtilization: 0 })).toBe("maxUtilization: Must be greater than 0.");
    expect(await rpcError(host, "advisor.set", { routes: { gemini: true } })).toBe('routes: Unrecognized key: "gemini"');
    expect(await rpcError(host, "advisor.set", { routes: { claude: "yes" } })).toMatch(/^routes\.claude: /u);
    expect(await rpcError(host, "advisor.set", { extra: 1 })).toBe('Unrecognized key: "extra"');
    for (const message of [cli.stderr, nan.stderr]) expect(message.trim().startsWith("[")).toBe(false);
    expect(await host.bb.storage.kv.get("advisor-config")).toBeUndefined();
  });

  it("threshold errors stay plain and a route can still be turned off after a threshold drop", async () => {
    const { fetch } = vendor();
    const host = await newHost({});
    await createAccountPoolPlugin(pluginOptions(fetch))(host.bb);
    await host.harness.behavior.callRpc("advisor.set", { routes: { claude: true }, maxUtilization: 0.9 });
    expect((await host.harness.behavior.runCli(["config", "set", "switchThreshold", "0.8"])).exitCode).toBe(0);
    expect(await rpcError(host, "advisor.set", { maxUtilization: 0.85 })).toBe("Must be at most switchThreshold (0.8).");
    const off = await host.harness.behavior.runCli(["advisor", "set", "claude", "off"]);
    expect([off.exitCode, off.stderr]).toEqual([0, ""]);
    expect(await advisorView(host)).toMatchObject({ routes: { claude: false }, maxUtilization: 0.9, effectiveMaxUtilization: 0.8 });
  });

  it("warming settings use the same formatter in the CLI and RPC", async () => {
    const { fetch } = vendor();
    const host = await newHost({});
    await createAccountPoolPlugin(pluginOptions(fetch))(host.bb);
    const cli = await host.harness.behavior.runCli(["warming", "set", "coordinatorMinutes", "61"]);
    expect([cli.exitCode, cli.stderr.trim()]).toEqual([1, "coordinatorMinutes: Must be at most 60."]);
    expect(await rpcError(host, "warming.set", { coordinatorMinutes: 61 })).toBe("coordinatorMinutes: Must be at most 60.");
    expect(await rpcError(host, "warming.set", { families: ["gpt"] })).toMatch(/^families\.0: /u);
    expect(await rpcError(host, "warming.set", { extra: 1 })).toBe('Unrecognized key: "extra"');
    expect(await host.bb.storage.kv.get("warming-config")).toBeUndefined();
  });
});
