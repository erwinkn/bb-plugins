// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { projectFixture } from "./fake-native";
import { appReads } from "../lib/dashboard-data";
import type { Overview } from "../lib/overview";
await loadPluginApp(() => import("../app"));
const { Dashboard, ProjectHeader, ProjectPanel } = await import("../app");
const slots: ReturnType<typeof renderSlot>[] = [];
afterEach(() => { for (const s of slots.splice(0)) s.unmount(); cleanup(); });

// W248: the UI fixes for W246's re-review (A425).
describe("W248 a panel read from before a save never seeds the overview (A425 finding 4)", () => {
  it("the real panel read, held across a header save, leaves the overview on the saved mode", async () => {
    const { f, project } = await projectFixture();
    const before = await f.harness.callRpc("panel", { threadId: "coordinator" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // The first read paints; the second starts before the save and answers after it.
    const panel = vi.fn(async () => {
      if (panel.mock.calls.length === 1) return before;
      if (panel.mock.calls.length === 2) { await gate; return before; }
      return new Promise<never>(() => {});
    });
    const setMemory = (input: unknown) => f.harness.callRpc("setMemory", input as never);
    const s = renderSlot({ component: ProjectHeader }, { threadId: "coordinator", isCompactViewport: false } as never, { rpc: { panel, setMemory } }); slots.push(s);
    const overviewMode = () => (appReads.entry(`overview:${project.id}`).data as Overview | null)?.memory?.mode;
    try {
      await s.findByRole("button", { name: "Memory: Regular. Change it" });
      expect(overviewMode()).toBe("regular");
      fireEvent(window, new Event("online"));
      await waitFor(() => expect(panel).toHaveBeenCalledTimes(2));
      fireEvent.click(s.getByRole("radio", { name: "Hybrid" }));
      await s.findByRole("button", { name: "Memory: Hybrid. Change it" });
      expect(overviewMode()).toBe("hybrid");
      await act(async () => { release(); await gate; });
      await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
      expect(overviewMode()).toBe("hybrid");
      expect(s.getByRole("button", { name: "Memory: Hybrid. Change it" })).toBeTruthy();
      expect(f.service.memory.settings(project.id).mode).toBe("hybrid");
    } finally {
      release();
      await f.service.memory.settled();
    }
  });
});

describe("W248 a failed keyboard save takes focus back to the saved mode (A425 finding 6)", () => {
  it("after a refused save, focus is on the selected mode and the arrows move on from there", async () => {
    const { f, project } = await projectFixture();
    const setMemory = vi.fn(async (input: unknown) => {
      if (setMemory.mock.calls.length === 1) throw new Error("Save refused");
      return f.harness.callRpc("setMemory", input as never);
    });
    const s = renderSlot({ component: Dashboard }, { projectId: project.id }, { rpc: { overview: async () => f.overview(project.id), setMemory } }); slots.push(s);
    const group = await s.findByRole("radiogroup", { name: "Memory" });
    const radio = (name: string) => within(group).getByRole("radio", { name });
    radio("Regular").focus();
    fireEvent.keyDown(radio("Regular"), { key: "ArrowRight" });
    expect((await s.findByRole("alert")).textContent).toBe("Save refused");
    expect(radio("Regular").getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(radio("Regular"));
    expect(radio("Regular").tabIndex).toBe(0);
    // ArrowLeft goes from the selected Regular to OptChat, not from the attempted Hybrid back to Regular.
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(radio("OptChat"));
    await waitFor(() => expect(f.service.memory.settings(project.id).mode).toBe("optchat"));
    await f.service.memory.settled();
  });
});

// W248 follow-up: W251's review (A429).
describe("W248 follow-up: the thread header follows a dashboard memory save (A429)", () => {
  it("a panel read held across the dashboard's save leaves the header on the saved mode, and its other modes still save", async () => {
    const { f, project } = await projectFixture();
    const before = await f.harness.callRpc("panel", { threadId: "coordinator" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const panel = vi.fn(async () => {
      if (panel.mock.calls.length === 1) return before;
      if (panel.mock.calls.length === 2) { await gate; return before; }
      return new Promise<never>(() => {});
    });
    const setMemory = vi.fn((input: unknown) => f.harness.callRpc("setMemory", input as never));
    const header = renderSlot({ component: ProjectHeader }, { threadId: "coordinator", isCompactViewport: false } as never, { rpc: { panel, setMemory } }); slots.push(header);
    try {
      await header.findByRole("button", { name: "Memory: Regular. Change it" });
      const page = renderSlot({ component: ProjectPanel }, { threadId: "coordinator" } as never, { rpc: { panel, overview: async () => f.overview(project.id), setMemory } }); slots.push(page);
      const group = await within(page.container).findByRole("radiogroup", { name: "Memory" });
      fireEvent(window, new Event("online"));
      await waitFor(() => expect(panel).toHaveBeenCalledTimes(2));
      fireEvent.click(within(group).getByRole("radio", { name: "Hybrid" }));
      await waitFor(() => expect(within(group).getByRole("radio", { name: "Hybrid" }).getAttribute("aria-checked")).toBe("true"));
      await act(async () => { release(); await gate; });
      await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
      expect(within(header.container).getByRole("button", { name: "Memory: Hybrid. Change it" })).toBeTruthy();
      // Regular is a real change again, so the header saves it.
      fireEvent.click(within(header.container).getByRole("radio", { name: "Regular" }));
      await waitFor(() => expect(f.service.memory.settings(project.id).mode).toBe("regular"));
      await within(header.container).findByRole("button", { name: "Memory: Regular. Change it" });
    } finally {
      release();
      await f.service.memory.settled();
    }
  });
});
