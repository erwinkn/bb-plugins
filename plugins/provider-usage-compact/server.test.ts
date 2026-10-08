import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";
import { providerUsageTone, type UsageSnapshot } from "./usage-schema.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("provider usage backend", () => {
  it("loads ordered provider usage independently for every machine", async () => {
    const host = createFakePluginHost({
      pluginId: "provider-usage",
      sdk: {
        hosts: {
          list: async () => [
            {
              id: "host-m4",
              name: "M4",
              type: "persistent",
              status: "connected",
              machineProviderId: "local",
              maxPermissionMode: "full",
              lastSeenAt: 1,
              lastRejectedProtocolVersion: null,
              createdAt: 1,
              updatedAt: 1,
            },
            {
              id: "host-intel",
              name: "Intel",
              type: "persistent",
              status: "disconnected",
              machineProviderId: null,
              maxPermissionMode: "full",
              lastSeenAt: 1,
              lastRejectedProtocolVersion: null,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
          experimental_listProviders: async () => [
            {
              id: "local",
              displayName: "This machine",
              description: "The bb server host.",
              icon: " Laptop ",
              logoUrl: null,
              pluginId: "local-machines",
              acceptsEmptyInputs: true,
              supportsSuspend: false,
              inputs: null,
            },
          ],
        },
        providers: {
          list: async () => [
            {
              id: "claude-code",
              displayName: "Claude Code",
              logoUrl: "/api/v1/system/providers/claude-code/logo?h=claude",
              strings: {
                signInHint: "Sign in to Claude Code.",
                expiredHint: "Sign in to Claude Code again.",
                iconTint: { light: "#D97757", dark: "#E38A6E" },
              },
            },
            {
              id: "codex",
              displayName: "Codex",
              logoUrl: "/api/v1/system/providers/codex/logo?h=codex",
            },
          ],
        },
        system: {
          usageLimits: async () => ({
            "claude-code": {
              status: "ok",
              accountEmail: "dev@example.com",
              planLabel: "Max",
              windows: [
                {
                  label: "Five-hour limit",
                  usedPercent: 82,
                  resetsAt: "2026-09-02T18:42:00.000Z",
                },
              ],
            },
            codex: { status: "unauthenticated" },
          }),
        },
      },
    });
    plugin(host.bb);

    await expect(
      host.harness.behavior.callRpc("getUsage", {
        force: false,
        machineIds: null,
        maxAgeMs: 30 * 60_000,
      }),
    ).resolves.toEqual({
      pools: [],
      detailsHref: null,
      machines: [
        {
          id: "host-m4",
          displayName: "M4",
          status: "connected",
          machineProvider: { id: "local", logoUrl: null, icon: "Laptop" },
          error: null,
          providers: [
            {
              id: "claude-code",
              displayName: "Claude Code",
              logoUrl: "/api/v1/system/providers/claude-code/logo?h=claude",
              iconGlyph: null,
              iconTint: { light: "#D97757", dark: "#E38A6E" },
              signInHint: "Sign in to Claude Code.",
              expiredHint: "Sign in to Claude Code again.",
              usage: {
                status: "ok",
                accountEmail: "dev@example.com",
                planLabel: "Max",
                windows: [
                  {
                    label: "Five-hour limit",
                    usedPercent: 82,
                    resetsAt: "2026-09-02T18:42:00.000Z",
                    cost: null,
                  },
                ],
              },
            },
            {
              id: "codex",
              displayName: "Codex",
              logoUrl: "/api/v1/system/providers/codex/logo?h=codex",
              iconGlyph: null,
              iconTint: null,
              signInHint: "Sign in to Codex, then reload usage.",
              expiredHint:
                "Your Codex session expired. Sign in again, then reload usage.",
              usage: { status: "unauthenticated" },
            },
          ],
        },
        {
          id: "host-intel",
          displayName: "Intel",
          status: "disconnected",
          machineProvider: null,
          error: null,
          providers: [
            {
              id: "claude-code",
              displayName: "Claude Code",
              logoUrl: "/api/v1/system/providers/claude-code/logo?h=claude",
              iconGlyph: null,
              iconTint: { light: "#D97757", dark: "#E38A6E" },
              signInHint: "Sign in to Claude Code.",
              expiredHint: "Sign in to Claude Code again.",
              usage: null,
            },
            {
              id: "codex",
              displayName: "Codex",
              logoUrl: "/api/v1/system/providers/codex/logo?h=codex",
              iconGlyph: null,
              iconTint: null,
              signInHint: "Sign in to Codex, then reload usage.",
              expiredHint:
                "Your Codex session expired. Sign in again, then reload usage.",
              usage: null,
            },
          ],
        },
      ],
    });
    expect(host.harness.sdk.callsTo("hosts.list")).toEqual([[]]);
    expect(host.harness.sdk.callsTo("hosts.experimental_listProviders")).toEqual([[]]);
    expect(host.harness.sdk.callsTo("providers.list")).toEqual([
      [{ hostId: "host-m4", capability: "usage" }],
      [{ hostId: "host-intel", capability: "usage" }],
    ]);
    expect(host.harness.sdk.callsTo("system.usageLimits")).toEqual([
      [{ hostId: "host-m4" }],
    ]);

    await host.harness.behavior.callRpc("getUsage", {
      force: false,
      machineIds: null,
      maxAgeMs: 30 * 60_000,
    });
    expect(host.harness.sdk.callsTo("hosts.list")).toHaveLength(2);
    expect(host.harness.sdk.callsTo("providers.list")).toHaveLength(2);
    expect(host.harness.sdk.callsTo("system.usageLimits")).toHaveLength(1);

    await host.harness.behavior.callRpc("getUsage", {
      force: true,
      machineIds: null,
      maxAgeMs: 0,
    });
    expect(host.harness.sdk.callsTo("hosts.list")).toHaveLength(3);
    expect(host.harness.sdk.callsTo("providers.list")).toHaveLength(4);
    expect(host.harness.sdk.callsTo("system.usageLimits")).toHaveLength(2);

    await host.harness.behavior.callRpc("getUsage", {
      force: true,
      machineIds: ["host-m4"],
      maxAgeMs: 0,
    });
    expect(host.harness.sdk.callsTo("providers.list")).toHaveLength(5);
    expect(host.harness.sdk.callsTo("system.usageLimits")).toHaveLength(3);
    expect(host.harness.sdk.callsTo("providers.list").at(-1)).toEqual([
      { hostId: "host-m4", capability: "usage" },
    ]);
  });

  it("marks only the affected machine dirty after thread completion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T12:00:00.000Z"));
    const host = createFakePluginHost({
      pluginId: "provider-usage",
      sdk: {
        hosts: {
          list: async () => [
            { id: "host-m4", name: "M4", status: "connected", machineProviderId: "modal" },
            { id: "host-m5", name: "M5", status: "connected" },
          ],
        },
        environments: {
          get: async () => ({ hostId: "host-m5" }),
        },
        providers: {
          list: async () => [],
        },
        system: {
          usageLimits: async () => ({}),
        },
      },
    });
    plugin(host.bb);
    // Without the experimental machine-provider listing, hosts keep an id-only record.
    await expect(
      host.harness.behavior.callRpc("getUsage", {
        force: false,
        machineIds: null,
        maxAgeMs: 30 * 60_000,
      }),
    ).resolves.toEqual({
      pools: [],
      detailsHref: null,
      machines: [
        {
          id: "host-m4",
          displayName: "M4",
          status: "connected",
          machineProvider: { id: "modal", logoUrl: null, icon: null },
          providers: [],
          error: null,
        },
        {
          id: "host-m5",
          displayName: "M5",
          status: "connected",
          machineProvider: null,
          providers: [],
          error: null,
        },
      ],
    });

    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ environmentId: "environment-m5" }),
      lastAssistantText: "done",
    });
    await host.harness.behavior.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ environmentId: "environment-m5" }),
      error: "failed",
    });
    expect(host.harness.sdk.callsTo("environments.get")).toEqual([
      [{ environmentId: "environment-m5" }],
    ]);
    expect(host.harness.sdk.callsTo("system.usageLimits")).toEqual([
      [{ hostId: "host-m4" }],
      [{ hostId: "host-m5" }],
    ]);

    vi.setSystemTime(new Date("2026-09-04T12:02:00.000Z"));
    await host.harness.behavior.callRpc("getUsage", {
      force: false,
      machineIds: null,
      maxAgeMs: 30 * 60_000,
    });

    expect(host.harness.sdk.callsTo("system.usageLimits")).toEqual([
      [{ hostId: "host-m4" }],
      [{ hostId: "host-m5" }],
      [{ hostId: "host-m5" }],
    ]);
    await host.harness.lifecycle.dispose();
  });
});

describe("pooled usage", () => {
  const host = {
    id: "host-m4",
    name: "M4",
    type: "persistent" as const,
    status: "connected" as const,
    machineProviderId: null,
    maxPermissionMode: "full" as const,
    lastSeenAt: 1,
    lastRejectedProtocolVersion: null,
    createdAt: 1,
    updatedAt: 1,
  };
  const quota = {
    fiveHourUtilization: null,
    fiveHourResetAt: null,
    fiveHourStatus: null,
    sevenDayUtilization: null,
    sevenDayResetAt: null,
    sevenDayStatus: null,
    familyWeekly: { fable: null, sonnet: null, opus: null, haiku: null, other: null },
    limitWindows: [],
    heldUntil: null,
    error: null,
  };
  const account = (overrides: Record<string, unknown>) => ({
    id: "11111111-1111-4111-8111-111111111111",
    provider: "claude",
    kind: "oauth",
    label: "Erwin",
    email: "erwin@griffe.dev",
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_20x",
    enabled: true,
    priority: 100,
    inFlight: 0,
    status: "ready",
    active: false,
    availableAt: null,
    ...quota,
    ...overrides,
  });

  function usageHost(
    callRpc: (args: { pluginId: string; method: string }) => Promise<unknown>,
    plugins: Array<{ id: string; enabled: boolean; status: string }> = [],
  ) {
    return createFakePluginHost({
      pluginId: "provider-usage-compact",
      sdk: {
        hosts: { list: async () => [host], experimental_listProviders: async () => [] },
        providers: { list: async () => [] },
        system: { usageLimits: async () => ({}) },
        plugins: { callRpc, list: async () => ({ plugins }) as never },
      },
    });
  }

  it("maps the Account Pooler's routed providers to their accounts, windows and status", async () => {
    const calls: unknown[] = [];
    const fake = usageHost(async (args) => {
      calls.push(args);
      return {
        routing: { claude: true, codex: false },
        accounts: [
          account({
            status: "exhausted",
            availableAt: Date.UTC(2026, 9, 8, 11),
            fiveHourUtilization: 1,
            fiveHourResetAt: Date.UTC(2026, 9, 8, 11),
            sevenDayUtilization: 0.69,
            sevenDayResetAt: Date.UTC(2026, 9, 10),
            familyWeekly: { ...quota.familyWeekly, fable: { utilization: 0.15, resetAt: Date.UTC(2026, 9, 10), status: "allowed", observedAt: 1, source: "header" } },
          }),
          account({ id: "22222222-2222-4222-8222-222222222222", email: null, label: "Second", active: true, sevenDayUtilization: 0.6 }),
          account({ id: "33333333-3333-4333-8333-333333333333", provider: "codex", subscriptionType: null, rateLimitTier: null }),
        ],
      };
    });
    plugin(fake.bb);
    const result = (await fake.harness.behavior.callRpc("getUsage", { force: false, machineIds: null, maxAgeMs: 0 })) as UsageSnapshot;
    expect(calls).toEqual([expect.objectContaining({ pluginId: "account-pool-local", method: "status.get", input: null })]);
    // Codex is not routed through the pool, so it keeps the machine's own usage.
    expect(result.pools).toEqual([
      {
        providerId: "claude-code",
        planLabel: "Max 20x",
        accounts: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            name: "erwin@griffe.dev",
            status: "exhausted",
            active: false,
            availableAt: "2026-10-08T11:00:00.000Z",
            error: null,
            windows: [
              { label: "5h", usedPercent: 100, resetsAt: "2026-10-08T11:00:00.000Z", cost: null },
              { label: "7d", usedPercent: 69, resetsAt: "2026-10-10T00:00:00.000Z", cost: null },
              { label: "Fable 7d", usedPercent: 15, resetsAt: "2026-10-10T00:00:00.000Z", cost: null },
            ],
          },
          {
            id: "22222222-2222-4222-8222-222222222222",
            name: "Second",
            status: "ready",
            active: true,
            availableAt: null,
            error: null,
            windows: [{ label: "7d", usedPercent: 60, resetsAt: null, cost: null }],
          },
        ],
      },
    ]);
    expect(providerUsageTone({ ...emptyProvider, id: "claude-code" }, result.pools[0]!)).toBeNull();
  });

  it("links to the Usage stats page only while that plugin runs", async () => {
    const details = async (plugins: Array<{ id: string; enabled: boolean; status: string }>) => {
      const fake = usageHost(async () => ({ routing: { claude: false, codex: false }, accounts: [] }), plugins);
      plugin(fake.bb);
      const result = (await fake.harness.behavior.callRpc("getUsage", { force: false, machineIds: null, maxAgeMs: 0 })) as UsageSnapshot;
      await fake.harness.lifecycle.dispose();
      return result.detailsHref;
    };
    expect(await details([{ id: "usage-stats", enabled: true, status: "running" }])).toBe("/plugins/usage-stats/usage");
    expect(await details([{ id: "usage-stats", enabled: false, status: "disabled" }])).toBeNull();
    expect(await details([{ id: "usage-stats", enabled: true, status: "failed" }])).toBeNull();
    expect(await details([])).toBeNull();
  });

  it("falls back to every machine's own usage without the Account Pooler", async () => {
    const fake = usageHost(async () => {
      throw new Error('Plugin "account-pool-local" is not installed.');
    });
    plugin(fake.bb);
    await expect(
      fake.harness.behavior.callRpc("getUsage", { force: false, machineIds: null, maxAgeMs: 0 }),
    ).resolves.toMatchObject({ pools: [] });
  });
});

const emptyProvider = {
  id: "codex",
  displayName: "Codex",
  logoUrl: null,
  iconGlyph: null,
  iconTint: null,
  signInHint: "Sign in.",
  expiredHint: "Sign in again.",
  usage: null,
};
