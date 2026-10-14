// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { memoryStore } from "./helpers";
import { buildOverview, type Overview, type OverviewDetail } from "../lib/overview";

// v9 round 2 (W434's review, D522): the Tasks tab's findings, F1 and F12, on a real ledger's tiers.
installTestPluginRuntime();
const app = await loadPluginApp(() => import("../app"));
const mounted: ReturnType<typeof renderSlot>[] = [];
afterEach(() => {
  for (const slot of mounted.splice(0)) slot.unmount();
  cleanup();
});

const NOW = Date.now();
/** Each tier as the server builds it: a planned task, one cancelled by hand and one marked done by hand. */
function tiers(): Record<OverviewDetail, Overview> {
  const { db, store } = memoryStore();
  store.createProject({ id: "p1", name: "Equisafe", objective: "Ship the market platform", memberProjectIds: ["repo"], coordinatorThreadId: "coordinator" });
  const task = (title: string, summary: string) => store.createTask({ projectId: "p1", title, summary, brief: null, priority: 1, dependsOn: [], workKind: "implementation", profileOverride: null, profileSource: "default" } as never);
  task("Template picker", "Pick a template when creating a deal.");
  store.setTaskStatus("p1", task("Import DNS", "Move the zone to Cloudflare.").num, "cancelled");
  store.setTaskStatus("p1", task("Old work", "Backfill the cap table history.").num, "done");
  const build = (detail: OverviewDetail) => buildOverview(store, "p1", new Map(), NOW, null, detail);
  const out = { summary: build("summary"), history: build("history"), full: build("full") };
  db.close();
  return out;
}
function mount(history: Promise<Overview> | Overview = tiers().history, every?: Overview) {
  const o = tiers();
  const overview = vi.fn((input: unknown) => {
    const { detail } = input as { detail: OverviewDetail };
    return every ?? (detail === "history" ? history : o[detail]);
  });
  const slot = renderSlot(app.navPanels[0], { subPath: "p1" }, { rpc: { inventory: () => [], list: () => [], overview, command: vi.fn().mockResolvedValue({}) } });
  mounted.push(slot);
  return { slot, overview };
}

describe("F1 the Tasks tab loads the done and cancelled tasks", () => {
  it("opening Tasks reads the history tier, saying so while it loads, and then shows the hand-cancelled task and its Follow the work", async () => {
    let resolve!: (o: Overview) => void;
    const { slot, overview } = mount(new Promise<Overview>((r) => { resolve = r; }));
    fireEvent.click(await slot.findByRole("tab", { name: /Tasks/ }));
    await waitFor(() => expect(overview).toHaveBeenCalledWith(expect.objectContaining({ detail: "history" })));
    expect(slot.getByText("Loading done and cancelled tasks…")).toBeTruthy();
    expect(slot.queryByText("No tasks yet.")).toBeNull();
    resolve(tiers().history);
    const cancelled = await slot.findByRole("region", { name: "Cancelled" }, { timeout: 3000 });
    expect(within(cancelled).getByText("Import DNS")).toBeTruthy();
    expect(within(slot.getByRole("region", { name: "Done" })).getByText("Old work")).toBeTruthy();
    fireEvent.click(slot.getByText("Cancelled"));
    fireEvent.click(within(cancelled).getByText("Import DNS"));
    expect(within(cancelled).getByRole("button", { name: "Follow the work" })).toBeTruthy();
    expect(slot.queryByText("Loading done and cancelled tasks…")).toBeNull();
  });
});

describe("F12 the task editor starts from the stored summary, whatever the status", () => {
  it("a done task's editor holds its description", async () => {
    // Every tier at once, so this reads only the editor, whatever loads the done tasks.
    const { slot } = mount(undefined, tiers().full);
    fireEvent.click(await slot.findByRole("tab", { name: /Tasks/ }));
    const done = await slot.findByRole("region", { name: "Done" }, { timeout: 3000 });
    fireEvent.click(slot.getByText("Done", { selector: "summary *, summary" }));
    fireEvent.click(within(done).getByText("Old work"));
    fireEvent.click(within(done).getByRole("button", { name: "Edit task" }));
    expect((within(done).getByLabelText("Task summary") as HTMLTextAreaElement).value).toBe("Backfill the cap table history.");
  });
});
