import { describe, expect, it } from "vitest";
import { projectFixture, report } from "./fake-native";
import { brief } from "./helpers";

// T92: a rejected assignment is closed. A late report from its worker is refused with
// current-assignment advice and writes nothing: the rejected state, its reviewed report,
// its task and any successor stay exactly as they were. Ports A203's w129-pre and Q1 probes.
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const refused = (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);
const ledger = (f: Fx, projectId: string) =>
  JSON.stringify([f.store.assignments(projectId), f.store.tasks(projectId), f.store.workers(projectId), f.store.activity(projectId)]);
const tool = (f: Fx, name: string, input: unknown, threadId = "coordinator") => f.harness.callAgentTool(name, input, { threadId });
const late = { ...report(), summary: "Late: actually finished after all." };
const bg = { pendingBackgroundWork: ["nohup npm run e2e &"] };

/** W1/A1 reports a failed outcome, goes idle and is rejected. */
async function rejected() {
  const { f, project } = await projectFixture();
  const task = f.task(project.id, "Search");
  const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
  await f.service.report(d.threadId!, { ...report(), outcome: "failed", summary: "Could not finish." } as never);
  f.idle(d.threadId!);
  await f.service.rejectReport(project.id, "A1", "Retry with the new schema.");
  return { f, project, task, threadId: d.threadId! };
}

describe("T92 a late report never revives a rejected assignment", () => {
  it("w129-pre: plain reject, then a late report from the same context is refused with no write", async () => {
    const x = await rejected();
    const a1 = x.f.store.assignment(x.project.id, 1)!;
    expect(a1.state).toBe("rejected");
    expect(x.f.store.task(x.project.id, x.task.num)!.status).toBe("planned");
    const before = ledger(x.f, x.project.id);
    for (const input of [late, { ...late, assignment: "A1" }]) {
      const message = await refused(x.f.service.report(x.threadId, input as never));
      expect(message).toMatch(/A1 was rejected \(Retry with the new schema\.\); its report is closed and this report was not recorded/);
      expect(message).toMatch(/W1 has no other current assignment\. Put anything the coordinator should know in your final reply/);
      expect(message).not.toMatch(/initiative_message|Wait for a new brief/);
      expect(ledger(x.f, x.project.id)).toBe(before);
    }
    expect(x.f.store.assignment(x.project.id, 1)).toEqual(a1);
    expect(x.f.send).toHaveBeenCalledTimes(0);
  });

  it("A203 Q1: a retired worker whose thread was unarchived cannot revive its orphan-rejected report while a successor runs", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id, "Search");
    const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
    await f.service.report(d.threadId!, { ...report(), outcome: "blocked", blocker: { question: "Which schema?", context: "Two exist." }, ...bg } as never);
    f.idle(d.threadId!);
    await tool(f, "initiative_worker", { action: "worker-retire", worker: "W1", reason: "Done." });
    f.threads.set(d.threadId!, { ...(f.threads.get(d.threadId!) as any), archivedAt: null });
    await tool(f, "initiative_task", { action: "assignment-reject", assignment: "A1", reason: "gone" });
    const [a2] = JSON.parse(await tool(f, "initiative_delegate", { action: "delegate", route: "fresh", tasks: [task.ref], label: "Retry", area: "Search", environment: { type: "worktree" } }) as string);
    expect(a2.assignment).toBe("A2");
    const a1 = f.store.assignment(project.id, 1)!;
    const before = ledger(f, project.id);
    for (const input of [late, { ...late, assignment: "A1" }]) {
      expect(await refused(f.service.report(d.threadId!, input as never))).toMatch(/A1 was rejected .*not recorded/);
      expect(ledger(f, project.id)).toBe(before);
    }
    // The reviewed report, its listed jobs, the filing count and the release binding stay frozen.
    expect(f.store.assignment(project.id, 1)).toEqual(a1);
    expect(a1).toMatchObject({ state: "rejected", report: { outcome: "blocked", pendingBackgroundWork: bg.pendingBackgroundWork } });
    // The orphan rejection no longer promises a refreshed report; only an explicit release clears the jobs.
    expect(a1.stopReason).toMatch(/keep A1's write scope until an explicit assignment-scope-release; a rejected assignment takes no later report\.\]$/);
    expect(f.store.task(project.id, task.num)!.status).toBe("in_progress");
    expect(f.store.assignment(project.id, 2)!.state).toBe("running");
  });

  it("a continued worker naming its rejected assignment is refused and pointed at its current one; an unnamed report still reaches the current assignment", async () => {
    const x = await rejected();
    const t2 = x.f.task(x.project.id, "Retry");
    await x.f.service.delegate(x.project.id, { route: "continue", worker: "W1", tasks: [t2.ref] });
    const a1 = x.f.store.assignment(x.project.id, 1)!;
    const a2 = x.f.store.assignment(x.project.id, 2)!;
    expect(a2.state).toBe("running");
    const before = ledger(x.f, x.project.id);
    const message = await refused(x.f.service.report(x.threadId, { ...late, assignment: "A1" } as never));
    expect(message).toMatch(/Your current assignment is A2; report only A2's own work on it, with "assignment":"A2"\. Send anything the coordinator should know with initiative_message\./);
    expect(ledger(x.f, x.project.id)).toBe(before);
    await x.f.service.report(x.threadId, late as never);
    expect(x.f.store.assignment(x.project.id, 1)).toEqual(a1);
    expect(x.f.store.assignment(x.project.id, 2)).toMatchObject({ state: "reported", report: { summary: late.summary } });
  });

  it("a late report listing background work is refused with advice for those jobs; the rejected hold still follows the running thread", async () => {
    const x = await rejected();
    x.f.store.db.prepare("UPDATE assignments SET write_scope = ? WHERE num = 1").run(JSON.stringify(["src"]));
    x.f.threads.set(x.threadId, { ...(x.f.threads.get(x.threadId) as any), status: "active" });
    const before = ledger(x.f, x.project.id);
    const message = await refused(x.f.service.report(x.threadId, { ...late, ...bg } as never));
    expect(message).toMatch(/The background work it lists \(nohup npm run e2e &\) is not recorded either: stop it before ending your turn and name it in your final reply\./);
    expect(message).not.toMatch(/initiative_message/);
    expect(ledger(x.f, x.project.id)).toBe(before);
    const other = x.f.service.createTask(x.project.id, { title: "Overlap", summary: "x", brief: brief("proj_a", ["src/lib"]) }, "coordinator");
    expect(await refused(x.f.service.delegate(x.project.id, { route: "fresh", tasks: [other.ref] }))).toMatch(/A1 \(W1\) is rejected, but its thread is still running/);
  });

  it("a rejection landing during the report's native reads wins: the report is refused and only the rejection is recorded", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id, "Search");
    const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
    await f.service.report(d.threadId!, { ...report(), outcome: "failed", summary: "first" } as never);
    f.idle(d.threadId!);
    let fired = false;
    f.intercept((path, _args, call) => {
      if (path === "threads.defaultExecutionOptions" && !fired) {
        fired = true;
        return f.service.rejectReport(project.id, "A1", "Retry.").then(() => call());
      }
      return call();
    });
    const message = await refused(f.service.report(d.threadId!, { ...late, assignment: "A1" } as never));
    f.intercept();
    expect(fired).toBe(true);
    expect(message).toMatch(/A1 was rejected \(Retry\.\)/);
    expect(f.store.assignment(project.id, 1)).toMatchObject({ state: "rejected", report: { summary: "first" }, reportSeq: 1 });
    expect(f.store.task(project.id, task.num)!.status).toBe("planned");
  });

  it("a rejected review assignment refuses its reviewer's late report", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id, "Search");
    const [impl] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
    await f.service.report(impl.threadId!, report() as never);
    f.idle(impl.threadId!);
    const [rev] = await f.service.delegate(project.id, { route: "fresh", role: "review", reviewOf: [task.ref] });
    await f.service.report(rev.threadId!, { ...report(), outcome: "blocked", blocker: { question: "Which revision?", context: "x" } } as never);
    f.idle(rev.threadId!);
    await f.service.rejectReport(project.id, "A2", "Wrong revision.");
    const before = ledger(f, project.id);
    expect(await refused(f.service.report(rev.threadId!, report() as never))).toMatch(/A2 was rejected \(Wrong revision\.\)/);
    expect(ledger(f, project.id)).toBe(before);
  });
});

describe("T92 controls: existing report contracts are unchanged", () => {
  it("a reported assignment can still be refreshed to clear its listed background work, then accepted", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id, "Search");
    const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
    await f.service.report(d.threadId!, { ...report(), ...bg } as never);
    await f.service.report(d.threadId!, report() as never);
    f.idle(d.threadId!);
    expect(f.store.assignment(project.id, 1)).toMatchObject({ state: "reported", reportSeq: 2, report: { pendingBackgroundWork: [] } });
    await f.service.acceptTask(project.id, task.ref, {});
    expect(f.store.task(project.id, task.num)!.status).toBe("done");
  });

  it("a stopped writer's late report is still stored without reviving it, and an accepted assignment still refuses one", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id, "Search");
    const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
    f.threads.set(d.threadId!, { ...(f.threads.get(d.threadId!) as any), status: "active" });
    await f.service.stopAssignment(project.id, "A1", "Replaced.");
    await f.service.report(d.threadId!, { ...late, ...bg } as never);
    expect(f.store.assignment(project.id, 1)).toMatchObject({ state: "cancelled", stopReason: "Stopped: Replaced.", report: { pendingBackgroundWork: bg.pendingBackgroundWork } });
    const x = await projectFixture();
    const t = x.f.task(x.project.id, "Docs");
    const [w] = await x.f.service.delegate(x.project.id, { route: "fresh", tasks: [t.ref] });
    await x.f.service.report(w.threadId!, report() as never);
    x.f.idle(w.threadId!);
    await x.f.service.acceptTask(x.project.id, t.ref, {});
    expect(await refused(x.f.service.report(w.threadId!, late as never))).toMatch(/A1 is already accepted/);
  });
});

describe("T92 A215: refusal advice matches what the caller can actually do", () => {
  const message = (f: Fx, threadId: string) =>
    refused(f.harness.callAgentTool("initiative_message", { target: "coordinator", text: "e2e still running", mode: "queue" }, { threadId }) as Promise<unknown>);

  it("F1: a continuation whose brief is still queued is named as not yet delivered; the stale report is never steered onto it", async () => {
    const { f, project } = await projectFixture();
    const t1 = f.task(project.id, "Search");
    const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [t1.ref] });
    await f.service.report(d.threadId!, report() as never);
    await f.service.rejectReport(project.id, "A1", "Redo.");
    const t2 = f.task(project.id, "Next");
    f.queueSend("a2-q");
    await f.service.delegate(project.id, { route: "continue", worker: "W1", tasks: [t2.ref] });
    expect(f.store.assignment(project.id, 2)).toMatchObject({ state: "queued", queuedMessageId: "a2-q", briefDelivered: false });
    const before = ledger(f, project.id);
    const advice = await refused(f.service.report(d.threadId!, { ...late, ...bg, assignment: "A1" } as never));
    expect(advice).toMatch(/Your next assignment A2's brief is not confirmed delivered to you yet: wait for it, and do not copy this A1 report onto A2\./);
    expect(advice).not.toMatch(/report only A2|"assignment":"A2"/);
    expect(ledger(f, project.id)).toBe(before);
    expect(f.store.assignment(project.id, 2)).toMatchObject({ state: "queued", queuedMessageId: "a2-q", briefDelivered: false });
    // The messaging guard admits a queued continuation, so the advice may offer it.
    expect(advice).toMatch(/stop it before ending your turn, or send it to the coordinator with initiative_message/);
    expect(await message(f, d.threadId!)).toBe("");
  });

  it("F2: a worker with no open work is not offered messaging, which its guard refuses", async () => {
    const { f, project } = await projectFixture();
    const t1 = f.task(project.id, "Search");
    const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [t1.ref] });
    await f.service.report(d.threadId!, report() as never);
    await f.service.rejectReport(project.id, "A1", "Redo.");
    const advice = await refused(f.service.report(d.threadId!, { ...late, ...bg } as never));
    expect(advice).not.toMatch(/initiative_message|Wait for a new brief/);
    expect(advice).toMatch(/stop it before ending your turn and name it in your final reply/);
    expect(advice).toMatch(/if this thread is an ordinary native child, BB sends its native parent a completion notice when the turn ends/);
    expect(await message(f, d.threadId!)).toMatch(/no current deliverable work/);
  });

  it("F2: a retired worker whose thread was unarchived is not told to wait for a brief or to message", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id, "Search");
    const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
    await f.service.report(d.threadId!, { ...report(), outcome: "failed", summary: "x" } as never);
    f.idle(d.threadId!);
    await tool(f, "initiative_worker", { action: "worker-retire", worker: "W1", reason: "Done." });
    f.threads.set(d.threadId!, { ...(f.threads.get(d.threadId!) as any), archivedAt: null });
    await f.service.rejectReport(project.id, "A1", "gone");
    const before = ledger(f, project.id);
    const advice = await refused(f.service.report(d.threadId!, { ...late, ...bg } as never));
    expect(advice).toMatch(/W1 is retired and has no current assignment\. Put anything the coordinator should know in your final reply/);
    expect(advice).not.toMatch(/initiative_message|brief/);
    expect(ledger(f, project.id)).toBe(before);
    expect(await message(f, d.threadId!)).toMatch(/stopped, retired/);
  });

  it("F3: a rejected holder's listed jobs point to an explicit release with the inspected version, not to a refused refresh", async () => {
    const { f, project } = await projectFixture();
    const t1 = f.task(project.id, "Search");
    const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [t1.ref] });
    f.store.db.prepare("UPDATE assignments SET write_scope = ? WHERE num = 1").run(JSON.stringify(["src"]));
    await f.service.report(d.threadId!, { ...report(), outcome: "blocked", blocker: { question: "Which schema?", context: "Two exist." }, ...bg } as never);
    f.idle(d.threadId!);
    // While reported, the hint still offers the supported refresh, but no longer promises one after an orphan rejection.
    const hint = await refused(f.service.stopAssignment(project.id, "A1", "x"));
    expect(hint).toMatch(/wait for an updated final report from W1/);
    expect(hint).toMatch(/keep A1's write scope until an explicit assignment-scope-release; a rejected assignment takes no later report\./);
    expect(hint).not.toMatch(/refreshed report/);
    const reportedHold = await refused(f.service.delegate(project.id, { route: "fresh", tasks: [f.service.createTask(project.id, { title: "A", summary: "x", brief: brief("proj_a", ["src/a"]) }, "coordinator").ref] }));
    expect(reportedHold).toMatch(/Wait for an updated final report; or/);
    await f.archive({ threadId: d.threadId! });
    await tool(f, "initiative_task", { action: "assignment-reject", assignment: "A1", reason: "gone" });
    expect(f.store.assignment(project.id, 1)!.state).toBe("rejected");
    const version = JSON.parse(await tool(f, "initiative_read", { refs: ["A1"] }) as string).items[0].reportVersion as string;
    const tb = f.service.createTask(project.id, { title: "B", summary: "x", brief: brief("proj_a", ["src/b"]) }, "coordinator");
    const before = ledger(f, project.id);
    const hold = await refused(f.service.delegate(project.id, { route: "fresh", tasks: [tb.ref] }));
    expect(hold).toMatch(new RegExp(`A1 \\(W1\\)'s report lists background work \\(nohup npm run e2e &\\) that is unverified and still owns overlapping paths\\. A1 is rejected and takes no later report: once those jobs are checked and BB shows the thread ended, record initiative_task \\{"action":"assignment-scope-release","assignment":"A1","reportVersion":"${version}","reason":"…"\\}; the release is not evidence that they ended`));
    expect(hold).not.toMatch(/Wait for an updated final report|refreshed/);
    expect(ledger(f, project.id)).toBe(before);
  });
});

describe("T92 A217: fork and dispatching advice", () => {
  const message = (f: Fx, threadId: string) =>
    refused(f.harness.callAgentTool("initiative_message", { target: "coordinator", text: "e2e still running", mode: "queue" }, { threadId }) as Promise<unknown>);
  /** W1 reports; W1 forks into W2/A2, which reports, goes idle and is rejected. */
  async function rejectedFork() {
    const { f, project } = await projectFixture();
    const t1 = f.task(project.id, "First");
    const [d1] = await f.service.delegate(project.id, { route: "fresh", tasks: [t1.ref] });
    await f.service.report(d1.threadId!, report() as never);
    f.idle(d1.threadId!);
    const [d2] = await f.service.delegate(project.id, { route: "fork", worker: "W1", tasks: [f.task(project.id, "Fork").ref], forkAtSeq: 1 });
    await f.service.report(d2.threadId!, { ...report(), outcome: "failed", summary: "x" } as never);
    f.idle(d2.threadId!);
    await f.service.rejectReport(project.id, "A2", "Redo.");
    return { f, project, threadId: d2.threadId! };
  }

  it("a rejected genuine fork with no deliverable work is told to stop its jobs first and is promised no delivery", async () => {
    const x = await rejectedFork();
    expect(x.f.store.worker(x.project.id, 2)).toMatchObject({ forkedFrom: 1 });
    const a2 = x.f.store.assignment(x.project.id, 2)!;
    const before = ledger(x.f, x.project.id);
    const advice = await refused(x.f.service.report(x.threadId, { ...late, ...bg } as never));
    expect(advice).toMatch(/W2 has no other current assignment\. Stop the background work it lists \(nohup npm run e2e &\) before ending your turn; it is not recorded either\. Your final reply stays only in this thread: as a fork, W2's turn endings are not delivered to the coordinator by ordinary native completion\./);
    expect(advice).not.toMatch(/completion notice|native parent|initiative_message|Put anything the coordinator should know/);
    expect(ledger(x.f, x.project.id)).toBe(before);
    expect(x.f.store.assignment(x.project.id, 2)).toEqual(a2);
    expect(await message(x.f, x.threadId)).toMatch(/no current deliverable work/);
    // Without listed jobs, only the record sentence remains.
    expect(await refused(x.f.service.report(x.threadId, late as never))).toMatch(/has no other current assignment\. Your final reply stays only in this thread: as a fork/);
  });

  it("an eligible fork is still offered messaging, which its guard admits", async () => {
    const x = await rejectedFork();
    await x.f.service.delegate(x.project.id, { route: "continue", worker: "W2", tasks: [x.f.task(x.project.id, "Next").ref] });
    expect(x.f.store.assignment(x.project.id, 3)).toMatchObject({ state: "running", briefDelivered: true });
    const advice = await refused(x.f.service.report(x.threadId, { ...late, ...bg, assignment: "A2" } as never));
    expect(advice).toMatch(/Your current assignment is A3; report only A3's own work on it/);
    expect(advice).toMatch(/stop it before ending your turn, or send it to the coordinator with initiative_message/);
    expect(advice).not.toMatch(/as a fork/);
    expect(await message(x.f, x.threadId)).toBe("");
  });

  it("a dispatching continuation is not called queued; the stale report is still never steered onto it", async () => {
    const x = await rejected();
    await x.f.service.delegate(x.project.id, { route: "continue", worker: "W1", tasks: [x.f.task(x.project.id, "Retry").ref] });
    x.f.store.updateAssignment(x.project.id, 2, { state: "dispatching", opState: "pending", briefDelivered: false, queuedMessageId: null });
    const before = ledger(x.f, x.project.id);
    const advice = await refused(x.f.service.report(x.threadId, { ...late, assignment: "A1" } as never));
    expect(advice).toMatch(/Your next assignment A2's brief is not confirmed delivered to you yet: wait for it, and do not copy this A1 report onto A2\./);
    expect(advice).not.toMatch(/queued|report only A2|"assignment":"A2"/);
    expect(ledger(x.f, x.project.id)).toBe(before);
  });
});
