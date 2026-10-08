// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, within } from "@testing-library/react";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { memoryStore } from "./helpers";
import { buildOverview, type InFlightItem } from "../lib/overview";

installTestPluginRuntime();
const app = await loadPluginApp(() => import("../app"));
const mounted: ReturnType<typeof renderSlot>[] = [];
afterEach(() => {
  for (const slot of mounted.splice(0)) slot.unmount();
  cleanup();
});

// The worker's current label is never what a row shows; each assignment's own brief names it.
const item = (assignment: string, worker: string, brief: string, tasks = [{ ref: "T143", title: "OptChat polish" }]): InFlightItem => ({
  assignment, role: "work", outcome: "Cut the fixed overhead per OptChat turn", brief, tasks,
  owner: { worker, label: `${worker}'s current label`, threadId: `thr_${worker}`, profile: "Opus 5.5" },
  state: "running", threadBusy: true, progress: "Working", nextCheckpoint: "Worker report", warnings: [], since: Date.now(),
});

async function inFlight(items: InFlightItem[]) {
  const { db, store } = memoryStore();
  store.createProject({ id: "p1", name: "Plugins", objective: "Polish", memberProjectIds: ["repo"], coordinatorThreadId: "coordinator" });
  const o = buildOverview(store, "p1", new Map(), Date.now());
  db.close();
  o.inFlight = items;
  const slot = renderSlot(app.navPanels[0], { subPath: "p1" }, { rpc: { inventory: () => [], list: () => [], overview: () => o } });
  mounted.push(slot);
  fireEvent.click(await slot.findByRole("tab", { name: "Tasks" }));
  return slot.getByRole("region", { name: "In flight" });
}
const summaries = (root: Element) => Array.from(root.querySelectorAll("summary"), (s) => s.textContent);

describe("T143 In flight groups a task's assignments", () => {
  it("groups by each task: overlapping and reordered task lists meet under one row per task (W262)", async () => {
    const T1 = { ref: "T1", title: "Fork bridge" }, T2 = { ref: "T2", title: "Plugin tools" };
    const region = await inFlight([
      item("A1", "W1", "Both halves", [T1, T2]),
      item("A2", "W2", "Fork only", [T1]),
      item("A3", "W3", "Both, other order", [T2, T1]),
      item("A4", "W4", "No task", []),
    ]);
    const t1 = within(region).getByRole("group", { name: "T1: 3 assignments" });
    const t2 = within(region).getByRole("group", { name: "T2: 2 assignments" });
    expect(summaries(t1)).toEqual([expect.stringMatching(/^Both halves.*W1/), expect.stringMatching(/^Fork only.*W2/), expect.stringMatching(/^Both, other order.*W3/)]);
    expect(summaries(t2)).toEqual([expect.stringMatching(/^Both halves.*W1/), expect.stringMatching(/^Both, other order.*W3/)]);
    expect(within(region).queryByText(/T1, T2|T2, T1/)).toBeNull();
    // A taskless assignment stays its own row, named by its brief.
    expect(within(region).getByText("No task").closest("summary")!.textContent).toMatch(/W4/);
    expect(region.textContent).not.toContain("current label");
  });

  it("shows an assignment once under a task even when its task refs repeat", async () => {
    const T = { ref: "T143", title: "OptChat polish" };
    const region = await inFlight([item("A1", "W1", "Doubled refs", [T, T]), item("A2", "W2", "Second", [T])]);
    const group = within(region).getByRole("group", { name: "T143: 2 assignments" });
    expect(Array.from(group.querySelectorAll("summary"), (s) => s.textContent)).toEqual([expect.stringMatching(/^Doubled refs.*W1/), expect.stringMatching(/^Second.*W2/)]);
  });

  it("shows a lone assignment with repeated task refs as one row", async () => {
    const T = { ref: "T143", title: "OptChat polish" };
    const region = await inFlight([item("A1", "W1", "Doubled refs", [T, T])]);
    expect(within(region).queryByRole("group", { name: /assignments/ })).toBeNull();
    expect(region.querySelectorAll("summary")).toHaveLength(1);
  });

  it("shows a task with two assignments once, with a line per assignment naming its own worker and brief", async () => {
    const region = await inFlight([
      item("A436", "W257", "T143 fork: bridge overhead"),
      item("A437", "W258", "T143 plugin: zoom timestamps"),
      item("A440", "W260", "Sidebar fix", [{ ref: "T150", title: "Sidebar snooze" }]),
    ]);
    const group = within(region).getByRole("group", { name: "T143: 2 assignments" });
    expect(within(group).getAllByText("OptChat polish")).toHaveLength(1);
    const rows = Array.from(group.querySelectorAll("summary"), (s) => s.textContent);
    expect(rows).toEqual([expect.stringMatching(/^T143 fork: bridge overhead.*W257/), expect.stringMatching(/^T143 plugin: zoom timestamps.*W258/)]);
    // The task's description is not repeated per assignment; each row's details name its own worker.
    fireEvent.click(group.querySelectorAll("summary")[1]!);
    expect(within(group).queryByText("Cut the fixed overhead per OptChat turn")).toBeNull();
    expect(within(group).getByText(/W258 T143 plugin: zoom timestamps · A437/)).toBeTruthy();
    // A task's only assignment stays one row, titled by the task, then the assignment's own brief.
    expect(within(region).getByText("Sidebar snooze").closest("summary")!.textContent).toMatch(/^T150Sidebar snoozeSidebar fix.*W260/);
    expect(region.textContent).not.toContain("current label");
  });
});
