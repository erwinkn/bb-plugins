// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { memoryStore } from "./helpers";
import { buildOverview, type Overview, type WorkerChild, type WorkerItem } from "../lib/overview";

// v9 round 3 (A623): the Workers tab reads child threads live, page by page, and says when it
// can't; Cancel task says what may still run.
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
const worker = (ref: string, over: Partial<WorkerItem> = {}): WorkerItem => ({
  ref, label: `${ref} label`, role: "work", kind: null, area: `${ref} purpose`, bbProjectId: "repo", threadId: `thr_${ref}`,
  generation: 1, generations: 1, state: "active", profile: null, forkedFrom: null,
  nativeParent: true, lastHandoff: null, runtime: "idle", context: { used: null, window: null, estimated: null },
  lead: null, open: { ref: "A1", state: "idle_no_report", tasks: [] }, latestReport: null, stopReason: null, tokens: null, prs: [], since: NOW - 60_000, ...over,
});
const child = (n: number, running: WorkerChild["running"] = null): WorkerChild => ({
  threadId: `c${n}`, title: `Child ${n}`, status: running ? "active" : "idle", archived: false, running, providerId: null, updatedAt: NOW - 60_000, children: 0,
});
function mount(o: Overview, rpc: Record<string, (input: unknown) => unknown>) {
  const slot = renderSlot(app.navPanels[0], { subPath: "p1" }, { rpc: { inventory: () => [], list: () => [], overview: () => o, command: vi.fn().mockResolvedValue({}), ...rpc } });
  mounted.push(slot);
  return slot;
}

describe("R1/R9/R10 Workers tab child threads", () => {
  it("an idle worker whose tree the cache hasn't listed says so instead of claiming no children", async () => {
    const o = base();
    o.workers.current = [worker("W1")];
    o.workerWaiting = { W1: { on: null, checked: false } };
    const slot = mount(o, { childPage: () => ({ status: "ready", value: { rows: [], next: null } }) });
    fireEvent.click(await slot.findByRole("tab", { name: /Workers/ }));
    expect(slot.getByText("Idle without a report · child threads not checked yet")).toBeTruthy();
  });

  it("a failed read says so with Retry, and More reads the next page until the last", async () => {
    const o = base();
    o.workers.current = [worker("W1")];
    o.workerWaiting = { W1: { on: null, checked: true, children: 3 } };
    let fail = true;
    const childPage = vi.fn((input: unknown) => {
      const { offset = 0 } = input as { offset?: number };
      if (fail) return { status: "failed", error: "BB unavailable" };
      return { status: "ready", value: offset === 0 ? { rows: [child(1), child(2)], next: 2 } : { rows: [child(3, "active")], next: null } };
    });
    const slot = mount(o, { childPage });
    fireEvent.click(await slot.findByRole("tab", { name: /Workers/ }));
    const row = slot.getByRole("button", { name: "W1 W1 label" }).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "3 child threads" }));
    expect((await within(row).findByRole("alert")).textContent).toMatch(/Couldn’t read child threads: BB unavailable/);
    expect(within(row).queryByText("No child threads.")).toBeNull();
    fail = false;
    fireEvent.click(within(row).getByRole("button", { name: "Retry" }));
    await within(row).findByRole("button", { name: "Open Child 2" });
    fireEvent.click(within(row).getByRole("button", { name: "More child threads" }));
    await within(row).findByRole("button", { name: "Open Child 3" });
    expect(within(row).queryByRole("button", { name: "More child threads" })).toBeNull();
    // More re-reads the opened page with the next one.
    expect(childPage.mock.calls.map(([input]) => (input as { offset?: number }).offset)).toEqual([0, 0, 0, 2]);
  });
});

describe("R6 Cancel task", () => {
  it("shows the threads BB refused to stop", async () => {
    const o = base();
    o.tasks = [{ ref: "T1", title: "Fix the export", status: "in_progress", statusReason: "W1 on A1", setByHand: false, summary: "", workers: ["W1"], updatedAt: NOW }];
    const command = vi.fn().mockResolvedValue({ ref: "T1", status: "cancelled", notStopped: ['"Review r2" (host offline)'] });
    const slot = mount(o, { command });
    fireEvent.click(await slot.findByRole("tab", { name: /Tasks/ }));
    fireEvent.click(slot.getByText("Fix the export"));
    fireEvent.click(slot.getByRole("button", { name: "Cancel task" }));
    await waitFor(() => expect(slot.getByRole("alert").textContent).toBe('Some work may still run: not stopped: "Review r2" (host offline).'));
  });
});
