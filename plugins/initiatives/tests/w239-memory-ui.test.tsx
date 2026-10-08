// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { projectFixture } from "./fake-native";
await loadPluginApp(() => import("../app"));
const { Dashboard, ProjectHeader } = await import("../app");
const slots: ReturnType<typeof renderSlot>[] = [];
afterEach(() => { for (const s of slots.splice(0)) s.unmount(); cleanup(); });

// W239 (D447): the memory switch is a three-way segmented control in the dashboard header, the
// Context tab and the coordinator thread's header popover.
describe("W239 memory switch", () => {
  it("switches from the dashboard header, at once, and explains the chosen mode", async () => {
    const { f, project } = await projectFixture();
    const command = vi.fn((input: unknown) => f.harness.callRpc("command", input as never));
    const overview = vi.fn(async () => f.overview(project.id));
    const s = renderSlot({ component: Dashboard }, { projectId: project.id }, { rpc: { overview, command } }); slots.push(s);
    const group = await s.findByRole("radiogroup", { name: "Memory" });
    expect(within(group).getByRole("radio", { name: "Regular" }).getAttribute("aria-checked")).toBe("true");
    expect(s.getByText("One long chat, compacted once it gets large.")).toBeTruthy();
    fireEvent.click(within(group).getByRole("radio", { name: "Hybrid" }));
    await waitFor(() => expect(within(group).getByRole("radio", { name: "Hybrid" }).getAttribute("aria-checked")).toBe("true"));
    expect(command).toHaveBeenCalledWith({ projectId: project.id, command: { action: "memory", mode: "hybrid" } });
    expect(f.service.memory.settings(project.id).mode).toBe("hybrid");
    expect(s.getByText("Compacts sooner; what it drops stays one zoom away in the summary tree.")).toBeTruthy();
    await f.service.memory.settled();
  });

  it("the Context tab lists every mode with its line, and shows a failed switch", async () => {
    const { f, project } = await projectFixture();
    const command = vi.fn(async () => { throw new Error("Unknown Initiative x."); });
    const o = await f.overview(project.id);
    const s = renderSlot({ component: Dashboard }, { projectId: project.id }, { rpc: { overview: async () => o, command, inventory: async () => [] } }); slots.push(s);
    fireEvent.click(await s.findByRole("tab", { name: "Context" }));
    const panel = await s.findByRole("region", { name: "Memory" });
    for (const line of ["One long chat", "Compacts sooner", "A fresh session per message"]) expect(within(panel).getByText(new RegExp(line))).toBeTruthy();
    fireEvent.click(within(panel).getByRole("radio", { name: "OptChat" }));
    expect(await within(panel).findByRole("alert")).toHaveProperty("textContent", "Unknown Initiative x.");
    expect(within(panel).getByRole("radio", { name: "Regular" }).getAttribute("aria-checked")).toBe("true");
  });

  it("the coordinator's thread header carries a memory pill and popover; a worker's does not", async () => {
    const { f, project } = await projectFixture();
    const panel = vi.fn((input: unknown) => f.harness.callRpc("panel", input as never));
    const command = vi.fn((input: unknown) => f.harness.callRpc("command", input as never));
    const s = renderSlot({ component: ProjectHeader }, { threadId: "coordinator", isCompactViewport: false } as never, { rpc: { panel, command } }); slots.push(s);
    const pill = await s.findByRole("button", { name: "Memory: Regular. Change it" });
    expect(pill.textContent).toBe("Memory · Regular");
    const group = s.getByRole("radiogroup", { name: "Memory" });
    expect(within(group.closest(".project-memory-popover") as HTMLElement).getByText("The summary tree builds in every mode, so a switch is instant and applies from the next turn.")).toBeTruthy();
    fireEvent.click(within(group).getByRole("radio", { name: "Hybrid" }));
    await s.findByRole("button", { name: "Memory: Hybrid. Change it" });
    expect(command).toHaveBeenCalledWith({ projectId: project.id, command: { action: "memory", mode: "hybrid" } });
    await f.service.memory.settled();
    slots.splice(slots.indexOf(s), 1);
    s.unmount();

    const [w] = JSON.parse(await f.harness.callAgentTool("initiative_spawn", { label: "Search", purpose: "search", text: "Do it." }, { threadId: "coordinator" }) as string);
    const worker = renderSlot({ component: ProjectHeader }, { threadId: w.threadId, isCompactViewport: false } as never, { rpc: { panel } }); slots.push(worker);
    await worker.findByRole("button", { name: /^Initiative overview/ });
    expect(worker.queryByRole("button", { name: /^Memory/ })).toBeNull();
  });
});

describe("W239 a write the relay never answers", () => {
  it("says it is slow after 5 s, then unconfirmed after 30 s, and the dashboard reads again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { f, project } = await projectFixture();
      const o = await f.overview(project.id);
      const overview = vi.fn(async () => o);
      const command = vi.fn(() => new Promise<never>(() => {}));
      const s = renderSlot({ component: Dashboard }, { projectId: project.id }, { rpc: { overview, command } }); slots.push(s);
      const group = await s.findByRole("radiogroup", { name: "Memory" });
      fireEvent.click(within(group).getByRole("radio", { name: "Hybrid" }));
      expect(within(group).getByRole("radio", { name: "Hybrid" }).getAttribute("aria-checked")).toBe("true");
      const reads = overview.mock.calls.length;
      await act(() => vi.advanceTimersByTimeAsync(5_000));
      expect(s.getByRole("status").textContent).toBe("Still saving: the connection is slow.");
      await act(() => vi.advanceTimersByTimeAsync(25_000));
      expect(s.getByRole("alert").textContent).toMatch(/^No answer after 30 s: this may still be saved/);
      expect(within(group).getByRole("radio", { name: "Regular" }).getAttribute("aria-checked")).toBe("true");
      // The held reads resume.
      await act(() => vi.advanceTimersByTimeAsync(500));
      expect(overview.mock.calls.length).toBeGreaterThan(reads);
    } finally {
      vi.useRealTimers();
    }
  });
});
