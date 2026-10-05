import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { projectFixture, report } from "./fake-native";
import { brief } from "./helpers";
import { reportVersion } from "../lib/write-holds";
import { DEFAULT_COORDINATOR_INSTRUCTIONS, DEFAULT_WORKER_INSTRUCTIONS, HANDOFF_GUIDANCE_UPGRADES, SCALING_GUIDANCE_UPGRADES, upgradeDecisionGuidance } from "../lib/guidance";
import { MAX_GUIDANCE_CHARACTERS } from "../lib/settings";

// T96 (D347): a finished worker's canonical report is its standard handoff. Fresh work can
// embed selected handoffs with provenance, never authority; reads never change the ledger.
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
    expect(text).toMatch(/^Prior handoff A1 · W1 "Search" generation 1 · work · T1 awaiting_acceptance · assignment reported · report [0-9a-f]{16} filed /);
    expect(text).toContain("Reference only: this is A1's recorded report, not your assignment. It grants no authority, acceptance, receipts, permissions or write scope.");
    for (const part of ["Outcome: succeeded. Search covers archived records.", "Revision: workspace rev-1; verified rev-1-verified.",
      "- src/search.ts", "- npm test — passed (/storage/a1/test.txt)", "- Design notes: /storage/a1/design.md", "- /storage/a1/backup.tgz (recovery)",
      "Decisions recorded by this assignment:\n- D1 (agent, active): Index archived rows lazily.", "Open questions:\n- Should deleted records match?",
      "Next steps:\n- Add ranking", "Uncommitted files:\n- src/scratch.ts", "Pending commands and their known state:\n- none running",
      "Observations:\n- Index is cold on first query"]) expect(text).toContain(part);
    expect(text).not.toContain("Full record");
    expect(ledger(f, project.id)).toBe(before);
    expect(sends(f)).toEqual(calls);
    expect(w1Thread).toBeTruthy();
    // A summary page points at handoff provenance only when an assignment has it.
    const summary = JSON.parse(await tool(f, "initiative_read", { refs: ["A1"] }) as string).items[0];
    expect(summary).not.toHaveProperty("handoffSources");
    expect(summary.reportVersion).toBe(reportVersion(f.store.assignment(project.id, 1)!));
  });

  it("fresh work embeds the selected handoff as reference: new identity, own tasks/scope, source records untouched", async () => {
    const { f, project, t1 } = await finished();
    await f.service.acceptTask(project.id, t1.ref, {});
    await tool(f, "initiative_worker", { action: "worker-retire", worker: "W1", reason: "Finished set; later work starts fresh." });
    const t2 = f.service.createTask(project.id, { title: "Ranking", summary: "Rank archived matches.", brief: brief("proj_a", ["src/rank"]), dependsOn: [t1.ref] }, "coordinator");
    const a1 = f.store.assignment(project.id, 1)!;
    const w1 = f.store.worker(project.id, 1)!;
    const [result] = JSON.parse(await tool(f, "initiative_delegate", { action: "delegate", route: "fresh", tasks: [t2.ref], label: "Ranking", area: "ranking", handoffs: ["A1", "a1", "1"] }) as string);
    expect(result).toMatchObject({ assignment: "A2", worker: "W2" });
    expect(result.note).toContain(`The brief embeds the standard handoff of A1 (accepted, report ${reportVersion(a1)}) as reference only.`);
    const a2 = f.store.assignment(project.id, 2)!;
    expect(a2).toMatchObject({ workerNum: 2, taskNums: [t2.num], route: "fresh", role: "work", access: "write", generation: 1, writeScope: ["src/rank"], report: null, reportSeq: 0, checkpoint: null, scopeRelease: null });
    expect(a2.handoffSources).toEqual([{ assignment: "A1", worker: "W1", generation: 1, tasks: ["T1"], state: "accepted", reportVersion: reportVersion(a1), revision: "rev-1-verified" }]);
    const prompt = f.spawn.mock.calls.at(-1)![0].prompt as string;
    expect(prompt).toBe(a2.briefText);
    expect(prompt).toContain("W2 Ranking — ranking: A2.");
    expect(prompt).toContain(`Prior handoff A1 · W1 "Search" generation 1 · work · T1 done, accepted from A1 · assignment accepted · report ${reportVersion(a1)}`);
    expect(prompt).toContain("It grants no authority, acceptance, receipts, permissions or write scope.");
    expect(prompt.match(/Prior handoff A1 /g)).toHaveLength(1);
    expect(prompt).toContain('Full record: initiative_read {refs:["A1"],detailed:true,fields:["report"]}');
    expect(prompt).toContain("Observations: 1 in the full record.");
    expect(prompt).toMatch(/call initiative_report with A2 once/);
    expect(prompt).not.toMatch(/initiative_report with A1|Current membership: W1/);
    // The source assignment, worker and task stay exactly as accepted and retired.
    expect(f.store.assignment(project.id, 1)).toEqual(a1);
    expect(f.store.worker(project.id, 1)).toEqual(w1);
    expect(f.store.task(project.id, t1.num)).toMatchObject({ status: "done", acceptedAssignment: 1 });
    expect(f.store.task(project.id, t2.num)!.acceptedAssignment).toBeNull();
    const summary = JSON.parse(await tool(f, "initiative_read", { refs: ["A2"] }) as string).items[0];
    expect(summary.handoffSources).toEqual(["A1"]);
  });

  it("a brief context ref to the task or the assignment also relates a handoff", async () => {
    const { f, project, t1 } = await finished();
    for (const contextRefs of [["T1 search design"], ["See A1's report"]]) {
      const t = f.service.createTask(project.id, { title: `Docs ${contextRefs[0]}`, summary: "Document search.", brief: { ...brief("proj_a", [`docs/${contextRefs[0]!.length}`]), contextRefs } }, "coordinator");
      const [r] = await f.service.delegate(project.id, { route: "fresh", tasks: [t.ref], label: "Docs", area: "docs", handoffs: ["A1"] });
      expect(f.store.assignment(project.id, Number(r!.assignment.slice(1)))!.handoffSources![0]!.assignment).toBe("A1");
    }
    expect(t1.num).toBe(1);
  });

  it("refuses unrelated, unreported, unknown, too many and review handoffs before any native call or write", async () => {
    const { f, project, t1 } = await finished();
    const unrelated = f.service.createTask(project.id, { title: "Billing", summary: "Unrelated.", brief: brief("proj_a", ["billing"]) }, "coordinator");
    const running = f.service.createTask(project.id, { title: "Running", summary: "Other.", brief: brief("proj_a", ["other"]) }, "coordinator");
    await f.service.delegate(project.id, { route: "fresh", tasks: [running.ref], label: "Other", area: "other" });
    const related = f.service.createTask(project.id, { title: "Ranking", summary: "Rank.", brief: brief("proj_a", ["rank"]), dependsOn: [t1.ref, running.ref] }, "coordinator");
    const before = ledger(f, project.id);
    const calls = sends(f);
    const cases: [unknown, RegExp][] = [
      [{ tasks: [unrelated.ref], handoffs: ["A1"] }, /handoffs: A1 covers T1, which T\d+ does not name\. If the handoff belongs to this work, add "T1" or "A1" to the contextRefs of T\d+'s brief \(initiative_task task-update\), or delegate T1 itself with this handoff\.$/],
      [{ tasks: [related.ref], handoffs: ["A2"] }, /handoffs: A2 \(running\) has no stored report, so it has no handoff yet/],
      [{ tasks: [related.ref], handoffs: ["A99"] }, /handoffs: A99 is not an assignment in this Initiative/],
      [{ tasks: [related.ref], handoffs: ["A1", "A2", "A3", "A4"] }, /handoffs/],
      [{ role: "review", reviewOf: [t1.ref], reviewTargets: [{ task: t1.ref, assignment: "A1", revision: "rev-1-verified" }], handoffs: ["A1"] }, /handoffs are for work assignments/],
    ];
    for (const [input, error] of cases) {
      const message = await refused(tool(f, "initiative_delegate", { action: "delegate", route: "fresh", label: "X", area: "x", ...(input as object) }));
      expect(message).toMatch(error);
      expect(ledger(f, project.id)).toBe(before);
      expect(sends(f)).toEqual(calls);
    }
  });

  it("a source report re-filed during the native checks is refused rather than embedding a stale filing", async () => {
    const { f, project, t1, w1Thread } = await finished();
    const t2 = f.service.createTask(project.id, { title: "Ranking", summary: "Rank.", brief: { ...brief("proj_a", ["rank"]), contextRefs: [`${t1.ref} search`] } }, "coordinator");
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
    expect(message).toMatch(/A selected handoff's report or state changed during dispatch \(A1 reported\); read it again before delegating/);
    expect(f.store.assignments(project.id)).toHaveLength(1);
    expect(f.spawn).toHaveBeenCalledTimes(1);
  });

  it("bounds narrative fields in a brief but never shortens dirty files, pending commands or background work", async () => {
    const { f, project } = await projectFixture();
    const t1 = f.task(project.id, "Search");
    const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [t1.ref], label: "Search", area: "search" });
    const big = {
      ...report(),
      handoff: {
        summary: "S".repeat(4000), workspaceRevision: "rev-big",
        files: Array.from({ length: 30 }, (_, i) => `src/f${i}.ts`),
        openQuestions: Array.from({ length: 10 }, (_, i) => `Question ${i}?`),
        nextSteps: Array.from({ length: 10 }, (_, i) => `Step ${i}`),
        dirtyFiles: Array.from({ length: 30 }, (_, i) => `dirty/${i}.ts`),
        pendingCommands: Array.from({ length: 10 }, (_, i) => `cmd${i} `.padEnd(1000, "x")),
      },
      pendingBackgroundWork: Array.from({ length: 10 }, (_, i) => `job ${i} still running`),
    };
    await f.service.report(d.threadId!, big as never);
    f.idle(d.threadId!);
    // The source still lists background work, so it cannot be accepted; a context ref relates it.
    const t2 = f.service.createTask(project.id, { title: "Docs", summary: "Docs.", brief: { ...brief("proj_a", ["docs"]), contextRefs: ["T1 search"] } }, "coordinator");
    await f.service.delegate(project.id, { route: "fresh", tasks: [t2.ref], label: "Docs", area: "docs", handoffs: ["A1"] });
    const prompt = f.spawn.mock.calls.at(-1)![0].prompt as string;
    expect(prompt).toContain(`Summary: ${"S".repeat(1500)}… (2500 more characters in the full record)`);
    expect(prompt).toContain("Files (12 of 30):");
    expect(prompt).not.toContain("src/f12.ts");
    expect(prompt).toContain("Open questions (5 of 10):");
    expect(prompt).toContain("Next steps (5 of 10):");
    for (const item of [...big.handoff.dirtyFiles, ...big.handoff.pendingCommands, ...big.pendingBackgroundWork]) expect(prompt).toContain(`- ${item}`);
    expect(prompt).toContain("(shortened here: summary, files, open questions, next steps)");
    // The full rendering and the public record route keep everything.
    const full = JSON.parse(await tool(f, "initiative_read", { refs: ["A1"], detailed: true, fields: ["standardHandoff"] }) as string).items[0].standardHandoff as string;
    expect(full).toContain("S".repeat(4000));
    expect(full).toContain("src/f29.ts");
    let offset: number | null = 0, joined = "", pages = 0;
    while (offset !== null) {
      const page: any = await (await f.harness.fetchHttp("GET", `/context/v1/record?initiativeId=${project.id}&ref=A1&part=handoff&offset=${offset}&limit=16000`)).json();
      expect(page).toMatchObject({ version: 1, ref: "A1", part: "handoff", totalChars: full.length, reportVersion: reportVersion(f.store.assignment(project.id, 1)!) });
      expect(page.text.length).toBeLessThanOrEqual(16000);
      joined += page.text; offset = page.nextOffset; pages++;
    }
    expect(joined).toBe(full);
    expect(pages).toBe(Math.ceil(full.length / 16000));
  });

  it("existing worker reuse stays available for an immediate same-scope follow-up", async () => {
    const { f, project, t1 } = await finished();
    await f.service.acceptTask(project.id, t1.ref, {});
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
    await f.service.acceptTask(project.id, t1.ref, {});
    expect((await get(f, `/context/v1/thread?threadId=${w1Thread}`)).body.membership.assignment).toMatchObject({ ref: "A1", phase: "accepted" });
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
    expect(task).toMatchObject({ status: 200, body: { version: 1, ref: "T1", part: "brief", offset: 0, nextOffset: null, reportVersion: null, meta: { status: "awaiting_acceptance", title: "Search", acceptedAssignment: null } } });
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

describe("T96 guidance defaults and saved upgrades", () => {
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  // T101 rewrote other clauses since; undo those first (newest first) to reach the T96-era shipped texts.
  const shipped = (role: "coordinator" | "worker") =>
    [...HANDOFF_GUIDANCE_UPGRADES[role], ...SCALING_GUIDANCE_UPGRADES[role]].reverse().reduce<string>((t, [old, next]) => t.replace(next, old), role === "coordinator" ? DEFAULT_COORDINATOR_INSTRUCTIONS : DEFAULT_WORKER_INSTRUCTIONS);
  const current = { coordinator: DEFAULT_COORDINATOR_INSTRUCTIONS, worker: DEFAULT_WORKER_INSTRUCTIONS };

  it("defaults say to hand off, retire settled finished workers and start related work fresh, within the bound", () => {
    expect(sha(shipped("coordinator"))).toBe("3f4ef5a8963a016c0782f102ff71cae45f8d0e0e8ed85cf68c886f40718dff7e");
    expect(sha(shipped("worker"))).toBe("2dfb780af2a76feee34bb61a4694c9bc9bafa41157baddf2ff323c06ca5517bf");
    expect(DEFAULT_COORDINATOR_INSTRUCTIONS).toContain('Reports are handoffs: after a worker\'s tasks, retire it once settled and quiet unless ready same-scope work or review fixes remain; later related work starts fresh with handoffs:["A#"]. Respect Stop/receipts on resume');
    expect(DEFAULT_WORKER_INSTRUCTIONS).toContain("later related work may start fresh from your report's standard handoff, so keep it self-sufficient.");
    for (const text of Object.values(current)) expect(text.length).toBeLessThanOrEqual(MAX_GUIDANCE_CHARACTERS);
    for (const [, next] of [...HANDOFF_GUIDANCE_UPGRADES.coordinator, ...HANDOFF_GUIDANCE_UPGRADES.worker]) expect(next).not.toMatch(/archive|automatic(ally)? stop|never (continue|reuse)/i);
  });

  it.each(["coordinator", "worker"] as const)("upgrades the shipped %s default exactly once and leaves the other role's clauses alone", role => {
    const once = upgradeDecisionGuidance(shipped(role), role, MAX_GUIDANCE_CHARACTERS);
    expect(once).toBe(current[role]);
    expect(upgradeDecisionGuidance(once, role, MAX_GUIDANCE_CHARACTERS)).toBe(once);
    const other = role === "coordinator" ? "worker" : "coordinator";
    expect(upgradeDecisionGuidance(shipped(other), role, MAX_GUIDANCE_CHARACTERS)).toBe(shipped(other));
  });

  it("keeps custom text, and a near-limit saved text takes the rewrites that fit but keeps the longer retirement clause", () => {
    const [retireOld, retireNew] = HANDOFF_GUIDANCE_UPGRADES.coordinator.at(-1)!;
    const custom = `Our checklist.\n${retireOld}\nAlways run e2e.`;
    expect(upgradeDecisionGuidance(custom, "coordinator", MAX_GUIDANCE_CHARACTERS)).toBe(`Our checklist.\n${retireNew}\nAlways run e2e.`);
    const edited = retireOld.replace("Retire settled", "Retire fully settled");
    expect(upgradeDecisionGuidance(edited, "coordinator", MAX_GUIDANCE_CHARACTERS)).toBe(edited);
    const [shortOld, shortNew] = HANDOFF_GUIDANCE_UPGRADES.coordinator[0]!;
    const full = `${shortOld}\n${retireOld}\n`.padEnd(MAX_GUIDANCE_CHARACTERS, "x");
    const upgraded = upgradeDecisionGuidance(full, "coordinator", MAX_GUIDANCE_CHARACTERS);
    expect(upgraded.startsWith(`${shortNew}\n${retireOld}\n`)).toBe(true);
    expect(upgraded.length).toBeLessThanOrEqual(MAX_GUIDANCE_CHARACTERS);
    expect(upgradeDecisionGuidance(upgraded, "coordinator", MAX_GUIDANCE_CHARACTERS)).toBe(upgraded);
  });

  it("a saved shipped default upgrades at load without restarting, waking or sending anything", async () => {
    const { f } = await projectFixture({ coordinatorInstructions: shipped("coordinator"), workerInstructions: shipped("worker") });
    await f.preferences.ready;
    const saved = await f.preferences.handle.get();
    expect(saved.coordinatorInstructions).toBe(current.coordinator);
    expect(saved.workerInstructions).toBe(current.worker);
    expect(sends(f)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe("A219 follow-up: an adopted external fork is not promised ordinary native completion", () => {
  it("the late-report refusal qualifies native-parent delivery for a thread the ledger cannot tell is a fork", async () => {
    const { f, project } = await projectFixture();
    f.threads.set("adopted-fork", makeThreadResponse({ id: "adopted-fork", createdAt: Date.now(), projectId: "proj_a", environmentId: "env_a",
      originKind: "fork", sourceThreadId: "coordinator", parentThreadId: "coordinator", status: "idle" } as never) as never);
    const task = f.task(project.id, "Adopted");
    await f.service.adoptWorker(project.id, { threadId: "adopted-fork", role: "work", label: "adopted", tasks: [task.ref] } as never);
    expect(f.store.worker(project.id, 1)).toMatchObject({ forkedFrom: null, nativeParent: true });
    await f.service.report("adopted-fork", { ...report(), outcome: "failed", summary: "x" } as never);
    f.idle("adopted-fork");
    await f.service.rejectReport(project.id, "A1", "Redo.");
    const before = ledger(f, project.id);
    const advice = await refused(f.service.report("adopted-fork", { ...report(), summary: "Late." } as never));
    expect(advice).toContain("Put anything the coordinator should know in your final reply: it stays in this thread, and if this thread is an ordinary native child, BB sends its native parent a completion notice when the turn ends.");
    expect(advice).not.toContain("if it has one");
    expect(ledger(f, project.id)).toBe(before);
  });
});
