// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import {
  mergeAdvisorConfig,
  type AdvisorConfigSetInput,
  type AdvisorConfigView,
} from "./src/advisor-config.js";
import type { PoolStatus } from "./src/contracts.js";
import type { WarmingStatus } from "./src/warming.js";
import {
  warmingConfigSchema,
  type WarmingConfig,
  type WarmingConfigView,
} from "./src/warming-config.js";

const app = await loadPluginApp(() => import("./app"));
afterEach(() => {
  cleanup();
});

function poolStatus(): PoolStatus {
  return {
    route: "/api/v1/plugins/account-pool-local/http",
    enabledAccountCount: 0,
    inFlight: 0,
    accepting: true,
    hosts: [],
    accounts: [],
    routing: { claude: true, codex: true },
  };
}

function warmingView(
  overrides: Partial<WarmingConfig> = {},
  error: string | null = null,
): WarmingConfigView {
  return {
    config: warmingConfigSchema.parse(overrides),
    effectiveQuotaReserve: Math.min(overrides.quotaReserve ?? 0.9, 0.98),
    error,
  };
}

function warmingStatus(overrides: Partial<WarmingStatus> = {}): WarmingStatus {
  return {
    mode: "off",
    leases: [],
    admissions: [],
    totals: {
      nativeObserved: 0,
      leasesStarted: 0,
      refreshesPlanned: 0,
      refreshesSent: 0,
      refreshesConfirmed: 0,
      cacheMisses: 0,
      refreshCacheReadTokens: 0,
      refreshCacheWriteTokens: 0,
      refreshInputTokens: 0,
      refreshOutputTokens: 0,
    },
    retainedBodyBytes: 0,
    since: 0,
    events: [],
    ...overrides,
  };
}

function advisorView(overrides: Partial<AdvisorConfigView> = {}): AdvisorConfigView {
  return {
    routes: { claude: false, codex: false },
    maxUtilization: null,
    effectiveMaxUtilization: 0.98,
    error: null,
    ...overrides,
  };
}

function render(
  rpc: Record<string, (input: never) => object | null | Promise<object | null>> = {},
) {
  return renderSlot(
    app.settingsSections[0]!,
    {},
    {
      rpc: {
        "status.get": () => poolStatus(),
        "config.get": () => ({
          anthropicUpstreamBaseUrl: "https://api.anthropic.com",
          codexUpstreamBaseUrl: "https://chatgpt.com/backend-api/codex",
          switchThreshold: 0.98,
          claudeMainCacheTtl: "1h",
          sessionAffinityIdleMinutes: 60,
        }),
        "warming.get": () => warmingView(),
        "warming.status": () => warmingStatus(),
        "advisor.get": () => advisorView(),
        ...rpc,
      },
      openUrl: () => true,
    },
  );
}

async function input(slot: ReturnType<typeof render>, label: string) {
  const element = await slot.findByLabelText(label);
  if (!(element instanceof HTMLInputElement)) throw new Error(`${label} is not an input`);
  return element;
}

describe("Cache warming settings", () => {
  it("shows the off default and the requested windows", async () => {
    const slot = render();
    const mode = (await slot.findByLabelText("Cache warming mode")) as HTMLButtonElement;
    await waitFor(() => expect(mode.textContent).toContain("Off"));
    const values = await Promise.all(
      [
        "Coordinator window (minutes)",
        "Worker mid-assignment window (minutes)",
        "Worker reported window (minutes)",
        "Worker accepted window (minutes)",
        "Ended window (minutes)",
        "Reviewer window (minutes)",
        "Reviewer accepted window (minutes)",
        "Standalone thread window (minutes)",
      ].map(async (label) => (await input(slot, label)).value),
    );
    await waitFor(async () =>
      expect((await input(slot, "Coordinator window (minutes)")).value).toBe("20"),
    );
    expect(values.slice(1)).toEqual(["15", "10", "0", "0", "0", "0", "0"]);
    expect(slot.getByRole("switch", { name: "Pause stops warming" }).getAttribute("aria-checked")).toBe("true");
    expect(slot.getByRole("switch", { name: "Warm opus" }).getAttribute("aria-checked")).toBe("true");
    expect(slot.getByRole("switch", { name: "Warm sonnet" }).getAttribute("aria-checked")).toBe("false");
    expect(slot.queryByText(/matched to threads/u)).toBeNull();
    // Initiatives cannot tell a standalone thread from an unknown one, so the setting is inactive.
    expect((await input(slot, "Standalone thread window (minutes)")).disabled).toBe(true);
    expect(slot.getByText(/Inactive: Initiatives reports standalone/u)).toBeTruthy();
  });

  it("saves the reviewer window and the pause switch", async () => {
    const slot = render({
      "warming.set": (update: Partial<WarmingConfig>) => warmingView(update),
    });
    const reviewer = await input(slot, "Reviewer window (minutes)");
    await waitFor(() => expect(reviewer.disabled).toBe(false));
    fireEvent.change(reviewer, { target: { value: "61" } });
    fireEvent.blur(reviewer);
    expect(await slot.findByText("Must be at most 60.")).toBeTruthy();
    fireEvent.change(reviewer, { target: { value: "5" } });
    fireEvent.blur(reviewer);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({ method: "warming.set", input: { reviewerMinutes: 5 } }),
    );
    fireEvent.click(slot.getByRole("switch", { name: "Pause stops warming" }));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({ method: "warming.set", input: { pauseStopsWarming: false } }),
    );
  });

  it("saves the accepted reviewer window on its own, apart from the worker one", async () => {
    const slot = render({
      "warming.set": (update: Partial<WarmingConfig>) => warmingView(update),
    });
    const accepted = await input(slot, "Reviewer accepted window (minutes)");
    await waitFor(() => expect(accepted.disabled).toBe(false));
    expect(slot.getByText(/Workers whose assignment was accepted/u)).toBeTruthy();
    expect(slot.queryByText(/Workers or reviewers/u)).toBeNull();
    fireEvent.change(accepted, { target: { value: "3" } });
    fireEvent.blur(accepted);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({ method: "warming.set", input: { reviewerAcceptedMinutes: 3 } }),
    );
    expect(slot.rpcCalls.some((call) => call.method === "warming.set" && "workerAcceptedMinutes" in (call.input as object))).toBe(false);
  });

  it("validates a window with the shared schema before saving it", async () => {
    const slot = render({
      "warming.set": () => warmingView({ coordinatorMinutes: 25 }),
    });
    const coordinator = await input(slot, "Coordinator window (minutes)");
    await waitFor(() => expect(coordinator.value).toBe("20"));
    fireEvent.change(coordinator, { target: { value: "61" } });
    fireEvent.blur(coordinator);
    expect(await slot.findByText("Must be at most 60.")).toBeTruthy();
    fireEvent.change(coordinator, { target: { value: "2.5" } });
    fireEvent.blur(coordinator);
    expect(await slot.findByText("Use whole minutes.")).toBeTruthy();
    expect(slot.rpcCalls.some((call) => call.method === "warming.set")).toBe(false);
    fireEvent.change(coordinator, { target: { value: "25" } });
    fireEvent.blur(coordinator);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({ method: "warming.set", input: { coordinatorMinutes: 25 } }),
    );
    await waitFor(() => expect(coordinator.value).toBe("25"));
  });

  it("switches mode, explains session matching without env changes and shows activity without dollar figures", async () => {
    let mode: WarmingConfig["mode"] = "off";
    const slot = render({
      "warming.get": () => warmingView({ mode }),
      "warming.set": (update: { mode?: WarmingConfig["mode"] }) => {
        mode = update.mode ?? mode;
        return warmingView({ mode });
      },
      "warming.status": () =>
        warmingStatus({
          mode,
          totals: { ...warmingStatus().totals, nativeObserved: 3, refreshesSent: 2, refreshesConfirmed: 2 },
          leases: [
            {
              sessionId: "6f1d3c1e-1111-4111-8111-111111111111",
              threadId: "thr_coord",
              accountId: "11111111-1111-4111-8111-111111111111",
              model: "claude-opus-5-5",
              ttl: "5m",
              bodyHash: "abcdefabcdef",
              prefixTokens: 100_000,
              nativeStartedAt: 0,
              nativeCompletedAt: 1,
              coveredUntil: 2,
              deadline: 3,
              windowLabel: "coordinator",
              refreshes: 2,
              nextRefreshAt: 4,
              state: "waiting",
              dryRun: false,
            },
          ],
          admissions: [{ sessionId: "s-2", threadId: null, state: "linking", since: 1 }],
          events: [
            { at: 1, kind: "lease", threadId: "thr_coord", accountId: null, model: null, ttl: "5m", message: "lease on 100000 cached tokens" },
          ],
        }),
    });
    const trigger = (await slot.findByLabelText("Cache warming mode")) as HTMLButtonElement;
    await waitFor(() => expect(trigger.disabled).toBe(false));
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const options = await slot.findAllByRole("menuitemradio");
    expect(options.map((option) => option.textContent)).toEqual(["Off", "Observe", "Warm"]);
    fireEvent.click(slot.getByRole("menuitemradio", { name: "Warm" }));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({ method: "warming.set", input: { mode: "warm" } }),
    );
    expect(await slot.findByText(/No environment variable is added/u)).toBeTruthy();
    // Once in the lease list, once in the recent decisions.
    expect(await slot.findAllByText("thr_coord")).toHaveLength(2);
    expect(slot.getByText("covered until", { exact: false })).toBeTruthy();
    expect(slot.getByText(/no dollar estimate is made/u)).toBeTruthy();
    expect(slot.getByText(/lease on 100000 cached tokens/u)).toBeTruthy();
    expect(slot.getByText(/waiting for a thread link or\s+role check/u)).toBeTruthy();
  });

  it("toggles model families as a full list", async () => {
    const slot = render({
      "warming.set": () => warmingView({ families: ["sonnet", "opus"] }),
    });
    const sonnet = await slot.findByRole("switch", { name: "Warm sonnet" });
    await waitFor(() => expect((sonnet as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(sonnet);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({ method: "warming.set", input: { families: ["sonnet", "opus"] } }),
    );
  });

  it("saves limits, including an empty reserve as null, and rejects out-of-range values", async () => {
    const slot = render({
      "warming.set": (update: Partial<WarmingConfig>) => warmingView(update),
    });
    fireEvent.click(await slot.findByRole("button", { name: "Limits" }));
    const cap = await input(slot, "Refreshes per idle period");
    await waitFor(() => expect(cap.value).toBe("4"));
    fireEvent.change(cap, { target: { value: "31" } });
    fireEvent.blur(cap);
    expect(await slot.findByText("Must be at most 30.")).toBeTruthy();
    fireEvent.change(cap, { target: { value: "2" } });
    fireEvent.blur(cap);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({ method: "warming.set", input: { maxRefreshesPerLease: 2 } }),
    );
    const reserve = await input(slot, "Warming quota reserve");
    expect(reserve.value).toBe("0.9");
    fireEvent.change(reserve, { target: { value: "" } });
    fireEvent.blur(reserve);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({ method: "warming.set", input: { quotaReserve: null } }),
    );
  });

  it("shows an invalid stored record's error", async () => {
    const slot = render({
      "warming.get": () =>
        warmingView({}, "Stored warming-config is invalid, so cache warming is off: mode: Invalid option"),
    });
    expect(
      await slot.findByText("Stored warming-config is invalid, so cache warming is off: mode: Invalid option"),
    ).toBeTruthy();
  });
});

describe("Advisor route settings", () => {
  it("turns one route on and validates the reserve", async () => {
    let view = advisorView();
    const slot = render({
      "advisor.get": () => view,
      "advisor.set": (update: { routes?: { claude?: boolean }; maxUtilization?: number | null }) => {
        view = advisorView({
          routes: { claude: update.routes?.claude ?? view.routes.claude, codex: false },
          maxUtilization: update.maxUtilization === undefined ? view.maxUtilization : update.maxUtilization,
        });
        return view;
      },
    });
    const claude = await slot.findByRole("switch", { name: "Advisor claude route" });
    await waitFor(() => expect((claude as HTMLButtonElement).disabled).toBe(false));
    expect(claude.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(claude);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({ method: "advisor.set", input: { routes: { claude: true } } }),
    );
    await waitFor(() => expect(claude.getAttribute("aria-checked")).toBe("true"));
    const reserve = await input(slot, "Advisor quota reserve");
    fireEvent.change(reserve, { target: { value: "1.5" } });
    fireEvent.blur(reserve);
    expect(await slot.findByText("Must be at most 1.")).toBeTruthy();
    fireEvent.change(reserve, { target: { value: "0.9" } });
    fireEvent.blur(reserve);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({ method: "advisor.set", input: { maxUtilization: 0.9 } }),
    );
  });

  it("shows a rejected reserve and an invalid stored record", async () => {
    const slot = render({
      "advisor.get": () =>
        advisorView({ error: "Stored advisor-config is invalid, so advisor routes are off: routes: Unrecognized key: \"gemini\"" }),
      // The real handler's merge, so the test sees the error the backend actually throws.
      "advisor.set": (update: AdvisorConfigSetInput) => {
        mergeAdvisorConfig({ ok: false, error: "bad" }, update, 0.9);
        return advisorView();
      },
    });
    expect(await slot.findByText(/Stored advisor-config is invalid/u)).toBeTruthy();
    const reserve = await input(slot, "Advisor quota reserve");
    await waitFor(() => expect(reserve.disabled).toBe(false));
    fireEvent.change(reserve, { target: { value: "0.95" } });
    fireEvent.blur(reserve);
    expect(await slot.findByText("Must be at most switchThreshold (0.9).")).toBeTruthy();
  });
});
