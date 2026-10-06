import { describe, expect, it } from "vitest";
import { projectFixture, report } from "./fake-native";
import { clearCatalogCache } from "../lib/bb";
import { DEFAULT_PROFILES } from "../lib/schema";

const checkedReport = () => ({ ...report(), handoff: { ...report().handoff, workspaceRevision: "stream-sha", verificationRevision: "stream-sha" } });
async function externalWork() {
  const { f, project } = await projectFixture();
  const tasks = Array.from({ length: 11 }, (_, i) => f.task(project.id, i === 5 ? "Tasks plugin" : i === 10 ? "Smooth streaming" : `Task ${i}`));
  const [worker] = await f.service.delegate(project.id, { route: "fresh", tasks: ["T6"] });
  return { f, project, tasks, worker };
}
const checkpoint = (task: string, worker: string) => ({ action: "task-checkpoint", task, worker, report: checkedReport() });

describe("T59 actual work/review association", () => {
  it("checkpoints native/external T11 work without sending a turn or rewriting T6, then reviews its implementer and revision", async () => {
    const { f, project, worker } = await externalWork();
    const original = f.store.assignment(project.id, 1)!;
    const saved = JSON.parse(await f.harness.callAgentTool("initiative_task", checkpoint("T11", worker.worker), { threadId: "coordinator" }) as string);
    expect(saved).toMatchObject({ ref: "A2", route: "checkpoint", state: "reported", taskNums: [11], report: { outcome: "succeeded" }, checkpoint: { recordedBy: "coordinator", sourceThreadId: worker.threadId } });
    expect(f.store.assignment(project.id, 1)).toEqual(original);
    expect(f.store.task(project.id, 11)).toMatchObject({ status: "awaiting_acceptance", acceptedAssignment: null });
    expect(f.send).not.toHaveBeenCalled();
    expect(f.spawn).toHaveBeenCalledTimes(1);
    const [review] = await f.service.delegate(project.id, { route: "fresh", role: "review", reviewOf: ["T11"], reviewTargets: [{ task: "T11", assignment: "A2", revision: "stream-sha" }] });
    expect(f.spawn.mock.calls.at(-1)![0]).toMatchObject({ providerId: "codex" });
    expect(f.spawn.mock.calls.at(-1)![0]).not.toHaveProperty("senderThreadId");
    const prompt = f.spawn.mock.calls.at(-1)![0].prompt;
    expect(prompt).toContain('T11 "Smooth streaming"');
    expect(prompt).toContain("T11 ← A2 (W1), checked revision stream-sha; implementer claude-code");
    expect(prompt).not.toContain('T6 "Tasks plugin"');
    expect(review.rationale).toContain("T11 from A2 at stream-sha");
    expect(f.store.assignments(project.id).at(-1)?.reviewTargets?.[0]).toMatchObject({ task: "T11", assignment: "A2", revision: "stream-sha", profile: { providerId: "claude-code" } });
    expect(f.store.task(project.id, 11)?.status).toBe("awaiting_acceptance");
  });

  it("refuses the T11/T6 workaround and wrong assignment/revision at the boundary", async () => {
    const { f, project, worker } = await externalWork();
    const saved = await f.service.checkpointTask(project.id, checkpoint("T11", worker.worker), "coordinator");
    const target = { task: "T11", assignment: saved.ref, revision: "stream-sha" };
    for (const bad of [
      { reviewOf: ["T6"], reviewTargets: [target] },
      { reviewOf: ["T6"], reviewTargets: [{ ...target, task: "T6" }] },
      { reviewOf: ["T11"], reviewTargets: [{ ...target, revision: "another-sha" }] },
      { reviewOf: ["T11"], tasks: ["T6"] },
      { reviewOf: ["T11"], reviewTargets: [{ ...target, assignment: "A999" }] },
    ]) await expect(f.service.delegate(project.id, { route: "fresh", role: "review", ...bad })).rejects.toThrow(/same tasks|did not implement|revision|not tasks|Unknown assignment/);
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
  });

  it("revalidates the implementer snapshot after native awaits rather than dispatching a stale review", async () => {
    const { f, project, worker } = await externalWork();
    const saved = await f.service.checkpointTask(project.id, checkpoint("T11", worker.worker), "coordinator");
    clearCatalogCache();
    f.harness.sdk.stub("providers.models", () => {
      f.store.updateAssignment(project.id, saved.num, { actualProfile: { ...saved.profile, model: "changed-native-model" } });
      return {
        providers: ["claude-code", "codex"].map(id => ({ id, available: true, capabilities: { supportsFork: true, supportsServiceTier: id === "codex" } })),
        models: Object.values(DEFAULT_PROFILES).map(p => ({ id: p.model, model: p.model, supportedReasoningEfforts: [{ reasoningEffort: "high" }, { reasoningEffort: "xhigh" }] })),
      };
    });
    await expect(f.service.delegate(project.id, { route: "fresh", role: "review", reviewTargets: [{ task: "T11", assignment: saved.ref, revision: "stream-sha" }] })).rejects.toThrow(/profile\/revision changed/);
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
  });

  it("does not turn stale task status into implementation evidence", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id);
    f.store.updateTask(project.id, task.num, { status: "in_progress" });
    await expect(f.service.delegate(project.id, { route: "fresh", role: "review", reviewOf: [task.ref] })).rejects.toThrow(/task-checkpoint/);
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it.each(["stopped", "cancelled", "failed", "rejected"] as const)("cannot review %s evidence", async state => {
    const { f, project, worker } = await externalWork();
    const saved = await f.service.checkpointTask(project.id, checkpoint("T11", worker.worker), "coordinator");
    f.store.updateAssignment(project.id, saved.num, { state });
    await expect(f.service.delegate(project.id, { route: "fresh", role: "review", reviewTargets: [{ task: "T11", assignment: saved.ref, revision: "stream-sha" }] })).rejects.toThrow(/settled/);
  });

  it("refuses uncertain receipts, stopped workers, foreign callers and mismatched checkpoint links", async () => {
    const { f, project, worker } = await externalWork();
    await expect(f.service.checkpointTask(project.id, { ...checkpoint("T11", worker.worker), assignment: "A1" }, "coordinator")).rejects.toThrow(/exactly the named task/);
    await expect(f.harness.callAgentTool("initiative_task", checkpoint("T11", worker.worker), { threadId: worker.threadId! })).rejects.toThrow();
    await expect(f.service.checkpointTask(project.id, checkpoint("T11", worker.worker), "foreign")).rejects.toThrow(/current coordinator/);
    f.store.updateAssignment(project.id, 1, { opState: "uncertain" });
    await expect(f.service.checkpointTask(project.id, checkpoint("T11", worker.worker), "coordinator")).rejects.toThrow(/unsettled/);
    f.store.updateAssignment(project.id, 1, { opState: "done" });
    f.store.updateWorker(project.id, 1, { userStopped: true });
    await expect(f.service.checkpointTask(project.id, checkpoint("T11", worker.worker), "coordinator")).rejects.toThrow(/unstopped/);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.spawn).toHaveBeenCalledTimes(1);
  });
});

describe("T59 native actionable delivery", () => {
  it("question closure restores the recorded running/reported stage without accepting work", async () => {
    const { f, project, worker } = await externalWork();
    const question = (task: string) => f.service.recordQuestion(project.id, { title: "Scope", question: "Include archives?", context: "Need explicit scope", humanAttention: "needs-opinion", blocksTaskIds: [task] }, { author: "coordinator", threadId: "coordinator", assignment: null });
    const running = question("T6");
    expect(f.store.task(project.id, 6)?.status).toBe("blocked");
    f.service.closeQuestion(project.id, running.ref, "Settled in chat.");
    expect(f.store.task(project.id, 6)?.status).toBe("in_progress");
    await f.service.checkpointTask(project.id, checkpoint("T11", worker.worker), "coordinator");
    const pending = question("T11");
    expect(f.store.task(project.id, 11)?.status).toBe("blocked");
    await f.service.answerOpinion(project.id, pending.ref, { choice: null, note: "Yes", notify: false });
    expect(f.store.task(project.id, 11)).toMatchObject({ status: "awaiting_acceptance", acceptedAssignment: null });
    expect(f.send).not.toHaveBeenCalled();
  });

  it("a final worker report keeps its task waiting until every open question resolves", async () => {
    const { f, project, worker } = await externalWork();
    const question = () => f.service.recordQuestion(project.id, { title: "Scope", question: "Include archives?", context: "Need explicit scope", humanAttention: "needs-opinion", blocksTaskIds: ["T6"] }, { author: "coordinator", threadId: "coordinator", assignment: null });
    const first = question(), second = question();
    await f.service.report(worker.threadId!, checkedReport());
    expect(f.store.task(project.id, 6)).toMatchObject({ status: "blocked", progress: `Waiting for your opinion on ${first.ref}`, acceptedAssignment: null });
    f.service.closeQuestion(project.id, first.ref, "Already settled.");
    expect(f.store.task(project.id, 6)).toMatchObject({ status: "blocked", progress: `Waiting for your opinion on ${second.ref}` });
    await f.service.answerOpinion(project.id, second.ref, { choice: null, note: "Yes", notify: false });
    expect(f.store.task(project.id, 6)).toMatchObject({ status: "awaiting_acceptance", acceptedAssignment: null });
    expect(f.send).not.toHaveBeenCalled();
  });

  it("durable question blocks real tasks; worker chat answer steers with recorder provenance and an honest native queue receipt", async () => {
    const { f, project, worker } = await externalWork();
    const request = { action: "question", question: { title: "Platform sign-off", humanAttention: "needs-opinion", question: "Who signs off macOS?", context: "Native bridge readiness", options: [{ label: "Erwin", consequences: "Wait for a human machine check" }], recommendation: "Erwin verifies the platform", blocksTaskIds: ["T11"] } };
    const q = JSON.parse(await f.harness.callAgentTool("initiative_decision", request, { threadId: "coordinator" }) as string);
    expect(f.store.task(project.id, 11)).toMatchObject({ status: "blocked", progress: `Waiting for your opinion on ${q.ref}` });
    f.queueSend("interaction-queue");
    const result = JSON.parse(await f.harness.callAgentTool("initiative_decision", { action: "answer", decision: q.ref, choice: "Erwin", note: "I'll run the check." }, { threadId: worker.threadId! }) as string);
    expect(f.send.mock.calls.at(-1)![0]).toMatchObject({ mode: "steer-if-active", senderThreadId: worker.threadId, threadId: "coordinator" });
    expect(result.notification).toMatchObject({ state: "queued", queuedId: "interaction-queue" });
    expect(f.store.task(project.id, 11)?.status).toBe("planned");
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it.each(["steer", "queue"] as const)("continuation %s delegates to native BB with the coordinator sender", async delivery => {
    const { f, project, worker } = await externalWork();
    await f.service.report(worker.threadId!, checkedReport());
    await f.service.acceptTask(project.id, "T6", {});
    f.idle(worker.threadId!);
    await f.service.delegate(project.id, { route: "continue", worker: worker.worker, tasks: ["T11"], delivery });
    expect(f.send.mock.calls.at(-1)![0]).toMatchObject({ mode: delivery === "steer" ? "steer-if-active" : "queue-if-active", senderThreadId: "coordinator" });
  });

  it.each(["sent", "queued", "uncertain", "failed"] as const)("fallback reports retain %s native delivery truth and worker sender", async state => {
    const { f, project, worker } = await externalWork();
    f.threads.set(worker.threadId!, { ...f.threads.get(worker.threadId!)!, parentThreadId: null });
    if (state === "queued") f.queueSend("notice-queue");
    if (state === "uncertain") f.send.mockRejectedValueOnce(new Error("lost response"));
    if (state === "failed") f.send.mockRejectedValueOnce(Object.assign(new Error("refused"), { status: 400 }));
    const blocked = { ...checkedReport(), outcome: "blocked" as const, blocker: { question: "Which platform?", context: "Need sign-off." } };
    const result = await f.service.report(worker.threadId!, blocked);
    expect(f.send.mock.calls.at(-1)![0]).toMatchObject({ mode: "steer-if-active", senderThreadId: worker.threadId });
    expect(result.notification).toMatchObject({ state, coordinatorThreadId: "coordinator" });
    expect(f.store.assignment(project.id, 1)?.reportNotice).toMatchObject({ state });
    await f.service.report(worker.threadId!, blocked);
    expect(f.send).toHaveBeenCalledTimes(state === "failed" ? 2 : 1);
    expect(f.store.assignment(project.id, 1)?.report?.outcome).toBe("blocked");
  });
});
