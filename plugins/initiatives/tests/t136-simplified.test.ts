import { describe, expect, it } from "vitest";
import { fixture, projectFixture, report } from "./fake-native";
import { clearCatalogCache } from "../lib/bb";
import { DEFAULT_COORDINATOR_INSTRUCTIONS, DEFAULT_WORKER_INSTRUCTIONS, GUIDANCE_RESET_FLAG } from "../lib/guidance";
import { MAX_GUIDANCE_CHARACTERS } from "../lib/settings";

// T136: Initiatives as threads, labels and messages. Workers are spawned or messaged; a
// report is the final message; done is closing the task or retiring the worker; a fresh
// coordinator starts from a handover GPT-6 Luna High writes from recent activity.
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const tool = async (f: Fx, name: string, input: unknown, threadId = "coordinator") => JSON.parse(await f.harness.callAgentTool(name, input, { threadId }) as string);
let seq = 100;
/** The latest brief the plugin sent, as BB records a turn's input. */
const latestBrief = (f: Fx) => (f.store.db.prepare("SELECT brief_text FROM assignments ORDER BY rowid DESC LIMIT 1").get() as { brief_text: string } | undefined)?.brief_text ?? "";
/** A turn that received `input` (by default the latest brief) and ends with this final message. */
function finishTurn(f: Fx, text: string, status = "completed", input = latestBrief(f)) {
  const request = `creq_${++seq}`;
  f.history.push({ type: "client/turn/requested", seq: ++seq, createdAt: Date.now(), data: { requestId: request, initiator: "agent", input: [{ type: "text", text: input }] } });
  f.history.push({ type: "turn/started", seq: ++seq, createdAt: Date.now() - 1 });
  f.history.push({ type: "turn/input/accepted", seq: ++seq, createdAt: Date.now(), data: { clientRequestId: request } });
  f.history.push({ type: "item/completed", seq: ++seq, createdAt: Date.now(), data: { item: { type: "agentMessage", id: `m${seq}`, text } } });
  f.history.push({ type: "turn/completed", seq: ++seq, createdAt: Date.now() + 1, data: { status } });
}
/** Lets the writer's model appear in the native catalog. */
function lunaAvailable(f: Fx) {
  f.execution.set("catalog-probe", { model: "gpt-6-luna", reasoningLevel: "high" });
  clearCatalogCache();
}

describe("T136 giving work: spawn or message, tasks optional", () => {
  it("spawns a worker without any task; the brief is the label, the text and the report line", async () => {
    const { f, project } = await projectFixture();
    const [r] = await tool(f, "initiative_spawn", { label: "Search index", purpose: "search ranking", text: "Index archived records. Verify with npm test." });
    expect(r).toMatchObject({ worker: "W1", assignment: "A1", state: "running" });
    const brief = f.spawn.mock.calls.at(-1)![0].prompt as string;
    expect(brief).toMatch(/^W1 "Search index" \(search ranking\) · work\n\nIndex archived records\. Verify with npm test\.\n\nExecution: .*\n\nFinish with your report as your final message\.\n\n\[initiatives:op_[a-z0-9]+\]$/);
    expect(brief.length).toBeLessThan(400);
    expect(f.store.assignment(project.id, 1)).toMatchObject({ taskNums: [], role: "work" });
  });

  it("a message with work:true gives an existing worker more work; a plain message gives none", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "Search", purpose: "search", text: "First part." });
    await f.service.report(w.threadId, report());
    f.idle(w.threadId);
    await tool(f, "initiative_message", { to: "W1", text: "A question about your report." });
    expect(f.store.assignments(project.id)).toHaveLength(1);
    const [more] = await tool(f, "initiative_message", { to: "W1", text: "Now the second part.", work: true });
    expect(more).toMatchObject({ worker: "W1", assignment: "A2" });
    expect(f.send.mock.calls.at(-1)![0].input[0].text).toMatch(/^W1 "Search" \(search\) · work\n\nNow the second part\./);
    await expect(tool(f, "initiative_message", { to: "coordinator", text: "x", work: true }, w.threadId)).rejects.toThrow(/worker/);
  });

  it("workers cannot give work, and reviewers never take it", async () => {
    const { f } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "Search", purpose: "search", text: "Do it." });
    await f.service.report(w.threadId, report());
    await expect(tool(f, "initiative_spawn", { label: "X", purpose: "x", text: "y" }, w.threadId)).rejects.toThrow(/coordinator/);
    const [r] = await tool(f, "initiative_spawn", { role: "review", reviews: "W1", label: "Review", purpose: "review W1", text: "Check it." });
    f.idle(r.threadId);
    await f.service.report(r.threadId, report());
    // work:true to a reviewer is a read-only re-review (W190); implementation is refused.
    await expect(f.service.delegate(f.store.projects()[0]!.id, { route: "continue", role: "work", worker: r.worker })).rejects.toThrow(/Reviewers never implement/);
    const [again] = await tool(f, "initiative_message", { to: r.worker, text: "Re-check it", work: true });
    expect(f.store.assignment(f.store.projects()[0]!.id, Number(again.assignment.slice(1)))).toMatchObject({ role: "review", access: "read-only" });
  });
});

describe("T136 the final message is the report", () => {
  it("records the turn's final message as a done report; the task stays open until closed", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id, "Archived search");
    const [w] = await tool(f, "initiative_spawn", { label: "Search", purpose: "search", text: "Do it.", tasks: [task.ref] });
    finishTurn(f, "## Done\n\nArchived records are indexed and ranked below live ones.\n\nRan npm test: 14 passed. Nothing uncommitted.");
    await f.runtime.onThreadIdle(f.idle(w.threadId));
    const a = f.store.assignment(project.id, 1)!;
    expect(a).toMatchObject({ state: "reported", report: { outcome: "succeeded", summary: "Done" } });
    expect(a.report!.finalMessage).toContain("Ran npm test: 14 passed.");
    expect(f.store.task(project.id, task.num)).toMatchObject({ status: "in_progress", progress: "W1 reported: Done" });
    // Native completion already told the parent coordinator: no plugin copy.
    expect(f.send).not.toHaveBeenCalled();
    const closed = await tool(f, "initiative_task", { action: "close", task: task.ref, outcome: "done", note: "Shipped." });
    expect(closed).toMatchObject({ status: "done", result: "Shipped.", acceptedAssignment: 1 });
    expect(f.store.assignment(project.id, 1)!.state).toBe("reported");
    const read = await tool(f, "initiative_read", { refs: ["W1"] });
    expect(read.items[0].latestReport).toMatchObject({ ref: "A1", outcome: "done", summary: "Done" });
  });

  it("a short initiative_report keeps its outcome and gets the final message attached", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id, "Archived search");
    const [w] = await tool(f, "initiative_spawn", { label: "Search", purpose: "search", text: "Do it.", tasks: [task.ref] });
    await tool(f, "initiative_report", { outcome: "blocked", summary: "Need the staging key", question: "Which staging key should I use?" }, w.threadId);
    finishTurn(f, "I'm blocked: the staging key is missing. Everything else is done.");
    await f.runtime.onThreadIdle(f.idle(w.threadId));
    expect(f.store.assignment(project.id, 1)!.report).toMatchObject({
      outcome: "blocked", summary: "Need the staging key", blocker: { question: "Which staging key should I use?" },
      finalMessage: "I'm blocked: the staging key is missing. Everything else is done.",
    });
    expect(f.store.task(project.id, task.num)!.status).toBe("blocked");
    const overview = await f.overview(project.id, "summary");
    expect(overview.blockers.map(b => b.question)).toEqual(["Which staging key should I use?"]);
    await expect(tool(f, "initiative_report", { outcome: "blocked", summary: "x" }, w.threadId)).rejects.toThrow(/question/);
  });

  it("an interrupted turn or a turn without a message records nothing", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "Search", purpose: "search", text: "Do it." });
    finishTurn(f, "Half-way there", "interrupted");
    await f.runtime.onThreadIdle(f.idle(w.threadId));
    expect(f.store.assignment(project.id, 1)!.report).toBeNull();
  });

  it("the Reported list keeps each live worker's latest report until its task closes or the worker retires", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id, "Archived search");
    const [w] = await tool(f, "initiative_spawn", { label: "Search", purpose: "search", text: "Do it.", tasks: [task.ref] });
    finishTurn(f, "Done and verified.");
    await f.runtime.onThreadIdle(f.idle(w.threadId));
    let o = await f.overview(project.id, "summary");
    expect(o.awaitingAcceptance).toEqual([expect.objectContaining({ assignment: "A1", finalMessage: "Done and verified." })]);
    await tool(f, "initiative_task", { action: "close", task: task.ref, outcome: "done" });
    o = await f.overview(project.id, "summary");
    expect(o.awaitingAcceptance).toEqual([]);
  });
});

describe("T136 coordinator handover written by GPT-6 Luna High", () => {
  it("writes the handover in a short-lived Codex thread, then starts the new coordinator with it", async () => {
    const { f, project } = await projectFixture();
    lunaAvailable(f);
    f.idle("coordinator");
    const spawns = f.spawn.mock.calls.length;
    const started = await f.service.replaceCoordinator(project.id, { reason: "Fresh context" });
    expect(started).toMatchObject({ state: "writing-handover" });
    const writer = f.spawn.mock.calls.at(-1)![0];
    expect(f.spawn.mock.calls.length).toBe(spawns + 1);
    expect(writer).toMatchObject({ providerId: "codex", model: "gpt-6-luna", reasoningLevel: "high", title: "Handover · Search", pluginMetadata: { role: "handover-writer", projectId: project.id } });
    expect(writer).not.toHaveProperty("parentThreadId");
    expect(writer.prompt).toContain('Write a short handover for the new coordinator of the Initiative "Search" from this dated snapshot.');
    expect(writer.prompt).toMatch(/Snapshot captured at \d{4}-\d\d-\d\d \d\d:\d\d UTC/);
    expect(writer.prompt).toContain("Objective: Make historical search useful");
    // The writer gets no Initiative tools.
    const writerThread = [...f.threads.keys()].at(-1)!;
    const { makePluginAgentConfigurationContext } = await import("@get-bb/plugin-sdk/testing");
    expect((await f.harness.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: f.threads.get(writerThread)!, pluginMetadata: f.metadata.get(writerThread) as never }))).tools).toEqual([]);
    expect(f.store.project(project.id)!.coordinatorThreadId).toBe("coordinator");
    const before = f.history.length;
    finishTurn(f, "Objective: historical search. In flight: nothing. Next: index archived rows.");
    // The writer's turn is in the writer's thread (W188: coordinator activity would make it stale).
    for (const row of f.history.slice(before)) row.threadId = writerThread;
    await f.runtime.onThreadIdle(f.idle(writerThread));
    const seed = f.spawn.mock.calls.at(-1)![0];
    expect(seed.title).toBe("Search · coordinator");
    // W188 (F1): the handover is dated by its capture, and the replacement says it is complete.
    expect(seed.prompt).toMatch(/Handover from the previous coordinator:\n\nWritten from a snapshot captured at \d{4}-\d\d-\d\d \d\d:\d\d UTC; anything later is not in it\. Read the overview first \(initiative_read\): things may have moved since the capture time\.\n\nObjective: historical search\. In flight: nothing\. Next: index archived rows\./);
    expect(seed.prompt).toContain("this replacement is complete");
    expect(f.store.project(project.id)!.coordinatorThreadId).not.toBe("coordinator");
    expect(f.archive).toHaveBeenCalledWith(expect.objectContaining({ threadId: writerThread }));
    expect(f.store.handoverDraft(project.id)).toBeNull();
    // Nothing persistent: the overview never injects a checkpoint.
    expect(f.store.project(project.id)!.checkpoint).toBeNull();
  });

  it("falls back to a plain listing at once when Luna is unavailable, so a replacement never blocks", async () => {
    const { f, project } = await projectFixture();
    clearCatalogCache();
    f.idle("coordinator");
    await f.service.replaceCoordinator(project.id, { reason: "Fresh context" });
    const seed = f.spawn.mock.calls.at(-1)![0].prompt as string;
    expect(seed).toMatch(/Handover from the previous coordinator:\n\nWritten from a snapshot captured at [^\n]+\n\n\(Generated without Luna: GPT-6 Luna is not available/);
    expect(seed).toContain('# Initiative "Search"');
    expect(f.store.project(project.id)!.coordinatorThreadId).not.toBe("coordinator");
  });

  it("uses the handover the user reviewed, as written", async () => {
    const { f, project } = await projectFixture();
    f.idle("coordinator");
    await f.service.replaceCoordinator(project.id, { reason: "Fresh context", handover: "Edited by Erwin: start with T4." });
    expect(f.spawn.mock.calls.at(-1)![0].prompt).toContain("Handover from the previous coordinator:\n\nEdited by Erwin: start with T4.");
  });

  it("a writer that runs too long is replaced by the plain listing", async () => {
    const { f, project } = await projectFixture();
    lunaAvailable(f);
    await f.service.startHandoverDraft(project.id, {});
    const draft = f.store.handoverDraft(project.id)!;
    expect(draft.state).toBe("generating");
    f.store.db.prepare("UPDATE handover_drafts SET updated_at=? WHERE project_id=?").run(0, project.id);
    await f.service.sweepHandoverDrafts();
    expect(f.store.handoverDraft(project.id)).toMatchObject({ state: "ready", source: "fallback", detail: "the writer took longer than 10 minutes" });
  });

  it("recreate-coordinators --dry-run writes and prints handovers without starting anything; the real run starts them", async () => {
    const { f, project } = await projectFixture();
    f.idle("coordinator");
    const spawns = f.spawn.mock.calls.length;
    const dry = await f.harness.runCli(["recreate-coordinators", "--all", "--dry-run", "--wait=0"]);
    expect(dry.exitCode).toBe(0);
    const [entry] = JSON.parse(dry.stdout!);
    expect(entry).toMatchObject({ initiative: project.id, name: "Search", state: "ready", source: "fallback" });
    expect(entry.handover).toContain('# Initiative "Search"');
    expect(f.spawn.mock.calls.length).toBe(spawns);
    expect(f.store.project(project.id)!.coordinatorThreadId).toBe("coordinator");
    const real = await f.harness.runCli(["recreate-coordinators", project.id, "--wait=0"]);
    expect(real.exitCode).toBe(0);
    expect(f.store.project(project.id)!.coordinatorThreadId).not.toBe("coordinator");
    expect(f.spawn.mock.calls.at(-1)![0].prompt).toContain("Reason: Coordinator recreated after the BB restart.");
    expect((await f.harness.runCli(["recreate-coordinators"])).exitCode).toBe(1);
  });
});

describe("T136 instructions", () => {
  it("defaults are short, within the bound, and say what the brief now leaves out", () => {
    // W198 added PR stages and batching (one line).
    expect(DEFAULT_COORDINATOR_INSTRUCTIONS.length).toBeLessThan(1600);
    // Erwin (2026-10-07) added the no-narration rule to the worker text.
    expect(DEFAULT_WORKER_INSTRUCTIONS.length).toBeLessThan(1200);
    for (const text of [DEFAULT_COORDINATOR_INSTRUCTIONS, DEFAULT_WORKER_INSTRUCTIONS]) expect(text.length).toBeLessThanOrEqual(MAX_GUIDANCE_CHARACTERS);
    expect(DEFAULT_COORDINATOR_INSTRUCTIONS).toContain("one work worker per related batch and one fresh reviewer");
    expect(DEFAULT_WORKER_INSTRUCTIONS).toContain("Your final message is your report");
  });

  it("replaces saved instructions with the new defaults once, outright; later edits stay", async () => {
    const f = fixture({ coordinatorInstructions: "Old agent-upgraded coordinator text.", workerInstructions: "Old agent-upgraded worker text." });
    await f.preferences.ready;
    expect(f.preferences.configuration()).toMatchObject({ coordinatorInstructions: DEFAULT_COORDINATOR_INSTRUCTIONS, workerInstructions: DEFAULT_WORKER_INSTRUCTIONS });
    expect(await f.preferences.handle.get()).toMatchObject({ coordinatorInstructions: DEFAULT_COORDINATOR_INSTRUCTIONS, workerInstructions: DEFAULT_WORKER_INSTRUCTIONS });
    expect(f.store.hasFlag(GUIDANCE_RESET_FLAG)).toBe(true);
    await f.preferences.handle.experimental_set({ workerInstructions: "Erwin's own edit." });
    expect(f.preferences.configuration().workerInstructions).toBe("Erwin's own edit.");
    expect(f.send).not.toHaveBeenCalled();
  });
});

describe("T136 sessions constructed before the change", () => {
  it("older payloads still run, and removed actions answer with what replaces them", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id);
    const [d] = await tool(f, "initiative_delegate", { action: "delegate", route: "fresh", tasks: [task.ref], label: "Old", area: "old" });
    expect(d).toMatchObject({ worker: "W1" });
    await tool(f, "initiative_report", report(), d.threadId);
    expect(f.store.assignment(project.id, 1)).toMatchObject({ state: "reported", report: { outcome: "succeeded" } });
    expect(await tool(f, "initiative_progress", { note: "Half-way" }, d.threadId)).toMatchObject({ note: expect.stringMatching(/no longer recorded/) });
    await expect(tool(f, "initiative_task", { action: "task-accept", task: task.ref })).rejects.toThrow(/close the task/);
    await expect(tool(f, "initiative_task", { action: "assignment-reject", assignment: "A1", reason: "x" })).rejects.toThrow(/message the worker/);
    await expect(tool(f, "initiative_delegate", { action: "delegate", route: "fork", worker: "W1" })).rejects.toThrow(/spawn a fresh worker/i);
    expect(await tool(f, "initiative_task", { action: "task-create", title: "Old style", summary: "Created by an older session." })).toMatchObject({ title: "Old style" });
    expect(await tool(f, "initiative_manage", { action: "pause", paused: true })).toBeTruthy();
    expect(f.store.project(project.id)!.paused).toBe(true);
  });
});
