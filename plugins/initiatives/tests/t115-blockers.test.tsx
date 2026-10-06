// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { projectFixture, report } from "./fake-native";
import { needsYouCount, openBlockers, type BlockerFacts } from "../lib/blockers";
await loadPluginApp(() => import("../app"));
const { Dashboard } = await import("../app");
const slots: ReturnType<typeof renderSlot>[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.unmount(); cleanup(); });

// T115 / D386: an unresolved blocked report waits on the user, in the Inbox and the Needs you count.
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const question = "Which Railway env keys does Tekk Paris need?";
const blocked = { ...report(), outcome: "blocked" as const, summary: "Blocked on secrets.", blocker: { question, context: "The deploy needs **two** secrets only Erwin has." } };
const seen = { question, context: blocked.blocker.context };
const tree = async (f: Fx) => ((await f.harness.callRpc("tree", null)) as any).projects[0].needsYou as number;
const sentTo = (f: Fx, threadId: string) => f.send.mock.calls.map(([args]) => args).filter((args) => args.threadId === threadId);

async function blockedWorker() {
  const { f, project } = await projectFixture();
  const task = f.task(project.id, "Deploy Tekk Paris");
  const [a] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
  await f.service.report(a.threadId!, blocked as never);
  f.idle(a.threadId!);
  return { f, project, task, threadId: a.threadId! };
}

describe("T115 blocked reports in the Inbox and Needs you", () => {
  it("a blocked report appears with its question and context, and counts in both the tree and the dashboard", async () => {
    const { f, project, threadId } = await blockedWorker();
    expect(await tree(f)).toBe(1);
    const o = await f.overview(project.id, "summary");
    expect(o.blockers).toEqual([expect.objectContaining({
      assignment: "A1", tasks: [{ ref: "T1", title: "Deploy Tekk Paris" }], question, context: blocked.blocker.context,
      owner: expect.objectContaining({ worker: "W1", threadId }), answer: null,
    })]);
    expect(o.blockers[0]!.reportedAt).toEqual(expect.any(Number));
  });

  it("answering records the user's decision, notifies the coordinator once, and stops counting; the item stays until the coordinator acts", async () => {
    const { f, project } = await blockedWorker();
    f.send.mockClear();
    const d = await f.service.answerBlocker(project.id, "A1", seen, "Use RAILWAY_TOKEN and TEKK_KEY from 1Password.");
    expect(d).toMatchObject({ madeBy: "user", status: "active", body: { blocker: { assignment: 1, question, context: blocked.blocker.context } }, notification: { state: "sent" } });
    const sends = sentTo(f, "coordinator");
    expect(sends).toHaveLength(1);
    expect(sends[0].input[0].text).toContain(question);
    expect(sends[0].input[0].text).toContain("Use RAILWAY_TOKEN and TEKK_KEY");
    expect(sends[0].input[0].text).toMatch(/Continue W1 with this answer/);
    expect(await tree(f)).toBe(0);
    const o = await f.overview(project.id, "summary");
    expect(o.blockers[0]!.answer).toMatchObject({ ref: d.ref, note: "Use RAILWAY_TOKEN and TEKK_KEY from 1Password.", notification: { state: "sent" } });
    // The same answer again is a transport retry, not a second send.
    await f.service.answerBlocker(project.id, "A1", seen, "Use RAILWAY_TOKEN and TEKK_KEY from 1Password.");
    expect(sentTo(f, "coordinator")).toHaveLength(1);
    // A changed answer supersedes the first and is sent again.
    const changed = await f.service.answerBlocker(project.id, "A1", seen, "Only TEKK_KEY.");
    expect(changed.supersedes).toBe(d.num);
    expect(f.store.decisionItem(project.id, d.num)!.status).toBe("superseded");
    expect(sentTo(f, "coordinator")).toHaveLength(2);
    expect((await f.overview(project.id, "summary")).blockers[0]!.answer!.note).toBe("Only TEKK_KEY.");
    // The coordinator acts on the report (T136: closes its task): the item clears.
    await f.service.closeTask(project.id, "T1", "done", "Continued with the answer");
    expect((await f.overview(project.id, "summary")).blockers).toEqual([]);
    expect(await tree(f)).toBe(0);
  });

  it("a failed notice keeps the answer and the retry sends it", async () => {
    const { f, project } = await blockedWorker();
    f.send.mockRejectedValueOnce(Object.assign(new Error("refused"), { status: 400 }));
    const d = await f.service.answerBlocker(project.id, "A1", seen, "Use the staging key.");
    expect(d.notification).toMatchObject({ state: "failed" });
    const again = await f.service.answerBlocker(project.id, "A1", seen, "Use the staging key.");
    expect(again).toMatchObject({ ref: d.ref, notification: { state: "sent" } });
  });

  it("refuses a stale or settled blocker without saving anything", async () => {
    const { f, project } = await blockedWorker();
    await expect(f.service.answerBlocker(project.id, "A1", { ...seen, question: "An older question?" }, "x")).rejects.toThrow(/blocker changed since you opened it/);
    await f.service.closeTask(project.id, "T1", "done", "Handled in chat");
    await expect(f.service.answerBlocker(project.id, "A1", seen, "x")).rejects.toThrow(/no longer waiting on a blocker/);
    expect(f.store.decisions(project.id).filter((d) => d.body.blocker)).toEqual([]);
  });

  it("A278: a changed context needs a new answer; an identical re-file keeps it", async () => {
    const { f, project, threadId } = await blockedWorker();
    await f.service.answerBlocker(project.id, "A1", seen, "Use STAGING_KEY.");
    expect(await tree(f)).toBe(0);
    // An identical re-file is the same blocker: the answer stands.
    await f.service.report(threadId, blocked as never);
    expect(await tree(f)).toBe(0);
    expect((await f.overview(project.id, "summary")).blockers[0]!.answer?.note).toBe("Use STAGING_KEY.");
    // Same question, new context: a new blocker that waits on the user again, in the tree and the dashboard.
    const context = "STAGING_KEY was rejected; production requires a different key.";
    await f.service.report(threadId, { ...blocked, blocker: { question, context } } as never);
    expect(await tree(f)).toBe(1);
    const o = await f.overview(project.id, "summary");
    expect(o.blockers[0]).toMatchObject({ context, answer: null });
    expect(needsYouCount(o)).toBe(1);
    // An answer written against the older context is refused and saves nothing.
    const before = f.store.decisions(project.id).length;
    f.send.mockClear();
    await expect(f.service.answerBlocker(project.id, "A1", seen, "Use STAGING_KEY.")).rejects.toThrow(/blocker changed since you opened it/);
    expect(f.store.decisions(project.id)).toHaveLength(before);
    expect(sentTo(f, "coordinator")).toEqual([]);
    // Answering the current blocker works and clears the count.
    await f.service.answerBlocker(project.id, "A1", { question, context }, "Use PROD_KEY from 1Password.");
    expect(await tree(f)).toBe(0);
    expect(sentTo(f, "coordinator")[0].input[0].text).toContain(context);
  });

  it("only the user answers a blocker", async () => {
    const { f } = await blockedWorker();
    await expect(f.harness.callAgentTool("initiative_task", { action: "blocker-answer", assignment: "A1", question, note: "x" }, { threadId: "coordinator" })).rejects.toThrow();
  });

  it("the Inbox shows the blocker as rich text, links the threads, and sends the answer", async () => {
    const { f, project, threadId } = await blockedWorker();
    const o = await f.overview(project.id, "summary");
    const commands: any[] = [];
    const slot = renderSlot({ component: Dashboard }, { projectId: project.id }, {
      rpc: { overview: async () => o, command: async ({ command }: any) => { commands.push(command); return f.service.answerBlocker(project.id, command.assignment, { question: command.question, context: command.context }, command.note); } },
    } as never);
    slots.push(slot);
    expect(await slot.findByRole("button", { name: "Needs you · 1" })).toBeTruthy();
    const section = slot.getByRole("region", { name: "Blocked workers" });
    expect(section.textContent).toContain(question);
    // Question and context render through BB's Markdown (the test host keeps the source text).
    expect(Array.from(section.querySelectorAll("[data-testid=bb-markdown]")).map((el) => el.textContent)).toEqual([question, blocked.blocker.context]);
    // T130: the worker label links its thread; the coordinator is not linked here.
    fireEvent.click(slot.getByRole("link", { name: "W1" }));
    expect(slot.navigateCalls).toEqual([{ method: "toThread", threadId }]);
    fireEvent.change(slot.getByLabelText("Your answer"), { target: { value: "Use the staging key." } });
    fireEvent.click(slot.getByRole("button", { name: "Send to coordinator" }));
    await waitFor(() => expect(commands).toEqual([{ action: "blocker-answer", assignment: "A1", question, context: blocked.blocker.context, note: "Use the staging key.", to: "coordinator" }]));
    await waitFor(() => expect(slot.queryByRole("button", { name: /Needs you/ })).toBeNull());
    expect(slot.getByRole("region", { name: "Blocked workers" }).textContent).toContain("Use the staging key.");
  });
});

describe("T115 the open-blocker rule", () => {
  const a = (num: number, over: Partial<BlockerFacts> = {}): BlockerFacts =>
    ({ num, workerNum: 1, role: "work", taskNums: [1], reviewOf: null, state: "reported", outcome: "blocked", ...over });
  const open = (rows: BlockerFacts[], closed: number[] = []) => openBlockers(rows, (n) => closed.includes(n)).map((r) => r.num);

  it("keeps an unsettled blocked report", () => expect(open([a(1)])).toEqual([1]));
  it("drops accepted, rejected and non-blocked reports", () =>
    expect(open([a(1, { state: "accepted" }), a(2, { state: "rejected", taskNums: [2] }), a(3, { outcome: "succeeded", taskNums: [3] })])).toEqual([]));
  it("clears on a newer assignment for the same worker or the same task, but not on a failed dispatch", () => {
    expect(open([a(1), a(2, { state: "running", taskNums: [9] })])).toEqual([]);
    expect(open([a(1), a(2, { workerNum: 2, state: "running" })])).toEqual([]);
    expect(open([a(1), a(2, { state: "failed" })])).toEqual([1]);
    expect(open([a(1), a(2, { workerNum: 2, taskNums: [9], state: "running" })])).toEqual([1]);
  });
  it("a review clears on a newer review of the same task, not on new work", () => {
    const review = a(1, { role: "review", taskNums: [], reviewOf: [1] });
    expect(open([review, a(2, { workerNum: 2, state: "running" })])).toEqual([1]);
    expect(open([review, a(2, { workerNum: 3, role: "review", taskNums: [], reviewOf: [1], state: "running" })])).toEqual([]);
  });
  it("clears once every task it is about is closed", () => {
    expect(open([a(1, { taskNums: [1, 2] })], [1])).toEqual([1]);
    expect(open([a(1, { taskNums: [1, 2] })], [1, 2])).toEqual([]);
  });
});
