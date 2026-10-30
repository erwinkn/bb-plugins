// @vitest-environment jsdom
// W555: a worker's blocked report reaches only its coordinator, which asks the user with
// initiative_question when only they can answer. The user sees that question once: no worker
// blocker card in the Inbox, nothing of it in Needs you, and a blocked worker waits on the
// coordinator in the Workers tab. A chat answer is recorded on the coordinator's own question.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { projectFixture } from "./fake-native";
import { emptySnapshot, handoverPacket } from "../lib/handover-packet";
await loadPluginApp(() => import("../app"));
const { Dashboard } = await import("../app");
const slots: ReturnType<typeof renderSlot>[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.unmount(); cleanup(); });

type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const tool = async (f: Fx, name: string, input: unknown, threadId = "coordinator") => JSON.parse(await f.harness.callAgentTool(name, input, { threadId }) as string);
const refused = (f: Fx, input: unknown, threadId = "coordinator") =>
  f.harness.callAgentTool("initiative_question", input, { threadId }).then(() => "", (e: Error) => e.message);
const sentTexts = (f: Fx) => f.send.mock.calls.map(([args]) => args.input[0].text as string);
const tree = async (f: Fx) => ((await f.harness.callRpc("tree", null)) as any).projects[0].needsYou as number;
const question = "Which staging key does the deploy use?";
const options = [{ label: "STAGING_KEY", consequences: "The shared key." }, { label: "A new key", consequences: "Erwin makes one." }];
const recommendation = "STAGING_KEY: it already works in CI.";

async function blockedWorker() {
  const { f, project } = await projectFixture();
  const task = f.task(project.id, "Deploy Tekk Paris");
  const [w] = await tool(f, "initiative_spawn", { label: "Deploy", purpose: "deploy", text: "Do it.", tasks: [task.ref] });
  f.send.mockClear();
  await tool(f, "initiative_report", { outcome: "blocked", summary: "Need a staging key.", question, options, recommendation, report: "Blocked on the key." }, w.threadId);
  f.idle(w.threadId);
  return { f, project, w: w as { worker: string; threadId: string } };
}

describe("W555 a worker's blocker reaches only its coordinator", () => {
  it("is sent whole to the coordinator, and never shows in the Inbox or Needs you", async () => {
    const { f, project, w } = await blockedWorker();
    // The coordinator gets the question, the options and the worker's pick to ask the user with.
    expect(sentTexts(f)).toEqual([expect.stringContaining(`${w.worker} is blocked on A1: ${question}\n\nOptions:\n- STAGING_KEY: The shared key.\n- A new key: Erwin makes one.\nRecommendation: ${recommendation}\n\nBlocked on the key.`)]);
    expect(f.send.mock.calls[0]![0]).toMatchObject({ threadId: "coordinator" });
    // The report keeps the blocker for the coordinator's reads.
    expect(f.store.assignment(project.id, 1)!.report!.blocker).toMatchObject({ question, options, recommendation });
    for (const tier of ["summary", "full"] as const) {
      const o = await f.overview(project.id, tier);
      expect(o).not.toHaveProperty("blockers");
      expect(o.opinionNeeded).toEqual([]);
      expect(o.workerGroups?.[w.worker]?.group).toBe("waiting");
    }
    expect(await tree(f)).toBe(0);
  });

  it("the dashboard shows no card and no Needs you; the Workers tab shows the worker blocked, waiting on the coordinator", async () => {
    const { f, project } = await blockedWorker();
    const slot = renderSlot({ component: Dashboard }, { projectId: project.id }, {
      rpc: { overview: (input: unknown) => f.harness.callRpc("overview", input) },
    } as never);
    slots.push(slot);
    expect(await slot.findByText("You’re up to date.")).toBeTruthy();
    expect(slot.queryByRole("button", { name: /Needs you/ })).toBeNull();
    expect(slot.queryByRole("region", { name: "Blocked workers" })).toBeNull();
    fireEvent.click(slot.getByRole("tab", { name: /Workers/ }));
    expect(slot.queryByRole("region", { name: "Needs you" })).toBeNull();
    expect(within(slot.getByRole("region", { name: "Waiting" })).getByText(`Blocked, waiting on the coordinator: ${question}`, { exact: false })).toBeTruthy();
  });

  it("the coordinator's question is the one ask, and its chat answer is recorded on it", async () => {
    const { f, project } = await blockedWorker();
    f.send.mockClear();
    const asked = await tool(f, "initiative_question", { question, context: "W1 needs it to deploy.", options, recommendation });
    expect(asked).toMatchObject({ ref: "D1" });
    expect(await tree(f)).toBe(1);
    expect((await f.overview(project.id, "summary")).opinionNeeded.map((q) => q.ref)).toEqual(["D1"]);
    // The user answers in the coordinator's chat instead of in the Inbox.
    const said = "Erwin: use STAGING_KEY.";
    expect(await tool(f, "initiative_question", { answered: "D1", text: said, choice: "STAGING_KEY" })).toMatchObject({ ref: "D1", status: "answered" });
    expect(await tree(f)).toBe(0);
    expect((await f.overview(project.id, "summary")).opinionNeeded).toEqual([]);
    const d = f.store.decisionItem(project.id, 1)!;
    expect(d).toMatchObject({ madeBy: "user", status: "answered", notification: null });
    expect(d.body.answer).toMatchObject({ choice: "STAGING_KEY", note: said, recordedBy: { author: "coordinator", threadId: "coordinator" } });
    // The coordinator recorded it and relays it itself: nothing is sent. The answer stands (T53).
    expect(await refused(f, { answered: "D1", text: said, choice: "STAGING_KEY" })).toMatch(/already answered; the recorded answer stands/);
    expect(f.send).not.toHaveBeenCalled();
  });

  it("answered takes only the coordinator's open D#, with the user's words", async () => {
    const { f, project, w } = await blockedWorker();
    await tool(f, "initiative_question", { question, context: "W1 needs it to deploy.", options });
    expect(await refused(f, { answered: "A1", question, text: "Use STAGING_KEY." })).toMatch(/A1 is a worker's report: its question is not in the user's Inbox/);
    expect(await refused(f, { answered: "W1", text: "x" })).toMatch(/D# of your open question/);
    expect(await refused(f, { answered: "D1" })).toMatch(/needs text/);
    expect(await refused(f, { answered: "D1", text: "x", context: "C." })).toMatch(/separate call/);
    expect(await refused(f, { answered: "D1", text: "x", choice: "Neither" })).toMatch(/not one of the options/);
    expect(await refused(f, { answered: "D1", text: "x" }, w.threadId)).not.toBe("");
    expect(f.store.decisionItem(project.id, 1)!.status).toBe("active");
    await tool(f, "initiative_question", { withdraw: "D1", reason: "Settled by a rule." });
    expect(await refused(f, { answered: "D1", text: "x" })).not.toBe("");
    expect(f.store.decisionItem(project.id, 1)!.status).toBe("withdrawn");
    const t = f.harness.registrations.agentTools.find((x) => x.name === "initiative_question")! as { description: string };
    expect(t.description).toContain('{answered:"D12",text:');
    expect(t.description).toMatch(/only after the user actually answered/);
  });

  it("refuses the removed blocker commands, saving nothing", async () => {
    const { f, project } = await blockedWorker();
    const seen = { assignment: "A1", question, context: "Need a staging key." };
    for (const command of [
      { action: "blocker-answer", ...seen, note: "Use STAGING_KEY.", to: "coordinator" },
      { action: "blocker-dismiss", ...seen, notify: false, note: "" },
      { action: "blocker-dismiss-undo", decision: "D1" },
    ])
      await expect(f.harness.callRpc("command", { projectId: project.id, command })).rejects.toThrow();
    expect(f.store.decisions(project.id)).toEqual([]);
  });

  it("a new coordinator's handover lists it as blocked on the coordinator, not as waiting on the user", async () => {
    const { f, project, w } = await blockedWorker();
    const packet = handoverPacket(f.store, project.id, emptySnapshot(Date.now(), "coordinator"), null);
    expect(packet).toContain("## Waiting on the user\nNothing.");
    expect(packet).toContain(`## Blocked on the coordinator\n- ${w.worker} reported blocked (A1, `);
    expect(packet).toContain(`with a question only the user can answer; the coordinator asks it, unless an open question above already does: ${question}`);
  });
});
