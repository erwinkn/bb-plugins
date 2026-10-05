import { describe, expect, it } from "vitest";
import { projectFixture, report } from "./fake-native";
import { brief } from "./helpers";
import { reportVersion } from "../lib/write-holds";
import { DEFAULT_COORDINATOR_INSTRUCTIONS, DEFAULT_WORKER_INSTRUCTIONS, HANDOFF_GUIDANCE_UPGRADES, upgradeDecisionGuidance } from "../lib/guidance";
import { MAX_GUIDANCE_CHARACTERS } from "../lib/settings";

// A225: the three A223 review follow-ups on T96, with W141's probes P1-P5 ported.
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const tool = (f: Fx, name: string, input: unknown, threadId = "coordinator") => f.harness.callAgentTool(name, input, { threadId });
const refused = (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);
const page = async (f: Fx, path: string) => (await (await f.harness.fetchHttp("GET", path)).json()) as any;
const ledger = (f: Fx, projectId: string) =>
  JSON.stringify([f.store.assignments(projectId), f.store.tasks(projectId), f.store.workers(projectId)]);

/** W1/A1 reports T1 (not accepted), optionally after recording a decision. */
async function reported(decision?: string) {
  const { f, project } = await projectFixture();
  const t1 = f.task(project.id, "Search");
  const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [t1.ref], label: "Search", area: "search" });
  if (decision) await tool(f, "initiative_decision", { action: "decision", madeBy: "agent", description: decision }, d.threadId!);
  await f.service.report(d.threadId!, report() as never);
  f.idle(d.threadId!);
  return { f, project, t1, threadId: d.threadId! };
}

describe("F1: every record page carries a token of the full rendered text", () => {
  it("P1: a decision cleanup changes the handoff token while updatedAt and reportVersion stay equal", async () => {
    const { f, project } = await reported("Index archived rows lazily ".repeat(5));
    const url = (offset: number) => `/context/v1/record?initiativeId=${project.id}&ref=A1&part=handoff&offset=${offset}&limit=100`;
    const first = await page(f, url(0));
    const second = await page(f, url(100));
    expect(first.textVersion).toMatch(/^[0-9a-f]{16}$/);
    expect(second.textVersion).toBe(first.textVersion);
    await tool(f, "initiative_decision", { action: "cleanup", ref: "D1", operation: "remove", reason: "Erwin requested removing it." });
    const after = await page(f, url(100));
    expect(after.updatedAt).toBe(first.updatedAt);
    expect(after.reportVersion).toBe(first.reportVersion);
    expect(after.totalChars).not.toBe(first.totalChars);
    expect(after.textVersion).not.toBe(first.textVersion);
    // An unchanged text keeps its token on later reads.
    expect((await page(f, url(0))).textVersion).toBe(after.textVersion);
  });

  it("task status and worker label changes also change the handoff token; every part carries one", async () => {
    const { f, project, t1 } = await reported();
    const url = `/context/v1/record?initiativeId=${project.id}&ref=A1&part=handoff`;
    const before = await page(f, url);
    const a1 = f.store.assignment(project.id, 1)!;
    f.store.updateTask(project.id, t1.num, { status: "blocked" });
    const status = await page(f, url);
    f.store.updateWorker(project.id, 1, { label: "Search renamed" });
    const label = await page(f, url);
    expect(f.store.assignment(project.id, 1)!.updatedAt).toBe(a1.updatedAt);
    expect(new Set([before.textVersion, status.textVersion, label.textVersion]).size).toBe(3);
    expect([status.reportVersion, label.reportVersion]).toEqual([reportVersion(a1), reportVersion(a1)]);
    for (const part of [`ref=A1&part=brief`, `ref=T1&part=brief`]) {
      const r = await page(f, `/context/v1/record?initiativeId=${project.id}&${part}`);
      expect(r.textVersion, part).toMatch(/^[0-9a-f]{16}$/);
      expect((await page(f, `/context/v1/record?initiativeId=${project.id}&${part}&offset=10&limit=5`)).textVersion, part).toBe(r.textVersion);
    }
  });
});

describe("F2: saved guidance reaches one stable result within a load", () => {
  const growOld = "One native spawn starts real work; no Ready-only bootstrap or raw-spawn/adopt/rebrief ritual.";
  const growNew = "One native spawn starts real work; raw starts can bypass worker identity, assignment and guidance. No Ready-only bootstrap or adopt/rebrief ritual.";
  /** P2: an earlier growing rewrite does not fit until a later shrinking one has applied. */
  const nearLimit = () => {
    const [shrinkOld] = HANDOFF_GUIDANCE_UPGRADES.coordinator.find(([old]) => old.startsWith("Keep a bounded checkpoint"))!;
    const core = `${growOld}\n${shrinkOld}\n`;
    return core + "x".repeat(MAX_GUIDANCE_CHARACTERS - (growNew.length - growOld.length) + 1 - core.length);
  };

  it("P2: the growing clause applies once a shorter rewrite makes room, and a replay is byte-identical", () => {
    const text = nearLimit();
    expect(text.length).toBeLessThanOrEqual(MAX_GUIDANCE_CHARACTERS);
    const once = upgradeDecisionGuidance(text, "coordinator", MAX_GUIDANCE_CHARACTERS);
    expect(once).toContain(growNew);
    expect(once).not.toContain(growOld);
    expect(once.length).toBeLessThanOrEqual(MAX_GUIDANCE_CHARACTERS);
    expect(upgradeDecisionGuidance(once, "coordinator", MAX_GUIDANCE_CHARACTERS)).toBe(once);
    expect(once.endsWith("x".repeat(100))).toBe(true);
  });

  it("P2 at load: persisted Settings equal the runtime value on the first load, without wakes", async () => {
    const text = nearLimit();
    const { f } = await projectFixture({ coordinatorInstructions: text });
    await f.preferences.ready;
    const saved = (await f.preferences.handle.get()).coordinatorInstructions;
    expect(saved).toBe(upgradeDecisionGuidance(text, "coordinator", MAX_GUIDANCE_CHARACTERS));
    expect(f.preferences.configuration().coordinatorInstructions).toBe(saved);
    expect((await f.preferences.read()).coordinatorInstructions).toBe(saved);
    expect([f.spawn, f.send, f.stop].map(m => m.mock.calls.length)).toEqual([0, 0, 0]);
  });

  it("defaults, custom text and texts with no room stay stable", () => {
    for (const [role, text] of [["coordinator", DEFAULT_COORDINATOR_INSTRUCTIONS], ["worker", DEFAULT_WORKER_INSTRUCTIONS]] as const)
      expect(upgradeDecisionGuidance(text, role, MAX_GUIDANCE_CHARACTERS)).toBe(text);
    const custom = "Our own process only.";
    expect(upgradeDecisionGuidance(custom, "coordinator", MAX_GUIDANCE_CHARACTERS)).toBe(custom);
    // No shorter rewrite available: the growing clause stays in its shipped wording on every replay.
    const stuck = `${growOld}\n`.padEnd(MAX_GUIDANCE_CHARACTERS, "x");
    expect(upgradeDecisionGuidance(stuck, "coordinator", MAX_GUIDANCE_CHARACTERS)).toBe(stuck);
    for (const [old, next] of [...HANDOFF_GUIDANCE_UPGRADES.coordinator, ...HANDOFF_GUIDANCE_UPGRADES.worker]) expect(next).not.toContain(old);
  });
});

describe("F3: the relation hint leads with contextRefs or the same task", () => {
  const retryHint = `To retry T1 itself instead, first reject A1's report with initiative_task {"action":"assignment-reject","assignment":"A1","reason":"…"}, then delegate T1 with this handoff.`;

  it("following the hint literally on a reported, unfinished source lets fresh work start with its handoff", async () => {
    const { f, project, t1 } = await reported();
    const t2 = f.service.createTask(project.id, { title: "Fix", summary: "Fix.", brief: brief("proj_a", ["fix"]) }, "coordinator");
    const hint = await refused(f.service.delegate(project.id, { route: "fresh", tasks: [t2.ref], label: "Fix", area: "fix", handoffs: ["A1"] }));
    expect(hint).toBe(`handoffs: A1 covers T1, which ${t2.ref} does not name. If the handoff belongs to this work, add "T1" or "A1" to the contextRefs of ${t2.ref}'s brief (initiative_task task-update). ${retryHint}`);
    expect(hint).not.toMatch(/dependsOn|or delegate T1 itself/);
    const a1 = f.store.assignment(project.id, 1)!;
    const task1 = f.store.task(project.id, t1.num)!;
    await tool(f, "initiative_task", { action: "task-update", task: t2.ref, brief: { ...brief("proj_a", ["fix"]), contextRefs: ["T1"] } });
    const [r] = await f.service.delegate(project.id, { route: "fresh", tasks: [t2.ref], label: "Fix", area: "fix", handoffs: ["A1"] });
    expect(f.store.assignment(project.id, Number(r!.assignment.slice(1)))!.handoffSources).toEqual([expect.objectContaining({ assignment: "A1", state: "reported" })]);
    expect(f.store.assignment(project.id, 1)).toEqual(a1);
    expect(f.store.task(project.id, t1.num)).toEqual(task1);
  });

  it("a reported source's retry route works only through the rejection the hint names", async () => {
    const { f, project, t1 } = await reported();
    // Without the rejection, the same task is still owned by A1's report.
    expect(await refused(f.service.delegate(project.id, { route: "fresh", tasks: [t1.ref], label: "Redo", area: "search", handoffs: ["A1"] }))).toMatch(/T1 already has A1 \(reported succeeded\)/);
    await tool(f, "initiative_task", { action: "assignment-reject", assignment: "A1", reason: "Redo with the new schema." });
    const a1 = f.store.assignment(project.id, 1)!;
    expect(a1.report).not.toBeNull();
    const [r] = await f.service.delegate(project.id, { route: "fresh", tasks: [t1.ref], label: "Redo", area: "search", handoffs: ["A1"] });
    expect(f.store.assignment(project.id, Number(r!.assignment.slice(1)))!.handoffSources![0]).toMatchObject({ assignment: "A1", state: "rejected" });
    expect(f.store.assignment(project.id, 1)).toEqual(a1);
  });

  it("a rejected source offers its own task directly, and that route works", async () => {
    const { f, project, t1 } = await reported();
    await f.service.rejectReport(project.id, "A1", "Redo with the new schema.");
    const t2 = f.service.createTask(project.id, { title: "Fix", summary: "Fix.", brief: brief("proj_a", ["fix"]) }, "coordinator");
    const hint = await refused(f.service.delegate(project.id, { route: "fresh", tasks: [t2.ref], label: "Fix", area: "fix", handoffs: ["A1"] }));
    expect(hint).toBe(`handoffs: A1 covers T1, which ${t2.ref} does not name. If the handoff belongs to this work, add "T1" or "A1" to the contextRefs of ${t2.ref}'s brief (initiative_task task-update), or delegate T1 itself with this handoff.`);
    const a1 = f.store.assignment(project.id, 1)!;
    const [r] = await f.service.delegate(project.id, { route: "fresh", tasks: [t1.ref], label: "Redo", area: "search", handoffs: ["A1"] });
    expect(r!.assignment).toBe("A2");
    expect(f.store.assignment(project.id, 2)!.handoffSources![0]).toMatchObject({ assignment: "A1", state: "rejected" });
    expect(f.store.assignment(project.id, 1)).toEqual(a1);
  });

  it("a done source also offers dependsOn, without the impossible same-task route", async () => {
    const { f, project, t1 } = await reported();
    await f.service.acceptTask(project.id, t1.ref, {});
    const t2 = f.service.createTask(project.id, { title: "Next", summary: "Next.", brief: brief("proj_a", ["next"]) }, "coordinator");
    const hint = await refused(f.service.delegate(project.id, { route: "fresh", tasks: [t2.ref], label: "N", area: "n", handoffs: ["A1"] }));
    expect(hint).toBe(`handoffs: A1 covers T1, which ${t2.ref} does not name. If the handoff belongs to this work, add "T1" or "A1" to the contextRefs of ${t2.ref}'s brief (initiative_task task-update). T1 is done, so adding it to dependsOn also works.`);
    const task1 = f.store.task(project.id, t1.num)!;
    await tool(f, "initiative_task", { action: "task-update", task: t2.ref, dependsOn: [t1.ref] });
    const [r] = await f.service.delegate(project.id, { route: "fresh", tasks: [t2.ref], label: "N", area: "n", handoffs: ["A1"] });
    expect(f.store.assignment(project.id, Number(r!.assignment.slice(1)))!.handoffSources![0]).toMatchObject({ assignment: "A1", state: "accepted" });
    expect(f.store.task(project.id, t1.num)).toEqual(task1);
  });

  it("several target tasks agree in number, and one of their briefs is enough", async () => {
    const { f, project } = await reported();
    const t2 = f.service.createTask(project.id, { title: "Fix", summary: "Fix.", brief: brief("proj_a", ["fix"]) }, "coordinator");
    const t3 = f.service.createTask(project.id, { title: "Docs", summary: "Docs.", brief: brief("proj_a", ["docs"]) }, "coordinator");
    const hint = await refused(f.service.delegate(project.id, { route: "fresh", tasks: [t2.ref, t3.ref], label: "Fix", area: "fix", handoffs: ["A1"] }));
    expect(hint).toBe(`handoffs: A1 covers T1, which ${t2.ref} and ${t3.ref} do not name. If the handoff belongs to this work, add "T1" or "A1" to the contextRefs of one of their briefs (initiative_task task-update). ${retryHint}`);
    await tool(f, "initiative_task", { action: "task-update", task: t3.ref, brief: { ...brief("proj_a", ["docs"]), contextRefs: ["A1"] } });
    const [r] = await f.service.delegate(project.id, { route: "fresh", tasks: [t2.ref, t3.ref], label: "Fix", area: "fix", handoffs: ["A1"] });
    expect(f.store.assignment(project.id, Number(r!.assignment.slice(1)))!.handoffSources![0]).toMatchObject({ assignment: "A1", state: "reported" });
  });

  it("P5: a delegation with no tasks is asked for tasks, not for briefs it does not have", async () => {
    const { f, project } = await reported();
    const before = ledger(f, project.id);
    const hint = await refused(f.service.delegate(project.id, { route: "continue", worker: "W1", handoffs: ["A1"], note: "Review fix" } as never));
    expect(hint).toBe(`handoffs: A1 covers T1, but this delegation names no tasks. Pass the tasks this work is for; if the handoff belongs to it, add "T1" or "A1" to the contextRefs of one of their briefs (initiative_task task-update).`);
    expect(ledger(f, project.id)).toBe(before);
    // Following it: a task that names A1 in its brief continues W1 with the handoff.
    const t2 = f.service.createTask(project.id, { title: "Fix", summary: "Fix.", brief: { ...brief("proj_a", ["search"]), contextRefs: ["A1"] } }, "coordinator");
    const [r] = await f.service.delegate(project.id, { route: "continue", worker: "W1", tasks: [t2.ref], handoffs: ["A1"], note: "Review fix" });
    expect(r).toMatchObject({ worker: "W1" });
    expect(f.store.assignment(project.id, Number(r!.assignment.slice(1)))!.handoffSources![0]).toMatchObject({ assignment: "A1", state: "reported" });
  });
});

describe("A223 probes P3 and P4 as regressions", () => {
  it("P3: a source accepted during the native awaits refuses the dispatch", async () => {
    const { f, project, t1 } = await reported();
    const t2 = f.service.createTask(project.id, { title: "Next", summary: "Next.", brief: { ...brief("proj_a", ["next"]), contextRefs: ["T1"] } }, "coordinator");
    let accepted = false;
    f.intercept((path, _args, call) => {
      if (!accepted && path === "projects.get") { accepted = true; return Promise.resolve(f.service.acceptTask(project.id, t1.ref, {})).then(() => call()); }
      return call();
    });
    const message = await refused(f.service.delegate(project.id, { route: "fresh", tasks: [t2.ref], label: "N", area: "n", handoffs: ["A1"] }));
    f.intercept();
    expect(accepted).toBe(true);
    expect(message).toMatch(/A selected handoff's report or state changed during dispatch \(A1 accepted\)/);
    expect(f.store.assignments(project.id)).toHaveLength(1);
  });

  it("P4: a continue may embed a related handoff into the retained context", async () => {
    const { f, project, t1 } = await reported();
    await f.service.acceptTask(project.id, t1.ref, {});
    const t2 = f.service.createTask(project.id, { title: "Fix", summary: "Fix.", brief: brief("proj_a", ["search"]), dependsOn: [t1.ref] }, "coordinator");
    const [r] = await f.service.delegate(project.id, { route: "continue", worker: "W1", tasks: [t2.ref], handoffs: ["A1"] });
    expect(r).toMatchObject({ assignment: "A2", worker: "W1" });
    expect(f.store.assignment(project.id, 2)!.handoffSources![0]).toMatchObject({ assignment: "A1", state: "accepted" });
    expect(f.send.mock.calls.at(-1)![0].input[0].text).toContain("Prior handoff A1 · W1");
  });
});
