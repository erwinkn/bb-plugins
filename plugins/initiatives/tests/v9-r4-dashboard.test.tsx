// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { memoryStore } from "./helpers";
import { buildOverview, type Overview, type WorkerChild, type WorkerItem } from "../lib/overview";

// v9 round 4 (A625 F3): an open child tree refreshes with the dashboard and keeps its pages.
installTestPluginRuntime();
const app = await loadPluginApp(() => import("../app"));
const mounted: ReturnType<typeof renderSlot>[] = [];
afterEach(() => {
  for (const slot of mounted.splice(0)) slot.unmount();
  cleanup();
});

const NOW = Date.now();
function base(): Overview {
  const { db, store } = memoryStore();
  store.createProject({ id: "p1", name: "Equisafe", objective: "Ship", memberProjectIds: ["repo"], coordinatorThreadId: "coordinator" });
  const o = buildOverview(store, "p1", new Map(), NOW);
  db.close();
  return o;
}
const worker = (ref: string): WorkerItem => ({
  ref, label: `${ref} label`, role: "work", kind: null, area: `${ref} purpose`, bbProjectId: "repo", threadId: `thr_${ref}`,
  generation: 1, generations: 1, state: "active", profile: null, forkedFrom: null,
  nativeParent: true, lastHandoff: null, runtime: "idle", context: { used: null, window: null, estimated: null },
  lead: null, open: { ref: "A1", state: "running", tasks: [] }, latestReport: null, stopReason: null, tokens: null, prs: [], since: NOW - 60_000,
});
const child = (n: number, running: WorkerChild["running"] = null): WorkerChild => ({
  threadId: `c${n}`, title: `Helper ${n}`, status: running ? "active" : "idle", archived: false, running, providerId: null, updatedAt: NOW - 60_000,
});

describe("F3 an open child tree refreshes with the dashboard", () => {
  it("a helper started after the tree opened shows on the next announcement, and opened pages stay", async () => {
    const o = base();
    o.workers.current = [worker("W1")];
    o.workerWaiting = { W1: { on: null, checked: true, children: 1 } };
    let pages: Record<number, { rows: WorkerChild[]; next: number | null }> = { 0: { rows: [child(1, "active")], next: 1 }, 1: { rows: [child(2)], next: null } };
    const childPage = vi.fn((input: unknown) => ({ status: "ready", value: pages[(input as { offset?: number }).offset ?? 0] }));
    const slot = renderSlot(app.navPanels[0], { subPath: "p1" }, { rpc: { inventory: () => [], list: () => [], overview: () => o, command: vi.fn(), childPage } });
    mounted.push(slot);
    fireEvent.click(await slot.findByRole("tab", { name: /Workers/ }));
    const row = slot.getByRole("button", { name: "W1 W1 label" }).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Child threads" }));
    fireEvent.click(await within(row).findByRole("button", { name: "More child threads" }));
    await within(row).findByRole("button", { name: "Open Helper 2" });
    // Helper 1 finished and Helper 3 started; the server announces the Initiative.
    pages = { 0: { rows: [child(1)], next: 1 }, 1: { rows: [child(2), child(3, "active")], next: null } };
    await act(async () => { await slot.behavior.emitRealtime("initiatives-changed", { projectId: "p1" }); });
    await within(row).findByRole("button", { name: "Open Helper 3" });
    expect(within(row).getByRole("button", { name: "Open Helper 1" }).getAttribute("data-live")).toBeNull();
    expect(within(row).getByRole("button", { name: "Open Helper 2" })).toBeTruthy();
  });
});
