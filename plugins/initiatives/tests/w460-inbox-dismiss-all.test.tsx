// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { projectFixture } from "./fake-native";
import { sendWrite } from "../lib/write-timeout";
import { applyCommitted } from "../lib/committed-result";
await loadPluginApp(() => import("../app"));
const { Dashboard } = await import("../app");
const slots: ReturnType<typeof renderSlot>[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.unmount(); cleanup(); });

// W460: the Inbox's Dismiss all closes every question quietly (W555: questions are all it holds to close).
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const recorder = { author: "coordinator" as const, threadId: "coordinator", assignment: null };
const ask = (f: Fx, projectId: string, title: string) =>
  f.service.recordQuestion(projectId, { title, question: `${title}?`, context: "Choose", humanAttention: "needs-opinion" }, recorder);
const dismissAll = (f: Fx, projectId: string, command: object) =>
  f.harness.callRpc("command", { projectId, command: { action: "inbox-dismiss-all", ...command } }) as Promise<any>;

async function fullInbox() {
  const { f, project } = await projectFixture();
  const questions = [ask(f, project.id, "Scope"), ask(f, project.id, "Naming")];
  f.send.mockClear();
  return { f, project, questions };
}

describe("W460 inbox-dismiss-all", () => {
  it("closes the questions quietly, in one command that sends nothing", async () => {
    const { f, project, questions } = await fullInbox();
    const result = await dismissAll(f, project.id, { questions: questions.map((q) => q.ref) });
    expect(result.closed.map((d: any) => d.ref)).toEqual(questions.map((q) => q.ref));
    expect(result.failed).toEqual([]);
    expect(result).not.toHaveProperty("dismissed");
    expect(f.send).not.toHaveBeenCalled();
    const o = await f.overview(project.id);
    expect(o.opinionNeeded).toEqual([]);
    // Each one is its own quiet close: the questions are in Archive without an answer.
    expect(o.closedQuestions.map((q) => q.ref).sort()).toEqual(questions.map((q) => q.ref).sort());
  });

  it("acts only on the questions it is given, and reports each refusal while saving the rest", async () => {
    const { f, project, questions } = await fullInbox();
    const later = ask(f, project.id, "Later");
    await f.service.answerOpinion(project.id, questions[1]!.ref, { choice: null, note: "Already answered.", notify: false });
    const result = await dismissAll(f, project.id, { questions: questions.map((q) => q.ref) });
    expect(result.closed.map((d: any) => d.ref)).toEqual([questions[0]!.ref]);
    expect(result.failed).toEqual([
      { ref: questions[1]!.ref, error: expect.stringMatching(new RegExp(`${questions[1]!.ref}.*not an open question`)) },
    ]);
    expect((await f.overview(project.id)).opinionNeeded.map((q) => q.ref)).toEqual([later.ref]);
    // A resend after a lost answer saves nothing twice.
    const again = await dismissAll(f, project.id, { questions: [questions[0]!.ref] });
    expect(again).toMatchObject({ closed: [{ ref: questions[0]!.ref }], failed: [] });
    expect(f.send).not.toHaveBeenCalled();
  });

  it("refuses the blockers an older dashboard still sends (W555)", async () => {
    const { f, project, questions } = await fullInbox();
    await expect(dismissAll(f, project.id, { questions: [questions[0]!.ref], blockers: [{ assignment: "A1", question: "Q", context: "C" }] })).rejects.toThrow();
    expect((await f.overview(project.id)).opinionNeeded).toHaveLength(2);
  });

  it("a resend after a lost answer replays the saved result", async () => {
    const { f, project, questions } = await fullInbox();
    const command = { action: "inbox-dismiss-all" as const, questions: [questions[0]!.ref] };
    const send = (keyed: { key?: string }) => f.harness.callRpc("command", { projectId: project.id, command, ...keyed } as never);
    await expect(sendWrite({ projectId: project.id, command }, async (keyed) => { await send(keyed); throw new Error("Connection closed before reply"); })).rejects.toThrow("Connection closed");
    const again = await sendWrite<any>({ projectId: project.id, command }, send);
    expect(again.closed.map((d: any) => d.ref)).toEqual([questions[0]!.ref]);
    for (const tier of ["summary", "full"] as const) {
      const shown = await f.overview(project.id, tier);
      const projected = applyCommitted(shown, command, again);
      expect(projected.opinionNeeded.map((q) => q.ref)).toEqual([questions[1]!.ref]);
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
  const held = { id: "q1", threadId: "coordinator", target: "the coordinator", preview: "Continue W1.", queuedAt: Date.now() - 60_000, reason: "Nothing is running to deliver it." };
  function dashboard(f: Fx, projectId: string, extra: object = {}) {
    const commands: any[] = [];
    const slot = renderSlot({ component: Dashboard }, { projectId }, {
      rpc: {
        overview: async (input: unknown) => ({ ...(await f.harness.callRpc("overview", input) as object), ...extra }),
        command: (input: any) => { commands.push(input.command); return f.harness.callRpc("command", input); },
      },
    } as never);
    slots.push(slot);
    return { slot, commands };
  }

  it("confirms with the count it saw, sends only those questions, and says what it did", async () => {
    const { f, project, questions } = await fullInbox();
    const { slot, commands } = dashboard(f, project.id);
    fireEvent.click(await slot.findByRole("button", { name: "Dismiss all" }));
    const confirm = slot.getByRole("group", { name: "Dismiss all" });
    expect(confirm.textContent).toContain("Close 2 questions quietly? No answers are recorded and nothing is sent.");
    expect(confirm.textContent).toContain("Closed questions cannot be reopened.");
    // A question that arrives while the confirm is open is not part of it.
    const later = ask(f, project.id, "Later");
    fireEvent.click(within(confirm).getByRole("button", { name: "Dismiss all" }));
    await waitFor(() => expect(slot.getByRole("status").textContent).toBe("Inbox: 2 questions closed quietly; nothing sent."));
    expect(commands).toEqual([{ action: "inbox-dismiss-all", questions: questions.map((q) => q.ref) }]);
    expect(slot.queryByRole("group", { name: "Dismiss all" })).toBeNull();
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
    expect(alert.textContent).toMatch(new RegExp(`^Inbox: 1 question closed quietly; nothing sent\\. 1 question left open\\. ${questions[0]!.ref} is not an open question`));
  });

  it("leaves held messages, says so, and is not offered when only they remain", async () => {
    const { f, project } = await fullInbox();
    const { slot } = dashboard(f, project.id, { notDelivered: [held] });
    fireEvent.click(await slot.findByRole("button", { name: "Dismiss all" }));
    const confirm = slot.getByRole("group", { name: "Dismiss all" });
    expect(confirm.textContent).toContain("Close 2 questions quietly? No answers are recorded and nothing is sent.");
    expect(confirm.textContent).toContain("1 undelivered item stays: each needs its own send or removal.");
    fireEvent.click(within(confirm).getByRole("button", { name: "Dismiss all" }));
    await waitFor(() => expect(slot.queryByRole("region", { name: "Questions" })).toBeNull());
    expect(slot.getByRole("region", { name: "Not delivered" })).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Dismiss all" })).toBeNull();
  });
});
