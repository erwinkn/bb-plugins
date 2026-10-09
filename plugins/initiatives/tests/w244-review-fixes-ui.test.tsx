// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { projectFixture } from "./fake-native";
await loadPluginApp(() => import("../app"));
const { Dashboard } = await import("../app");
const slots: ReturnType<typeof renderSlot>[] = [];
afterEach(() => { for (const s of slots.splice(0)) s.unmount(); cleanup(); vi.useRealTimers(); });

// W244: the UI fixes for W242's review (A421) of W239's dashboard writes. The memory switch's
// moved to the Chat memory plugin with T145.
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
