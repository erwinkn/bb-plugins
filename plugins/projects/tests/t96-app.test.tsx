// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { memoryStore } from "./helpers";
import { buildOverview } from "../lib/overview";
import { report } from "./fake-native";

// T96: a worker's latest report is reachable from its thread details as a copyable
// standard handoff and as the delegate field that embeds it in fresh work.
installTestPluginRuntime();
const app = await loadPluginApp(() => import("../app"));
const mounted: ReturnType<typeof renderSlot>[] = [];
afterEach(() => { for (const slot of mounted.splice(0)) slot.unmount(); cleanup(); });

function reportedOverview() {
  const { db, store } = memoryStore();
  store.createProject({ id: "p1", name: "Search", objective: "Focused work", memberProjectIds: ["repo"], coordinatorThreadId: "coordinator" });
  const worker = store.createWorker({ projectId: "p1", role: "work", label: "Search", area: "Archived search", bbProjectId: "repo" });
  store.updateWorker("p1", worker.num, { threadId: "worker", generation: 1, state: "active" });
  store.openGeneration("p1", worker.num, 1, "worker");
  const task = store.createTask({ projectId: "p1", title: "Search", summary: "Search", brief: null, priority: 2, dependsOn: [], workKind: "implementation" } as never);
  const a = store.createAssignment({ projectId: "p1", workerNum: worker.num, taskNums: [task.num], route: "fresh", role: "work", workKind: "implementation", threadId: "worker", generation: 1,
    profile: { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" }, bbProjectId: "repo", environmentId: null, state: "running", opId: "op_a", opState: "done", briefText: "brief", reviewOf: null, rationale: null } as never);
  store.updateAssignment("p1", a.num, { state: "reported", report: report(), reportedAt: Date.now(), briefDelivered: true });
  const o = buildOverview(store, "p1", new Map([["worker", { status: "idle", archived: false, title: "Search", parentThreadId: "coordinator" }]]), Date.now());
  db.close();
  return o;
}

it("thread details copy the latest handoff text and the delegate field without any command", async () => {
  const o = reportedOverview();
  expect(o.workers.current[0]!.lastHandoff).toBe("A1");
  const writeText = vi.fn(async (_text: string) => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const read = vi.fn(async (_input: unknown) => ({ items: [{ standardHandoff: "Prior handoff A1 · W1 …" }] }));
  const command = vi.fn();
  const slot = renderSlot(app.navPanels[0], { subPath: "p1" }, { rpc: { inventory: () => [], list: () => [], overview: () => o, read, command } });
  mounted.push(slot);
  fireEvent.click(await slot.findByRole("tab", { name: /Threads/ }));
  fireEvent.click(slot.getByRole("button", { name: "Details for W1 Search" }));
  await slot.findByText("Latest handoff: A1. Later related work can start a fresh worker with it.");
  fireEvent.click(slot.getByRole("button", { name: "Copy handoff" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("Prior handoff A1 · W1 …"));
  expect(read.mock.calls[0]![0]).toMatchObject({ projectId: "p1", view: "assignments", refs: ["A1"], detailed: true, fields: ["standardHandoff"] });
  await slot.findByText("Copied A1's handoff.");
  fireEvent.click(slot.getByRole("button", { name: "Copy delegate field" }));
  await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('"handoffs":["A1"]'));
  expect(slot.getByRole("button", { name: "Retire worker" })).toBeTruthy();
  expect(command).not.toHaveBeenCalled();
});
