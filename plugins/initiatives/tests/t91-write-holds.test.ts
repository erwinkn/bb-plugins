import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { projectFixture, report } from "./fake-native";
import { brief } from "./helpers";
import { parseCommandInput } from "../lib/commands";

// T91: a writer's declared scope stays held after it reports while its native thread may
// still run, and while its report lists unverified background work (D343). Ports A199's
// matrix and A201's P1–P7 probes as assertions; isolated fixtures only.
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const taskAt = (f: Fx, id: string, title: string, paths: string[]) =>
  f.service.createTask(id, { title, summary: "x", brief: brief("proj_a", paths) }, "coordinator");
const setThread = (f: Fx, id: string, patch: Record<string, unknown>) => f.threads.set(id, { ...(f.threads.get(id) as any), ...patch });
const quiet = { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activeGoalCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 };
const refused = (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);
const tool = (f: Fx, name: string, input: unknown, threadId = "coordinator") => f.harness.callAgentTool(name, input, { threadId });
/** The report version a coordinator sees in a bounded assignment read. */
const versionOf = async (f: Fx, ref: string) =>
  JSON.parse(await f.harness.callAgentTool("initiative_read", { refs: [ref] }, { threadId: "coordinator" }) as string).items[0].reportVersion as string;
const ledger = (f: Fx, projectId: string) => JSON.stringify([f.store.assignments(projectId), f.store.tasks(projectId), f.store.workers(projectId), f.store.activity(projectId)]);

/** W1/A1 writes src/ and reports; its native thread then goes idle, unless the caller shapes it. */
async function reportedWriter(opts: { access?: "write" | "read-only"; extra?: object } = {}) {
  const { f, project } = await projectFixture();
  const t1 = taskAt(f, project.id, "Writer one", ["src"]);
  const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [t1.ref], ...(opts.access ? { access: opts.access } : {}) });
  await f.service.report(d.threadId!, { ...report(), ...(opts.extra ?? {}) } as never);
  f.idle(d.threadId!);
  const t2 = taskAt(f, project.id, "Writer two", ["src/lib"]);
  return { f, project, t1, t2, threadId: d.threadId! };
}
const freshWrite = (f: Fx, projectId: string, ref: string, extra: object = {}) =>
  f.service.delegate(projectId, { route: "fresh", tasks: [ref], ...extra });
const bg = { pendingBackgroundWork: ["nohup npm run migrate &"] };

describe("T91 a reported writer keeps its scope while its thread may still run", () => {
  const holds: [string, (x: Awaited<ReturnType<typeof reportedWriter>>) => unknown, RegExp][] = [
    ["B2 foreground still active", x => setThread(x.f, x.threadId, { status: "active" }), /thread is still running/],
    ["B3 idle with an unlisted background command", x => setThread(x.f, x.threadId, { activity: { ...quiet, activeBackgroundCommandCount: 1 } }), /thread is still running/],
    ["B4 idle with queued input", x => setThread(x.f, x.threadId, { queuedMessageCount: 1 }), /thread is still running/],
    ["D2 malformed list row", x => setThread(x.f, x.threadId, { activity: { activeBackgroundAgentCount: 0 } }), /could not be proven quiet/],
  ];
  for (const [name, shape, why] of holds)
    it(`${name}: an overlapping shared write is refused, naming the hold, with no ledger write`, async () => {
      const x = await reportedWriter();
      await shape(x);
      const before = ledger(x.f, x.project.id);
      const message = await refused(freshWrite(x.f, x.project.id, x.t2.ref));
      expect(message).toMatch(/A1 \(W1\)/);
      expect(message).toMatch(why);
      expect(message).toMatch(/narrow the paths, or use an isolated workspace/);
      expect(message).not.toMatch(/retire/i);
      expect(ledger(x.f, x.project.id)).toBe(before);
    });

  it("B5 a listed background job holds even when BB looks quiet, and names the release", async () => {
    const x = await reportedWriter({ extra: bg });
    const message = await refused(freshWrite(x.f, x.project.id, x.t2.ref));
    expect(message).toMatch(/A1 \(W1\)'s report lists background work .*unverified/);
    expect(message).toContain('"action":"assignment-scope-release"');
    expect(message).not.toMatch(/retire/i);
  });

  it("B6/B7 accepted or rejected reports keep holding while the thread runs", async () => {
    for (const settle of ["accept", "reject"] as const) {
      const x = await reportedWriter();
      setThread(x.f, x.threadId, { activity: { ...quiet, activeBackgroundCommandCount: 1 } });
      if (settle === "accept") await x.f.service.acceptTask(x.project.id, x.t1.ref, {});
      else await x.f.service.rejectReport(x.project.id, "A1", "retry");
      expect(await refused(freshWrite(x.f, x.project.id, x.t2.ref)), settle).toMatch(/A1 \(W1\).*thread is still running/);
    }
  });

  it("controls: read-only, disjoint, isolated, read-only incumbent and same-worker continue are allowed; quiet or archived releases", async () => {
    const make = async (shape?: (x: Awaited<ReturnType<typeof reportedWriter>>) => unknown, opts = {}) => {
      const x = await reportedWriter(opts);
      if (shape) shape(x);
      return x;
    };
    const active = (x: Awaited<ReturnType<typeof reportedWriter>>) => setThread(x.f, x.threadId, { status: "active" });
    let x = await make(active);
    await freshWrite(x.f, x.project.id, x.t2.ref, { access: "read-only" });
    x = await make(active);
    await freshWrite(x.f, x.project.id, taskAt(x.f, x.project.id, "Docs", ["docs"]).ref);
    x = await make(active);
    await freshWrite(x.f, x.project.id, x.t2.ref, { environment: { type: "worktree" } });
    x = await make(active, { access: "read-only" });
    await freshWrite(x.f, x.project.id, x.t2.ref);
    x = await make(active);
    await x.f.service.delegate(x.project.id, { route: "continue", worker: "W1", tasks: [x.t2.ref] });
    expect(x.f.send.mock.calls.at(-1)![0].mode).toBe("queue-if-active");
    x = await make();
    await freshWrite(x.f, x.project.id, x.t2.ref);
    x = await make(y => setThread(y.f, y.threadId, { status: "active", archivedAt: 5 }));
    await freshWrite(x.f, x.project.id, x.t2.ref);
  });
});

describe("T91 every past write scope of a thread counts, as declared at dispatch", () => {
  for (const access of ["read-only", "write"] as const)
    it(`A201 P3: a later ${access} continuation on docs does not erase A1's src hold`, async () => {
      const x = await reportedWriter();
      setThread(x.f, x.threadId, { activity: { ...quiet, activeBackgroundCommandCount: 1 } });
      const docs = taskAt(x.f, x.project.id, "Docs", ["docs"]);
      await x.f.service.delegate(x.project.id, { route: "continue", worker: "W1", tasks: [docs.ref], access });
      expect(await refused(freshWrite(x.f, x.project.id, x.t2.ref))).toMatch(/A1 \(W1\)/);
    });

  it("a later failed continuation does not erase the older hold either", async () => {
    const x = await reportedWriter();
    setThread(x.f, x.threadId, { status: "active" });
    x.f.send.mockImplementationOnce(async () => { throw Object.assign(new Error("refused"), { status: 400 }); });
    await refused(x.f.service.delegate(x.project.id, { route: "continue", worker: "W1", tasks: [taskAt(x.f, x.project.id, "Docs", ["docs"]).ref] }));
    expect(await refused(freshWrite(x.f, x.project.id, x.t2.ref))).toMatch(/A1 \(W1\)/);
  });

  it("A201 #8: editing the task brief after dispatch does not narrow the recorded scope", async () => {
    const x = await reportedWriter();
    setThread(x.f, x.threadId, { status: "active" });
    expect(x.f.store.assignment(x.project.id, 1)!.writeScope).toEqual(["src"]);
    x.f.service.updateTask(x.project.id, x.t1.ref, { brief: brief("proj_a", ["docs"]) }, "coordinator");
    expect(x.f.store.assignment(x.project.id, 1)!.writeScope).toEqual(["src"]);
    expect(await refused(freshWrite(x.f, x.project.id, x.t2.ref))).toMatch(/A1 \(W1\)/);
  });

  it("a record without a recorded scope is held as the whole project and says so", async () => {
    const x = await reportedWriter();
    setThread(x.f, x.threadId, { status: "active" });
    x.f.store.db.prepare("UPDATE assignments SET write_scope = NULL WHERE num = 1").run();
    const message = await refused(freshWrite(x.f, x.project.id, taskAt(x.f, x.project.id, "Docs", ["docs"]).ref));
    expect(message).toMatch(/A1 \(W1\).*no recorded write scope.*whole project/);
  });

  it("a checkpoint snapshots its task's declared scope", async () => {
    const { f, project } = await projectFixture();
    const t1 = taskAt(f, project.id, "Delivered", ["src"]);
    await f.service.delegate(project.id, { route: "fresh", tasks: [t1.ref] });
    const external = taskAt(f, project.id, "External", ["lib/external"]);
    const saved = await f.service.checkpointTask(project.id, { task: external.ref, worker: "W1", report: { ...report(), handoff: { ...report().handoff, workspaceRevision: "sha", verificationRevision: "sha" } } } as never, "coordinator");
    expect(f.store.assignment(project.id, saved.num)!.writeScope).toEqual(["lib/external"]);
  });
});

describe("T91 dispatch reads native state once, before the final reservation re-read", () => {
  it("A201 P7: of two simultaneous overlapping writers, exactly one reserves", async () => {
    const x = await reportedWriter();
    const t3 = taskAt(x.f, x.project.id, "Writer three", ["src/lib/x"]);
    const results = await Promise.all([
      x.f.service.delegate(x.project.id, { route: "fresh", tasks: [x.t2.ref] }).then(() => "ok", (e: Error) => e.message),
      x.f.service.delegate(x.project.id, { route: "fresh", tasks: [t3.ref] }).then(() => "ok", (e: Error) => e.message),
    ]);
    expect(results.filter(r => r === "ok")).toHaveLength(1);
    expect(results.find(r => r !== "ok")).toMatch(/overlapping paths/);
  });

  it("a candidate that changes during the native read counts as unknown", async () => {
    const x = await reportedWriter();
    let fired = false;
    x.f.intercept((path, args, call) => {
      if (path === "threads.list" && args?.projectId && !fired) {
        fired = true;
        // A refreshed report lands while BB is being asked.
        const a1 = x.f.store.assignment(x.project.id, 1)!;
        x.f.store.updateAssignment(x.project.id, 1, { report: { ...a1.report!, summary: "Refreshed." } });
      }
      return call();
    });
    const message = await refused(freshWrite(x.f, x.project.id, x.t2.ref));
    expect(fired).toBe(true);
    expect(message).toMatch(/A1 \(W1\).*could not be proven quiet/);
  });

  it("bounded: quiet disjoint writers cost no native evidence reads; overlapping ones one project list pass plus GETs only for missing ids", async () => {
    const { f, project } = await projectFixture();
    for (let i = 0; i < 10; i++) {
      const t = taskAt(f, project.id, `Disjoint ${i}`, [`pkg${i}`]);
      const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [t.ref] });
      await f.service.report(d.threadId!, report());
      f.idle(d.threadId!);
      await f.service.acceptTask(project.id, t.ref, {});
    }
    const calls: { path: string; args: any }[] = [];
    f.intercept((path, args, call) => { calls.push({ path, args }); return call(); });
    await freshWrite(f, project.id, taskAt(f, project.id, "Mine", ["src"]).ref);
    expect(calls.filter(c => c.path === "threads.list" && c.args?.projectId)).toHaveLength(0);
    calls.length = 0;
    const overlapping = taskAt(f, project.id, "Wide", ["pkg1", "pkg2", "pkg3"]);
    f.threads.delete(f.store.assignment(project.id, 3)!.threadId!);
    await freshWrite(f, project.id, overlapping.ref);
    const lists = calls.filter(c => c.path === "threads.list" && c.args?.projectId);
    expect(lists.length).toBeGreaterThan(0);
    expect(lists.length).toBeLessThanOrEqual(5);
    expect(lists.every(c => c.args.projectId === "proj_a" && c.args.includeHidden === true)).toBe(true);
    const gets = calls.filter(c => c.path === "threads.get").map(c => c.args.threadId);
    expect(gets.filter(id => [2, 3, 4].map(n => f.store.assignment(project.id, n)!.threadId).includes(id))).toEqual([f.store.assignment(project.id, 3)!.threadId]);
  });
});

describe("T91 retirement and forks", () => {
  it("A201 P4: retire refuses while the root list row shows a background command; no archive or Stop", async () => {
    const x = await reportedWriter();
    await x.f.service.acceptTask(x.project.id, x.t1.ref, {});
    setThread(x.f, x.threadId, { activity: { ...quiet, activeBackgroundCommandCount: 1 } });
    const message = await refused(tool(x.f, "initiative_worker", { action: "worker-retire", worker: "W1", reason: "Done." }));
    expect(message).toMatch(/background/);
    expect(x.f.archive).not.toHaveBeenCalled();
    expect(x.f.stop).not.toHaveBeenCalled();
    expect(x.f.store.worker(x.project.id, 1)!.state).not.toBe("retired");
  });

  it("A201 P5: retiring a worker whose report lists background work does not release its scope", async () => {
    const x = await reportedWriter({ extra: bg });
    await tool(x.f, "initiative_worker", { action: "worker-retire", worker: "W1", reason: "Done." });
    expect(x.f.store.worker(x.project.id, 1)!.state).toBe("retired");
    expect(await refused(freshWrite(x.f, x.project.id, x.t2.ref))).toMatch(/A1 \(W1\)'s report lists background work/);
  });

  it("A201 P2: an explicit shared-checkout fork of a running writer is a new writer; the default worktree fork stays isolated", async () => {
    const { f, project } = await projectFixture();
    const t1 = taskAt(f, project.id, "Writer one", ["src"]);
    const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [t1.ref] });
    f.idle(d.threadId!);
    const t2 = taskAt(f, project.id, "Writer two", ["src/lib"]);
    expect(await refused(f.service.delegate(project.id, { route: "fork", worker: "W1", tasks: [t2.ref], environment: { type: "reuse", environmentId: "env_a" }, forkAtSeq: 1 }))).toMatch(/A1 \(W1\) is writing overlapping paths/);
    await f.service.delegate(project.id, { route: "fork", worker: "W1", tasks: [t2.ref], forkAtSeq: 1 });
    expect(f.fork.mock.calls.at(-1)![0]).toMatchObject({ environment: { workspace: { type: "managed-worktree" } } });
  });
});

describe("T91 explicit scope release (D343)", () => {
  // The caller echoes the report version it inspected (A205 F3); read it the way a coordinator would.
  const release = async (f: Fx, threadId = "coordinator", assignment = "A1") =>
    tool(f, "initiative_task", { action: "assignment-scope-release", assignment, reportVersion: await versionOf(f, assignment), reason: "Erwin checked: the nohup migrate job is gone." }, threadId);

  it("needs positive native end; records actor, reason and report version; keeps the report; frees the scope", async () => {
    const x = await reportedWriter({ extra: bg });
    setThread(x.f, x.threadId, { status: "active" });
    const before = ledger(x.f, x.project.id);
    expect(await refused(release(x.f))).toMatch(/A1's thread is not confirmed ended .*Nothing was recorded/);
    expect(ledger(x.f, x.project.id)).toBe(before);
    x.f.idle(x.threadId);
    const report1 = x.f.store.assignment(x.project.id, 1)!.report;
    const released = JSON.parse(await release(x.f) as string);
    expect(released).toMatchObject({ ref: "A1", state: "reported", scopeRelease: { by: "coordinator", recordedBy: "coordinator", reason: "Erwin checked: the nohup migrate job is gone." } });
    expect(released.scopeRelease.evidence).toMatch(/BB shows A1's thread ended/);
    const a1 = x.f.store.assignment(x.project.id, 1)!;
    expect(a1.report).toEqual(report1);
    expect(a1.report!.pendingBackgroundWork).toEqual(bg.pendingBackgroundWork);
    expect(x.f.store.activity(x.project.id).some(e => /A1's write scope was released by the coordinator: .*not evidence that it finished/.test(e.summary))).toBe(true);
    await freshWrite(x.f, x.project.id, x.t2.ref);
  });

  it("a later report makes an earlier release stale", async () => {
    const x = await reportedWriter({ extra: bg });
    await release(x.f);
    await x.f.service.report(x.threadId, { ...report(), pendingBackgroundWork: ["nohup npm run seed &"] } as never);
    x.f.idle(x.threadId);
    expect(await refused(freshWrite(x.f, x.project.id, x.t2.ref))).toMatch(/A1 \(W1\)'s report lists background work/);
  });

  it("is refused for unresolved receipts, missing listed work, worker callers and a change during the native read", async () => {
    const x = await reportedWriter({ extra: bg });
    x.f.store.updateAssignment(x.project.id, 1, { opState: "uncertain" });
    expect(await refused(release(x.f))).toMatch(/unconfirmed operation/);
    x.f.store.updateAssignment(x.project.id, 1, { opState: "done" });
    const plain = await reportedWriter();
    expect(await refused(release(plain.f))).toMatch(/lists no background work/);
    const [w2] = await x.f.service.delegate(x.project.id, { route: "fresh", tasks: [taskAt(x.f, x.project.id, "Docs", ["docs"]).ref] });
    expect(await refused(release(x.f, w2.threadId!))).toMatch(/This thread is not the current coordinator of an Initiative/);
    let fired = false;
    x.f.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => {
      if (!fired) { fired = true; const a1 = x.f.store.assignment(x.project.id, 1)!; x.f.store.updateAssignment(x.project.id, 1, { report: { ...a1.report!, summary: "Refreshed." } }); }
      return x.f.threads.get(threadId);
    });
    expect(await refused(release(x.f))).toMatch(/changed while checking BB; nothing was recorded/);
    expect(x.f.store.assignment(x.project.id, 1)!.scopeRelease).toBeNull();
  });

  it("describe scope-release is a strict-parser-valid example", async () => {
    const { f } = await projectFixture();
    const example = JSON.parse((await f.harness.runCli(["describe", "scope-release"], { threadId: "coordinator" })).stdout!);
    expect(parseCommandInput(example)).toMatchObject({ action: "assignment-scope-release" });
  });
});

describe("T91 A203 P3: an orphan rejection says the listed jobs may still run and keep the scope", () => {
  it("records it, and a retry on the same paths waits for a release", async () => {
    const x = await reportedWriter({ extra: bg });
    await x.f.archive({ threadId: x.threadId });
    x.f.runtime.onThreadArchived(x.f.threads.get(x.threadId)!);
    await x.f.service.rejectReport(x.project.id, "A1", "Retry.");
    expect(x.f.store.assignment(x.project.id, 1)!.stopReason).toMatch(/may still be running and keep A1's write scope/);
    expect(await refused(freshWrite(x.f, x.project.id, x.t2.ref))).toMatch(/A1 \(W1\)'s report lists background work/);
  });
});

describe("T91 A205 F1: cancelled and failed writes keep their scope while running or listing work", () => {
  it("PA: a stopped writer's late report listing a nohup job holds after its thread is quiet and its op settled", async () => {
    const { f, project } = await projectFixture();
    const t1 = taskAt(f, project.id, "Writer one", ["src"]);
    const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [t1.ref] });
    setThread(f, d.threadId!, { status: "active" });
    await f.service.stopAssignment(project.id, "A1", "Replaced.");
    await f.service.report(d.threadId!, { ...report(), ...bg } as never);
    f.idle(d.threadId!);
    await f.runtime.sweep();
    expect(f.store.assignment(project.id, 1)).toMatchObject({ state: "cancelled", opState: "done", report: { pendingBackgroundWork: bg.pendingBackgroundWork } });
    const t2 = taskAt(f, project.id, "Writer two", ["src/lib"]);
    expect(await refused(freshWrite(f, project.id, t2.ref))).toMatch(/A1 \(W1\)'s report lists background work/);
    // The cancellation, its settlement and the late report stay as they were.
    expect(f.store.assignment(project.id, 1)).toMatchObject({ state: "cancelled", opState: "done", stopReason: "Stopped: Replaced." });
  });

  it("a failed continuation's scope holds while the worker's thread runs, and not once it is quiet", async () => {
    const x = await reportedWriter();
    x.f.store.db.prepare("UPDATE assignments SET write_scope = ? WHERE num = 1").run(JSON.stringify(["docs"]));
    x.f.send.mockImplementationOnce(async () => { throw Object.assign(new Error("refused"), { status: 400 }); });
    await refused(x.f.service.delegate(x.project.id, { route: "continue", worker: "W1", tasks: [taskAt(x.f, x.project.id, "Retry src", ["src"]).ref] }));
    expect(x.f.store.assignment(x.project.id, 2)).toMatchObject({ state: "failed", opState: "failed", writeScope: ["src"] });
    setThread(x.f, x.threadId, { status: "active" });
    expect(await refused(freshWrite(x.f, x.project.id, x.t2.ref))).toMatch(/A2 \(W1\) is failed, but its thread is still running/);
    x.f.idle(x.threadId);
    await freshWrite(x.f, x.project.id, x.t2.ref);
  });

  it("control: a cancelled writer with a quiet thread and no listed work holds nothing", async () => {
    const { f, project } = await projectFixture();
    const t1 = taskAt(f, project.id, "Writer one", ["src"]);
    const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [t1.ref] });
    setThread(f, d.threadId!, { status: "active" });
    await f.service.stopAssignment(project.id, "A1", "Replaced.");
    f.idle(d.threadId!);
    await f.runtime.sweep();
    expect(f.store.assignment(project.id, 1)).toMatchObject({ state: "cancelled", opState: "done" });
    await freshWrite(f, project.id, taskAt(f, project.id, "Writer two", ["src/lib"]).ref);
  });
});

describe("T91 A205 F2: release evidence reads the thread's own project listing", () => {
  const releaseNow = async (f: Fx) => f.harness.callAgentTool("initiative_task", { action: "assignment-scope-release", assignment: "A1", reportVersion: await versionOf(f, "A1"), reason: "Checked: the job is gone." }, { threadId: "coordinator" });
  /** Lists like a large host: the unfiltered list never reaches this project, the project-filtered one does. */
  const outsideGlobalBudget = (f: Fx, row: (args: any) => any[]) =>
    f.harness.sdk.stub("threads.list", async (args: any) => args.parentThreadId ? [] : args.projectId ? row(args) : []);

  it("PB: a quiet thread outside the global 1000-row scan but in its project listing can be released", async () => {
    const x = await reportedWriter({ extra: bg });
    outsideGlobalBudget(x.f, () => [{ ...x.f.threads.get(x.threadId), queuedWork: "none", hasPendingInteraction: false, activity: quiet }]);
    const released = JSON.parse(await releaseNow(x.f) as string);
    expect(released.scopeRelease.evidence).toMatch(/quiet/);
  });

  it("a thread missing from its project listing stays unknown: refused, nothing written, no retire advice", async () => {
    const x = await reportedWriter({ extra: bg });
    outsideGlobalBudget(x.f, () => []);
    const before = ledger(x.f, x.project.id);
    const message = await refused(releaseNow(x.f));
    expect(message).toMatch(/BB's thread state could not be read/);
    expect(message).not.toMatch(/retire/i);
    expect(ledger(x.f, x.project.id)).toBe(before);
  });

  it("an archived thread is positive end evidence, and the evidence names it", async () => {
    const x = await reportedWriter({ extra: bg });
    setThread(x.f, x.threadId, { archivedAt: 5 });
    const released = JSON.parse(await releaseNow(x.f) as string);
    expect(released.scopeRelease.evidence).toMatch(/archived/);
  });
});

describe("T91 A205 F3: a release binds the report version the caller inspected", () => {
  const releaseWith = (f: Fx, input: object) => f.harness.callAgentTool("initiative_task", { action: "assignment-scope-release", assignment: "A1", reason: "Checked: the job is gone.", ...input }, { threadId: "coordinator" });

  it("reads and the hold refusal expose the exact version to echo", async () => {
    const x = await reportedWriter({ extra: bg });
    const version = await versionOf(x.f, "A1");
    expect(version).toMatch(/^[0-9a-f]{16}$/);
    expect(await refused(freshWrite(x.f, x.project.id, x.t2.ref))).toContain(`"reportVersion":"${version}"`);
  });

  it("a missing or malformed version is refused with how to get it; nothing is written", async () => {
    const x = await reportedWriter({ extra: bg });
    const before = ledger(x.f, x.project.id);
    expect(await refused(releaseWith(x.f, {}))).toMatch(/reportVersion.*initiative_read/);
    expect(await refused(releaseWith(x.f, { reportVersion: "latest" }))).toMatch(/reportVersion.*16 hex/);
    expect(ledger(x.f, x.project.id)).toBe(before);
  });

  it("a report filed after the caller read it is not released; the hold stays", async () => {
    const x = await reportedWriter({ extra: bg });
    const inspected = await versionOf(x.f, "A1");
    await x.f.service.report(x.threadId, { ...report(), pendingBackgroundWork: ["nohup npm run seed &"] } as never);
    x.f.idle(x.threadId);
    const current = await versionOf(x.f, "A1");
    expect(current).not.toBe(inspected);
    const before = ledger(x.f, x.project.id);
    const message = await refused(releaseWith(x.f, { reportVersion: inspected }));
    expect(message).toMatch(/A1's report changed since you read it/);
    expect(message).toContain(current);
    expect(ledger(x.f, x.project.id)).toBe(before);
    expect(await refused(freshWrite(x.f, x.project.id, x.t2.ref))).toMatch(/A1 \(W1\)'s report lists background work/);
  });
});

describe("T91 A205 F2 controls: the shared end-evidence helper keeps D342 and cancelled-settle semantics", () => {
  // Project-filtered listings get the controlled row; the unfiltered global scan misses it (a
  // large host); other listings (children, plugin-origin lookups) behave as usual.
  const listing = (f: Fx, threadId: string, rowPresent: () => boolean) =>
    f.intercept((path, args, call) => {
      if (path !== "threads.list") return call();
      if (args?.projectId) return Promise.resolve(rowPresent() ? [{ ...f.threads.get(threadId), queuedWork: "none", hasPendingInteraction: false, activity: quiet }] : []);
      if (!args?.parentThreadId && !args?.originPluginId) return Promise.resolve([]);
      return call();
    });

  it("D342 orphan reject: a retired worker's quiet project row allows it; a missing row refuses with no write", async () => {
    for (const present of [true, false]) {
      const x = await reportedWriter({ extra: bg });
      x.f.store.updateWorker(x.project.id, 1, { state: "retired" });
      listing(x.f, x.threadId, () => present);
      const before = ledger(x.f, x.project.id);
      const result = await x.f.service.rejectReport(x.project.id, "A1", "Retry.").then(() => "ok", (e: Error) => e.message);
      if (present) expect(x.f.store.assignment(x.project.id, 1)!.state).toBe("rejected");
      else {
        expect(result).toMatch(/W1 is retired, but its thread is not confirmed ended \(BB's thread state could not be read\)/);
        expect(ledger(x.f, x.project.id)).toBe(before);
      }
    }
  });

  it("cancelled settle: a quiet project row settles the op; a missing row keeps it uncertain", async () => {
    for (const present of [true, false]) {
      const { f, project } = await projectFixture();
      const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [taskAt(f, project.id, "W", ["src"]).ref] });
      setThread(f, d.threadId!, { status: "active" });
      await f.service.stopAssignment(project.id, "A1", "stop");
      f.idle(d.threadId!);
      listing(f, d.threadId!, () => present);
      await f.runtime.sweep();
      expect(f.store.assignment(project.id, 1)!.opState, String(present)).toBe(present ? "done" : "uncertain");
    }
  });
});

describe("T91 A207 R2: a release binds one report filing, not just its content", () => {
  const releaseAs = (f: Fx, reportVersion: string) =>
    f.harness.callAgentTool("initiative_task", { action: "assignment-scope-release", assignment: "A1", reportVersion, reason: "Checked: the migrate job is gone." }, { threadId: "coordinator" });
  /** A207 Q2: report → quiet → release → relaunch → identical report → quiet. */
  async function relaunched() {
    const x = await reportedWriter({ extra: bg });
    const first = await versionOf(x.f, "A1");
    await releaseAs(x.f, first);
    await freshWrite(x.f, x.project.id, taskAt(x.f, x.project.id, "Probe", ["src/probe"]).ref, { access: "read-only" });
    setThread(x.f, x.threadId, { status: "active" });
    await x.f.service.report(x.threadId, { ...report(), ...bg } as never);
    x.f.idle(x.threadId);
    return { ...x, first };
  }

  it("Q2: an identical re-filed report is a new filing: the old version is refused before any native read, the overlap holds, and a newly read version can be released", async () => {
    const x = await relaunched();
    const second = await versionOf(x.f, "A1");
    expect(second).not.toBe(x.first);
    expect(await refused(freshWrite(x.f, x.project.id, x.t2.ref))).toMatch(new RegExp(`A1 \\(W1\\)'s report lists background work .*"reportVersion":"${second}"`));
    const gets: string[] = [];
    x.f.intercept((path, args, call) => { if (path === "threads.get") gets.push(args.threadId); return call(); });
    const before = ledger(x.f, x.project.id);
    expect(await refused(releaseAs(x.f, x.first))).toMatch(/A1's report changed since you read it/);
    expect(gets).not.toContain(x.threadId);
    expect(ledger(x.f, x.project.id)).toBe(before);
    x.f.intercept();
    // The earlier release stays recorded as history but never covers the new filing.
    expect(x.f.store.assignment(x.project.id, 1)!.scopeRelease!.reportVersion).toBe(x.first);
    expect(await refused(freshWrite(x.f, x.project.id, x.t2.ref))).toMatch(/A1 \(W1\)'s report lists background work/);
    await releaseAs(x.f, second);
    await freshWrite(x.f, x.project.id, x.t2.ref, { access: "read-only" });
    // A third identical filing is held again: no earlier release ever revalidates.
    await x.f.service.report(x.threadId, { ...report(), ...bg } as never);
    const third = await versionOf(x.f, "A1");
    expect([x.first, second]).not.toContain(third);
    expect(await refused(freshWrite(x.f, x.project.id, taskAt(x.f, x.project.id, "Writer three", ["src/lib"]).ref))).toMatch(/A1 \(W1\)'s report lists background work/);
    expect(await refused(releaseAs(x.f, second))).toMatch(/A1's report changed since you read it/);
  });

  it("a late report on stopped work counts as a filing without reviving it; a refused report changes nothing", async () => {
    const { f, project } = await projectFixture();
    const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [taskAt(f, project.id, "W", ["src"]).ref] });
    setThread(f, d.threadId!, { status: "active" });
    await f.service.stopAssignment(project.id, "A1", "Replaced.");
    await f.service.report(d.threadId!, { ...report(), ...bg } as never);
    const late = f.store.assignment(project.id, 1)!;
    await f.service.report(d.threadId!, { ...report(), ...bg } as never);
    const again = f.store.assignment(project.id, 1)!;
    expect(again).toMatchObject({ state: "cancelled", stopReason: late.stopReason, reportedAt: late.reportedAt, reportSeq: late.reportSeq + 1 });
    expect(await versionOf(f, "A1")).toMatch(/^[0-9a-f]{16}$/);
    // Accepted work refuses a report: no filing, no write.
    const x = await reportedWriter();
    await x.f.service.acceptTask(x.project.id, x.t1.ref, {});
    const before = ledger(x.f, x.project.id);
    expect(await refused(x.f.service.report(x.threadId, report() as never))).toMatch(/already accepted/);
    expect(ledger(x.f, x.project.id)).toBe(before);
  });

  it("legacy reports start at filing 0, and a release in the content-only format never matches", async () => {
    const x = await reportedWriter({ extra: bg });
    x.f.store.db.prepare("UPDATE assignments SET report_seq = 0 WHERE num = 1").run();
    const a1 = x.f.store.assignment(x.project.id, 1)!;
    const contentOnly = createHash("sha256").update(JSON.stringify(a1.report)).digest("hex").slice(0, 16);
    x.f.store.updateAssignment(x.project.id, 1, { scopeRelease: { by: "user", recordedBy: null, reason: "old", at: 1, reportVersion: contentOnly, evidence: "old" } });
    expect(await versionOf(x.f, "A1")).not.toBe(contentOnly);
    expect(await refused(freshWrite(x.f, x.project.id, x.t2.ref))).toMatch(/A1 \(W1\)'s report lists background work/);
  });

  it("does not depend on the clock: a frozen reportedAt still yields a new version", async () => {
    const x = await reportedWriter({ extra: bg });
    const frozen = x.f.store.assignment(x.project.id, 1)!.reportedAt;
    x.f.store.now = () => frozen!;
    const first = await versionOf(x.f, "A1");
    await x.f.service.report(x.threadId, { ...report(), ...bg } as never);
    expect(x.f.store.assignment(x.project.id, 1)!.reportedAt).toBe(frozen);
    expect(await versionOf(x.f, "A1")).not.toBe(first);
  });

  it("the filing sequence survives a reload from storage", async () => {
    const x = await relaunched();
    const reloaded = new (x.f.store.constructor as any)(x.f.store.db);
    const a1 = reloaded.assignment(x.project.id, 1);
    expect(a1.reportSeq).toBe(x.f.store.assignment(x.project.id, 1)!.reportSeq);
    expect(a1.reportSeq).toBeGreaterThan(1);
    expect(await versionOf(x.f, "A1")).not.toBe(x.first);
  });

  it("an identical re-file during the release's native read is caught; nothing is recorded", async () => {
    const x = await reportedWriter({ extra: bg });
    const inspected = await versionOf(x.f, "A1");
    let fired = false;
    x.f.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => {
      if (!fired) { fired = true; await x.f.service.report(x.threadId, { ...report(), ...bg } as never); }
      return x.f.threads.get(threadId);
    });
    expect(await refused(releaseAs(x.f, inspected))).toMatch(/changed while checking BB; nothing was recorded/);
    expect(fired).toBe(true);
    expect(x.f.store.assignment(x.project.id, 1)!.scopeRelease).toBeNull();
  });
});

describe("T91 A207 R1: the idle-event cancelled settle reads the thread's own project row", () => {
  /** A stopped writer whose thread just went idle, on a host where the global list misses it. */
  async function stoppedIdle(row: (base: any) => any | null, event: "idle" | "failed" = "idle") {
    const { f, project } = await projectFixture();
    const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [taskAt(f, project.id, "W", ["src"]).ref] });
    setThread(f, d.threadId!, { status: "active" });
    await f.service.stopAssignment(project.id, "A1", "stop");
    const idle = f.idle(d.threadId!);
    f.intercept((path, args, call) => {
      if (path !== "threads.list") return call();
      if (args?.projectId) { const r = row({ ...f.threads.get(d.threadId!), queuedWork: "none", hasPendingInteraction: false, activity: quiet }); return Promise.resolve(r ? [r] : []); }
      if (!args?.parentThreadId && !args?.originPluginId) return Promise.resolve([]);
      return call();
    });
    if (event === "idle") await f.runtime.onThreadIdle(idle);
    else await f.runtime.onThreadFailed(idle, "turn failed");
    return f.store.assignment(project.id, 1)!;
  }

  it("Q1: a quiet project row settles the cancelled op on the idle event itself", async () => {
    expect(await stoppedIdle(r => r)).toMatchObject({ state: "cancelled", opState: "done" });
  });
  it("Q1: the failed event settles from the same project row", async () => {
    expect(await stoppedIdle(r => r, "failed")).toMatchObject({ state: "cancelled", opState: "done" });
    expect((await stoppedIdle(() => null, "failed")).opState).toBe("uncertain");
  });
  it("controls: a missing row, a background command or queued input keep it uncertain", async () => {
    expect((await stoppedIdle(() => null)).opState).toBe("uncertain");
    expect((await stoppedIdle(r => ({ ...r, activity: { ...quiet, activeBackgroundCommandCount: 1 } }))).opState).toBe("uncertain");
    expect((await stoppedIdle(r => ({ ...r, queuedWork: "waiting" }))).opState).toBe("uncertain");
  });
});

describe("T91 A207 R3: a listed hold names only its lead report's jobs", () => {
  it("Q3: A1 lists migrate and A2 lists seed; each message attributes only its own jobs and version", async () => {
    const x = await reportedWriter({ extra: bg });
    const docs = taskAt(x.f, x.project.id, "Docs", ["docs"]);
    await x.f.service.delegate(x.project.id, { route: "continue", worker: "W1", tasks: [docs.ref] });
    x.f.store.db.prepare("UPDATE assignments SET write_scope = ? WHERE num = 2").run(JSON.stringify(["src"]));
    await x.f.service.report(x.threadId, { ...report(), assignment: "A2", pendingBackgroundWork: ["nohup npm run seed &"] } as never);
    x.f.idle(x.threadId);
    const first = await refused(freshWrite(x.f, x.project.id, x.t2.ref));
    expect(first).toMatch(/A1 \(W1\)'s report lists background work \(nohup npm run migrate &\)/);
    expect(first).not.toMatch(/A1 \(W1\)'s report lists background work \([^)]*seed/);
    expect(first).toMatch(/A2 on the same thread also lists unverified work/);
    await x.f.harness.callAgentTool("initiative_task", { action: "assignment-scope-release", assignment: "A1", reportVersion: await versionOf(x.f, "A1"), reason: "Checked." }, { threadId: "coordinator" });
    const second = await refused(freshWrite(x.f, x.project.id, x.t2.ref));
    expect(second).toMatch(new RegExp(`A2 \\(W1\\)'s report lists background work \\(nohup npm run seed &\\).*"reportVersion":"${await versionOf(x.f, "A2")}"`));
  });
});
