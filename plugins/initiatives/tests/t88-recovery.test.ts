import { describe, expect, it } from "vitest";
import { projectFixture, report } from "./fake-native";

// Isolated counterpart of erwinkn.com W1/A1 (thr_83umudet2c seq 1799–1855): a delivered
// continuation is stopped while its native thread may still run, reuse is refused until a
// sweep sees the thread positively quiet, and only then can a valid continuation start.
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const refused = (promise: Promise<unknown>) => promise.then(() => "", (e: Error) => e.message);
const tool = (f: Fx, name: string, input: unknown) => f.harness.callAgentTool(name, input, { threadId: "coordinator" });
const setStatus = (f: Fx, id: string, status: string) => f.threads.set(id, { ...(f.threads.get(id) as any), status });

async function stoppedWhileRunning() {
  const { f, project } = await projectFixture();
  const task = f.task(project.id);
  const [delegated] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
  const a1 = f.store.assignments(project.id).at(-1)!;
  const worker = `W${a1.workerNum}`;
  setStatus(f, delegated.threadId!, "active");
  await tool(f, "initiative_task", { action: "assignment-stop", assignment: a1.ref, reason: "Replacing it with the remaining replay." });
  return { f, project, task, a1: f.store.assignment(project.id, a1.num)!, worker, threadId: delegated.threadId! };
}

describe("T88 a cancelled assignment awaiting native quiet confirmation", () => {
  it("is pending, not settled: op uncertain with Stop requested and the brief delivered", async () => {
    const { a1 } = await stoppedWhileRunning();
    expect(a1).toMatchObject({ state: "cancelled", cancelRequested: true, opState: "uncertain", briefDelivered: true });
  });

  it("refuses reuse naming the assignment, its op and the pending native quiet confirmation", async () => {
    const { f, project, task, a1, worker } = await stoppedWhileRunning();
    const message = await refused(tool(f, "initiative_delegate", { action: "delegate", route: "continue", worker, tasks: [task.ref] }));
    expect(message).toMatch(/unconfirmed operation/);
    expect(message).toContain(a1.ref);
    expect(message).toContain(a1.opId!);
    expect(message).toMatch(/uncertain/);
    expect(message).toMatch(/positively quiet/);
    expect(message).toMatch(/sweep/);
    // Not the misleading instruction that sent the real coordinator to settle by hand.
    expect(message).not.toMatch(/Settle it before reusing/);
    expect(f.store.assignments(project.id)).toHaveLength(1);
  });

  it("CLI assignment-settle with the thread confirms delivery only, and says so within its first 300 bytes", async () => {
    const { f, project, task, a1, worker, threadId } = await stoppedWhileRunning();
    const result = await f.harness.runCli(["command", JSON.stringify({ action: "assignment-settle", assignment: a1.ref, outcome: { threadId } }), project.id], { threadId: "coordinator" });
    expect(result.exitCode).toBe(0);
    const head = result.stdout!.slice(0, 300);
    expect(head).toMatch(/delivery .*confirmed/i);
    expect(head).toMatch(/native quiet .*pending/i);
    expect(head).toContain(a1.opId!);
    // Existing consumers still get the full assignment record.
    expect(JSON.parse(result.stdout!)).toMatchObject({ ref: a1.ref, state: "cancelled", opState: "uncertain" });
    // The pending state is unchanged, so reuse is still refused (real seq 1833).
    expect(await refused(tool(f, "initiative_delegate", { action: "delegate", route: "continue", worker, tasks: [task.ref] }))).toMatch(/positively quiet/);
  });

  it("refuses a peer message to the worker without suggesting it grants work or bypasses the Stop", async () => {
    const { f, project, a1, worker } = await stoppedWhileRunning();
    // A read-only peer: a second writer is refused while A1's reservation holds.
    const [peer] = await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id).ref], access: "read-only" });
    setStatus(f, peer.threadId!, "active");
    const message = await refused(f.harness.callAgentTool("initiative_message", { target: worker, text: "The replay inputs moved.", mode: "queue" }, { threadId: peer.threadId! }));
    // T136: a stop that has not settled must not be woken by a message.
    expect(message).toMatch(new RegExp(`${worker}'s ${a1.ref} is being stopped or is not confirmed yet; message it once that settles`));
    expect(f.send).not.toHaveBeenCalled();
  });

  it("once a sweep sees the thread positively quiet the op is done, and a valid continuation starts; sent legacy messages never block it", async () => {
    const { f, project, task, a1, worker, threadId } = await stoppedWhileRunning();
    // Confirmed legacy worker_messages rows stay as history (erwinkn op_873b4fd99fa9 and peers).
    f.store.db.prepare("INSERT INTO worker_messages (op_id, project_id, worker_num, generation, thread_id, assignment_num, kind, text, state, queued_id, created_at) VALUES (?, ?, ?, 1, ?, NULL, 'message', 'old', 'sent', NULL, 1)")
      .run("op_legacy_sent", project.id, Number(worker.slice(1)), threadId);
    // Still running natively: the sweep keeps the reservation.
    await f.runtime.sweep();
    expect(f.store.assignment(project.id, a1.num)).toMatchObject({ opState: "uncertain" });
    f.idle(threadId);
    await f.runtime.sweep();
    expect(f.store.assignment(project.id, a1.num)).toMatchObject({ state: "cancelled", opState: "done" });
    expect(f.store.activity(project.id).some(e => e.summary.includes(`${a1.ref}'s cancelled native side is positively quiet`))).toBe(true);
    const [a2] = JSON.parse(await tool(f, "initiative_delegate", { action: "delegate", route: "continue", worker, tasks: [task.ref] }) as string);
    expect(a2).toMatchObject({ worker, assignment: "A2" });
    expect(f.store.db.prepare("SELECT state FROM worker_messages WHERE op_id='op_legacy_sent'").get()).toEqual({ state: "sent" });
  });
});

describe("T88 an ambiguous dispatch is still refused, with its own recovery", () => {
  it("names the unconfirmed send and the explicit settle outcomes, not native quiet", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id);
    f.spawn.mockImplementationOnce(async () => { throw Object.assign(new Error("connection reset"), { status: 0 }); });
    await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
    const record = f.store.assignment(project.id, 1)!;
    expect(record).toMatchObject({ state: "dispatching", opState: "uncertain" });
    const message = await refused(f.service.delegate(project.id, { route: "continue", worker: `W${record.workerNum}`, tasks: [task.ref] }));
    expect(message).toMatch(/unconfirmed operation/);
    expect(message).toContain("A1");
    expect(message).toContain(record.opId!);
    expect(message).toMatch(/notSent/);
    expect(message).toMatch(/threadId/);
    expect(message).not.toMatch(/positively quiet/);
  });
});

describe("T88 A189: each refusal names the real prerequisite and next step", () => {
  /** Worker W1 finished T1 (accepted, idle); T2 is next. */
  async function finishedWorker() {
    const { f, project } = await projectFixture();
    const t1 = f.task(project.id);
    const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [t1.ref] });
    await f.service.report(d.threadId!, report());
    await f.service.closeTask(project.id, t1.ref, "done");
    f.idle(d.threadId!);
    const worker = f.store.workers(project.id)[0]!;
    return { f, project, worker, t2: f.task(project.id, "Next") };
  }
  const reuse = (f: Fx, project: { id: string }, worker: string, task: string) =>
    refused(f.service.delegate(project.id, { route: "continue", worker, tasks: [task] }));

  // A189 exact probe: a queued continuation is cancelled while its queue delete fails; the
  // sweep later removes the row while the thread is active, then releases once it is idle.
  it("a cancelled queued continuation needs only the sweep: row removal, then positive quiet", async () => {
    const { f, project, worker, t2 } = await finishedWorker();
    f.queueSend("q");
    await f.service.delegate(project.id, { route: "continue", worker: worker.ref, tasks: [t2.ref] });
    f.queued.set(worker.threadId!, [{ id: "q", content: f.send.mock.calls.at(-1)![0].input }]);
    f.harness.sdk.stub("threads.queuedMessages.delete", async () => { throw new Error("offline"); });
    await f.service.stopAssignment(project.id, "A2", "cancel");
    const queued = await reuse(f, project, worker.ref, t2.ref);
    expect(f.store.assignment(project.id, 2)).toMatchObject({ state: "cancelled", opState: "uncertain", queuedMessageId: "q" });
    expect(queued).toContain("A2");
    expect(queued).toMatch(/removing it alone does not release/);
    expect(queued).toMatch(/gone and the thread is positively quiet/);
    expect(queued).not.toMatch(/assignment-settle|notSent/);

    f.harness.sdk.stub("threads.queuedMessages.delete", async ({ threadId }: any) => { f.queued.set(threadId, []); return {}; });
    f.threads.set(worker.threadId!, { ...(f.threads.get(worker.threadId!) as any), status: "active" });
    await f.runtime.sweep();
    // Pending, not settled: the row is gone but the thread is still active.
    expect(f.store.assignment(project.id, 2)).toMatchObject({ state: "cancelled", opState: "uncertain", queuedMessageId: null, briefDelivered: false });
    const removed = await reuse(f, project, worker.ref, t2.ref);
    expect(removed).toMatch(/positively quiet/);
    expect(removed).toMatch(/sweep/);
    expect(removed).not.toMatch(/assignment-settle|notSent/);

    f.idle(worker.threadId!);
    await f.runtime.sweep();
    // Settled by the sweep alone.
    expect(f.store.assignment(project.id, 2)).toMatchObject({ state: "cancelled", opState: "done" });
  });

  it("a cancelled fresh worker whose creation BB never confirmed still points to inspection and an explicit settle", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id);
    f.spawn.mockImplementationOnce(async () => { throw Object.assign(new Error("connection reset"), { status: 0 }); });
    await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
    await f.service.stopAssignment(project.id, "A1", "cancel");
    expect(f.store.assignment(project.id, 1)).toMatchObject({ state: "cancelled", opState: "uncertain", threadId: null });
    const message = await reuse(f, project, "W1", task.ref);
    expect(message).toMatch(/never confirmed whether its thread was created/);
    expect(message).toMatch(/notSent/);
    expect(message).toMatch(/threadId/);
    expect(message).not.toMatch(/Nothing needs settling/);
  });

  it("a peer message to work whose dispatch is unconfirmed points to confirming it, not to a continuation", async () => {
    const { f, project } = await projectFixture();
    await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id).ref] });
    f.store.updateAssignment(project.id, 1, { state: "dispatching", opState: "pending" } as any);
    const [peer] = await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id, "Other").ref], access: "read-only" });
    setStatus(f, peer.threadId!, "active");
    const message = await refused(f.harness.callAgentTool("initiative_message", { target: "W1", text: "hi", mode: "queue" }, { threadId: peer.threadId! }));
    expect(message).toMatch(/W1's A1 is being stopped or is not confirmed yet/);
  });

  it("retirement refusals name the blocking assignment and the sweep, not settle-by-hand", async () => {
    const { f, project, a1, worker } = await stoppedWhileRunning();
    const next = f.task(project.id, "External milestone");
    void next;
    const retire = await refused(tool(f, "initiative_worker", { action: "retire", worker, reason: "Done." }));
    expect(retire).toContain(a1.ref);
    expect(retire).toContain(a1.opId!);
    expect(retire).toMatch(/positively quiet/);
    expect(retire).not.toMatch(/Inspect and settle|Settle this worker/);
    expect(retire).toMatch(/retire/);
    expect(f.store.workers(project.id)[0]!.state).not.toBe("retired");
    // "Never sent" stays refused for a delivered brief, and points to the sweep rather than another settle.
    const notSent = await refused(tool(f, "initiative_task", { action: "assignment-settle", assignment: a1.ref, outcome: { notSent: true } }));
    expect(notSent).toMatch(/cannot be settled as never sent/);
    expect(notSent).toMatch(/positively quiet/);
    expect(notSent).not.toMatch(/Settle it by its outcome/);
    expect(f.store.assignment(project.id, a1.num)).toMatchObject({ state: "cancelled", opState: "uncertain" });
  });
});

describe("T88 A191: a cancelled operation already settled as failed is terminal", () => {
  // A191 probe (exact): a lost continuation send, then Stop, then an explicit notSent settle.
  async function settledNotSent() {
    const { f, project } = await projectFixture();
    const t1 = f.task(project.id);
    const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [t1.ref] });
    await f.service.report(d.threadId!, report());
    await f.service.closeTask(project.id, t1.ref, "done");
    f.idle(d.threadId!);
    const worker = f.store.workers(project.id)[0]!;
    const t2 = f.task(project.id, "Next");
    f.send.mockImplementationOnce(async () => { throw Object.assign(new Error("connection reset"), { status: 0 }); });
    await f.service.delegate(project.id, { route: "continue", worker: worker.ref, tasks: [t2.ref] });
    await f.service.stopAssignment(project.id, "A2", "cancel");
    await f.service.settleUncertain(project.id, "A2", { notSent: true });
    return { f, project, worker, t2 };
  }
  const checkpoint = (f: Fx, project: { id: string }, worker: string, title: string) =>
    refused(tool(f, "initiative_task", { action: "task-checkpoint", task: f.task(project.id, title).ref, worker, report: report() }));

  it("is settled, not pending: cancelled, op failed, Stop flag set, no queue receipt", async () => {
    const { f, project } = await settledNotSent();
    expect(f.store.assignment(project.id, 2)).toMatchObject({ state: "cancelled", opState: "failed", cancelRequested: true, queuedMessageId: null, briefDelivered: false });
  });

  // Was A192's known-defect control (permanent refusal, see w113-a192/red-a190.txt and
  // A191's probe). T89 corrected the guard: a terminal settled cancellation is history.

  it("a plain message reaches the worker at once, and more work starts", async () => {
    const { f, project, worker, t2 } = await settledNotSent();
    void project;
    const sends = f.send.mock.calls.length;
    await f.harness.callAgentTool("initiative_message", { to: worker.ref, text: "hi" }, { threadId: "coordinator" });
    expect(f.send).toHaveBeenCalledTimes(sends + 1);
    const [a3] = JSON.parse(await tool(f, "initiative_delegate", { action: "delegate", route: "continue", worker: worker.ref, tasks: [t2.ref] }) as string);
    expect(a3).toMatchObject({ worker: worker.ref, assignment: "A3" });
  });
});
