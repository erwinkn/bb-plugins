// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { projectFixture, report } from "./fake-native";
import { needsYouCount } from "../lib/blockers";
await loadPluginApp(() => import("../app"));
const { Dashboard } = await import("../app");
const slots: ReturnType<typeof renderSlot>[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.unmount(); cleanup(); });

// T128: the user dismisses a blocked report instead of answering it, silently or with a note to the coordinator.
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const question = "Which Railway env keys does Tekk Paris need?";
const context = "The deploy needs two secrets only Erwin has.";
const blocked = { ...report(), outcome: "blocked" as const, summary: "Blocked on secrets.", blocker: { question, context } };
const seen = { question, context };
const tree = async (f: Fx) => ((await f.harness.callRpc("tree", null)) as any).projects[0].needsYou as number;
const sentTo = (f: Fx, threadId: string) => f.send.mock.calls.map(([args]) => args).filter((args) => args.threadId === threadId);

async function blockedWorker() {
  const { f, project } = await projectFixture();
  const task = f.task(project.id, "Deploy Tekk Paris");
  const [a] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
  await f.service.report(a.threadId!, blocked as never);
  f.idle(a.threadId!);
  f.send.mockClear();
  return { f, project, threadId: a.threadId! };
}

/** Needs you as the tree (sidebar row, catalog) and the dashboard pill count it, and the Inbox list. */
async function counts(f: Fx, projectId: string) {
  const o = await f.overview(projectId, "summary");
  return { tree: await tree(f), dashboard: needsYouCount(o), inbox: o.blockers.length };
}

describe("T128 dismissing a blocker", () => {
  it("silent: records the user's dismissal, sends nothing, and leaves Needs you and the Inbox everywhere", async () => {
    const { f, project } = await blockedWorker();
    expect(await counts(f, project.id)).toEqual({ tree: 1, dashboard: 1, inbox: 1 });
    const d = await f.service.dismissBlocker(project.id, "A1", seen, { notify: false, note: "" });
    expect(d).toMatchObject({ madeBy: "user", status: "active", notification: null, body: { blocker: { assignment: 1, question, context }, dismissal: { notify: false, note: "" } } });
    expect(f.send).not.toHaveBeenCalled();
    expect(await counts(f, project.id)).toEqual({ tree: 0, dashboard: 0, inbox: 0 });
    // History shows who, when and what, with the blocker it was about.
    const row = (await f.overview(project.id)).decisions.find((r) => r.ref === d.ref)!;
    expect(row).toMatchObject({ madeBy: "user", recordedBy: { author: "user" }, description: expect.stringMatching(/^Dismissed W1's blocker on T1 \(A1\) without answering\.$/), dismissal: { assignment: "A1", question, notify: false, undoneAt: null, at: expect.any(Number) } });
    // Dismissing again is a no-op.
    expect((await f.service.dismissBlocker(project.id, "A1", seen, { notify: false, note: "" })).ref).toBe(d.ref);
    expect(f.store.decisions(project.id).filter((x) => x.body.dismissal)).toHaveLength(1);
  });

  it("notify: one message to the coordinator with the note, retried only after a failure", async () => {
    const { f, project } = await blockedWorker();
    f.send.mockRejectedValueOnce(Object.assign(new Error("refused"), { status: 400 }));
    const d = await f.service.dismissBlocker(project.id, "A1", seen, { notify: true, note: "Ship without secrets; skip the deploy step." });
    expect(d).toMatchObject({ notification: { state: "failed" }, body: { dismissal: { notify: true, note: "Ship without secrets; skip the deploy step." } } });
    expect(await counts(f, project.id)).toEqual({ tree: 0, dashboard: 0, inbox: 0 });
    // A failed notice stays visible in the summary so the Inbox can offer the retry.
    expect((await f.overview(project.id, "summary")).decisions.map((r) => r.ref)).toContain(d.ref);
    const retried = await f.service.dismissBlocker(project.id, "A1", seen, { notify: true, note: "Ship without secrets; skip the deploy step." });
    expect(retried).toMatchObject({ ref: d.ref, notification: { state: "sent" } });
    const sends = sentTo(f, "coordinator");
    expect(sends).toHaveLength(2);
    expect(sends[1].input[0].text).toMatch(/The user dismissed W1's blocker \(A1, T1, D\d+\) without answering it/);
    expect(sends[1].input[0].text).toContain(`Blocker: ${question}\nContext: ${context}\nNote: Ship without secrets`);
    // Once delivered, repeating it sends nothing more.
    await f.service.dismissBlocker(project.id, "A1", seen, { notify: true, note: "Ship without secrets; skip the deploy step." });
    expect(sentTo(f, "coordinator")).toHaveLength(2);
    expect(f.store.decisions(project.id).filter((x) => x.body.dismissal)).toHaveLength(1);
  });

  it("an identical re-file stays dismissed; a changed question or context shows again", async () => {
    const { f, project, threadId } = await blockedWorker();
    await f.service.dismissBlocker(project.id, "A1", seen, { notify: false, note: "" });
    await f.service.report(threadId, blocked as never);
    expect(await counts(f, project.id)).toEqual({ tree: 0, dashboard: 0, inbox: 0 });
    const changed = { question, context: "Production now needs a third key." };
    await f.service.report(threadId, { ...blocked, blocker: changed } as never);
    expect(await counts(f, project.id)).toEqual({ tree: 1, dashboard: 1, inbox: 1 });
    expect((await f.overview(project.id, "summary")).blockers[0]).toMatchObject({ context: changed.context, answer: null });
    // A dismissal of the older blocker is refused and saves nothing.
    await expect(f.service.dismissBlocker(project.id, "A1", seen, { notify: true, note: "x" })).rejects.toThrow(/blocker changed since you opened it.*dismissal was not saved/);
    expect(f.store.decisions(project.id).filter((x) => x.body.dismissal)).toHaveLength(1);
    // Only the changed blocker reached the coordinator; the identical re-file and the dismissals sent nothing.
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0][0].input[0].text).toContain("is blocked on A1");
  });

  it("undo brings the blocker back, keeps the record as undone, and a new dismissal works again", async () => {
    const { f, project } = await blockedWorker();
    const d = await f.service.dismissBlocker(project.id, "A1", seen, { notify: false, note: "Not mine to decide." });
    const undone = await f.service.undoBlockerDismissal(project.id, d.ref);
    expect(undone).toMatchObject({ status: "closed", body: { dismissal: { undoneAt: expect.any(Number), note: "Not mine to decide." } } });
    expect(await counts(f, project.id)).toEqual({ tree: 1, dashboard: 1, inbox: 1 });
    const o = await f.overview(project.id);
    expect(o.decisions.find((r) => r.ref === d.ref)!.dismissal!.undoneAt).toEqual(expect.any(Number));
    expect(o.closedQuestions.map((q) => q.ref)).not.toContain(d.ref);
    expect((await f.service.undoBlockerDismissal(project.id, d.ref)).updatedAt).toBe(undone.updatedAt);
    const again = await f.service.dismissBlocker(project.id, "A1", seen, { notify: false, note: "" });
    expect(again.ref).not.toBe(d.ref);
    expect(await counts(f, project.id)).toEqual({ tree: 0, dashboard: 0, inbox: 0 });
    expect(f.send).not.toHaveBeenCalled();
  });

  it("dismissal and answer are separate records: a dismissal never reads as the answer", async () => {
    const { f, project } = await blockedWorker();
    const answer = await f.service.answerBlocker(project.id, "A1", seen, "Use STAGING_KEY.");
    const d = await f.service.dismissBlocker(project.id, "A1", seen, { notify: false, note: "" });
    expect(f.store.decisionItem(project.id, answer.num)!.status).toBe("active");
    await f.service.undoBlockerDismissal(project.id, d.ref);
    expect((await f.overview(project.id, "summary")).blockers[0]!.answer).toMatchObject({ ref: answer.ref, note: "Use STAGING_KEY." });
    expect(await counts(f, project.id)).toEqual({ tree: 0, dashboard: 0, inbox: 1 });
  });

  it("only the user dismisses or undoes", async () => {
    const { f, project } = await blockedWorker();
    await expect(f.harness.callAgentTool("initiative_task", { action: "blocker-dismiss", assignment: "A1", question, context }, { threadId: "coordinator" })).rejects.toThrow();
    const d = await f.service.dismissBlocker(project.id, "A1", seen, { notify: false, note: "" });
    await expect(f.harness.callAgentTool("initiative_task", { action: "blocker-dismiss-undo", decision: d.ref }, { threadId: "coordinator" })).rejects.toThrow();
    await expect(f.harness.callRpc("command", { projectId: project.id, command: { action: "blocker-dismiss-undo", decision: d.ref } })).resolves.toMatchObject({ status: "closed" });
  });

  it("the Inbox card offers Dismiss and Dismiss and tell coordinator", async () => {
    const { f, project } = await blockedWorker();
    const commands: any[] = [];
    let o = await f.overview(project.id, "summary");
    const slot = renderSlot({ component: Dashboard }, { projectId: project.id }, {
      rpc: {
        overview: async () => o,
        command: async ({ command }: any) => {
          commands.push(command);
          const result = await f.service.dismissBlocker(project.id, command.assignment, { question: command.question, context: command.context }, command);
          o = await f.overview(project.id, "summary");
          return result;
        },
      },
    } as never);
    slots.push(slot);
    expect(await slot.findByRole("button", { name: "Needs you · 1" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "Dismiss" })).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "More dismiss options" }));
    fireEvent.click(slot.getByRole("menuitem", { name: "Dismiss and tell coordinator…" }));
    fireEvent.change(slot.getByLabelText("Note for the coordinator (optional)"), { target: { value: "Skip the deploy." } });
    fireEvent.click(slot.getByRole("button", { name: "Dismiss and send" }));
    await waitFor(() => expect(commands).toEqual([{ action: "blocker-dismiss", assignment: "A1", question, context, notify: true, note: "Skip the deploy." }]));
    await waitFor(() => expect(slot.queryByRole("button", { name: /Needs you/ })).toBeNull());
    expect(slot.queryByRole("region", { name: "Blocked workers" })).toBeNull();
    expect(sentTo(f, "coordinator")).toHaveLength(1);
  });
});
