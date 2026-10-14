// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { projectFixture, report } from "./fake-native";
import { sendWrite } from "../lib/write-timeout";
import { applyCommitted } from "../lib/committed-result";
await loadPluginApp(() => import("../app"));
const { Dashboard } = await import("../app");
const slots: ReturnType<typeof renderSlot>[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.unmount(); cleanup(); });

// W460: the Inbox's Dismiss all closes every question quietly and dismisses every blocker silently.
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const recorder = { author: "coordinator" as const, threadId: "coordinator", assignment: null };
const question = "Which Railway env keys does Tekk Paris need?";
const context = "The deploy needs two secrets only Erwin has.";
const blocked = { ...report(), outcome: "blocked" as const, summary: "Blocked on secrets.", blocker: { question, context } };
const ask = (f: Fx, projectId: string, title: string) =>
  f.service.recordQuestion(projectId, { title, question: `${title}?`, context: "Choose", humanAttention: "needs-opinion" }, recorder);
const dismissAll = (f: Fx, projectId: string, command: object) =>
  f.harness.callRpc("command", { projectId, command: { action: "inbox-dismiss-all", ...command } }) as Promise<any>;

async function fullInbox() {
  const { f, project } = await projectFixture();
  const [a] = await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id, "Deploy Tekk Paris").ref] });
  await f.service.report(a.threadId!, blocked as never);
  f.idle(a.threadId!);
  const questions = [ask(f, project.id, "Scope"), ask(f, project.id, "Naming")];
  f.send.mockClear();
  return { f, project, questions };
}

describe("W460 inbox-dismiss-all", () => {
  it("closes the questions quietly and dismisses the blocker silently, in one command that sends nothing", async () => {
    const { f, project, questions } = await fullInbox();
    const result = await dismissAll(f, project.id, { questions: questions.map((q) => q.ref), blockers: [{ assignment: "A1", question, context }] });
    expect(result.closed.map((d: any) => d.ref)).toEqual(questions.map((q) => q.ref));
    expect(result.dismissed).toEqual([expect.objectContaining({ madeBy: "user", notification: null, body: expect.objectContaining({ dismissal: expect.objectContaining({ notify: false, note: "" }) }) })]);
    expect(result.failed).toEqual([]);
    expect(f.send).not.toHaveBeenCalled();
    const o = await f.overview(project.id);
    expect({ questions: o.opinionNeeded.length, blockers: o.blockers.length }).toEqual({ questions: 0, blockers: 0 });
    // Each one is its own quiet close: the questions are in Archive without an answer, and the dismissal undoes as usual.
    expect(o.closedQuestions.map((q) => q.ref).sort()).toEqual(questions.map((q) => q.ref).sort());
    await f.harness.callRpc("command", { projectId: project.id, command: { action: "blocker-dismiss-undo", decision: result.dismissed[0].ref } });
    expect((await f.overview(project.id)).blockers.map((b) => b.assignment)).toEqual(["A1"]);
  });

  it("acts only on the items it is given, and reports each refusal while saving the rest", async () => {
    const { f, project, questions } = await fullInbox();
    const later = ask(f, project.id, "Later");
    await f.service.answerOpinion(project.id, questions[1]!.ref, { choice: null, note: "Already answered.", notify: false });
    const result = await dismissAll(f, project.id, {
      questions: questions.map((q) => q.ref),
      blockers: [{ assignment: "A1", question, context: "An older context." }],
    });
    expect(result.closed.map((d: any) => d.ref)).toEqual([questions[0]!.ref]);
    expect(result.dismissed).toEqual([]);
    expect(result.failed).toEqual([
      { ref: questions[1]!.ref, error: expect.stringMatching(new RegExp(`${questions[1]!.ref}.*not an open question`)) },
      { ref: "A1", error: expect.stringMatching(/A1's blocker changed since you opened it/) },
    ]);
    const o = await f.overview(project.id);
    expect(o.opinionNeeded.map((q) => q.ref)).toEqual([later.ref]);
    expect(o.blockers.map((b) => b.assignment)).toEqual(["A1"]);
    // A resend after a lost answer saves nothing twice.
    const again = await dismissAll(f, project.id, { questions: [questions[0]!.ref] });
    expect(again).toMatchObject({ closed: [{ ref: questions[0]!.ref }], failed: [] });
    expect(f.send).not.toHaveBeenCalled();
  });

  it("never retries a failed coordinator notice of a dismissal made meanwhile", async () => {
    const { f, project } = await fullInbox();
    f.send.mockRejectedValueOnce(Object.assign(new Error("refused"), { status: 400 }));
    const told = await f.service.dismissBlocker(project.id, "A1", { question, context }, { notify: true, note: "Skip it." });
    expect(told.notification).toMatchObject({ state: "failed" });
    f.send.mockClear();
    const result = await dismissAll(f, project.id, { blockers: [{ assignment: "A1", question, context }] });
    expect(result).toMatchObject({ dismissed: [{ ref: told.ref, notification: { state: "failed" } }], failed: [] });
    expect(f.send).not.toHaveBeenCalled();
  });

  it("a resend after a lost answer replays the saved result, so it cannot undo an Undo", async () => {
    const { f, project } = await fullInbox();
    const command = { action: "inbox-dismiss-all" as const, questions: [], blockers: [{ assignment: "A1", question, context }] };
    const send = (keyed: { key?: string }) => f.harness.callRpc("command", { projectId: project.id, command, ...keyed } as never);
    await expect(sendWrite({ projectId: project.id, command }, async (keyed) => { await send(keyed); throw new Error("Connection closed before reply"); })).rejects.toThrow("Connection closed");
    const [first] = f.store.decisions(project.id).filter((d) => d.body.dismissal);
    await f.harness.callRpc("command", { projectId: project.id, command: { action: "blocker-dismiss-undo", decision: first!.ref } });
    const again = await sendWrite<any>({ projectId: project.id, command }, send);
    expect(again.dismissed.map((d: any) => d.ref)).toEqual([first!.ref]);
    expect(f.store.decisions(project.id).filter((d) => d.body.dismissal && !d.body.dismissal.undoneAt)).toEqual([]);
    // Over every tier the dashboard holds, the replayed result neither hides the blocker again nor loses the Undo.
    for (const tier of ["summary", "full"] as const) {
      const shown = await f.overview(project.id, tier);
      expect(shown.blockers.map((b) => b.assignment)).toEqual(["A1"]);
      const projected = applyCommitted(shown, command, again);
      expect(projected.blockers.map((b) => b.assignment)).toEqual(["A1"]);
      expect(projected.decisions).toEqual(shown.decisions);
    }
  });

  it("is the user's alone", async () => {
    const { f, project, questions } = await fullInbox();
    const command = JSON.stringify({ action: "inbox-dismiss-all", questions: [questions[0]!.ref] });
    const cli = await f.harness.runCli(["command", command, project.id], { threadId: "coordinator" });
    expect(cli.exitCode).toBe(1);
    expect(cli.stderr).toMatch(/needs the user in the Initiative panel/);
    await expect(f.harness.callAgentTool("initiative_manage", { action: "inbox-dismiss-all", questions: [questions[0]!.ref] }, { threadId: "coordinator" })).rejects.toThrow();
    expect((await f.overview(project.id)).opinionNeeded).toHaveLength(2);
  });
});

describe("W460 the Inbox's Dismiss all control", () => {
  function dashboard(f: Fx, projectId: string) {
    const commands: any[] = [];
    const slot = renderSlot({ component: Dashboard }, { projectId }, {
      rpc: {
        overview: (input: unknown) => f.harness.callRpc("overview", input),
        command: (input: any) => { commands.push(input.command); return f.harness.callRpc("command", input); },
      },
    } as never);
    slots.push(slot);
    return { slot, commands };
  }

  it("confirms with the counts it saw, sends only those items, and says what it did", async () => {
    const { f, project, questions } = await fullInbox();
    const { slot, commands } = dashboard(f, project.id);
    fireEvent.click(await slot.findByRole("button", { name: "Dismiss all" }));
    const confirm = slot.getByRole("group", { name: "Dismiss all" });
    expect(confirm.textContent).toContain("Close 2 questions quietly and dismiss 1 blocker? No answers are recorded and nothing is sent.");
    expect(confirm.textContent).toContain("Closed questions cannot be reopened. A dismissed blocker comes back with Undo in Archive.");
    // A question that arrives while the confirm is open is not part of it.
    const later = ask(f, project.id, "Later");
    fireEvent.click(within(confirm).getByRole("button", { name: "Dismiss all" }));
    await waitFor(() => expect(slot.getByRole("status").textContent).toBe("Inbox: 2 questions closed quietly and 1 blocker dismissed; nothing sent."));
    expect(commands).toEqual([{ action: "inbox-dismiss-all", questions: questions.map((q) => q.ref), blockers: [{ assignment: "A1", question, context }] }]);
    expect(slot.queryByRole("group", { name: "Dismiss all" })).toBeNull();
    // The blocker card leaves with the read that follows.
    await waitFor(() => expect(slot.queryByRole("region", { name: "Blocked workers" })).toBeNull());
    expect((await f.overview(project.id)).opinionNeeded.map((q) => q.ref)).toEqual([later.ref]);
    expect(f.send).not.toHaveBeenCalled();
  });

  it("names what it left open, and Cancel sends nothing", async () => {
    const { f, project, questions } = await fullInbox();
    const { slot, commands } = dashboard(f, project.id);
    fireEvent.click(await slot.findByRole("button", { name: "Dismiss all" }));
    fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
    expect(commands).toEqual([]);
    fireEvent.click(slot.getByRole("button", { name: "Dismiss all" }));
    await f.service.answerOpinion(project.id, questions[0]!.ref, { choice: null, note: "Answered in chat.", notify: false });
    fireEvent.click(within(slot.getByRole("group", { name: "Dismiss all" })).getByRole("button", { name: "Dismiss all" }));
    const alert = await slot.findByRole("alert");
    expect(alert.textContent).toMatch(new RegExp(`^Inbox: 1 question closed quietly and 1 blocker dismissed; nothing sent\\. 1 item left open\\. ${questions[0]!.ref} is not an open question`));
  });

  it("leaves undelivered items, says so, and is not offered when only they remain", async () => {
    const { f, project } = await fullInbox();
    f.send.mockRejectedValueOnce(Object.assign(new Error("refused"), { status: 400 }));
    await f.service.dismissBlocker(project.id, "A1", { question, context }, { notify: true, note: "Skip it." });
    const { slot } = dashboard(f, project.id);
    fireEvent.click(await slot.findByRole("button", { name: "Dismiss all" }));
    const confirm = slot.getByRole("group", { name: "Dismiss all" });
    expect(confirm.textContent).toContain("Close 2 questions quietly? No answers are recorded and nothing is sent.");
    expect(confirm.textContent).toContain("1 undelivered item stays: each needs its own send, retry or removal.");
    fireEvent.click(within(confirm).getByRole("button", { name: "Dismiss all" }));
    await waitFor(() => expect(slot.queryByRole("region", { name: "Questions" })).toBeNull());
    expect(slot.getByRole("region", { name: "Not delivered" })).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Dismiss all" })).toBeNull();
  });
});
