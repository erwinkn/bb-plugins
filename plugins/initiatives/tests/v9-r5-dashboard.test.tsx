// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { memoryStore } from "./helpers";
import { buildOverview, type Overview, type WorkerChild, type WorkerItem } from "../lib/overview";

// v9 round 5 (A639 F2): a realtime refresh within the debounce keeps the page More asked for.
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
const child = (n: number): WorkerChild => ({
  threadId: `c${n}`, title: `Helper ${n}`, status: "idle", archived: false, running: null, providerId: null, updatedAt: NOW - 60_000,
});

describe("F2 More child threads survives a realtime refresh", () => {
  it("an announcement right after More reads both pages and shows the second", async () => {
    const o = base();
    o.workers.current = [worker("W1")];
    o.workerWaiting = { W1: { on: null, checked: true, children: 1 } };
    const pages: Record<number, { rows: WorkerChild[]; next: number | null }> = { 0: { rows: [child(1)], next: 1 }, 1: { rows: [child(2)], next: null } };
    const childPage = vi.fn((input: unknown) => ({ status: "ready", value: pages[(input as { offset?: number }).offset ?? 0] }));
    const slot = renderSlot(app.navPanels[0], { subPath: "p1" }, { rpc: { inventory: () => [], list: () => [], overview: () => o, command: vi.fn(), childPage } });
    mounted.push(slot);
    fireEvent.click(await slot.findByRole("tab", { name: /Workers/ }));
    const row = slot.getByRole("button", { name: "W1 W1 label" }).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Child threads" }));
    const more = await within(row).findByRole("button", { name: "More child threads" });
    childPage.mockClear();
    await act(async () => {
      fireEvent.click(more);
      await slot.behavior.emitRealtime("initiatives-changed", { projectId: "p1" });
    });
    await within(row).findByRole("button", { name: "Open Helper 2" });
    expect(childPage.mock.calls.map(([input]) => (input as { offset?: number }).offset ?? 0)).toEqual([0, 1]);
  });
});
