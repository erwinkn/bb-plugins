// @vitest-environment jsdom
// T106, T122: the one Advisor entry, above the Initiatives header, drawn like an
// Initiative row with the Advisor's live summary. Fake RPC and realtime; no Advisor plugin involved.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { ADVISOR_FEED_HREF, ADVISOR_UNSEEN_CHANNEL } from "../lib/advisor-contract";
import { registerAdvisorEntry } from "../lib/advisor-server";

// Loading the app installs the SDK's test runtime that the hooks resolve against.
const app = await loadPluginApp(() => import("../app"));
void app;
const { AdvisorEntry, advisorStatus } = await import("../components/advisor-entry");
afterEach(() => history.replaceState(null, "", "/"));
afterEach(cleanup);

const summary = (patch: object = {}) => ({ unseen: 0, reviewing: true, initiatives: 1, threads: 4, ...patch });
const entryOf = (patch: object = {}) => () => ({ available: true, summary: summary(patch) });

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
  it("shows the count as a badge, updates it live from pushes without re-reading, and hides the badge at zero", async () => {
    const { slot, calls } = mount(entryOf({ unseen: 3 }));
    const row = await slot.findByRole("link", { name: "Advisor, 3 new findings" });
    expect(row.textContent).toBe("Advisor1 initiative · 4 threads3");
    await slot.behavior.emitRealtime(ADVISOR_UNSEEN_CHANNEL, summary({ unseen: 7, threads: 5 }));
    expect((await slot.findByRole("link", { name: "Advisor, 7 new findings" })).textContent).toBe("Advisor1 initiative · 5 threads7");
    await slot.behavior.emitRealtime(ADVISOR_UNSEEN_CHANNEL, summary({ reviewing: false }));
    expect((await slot.findByRole("link", { name: "Advisor" })).textContent).toBe("AdvisorReviews off");
    await slot.behavior.emitRealtime(ADVISOR_UNSEEN_CHANNEL, { unseen: 2 }); // malformed: ignored
    expect(slot.getByRole("link", { name: "Advisor" })).toBeTruthy();
    expect(calls).toEqual(["advisorEntry"]); // one read on mount; pushes carry the summary
  });

  it("says what the Advisor watches, or that reviews are off", () => {
    expect(advisorStatus(summary({ initiatives: 2, threads: 1 }))).toBe("2 initiatives · 1 thread");
    expect(advisorStatus(summary({ initiatives: 0, threads: 3 }))).toBe("3 threads");
    expect(advisorStatus(summary({ initiatives: 0, threads: 0 }))).toBe("Nothing watched");
    expect(advisorStatus(summary({ reviewing: false, unseen: 4 }))).toBe("Reviews off");
  });

  it("draws an Initiative-style row: icon tile, title, status line, and the selected state on the feed", async () => {
    history.replaceState(null, "", `${ADVISOR_FEED_HREF}/finding/x`);
    const { slot } = mount(entryOf());
    const row = await slot.findByRole("link", { name: "Advisor" });
    expect(row.querySelector("[data-project-icon]")?.getAttribute("data-project-icon")).toBe("SecurityCheck");
    expect(row.querySelector("[data-project-hue]")).toBeNull(); // neutral: not an Initiative color
    expect(row.getAttribute("aria-current")).toBe("page");
    expect(row.className).toContain("bg-accent");
    // Leaving the feed clears it.
    await act(async () => {
      history.pushState(null, "", "/projects/p/threads/t");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(row.getAttribute("aria-current")).toBeNull();
    expect(row.className).toContain("hover:bg-accent/60");
  });

  it("keeps the row without a status line when the Advisor's summary could not be read", async () => {
    const { slot } = mount(() => ({ available: true, summary: null }));
    expect((await slot.findByRole("link", { name: "Advisor" })).textContent).toBe("Advisor");
  });

  it("caps a large count", async () => {
    const { slot } = mount(entryOf({ unseen: 120 }));
    expect((await slot.findByRole("link", { name: "Advisor, 120 new findings" })).textContent).toContain("99+");
  });

  it("opens the Advisor feed and closes the mobile drawer", async () => {
    const { slot, onNavigate } = mount(entryOf({ unseen: 1 }));
    const row = await slot.findByRole("link", { name: /Advisor/ });
    expect(row.getAttribute("href")).toBe(ADVISOR_FEED_HREF);
    fireEvent.click(row);
    expect(onNavigate).toHaveBeenCalledOnce();
    expect(slot.inspection.navigateCalls).toEqual([{ method: "openUrl", url: ADVISOR_FEED_HREF }]);
  });

  it("renders nothing while the Advisor is missing, or when the read fails", async () => {
    const absent = mount(() => ({ available: false, summary: null }));
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

  it("reads the summary from a running Advisor, hides without one, and keeps the row when the read fails", async () => {
    const running = [{ id: "advisor", enabled: true, status: "running" }];
    const ok = host(running, async (args) => (args.pluginId === "advisor" && args.method === "unseen" ? args.outputSchema.parse(summary({ unseen: 4 })) : null));
    expect(await ok.harness.callRpc("advisorEntry", null)).toEqual({ available: true, summary: summary({ unseen: 4 }) });
    const none = host([]);
    expect(await none.harness.callRpc("advisorEntry", null)).toEqual({ available: false, summary: null });
    expect(none.harness.sdk.callsTo("plugins.callRpc")).toEqual([]);
    const disabled = host([{ id: "advisor", enabled: false, status: "stopped" }]);
    expect(await disabled.harness.callRpc("advisorEntry", null)).toEqual({ available: false, summary: null });
    const failing = host(running, async () => {
      throw new Error("503");
    });
    expect(await failing.harness.callRpc("advisorEntry", null)).toEqual({ available: true, summary: null });
    // An older Advisor that answers only the count fails the schema and keeps the row without a status.
    const older = host(running, async (args) => args.outputSchema.parse({ unseen: 4 }));
    expect(await older.harness.callRpc("advisorEntry", null)).toEqual({ available: true, summary: null });
    for (const h of [ok, none, disabled, failing, older]) await h.harness.dispose();
  });

  it("republishes the Advisor's push on the Sidebar's own channel", async () => {
    const h = host([]);
    expect(await h.harness.callRpc("advisorChanged", summary({ unseen: 2 }))).toEqual({ ok: true });
    expect(h.harness.inspection.realtimeSignals).toEqual([{ channel: ADVISOR_UNSEEN_CHANNEL, payload: summary({ unseen: 2 }) }]);
    await expect(h.harness.callRpc("advisorChanged", summary({ unseen: -1 }))).rejects.toThrow();
    await h.harness.dispose();
  });
});
