// @vitest-environment jsdom
// T129: every user command that changes Needs you announces the change once,
// after it is saved, so the sidebar tree and every open dashboard update at
// once, without a reload or the 15 s poll.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { projectFixture } from "./fake-native";

await loadPluginApp(() => import("../app"));
const { Dashboard } = await import("../app");
const slots: ReturnType<typeof renderSlot>[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.unmount(); cleanup(); });

type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const coordinator = { author: "coordinator" as const, threadId: "coordinator", assignment: null };

/** An Adventure with one open question for the user (W555: the only thing Needs you counts). */
async function asked() {
  const { f, project } = await projectFixture();
  const q = f.service.recordQuestion(project.id, { title: "Keys", humanAttention: "needs-opinion", question: "Which Railway env keys does Tekk Paris need?", context: "The deploy needs two secrets only Erwin has." }, coordinator);
  return { f, project, q };
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
        dashboard: f.overview(projectId, "summary").then((o) => o.opinionNeeded.length),
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
    const { f, project, q } = await asked();
    const w = watch(f, project.id);
    await command(f, project.id, { action: "question-close", decision: q.ref, note: "" });
    await w.take();
    // Closing again returns the closed question and writes nothing.
    await command(f, project.id, { action: "question-close", decision: q.ref, note: "" });
    // An answer to a closed question is refused before anything is saved.
    await expect(command(f, project.id, { action: "answer", decision: q.ref, choice: null, note: "x" })).rejects.toThrow();
    // Reads write nothing either.
    await f.harness.callAgentTool("initiative_read", {}, { threadId: "coordinator" });
    expect(await w.take()).toEqual({ signals: [], bumped: [] });
  });

  it("another open dashboard drops its Needs you pill on the signal alone", async () => {
    const { f, project, q } = await asked();
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
    // The answer comes from another view; this one only hears its signal.
    await command(f, project.id, { action: "answer", decision: q.ref, choice: null, note: "Use the staging keys." });
    await relay();
    await waitFor(() => expect(slot.queryByRole("button", { name: /Needs you/ })).toBeNull());
  });
});
