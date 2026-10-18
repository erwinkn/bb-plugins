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

  it("durable question blocks real tasks; worker chat answer steers with recorder provenance and an honest native queue receipt", async () => {
    const { f, project, worker } = await externalWork();
    const request = { action: "question", question: { title: "Platform sign-off", humanAttention: "needs-opinion", question: "Who signs off macOS?", context: "Native bridge readiness", options: [{ label: "Erwin", consequences: "Wait for a human machine check" }], recommendation: "Erwin verifies the platform", blocksTaskIds: ["T11"] } };
    const q = JSON.parse(await f.harness.callAgentTool("initiative_decision", request, { threadId: "coordinator" }) as string);
    f.queueSend("interaction-queue");
    const result = JSON.parse(await f.harness.callAgentTool("initiative_decision", { action: "answer", decision: q.ref, choice: "Erwin", note: "I'll run the check." }, { threadId: worker.threadId! }) as string);
    expect(f.send.mock.calls.at(-1)![0]).toMatchObject({ mode: "steer-if-active", senderThreadId: worker.threadId, threadId: "coordinator" });
    expect(result.notification).toMatchObject({ state: "queued", queuedId: "interaction-queue" });
    expect(f.store.task(project.id, 11)?.status).toBe("planned");
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("a continuation always steers through native BB with the coordinator sender", async () => {
    const { f, project, worker } = await externalWork();
    await f.service.report(worker.threadId!, checkedReport());
    await f.service.setTaskStatus(project.id, "T6", "done", "Closed as done.", "the user");
    f.idle(worker.threadId!);
    await f.service.delegate(project.id, { route: "continue", worker: worker.worker, tasks: ["T11"] });
    expect(f.send.mock.calls.at(-1)![0]).toMatchObject({ mode: "steer-if-active", senderThreadId: "coordinator" });
  });

});
