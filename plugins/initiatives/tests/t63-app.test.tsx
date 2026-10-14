// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { projectFixture } from "./fake-native";
import { answersLikeServer } from "./helpers";
import type { Overview } from "../lib/overview";
await loadPluginApp(() => import("../app"));
const { Dashboard, ProjectsPage } = await import("../app");
const slots: ReturnType<typeof renderSlot>[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.unmount(); cleanup(); });
const held = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const recorder = { author: "coordinator" as const, threadId: "coordinator", assignment: null };
async function setup() {
  const { f, project } = await projectFixture();
  const d = f.service.recordDecision(project.id, { decision: { description: "Use the native composer", madeBy: "agent" } }, recorder);
  const o = await f.overview(project.id);
  return { f, project, d, o };
}
function mount(projectId: string, rpc: NonNullable<Parameters<typeof renderSlot>[2]>["rpc"], connection: "connected" | "connecting" = "connected") {
  const slot = renderSlot({ component: Dashboard }, { projectId }, { rpc, realtimeConnectionState: connection }); slots.push(slot); return slot;
}
const beat = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 190)); });

describe("T63 dashboard request/acknowledgment boundaries", () => {
  it("mounts once, coalesces relevant signals, keeps cached data during refresh and lazily loads inventory/telemetry", async () => {
    const { project, o } = await setup(); const pending = held<Overview>();
    const overview = vi.fn().mockResolvedValueOnce(o).mockImplementation(() => pending.promise);
    const inventory = vi.fn(async () => []); const slot = mount(project.id, { overview, inventory });
    await slot.findByRole("tab", { name: "Workers" }); await beat(); expect(overview).toHaveBeenCalledTimes(1); expect(inventory).not.toHaveBeenCalled();
    await slot.behavior.emitRealtime("initiatives-changed", { projectId: "foreign" }); await beat(); expect(overview).toHaveBeenCalledTimes(1);
    for (let n = 0; n < 4; n++) await slot.behavior.emitRealtime("initiatives-changed", { projectId: project.id });
    await waitFor(() => expect(overview).toHaveBeenCalledTimes(2));
    expect(slot.getByRole("tab", { name: "Workers" })).toBeTruthy();
    await slot.behavior.emitRealtime("initiatives-changed", { projectId: project.id }); await beat(); expect(overview).toHaveBeenCalledTimes(2);
    // Rules loads the repository inventory; Workers loads retired workers and token totals.
    fireEvent.click(slot.getByRole("tab", { name: "Rules" }));
    await waitFor(() => expect(inventory).toHaveBeenCalledTimes(1));
    fireEvent.click(slot.getByRole("tab", { name: "Workers" }));
    await waitFor(() => expect(overview).toHaveBeenCalledTimes(3)); expect(overview.mock.calls[0][0]).toEqual({ projectId: project.id, detail: "summary" });
    // T125: the signal that landed during the held read may postdate it, so one read follows it.
    pending.resolve(o); await waitFor(() => expect(overview).toHaveBeenCalledTimes(4)); await beat(); expect(overview).toHaveBeenCalledTimes(4); slot.unmount();
    await slot.behavior.emitRealtime("initiatives-changed", {}); await beat(); expect(overview).toHaveBeenCalledTimes(4);
  });

  it("first realtime connection does not duplicate the mount; a genuine reconnect refreshes once", async () => {
    const { project, o } = await setup(); const overview = vi.fn(async () => o);
    const slot = mount(project.id, { overview }, "connecting");
    await slot.findByRole("tab", { name: "Workers" });
    await slot.behavior.setRealtimeConnectionState("connected"); await beat(); expect(overview).toHaveBeenCalledTimes(1);
    await slot.behavior.setRealtimeConnectionState("reconnecting"); await slot.behavior.setRealtimeConnectionState("connected");
    await waitFor(() => expect(overview).toHaveBeenCalledTimes(2));
  });


  it("NewTask acknowledges its durable result without an overview gate", async () => {
    const { f, project, o } = await setup(); const refresh = held<Overview>();
    const overview = vi.fn().mockResolvedValueOnce(o).mockImplementation(() => refresh.promise);
    const command = vi.fn((input: unknown) => f.harness.callRpc("command", input));
    const slot = mount(project.id, { overview, command });
    fireEvent.click(await slot.findByRole("tab", { name: "Tasks" }));
    fireEvent.click(slot.getByText("Add a task"));
    fireEvent.change(slot.getByLabelText("Task title"), { target: { value: "New task" } });
    fireEvent.change(slot.getByLabelText("What should be achieved?"), { target: { value: "Keep acknowledgment fast" } });
    fireEvent.click(slot.getByRole("button", { name: "Add task" }));
    await slot.findByText("T1: saved.");
    expect(slot.queryByText("Adding…")).toBeNull(); expect((slot.getByLabelText("Task title") as HTMLInputElement).value).toBe("");
    await waitFor(() => expect(overview).toHaveBeenCalledTimes(2)); expect(command).toHaveBeenCalledTimes(1);
    refresh.resolve(await f.overview(project.id));
  });

  it.each(["failed", "queued", "uncertain"] as const)("an answer keeps its %s receipt visible after a failed background refresh", async state => {
    const { f, project } = await setup();
    const q = f.service.recordQuestion(project.id, { title: "Scope", question: "Include archives?", context: "Need scope", humanAttention: "needs-opinion", options: [{ label: "Yes", consequences: "Include archived work" }] }, recorder);
    const initial = await f.overview(project.id); const refresh = held<Overview>();
    const overview = vi.fn().mockResolvedValueOnce(initial).mockImplementation(() => refresh.promise);
    const command = vi.fn(async ({ command: input }) => {
      const saved = await f.service.answerOpinion(project.id, q.ref, input);
      return { ...saved, notification: { op: "test", state, coordinatorThreadId: "coordinator", ...(state === "failed" ? { detail: "Refused" } : {}) } };
    });
    const slot = mount(project.id, { overview, command: answersLikeServer(command) });
    fireEvent.click(await slot.findByRole("radio", { name: /Yes/ })); fireEvent.click(slot.getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(slot.container.textContent).toContain(`${q.ref}: answer saved. Coordinator notification ${state}`));
    expect(slot.queryByText("Saving…")).toBeNull(); expect(slot.queryByRole("radio", { name: /Yes/ })).toBeNull();
    await waitFor(() => expect(overview).toHaveBeenCalledTimes(2)); await act(async () => { refresh.reject(new Error("Answer refresh failed")); });
    await slot.findByText("Answer refresh failed"); expect(slot.container.textContent).toContain(`notification ${state}`);
    expect(f.send).toHaveBeenCalledTimes(1); expect(f.send.mock.calls[0][0].mode).toBe("steer-if-active");
  });



  it("route switch cannot show another Initiative's cache or old action receipt", async () => {
    const { project, o, d } = await setup(); const pending = held<Overview>(), save = held<unknown>();
    const second = { ...o, project: { ...o.project, id: "second", name: "Second Initiative" } };
    const overview = vi.fn(({ projectId }) => projectId === "second" ? pending.promise : Promise.resolve(o));
    const slot = mount(project.id, { overview, command: () => save.promise });
    fireEvent.click(await slot.findByRole("button", { name: /Initiative menu/ }));
    fireEvent.click(slot.getByRole("button", { name: "Pause" }));
    slot.rerender(createElement(Dashboard, { projectId: "second" }));
    expect(slot.queryByText(o.project.name)).toBeNull(); expect(slot.container.querySelector(`[data-project-id="second"]`)).not.toBeNull();
    await act(async () => { save.resolve({ ref: d.ref }); pending.resolve(second); });
    await slot.findByText("Second Initiative"); expect(slot.queryByText(/saved/)).toBeNull();
    await beat(); expect(overview.mock.calls.filter(([input]) => input.projectId === "second")).toHaveLength(1);
  });

  it("D536: the bare route is no overview: it reads no Initiative list and points to the sidebar", async () => {
    const list = vi.fn(async () => []);
    const slot = renderSlot({ component: ProjectsPage }, { subPath: "" }, { rpc: { list } }); slots.push(slot);
    await slot.findByText(/Initiatives are listed in the sidebar/);
    await slot.behavior.emitRealtime("initiatives-changed", {}); await beat();
    expect(list).not.toHaveBeenCalled();
    expect(slot.queryByRole("button", { name: "New initiative" })).toBeNull();
  });
});
