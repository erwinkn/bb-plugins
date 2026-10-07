// @vitest-environment jsdom
// W196: a missed dashboard read is retried at once and reported; a tab that
// comes back or a network that returns reads at once instead of on the next
// 15 s poll, which a hidden tab skipped.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { projectFixture } from "./fake-native";

const app = await loadPluginApp(() => import("../app"));
const slots: ReturnType<typeof renderSlot>[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.unmount(); cleanup(); });

describe("W196 read timeouts", () => {
  it("logs one warn line per reported client timeout", async () => {
    const { f } = await projectFixture();
    expect(await f.harness.callRpc("reportReadTimeout", {
      read: "panel", elapsedMs: 41250, hidden: true, online: false, sinceVisibleMs: 38000, hiddenDuringRead: true,
    })).toEqual({ ok: true });
    expect(f.harness.inspection.logEntries).toContainEqual({
      level: "warn",
      message: "An Initiatives panel read timed out in a client: elapsedMs=41250 hidden=true online=false sinceVisibleMs=38000 hiddenDuringRead=true",
    });
  });

  it("the panel reads at once when the tab becomes visible again or the network returns", async () => {
    let visibility: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    try {
      const panel = vi.fn(async () => ({ membership: null, summary: null }));
      const slot = renderSlot(app.threadPanelActions[0], { threadId: "w196-thread", params: {} }, { rpc: { panel, inventory: async () => [] } });
      slots.push(slot);
      await waitFor(() => expect(panel).toHaveBeenCalledTimes(1));
      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(panel).toHaveBeenCalledTimes(1);
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      await waitFor(() => expect(panel).toHaveBeenCalledTimes(2));
      window.dispatchEvent(new Event("online"));
      await waitFor(() => expect(panel).toHaveBeenCalledTimes(3));
    } finally {
      delete (document as { visibilityState?: unknown }).visibilityState;
    }
  });
});
