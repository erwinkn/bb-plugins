import { describe, expect, it } from "vitest";
import { projectFixture, report } from "./fake-native";

async function failedProvision() {
  const { f, project } = await projectFixture(); const task = f.task(project.id);
  const [created] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
  const thread = { ...f.threads.get(created.threadId!)!, status: "error" as const, environmentId: null };
  f.threads.set(thread.id, thread);
  f.history.splice(0, f.history.length,
    { type: "client/turn/requested", seq: 1, createdAt: 1, data: { source: "spawn" } },
    { type: "system/thread-provisioning", seq: 2, createdAt: 2, data: { status: "failed" } },
    { type: "system/error", seq: 3, createdAt: 3, data: { code: "thread_provisioning_failed" } });
  await f.runtime.onThreadFailed(thread, "Workspace setup failed: base branch gone");
  return { f, project, task, created, thread };
}

describe("T68 accepted creation, provisioning failure and same-task recovery", () => {
  it("accepted create is delivery, not execution; a provisioning error is not called a failed turn", async () => {
    const { f, project, created } = await failedProvision();
    expect(created.note).toContain("does not establish that an agent turn started");
    expect(f.store.assignment(project.id, 1)).toMatchObject({ briefDelivered: true, opState: "done", report: null, stopReason: "Native thread failed: Workspace setup failed: base branch gone." });
    expect(f.store.activity(project.id, 10).some(x => x.summary.includes("turn failed"))).toBe(false);
  });
  it("stop settles a positively quiet pre-turn failure and reuses its original task without inventing execution", async () => {
    const { f, project, task } = await failedProvision();
    const stopped = await f.service.stopAssignment(project.id, "A1", "Provisioning failed");
    expect(stopped).toMatchObject({ state: "cancelled", opState: "done", briefDelivered: true, report: null });
    const released = f.store.task(project.id, task.num)!;
    expect(released.status).toBe("planned"); expect(released.progress).toContain("execution is not established");
    expect(released.progress).not.toContain("brief ran");
    const [retry] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
    expect(retry.assignment).toBe("A2"); expect(f.store.tasks(project.id)).toHaveLength(1);
    expect(f.store.assignment(project.id, 1)?.state).toBe("cancelled");
  });
  it("explicit reassignment rechecks a known accepted cancelled reservation once the native side becomes quiet", async () => {
    const { f, project, task, thread } = await failedProvision();
    f.threads.set(thread.id, { ...thread, status: "active" });
    await f.service.stopAssignment(project.id, "A1", "Stop requested");
    expect(f.store.assignment(project.id, 1)?.opState).toBe("uncertain");
    f.threads.set(thread.id, thread);
    const [retry] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
    expect(retry.assignment).toBe("A2"); expect(f.store.assignment(project.id, 1)).toMatchObject({ state: "cancelled", opState: "done" });
  });
  it.each(["active", "pending", "queue", "background", "unreadable", "missing-row", "unknown-status"])("%s native evidence keeps the reservation", async kind => {
    const { f, project, task, thread } = await failedProvision();
    if (kind === "active" || kind === "pending") f.threads.set(thread.id, { ...thread, status: kind });
    if (kind === "queue") f.threads.set(thread.id, { ...thread, queuedMessageCount: 1 });
    if (kind === "background") f.threads.set(thread.id, { ...thread, activeBackgroundAgentCount: 1 });
    if (kind === "unreadable") f.harness.sdk.stub("threads.get", async () => { throw new Error("Native read unavailable"); });
    if (kind === "missing-row") f.harness.sdk.stub("threads.list", async () => []);
    if (kind === "unknown-status") f.harness.sdk.stub("threads.list", async () => [{ ...thread, status: "unrecognized" }] as never);
    await f.service.stopAssignment(project.id, "A1", "Stop requested");
    await expect(f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] })).rejects.toThrow(/A1/);
    expect(f.store.assignment(project.id, 1)).toMatchObject({ state: "cancelled", opState: "uncertain" });
    expect(f.spawn).toHaveBeenCalledTimes(1);
  });
  it("a confirmed missing native thread releases without claiming its accepted brief ran", async () => {
    const { f, project, task } = await failedProvision();
    f.harness.sdk.stub("threads.get", async () => { throw Object.assign(new Error("Gone"), { status: 404 }); });
    await f.service.stopAssignment(project.id, "A1", "Gone");
    expect(f.store.assignment(project.id, 1)?.opState).toBe("done");
    expect(f.store.task(project.id, task.num)?.progress).toContain("execution is not established");
  });
  it.each(["command", "workflow", "failed-queue", "malformed-count"])("a native %s list row cannot settle cancelled work", async kind => {
    const { f, project, task, thread } = await failedProvision();
    const rows = await f.bb.sdk.threads.list({});
    f.harness.sdk.stub("threads.list", async () => rows.map(row => row.id !== thread.id ? row : {
      ...row,
      queuedWork: kind === "failed-queue" ? "failed" as const : row.queuedWork,
      activity: { ...row.activity,
        activeBackgroundCommandCount: kind === "command" ? 1 : kind === "malformed-count" ? NaN : 0,
        activeWorkflowCount: kind === "workflow" ? 1 : 0 },
    }));
    await f.service.stopAssignment(project.id, "A1", "Stop requested");
    await expect(f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] })).rejects.toThrow(/A1/);
    expect(f.store.assignment(project.id, 1)?.opState).toBe("uncertain");
  });
  it("a received prompt and empty bounded history do not become proof that an uncertain create never ran", async () => {
    const { f, project } = await projectFixture(); const task = f.task(project.id);
    f.spawn.mockRejectedValueOnce(new Error("Lost create response"));
    await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
    await f.service.stopAssignment(project.id, "A1", "Unknown outcome");
    f.history.splice(0);
    await expect(f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] })).rejects.toThrow(/A1/);
    expect(f.store.assignment(project.id, 1)).toMatchObject({ state: "cancelled", opState: "uncertain", threadId: null });
  });
  it("late real work reports remain cancelled evidence, and quiet settlement names that proof", async () => {
    const { f, project, task, thread } = await failedProvision();
    f.threads.set(thread.id, { ...thread, status: "active" });
    await f.service.stopAssignment(project.id, "A1", "Stop requested");
    await f.service.report(thread.id, report());
    expect(f.store.assignment(project.id, 1)).toMatchObject({ state: "cancelled", opState: "uncertain", report: report() });
    f.threads.set(thread.id, thread); await f.runtime.onThreadIdle(thread);
    expect(f.store.assignment(project.id, 1)).toMatchObject({ state: "cancelled", opState: "done", report: report() });
    expect(f.store.task(project.id, task.num)?.progress).toContain("report proves work ran");
  });
  it("new accepted evidence arriving during a quiet read cannot be overwritten by settlement", async () => {
    const { f, project, thread } = await failedProvision();
    f.threads.set(thread.id, { ...thread, status: "active" }); await f.service.stopAssignment(project.id, "A1", "Stop requested");
    f.threads.set(thread.id, thread);
    f.harness.sdk.stub("threads.get", async () => {
      f.store.updateAssignment(project.id, 1, { state: "accepted", report: report() }); return thread;
    });
    await f.service.reconcile();
    expect(f.store.assignment(project.id, 1)).toMatchObject({ state: "accepted", report: report(), opState: "uncertain" });
  });
  it("a quiet accepted prompt without a report settles without inferring execution from empty history", async () => {
    const { f, project } = await projectFixture(); const task = f.task(project.id);
    const [created] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
    f.idle(created.threadId!); f.history.splice(0);
    await f.service.stopAssignment(project.id, "A1", "No report");
    expect(f.store.task(project.id, task.num)?.progress).toContain("execution is not established");
    expect(f.harness.inspection.sdk.callsTo("threads.events.list")).toHaveLength(0);
  });
  it("Stop racing an unconfirmed create holds until its real receipt arrives", async () => {
    const { f, project } = await projectFixture(); const task = f.task(project.id);
    const original = f.spawn.getMockImplementation()!;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.spawn.mockImplementationOnce(async args => {
      entered(); await gate; const t = await original(args);
      const failed = { ...t, status: "error" as const, environmentId: null };
      f.threads.set(t.id, failed); return failed;
    });
    const dispatch = f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
    await started; await f.service.stopAssignment(project.id, "A1", "Cancel pending create");
    expect(f.store.assignment(project.id, 1)).toMatchObject({ state: "cancelled", opState: "uncertain", threadId: null });
    await expect(f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] })).rejects.toThrow(/A1/);
    release(); await dispatch;
    expect(f.store.assignment(project.id, 1)).toMatchObject({ state: "cancelled", opState: "done", briefDelivered: true });
    expect(f.store.task(project.id, task.num)?.progress).toContain("execution is not established");
    expect(f.spawn).toHaveBeenCalledTimes(1);
  });
  it("a quiet old thread cannot settle Stop racing an unconfirmed continuation or its later queue receipt", async () => {
    const { f, project } = await projectFixture(); const first = f.task(project.id);
    const [worker] = await f.service.delegate(project.id, { route: "fresh", tasks: [first.ref] });
    await f.service.report(worker.threadId!, report()); await f.service.acceptTask(project.id, first.ref, {}); f.idle(worker.threadId!);
    const task = f.task(project.id, "Next"); let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.send.mockImplementationOnce(async args => {
      entered(); await gate;
      const queuedMessage = { id: "late-queue", content: args.input };
      f.queued.set(worker.threadId!, [queuedMessage]);
      return { delivery: "queued", queuedMessage };
    });
    const dispatch = f.service.delegate(project.id, { route: "continue", worker: worker.worker, tasks: [task.ref] });
    await started; await f.service.stopAssignment(project.id, "A2", "Stop pending send");
    await expect(f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] })).rejects.toThrow(/A2/);
    release(); await dispatch;
    expect(f.store.assignment(project.id, 2)).toMatchObject({ state: "cancelled", opState: "uncertain", queuedMessageId: "late-queue", briefDelivered: false });
    await expect(f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] })).rejects.toThrow(/A2/);
  });
});
