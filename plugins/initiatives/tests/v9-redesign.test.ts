import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { fixture, legacyDiscussion, projectFixture } from "./fake-native";
import { MIGRATIONS, Store } from "../lib/store";
import { DEFAULT_COORDINATOR_INSTRUCTIONS, DEFAULT_WORKER_INSTRUCTIONS, GUIDANCE_RESET_FLAG, PREVIOUS_DEFAULTS } from "../lib/guidance";
import { MAX_GUIDANCE_CHARACTERS } from "../lib/settings";
import { computeTaskStatus, type LinkingWork } from "../lib/task-status";
import { CUTOVER_FLAG, cutoverInstruction } from "../lib/cutover";
import { renderCoordinatorSeed } from "../lib/brief";
import { formatRulesFile, parseRulesFile } from "../lib/rules";
import { assembleInstructions, INSTRUCTIONS_MAX } from "../lib/instructions";

// v9 (Initiatives redesign, design.md): worker-owned review loops, the coordinator as every
// worker's lead (discussions, briefly leads too, are gone: R6), computed task status with a
// hand-set override, standing rules, pre-switch work and the cutover, D529.

type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const tool = async (f: Fx, name: string, input: unknown, threadId = "coordinator") =>
  JSON.parse((await f.harness.callAgentTool(name, input, { threadId })) as string);
const texts = (f: Fx, threadId?: string) =>
  f.send.mock.calls.map(([args]) => args).filter((a) => !threadId || a.threadId === threadId).map((a) => a.input[0].text as string);
const configure = (f: Fx, threadId: string) =>
  f.harness.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: f.threads.get(threadId)! }));
const rule = (n: number) => `Rule ${n}: ${"keep every query tenant-scoped and every migration reversible ".repeat(7)}`.slice(0, 400);
const PRECONDITION = `SELECT DISTINCT a.project_id, a.worker_num FROM assignments a
  JOIN workers w ON w.project_id = a.project_id AND w.num = a.worker_num
  WHERE a.reply_to IS NOT NULL AND w.state <> 'retired'`;

/** The worker's turn on its brief ended a minute ago with a message and no report. */
function stoppedTurn(f: Fx, threadId: string) {
  const at = Date.now() - 60_000;
  f.history.push({ type: "client/turn/requested", seq: 901, threadId, createdAt: at, data: { requestId: "creq_901", senderThreadId: "coordinator", input: [] } });
  f.history.push({ type: "turn/started", seq: 902, threadId, createdAt: at });
  f.history.push({ type: "item/completed", seq: 903, threadId, createdAt: at + 1, data: { item: { type: "agentMessage", text: "Reviewer r1 is running; waiting for it." } } });
  f.history.push({ type: "turn/completed", seq: 904, threadId, createdAt: at + 2, data: { status: "completed" } });
  f.idle(threadId);
}

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("v9 §6.1 the instruction budget", () => {
  const guidance = `${"g".repeat(MAX_GUIDANCE_CHARACTERS - 1)}Z`;
  it("every configure branch stays within 4096 and ends with the whole guidance", async () => {
    const { f, project } = await projectFixture({ coordinatorInstructions: guidance, workerInstructions: guidance });
    f.store.updateProject(project.id, { name: "N".repeat(200) });
    const [w] = await tool(f, "initiative_spawn", { label: "L".repeat(200), purpose: "P".repeat(300), text: "Do it." });
    for (const threadId of ["coordinator", w.threadId]) {
      const { instructions } = await configure(f, threadId);
      expect(instructions!.length, threadId).toBeLessThanOrEqual(INSTRUCTIONS_MAX);
      expect(instructions!.endsWith(guidance), threadId).toBe(true);
      expect(instructions, threadId).toMatch(/Standing rules: 0\./);
    }
    // The user's own thread gets no guidance, and stays far below the limit.
    const own = (await f.perform(project.id, { action: "thread-create", title: "Mine", request: {
      projectId: "proj_a", providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high", permissionMode: "full",
      executionInputSources: {}, environment: { type: "project-default" }, input: [{ type: "text", text: "hi" }] } as never }, "user", null)) as { threadId: string };
    if (own.threadId) expect((await configure(f, own.threadId)).instructions!.length).toBeLessThan(1000);
  });

  it("assembles plugin lines first and clips only them (the pending coordinator's long branch)", () => {
    const pending = "You are the pending coordinator of the \"" + "N".repeat(80) + "\" Initiative: this thread's checkout is still being proven. ".repeat(6);
    const out = assembleInstructions([pending, "Standing rules: 60, last changed 2026-10-14 10:12 UTC. Read them with initiative_read {view:\"rules\"}."], guidance);
    expect(out.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX);
    expect(out.endsWith(guidance)).toBe(true);
    expect(DEFAULT_WORKER_INSTRUCTIONS.length).toBeLessThanOrEqual(MAX_GUIDANCE_CHARACTERS);
    expect(DEFAULT_COORDINATOR_INSTRUCTIONS.length).toBeLessThanOrEqual(MAX_GUIDANCE_CHARACTERS);
  });
});

describe("v9 §3 the worker owns its review loop", () => {
  it("guidance: fresh reviewer each round from the other family, no round cap while findings converge (R5), blocked on whack-a-mole or scope creep; leads send it back only on a rule or the user's word", () => {
    expect(DEFAULT_WORKER_INSTRUCTIONS).toContain("a fresh reviewer each round, from the other model family, started with the reviewer command in your brief");
    expect(DEFAULT_WORKER_INSTRUCTIONS).toContain("Keep reviewing while findings converge (fewer, milder each round); no round cap. Done when the last verdict is clean. Blocked (each open finding, your view, the options) on whack-a-mole (P1s, or P2s reappearing in the same area round after round) or scope creep.");
    expect(DEFAULT_WORKER_INSTRUCTIONS).toContain("While a child or background job runs, end your turn; its result wakes you. Ending a turn reports nothing. End one without a report only to wait like that.");
    expect(DEFAULT_COORDINATOR_INSTRUCTIONS).toContain("if a standing rule or the user's explicit instruction settles it, answer the worker and let it keep reviewing");
    // W498 (R5): no 4- or 6-round limit is left in either default.
    for (const text of [DEFAULT_WORKER_INSTRUCTIONS, DEFAULT_COORDINATOR_INSTRUCTIONS]) expect(text).not.toMatch(/\b[46] (more )?(review )?rounds|after round \d|At most \d/);
    expect(DEFAULT_COORDINATOR_INSTRUCTIONS).toContain("Otherwise ask the user with initiative_question.");
  });

  it("a brief ends with the reviewer command of the other family and the rules; every work message with the whole loop", async () => {
    const { f, project } = await projectFixture();
    await tool(f, "initiative_rule", { action: "add", text: "Every PR targets dev." });
    const [w] = await tool(f, "initiative_spawn", { label: "Search", purpose: "search", text: "Do it." });
    const brief = f.spawn.mock.calls.at(-1)![0].prompt as string;
    // A Claude worker's reviewer is the reviewOfClaude profile (GPT by default).
    expect(brief).toContain('Reviewer command (code-review skill, other model family):\nbb thread spawn --project "$BB_PROJECT_ID" --parent-self \\\n  --lifecycle-owner-thread "$BB_THREAD_ID" --environment "$BB_ENVIRONMENT_ID" \\\n  --provider codex --model gpt-6-astra --reasoning-level xhigh');
    expect(brief).toMatch(/\n\nStanding rules \(1, last changed [^)]+\)\. The full list; follow it:\nR1\. Every PR targets dev\.\n\n\[initiatives:op_[a-z0-9]+\]$/);
    expect(brief).not.toContain("How you work in this Initiative");
    await tool(f, "initiative_report", { outcome: "blocked", summary: "Still rejected after 4 review rounds.", question: "Move the backfill?", report: "r4: P1 open." }, w.threadId);
    await tool(f, "initiative_message", { to: "W1", text: "R1 settles it. You have 4 more review rounds.", work: true });
    const work = texts(f, w.threadId).at(-1)!;
    expect(work).toContain(`How you work in this Initiative (current; replaces anything earlier):\n\n${DEFAULT_WORKER_INSTRUCTIONS}\n\nReviewer command`);
    expect(work).toMatch(/R1\. Every PR targets dev\.\n\n\[initiatives:op_[a-z0-9]+\]$/);
    expect(f.store.assignment(project.id, 2)).toMatchObject({ replyTo: "coordinator", route: "continue" });
  });

  it("a worker waiting on its running child is not stuck; the context route names the child; Stop stops it too", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "Search", purpose: "search", text: "Do it." });
    const child = makeThreadResponse({ id: "review-r1", projectId: "proj_a", parentThreadId: w.threadId, status: "active", title: "Review r1 #2631" });
    f.threads.set(child.id, child);
    await f.harness.emitThreadEvent("thread.active", { thread: child as never });
    // The worker ended its turn to wait; its latest input is the brief, long ago.
    stoppedTurn(f, w.threadId);
    f.send.mockClear();
    vi.spyOn(f.service, "now").mockReturnValue(Date.now() + 4 * 60_000);
    await f.service.checkWorkers();
    expect(texts(f).filter((t) => t.includes("without reporting"))).toEqual([]);
    // Stop with open work cancels it and stops the running child as well.
    const stopped = await tool(f, "initiative_worker", { action: "stop", worker: "W1", reason: "Dropped." });
    expect(stopped).toMatchObject({ worker: "W1", assignment: "A1", state: "cancelled" });
    expect(f.stop.mock.calls.map((call) => (call as unknown as [{ threadId: string }])[0].threadId)).toEqual(expect.arrayContaining([w.threadId, "review-r1"]));
    // Without open work, Stop still stops the thread and its children.
    f.stop.mockClear();
    await tool(f, "initiative_worker", { action: "stop", worker: "W1", reason: "Again." });
    expect(f.stop.mock.calls.map((call) => (call as unknown as [{ threadId: string }])[0].threadId)).toEqual(expect.arrayContaining([w.threadId, "review-r1"]));
    expect(f.store.project(project.id)).toBeTruthy();
  });

  it("control: the same silent worker without a live child is flagged to its lead", async () => {
    const { f } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "Search", purpose: "search", text: "Do it." });
    const child = makeThreadResponse({ id: "review-r1", projectId: "proj_a", parentThreadId: w.threadId, status: "idle", title: "Review r1 #2631" });
    f.threads.set(child.id, child);
    stoppedTurn(f, w.threadId);
    f.send.mockClear();
    vi.spyOn(f.service, "now").mockReturnValue(Date.now() + 4 * 60_000);
    await f.service.checkWorkers();
    expect(f.send.mock.calls.filter(([a]) => a.input[0].text.includes("without reporting")).map(([a]) => a.threadId)).toEqual(["coordinator"]);
  });

  it("the Pooler's context route names a worker's running child as its review", async () => {
    const { f } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "Search", purpose: "search", text: "Do it." });
    const child = makeThreadResponse({ id: "review-r2", projectId: "proj_a", parentThreadId: w.threadId, status: "active", title: "Review r2" });
    f.threads.set(child.id, child);
    await f.harness.emitThreadEvent("thread.active", { thread: child as never });
    const body = (await (await f.harness.fetchHttp("GET", `/context/v1/thread?threadId=${w.threadId}`)).json()) as { membership: { review: unknown } };
    expect(body.membership.review).toMatchObject({ ref: "review-r2", worker: "W1", phase: "running" });
    await f.harness.emitThreadEvent("thread.idle", { thread: { ...child, status: "idle" }, lastAssistantText: null } as never);
    const after = (await (await f.harness.fetchHttp("GET", `/context/v1/thread?threadId=${w.threadId}`)).json()) as { membership: { review: unknown } };
    expect(after.membership.review).toBeNull();
  });

  it("a lead's review spawn is refused with what replaces it", async () => {
    const { f } = await projectFixture();
    await expect(tool(f, "initiative_spawn", { role: "review", reviews: "W1", label: "R", purpose: "r", text: "x" })).rejects.toThrow(/Workers run their own reviews now/);
  });
});

describe("v9 §5 reports and messages go to the worker's lead, the coordinator", () => {
  it("a done report queues; a blocked one steers; to:\"lead\" and to:\"coordinator\" both reach it, even for work a discussion gave out", async () => {
    const { f, project } = await projectFixture();
    const chat = legacyDiscussion(f, project.id, "Wallet audit");
    const [w] = await tool(f, "initiative_spawn", { label: "Audit", purpose: "wallet", text: "Audit it." });
    // Work the previous build let the discussion give out.
    f.store.db.prepare("UPDATE assignments SET reply_to = ? WHERE project_id = ?").run(chat, project.id);
    f.send.mockClear();
    await tool(f, "initiative_message", { to: "lead", text: "Which chain first?" }, w.threadId);
    await tool(f, "initiative_message", { to: "coordinator", text: "And which RPC?" }, w.threadId);
    expect(f.send.mock.calls.map(([a]) => a.threadId)).toEqual(["coordinator", "coordinator"]);
    const blocked = await tool(f, "initiative_report", { outcome: "blocked", summary: "Need a choice.", question: "Pages or a queue consumer?", report: "Both options…" }, w.threadId);
    expect(blocked.note).toBe("Report recorded and sent to the coordinator.");
    expect(f.send.mock.calls[2]![0]).toMatchObject({ threadId: "coordinator", mode: "steer-if-active" });
    // The coordinator answers with more work; the next done report queues.
    await tool(f, "initiative_message", { to: "W1", text: "Pages.", work: true });
    expect(f.store.assignment(project.id, 2)).toMatchObject({ replyTo: "coordinator" });
    await tool(f, "initiative_report", { outcome: "done", summary: "Done after 2 rounds, last verdict clean.", report: "…" }, w.threadId);
    expect(f.send.mock.calls.at(-1)![0]).toMatchObject({ threadId: "coordinator", mode: "queue-if-active", senderThreadId: w.threadId });
    expect(f.send.mock.calls.map(([a]) => a.threadId)).not.toContain(chat);
  });

  it("a refused send names the lead and the retry", async () => {
    const { f } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "Audit", purpose: "wallet", text: "Audit it." });
    f.send.mockRejectedValueOnce(Object.assign(new Error("thread busy"), { status: 409 }));
    const result = await tool(f, "initiative_report", { outcome: "done", summary: "Done.", report: "Done." }, w.threadId);
    expect(result.note).toBe('Report recorded, but sending it to the coordinator failed (thread busy); tell the coordinator with initiative_message to:"lead".');
  });
});

describe("v9 §8.1 adoption: always one assignment, obeys Pause at its commit, then the loop", () => {
  const thread = (f: Fx, id = "adopt-me") => f.threads.set(id, { ...f.threads.get("coordinator")!, id, parentThreadId: "coordinator", status: "idle" });

  it("without tasks: one open assignment with reply_to, visible to rollback's query; the message ends with the loop", async () => {
    const { f, project } = await projectFixture();
    thread(f);
    f.send.mockClear();
    const adopted = await tool(f, "initiative_worker", { action: "adopt", threadId: "adopt-me", label: "Audit", purpose: "metrics" });
    expect(adopted.worker ?? adopted.ref).toBeTruthy();
    expect(f.store.assignments(project.id)).toMatchObject([{ workerNum: 1, taskNums: [], state: "idle_no_report", replyTo: "coordinator", workKind: "implementation" }]);
    expect(f.store.db.prepare(PRECONDITION).all()).toEqual([{ project_id: project.id, worker_num: 1 }]);
    const [message] = texts(f, "adopt-me");
    expect(message).toMatch(/^You are now W1 "Audit" \(metrics\) in the "Search" Initiative, on A1\./);
    expect(message).toContain("bb initiative report");
    expect(message).toContain(`How you work in this Initiative (current; replaces anything earlier):\n\n${DEFAULT_WORKER_INSTRUCTIONS}\n\nReviewer command`);
    expect(message).toMatch(/Standing rules: none yet\.\n\n\[initiatives:op_[a-z0-9]+\]$/);
    expect(f.send.mock.calls.at(-1)![0]).toMatchObject({ threadId: "adopt-me", mode: "queue-if-active" });
    // It reports from the shell while its tools predate the switch.
    const cli = await f.harness.runCli(["report", JSON.stringify({ outcome: "done", summary: "Audited.", report: "All good." })], { threadId: "adopt-me" });
    expect(cli.exitCode).toBe(0);
    expect(f.store.assignment(project.id, 1)).toMatchObject({ state: "reported" });
  });

  it("refused while paused, up front and when Pause lands during its reads; nothing is written or sent", async () => {
    const { f, project } = await projectFixture();
    thread(f);
    f.service.setPaused(project.id, true);
    f.send.mockClear();
    await expect(tool(f, "initiative_worker", { action: "adopt", threadId: "adopt-me", label: "Audit" })).rejects.toThrow("The Initiative is paused. Resume it before adopting a thread.");
    f.service.setPaused(project.id, false);
    // In flight: the thread read resolves only after Pause.
    f.intercept((path, args, call) => {
      if (path === "threads.get" && args.threadId === "adopt-me") f.service.setPaused(project.id, true);
      return call();
    });
    await expect(tool(f, "initiative_worker", { action: "adopt", threadId: "adopt-me", label: "Audit" })).rejects.toThrow("The Initiative is paused.");
    f.intercept();
    expect(f.store.workers(project.id)).toEqual([]);
    expect(f.store.assignments(project.id)).toEqual([]);
    expect(texts(f, "adopt-me")).toEqual([]);
    expect(f.store.db.prepare(PRECONDITION).all()).toEqual([]);
  });
});

describe("v9 §6 standing rules (D523)", () => {
  it("the coordinator adds, edits and removes; each change reaches workers with open work, not idle ones, nor a former discussion", async () => {
    const { f, project } = await projectFixture();
    const chat = legacyDiscussion(f, project.id);
    const [busy] = await tool(f, "initiative_spawn", { label: "Busy", purpose: "busy", text: "Work." });
    const [done] = await tool(f, "initiative_spawn", { label: "Done", purpose: "done", text: "Work." });
    await tool(f, "initiative_report", { outcome: "done", summary: "Done.", report: "Done." }, done.threadId);
    f.send.mockClear();
    const added = await tool(f, "initiative_rule", { action: "add", text: "A backfill over 1 M rows runs as a separate, resumable job." });
    expect(added).toMatchObject({ rule: "R1", reached: ["W1"] });
    expect(f.send.mock.calls.map(([a]) => [a.threadId, a.mode])).toEqual([[busy.threadId, "queue-if-active"]]);
    expect(texts(f)[0]).toContain('Rule R1 added: "A backfill over 1 M rows runs as a separate, resumable job."');
    // From the user: the coordinator hears of it too. The former discussion never does, and can't change rules.
    f.send.mockClear();
    await f.perform(project.id, { action: "rule-edit", rule: "R1", text: "A backfill over 1 M rows runs as its own job." }, "user", null);
    expect(f.send.mock.calls.map(([a]) => a.threadId)).toEqual(["coordinator", busy.threadId]);
    await expect(tool(f, "initiative_rule", { action: "add", text: "x" }, chat)).rejects.toThrow();
    await tool(f, "initiative_rule", { action: "add", text: "Every PR targets dev." });
    await tool(f, "initiative_rule", { action: "remove", rule: "R1" });
    const read = await tool(f, "initiative_read", { view: "rules" });
    expect(read.rules).toEqual([{ ref: "R2", text: "Every PR targets dev." }]);
    // A removed number is never reused.
    expect((await tool(f, "initiative_rule", { action: "add", text: "Third." })).rule).toBe("R3");
    expect(f.store.activity(project.id, 20).filter((a) => a.kind === "rule").map((a) => a.summary)).toContain("R1 removed by the coordinator (was: A backfill over 1 M rows runs as its own job.)");
    // Workers can't change rules.
    await expect(tool(f, "initiative_rule", { action: "add", text: "x" }, busy.threadId)).rejects.toThrow();
  });

  it("at most 60 rules of 400 characters, one line each; the user reorders on the Rules tab", async () => {
    const { f, project } = await projectFixture();
    for (let n = 1; n <= 60; n++) f.store.addRule(project.id, rule(n));
    await expect(tool(f, "initiative_rule", { action: "add", text: "One too many." })).rejects.toThrow(/60 standing rules/);
    await expect(tool(f, "initiative_rule", { action: "edit", rule: "R1", text: "x".repeat(401) })).rejects.toThrow();
    await expect(f.perform(project.id, { action: "rule-add", text: "two\nlines" }, "user", null)).rejects.toThrow();
    await f.perform(project.id, { action: "rule-move", rule: "R60", to: 1 }, "user", null);
    expect(f.store.rules(project.id).slice(0, 2).map((r) => r.ref)).toEqual(["R60", "R1"]);
    await expect(f.perform(project.id, { action: "rule-move", rule: "R1", to: 2 }, "coordinator", "coordinator")).rejects.toThrow(/Only the user reorders/);
  });

  it("the full list reaches a coordinator's first message, after a handover that mentions none", async () => {
    const rules = Array.from({ length: 60 }, (_, i) => ({ ref: `R${i + 1}`, num: i + 1, text: rule(i + 1), updatedAt: 0 })) as never[];
    const { renderRules } = await import("../lib/rules");
    for (const replacing of [true, false]) {
      const seed = renderCoordinatorSeed({ project: { name: "Equisafe", objective: "Ship." }, replacing, reason: replacing ? "context" : null,
        handover: replacing ? "W1420 owns #2631; nothing about rules here." : null, rules: renderRules(rules), preSwitch: null });
      expect(seed).toContain(`R1. ${rule(1)}`);
      expect(seed.endsWith(`R60. ${rule(60)}`)).toBe(true);
    }
  });

  it("import makes the list exactly the file's and writes the previous list next to it: importing that is the exact undo", async () => {
    const { f, project } = await projectFixture();
    const dir = mkdtempSync(join(tmpdir(), "v9-rules-"));
    scratch.push(dir);
    await tool(f, "initiative_rule", { action: "add", text: "Old rule." });
    await f.perform(project.id, { action: "rule-add", text: "Edited on the dashboard.", sources: ["D12"] }, "user", null);
    const file = join(dir, "rules-proposal.md");
    writeFileSync(file, "# Proposal\n\nR3. Every PR targets dev.\n    Sources: D12, D40\nR1. Old rule, reworded.\nR7. Migrations have a down step.\n");
    const imported = await f.harness.runCli(["rules", "import", project.id, file]);
    expect(imported.exitCode).toBe(0);
    expect(f.store.rules(project.id).map((r) => [r.ref, r.text, r.sources])).toEqual([
      ["R3", "Every PR targets dev.", ["D12", "D40"]], ["R1", "Old rule, reworded.", []], ["R7", "Migrations have a down step.", []]]);
    const backup = readdirSync(dir).find((name) => name.startsWith("rules-before-"))!;
    expect(JSON.parse(imported.stdout!).undo).toBe(`bb initiative rules import ${project.id} ${join(dir, backup)}`);
    expect((await f.harness.runCli(["rules", "import", project.id, join(dir, backup)])).exitCode).toBe(0);
    expect(f.store.rules(project.id).map((r) => [r.ref, r.text, r.sources])).toEqual([["R1", "Old rule.", []], ["R2", "Edited on the dashboard.", ["D12"]]]);
    // The format round-trips numbers, order, text and sources.
    const list = [{ num: 9, text: "Nine.", sources: ["D1"] }, { num: 2, text: "Two: with a colon, and #2631.", sources: [] }];
    expect(parseRulesFile(formatRulesFile("X", list))).toEqual(list);
    expect(() => parseRulesFile("R1. a\nnot a rule\n")).toThrow(/line 2/);
    expect(readFileSync(join(dir, backup), "utf8")).toContain("R2. Edited on the dashboard.\n    Sources: D12");
  });
});

describe("v9 §7 task status: computed, with a hand-set override (D522)", () => {
  const work = (patch: Partial<LinkingWork>): LinkingWork => ({ num: 1, workerNum: 1, state: "reported", report: { outcome: "succeeded", summary: "Done." }, stopReason: null, threadFailed: false, prs: [], ...patch });
  const computed = { status: "planned" as const, statusSetAt: null };
  it("follows the table", () => {
    expect(computeTaskStatus({ status: "cancelled", statusSetAt: 5 }, [work({})])).toEqual({ status: "cancelled", reason: "set by hand" });
    expect(computeTaskStatus(computed, [])).toEqual({ status: "planned", reason: "no worker yet" });
    expect(computeTaskStatus(computed, [work({ state: "running", report: null, num: 7 })])).toEqual({ status: "in_progress", reason: "W1 on A7" });
    expect(computeTaskStatus(computed, [work({ report: { outcome: "blocked", summary: "Still rejected after 4 rounds" } })]).status).toBe("blocked");
    expect(computeTaskStatus(computed, [work({})])).toEqual({ status: "done", reason: "W1 reported done, no PR" });
    const pr = (n: number, state: "OPEN" | "MERGED" | "CLOSED" | null, stage: string | null = null) => ({ url: `https://github.com/o/r/pull/${n}`, state, stage });
    expect(computeTaskStatus(computed, [work({ prs: [pr(2652, "OPEN", "ready-for-erwin")] })])).toEqual({ status: "in_progress", reason: "#2652 open · ready for erwin" });
    expect(computeTaskStatus(computed, [work({ prs: [pr(1, null)] })]).status).toBe("in_progress");
    expect(computeTaskStatus(computed, [work({ prs: [pr(2631, "MERGED"), pr(2632, "CLOSED")] })])).toEqual({ status: "done", reason: "#2631 merged" });
    expect(computeTaskStatus(computed, [work({ prs: [pr(2588, "CLOSED")] })])).toEqual({ status: "planned", reason: "#2588 closed unmerged" });
    expect(computeTaskStatus(computed, [work({ state: "failed", report: null, threadFailed: true, stopReason: "provider 529" })])).toEqual({ status: "blocked", reason: "W1: provider 529" });
    expect(computeTaskStatus(computed, [work({ state: "cancelled", report: null, stopReason: "Stopped: by Erwin" })])).toEqual({ status: "planned", reason: "W1 stopped: Stopped: by Erwin" });
    // The newest linking work decides, unless any is open.
    expect(computeTaskStatus(computed, [work({ num: 2, state: "cancelled", report: null }), work({ num: 1 })]).status).toBe("planned");
  });

  it("from the ledger: a PR record and its known state; a refused or cancelled-by-hand task; new work clears planned and done", async () => {
    const { f, project } = await projectFixture();
    const t = f.task(project.id);
    const [w] = await tool(f, "initiative_spawn", { label: "Fix", purpose: "fix", text: "Fix it.", tasks: [t.ref] });
    expect(f.store.task(project.id, t.num)).toMatchObject({ status: "in_progress", statusReason: "W1 on A1" });
    await tool(f, "initiative_report", { outcome: "done", summary: "PR https://github.com/o/r/pull/2631 is ready.", report: "…" }, w.threadId);
    expect(f.store.task(project.id, t.num)).toMatchObject({ status: "in_progress", statusReason: "#2631 state not known yet" });
    f.store.savePrLookup("https://github.com/o/r/pull/2631", Date.now(), { state: "MERGED", mergedAt: Date.now(), closedAt: Date.now() });
    expect(f.store.task(project.id, t.num)).toMatchObject({ status: "done", statusReason: "#2631 merged" });
    // MERGED is final.
    f.store.markPrsOpen(["https://github.com/o/r/pull/2631"], Date.now());
    expect(f.store.prState("https://github.com/o/r/pull/2631")!.state).toBe("MERGED");
    // Erwin cancels it by hand: it stays cancelled and refuses work until he follows the work again.
    await f.perform(project.id, { action: "task-status", task: t.ref, status: "cancelled", reason: "Dropped." }, "user", null);
    expect(f.store.task(project.id, t.num)).toMatchObject({ status: "cancelled", statusReason: "set by hand" });
    await expect(tool(f, "initiative_message", { to: "W1", text: "More.", work: true, tasks: [t.ref] })).rejects.toThrow(`${t.ref} was cancelled by hand. Ask the user, who can choose Follow the work on the Tasks tab.`);
    await f.perform(project.id, { action: "task-status", task: t.ref, status: "auto", reason: "Back." }, "user", null);
    expect(f.store.task(project.id, t.num)).toMatchObject({ status: "done", statusSetAt: null });
    expect(f.store.db.prepare("SELECT status FROM tasks WHERE num = ?").get(t.num)).toEqual({ status: "planned" });
    // Planned by hand: new work clears it and the status follows the work.
    await f.perform(project.id, { action: "task-status", task: t.ref, status: "planned", reason: "Later." }, "user", null);
    await tool(f, "initiative_message", { to: "W1", text: "More.", work: true, tasks: [t.ref] });
    expect(f.store.task(project.id, t.num)).toMatchObject({ status: "in_progress", statusSetAt: null });
    // Agents set a status only through status, on the user's word; close/reopen are refused.
    await expect(tool(f, "initiative_task", { action: "close", task: t.ref, outcome: "done" })).rejects.toThrow(/Tasks follow their work now/);
    await tool(f, "initiative_task", { action: "status", task: t.ref, status: "done", reason: "Erwin: ship it." });
    expect(f.store.activity(project.id, 5).map((a) => a.summary)).toContain(`${t.ref} set to done by the coordinator: Erwin: ship it.`);
  });

  it("the load-time statements keep old-build closes, return old-build moves of hand-set tasks to the work, and a second run changes nothing", () => {
    const db = new Database(":memory:");
    createFakePluginHost().bb.storage.migrate(db, MIGRATIONS);
    const store = new Store(db);
    store.createProject({ id: "p", name: "P", objective: "o", memberProjectIds: ["m"], coordinatorThreadId: null, policy: { profiles: {} } } as never);
    const rows: [string, number | null, string][] = [
      // [stored status, status_set_at, what the previous build did]
      ["cancelled", null, "Erwin cancels a computed task under the previous build"],
      ["done", null, "Erwin closes a computed task as done"],
      ["planned", 5, "Erwin reopens a task cancelled by hand under v9 (old reopen writes planned)"],
      ["in_progress", 5, "an old spawn moves a hand-planned task"],
      ["planned", null, "Follow the work under v9, untouched since"],
      ["blocked", null, "an automatic write of the previous build"],
    ];
    rows.forEach(([status, setAt], i) => db.prepare(`INSERT INTO tasks (project_id, num, title, summary, status, priority, depends_on, work_kind, created_at, updated_at, status_set_at)
      VALUES ('p', ?, 't', 's', ?, 2, '[]', 'implementation', 1, ?, ?)`).run(i + 1, status, 100 + i, setAt));
    const kept = store.reconcileTaskOverrides();
    expect(kept).toEqual([{ projectId: "p", num: 1, status: "cancelled" }, { projectId: "p", num: 2, status: "done" }]);
    const after = () => db.prepare("SELECT num, status, status_set_at AS setAt FROM tasks ORDER BY num").all();
    expect(after()).toEqual([
      { num: 1, status: "cancelled", setAt: 100 }, { num: 2, status: "done", setAt: 101 }, { num: 3, status: "planned", setAt: 5 },
      { num: 4, status: "in_progress", setAt: null }, { num: 5, status: "planned", setAt: null }, { num: 6, status: "blocked", setAt: null }]);
    const once = after();
    expect(store.reconcileTaskOverrides()).toEqual([]);
    expect(after()).toEqual(once);
    expect(store.task("p", 1)).toMatchObject({ status: "cancelled", statusReason: "set by hand" });
    expect(store.task("p", 6)).toMatchObject({ status: "planned", statusReason: "no worker yet" });
  });
});

describe("v9 §12 pre-switch work and the cutover", () => {
  it("the first load tells the coordinator once, steering; an ordinary reload tells no one", async () => {
    const { f, project } = await projectFixture();
    legacyDiscussion(f, project.id);
    f.send.mockClear();
    expect(await f.service.runCutover()).toEqual([project.id]);
    expect(f.send.mock.calls.map(([a]) => [a.threadId, a.mode])).toEqual([["coordinator", "steer-if-active"]]);
    expect(texts(f)[0]).toContain("Initiatives switched to worker-owned reviews at");
    const at = f.store.flagSetAt(CUTOVER_FLAG)!;
    expect(at).toEqual(expect.any(Number));
    f.send.mockClear();
    expect(await f.service.runCutover()).toEqual([]);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.store.flagSetAt(CUTOVER_FLAG)).toBe(at);
  });

  it("work the previous build gave out after the flag (reply_to NULL) makes the next load a cutover for that Initiative only", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "Fix", purpose: "fix", text: "Fix it." });
    await f.service.runCutover();
    f.store.upsertFlag(CUTOVER_FLAG, Date.now() - 10_000);
    // v9 work after the flag, and old work before it: neither is a cutover.
    f.store.db.prepare("UPDATE assignments SET created_at = ? WHERE num = 1").run(Date.now() - 20_000);
    expect(await f.service.runCutover()).toEqual([]);
    // The previous build ran again and gave out work: it has no reply_to.
    await tool(f, "initiative_report", { outcome: "done", summary: "PR https://github.com/o/r/pull/1 ready.", report: "Done." }, w.threadId);
    f.store.db.prepare("UPDATE assignments SET reply_to = NULL, created_at = ? WHERE num = 1").run(Date.now());
    f.send.mockClear();
    expect(await f.service.runCutover()).toEqual([project.id]);
    expect(f.store.flagSetAt(CUTOVER_FLAG)!).toBeGreaterThan(Date.now() - 5_000);
    // The pre-switch line appears wherever a lead reads that report.
    const read = await tool(f, "initiative_read", { refs: ["A1"], detailed: true });
    expect(read.items[0].preSwitch).toMatch(/^Given out before the switch to worker-owned reviews: W1 did not review this itself\./);
    const listed = await tool(f, "initiative_read", { view: "reports" });
    expect(listed.items[0].preSwitch).toMatch(/^Given out before the switch/);
    // A replacement coordinator's first message lists it whole, after the handover text.
    f.idle("coordinator");
    await f.service.replaceCoordinator(project.id, { reason: "fresh context", handover: "Short handover." });
    const seed = f.spawn.mock.calls.at(-1)![0].prompt as string;
    expect(seed).toMatch(/Short handover\.[^]*Standing rules: none yet\.\n\nWork given out before the switch to worker-owned reviews \(1 worker\):\n/);
    expect(seed).toContain(`- W1 · A1 · reported done`);
    expect(seed).toContain("Given out before the switch to worker-owned reviews: W1 did not review this itself.");
    expect(seed).toContain(cutoverInstruction(f.store.flagSetAt(CUTOVER_FLAG)!).slice(0, 60));
  });

  it("a pre-switch report sent now carries its line; a v9 one doesn't", async () => {
    const { f } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "Fix", purpose: "fix", text: "Fix it." });
    f.store.db.prepare("UPDATE assignments SET reply_to = NULL WHERE num = 1").run();
    f.send.mockClear();
    await tool(f, "initiative_report", { outcome: "done", summary: "Done.", report: "Done." }, w.threadId);
    expect(texts(f, "coordinator")[0]).toContain("Given out before the switch to worker-owned reviews: W1 did not review this itself.");
  });
});

describe("v9 §8.4 code-owned defaults are never stored", () => {
  const sets = (f: ReturnType<typeof fixture>) => vi.spyOn(f.preferences.handle, "experimental_set");
  it("a stored previous or current default is unset, never replaced with text; a real edit stays; a pending reset unsets", async () => {
    for (const [stored, flag, expected] of [
      [{ coordinatorInstructions: PREVIOUS_DEFAULTS.coordinator[0]!, workerInstructions: PREVIOUS_DEFAULTS.worker.at(-1)! }, true, { coordinatorInstructions: null, workerInstructions: null }],
      [{ coordinatorInstructions: DEFAULT_COORDINATOR_INSTRUCTIONS, workerInstructions: "Erwin's own edit." }, true, { coordinatorInstructions: null }],
      [{ coordinatorInstructions: "Erwin's lead edit.", workerInstructions: "Erwin's own edit." }, true, null],
      [{ coordinatorInstructions: "Agent-upgraded text.", workerInstructions: "More." }, false, { coordinatorInstructions: null, workerInstructions: null }],
    ] as const) {
      const f = fixture(stored as never);
      if (flag) f.store.setFlag(GUIDANCE_RESET_FLAG);
      const spy = sets(f);
      await f.preferences.ready;
      const written = spy.mock.calls.map(([patch]) => patch);
      if (expected) expect(written).toEqual([expected]);
      else expect(written).toEqual([]);
      for (const patch of written) for (const value of Object.values(patch)) expect(value).toBeNull();
      expect(f.store.hasFlag(GUIDANCE_RESET_FLAG)).toBe(true);
    }
  });
});

describe("v9 §11 migrations on the live database's schema (3d46353)", () => {
  it("apply additively over the recorded ledger, keep every column, and the previous build's rows read", () => {
    const db = new Database(":memory:");
    db.exec(readFileSync(new URL("./fixtures/live-schema-3d46353.sql", import.meta.url), "utf8"));
    const columns = (table: string) => (db.prepare(`SELECT name FROM pragma_table_info(?)`).pluck().all(table) as string[]);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").pluck().all() as string[];
    const before = Object.fromEntries(tables.map((t) => [t, columns(t)]));
    // A row of each kind the previous build writes, reply_to and status_set_at unknown to it.
    db.exec(`INSERT INTO projects (id, name, objective, member_project_ids, coordinator_thread_id, policy, created_at, updated_at) VALUES ('p', 'P', 'o', '["m"]', 'c', '{"profiles":{}}', 1, 1);
      INSERT INTO tasks (project_id, num, title, summary, status, priority, depends_on, work_kind, created_at, updated_at) VALUES ('p', 1, 't', 's', 'cancelled', 2, '[]', 'implementation', 1, 7), ('p', 2, 't', 's', 'in_progress', 2, '[]', 'implementation', 1, 1);
      INSERT INTO workers (project_id, num, role, label, area, thread_id, generation, bb_project_id, state, created_at, updated_at) VALUES ('p', 1, 'work', 'W', 'a', 'w1', 1, 'm', 'active', 1, 1);
      INSERT INTO assignments (project_id, num, worker_num, task_nums, route, role, thread_id, generation, profile, bb_project_id, state, op_id, op_state, brief_text, created_at, updated_at) VALUES ('p', 1, 1, '[2]', 'fresh', 'work', 'w1', 1, '{"providerId":"claude-code","model":"m","reasoningLevel":"high"}', 'm', 'running', 'op_1', 'done', 'b', 1, 1);`);
    // The SDK's runner checks every recorded migration's hash, then applies the new ones (v9's, W464's PR owners, W468's report_notices, W476's blocker columns, W492's retire requests, overview index and blocked_on_lead, W496's ended nested threads, W499's placement).
    createFakePluginHost().bb.storage.migrate(db, MIGRATIONS);
    expect(db.prepare("SELECT COUNT(*) FROM _bb_migrations").pluck().get()).toBe(MIGRATIONS.length);
    expect(MIGRATIONS.length - 87).toBe(13);
    expect(columns("assignments")).toContain("placement");
    for (const [table, cols] of Object.entries(before)) expect(columns(table), table).toEqual(expect.arrayContaining(cols));
    expect(columns("assignments")).toContain("reply_to");
    expect(columns("tasks")).toContain("status_set_at");
    expect(columns("assignments")).toContain("blocker_options");
    expect(columns("knowledge")).toContain("blocker_choice");
    expect(columns("rules")).toEqual(["project_id", "num", "text", "position", "sources", "created_at", "updated_at", "removed_at"]);
    expect(columns("pr_states")).toEqual(["url", "state", "merged_at", "closed_at", "checked_at", "error"]);
    // R2 (W464): one more table, empty: every PR starts unassigned.
    expect(columns("pr_owners")).toEqual(["url", "project_id", "source", "set_at"]);
    expect(db.prepare("SELECT COUNT(*) FROM pr_owners").pluck().get()).toBe(0);
    const store = new Store(db);
    expect(store.reconcileTaskOverrides()).toEqual([{ projectId: "p", num: 1, status: "cancelled" }]);
    expect(store.tasks("p").map((t) => [t.ref, t.status, t.statusReason])).toEqual([["T1", "cancelled", "set by hand"], ["T2", "in_progress", "W1 on A1"]]);
    expect(store.assignment("p", 1)).toMatchObject({ replyTo: null });
    // Running them again is a no-op.
    createFakePluginHost().bb.storage.migrate(db, MIGRATIONS);
    expect(db.prepare("SELECT COUNT(*) FROM _bb_migrations").pluck().get()).toBe(MIGRATIONS.length);
  });
});

describe("v9 D532: the tree tells the sidebar which threads are the Initiative's", () => {
  it("lists a former discussion as a plain user thread, and former thread ids (retired workers, earlier generations)", async () => {
    const { f, project } = await projectFixture();
    const chat = legacyDiscussion(f, project.id);
    const [w] = await tool(f, "initiative_spawn", { label: "Fix", purpose: "fix", text: "Fix it." });
    await tool(f, "initiative_report", { outcome: "done", summary: "Done.", report: "Done." }, w.threadId);
    f.idle(w.threadId);
    await tool(f, "initiative_worker", { action: "retire", worker: "W1" });
    const tree = (await f.harness.callRpc("tree", null)) as { projects: { id: string; nodes: { threadId: string; role: string }[]; formerThreadIds?: string[] }[] };
    const p = tree.projects.find((x) => x.id === project.id)!;
    const node = p.nodes.find((n) => n.threadId === chat)!;
    expect(node).toMatchObject({ role: "adhoc", state: "member" });
    expect(node).not.toHaveProperty("discussion");
    expect(p.formerThreadIds).toContain(w.threadId);
    expect(p.formerThreadIds).not.toContain("coordinator");
  });
});
