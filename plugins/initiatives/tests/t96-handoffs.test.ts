import { describe, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { projectFixture, report } from "./fake-native";
import { brief } from "./helpers";
import { reportVersion } from "../lib/write-holds";

// T96 (D347), simplified by T136: a worker's report is readable as its standard handoff, and
// new work can embed any prior reports (W# or A#) with provenance; reads never change the ledger.
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const tool = (f: Fx, name: string, input: unknown, threadId = "coordinator") => f.harness.callAgentTool(name, input, { threadId });
const refused = (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);
const ledger = (f: Fx, projectId: string) =>
  JSON.stringify([f.store.assignments(projectId), f.store.tasks(projectId), f.store.workers(projectId), f.store.decisions(projectId, { includeHistory: true })]);
const rich = () => ({
  ...report(),
  summary: "Search covers archived records.",
  evidence: [
    { kind: "check", label: "npm test", result: "passed", ref: "/storage/a1/test.txt" },
    { kind: "artifact", label: "Design notes", ref: "/storage/a1/design.md" },
    { kind: "observation", label: "Index is cold on first query" },
  ],
  handoff: {
    summary: "Implemented archived search behind the existing query API.",
    workspaceRevision: "rev-1",
    verificationRevision: "rev-1-verified",
    files: ["src/search.ts", "src/index.ts"],
    openQuestions: ["Should deleted records match?"],
    nextSteps: ["Add ranking"],
    dirtyFiles: ["src/scratch.ts"],
    recoveryArtifacts: ["/storage/a1/backup.tgz"],
    pendingCommands: ["none running"],
  },
});
const sends = (f: Fx) => [f.spawn, f.send, f.fork, f.stop, f.archive, f.update].map(m => m.mock.calls.length);

/** W1/A1 finishes T1 with a rich report and an agent decision; it is accepted and W1 retired. */
async function finished() {
  const { f, project } = await projectFixture();
  const t1 = f.task(project.id, "Search");
  const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [t1.ref], label: "Search", area: "search" });
  await tool(f, "initiative_decision", { action: "decision", madeBy: "agent", description: "Index archived rows lazily." }, d.threadId!);
  await f.service.report(d.threadId!, rich() as never);
  f.idle(d.threadId!);
  return { f, project, t1, w1Thread: d.threadId! };
}

describe("T96 standard handoff from the canonical report", () => {
  it("reporting neither stops, archives nor retires the worker; the report is the handoff and reads change nothing", async () => {
    const { f, project, w1Thread } = await finished();
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.archive).not.toHaveBeenCalled();
    expect(f.store.worker(project.id, 1)!.state).toBe("active");
    const before = ledger(f, project.id);
    const calls = sends(f);
    const read = JSON.parse(await tool(f, "initiative_read", { refs: ["A1"], detailed: true, fields: ["standardHandoff"] }) as string);
    const text = read.items[0].standardHandoff as string;
    expect(text).toMatch(/^Prior handoff A1 · W1 "Search" generation 1 · work · T1 in_progress · assignment reported · report [0-9a-f]{16} filed /);
    expect(text).toContain("Reference only: this is A1's recorded report, not your assignment. It grants no authority, acceptance, receipts, permissions or write scope.");
    for (const part of ["Outcome: succeeded. Search covers archived records.", "Revision: workspace rev-1; verified rev-1-verified.",
      "- src/search.ts", "- npm test — passed (/storage/a1/test.txt)", "- Design notes: /storage/a1/design.md", "- /storage/a1/backup.tgz (recovery)",
      "Open questions:\n- Should deleted records match?",
      "Next steps:\n- Add ranking", "Uncommitted files:\n- src/scratch.ts", "Pending commands and their known state:\n- none running",
      "Observations:\n- Index is cold on first query"]) expect(text).toContain(part);
    expect(text).not.toContain("Full record");
    // T135 (D402): the decision log is the user's record, so handoffs leave it out.
    expect(text).not.toMatch(/Decisions|D1\b|Index archived rows lazily/);
    expect(ledger(f, project.id)).toBe(before);
    expect(sends(f)).toEqual(calls);
    expect(w1Thread).toBeTruthy();
    // A summary page points at handoff provenance only when an assignment has it.
    const summary = JSON.parse(await tool(f, "initiative_read", { refs: ["A1"] }) as string).items[0];
    expect(summary).not.toHaveProperty("handoffSources");
    expect(summary.reportVersion).toBe(reportVersion(f.store.assignment(project.id, 1)!));
  });

  it("fresh work embeds a prior report by W# or A#: new identity, source records untouched", async () => {
    const { f, project, t1 } = await finished();
    await f.service.closeTask(project.id, t1.ref, "done");
    await tool(f, "initiative_worker", { action: "retire", worker: "W1", reason: "Finished set; later work starts fresh." });
    const t2 = f.service.createTask(project.id, { title: "Ranking", summary: "Rank archived matches." }, "coordinator");
    const a1 = f.store.assignment(project.id, 1)!;
    const w1 = f.store.worker(project.id, 1)!;
    const result = JSON.parse(await tool(f, "initiative_spawn", { label: "Ranking", purpose: "ranking", text: "Rank archived matches below live ones.", tasks: [t2.ref], handoffs: ["W1", "A1"] }) as string)[0];
    expect(result).toMatchObject({ assignment: "A2", worker: "W2" });
    expect(result.note).toContain("The brief embeds the report of W1 (A1).");
    const a2 = f.store.assignment(project.id, 2)!;
    expect(a2).toMatchObject({ workerNum: 2, taskNums: [t2.num], route: "fresh", role: "work", report: null });
    expect(a2.handoffSources).toEqual([{ assignment: "A1", worker: "W1", generation: 1, tasks: ["T1"], state: "reported", reportVersion: reportVersion(a1), revision: "rev-1-verified" }]);
    const prompt = f.spawn.mock.calls.at(-1)![0].prompt as string;
    expect(prompt).toBe(a2.briefText);
    expect(prompt).toMatch(/^W2 "Ranking" \(ranking\) · work · T2\n\nT2 Ranking\nRank archived matches\.\n\nRank archived matches below live ones\./);
    expect(prompt).toMatch(/Prior report from W1 "Search" \(A1 · T1, done, \d{4}-\d\d-\d\d \d\d:\d\d UTC\):\nSearch covers archived records\.\n\nImplemented archived search behind the existing query API\./);
    expect(prompt.match(/Prior report from W1/g)).toHaveLength(1);
    expect(prompt).toContain("Finish with your report as your final message.");
    // The source assignment, worker and task stay exactly as they were.
    expect(f.store.assignment(project.id, 1)).toEqual(a1);
    expect(f.store.worker(project.id, 1)).toEqual(w1);
    expect(f.store.task(project.id, t1.num)).toMatchObject({ status: "done", acceptedAssignment: 1 });
    const summary = JSON.parse(await tool(f, "initiative_read", { refs: ["A2"] }) as string).items[0];
    expect(summary.handoffSources).toEqual(["A1"]);
  });

  it("embeds any prior report without coverage rules, and refuses only missing or too many reports", async () => {
    const { f, project } = await finished();
    const unrelated = f.service.createTask(project.id, { title: "Billing", summary: "Unrelated." }, "coordinator");
    const running = f.service.createTask(project.id, { title: "Running", summary: "Other." }, "coordinator");
    await f.service.delegate(project.id, { route: "fresh", tasks: [running.ref], label: "Other", area: "other" });
    const before = ledger(f, project.id);
    const calls = sends(f);
    const cases: [unknown, RegExp][] = [
      [{ handoffs: ["A2"] }, /A2 \(running\) has no report yet/],
      [{ handoffs: ["W2"] }, /W2 has no report yet/],
      [{ handoffs: ["A99"] }, /A99 is not a worker \(W#\) or assignment \(A#\) in this Initiative/],
      [{ handoffs: ["A1", "A2", "A3", "A4"] }, /handoffs/],
    ];
    for (const [input, error] of cases) {
      expect(await refused(tool(f, "initiative_spawn", { label: "X", purpose: "x", text: "Do it.", tasks: [unrelated.ref], ...(input as object) }))).toMatch(error);
      expect(ledger(f, project.id)).toBe(before);
      expect(sends(f)).toEqual(calls);
    }
    const [ok] = JSON.parse(await tool(f, "initiative_spawn", { label: "Billing", purpose: "billing", text: "Do it.", tasks: [unrelated.ref], handoffs: ["A1"] }) as string);
    expect(f.store.assignment(project.id, Number(ok.assignment.slice(1)))!.handoffSources![0]!.assignment).toBe("A1");
  });

  it("a review embeds the reviewed worker's latest report and reads its checkout", async () => {
    const { f, project, t1 } = await finished();
    const [r] = JSON.parse(await tool(f, "initiative_spawn", { role: "review", reviews: "W1", label: "Review search", purpose: "review W1", text: "Check ranking." }) as string);
    const a = f.store.assignment(project.id, Number(r.assignment.slice(1)))!;
    expect(a).toMatchObject({ role: "review", access: "read-only", reviewOf: [t1.num], taskNums: [] });
    expect(a.handoffSources![0]).toMatchObject({ assignment: "A1", worker: "W1" });
    expect(a.briefText).toMatch(/^W2 "Review search" \(review W1\) · review · T1\n\nCheck ranking\.\n\nReview W1 "Search" \(A1 · T1, done, [^)]*\)\. Its report:\nSearch covers archived records\./);
    expect(a.briefText).toContain("This review is read-only: read the code, then give your findings as your final message. Don't fix them.");
    expect(f.spawn.mock.calls.at(-1)![0].environment).toEqual({ type: "reuse", environmentId: f.store.worker(project.id, 1)!.environmentId });
  });

  it("a source report re-filed during the native checks is refused rather than embedding a stale filing", async () => {
    const { f, project, w1Thread } = await finished();
    const t2 = f.service.createTask(project.id, { title: "Ranking", summary: "Rank." }, "coordinator");
    let refiled = false;
    f.intercept((path, _args, call) => {
      if (!refiled && path === "projects.get") {
        refiled = true;
        return Promise.resolve(f.service.report(w1Thread, { ...rich(), summary: "Corrected after new evidence." } as never)).then(() => call());
      }
      return call();
    });
    const message = await refused(f.service.delegate(project.id, { route: "fresh", tasks: [t2.ref], label: "R", area: "r", handoffs: ["A1"] }));
    f.intercept();
    expect(refiled).toBe(true);
    expect(message).toMatch(/An embedded report changed during dispatch \(A1 reported\); read it again before giving out the work/);
    expect(f.store.assignments(project.id)).toHaveLength(1);
    expect(f.spawn).toHaveBeenCalledTimes(1);
  });

  it("clips a long embedded report and points at the full one; the full record keeps everything", async () => {
    const { f, project } = await projectFixture();
    const t1 = f.task(project.id, "Search");
    const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [t1.ref], label: "Search", area: "search" });
    await f.service.report(d.threadId!, { ...report(), finalMessage: "F".repeat(4000) } as never);
    f.idle(d.threadId!);
    const t2 = f.service.createTask(project.id, { title: "Docs", summary: "Docs." }, "coordinator");
    await f.service.delegate(project.id, { route: "fresh", tasks: [t2.ref], label: "Docs", area: "docs", handoffs: ["W1"] });
    const prompt = f.spawn.mock.calls.at(-1)![0].prompt as string;
    expect(prompt).toContain(`${"F".repeat(1500)}… (full report: initiative_read {refs:["A1"]})`);
    expect(prompt).not.toContain("F".repeat(1501));
    const full = JSON.parse(await tool(f, "initiative_read", { refs: ["A1"], detailed: true, fields: ["report"] }) as string).items[0].report;
    expect(full.finalMessage).toBe("F".repeat(4000));
  });

  it("existing worker reuse stays available for an immediate same-scope follow-up", async () => {
    const { f, project, t1 } = await finished();
    await f.service.closeTask(project.id, t1.ref, "done");
    const t2 = f.task(project.id, "Review fix");
    const [r] = await f.service.delegate(project.id, { route: "continue", worker: "W1", tasks: [t2.ref] });
    expect(r).toMatchObject({ assignment: "A2", worker: "W1" });
    expect(f.store.assignment(project.id, 2)!.handoffSources).toBeNull();
  });

  it("retirement keeps its native guards: a busy worker is refused and nothing is archived", async () => {
    const { f, project, w1Thread } = await finished();
    f.threads.set(w1Thread, { ...f.threads.get(w1Thread)!, status: "active" });
    expect(await refused(tool(f, "initiative_worker", { action: "worker-retire", worker: "W1", reason: "Done." }))).not.toBe("");
    expect(f.store.worker(project.id, 1)!.state).toBe("active");
    expect(f.archive).not.toHaveBeenCalled();
  });
});

describe("T96 public context routes", () => {
  const get = async (f: Fx, path: string) => {
    const response = await f.harness.fetchHttp("GET", path);
    return { status: response.status, body: (await response.json()) as any };
  };

  it("registers only token-auth GET routes on exact paths", async () => {
    const { f } = await projectFixture();
    const routes = f.harness.registrations.httpRoutes.map((r: any) => ({ method: r.method, path: r.path, auth: r.auth }));
    expect(routes).toEqual([
      { method: "GET", path: "/context/v1/thread", auth: "token" },
      { method: "GET", path: "/context/v1/record", auth: "token" },
      { method: "GET", path: "/context/v1/initiatives", auth: "token" },
      { method: "GET", path: "/context/v1/members", auth: "token" },
    ]);
  });

  it("reports coordinator, worker phases from canonical records, the undelivered next brief and retirement, without side effects", async () => {
    const { f, project, t1, w1Thread } = await finished();
    const unknown = await get(f, "/context/v1/thread?threadId=thr_standalone");
    expect(unknown).toMatchObject({ status: 200, body: { version: 1, threadId: "thr_standalone", membership: null } });
    expect(typeof unknown.body.observedAt).toBe("number");
    const coordinator = await get(f, "/context/v1/thread?threadId=coordinator");
    expect(coordinator.body.membership).toMatchObject({ initiativeId: project.id, kind: "coordinator", role: "coordinator", state: "active", former: false, generation: 1, currentGeneration: 1, assignment: null, coordinator: { threadId: "coordinator", generation: 1 } });

    const before = ledger(f, project.id);
    const calls = sends(f);
    const reported = await get(f, `/context/v1/thread?threadId=${w1Thread}&token=ignored`);
    expect(ledger(f, project.id)).toBe(before);
    expect(sends(f)).toEqual(calls);
    const a1 = f.store.assignment(project.id, 1)!;
    expect(reported.body.membership).toMatchObject({
      kind: "worker", role: "work", worker: "W1", generation: 1, currentGeneration: 1, state: "active", former: false, retired: false, stopped: false,
      parent: { forkedFrom: null, nativeParent: true }, next: null,
      assignment: { ref: "A1", tasks: ["T1"], phase: "reported", state: "reported", outcome: "succeeded", reportVersion: reportVersion(a1), updatedAt: a1.updatedAt, handoff: true, briefChars: a1.briefText.length },
    });

    // A continuation still queued behind the reported turn is next, not current.
    const t2 = f.task(project.id, "Follow-up");
    f.queueSend("qm1");
    f.threads.set(w1Thread, { ...f.threads.get(w1Thread)!, status: "active" });
    await f.service.delegate(project.id, { route: "continue", worker: "W1", tasks: [t2.ref] });
    const queued = (await get(f, `/context/v1/thread?threadId=${w1Thread}`)).body.membership;
    expect(queued.assignment.ref).toBe("A1");
    expect(queued.next).toMatchObject({ ref: "A2", phase: "pending", state: "queued", handoff: false });

    await f.service.stopAssignment(project.id, "A2", "Not needed.").catch(() => undefined);
    f.idle(w1Thread);
    await f.service.closeTask(project.id, t1.ref, "done");
    // T136: closing the task accepts nothing; the report stays reported.
    expect((await get(f, `/context/v1/thread?threadId=${w1Thread}`)).body.membership.assignment).toMatchObject({ ref: "A1", phase: "reported" });
    f.store.updateWorker(project.id, 1, { userStopped: true });
    expect((await get(f, `/context/v1/thread?threadId=${w1Thread}`)).body.membership).toMatchObject({ state: "stopped", stopped: true });
    f.store.updateWorker(project.id, 1, { userStopped: false, state: "retired" });
    expect((await get(f, `/context/v1/thread?threadId=${w1Thread}`)).body.membership).toMatchObject({ state: "retired", retired: true, former: false });
  });

  it("marks a replaced coordinator former and keeps its own generation", async () => {
    const { f, project } = await projectFixture();
    f.idle("coordinator");
    await f.service.replaceCoordinator(project.id, { reason: "Fresh context" });
    const current = f.store.project(project.id)!;
    expect(current.coordinatorThreadId).not.toBe("coordinator");
    const former = (await get(f, "/context/v1/thread?threadId=coordinator")).body.membership;
    expect(former).toMatchObject({ kind: "coordinator", state: "former", former: true, generation: 1, currentGeneration: current.coordinatorGeneration, coordinator: { threadId: current.coordinatorThreadId } });
  });

  it("pages task and assignment briefs and answers bad, unknown and missing requests honestly", async () => {
    const { f, project, t1 } = await finished();
    const task = await get(f, `/context/v1/record?initiativeId=${project.id}&ref=T1&part=brief`);
    expect(task).toMatchObject({ status: 200, body: { version: 1, ref: "T1", part: "brief", offset: 0, nextOffset: null, reportVersion: null, meta: { status: "in_progress", title: "Search", acceptedAssignment: null } } });
    expect(task.body.text).toContain('T1 "Search"\nObjective: Make the thing work');
    expect(task.body.updatedAt).toBe(f.store.task(project.id, t1.num)!.updatedAt);
    const a1 = f.store.assignment(project.id, 1)!;
    const first = await get(f, `/context/v1/record?initiativeId=${project.id}&ref=A1&part=brief&limit=100`);
    expect(first.body).toMatchObject({ totalChars: a1.briefText.length, offset: 0, nextOffset: 100, text: a1.briefText.slice(0, 100), meta: { phase: "reported", tasks: ["T1"], worker: "W1", generation: 1 } });
    const errors: [string, number, string][] = [
      ["/context/v1/thread", 400, "bad-request"],
      ["/context/v1/thread?threadId=a%20b", 400, "bad-request"],
      [`/context/v1/record?initiativeId=${project.id}&ref=A1&part=brief&limit=16001`, 400, "bad-request"],
      [`/context/v1/record?initiativeId=${project.id}&ref=A1&part=brief&offset=${a1.briefText.length + 1}`, 400, "bad-request"],
      [`/context/v1/record?initiativeId=${project.id}&ref=T1&part=handoff`, 400, "bad-request"],
      [`/context/v1/record?initiativeId=${project.id}&ref=W1&part=brief`, 400, "bad-request"],
      ["/context/v1/record?initiativeId=prj_missing&ref=A1&part=brief", 404, "not-found"],
      [`/context/v1/record?initiativeId=${project.id}&ref=A9&part=brief`, 404, "not-found"],
    ];
    for (const [path, status, code] of errors) {
      const r = await get(f, path);
      expect(r.status, path).toBe(status);
      expect(r.body, path).toMatchObject({ version: 1, error: { code } });
    }
    const t2 = f.task(project.id, "Next");
    await f.service.delegate(project.id, { route: "fresh", tasks: [t2.ref], label: "N", area: "n", environment: { type: "worktree" } });
    expect(await get(f, `/context/v1/record?initiativeId=${project.id}&ref=A2&part=handoff`)).toMatchObject({ status: 404, body: { error: { code: "no-report" } } });
  });

  it("an unreadable stored record is reported as unknown context, not guessed", async () => {
    const { f, project, w1Thread } = await finished();
    f.store.db.prepare("UPDATE assignments SET report = '{broken' WHERE project_id = ? AND num = 1").run(project.id);
    const r = await get(f, `/context/v1/thread?threadId=${w1Thread}`);
    expect(r).toMatchObject({ status: 500, body: { version: 1, error: { code: "store-unreadable" } } });
  });
});
