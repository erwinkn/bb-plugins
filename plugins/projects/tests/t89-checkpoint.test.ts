import { describe, expect, it } from "vitest";
import { projectFixture, report } from "./fake-native";

// T89: a cancellation already settled as failed (provably never delivered, reservation
// released) must not block a valid new checkpoint for good. Unresolved operations and
// live queue receipts still block, including when they appear during the native read.
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const checkedReport = () => ({ ...report(), handoff: { ...report().handoff, workspaceRevision: "replay-sha", verificationRevision: "replay-sha" } });
const tool = (f: Fx, name: string, input: unknown, threadId = "coordinator") => f.harness.callAgentTool(name, input, { threadId });
const checkpoint = (f: Fx, task: string, worker: string, threadId = "coordinator") =>
  tool(f, "initiative_task", { action: "task-checkpoint", task, worker, report: checkedReport() }, threadId).then(r => JSON.parse(r as string));
const refused = (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);

/** W1 finished A1 (reported, accepted, idle); its continuation A2 was lost, stopped and settled as never sent. */
async function settledNotSent() {
  const { f, project } = await projectFixture();
  const t1 = f.task(project.id);
  const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [t1.ref] });
  await f.service.report(d.threadId!, report());
  await f.service.acceptTask(project.id, t1.ref, {});
  f.idle(d.threadId!);
  const worker = f.store.workers(project.id)[0]!;
  const t2 = f.task(project.id, "Next");
  f.send.mockImplementationOnce(async () => { throw Object.assign(new Error("connection reset"), { status: 0 }); });
  await f.service.delegate(project.id, { route: "continue", worker: worker.ref, tasks: [t2.ref] });
  await f.service.stopAssignment(project.id, "A2", "cancel");
  await f.service.settleUncertain(project.id, "A2", { notSent: true });
  return { f, project, worker, t2 };
}
const ledger = (f: Fx, projectId: string) => JSON.stringify([f.store.assignments(projectId), f.store.tasks(projectId)]);

describe("T89 a terminal settled cancellation no longer blocks checkpointing", () => {
  it("records a separate checkpoint assignment, before and after a sweep, leaving A1's report and A2's cancellation history intact", async () => {
    const { f, project, worker } = await settledNotSent();
    const a1 = f.store.assignment(project.id, 1)!;
    const a2 = f.store.assignment(project.id, 2)!;
    expect(a2).toMatchObject({ state: "cancelled", opState: "failed", cancelRequested: true, queuedMessageId: null, briefDelivered: false, stopReason: "Stopped: cancel" });
    expect(a1.report).not.toBeNull();

    const milestone = f.task(project.id, "Replay milestone");
    const saved = await checkpoint(f, milestone.ref, worker.ref);
    expect(saved).toMatchObject({ ref: "A3", route: "checkpoint", state: "reported", taskNums: [milestone.num], report: { outcome: "succeeded", handoff: { workspaceRevision: "replay-sha" } }, checkpoint: { recordedBy: "coordinator", sourceThreadId: worker.threadId } });
    await f.runtime.sweep();
    const second = await checkpoint(f, f.task(project.id, "Second milestone").ref, worker.ref);
    expect(second).toMatchObject({ ref: "A4", route: "checkpoint", state: "reported" });

    // Nothing earlier was rewritten: the cancellation and its settlement provenance stand.
    expect(f.store.assignment(project.id, 1)).toEqual(a1);
    expect(f.store.assignment(project.id, 2)).toEqual(a2);
    expect(f.store.activity(project.id).some(e => e.summary.includes("A2's cancelled send was settled as never delivered"))).toBe(true);
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("does not use a cancelled assignment as the checkpoint source", async () => {
    const { f, project, worker, t2 } = await settledNotSent();
    const message = await refused(tool(f, "initiative_task", { action: "task-checkpoint", task: t2.ref, worker: worker.ref, assignment: "A2", report: checkedReport() }));
    expect(message).toMatch(/A2 is cancelled/);
    expect(f.store.assignment(project.id, 2)).toMatchObject({ state: "cancelled", opState: "failed", report: null });
  });
});

describe("T89 unresolved receipts still block, including during the native read", () => {
  it("an uncertain cancellation awaiting native quiet still refuses checkpointing", async () => {
    const { f, project } = await projectFixture();
    const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id).ref] });
    f.threads.set(d.threadId!, { ...(f.threads.get(d.threadId!) as any), status: "active" });
    await f.service.stopAssignment(project.id, "A1", "cancel");
    const milestone = f.task(project.id, "Milestone");
    const before = ledger(f, project.id);
    const message = await refused(checkpoint(f, milestone.ref, "W1"));
    expect(message).toMatch(/A1 \(op \S+ uncertain, assignment cancelled\)/);
    expect(message).toMatch(/positively quiet/);
    expect(ledger(f, project.id)).toBe(before);
  });

  it("a live queued brief still refuses checkpointing", async () => {
    const { f, project, worker, t2 } = await settledNotSent();
    f.queueSend("q");
    await f.service.delegate(project.id, { route: "continue", worker: worker.ref, tasks: [t2.ref] });
    expect(f.store.assignment(project.id, 3)).toMatchObject({ state: "queued", opState: "done", queuedMessageId: "q" });
    const message = await refused(checkpoint(f, f.task(project.id, "Milestone").ref, worker.ref));
    expect(message).toMatch(/still in BB's native queue/);
    expect(f.store.assignments(project.id)).toHaveLength(3);
  });

  for (const [arriving, blocks] of [["pending", true], ["uncertain", true], ["failed", false], ["done", false]] as const)
    it(`a cancellation whose op is ${arriving} arriving during the native read ${blocks ? "prevents" : "does not prevent"} the write`, async () => {
      const { f, project, worker } = await settledNotSent();
      const milestone = f.task(project.id, "Milestone");
      let fired = false;
      f.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => {
        if (!fired) {
          fired = true;
          // A1 is stopped while the coordinator's checkpoint awaits BB.
          f.store.updateAssignment(project.id, 1, { cancelRequested: true, opState: arriving });
        }
        return f.threads.get(threadId);
      });
      const before = f.store.assignments(project.id).length;
      const result = await checkpoint(f, milestone.ref, worker.ref).then(r => r, (e: Error) => e);
      expect(fired).toBe(true);
      if (blocks) {
        expect(result).toBeInstanceOf(Error);
        expect((result as Error).message).toMatch(/changed while checkpointing; nothing was recorded/);
        expect((result as Error).message).toContain("A1");
        expect(f.store.assignments(project.id)).toHaveLength(before);
        expect(f.store.task(project.id, milestone.num)?.status).toBe("planned");
      } else {
        expect(result).toMatchObject({ ref: "A3", route: "checkpoint", state: "reported" });
      }
    });

  it("existing contract refusals are unchanged: running managed work, reported source, stopped worker, worker caller", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id);
    const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
    expect(await refused(checkpoint(f, task.ref, "W1"))).toMatch(/already has A1/);
    await f.service.report(d.threadId!, report());
    expect(await refused(tool(f, "initiative_task", { action: "task-checkpoint", task: task.ref, worker: "W1", assignment: "A1", report: checkedReport() }))).toMatch(/reported evidence|with a report/);
    expect(await refused(checkpoint(f, f.task(project.id, "Other").ref, "W1", d.threadId!))).not.toBe("");
    f.store.updateWorker(project.id, 1, { userStopped: true });
    expect(await refused(checkpoint(f, f.task(project.id, "Third").ref, "W1"))).toMatch(/unstopped/);
    expect(f.store.assignments(project.id)).toHaveLength(1);
  });
});
