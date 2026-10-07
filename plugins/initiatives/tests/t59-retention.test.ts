import { describe, expect, it, vi } from "vitest";
import { projectFixture, report } from "./fake-native";
import { DEFAULT_WORKER_INSTRUCTIONS } from "../lib/guidance";
import { definePreferences } from "../lib/settings";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

const coordinator = { author: "coordinator" as const, threadId: "coordinator", assignment: null };
const rev = (revision: string) => ({ ...report(), handoff: { ...report().handoff, workspaceRevision: revision, verificationRevision: revision } });
async function work() {
  const { f, project } = await projectFixture();
  const task = f.task(project.id, "Streaming");
  const [worker] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
  return { f, project, task, worker };
}
const blocked = () => ({ ...rev("worker-sha"), outcome: "blocked" as const, summary: "Blocked on contract", blocker: { question: "Which contract?", context: "Need a decision" } });

describe("A108 reviewed retention/state boundaries", () => {
  it("A110 concurrent identical first reports sharing a queued brief send one fallback", async () => {
    const { f, project, worker } = await work();
    f.threads.set(worker.threadId!, { ...f.threads.get(worker.threadId!)!, parentThreadId: null });
    f.store.updateAssignment(project.id, 1, { queuedMessageId: "q-1" });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    f.harness.sdk.stub("threads.queuedMessages.delete", async () => { await held; return {}; });
    const a = f.service.report(worker.threadId!, blocked());
    const b = f.service.report(worker.threadId!, blocked());
    await new Promise(resolve => setTimeout(resolve, 10));
    release(); await Promise.all([a, b]);
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("A110 a distinct report with no coordinator sends nothing", async () => {
    const { f, project, worker } = await work();
    f.threads.set(worker.threadId!, { ...f.threads.get(worker.threadId!)!, parentThreadId: null });
    await f.service.report(worker.threadId!, blocked());
    f.store.db.prepare("UPDATE projects SET coordinator_thread_id=NULL WHERE id=?").run(project.id);
    const r = await f.service.report(worker.threadId!, { ...blocked(), summary: "Different evidence" });
    expect(r.note).toMatch(/no current coordinator/);
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it.each(["blocked", "failed"] as const)("answer/quiet close restores the recorded %s report and clears Answer D checkpoint", async outcome => {
    const { f, project, task, worker } = await work();
    const ask = () => f.service.recordQuestion(project.id, { title: "Scope", question: "Include archives?", context: "Need scope", humanAttention: "needs-opinion", blocksTaskIds: [task.ref] }, coordinator);
    const first = ask(), second = ask();
    await f.service.report(worker.threadId!, { ...blocked(), outcome });
    f.send.mockClear();
    await f.service.answerOpinion(project.id, first.ref, { choice: null, note: "Yes", notify: false });
    expect(f.store.task(project.id, task.num)).toMatchObject({ status: "blocked", progress: `Waiting for your opinion on ${second.ref}`, nextCheckpoint: `Answer ${second.ref}` });
    f.service.closeQuestion(project.id, second.ref, "Already settled in chat.");
    expect(f.store.task(project.id, task.num)).toMatchObject({ status: "blocked", progress: "W1 reported: Blocked on contract", nextCheckpoint: null, acceptedAssignment: null });
    expect(f.send).not.toHaveBeenCalled();
  });

  it("planned and running task releases reset stale question checkpoints", async () => {
    const { f, project, task } = await work();
    const planned = f.task(project.id, "Next");
    for (const [t, state, checkpoint] of [[task, "in_progress", null], [planned, "planned", null]] as const) {
      const q = f.service.recordQuestion(project.id, { title: "Scope", question: "Include archives?", context: "Need scope", humanAttention: "needs-opinion", blocksTaskIds: [t.ref] }, coordinator);
      f.store.updateTask(project.id, t.num, { nextCheckpoint: `Answer ${q.ref}` });
      f.service.closeQuestion(project.id, q.ref, "Already settled.");
      expect(f.store.task(project.id, t.num)).toMatchObject({ status: state, nextCheckpoint: checkpoint });
    }
  });

  it.each(["removed", "superseded"] as const)("refuses stale review, acknowledgement and supersession of %s decisions before any write/send", async status => {
    const { f, project } = await projectFixture();
    const d = f.service.recordDecision(project.id, { decision: { description: "Keep native dispatch", madeBy: "agent" } }, coordinator);
    if (status === "removed") await f.service.cleanupDecision(project.id, d.ref, "remove", "Erwin requested scoped cleanup", "coordinator");
    else f.service.recordDecision(project.id, { decision: { description: "Use dispatch v2", madeBy: "agent" }, supersedes: d.ref }, coordinator);
    const before = f.store.decisionItem(project.id, d.num)!;
    await expect(f.harness.callRpc("command", { projectId: project.id, command: { action: "decision-review", decision: d.ref, verdict: "not-okay", message: "Wrong design" } })).rejects.toThrow(new RegExp(status));
    await expect(f.service.acknowledgeDecision(project.id, d.ref, "Fine")).rejects.toThrow(new RegExp(status));
    expect(() => f.service.recordDecision(project.id, { decision: { description: "New dispatch", madeBy: "agent" }, supersedes: d.ref }, coordinator)).toThrow(new RegExp(status));
    expect(f.store.decisionItem(project.id, d.num)).toEqual(before);
    expect(f.send).not.toHaveBeenCalled();
  });

  it("names a failed guidance reset correctly and still runs on the new defaults (T136)", async () => {
    const { f } = await projectFixture();
    const raw = await f.preferences.handle.get();
    raw.workerInstructions = "Old agent-upgraded worker guidance.";
    const error = vi.fn();
    const flags = { has: vi.fn(() => false), set: vi.fn() };
    const handle = { get: async () => raw, onChange: vi.fn(), experimental_set: vi.fn().mockRejectedValue(new Error("disk refused")) };
    const preferences = definePreferences({ settings: { define: () => handle }, log: { error } } as unknown as BbPluginApi, flags);
    await preferences.ready;
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/migration.*persist.*disk refused/i));
    expect(error).not.toHaveBeenCalledWith(expect.stringMatching(/could not load/i));
    expect(preferences.configuration().workerInstructions).toBe(DEFAULT_WORKER_INSTRUCTIONS);
    expect(flags.set).not.toHaveBeenCalled();
  });
});
