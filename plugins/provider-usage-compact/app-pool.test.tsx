// @vitest-environment jsdom
import { cleanup, fireEvent, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { UsageProvider, UsageSnapshot } from "./usage-schema.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const NOW = Date.UTC(2026, 9, 8, 10);
const inMinutes = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

function provider(id: string, displayName: string, accountEmail: string): UsageProvider {
  return {
    id,
    displayName,
    logoUrl: null,
    iconGlyph: "Bot",
    iconTint: null,
    signInHint: "Sign in.",
    expiredHint: "Sign in again.",
    usage: {
      status: "ok",
      accountEmail,
      planLabel: "Max",
      windows: [{ label: "Weekly limit", usedPercent: 100, resetsAt: null, cost: null }],
    },
  };
}

const snapshot: UsageSnapshot = {
  machines: [
    {
      id: "host",
      displayName: "hetzner",
      status: "connected",
      machineProvider: null,
      error: null,
      providers: [
        provider("claude-code", "Claude Code", "local-login@example.com"),
        provider("codex", "Codex", "codex@example.com"),
      ],
    },
  ],
  pools: [
    {
      providerId: "claude-code",
      planLabel: "Max 20x",
      accounts: [
        {
          id: "a",
          name: "erwin@griffe.dev",
          status: "exhausted",
          active: false,
          availableAt: inMinutes(25),
          error: null,
          windows: [
            { label: "5h", usedPercent: 100, resetsAt: inMinutes(25), cost: null },
            { label: "7d", usedPercent: 69, resetsAt: inMinutes(3 * 24 * 60), cost: null },
          ],
        },
        {
          id: "b",
          name: "erwin.kuhn@pm.me",
          status: "ready",
          active: true,
          availableAt: null,
          error: null,
          windows: [
            { label: "5h", usedPercent: 4, resetsAt: inMinutes(130), cost: null },
            { label: "7d", usedPercent: 60, resetsAt: inMinutes(3 * 24 * 60), cost: null },
            { label: "Fable 7d", usedPercent: 26, resetsAt: inMinutes(3 * 24 * 60), cost: null },
          ],
        },
        {
          id: "c",
          name: "spare@example.com",
          status: "disabled",
          active: false,
          availableAt: null,
          error: null,
          windows: [{ label: "5h", usedPercent: 0, resetsAt: null, cost: null }],
        },
      ],
    },
  ],
  detailsHref: "/plugins/usage-stats/usage",
};

it("shows the pooled accounts for a provider the Account Pooler routes, and the machine's own usage for the rest", async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ ok: true, result: snapshot }))),
  );
  const app = await loadPluginApp(() => import("./app"));
  const item = app.experimentalSidebarFooterItems[0];
  if (item?.kind !== "disclosure") throw new Error("missing disclosure");
  const slot = renderSlot(item, { dismiss: vi.fn() });

  const accounts = await slot.findByRole("list", { name: "Pooled accounts" });
  expect(slot.getByText("Account Pooler · 1 of 2 ready")).toBeTruthy();
  expect(slot.getByText("Max 20x")).toBeTruthy();
  // The machine's own Claude login is not what serves the traffic.
  expect(slot.queryByText("local-login@example.com")).toBeNull();

  const rows = within(accounts).getAllByRole("listitem");
  expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
    "erwin@griffe.dev, Exhausted",
    "erwin.kuhn@pm.me, active, Ready",
    "spare@example.com, Disabled",
  ]);
  expect(within(rows[0]!).getByText("Exhausted · 25m")).toBeTruthy();
  expect(within(rows[0]!).getByText("100%")).toBeTruthy();
  expect(within(rows[1]!).getByText("Active")).toBeTruthy();
  expect(within(rows[1]!).getByText("2h 10m")).toBeTruthy();
  expect(within(rows[1]!).getByText("Fable 7d")).toBeTruthy();
  // A disabled account shows no windows.
  expect(within(rows[2]!).queryByText("5h")).toBeNull();
  // The active account is at 60% at most and another is ready: no warning on the tab.
  const claudeTab = slot.getByRole("tab", { name: "Claude Code" });
  expect(claudeTab.querySelector("[data-provider-usage-tone]")).toBeNull();

  fireEvent.click(slot.getByRole("tab", { name: "Codex" }));
  expect(slot.queryByRole("list", { name: "Pooled accounts" })).toBeNull();
  expect(slot.getByText("codex@example.com")).toBeTruthy();
  expect(slot.getByText("100% used")).toBeTruthy();
});

it("links to the Usage stats page when it is installed, and closes the popup on the way", async () => {
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return true; },
  }));
  const render = async (detailsHref: string | null) => {
    cleanup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { ...snapshot, detailsHref } }))),
    );
    // A fresh module: the usage store and the selected tab live at module scope.
    vi.resetModules();
    const app = await loadPluginApp(() => import("./app"));
    const item = app.experimentalSidebarFooterItems[0];
    if (item?.kind !== "disclosure") throw new Error("missing disclosure");
    const dismiss = vi.fn();
    const slot = renderSlot(item, { dismiss });
    await slot.findByRole("list", { name: "Pooled accounts" });
    return { slot, dismiss };
  };
  const { slot, dismiss } = await render("/plugins/usage-stats/usage");
  const link = slot.getByRole("link", { name: "Usage details" });
  expect(link.getAttribute("href")).toBe("/plugins/usage-stats/usage");
  // BB routes the anchor in-app; jsdom cannot navigate.
  link.addEventListener("click", (event) => event.preventDefault());
  fireEvent.click(link);
  expect(dismiss).toHaveBeenCalled();

  const without = await render(null);
  expect(without.slot.queryByRole("link", { name: "Usage details" })).toBeNull();
});
