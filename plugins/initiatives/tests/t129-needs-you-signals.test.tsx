// @vitest-environment jsdom
// T129: every user command that changes Needs you announces the change once,
// after it is saved, so the sidebar tree and every open dashboard update at
// once, without a reload or the 15 s poll.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { needsYouCount } from "../lib/blockers";
import { projectFixture, report } from "./fake-native";

await loadPluginApp(() => import("../app"));
const { Dashboard } = await import("../app");
const slots: ReturnType<typeof renderSlot>[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.unmount(); cleanup(); });

type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const question = "Which Railway env keys does Tekk Paris need?";
const context = "The deploy needs two secrets only Erwin has.";
const blocked = { ...report(), outcome: "blocked" as const, summary: "Blocked on secrets.", blocker: { question, context } };

async function blockedWorker() {
  const { f, project } = await projectFixture();
  const task = f.task(project.id, "Deploy Tekk Paris");
  const [a] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
  await f.service.report(a.threadId!, blocked as never);
  f.idle(a.threadId!);
  return { f, project };
}

/**
 * Each Initiatives signal and sidebar bump, with Needs you as the tree and
 * the dashboard pill counted it at that moment: a view refreshing on the
 * signal must already read the new state.
 */
function watch(f: Fx, projectId: string) {
  const signals: { payload: unknown; tree: number; dashboard: Promise<number> }[] = [];
  const publish = f.bb.realtime.publish.bind(f.bb.realtime);
  vi.spyOn(f.bb.realtime, "publish").mockImplementation((channel, payload) => {
    if (channel === "initiatives-changed")
      signals.push({
        payload,
        tree: (f.tree().projects[0] as { needsYou: number }).needsYou,
        dashboard: f.overview(projectId, "summary").then(needsYouCount),
      });
    return publish(channel, payload);
  });
  const bumps = f.pluginRpc;
  bumps.mockClear();
  const sidebar = () => bumps.mock.calls.filter(([args]) => args.pluginId === "sidebar" && args.method === "initiativesChanged");
  return {
    async take() {
      const taken = await Promise.all(signals.splice(0).map(async (s) => ({ payload: s.payload, tree: s.tree, dashboard: await s.dashboard })));
      const bumped = sidebar().map(([args]) => args.input);
      bumps.mockClear();
      return { signals: taken, bumped };
    },
  };
}
const command = (f: Fx, projectId: string, command: Record<string, unknown>) =>
  f.harness.callRpc("command", { projectId, command });

describe("T129 Needs you commands announce once, after saving", () => {
  it("dismiss, undo, dismiss again and answer each update the tree and dashboard counts at their signal", async () => {
    const { f, project } = await blockedWorker();
    const w = watch(f, project.id);
    const once = (needsYou: number) => ({
      signals: [{ payload: { projectId: project.id }, tree: needsYou, dashboard: needsYou }],
      bumped: [{ projectId: project.id }],
    });
    const blocker = { assignment: "A1", question, context };
    const d = (await command(f, project.id, { action: "blocker-dismiss", ...blocker, notify: false, note: "" })) as { ref: string };
    expect(await w.take()).toEqual(once(0));
    await command(f, project.id, { action: "blocker-dismiss-undo", decision: d.ref });
    expect(await w.take()).toEqual(once(1));
    await command(f, project.id, { action: "blocker-answer", ...blocker, note: "Use the staging keys." });
    expect(await w.take()).toEqual(once(0));
  });

  it("a question's answer clears it from Needs you at its signal", async () => {
    const { f, project } = await projectFixture();
    const w = watch(f, project.id);
    // An agent tool is an entry point too: one signal, though it runs through the command path.
    const asked = JSON.parse(await f.harness.callAgentTool("initiative_decision", { action: "question", question: "Which checkout?", context: "Choose the writer home.", options: ["Main", "Worktree"] }, { threadId: "coordinator" }) as string) as { ref: string };
    expect(await w.take()).toEqual({ signals: [{ payload: { projectId: project.id }, tree: 1, dashboard: 1 }], bumped: [{ projectId: project.id }] });
    await command(f, project.id, { action: "answer", decision: asked.ref, choice: "Main", note: "" });
    expect(await w.take()).toEqual({ signals: [{ payload: { projectId: project.id }, tree: 0, dashboard: 0 }], bumped: [{ projectId: project.id }] });
  });

  it("a command that saves nothing announces nothing", async () => {
    const { f, project } = await blockedWorker();
    const w = watch(f, project.id);
    await command(f, project.id, { action: "blocker-dismiss", assignment: "A1", question, context, notify: false, note: "" });
    await w.take();
    // Dismissing again returns the existing dismissal and writes nothing.
    await command(f, project.id, { action: "blocker-dismiss", assignment: "A1", question, context, notify: false, note: "" });
    // A stale blocker is refused before anything is saved.
    await expect(command(f, project.id, { action: "blocker-answer", assignment: "A1", question: "Something else?", context, note: "x" })).rejects.toThrow();
    // Reads write nothing either.
    await f.harness.callAgentTool("initiative_read", {}, { threadId: "coordinator" });
    expect(await w.take()).toEqual({ signals: [], bumped: [] });
  });

  it("another open dashboard drops and restores its Needs you pill on the signal alone", async () => {
    const { f, project } = await blockedWorker();
    const signals: unknown[] = [];
    const publish = f.bb.realtime.publish.bind(f.bb.realtime);
    vi.spyOn(f.bb.realtime, "publish").mockImplementation((channel, payload) => {
      if (channel === "initiatives-changed") signals.push(payload);
      return publish(channel, payload);
    });
    const slot = renderSlot({ component: Dashboard }, { projectId: project.id }, {
      rpc: { overview: (input: unknown) => f.harness.callRpc("overview", input) },
    } as never);
    slots.push(slot);
    expect(await slot.findByRole("button", { name: "Needs you · 1" })).toBeTruthy();
    const relay = async () => { for (const payload of signals.splice(0)) await slot.behavior.emitRealtime("initiatives-changed", payload); };
    // The dismissal happens in another view; this one only hears its signal.
    const d = (await command(f, project.id, { action: "blocker-dismiss", assignment: "A1", question, context, notify: false, note: "" })) as { ref: string };
    await relay();
    await waitFor(() => expect(slot.queryByRole("button", { name: /Needs you/ })).toBeNull());
    await command(f, project.id, { action: "blocker-dismiss-undo", decision: d.ref });
    await relay();
    expect(await slot.findByRole("button", { name: "Needs you · 1" })).toBeTruthy();
  });
});
