// @vitest-environment jsdom
// T106: the one Advisor entry, above the Initiatives header, with the Advisor's
// live unseen count. Fake RPC and realtime; no Advisor plugin involved.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { ADVISOR_FEED_HREF, ADVISOR_UNSEEN_CHANNEL } from "../lib/advisor-contract";
import { registerAdvisorEntry } from "../lib/advisor-server";

// Loading the app installs the SDK's test runtime that the hooks resolve against.
const app = await loadPluginApp(() => import("../app"));
void app;
const { AdvisorEntry } = await import("../components/advisor-entry");
afterEach(cleanup);

const mount = (entry: () => unknown, onNavigate = vi.fn()) => {
  const calls: string[] = [];
  const slot = renderSlot(
    { component: AdvisorEntry },
    { onNavigate },
    {
      rpc: {
        advisorEntry: () => {
          calls.push("advisorEntry");
          return entry();
        },
      },
      openUrl: () => true,
    },
  );
  return { slot, calls, onNavigate };
};

describe("Advisor entry", () => {
  it("shows the count, updates it live from pushes without re-reading, and hides the badge at zero", async () => {
    const { slot, calls } = mount(() => ({ available: true, unseen: 3 }));
    await slot.findByRole("link", { name: "Advisor, 3 new findings" });
    await slot.behavior.emitRealtime(ADVISOR_UNSEEN_CHANNEL, { unseen: 7 });
    await slot.findByRole("link", { name: "Advisor, 7 new findings" });
    await slot.behavior.emitRealtime(ADVISOR_UNSEEN_CHANNEL, { unseen: 0 });
    const row = await slot.findByRole("link", { name: "Advisor" });
    expect(row.textContent).toBe("Advisor");
    expect(calls).toEqual(["advisorEntry"]); // one read on mount; pushes carry the count
  });

  it("caps a large count", async () => {
    const { slot } = mount(() => ({ available: true, unseen: 120 }));
    expect((await slot.findByRole("link", { name: "Advisor, 120 new findings" })).textContent).toContain("99+");
  });

  it("opens the Advisor feed and closes the mobile drawer", async () => {
    const { slot, onNavigate } = mount(() => ({ available: true, unseen: 1 }));
    const row = await slot.findByRole("link", { name: /Advisor/ });
    expect(row.getAttribute("href")).toBe(ADVISOR_FEED_HREF);
    fireEvent.click(row);
    expect(onNavigate).toHaveBeenCalledOnce();
    expect(slot.inspection.navigateCalls).toEqual([{ method: "openUrl", url: ADVISOR_FEED_HREF }]);
  });

  it("renders nothing while the Advisor is missing, or when the read fails", async () => {
    const absent = mount(() => ({ available: false, unseen: null }));
    await waitFor(() => expect(absent.calls).toHaveLength(1));
    expect(absent.slot.container.querySelector("[data-advisor-entry]")).toBeNull();
    cleanup();
    const broken = mount(() => {
      throw new Error("boom");
    });
    await waitFor(() => expect(broken.calls).toHaveLength(1));
    expect(broken.slot.container.querySelector("[data-advisor-entry]")).toBeNull();
  });
});

describe("Advisor entry server", () => {
  const host = (plugins: unknown[], callRpc?: (args: any) => Promise<unknown>) => {
    const h = createFakePluginHost({ sdk: { plugins: { list: async () => ({ plugins }), ...(callRpc ? { callRpc } : {}) } } as any });
    registerAdvisorEntry(h.bb);
    return h;
  };

  it("reads the count from a running Advisor, hides without one, and keeps the row when the read fails", async () => {
    const running = [{ id: "advisor", enabled: true, status: "running" }];
    const ok = host(running, async (args) => (args.pluginId === "advisor" && args.method === "unseen" ? { unseen: 4 } : null));
    expect(await ok.harness.callRpc("advisorEntry", null)).toEqual({ available: true, unseen: 4 });
    const none = host([]);
    expect(await none.harness.callRpc("advisorEntry", null)).toEqual({ available: false, unseen: null });
    expect(none.harness.sdk.callsTo("plugins.callRpc")).toEqual([]);
    const disabled = host([{ id: "advisor", enabled: false, status: "stopped" }]);
    expect(await disabled.harness.callRpc("advisorEntry", null)).toEqual({ available: false, unseen: null });
    const failing = host(running, async () => {
      throw new Error("503");
    });
    expect(await failing.harness.callRpc("advisorEntry", null)).toEqual({ available: true, unseen: null });
    for (const h of [ok, none, disabled, failing]) await h.harness.dispose();
  });

  it("republishes the Advisor's push on the Sidebar's own channel", async () => {
    const h = host([]);
    expect(await h.harness.callRpc("advisorChanged", { unseen: 2 })).toEqual({ ok: true });
    expect(h.harness.inspection.realtimeSignals).toEqual([{ channel: ADVISOR_UNSEEN_CHANNEL, payload: { unseen: 2 } }]);
    await expect(h.harness.callRpc("advisorChanged", { unseen: -1 })).rejects.toThrow();
    await h.harness.dispose();
  });
});
