import { describe, expect, it } from "vitest";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { projectFixture } from "./fake-native";
import { needsYouCount } from "../lib/blockers";
import { FINAL_MESSAGE_MAX, reportSchema } from "../lib/schema";
import { emptySnapshot, handoverPacket } from "../lib/handover-packet";
import { blankPrRecord } from "../lib/pr-stages";

// W492: the tool calls agents kept getting refused (server log, 2026-10-16), each made to succeed
// the first time where refusing was not the point.
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const tool = async (f: Fx, name: string, input: unknown, threadId = "coordinator") => JSON.parse(await f.harness.callAgentTool(name, input, { threadId }) as string);
const sentTexts = (f: Fx) => f.send.mock.calls.map(([args]) => args.input[0].text as string);
async function spawned(text = "Do it.") {
  const { f, project } = await projectFixture();
  const [w] = await tool(f, "initiative_spawn", { label: "Search", purpose: "search", text });
  return { f, project, w: w as { assignment: string; worker: string; threadId: string } };
}
const configured = async (f: Fx, threadId: string) => (await f.harness.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: f.threads.get(threadId)! }))).tools;
const properties = (schema: unknown, ...path: string[]) => Object.keys(path.reduce<any>((node, key) => node[key], schema).properties);

describe("W492 a worker is offered only what it can set", () => {
  it("advertises initiative_pr and initiative_message without the lead's fields to workers, and whole to leads", async () => {
    const { f, w } = await spawned();
    const worker = Object.fromEntries((await configured(f, w.threadId)).map((t) => [t.name, t.inputSchema]));
    expect(Object.keys(worker).sort()).toEqual(["initiative_message", "initiative_pr", "initiative_pr_unwatch", "initiative_pr_watch", "initiative_read", "initiative_report"]);
    expect(properties(worker.initiative_pr, "properties", "prs", "items")).toEqual(["url", "stage", "note", "notes", "initiative"]);
    expect(properties(worker.initiative_pr)).toEqual(["prs"]);
    expect(properties(worker.initiative_message)).toEqual(["text", "to"]);
    const lead = Object.fromEntries((await configured(f, "coordinator")).map((t) => [t.name, t.inputSchema]));
    expect(properties(lead.initiative_pr, "properties", "prs", "items")).toEqual(expect.arrayContaining(["waitingOn", "worker", "category", "answered"]));
    expect(properties(lead.initiative_message)).toEqual(expect.arrayContaining(["tasks", "work", "resumeCold"]));
  });

  it("offers no memory view, and answers one from a thread without chat memory instead of failing", async () => {
    const { f, w } = await spawned();
    const read = (await configured(f, w.threadId)).find((t) => t.name === "initiative_read")!.inputSchema as any;
    expect(read.properties.view.enum).not.toContain("memory");
    f.pluginRpc.mockRejectedValueOnce(new Error("HTTP 500: This thread has no chat memory: turn it on in the thread's Memory panel."));
    expect(await tool(f, "initiative_read", { view: "memory", limit: 30 }, w.threadId)).toEqual({ messages: 0, view: "",
      note: `Workers have no chat memory: your brief and messages are in this thread. initiative_read {refs:["${w.worker}"],fields:["brief"]} reads your latest brief.` });
    // Any other failure of Chat memory still fails the read.
    f.pluginRpc.mockRejectedValueOnce(new Error("HTTP 503: unavailable"));
    await expect(tool(f, "initiative_read", { view: "memory" }, w.threadId)).rejects.toThrow(/503/);
  });

  it("reads a worker's brief, and brief as an assignment's briefText", async () => {
    const { f, w } = await spawned("Index the archived records.");
    const brief = f.store.assignment(f.store.projects()[0]!.id, 1)!.briefText;
    expect((await tool(f, "initiative_read", { refs: [w.worker], fields: ["brief"] })).items).toEqual([{ ref: w.worker, view: "workers", brief }]);
    expect((await tool(f, "initiative_read", { refs: [w.worker], fields: ["briefText", "report"] })).items).toEqual([{ ref: w.worker, view: "workers", briefText: brief, report: null }]);
    expect((await tool(f, "initiative_read", { refs: [w.assignment], fields: ["brief"] })).items).toEqual([{ ref: w.assignment, view: "assignments", brief }]);
    expect((await tool(f, "initiative_read", { view: "workers", fields: ["brief"] })).items).toEqual([{ ref: w.worker, view: "workers", brief }]);
  });
});

describe("W492 initiative_report reads what it can", () => {
  it("records succeeded as done, and either of summary and report for the other, saying so", async () => {
    const { f, project, w } = await spawned();
    const result = await tool(f, "initiative_report", { outcome: "succeeded", summary: "PR #12 is green." }, w.threadId);
    expect(result.note).toContain('outcome "succeeded" was recorded as "done". No report: the summary is recorded as the report.');
    expect(f.store.assignment(project.id, 1)!.report).toMatchObject({ outcome: "succeeded", summary: "PR #12 is green.", finalMessage: "PR #12 is green." });
  });

  it("keeps the start and end of a report past the cap, and takes a summary from it", async () => {
    const { f, project, w } = await spawned();
    const long = `Start of it. ${"x".repeat(30_000)} The end.`;
    const result = await tool(f, "initiative_report", { outcome: "done", report: long }, w.threadId);
    expect(result.note).toContain(`No summary: the report's first 1000 characters stand in. The report is ${long.length} characters: its start and end are kept`);
    const stored = f.store.assignment(project.id, 1)!.report!;
    expect(stored.finalMessage!.length).toBeLessThanOrEqual(FINAL_MESSAGE_MAX);
    expect(stored.finalMessage).toMatch(/^Start of it\. x+\n\[… \d+ characters omitted …\]\nx+ The end\.$/);
    expect(stored.summary.startsWith("Start of it.")).toBe(true);
  });

  it("still refuses an outcome it can't read", async () => {
    const { f, w } = await spawned();
    await expect(tool(f, "initiative_report", { outcome: "partial", summary: "Half.", report: "Half." }, w.threadId)).rejects.toThrow(/outcome/);
  });

  it("a blocked report without a question waits on the lead: no Inbox card, the worker shows Waiting", async () => {
    const { f, project, w } = await spawned();
    await tool(f, "initiative_report", { outcome: "blocked", summary: "Rebased, not pushed: the pre-push hook wants a rewrite confirmation.", report: "Details." }, w.threadId);
    f.idle(w.threadId);
    expect(f.store.assignment(project.id, 1)!.report).toMatchObject({ outcome: "blocked" });
    expect(f.store.assignment(project.id, 1)!.report!.blocker).toBeUndefined();
    expect(sentTexts(f).at(-1)).toContain(`${w.worker} is blocked on A1: Rebased, not pushed`);
    const o = await f.overview(project.id, "summary");
    expect([o.blockers.length, needsYouCount(o), o.workerGroups?.[w.worker]?.group]).toEqual([0, 0, "waiting"]);
    expect(((await f.harness.callRpc("tree", null)) as any).projects[0].needsYou).toBe(0);
  });

  it("a blocked report with a question still asks the user", async () => {
    const { f, project, w } = await spawned();
    await tool(f, "initiative_report", { outcome: "blocked", summary: "Need a key.", question: "Which staging key?", report: "Blocked." }, w.threadId);
    f.idle(w.threadId);
    const o = await f.overview(project.id, "summary");
    expect([o.blockers.length, needsYouCount(o), o.workerGroups?.[w.worker]?.group]).toEqual([1, 1, "needs"]);
  });
});

describe("W492 initiative_message", () => {
  it("a worker naming itself reaches its lead", async () => {
    const { f, w } = await spawned();
    expect(await tool(f, "initiative_message", { to: w.worker, text: "PR #12 is merge-ready." }, w.threadId))
      .toEqual({ to: "lead", delivery: expect.anything(), note: `${w.worker} is you, so this went to your lead.` });
    expect(f.send.mock.calls.at(-1)![0]).toMatchObject({ threadId: "coordinator" });
  });

  it("reaches a lead tab whose last turn failed, and a worker whose own work is being stopped can still say so", async () => {
    const { f, project, w } = await spawned();
    f.threads.set("coordinator", { ...f.threads.get("coordinator")!, status: "error" });
    await tool(f, "initiative_message", { to: "lead", text: "Heads-up." }, w.threadId);
    f.store.updateAssignment(project.id, 1, { cancelRequested: true });
    await tool(f, "initiative_message", { to: "lead", text: "Already pushed before your Stop." }, w.threadId);
    expect(f.send.mock.calls.slice(-2).map(([args]) => args.threadId)).toEqual(["coordinator", "coordinator"]);
  });

  it("more work for a worker still running its open work steers in as a message; queued, it is still refused", async () => {
    const { f, project, w } = await spawned();
    f.store.updateAssignment(project.id, 1, { state: "running" });
    f.threads.set(w.threadId, { ...f.threads.get(w.threadId)!, status: "active" });
    const assignments = f.store.assignments(project.id).length;
    expect(await tool(f, "initiative_message", { to: w.worker, text: "Also drop the retry.", work: true })).toEqual({ to: w.worker, delivery: expect.anything(),
      note: `${w.worker} is still working on A1, so this went to it as a steer message; its A1 report covers it.` });
    expect(f.send.mock.calls.at(-1)![0]).toMatchObject({ threadId: w.threadId, mode: "steer-if-active" });
    expect(f.store.assignments(project.id)).toHaveLength(assignments);
    await expect(tool(f, "initiative_message", { to: w.worker, text: "After that, the docs.", work: true, mode: "queue" })).rejects.toThrow(/this option was removed/);
  });
});

describe("W492 retiring a worker whose turn is still ending", () => {
  async function reported() {
    const { f, project, w } = await spawned();
    await tool(f, "initiative_report", { outcome: "done", summary: "Done.", report: "Done." }, w.threadId);
    f.threads.set(w.threadId, { ...f.threads.get(w.threadId)!, status: "active" });
    return { f, project, w };
  }

  it("answers retiring, and retires on the worker's idle event", async () => {
    const { f, project, w } = await reported();
    expect(await tool(f, "initiative_worker", { action: "retire", worker: w.worker, reason: "Merged." })).toEqual({ ref: w.worker, state: "retiring",
      note: `${w.worker} retires by itself once that ends (its thread is still running). More work for it before then cancels this.` });
    expect(f.archive).not.toHaveBeenCalled();
    await f.runtime.onThreadIdle(f.idle(w.threadId));
    expect(f.archive).toHaveBeenCalledWith({ threadId: w.threadId });
    expect(f.store.worker(project.id, 1)!.state).toBe("retired");
    expect(f.store.retireRequests()).toEqual([]);
  });

  it("is cancelled by more work given before the thread is quiet", async () => {
    const { f, project, w } = await reported();
    await tool(f, "initiative_worker", { action: "retire", worker: w.worker });
    f.idle(w.threadId);
    // Later than the request: the clock moved on.
    const request = f.store.retireRequests()[0]!;
    f.store.db.prepare("UPDATE workers SET retire_request = ? WHERE num = 1").run(JSON.stringify({ reason: request.reason, at: request.at - 10 }));
    await tool(f, "initiative_message", { to: w.worker, text: "One more pass.", work: true });
    await f.service.finishRetirements();
    expect(f.archive).not.toHaveBeenCalled();
    expect(f.store.worker(project.id, 1)!.state).not.toBe("retired");
    expect(f.store.retireRequests()).toEqual([]);
    expect(f.store.activity(project.id, -1).map((a) => a.summary)).toContain(`${w.worker} was not retired: it got more work after the request.`);
  });

  it("still refuses a worker with open work", async () => {
    const { f, w } = await spawned();
    await expect(tool(f, "initiative_worker", { action: "retire", worker: w.worker })).rejects.toThrow(/still has A1 open/);
  });
});

describe("W492 review r1", () => {
  const url = (n: number) => `https://github.com/o/r/pull/${n}`;

  it("stores a report blocked on the lead as the previous build reads a blocked report, and reads it back without a blocker", async () => {
    const { f, project, w } = await spawned();
    await tool(f, "initiative_report", { outcome: "blocked", summary: "Need a re-brief: the heads moved.", report: "Details." }, w.threadId);
    const row = f.store.db.prepare("SELECT report, blocked_on_lead FROM assignments WHERE project_id = ? AND num = 1").get(project.id) as { report: string; blocked_on_lead: number };
    expect(row.blocked_on_lead).toBe(1);
    // bd5b212's decoder: a blocked report must carry a blocker.
    const previous = reportSchema.refine((r) => r.outcome !== "blocked" || r.blocker);
    expect(previous.safeParse(JSON.parse(row.report)).success).toBe(true);
    expect(JSON.parse(row.report).blocker).toEqual({ question: "Need a re-brief: the heads moved.", context: "Need a re-brief: the heads moved." });
    expect(f.store.assignment(project.id, 1)!.report!.blocker).toBeUndefined();
    expect(f.store.reports(project.id, [1]).get(1)!.blocker).toBeUndefined();
    // A later filing with a question is the user's again.
    await tool(f, "initiative_report", { outcome: "blocked", summary: "Need a key.", question: "Which key?", report: "Blocked." }, w.threadId).catch(() => undefined);
  });

  it("tells a new coordinator which blocked workers wait on it, apart from what waits on the user", async () => {
    const { f, project, w } = await spawned();
    await tool(f, "initiative_report", { outcome: "blocked", summary: "Need a re-brief: the heads moved.", report: "Details." }, w.threadId);
    const packet = handoverPacket(f.store, project.id, emptySnapshot(Date.now(), "coordinator"), null);
    expect(packet).toContain("## Waiting on the user\nNothing.");
    expect(packet).toContain(`## Blocked on the coordinator\n- ${w.worker} reported blocked (A1, `);
    expect(packet).toContain("with no question for the user; the coordinator decides: Need a re-brief: the heads moved.");
  });

  it("keeps a PR a rule or another worker names by owner/repo#n, and one another Adventure holds or owns", async () => {
    const { f, project } = await projectFixture();
    await tool(f, "initiative_rule", { action: "add", text: "Do not change o/r#7." });
    const [a] = await tool(f, "initiative_spawn", { label: "A", purpose: "a", text: "Rebase o/r#8." });
    const [b] = await tool(f, "initiative_spawn", { label: "B", purpose: "b", text: "Other work." });
    await expect(tool(f, "initiative_pr", { prs: [{ url: url(7), stage: "working" }] }, b.threadId)).rejects.toThrow(/\(R1 names it\)/);
    await expect(tool(f, "initiative_pr", { prs: [{ url: url(8), stage: "working" }] }, b.threadId)).rejects.toThrow(new RegExp(`\\(${a.worker}'s ${a.assignment} names it\\)`));
    expect(await tool(f, "initiative_pr", { prs: [{ url: url(8), stage: "working" }] }, a.threadId)).toEqual({ prs: [{ url: url(8), stage: "working" }] });
    // Another open Adventure: its records, then its R2 owner.
    const other = f.store.createProject({ id: "ui", name: "Equisafe UI", objective: "UI", memberProjectIds: ["proj_ui"], coordinatorThreadId: null });
    f.store.savePrRecord(other.id, { ...blankPrRecord(url(9), 1), worker: "W3" });
    await expect(tool(f, "initiative_pr", { prs: [{ url: url(9), initiative: null }] }, b.threadId)).rejects.toThrow(/\(W3 in Equisafe UI holds it\)/);
    f.store.db.prepare("INSERT INTO pr_owners (url, project_id, source, set_at) VALUES (?, ?, 'manual', 1)").run(url(10), other.id);
    await expect(tool(f, "initiative_pr", { prs: [{ url: url(10), stage: "working" }] }, b.threadId)).rejects.toThrow(/\(Equisafe UI owns it\)/);
  });

  it("drops a retirement past its wait before trying it, even once the thread is quiet", async () => {
    const { f, project, w } = await spawned();
    await tool(f, "initiative_report", { outcome: "done", summary: "Done.", report: "Done." }, w.threadId);
    f.threads.set(w.threadId, { ...f.threads.get(w.threadId)!, status: "active" });
    await tool(f, "initiative_worker", { action: "retire", worker: w.worker });
    const at = Date.now() - 25 * 3_600_000;
    f.store.db.prepare("UPDATE workers SET retire_request = ? WHERE num = 1").run(JSON.stringify({ reason: "Merged.", at }));
    f.store.db.prepare("UPDATE assignments SET created_at = ? WHERE num = 1").run(at - 1);
    f.idle(w.threadId);
    await f.service.finishRetirements();
    expect(f.archive).not.toHaveBeenCalled();
    expect(f.store.worker(project.id, 1)!.state).not.toBe("retired");
    expect(f.store.activity(project.id, -1).map((a) => a.summary)).toContain(`${w.worker} was not retired: its thread was still busy 24 h after the request.`);
  });

  it("retries a retirement in the server's write queue, after the writes already in it", async () => {
    const { f, project, w } = await spawned();
    await tool(f, "initiative_report", { outcome: "done", summary: "Done.", report: "Done." }, w.threadId);
    f.threads.set(w.threadId, { ...f.threads.get(w.threadId)!, status: "active" });
    await tool(f, "initiative_worker", { action: "retire", worker: w.worker });
    f.idle(w.threadId);
    // More work already queued (behind a slow write) runs first, and cancels the request.
    let release!: () => void;
    const held = f.service.serialize(() => new Promise<void>((resolve) => { release = resolve; }));
    const more = f.perform(project.id, { action: "delegate", route: "continue", role: "work", worker: w.worker, note: "One more pass." } as never, "coordinator", "coordinator");
    const retry = f.service.finishRetirements();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(f.archive).not.toHaveBeenCalled();
    release();
    await Promise.all([held, more, retry]);
    expect(f.archive).not.toHaveBeenCalled();
    expect(f.store.retireRequests()).toEqual([]);
    expect(f.store.assignments(project.id)).toHaveLength(2);
  });
});

describe("W492 review r2", () => {
  it("lets a later filing by the previous build (a real question) count again", async () => {
    const { f, project, w } = await spawned();
    await tool(f, "initiative_report", { outcome: "blocked", summary: "Need a re-brief.", report: "Details." }, w.threadId);
    // bd5b212 re-files with a question: new JSON and report_seq, blocked_on_lead untouched.
    const report = { ...JSON.parse((f.store.db.prepare("SELECT report FROM assignments WHERE num = 1").get() as { report: string }).report), blocker: { question: "Which key?", context: "Ctx" } };
    f.store.db.prepare("UPDATE assignments SET report = ?, report_seq = report_seq + 1 WHERE num = 1").run(JSON.stringify(report));
    expect(f.store.assignment(project.id, 1)!.report!.blocker).toEqual({ question: "Which key?", context: "Ctx" });
    f.idle(w.threadId);
    const o = await f.overview(project.id, "summary");
    expect([o.blockers.length, needsYouCount(o), ((await f.harness.callRpc("tree", null)) as any).projects[0].needsYou]).toEqual([1, 1, 1]);
  });

  it("an Inbox answer sent to the worker cancels its waiting retirement", async () => {
    const { f, project, w } = await spawned();
    await tool(f, "initiative_report", { outcome: "blocked", summary: "Need a key.", question: "Which key?", report: "Blocked." }, w.threadId);
    f.threads.set(w.threadId, { ...f.threads.get(w.threadId)!, status: "active" });
    await tool(f, "initiative_worker", { action: "retire", worker: w.worker });
    f.idle(w.threadId);
    const blocker = f.store.assignment(project.id, 1)!.report!.blocker!;
    await f.service.answerBlocker(project.id, "A1", { question: blocker.question, context: blocker.context }, "Use staging.", "worker");
    expect(f.store.retireRequests()).toEqual([]);
    await f.service.finishRetirements();
    expect(f.archive).not.toHaveBeenCalled();
  });

  it("a lead's later retire replaces an earlier one that more work made moot", async () => {
    const { f, project, w } = await spawned();
    await tool(f, "initiative_report", { outcome: "done", summary: "Done.", report: "Done." }, w.threadId);
    f.threads.set(w.threadId, { ...f.threads.get(w.threadId)!, status: "active" });
    await tool(f, "initiative_worker", { action: "retire", worker: w.worker, reason: "First." });
    const first = f.store.retireRequests()[0]!;
    f.store.db.prepare("UPDATE workers SET retire_request = ? WHERE num = 1").run(JSON.stringify({ reason: "First.", at: first.at - 10 }));
    f.idle(w.threadId);
    await tool(f, "initiative_message", { to: w.worker, text: "One more pass.", work: true });
    await tool(f, "initiative_report", { outcome: "done", summary: "Done again.", report: "Done." }, w.threadId);
    f.threads.set(w.threadId, { ...f.threads.get(w.threadId)!, status: "active" });
    await tool(f, "initiative_worker", { action: "retire", worker: w.worker, reason: "Second." });
    expect(f.store.retireRequests()).toEqual([expect.objectContaining({ reason: "Second." })]);
    await f.runtime.onThreadIdle(f.idle(w.threadId));
    expect(f.store.worker(project.id, 1)!.state).toBe("retired");
  });
});

describe("W492 review r3", () => {
  async function blockedOnUser() {
    const { f, project, w } = await spawned();
    await tool(f, "initiative_report", { outcome: "blocked", summary: "Need a key.", question: "Which key?", report: "Blocked." }, w.threadId);
    const blocker = f.store.assignment(project.id, 1)!.report!.blocker!;
    return { f, project, w, seen: { question: blocker.question, context: blocker.context } };
  }

  it("an answer to the worker waits for a retire already running, then cancels the request it stored", async () => {
    const { f, project, w, seen } = await blockedOnUser();
    f.threads.set(w.threadId, { ...f.threads.get(w.threadId)!, status: "active" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    f.intercept(async (path, args, call) => {
      if (path === "threads.get" && args.threadId === w.threadId && !held) {
        held = true;
        await gate;
      }
      return call();
    });
    const retire = f.perform(project.id, { action: "worker-retire", worker: w.worker, reason: "Done." } as never, "coordinator", "coordinator");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const answer = f.service.answerBlocker(project.id, "A1", seen, "Use staging.", "worker");
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    expect(await retire).toMatchObject({ state: "retiring" });
    await answer;
    f.intercept();
    expect(f.store.retireRequests()).toEqual([]);
    await f.runtime.onThreadIdle(f.idle(w.threadId));
    expect(f.archive).not.toHaveBeenCalled();
  });

  it("a retried FYI to the lead leaves a later retirement waiting", async () => {
    const { f, project, w, seen } = await blockedOnUser();
    const answered = await f.service.answerBlocker(project.id, "A1", seen, "Use staging.", "worker");
    // The worker got it; the FYI to its lead failed. Later the lead asks to retire the worker.
    const notification = JSON.parse((f.store.db.prepare("SELECT decision_notification FROM knowledge WHERE project_id = ? AND num = ?").get(project.id, Number(answered.ref.slice(1))) as { decision_notification: string }).decision_notification);
    f.store.db.prepare("UPDATE knowledge SET decision_notification = ? WHERE project_id = ? AND num = ?").run(JSON.stringify({ ...notification, state: "failed" }), project.id, Number(answered.ref.slice(1)));
    f.store.requestRetire(project.id, 1, "Merged.", Date.now());
    await f.service.answerBlocker(project.id, "A1", seen, "Use staging.", "worker");
    expect(f.store.retireRequests()).toEqual([expect.objectContaining({ reason: "Merged." })]);
  });
});

describe("W492 review r4", () => {
  it("an answer to the worker runs after a continuation queued before it, against the ledger as it then is", async () => {
    const { f, project, w } = await spawned();
    await tool(f, "initiative_report", { outcome: "blocked", summary: "Need a key.", question: "Which key?", report: "Blocked." }, w.threadId);
    f.idle(w.threadId);
    const blocker = f.store.assignment(project.id, 1)!.report!.blocker!;
    let release!: () => void;
    const held = f.service.serialize(() => new Promise<void>((resolve) => { release = resolve; }));
    const more = f.perform(project.id, { action: "delegate", route: "continue", role: "work", worker: w.worker, note: "Use staging; carry on." } as never, "coordinator", "coordinator");
    const answer = f.service.answerBlocker(project.id, "A1", { question: blocker.question, context: blocker.context }, "Use prod.", "worker");
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await Promise.all([held, more]);
    await expect(answer).rejects.toThrow(/no longer waiting on a blocker/);
    expect(sentTexts(f).some((t) => t.includes("Continue A1"))).toBe(false);
  });

  it("steers more work in only while the thread runs; an idle one takes the usual path and its checks", async () => {
    const { f, project, w } = await spawned();
    f.store.updateAssignment(project.id, 1, { state: "running" });
    f.idle(w.threadId);
    await expect(tool(f, "initiative_message", { to: w.worker, text: "Also drop the retry.", work: true })).rejects.toThrow(/still working on A1/);
  });

  it("new work cancels a waiting retirement whatever the clocks say", async () => {
    const { f, project, w } = await spawned();
    await tool(f, "initiative_report", { outcome: "done", summary: "Done.", report: "Done." }, w.threadId);
    f.threads.set(w.threadId, { ...f.threads.get(w.threadId)!, status: "active" });
    await tool(f, "initiative_worker", { action: "retire", worker: w.worker });
    // A request dated at (or after) the new work's creation.
    f.store.requestRetire(project.id, 1, "Merged.", Date.now() + 60_000);
    f.idle(w.threadId);
    await tool(f, "initiative_message", { to: w.worker, text: "One more pass.", work: true });
    expect(f.store.retireRequests()).toEqual([]);
    expect(f.store.activity(project.id, -1).map((a) => a.summary)).toContain(`${w.worker} was not retired: it got more work after the request.`);
  });
});
