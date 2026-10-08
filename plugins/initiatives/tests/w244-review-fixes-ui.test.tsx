// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { projectFixture } from "./fake-native";
import { appReads } from "../lib/dashboard-data";
import { SESSION_NOTE } from "../lib/memory/memory";
await loadPluginApp(() => import("../app"));
const { Dashboard, ProjectHeader } = await import("../app");
const slots: ReturnType<typeof renderSlot>[] = [];
afterEach(() => { for (const s of slots.splice(0)) s.unmount(); cleanup(); vi.useRealTimers(); });

// W244: the UI fixes for W242's review (A421) of W239's memory setting redesign.
describe("W244 Add task after a lost answer", () => {
  it("sent again while the first still waits in the server's write queue, it creates one task", async () => {
    const { f, project } = await projectFixture();
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const atGate = new Promise<void>((resolve) => (reached = resolve));
    f.intercept(async (path, _args, call) => {
      if (path === "threads.spawn") {
        reached();
        await gate;
      }
      return call();
    });
    const slow = f.harness.callRpc("command", { projectId: project.id, command: { action: "delegate", label: "Slow", area: "hold the queue", note: "Test." } });
    await atGate;
    const command = vi.fn((input: unknown) => f.harness.callRpc("command", input as never));
    const s = renderSlot({ component: Dashboard }, { projectId: project.id }, { rpc: { overview: async () => f.overview(project.id), command } }); slots.push(s);
    try {
      fireEvent.click(await s.findByRole("tab", { name: "Tasks" }));
      fireEvent.click(s.getByText("Add a task"));
      fireEvent.change(s.getByLabelText("Task title"), { target: { value: "Single intended task" } });
      fireEvent.change(s.getByLabelText("What should be achieved?"), { target: { value: "Create once" } });
      vi.useFakeTimers({ shouldAdvanceTime: true });
      fireEvent.click(s.getByRole("button", { name: "Add task" }));
      await act(() => vi.advanceTimersByTimeAsync(30_000));
      expect(s.getByRole("alert").textContent).toMatch(/Sending the same again never saves it twice/);
      expect(f.store.tasks(project.id)).toHaveLength(0);
      fireEvent.click(s.getByRole("button", { name: "Add task" }));
      expect(command).toHaveBeenCalledTimes(2);
      const [first, again] = command.mock.calls.map(([input]) => (input as { key: string }).key);
      expect(again).toBe(first);
      release();
      await slow;
      await waitFor(() => expect((s.getByLabelText("Task title") as HTMLInputElement).value).toBe(""));
      expect(f.store.tasks(project.id).map((t) => t.title)).toEqual(["Single intended task"]);
    } finally {
      release();
      await slow;
      f.intercept();
    }
  });
});

describe("W244 the thread header's memory switch", () => {
  it("shows the saved mode at once, whatever a panel read from before the save returns later", async () => {
    const { f, project } = await projectFixture();
    const before = await f.harness.callRpc("panel", { threadId: "coordinator" });
    const setMemory = vi.fn((input: unknown) => f.harness.callRpc("setMemory", input as never));
    const s = renderSlot({ component: ProjectHeader }, { threadId: "coordinator", isCompactViewport: false } as never, { rpc: { panel: async () => before, setMemory } }); slots.push(s);
    await s.findByRole("button", { name: "Memory: Regular. Change it" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // A read that started before the save, and answers after it with the old mode.
    const oldRead = appReads.refresh("panel:coordinator", async () => { await gate; return before; });
    fireEvent.click(s.getByRole("radio", { name: "Hybrid" }));
    await waitFor(() => expect(f.service.memory.settings(project.id).mode).toBe("hybrid"));
    release();
    await oldRead;
    await s.findByRole("button", { name: "Memory: Hybrid. Change it" });
    expect(s.getByRole("radio", { name: "Hybrid" }).getAttribute("aria-checked")).toBe("true");
    expect(s.queryAllByRole("alert")).toHaveLength(0);
    await f.service.memory.settled();
  });

  it("says when the coordinator may lack its memory tools", async () => {
    const { f, project } = await projectFixture();
    const o = await f.overview(project.id);
    const s = renderSlot({ component: Dashboard }, { projectId: project.id }, { rpc: { overview: async () => ({ ...o, memory: { ...o.memory!, mode: "hybrid", sessionNote: SESSION_NOTE } }) } }); slots.push(s);
    expect(await s.findByText(SESSION_NOTE)).toBeTruthy();
  });
});

describe("W244 the memory switch is a radio group for the keyboard", () => {
  it("Tab reaches only the selected mode; the arrows select and save a neighbour, keeping focus", async () => {
    const { f, project } = await projectFixture();
    const setMemory = vi.fn((input: unknown) => f.harness.callRpc("setMemory", input as never));
    const s = renderSlot({ component: Dashboard }, { projectId: project.id }, { rpc: { overview: async () => f.overview(project.id), setMemory } }); slots.push(s);
    const group = await s.findByRole("radiogroup", { name: "Memory" });
    const radio = (name: string) => within(group).getByRole("radio", { name });
    expect(["Regular", "Hybrid", "OptChat"].map((m) => radio(m).tabIndex)).toEqual([0, -1, -1]);
    radio("Regular").focus();
    fireEvent.keyDown(radio("Regular"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(radio("Hybrid"));
    await waitFor(() => expect(f.service.memory.settings(project.id).mode).toBe("hybrid"));
    await waitFor(() => expect(radio("Hybrid").getAttribute("aria-disabled")).toBe("false"));
    expect(["Regular", "Hybrid", "OptChat"].map((m) => radio(m).tabIndex)).toEqual([-1, 0, -1]);
    // Left from the first wraps to the last; End and Home go to either end.
    fireEvent.keyDown(radio("Hybrid"), { key: "End" });
    await waitFor(() => expect(f.service.memory.settings(project.id).mode).toBe("optchat"));
    await waitFor(() => expect(radio("OptChat").getAttribute("aria-disabled")).toBe("false"));
    fireEvent.keyDown(radio("OptChat"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(radio("Regular"));
    await waitFor(() => expect(f.service.memory.settings(project.id).mode).toBe("regular"));
    await f.service.memory.settled();
  });
});
