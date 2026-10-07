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

describe("T59 native actionable delivery", () => {
  it("a final worker report keeps its task waiting until every open question resolves", async () => {
    const { f, project, worker } = await externalWork();
    const question = () => f.service.recordQuestion(project.id, { title: "Scope", question: "Include archives?", context: "Need explicit scope", humanAttention: "needs-opinion", blocksTaskIds: ["T6"] }, { author: "coordinator", threadId: "coordinator", assignment: null });
    const first = question(), second = question();
    await f.service.report(worker.threadId!, checkedReport());
    f.send.mockClear();
    expect(f.store.task(project.id, 6)).toMatchObject({ status: "blocked", progress: `Waiting for your opinion on ${first.ref}`, acceptedAssignment: null });
    f.service.closeQuestion(project.id, first.ref, "Already settled.");
    expect(f.store.task(project.id, 6)).toMatchObject({ status: "blocked", progress: `Waiting for your opinion on ${second.ref}` });
    await f.service.answerOpinion(project.id, second.ref, { choice: null, note: "Yes", notify: false });
    // T136: the reported task stays open until the coordinator closes it.
    expect(f.store.task(project.id, 6)).toMatchObject({ status: "in_progress", acceptedAssignment: null });
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
    await f.service.closeTask(project.id, "T6", "done");
    f.idle(worker.threadId!);
    await f.service.delegate(project.id, { route: "continue", worker: worker.worker, tasks: ["T11"], delivery });
    expect(f.send.mock.calls.at(-1)![0]).toMatchObject({ mode: delivery === "steer" ? "steer-if-active" : "queue-if-active", senderThreadId: "coordinator" });
  });

});
