// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { projectFixture } from "./fake-native";
await loadPluginApp(() => import("../app"));
const { Dashboard } = await import("../app");
const slots: ReturnType<typeof renderSlot>[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.unmount(); cleanup(); });
const recorder = { author: "coordinator" as const, threadId: "coordinator", assignment: null };

describe("T112 dashboard tiers (A264)", () => {
  it("a newer summary keeps a new agent decision in the Inbox while history is older or failing", async () => {
    const { f, project } = await projectFixture();
    f.service.recordDecision(project.id, { decision: { description: "Settled user choice", madeBy: "user" } }, recorder);
    let summary: unknown = await f.harness.callRpc("overview", { projectId: project.id, detail: "summary" });
    const oldHistory = await f.harness.callRpc("overview", { projectId: project.id, detail: "history" });
    let historyFailed = false;
    const overview = vi.fn(async (input: unknown) => {
      if ((input as { detail?: string }).detail !== "history") return summary;
      if (historyFailed) throw new Error("History unavailable");
      return oldHistory;
    });
    const slot = renderSlot({ component: Dashboard }, { projectId: project.id }, { rpc: { overview } }); slots.push(slot);
    fireEvent.click(await slot.findByRole("tab", { name: "Decisions" }));
    await slot.findByText("Settled user choice");
    fireEvent.click(slot.getByRole("tab", { name: /^Inbox/ }));
    f.service.recordDecision(project.id, { decision: { description: "New pending agent choice", madeBy: "agent" } }, recorder);
    summary = await f.harness.callRpc("overview", { projectId: project.id, detail: "summary" });
    historyFailed = true;
    await slot.behavior.emitRealtime("projects-changed", { projectId: project.id });
    await slot.findByText("History unavailable");
    await waitFor(() => expect(slot.getAllByText("New pending agent choice").length).toBeGreaterThan(0));
    expect(slot.queryByText("You’re up to date.")).toBeNull();
    // The record still lists the settled choice from history.
    fireEvent.click(slot.getByRole("tab", { name: "Decisions" }));
    expect(slot.getByText("Settled user choice")).toBeTruthy();
  });
});
