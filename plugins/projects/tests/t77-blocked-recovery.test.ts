import { describe, expect, it } from "vitest";
import { projectFixture, report } from "./fake-native";
import { parseCommandInput } from "../lib/commands";

// T77: a reported blocked/failed assignment is retried through the existing assignment-reject.
// Isolated counterpart of the A196 audit (Marbre T16/A35); no foreign reads.
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const tool = (f: Fx, name: string, input: unknown) => f.harness.callAgentTool(name, input, { threadId: "coordinator" });
const refused = (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);
const blocked = (extra: object = {}) => ({
  ...report(), outcome: "blocked" as const, summary: "Blocked: the migration needs a credential only Erwin has.",
  blocker: { question: "Can Erwin provide the staging credential?", context: "The migration cannot run without it." }, ...extra,
});
const retry = { label: "Migration retry", area: "Database migration" };

async function reportedBlocked(extra: object = {}, outcome: "blocked" | "failed" = "blocked") {
  const { f, project } = await projectFixture();
  const task = f.task(project.id, "Ship the migration");
  const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
  // A failed report usually carries no blocker; a blocked one must.
  const { blocker, ...noBlocker } = blocked(extra);
  await f.service.report(d.threadId!, (outcome === "blocked" ? { ...noBlocker, blocker, outcome } : { ...noBlocker, outcome }) as never);
  f.idle(d.threadId!);
  return { f, project, task, threadId: d.threadId! };
}
const names = (message: string) => {
  expect(message).toContain('"action":"assignment-reject"');
  expect(message).toContain('"assignment":"A1"');
  expect(message).toMatch(/report.*stay in the ledger/);
  expect(message).toMatch(/route continue to W1/);
  expect(message).not.toMatch(/reopen or re-delegate|Accept or stop it/);
};

describe("T77 refusals on a reported blocked or failed assignment point to assignment-reject", () => {
  for (const outcome of ["blocked", "failed"] as const)
    it(`accept, delegate (continue and fresh) and Stop refusals for a ${outcome} report name the exit, not the loop`, async () => {
      const { f, project, task } = await reportedBlocked({}, outcome);
      const accept = await refused(tool(f, "initiative_task", { action: "task-accept", task: task.ref }));
      expect(accept).toMatch(new RegExp(`A1 reported ${outcome}, so it cannot be accepted`));
      names(accept);
      expect(accept).toMatch(outcome === "blocked" ? /report, blocker and handoff stay in the ledger.*with the answer to its blocker/ : /report and handoff stay in the ledger.*with what the retry needs/);
      const cont = await refused(tool(f, "initiative_delegate", { action: "delegate", route: "continue", worker: "W1", tasks: [task.ref] }));
      expect(cont).toMatch(new RegExp(`T1 already has A1 \\(reported ${outcome}\\)`));
      names(cont);
      names(await refused(tool(f, "initiative_delegate", { action: "delegate", route: "fresh", tasks: [task.ref], ...retry })));
      const stop = await refused(tool(f, "initiative_task", { action: "assignment-stop", assignment: "A1", reason: "Retry." }));
      expect(stop).toMatch(/A1 is reported .*Stop applies only to running work/);
      names(stop);
      expect(f.store.assignment(project.id, 1)).toMatchObject({ state: "reported" });
      expect(f.store.assignments(project.id)).toHaveLength(1);
    });

  it("task-reopen says it does not release the reported assignment, and still returns the task", async () => {
    const { f, project, task } = await reportedBlocked();
    const result = JSON.parse(await tool(f, "initiative_task", { action: "task-reopen", task: task.ref, reason: "Retry once the credential exists." }) as string);
    expect(result).toMatchObject({ ref: "T1", status: "planned" });
    expect(result.note).toMatch(/A1 is still reported and still holds T1/);
    expect(result.note).toContain('"action":"assignment-reject"');
    expect(f.store.assignment(project.id, 1)!.state).toBe("reported");
    // A reopen with nothing reported keeps its plain result.
    const { f: g, project: p2 } = await projectFixture();
    const t = g.task(p2.id);
    expect(JSON.parse(await tool(g, "initiative_task", { action: "task-reopen", task: t.ref, reason: "x" }) as string)).not.toHaveProperty("note");
  });

  it("a succeeded report still points to task-accept first", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id);
    const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
    await f.service.report(d.threadId!, report());
    const message = await refused(tool(f, "initiative_delegate", { action: "delegate", route: "continue", worker: "W1", tasks: [task.ref] }));
    expect(message).toMatch(/T1 already has A1 \(reported succeeded\)\. Accept it with task-accept/);
    expect(message).toContain("assignment-reject");
  });

  it("running work keeps its Stop guidance and cannot be rejected", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id);
    await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
    expect(await refused(tool(f, "initiative_delegate", { action: "delegate", route: "continue", worker: "W1", tasks: [task.ref] }))).toMatch(/T1 already has A1 \(running\)\. Accept or stop it before delegating again\./);
    expect(await refused(tool(f, "initiative_task", { action: "assignment-reject", assignment: "A1", reason: "x" }))).toMatch(/Only a reported assignment can be rejected/);
    expect(f.store.assignment(project.id, 1)!.state).toBe("running");
  });
});

describe("T77 assignment-reject keeps the evidence and frees the task", () => {
  it("history stays byte-identical, a rejected report cannot be accepted, and the same task continues to W1", async () => {
    const { f, project, task } = await reportedBlocked();
    const before = f.store.assignment(project.id, 1)!;
    const reason = "Blocked on the staging credential; retry with the same worker now that Erwin supplied it.";
    await tool(f, "initiative_task", { action: "assignment-reject", assignment: "A1", reason });
    const after = f.store.assignment(project.id, 1)!;
    expect(after).toMatchObject({ state: "rejected", stopReason: reason, opState: "done" });
    for (const key of ["report", "briefText", "threadId", "checkpoint", "workerNum", "taskNums"] as const) expect(after[key]).toEqual(before[key]);
    const read = JSON.parse(await tool(f, "initiative_read", { refs: ["A1"], detailed: true, fields: ["report"] }) as string);
    expect(read.items[0].report.blocker).toEqual(before.report!.blocker);
    expect(f.store.task(project.id, task.num)?.status).toBe("planned");
    expect(await refused(tool(f, "initiative_task", { action: "task-accept", task: task.ref, assignment: "A1" }))).toMatch(/no report to accept \(rejected\)/);
    const [a2] = JSON.parse(await tool(f, "initiative_delegate", { action: "delegate", route: "continue", worker: "W1", tasks: [task.ref], note: "Erwin supplied the staging credential." }) as string);
    expect(a2).toMatchObject({ worker: "W1", assignment: "A2" });
  });

  it("a fresh worker can take the task once the report is rejected", async () => {
    const { f, task } = await reportedBlocked();
    await tool(f, "initiative_task", { action: "assignment-reject", assignment: "A1", reason: "Retry with a fresh worker." });
    const [a2] = JSON.parse(await tool(f, "initiative_delegate", { action: "delegate", route: "fresh", tasks: [task.ref], ...retry }) as string);
    expect(a2).toMatchObject({ worker: "W2", assignment: "A2" });
  });
});

describe("T77 a report that still lists background work cannot be rejected", () => {
  it("refuses with no write and asks for an updated final report; a refreshed report without background work can be rejected", async () => {
    const { f, project, task, threadId } = await reportedBlocked({ pendingBackgroundWork: ["npm run e2e (still running)"] });
    const before = JSON.stringify([f.store.assignments(project.id), f.store.tasks(project.id), f.store.activity(project.id)]);
    const accept = await refused(tool(f, "initiative_task", { action: "task-accept", task: task.ref }));
    expect(accept).toMatch(/still lists background work/);
    const message = await refused(tool(f, "initiative_task", { action: "assignment-reject", assignment: "A1", reason: "Retry." }));
    expect(message).toMatch(/A1's report still lists background work/);
    expect(message).toMatch(/updated final report from W1/);
    expect(message).not.toMatch(/continuation|route continue|delegate/);
    expect(JSON.stringify([f.store.assignments(project.id), f.store.tasks(project.id), f.store.activity(project.id)])).toBe(before);

    // The worker finishes its background work and reports again.
    await f.service.report(threadId, blocked() as never);
    expect(f.store.assignment(project.id, 1)!.report!.pendingBackgroundWork).toEqual([]);
    await tool(f, "initiative_task", { action: "assignment-reject", assignment: "A1", reason: "Retry with the credential." });
    expect(f.store.assignment(project.id, 1)!.state).toBe("rejected");
  });
});

describe("T77 describe example", () => {
  it("bb initiative describe reject returns a strict-parser-valid assignment-reject", async () => {
    const { f } = await projectFixture();
    const list = JSON.parse((await f.harness.runCli(["describe"], { threadId: "coordinator" })).stdout!);
    expect(list.commands).toContain("reject");
    const example = JSON.parse((await f.harness.runCli(["describe", "reject"], { threadId: "coordinator" })).stdout!);
    expect(example).toMatchObject({ action: "assignment-reject" });
    expect(parseCommandInput(example)).toMatchObject({ action: "assignment-reject" });
  });
});

describe("T77 A200: a background-listed report whose worker context has ended (D342)", () => {
  const bg = { pendingBackgroundWork: ["npm run e2e (still running)"] };
  const snapshot = (f: Fx, projectId: string) => JSON.stringify([f.store.assignments(projectId), f.store.tasks(projectId), f.store.activity(projectId)]);
  const reject = (f: Fx) => tool(f, "initiative_task", { action: "assignment-reject", assignment: "A1", reason: "W1 is gone; retry with a fresh worker." });
  async function expectOrphanRejected(f: Fx, projectId: string, task: { ref: string; num: number }) {
    const before = f.store.assignment(projectId, 1)!;
    await reject(f);
    const after = f.store.assignment(projectId, 1)!;
    expect(after.state).toBe("rejected");
    // The report, including the listed background work, is kept exactly as filed.
    expect(after.report).toEqual(before.report);
    expect(after.report!.pendingBackgroundWork).toEqual(bg.pendingBackgroundWork);
    expect(after.stopReason).toMatch(/^W1 is gone; retry with a fresh worker\./);
    expect(after.stopReason).toMatch(/listed background work remains unverified/);
    expect(after.stopReason).not.toMatch(/finished|completed|ended successfully/);
    expect(f.store.activity(projectId).some(e => /A1 rejected: .*remains unverified/.test(e.summary))).toBe(true);
    expect(f.store.task(projectId, task.num)?.status).toBe("planned");
    expect(await refused(tool(f, "initiative_task", { action: "task-accept", task: task.ref, assignment: "A1" }))).toMatch(/no report to accept \(rejected\)/);
    // T91/D343: the listed jobs may still run, so they keep A1's write scope after the rejection.
    expect(after.stopReason).toMatch(/may still be running and keep A1's write scope/);
    const held = await refused(tool(f, "initiative_delegate", { action: "delegate", route: "fresh", tasks: [task.ref], ...retry }));
    expect(held).toMatch(/A1 \(W1\)'s report lists background work .*unverified/);
    expect(held).toContain('"action":"assignment-scope-release"');
    // An explicit, reasoned release (BB shows the thread ended) frees it; the report stays as filed.
    const reportVersion = JSON.parse(await tool(f, "initiative_read", { refs: ["A1"] }) as string).items[0].reportVersion;
    await tool(f, "initiative_task", { action: "assignment-scope-release", assignment: "A1", reportVersion, reason: "Checked: the e2e job is gone." });
    expect(f.store.assignment(projectId, 1)!.report).toEqual(before.report);
    const [next] = JSON.parse(await tool(f, "initiative_delegate", { action: "delegate", route: "fresh", tasks: [task.ref], ...retry }) as string);
    expect(next).toMatchObject({ assignment: "A2" });
  }

  it("A200 P2x: its thread archived outside Projects (runtime retires W1) → reject is allowed and the work stays unverified", async () => {
    const { f, project, task, threadId } = await reportedBlocked(bg);
    await f.archive({ threadId });
    f.runtime.onThreadArchived(f.threads.get(threadId)!);
    expect(f.store.worker(project.id, 1)!.state).toBe("retired");
    await expectOrphanRejected(f, project.id, task);
  });

  it("explicit worker-retire (thread archived by retirement) → reject is allowed", async () => {
    const { f, project, task } = await reportedBlocked(bg);
    await tool(f, "initiative_worker", { action: "worker-retire", worker: "W1", reason: "Done." });
    expect(f.store.worker(project.id, 1)!.state).toBe("retired");
    await expectOrphanRejected(f, project.id, task);
  });

  it("a live worker whose thread was deleted, or is missing (404), cannot update the report → reject is allowed", async () => {
    for (const gone of ["deleted", "missing"] as const) {
      const { f, project, task, threadId } = await reportedBlocked(bg);
      if (gone === "deleted") f.threads.set(threadId, { ...(f.threads.get(threadId) as any), deletedAt: 5 });
      else f.threads.delete(threadId);
      expect(f.store.worker(project.id, 1)!.state).not.toBe("retired");
      await expectOrphanRejected(f, project.id, task);
    }
  });

  it("a retired label with an active or unreadable thread is not enough: refused with no write", async () => {
    for (const thread of [{ status: "active" }, { archivedAt: undefined }] as const) {
      const { f, project, threadId } = await reportedBlocked(bg);
      f.store.updateWorker(project.id, 1, { state: "retired" });
      f.threads.set(threadId, { ...(f.threads.get(threadId) as any), ...thread });
      const before = snapshot(f, project.id);
      const message = await refused(reject(f));
      expect(message).toMatch(/W1 is retired, but its thread is not confirmed ended/);
      expect(message).not.toMatch(/continuation|route continue/);
      expect(snapshot(f, project.id)).toBe(before);
    }
  });

  it("a live worker with an existing quiet thread still must send an updated report", async () => {
    const { f, project } = await reportedBlocked(bg);
    const before = snapshot(f, project.id);
    const message = await refused(reject(f));
    expect(message).toMatch(/wait for an updated final report from W1/);
    expect(snapshot(f, project.id)).toBe(before);
  });

  it("a ledger change during the native read is re-checked: nothing is written", async () => {
    const { f, project, threadId } = await reportedBlocked(bg);
    await f.archive({ threadId });
    f.runtime.onThreadArchived(f.threads.get(threadId)!);
    let fired = false;
    let before = "";
    f.harness.sdk.stub("threads.get", async ({ threadId: id }: { threadId: string }) => {
      if (!fired) {
        fired = true;
        // A refreshed report lands while BB is being asked.
        const a1 = f.store.assignment(project.id, 1)!;
        f.store.updateAssignment(project.id, 1, { report: { ...a1.report!, summary: "Refreshed." } });
        before = snapshot(f, project.id);
      }
      return f.threads.get(id);
    });
    const message = await refused(reject(f));
    expect(fired).toBe(true);
    expect(message).toMatch(/changed while checking/);
    expect(snapshot(f, project.id)).toBe(before);
    expect(f.store.assignment(project.id, 1)!.state).toBe("reported");
  });
});

describe("T77 A200: review assignments get review advice; blocked reports never 'yet' accepted", () => {
  async function reportedReview(outcome: "succeeded" | "blocked") {
    const { f, project } = await projectFixture();
    const t = f.task(project.id);
    const [impl] = await f.service.delegate(project.id, { route: "fresh", tasks: [t.ref] });
    await f.service.report(impl.threadId!, report());
    f.idle(impl.threadId!);
    const [rev] = await f.service.delegate(project.id, { route: "fresh", role: "review", reviewOf: [t.ref] });
    await f.service.report(rev.threadId!, (outcome === "succeeded" ? report() : blocked()) as never);
    f.idle(rev.threadId!);
    return { f, project };
  }

  it("A200 P1: Stop on a succeeded review names review-accept or reject, with no empty task refs", async () => {
    const { f } = await reportedReview("succeeded");
    const message = await refused(tool(f, "initiative_task", { action: "assignment-stop", assignment: "A2", reason: "x" }));
    expect(message).toMatch(/A2 is reported \(succeeded\); Stop applies only to running work/);
    expect(message).toContain('"action":"review-accept"');
    expect(message).toContain('"action":"assignment-reject"');
    expect(message).not.toMatch(/task-accept|route continue|fork|delegating {2}|retry ,| again,? usually/);
  });

  it("A200 P1b: Stop on a blocked review names reject and a fresh independent reviewer for its reviewOf/targets", async () => {
    const { f } = await reportedReview("blocked");
    const message = await refused(tool(f, "initiative_task", { action: "assignment-stop", assignment: "A2", reason: "x" }));
    expect(message).toContain('"action":"assignment-reject"');
    expect(message).toMatch(/fresh independent reviewer/);
    expect(message).toMatch(/reviewOf \["T1"\]/);
    expect(message).toMatch(/"task":"T1","assignment":"A1"/);
    expect(message).not.toMatch(/task-accept|route continue|continuation|fork|W2 with/);
  });

  it("A200 P3: a blocked report listing background work is never said to become acceptable", async () => {
    const { f, task } = await reportedBlocked({ pendingBackgroundWork: ["e2e"] });
    for (const message of [
      await refused(tool(f, "initiative_task", { action: "task-accept", task: task.ref })),
      await refused(tool(f, "initiative_task", { action: "assignment-reject", assignment: "A1", reason: "x" })),
    ]) {
      expect(message).toMatch(/cannot be rejected until/);
      expect(message).not.toMatch(/neither accepted nor rejected|yet/);
    }
  });
});
