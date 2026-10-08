import { describe, expect, it } from "vitest";
import { projectFixture, report } from "./fake-native";
import { parseCommandInput } from "../lib/commands";
import { COMMAND_EXAMPLES, READ_EXAMPLES } from "../lib/examples";
import { agentReadSchema, MAX_READ_BYTES } from "../lib/read";

describe("T59 selective agent reads", () => {
  it.each([
    ["A25", "T26", ...Array.from({ length: 8 }, (_, i) => `D${109 + i}`)],
    ["A33", "T6", "D102", "D95", "D100", "D101"],
  ])("reproduces the A103 refs-only reviewer call with exact records: %j", async (...refs) => {
    const { f, project } = await projectFixture();
    for (let i = 0; i < 40; i++) {
      const task = f.task(project.id, `Task ${i}`);
      const worker = f.store.createWorker({ projectId: project.id, role: "work", label: "Implementer", area: "src", bbProjectId: "proj_a" });
      const a = f.store.createAssignment({ projectId: project.id, workerNum: worker.num, taskNums: [task.num], route: "fresh", role: "work", workKind: "implementation", threadId: null, generation: 1, profile: { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" }, bbProjectId: "proj_a", environmentId: null, state: "reported", opId: `op_${i}`, opState: "done", briefText: "Implemented work", reviewOf: null, rationale: null });
      f.store.updateAssignment(project.id, a.num, { report: report() });
    }
    for (let i = 0; i < 120; i++) f.service.recordDecision(project.id, { decision: { description: `Choice ${i}`, madeBy: "user" } }, { author: "coordinator", threadId: "coordinator", assignment: null });
    const result = JSON.parse(await f.harness.callAgentTool("initiative_read", { refs, detailed: true }, { threadId: "coordinator" }) as string);
    expect(result.items.map((r: any) => r.ref)).toEqual(refs);
    expect(result.missingRefs).toEqual([]);
    expect(result).not.toHaveProperty("usage");
    expect(JSON.stringify(result).length).toBeLessThan(30000);
    expect(f.send).not.toHaveBeenCalled();
  }, 20000);

  it("rejects incompatible selectors and exposes missing refs rather than hiding them", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id);
    await expect(f.harness.callAgentTool("initiative_read", { view: "overview", refs: [task.ref] }, { threadId: "coordinator" })).rejects.toThrow(/overview.*refs|refs.*overview/);
    await expect(f.harness.callAgentTool("initiative_read", { view: "tasks", refs: ["A1"] }, { threadId: "coordinator" })).rejects.toThrow(/A1.*assignments/);
    const result = JSON.parse(await f.harness.callAgentTool("initiative_read", { refs: [task.ref, "D999"] }, { threadId: "coordinator" }) as string);
    expect(result.items.map((r: any) => r.ref)).toEqual([task.ref]);
    expect(result.missingRefs).toEqual(["D999"]);
    const alias = JSON.parse(await f.harness.callAgentTool("initiative_read", { refs: ["K999"] }, { threadId: "coordinator" }) as string);
    expect(alias.missingRefs).toEqual(["K999"]);
    await expect(f.harness.callAgentTool("initiative_read", { view: "overview", limit: 20 }, { threadId: "coordinator" })).rejects.toThrow(/overview/);
    // T143: a selection that fits no kind read is refused, even with no records to read.
    await expect(f.harness.callAgentTool("initiative_read", { view: "workers", fields: ["body"], detailed: true }, { threadId: "coordinator" })).rejects.toThrow(/applies to none/);
    // W188 (F5): fields implies detailed.
    expect(JSON.parse(await f.harness.callAgentTool("initiative_read", { view: "assignments", fields: ["report"] }, { threadId: "coordinator" }) as string).detail).toMatch(/^Full selected/);
  });

  it("W188, T143: a selection no record has names every bad field and one complete call that works (Equisafe)", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id);
    const read = (input: unknown) => f.harness.callAgentTool("initiative_read", input, { threadId: "coordinator" });
    const fails = (input: unknown) => read(input).then(() => "", (e: Error) => e.message);
    const message = await fails({ refs: [task.ref], detailed: true, fields: ["resolution", "checkpoint"] });
    expect(message).toContain("resolution, checkpoint apply to none of the records read. Valid fields by kind: tasks: brief.");
    const example = JSON.parse(/initiative_read (\{.*\})\.$/.exec(message)![1]!);
    expect(example).toEqual({ refs: [task.ref], fields: ["brief"] });
    expect(JSON.parse(await read(example) as string).items).toEqual([{ ref: task.ref, view: "tasks", brief: expect.anything() }]);
    // A single ref whose kind lacks the one field, and mixed refs none of whose kinds has any.
    expect(await fails({ refs: [task.ref], fields: ["report"] })).toMatch(/^report applies to none of the records read/);
    await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
    expect(await fails({ refs: [task.ref, "W1"], fields: ["body", "resolution"] })).toContain("Valid fields by kind: tasks: brief; workers: handoff, report.");
  });

  it("T143: mixed refs read each record's own fields in one call (W238 and D446–D449)", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id);
    const [worker] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
    await f.service.report(worker.threadId!, report());
    const decision = JSON.parse(await f.harness.callAgentTool("initiative_decision", { action: "user-choice", description: "Keep the 5m TTL." }, { threadId: "coordinator" }) as string);
    const result = JSON.parse(await f.harness.callAgentTool("initiative_read", { refs: [worker.worker, decision.ref, "D999"], fields: ["report", "body", "resolution"] }, { threadId: "coordinator" }) as string);
    expect(result.items.map((i: any) => Object.keys(i))).toEqual([["ref", "view", "report"], ["ref", "view", "body", "resolution"]]);
    expect(result.items[0].report).toMatchObject({ ref: worker.assignment, summary: expect.stringMatching(/archived records/) });
    expect(result.items[1].body).toBeTruthy();
    expect(result.fieldsNotApplied).toEqual({ workers: ["body", "resolution"], decisions: ["report"] });
    expect(result.missingRefs).toEqual(["D999"]);
  });

  it("pages complete large records, exposes field selection, and never clips valid JSON", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id);
    const [worker] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
    const large = report();
    large.evidence = Array.from({ length: 30 }, () => ({ kind: "check", label: "Check".repeat(60), detail: "d".repeat(1000), ref: "r".repeat(500), result: "passed" }));
    large.handoff.pendingCommands = Array.from({ length: 10 }, () => "c".repeat(1000));
    large.handoff.dirtyFiles = Array.from({ length: 30 }, () => "f".repeat(300));
    await f.service.report(worker.threadId!, large);
    await expect(f.harness.callAgentTool("initiative_read", { refs: ["A1"], detailed: true }, { threadId: "coordinator" })).rejects.toThrow(/byte.*budget.*fields/);
    const selected = JSON.parse(await f.harness.callAgentTool("initiative_read", { view: "assignments", refs: ["A1"], detailed: true, fields: ["report.handoff"] }, { threadId: "coordinator" }) as string);
    expect(selected.items[0]["report.handoff"].dirtyFiles).toHaveLength(30);
    expect(JSON.stringify(selected).length).toBeLessThan(MAX_READ_BYTES);
    const summary = JSON.parse(await f.harness.callAgentTool("initiative_read", { view: "assignments", refs: ["A1"] }, { threadId: "coordinator" }) as string);
    expect(summary.items[0]).not.toHaveProperty("briefText");
    expect(summary.items[0].report).not.toHaveProperty("evidence");
    expect(f.store.assignment(project.id, 1)?.report?.evidence).toHaveLength(30);
    // A page of individually valid details stops only between whole records.
    const update = "x".repeat(30000);
    for (let i = 0; i < 4; i++) f.store.addUpdate(project.id, `Update ${i}`, update, "coordinator");
    const first = JSON.parse(await f.harness.callAgentTool("initiative_read", { view: "updates", detailed: true }, { threadId: "coordinator" }) as string);
    expect(first.items).toHaveLength(2);
    expect(first.byteLimited).toBe(true);
    expect(first.nextOffset).toBe(2);
    expect(first.items[0].body).toBe(update);
  });

  it("publishes valid short tool/CLI examples and native inventory/usage selectors", async () => {
    for (const [name, example] of Object.entries(COMMAND_EXAMPLES)) expect(() => parseCommandInput(example), name).not.toThrow();
    for (const [name, example] of Object.entries(READ_EXAMPLES)) expect(agentReadSchema.safeParse(example).success, name).toBe(true);
    const { f, project } = await projectFixture();
    const reply = await f.harness.runCli(["describe", "spawn"], { threadId: "coordinator" });
    expect(reply.exitCode).toBe(0);
    expect(JSON.parse(reply.stdout!)).toEqual(COMMAND_EXAMPLES.spawn);
    const threads = JSON.parse(await f.harness.callAgentTool("initiative_read", { view: "threads", refs: ["coordinator"], detailed: true }, { threadId: "coordinator" }) as string);
    expect(threads.items).toHaveLength(1);
    expect(threads.items[0].threadId).toBe("coordinator");
    expect(threads).not.toHaveProperty("usage");
    await expect(f.harness.callAgentTool("initiative_read", { view: "threads", detailed: true, fields: ["report"] }, { threadId: "coordinator" })).rejects.toThrow(/threads: none, omit fields/);
    expect(f.store.project(project.id)).not.toBeNull();
    const legacy = JSON.parse(await f.harness.callAgentTool("project_read", { view: "overview", refs: ["T999"], offset: 0, limit: 20, detailed: false }, { threadId: "coordinator" }) as string);
    expect(legacy.missingRefs).toEqual(["T999"]);
    const oldDefault = JSON.parse(await f.harness.callAgentTool("project_read", { view: "overview", offset: 0, limit: 20, detailed: false }, { threadId: "coordinator" }) as string);
    expect(oldDefault).not.toHaveProperty("usage");
  });

  it("reads numeric activity IDs and whole retained history with truthful field selectors", async () => {
    const { f, project } = await projectFixture();
    for (let i = 0; i < 40; i++) f.store.log(project.id, "check", `Check ${i}`, { task: "T6", sequence: i });
    const read = (args: Record<string, unknown>) => f.harness.callAgentTool("initiative_read", args, { threadId: "coordinator" });
    const first = JSON.parse(await read({ view: "activity", limit: 3 }) as string);
    expect(first.total).toBeGreaterThanOrEqual(40);
    expect(first.items[0].ref).toMatch(/^\d+$/);
    const selected = JSON.parse(await read({ view: "activity", refs: [first.items[0].ref], detailed: true, fields: ["payload"] }) as string);
    expect(selected.items[0]).toMatchObject({ ref: first.items[0].ref, payload: { task: "T6", sequence: 39 } });
    const tail = JSON.parse(await read({ view: "activity", offset: 30, limit: 10 }) as string);
    expect(tail.items).toHaveLength(10);
    await expect(read({ view: "activity", refs: ["T6"] })).rejects.toThrow(/belongs to tasks/);
    await expect(read({ view: "threads", refs: ["D1"] })).rejects.toThrow(/belongs to decisions/);
  });

  it("bounds the default overview and real summaries over a large retained corpus", async () => {
    const { f, project } = await projectFixture();
    f.store.updateProject(project.id, { checkpoint: "History ".repeat(2000) });
    for (let i = 0; i < 500; i++) f.task(project.id, `Work ${i}`);
    const overview = JSON.parse(await f.harness.callAgentTool("initiative_read", {}, { threadId: "coordinator" }) as string);
    expect(overview.counts.openTasks).toBe(500);
    // T136: the old persistent checkpoint is never injected into the overview.
    expect(JSON.stringify(overview)).not.toContain("History");
    expect(overview).not.toHaveProperty("usage");
    expect(overview).not.toHaveProperty("memberThreads");
    expect(JSON.stringify(overview).length).toBeLessThan(16000);
    expect(overview.truncated).toBe(true);
    const page = JSON.parse(await f.harness.callAgentTool("initiative_read", { view: "tasks", limit: 3 }, { threadId: "coordinator" }) as string);
    expect(page.total).toBe(500);
    expect(page.nextOffset).toBe(3);
    expect(page.items[0]).not.toHaveProperty("brief");
    expect(page.items[0]).not.toHaveProperty("result");
    expect(page.truncated).toBe(true);
    expect(f.store.tasks(project.id)).toHaveLength(500);
    // Retained legacy dependency lists cannot make an eight-row overview unbounded.
    const first = f.store.task(project.id, 1)!;
    f.store.updateTask(project.id, first.num, { dependsOn: Array.from({ length: 400 }, (_, i) => i + 1) });
    const bounded = JSON.parse(await f.harness.callAgentTool("initiative_read", {}, { threadId: "coordinator" }) as string);
    expect(bounded.tasks[0].dependsOn).toHaveLength(20);
    expect(bounded.tasks[0].truncatedFields).toContain("dependsOn");
    expect(f.store.task(project.id, first.num)?.dependsOn).toHaveLength(400);
  }, 20000);

  it("W188: fields:[\"report\"] on a W# returns its latest report with the full final message", async () => {
    const { f } = await projectFixture();
    const tool = async (name: string, input: unknown) => JSON.parse(await f.harness.callAgentTool(name, input, { threadId: "coordinator" }) as string);
    const [w] = await tool("initiative_spawn", { label: "Search", purpose: "search", text: "Do it." });
    const long = `## Done\n\n${"Indexed and ranked. ".repeat(120)}\n\nRan npm test: 14 passed.`;
    const brief = f.spawn.mock.calls.at(-1)![0].prompt as string;
    f.history.push({ type: "client/turn/requested", seq: 1, createdAt: Date.now(), data: { requestId: "creq_1", initiator: "agent", input: [{ type: "text", text: brief }] } });
    f.history.push({ type: "turn/started", seq: 2, createdAt: Date.now() - 1 });
    f.history.push({ type: "turn/input/accepted", seq: 3, createdAt: Date.now(), data: { clientRequestId: "creq_1" } });
    f.history.push({ type: "item/completed", seq: 4, createdAt: Date.now(), data: { item: { type: "agentMessage", id: "m4", text: long } } });
    f.history.push({ type: "turn/completed", seq: 5, createdAt: Date.now() + 1, data: { status: "completed" } });
    await f.runtime.onThreadIdle(f.idle(w.threadId));
    const read = await tool("initiative_read", { refs: ["W1"], detailed: true, fields: ["report"] });
    expect(read.items).toEqual([{ ref: "W1", view: "workers", report: expect.objectContaining({ ref: "A1", outcome: "done", finalMessage: long.trim() }) }]);
    const both = await tool("initiative_read", { refs: ["W1"], detailed: true, fields: ["report", "handoff"] });
    expect(Object.keys(both.items[0])).toEqual(["ref", "view", "report", "handoff"]);
  });
});
