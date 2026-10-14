import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { projectFixture, report } from "./fake-native";
import { settledChildPage } from "./helpers";

// v9 round 2 (W434's review, D522): one regression per finding, each failing on the v9 patch.

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const tool = async (f: Fx, name: string, input: unknown, threadId = "coordinator") =>
  JSON.parse((await f.harness.callAgentTool(name, input, { threadId })) as string);

describe("F2/F3 a task's PRs", () => {
  it("F2: come from every linking assignment, so a follow-up that doesn't repeat the PR still waits for it", async () => {
    const { f, project } = await projectFixture();
    const t = f.task(project.id);
    const [w] = await tool(f, "initiative_spawn", { label: "Fix", purpose: "fix", text: "Fix it.", tasks: [t.ref] });
    await tool(f, "initiative_report", { outcome: "done", summary: "PR https://github.com/o/r/pull/7 is ready.", report: "…" }, w.threadId);
    f.store.markPrsOpen(["https://github.com/o/r/pull/7"], Date.now());
    await tool(f, "initiative_message", { to: "W1", text: "Check the follow-up analysis.", work: true, tasks: [t.ref] });
    await tool(f, "initiative_report", { outcome: "done", summary: "Analysis done; nothing else to change.", report: "No findings." }, w.threadId);
    expect(f.store.task(project.id, t.num)).toMatchObject({ status: "in_progress", statusReason: "#7 open" });
  });

  it("F3: come from the whole report (summary, evidence), the same extractor the state lookup uses", async () => {
    const { f, project } = await projectFixture();
    const t = f.task(project.id);
    const [w] = await tool(f, "initiative_spawn", { label: "Fix", purpose: "fix", text: "Fix it.", tasks: [t.ref] });
    const legacy = { ...report(), summary: "Opened https://github.com/o/r/pull/8 for review.",
      evidence: [{ kind: "artifact" as const, label: "PR", ref: "o/r#9" }],
      handoff: { ...report().handoff, summary: "Implemented." } };
    await f.service.report(w.threadId, legacy);
    expect(f.store.task(project.id, t.num)).toMatchObject({ status: "in_progress", statusReason: "#8 state not known yet" });
    // Every PR the status reads is one the lookup pass tracks, and vice versa.
    expect(f.store.prsToLookUp(new Set(), Date.now(), 10).sort()).toEqual(["https://github.com/o/r/pull/8", "https://github.com/o/r/pull/9"]);
    f.store.savePrLookup("https://github.com/o/r/pull/8", Date.now(), { state: "MERGED", mergedAt: Date.now(), closedAt: Date.now() });
    expect(f.store.task(project.id, t.num)).toMatchObject({ status: "in_progress", statusReason: "#9 state not known yet" });
  });

  it("F3: the lookup reads owner/repo#12 after a newline as that PR, not one glued to the escaped \\n", async () => {
    const { f, project } = await projectFixture();
    const t = f.task(project.id);
    const [w] = await tool(f, "initiative_spawn", { label: "Fix", purpose: "fix", text: "Fix it.", tasks: [t.ref] });
    await tool(f, "initiative_report", { outcome: "done", summary: "Done.", report: "Opened:\no/r#12" }, w.threadId);
    expect(f.store.prsToLookUp(new Set(), Date.now(), 10)).toEqual(["https://github.com/o/r/pull/12"]);
  });
});

describe("F4 a PR a standing rule names belongs to no worker", () => {
  it("every brief still carries the rule, but no worker owns its PR; the brief's own PR stays the worker's", async () => {
    const { f, project } = await projectFixture();
    await tool(f, "initiative_rule", { action: "add", text: "Follow the patterns in https://github.com/o/r/pull/7; do not change that PR." });
    const [a] = await tool(f, "initiative_spawn", { label: "Search", purpose: "search", text: "Do it." });
    const [b] = await tool(f, "initiative_spawn", { label: "Fix", purpose: "fix", text: "Fix https://github.com/o/r/pull/8." });
    expect(f.store.assignment(project.id, 2)!.briefText).toContain("R1. Follow the patterns in https://github.com/o/r/pull/7");
    for (const w of [a, b])
      await expect(tool(f, "initiative_pr", { prs: [{ url: "https://github.com/o/r/pull/7", stage: "in-review" }] }, w.threadId)).rejects.toThrow();
    await tool(f, "initiative_pr", { prs: [{ url: "https://github.com/o/r/pull/8", stage: "in-review" }] }, b.threadId);
    expect(f.store.prRecords(project.id).get("https://github.com/o/r/pull/8")?.stage).toBe("in-review");
    // A follow-up message carries the whole loop block (guidance, reviewer, rules): still not the worker's PR.
    await tool(f, "initiative_report", { outcome: "done", summary: "Done.", report: "Done." }, a.threadId);
    await tool(f, "initiative_message", { to: "W1", text: "One more pass.", work: true });
    await expect(tool(f, "initiative_pr", { prs: [{ url: "https://github.com/o/r/pull/7", stage: "in-review" }] }, a.threadId)).rejects.toThrow();
  });
});

describe("F6 no new review assignments through the retained paths", () => {
  it("bb initiative command and initiative_delegate refuse role:review; a pre-switch reviewer still reports", async () => {
    const { f, project } = await projectFixture();
    const t = f.task(project.id);
    const [w] = await tool(f, "initiative_spawn", { label: "Fix", purpose: "fix", text: "Fix it.", tasks: [t.ref] });
    await tool(f, "initiative_report", { outcome: "done", summary: "Done.", report: "Done." }, w.threadId);
    // A reviewer the previous build started (the service itself still runs one).
    const [reviewer] = await f.service.delegate(project.id, { route: "fresh", role: "review", reviews: "W1", label: "Review", area: "Review" });
    f.spawn.mockClear();
    const cli = await f.harness.runCli(["command", JSON.stringify({ action: "delegate", route: "fresh", role: "review", reviews: "W1", label: "R", area: "R" }), project.id], { threadId: "coordinator" });
    expect(cli.exitCode).not.toBe(0);
    expect(`${cli.stdout}${cli.stderr}`).toContain("Workers run their own reviews now");
    await expect(tool(f, "initiative_delegate", { route: "fresh", role: "review", reviews: "W1", label: "R", area: "R" })).rejects.toThrow(/Workers run their own reviews now/);
    expect(f.spawn).not.toHaveBeenCalled();
    const filed = await tool(f, "initiative_report", { outcome: "done", summary: "Clean.", report: "No findings." }, reviewer.threadId!);
    expect(filed).toMatchObject({ assignment: reviewer.assignment, state: "reported" });
  });
});

const discussion = async (f: Fx, projectId: string, title = "Chat 2") => {
  const { threadId } = (await f.harness.callRpc("discussionCreate", { projectId })) as { threadId: string };
  f.threads.set(threadId, { ...f.threads.get(threadId)!, title, status: "idle" });
  return threadId;
};

describe("F5 an import is a rule change like any other", () => {
  it("import and its undo reach the live lead tabs and the workers with open work, and say whom", async () => {
    const { f, project } = await projectFixture();
    const dir = mkdtempSync(join(tmpdir(), "v9-r2-rules-"));
    scratch.push(dir);
    const chat = await discussion(f, project.id);
    const [busy] = await tool(f, "initiative_spawn", { label: "Busy", purpose: "busy", text: "Work." });
    await tool(f, "initiative_rule", { action: "add", text: "Old rule." });
    f.send.mockClear();
    const file = join(dir, "rules.md");
    writeFileSync(file, "R1. Every PR targets dev.\n");
    const imported = await f.harness.runCli(["rules", "import", project.id, file]);
    expect(imported.exitCode).toBe(0);
    const tab = f.store.projectThreadByThreadId(chat)!.label;
    expect(JSON.parse(imported.stdout!)).toMatchObject({ rules: 1, reached: ["the coordinator", tab, "W1"] });
    expect(f.send.mock.calls.map(([a]) => a.threadId)).toEqual(["coordinator", chat, busy.threadId]);
    expect(f.send.mock.calls[0]![0].input[0].text).toContain("The standing rules were replaced by an import (1 rule).");
    // The undo is an import too; from a lead tab, that tab isn't told its own change.
    f.send.mockClear();
    const undo = await f.harness.runCli(JSON.parse(imported.stdout!).undo.split(" ").slice(2), { threadId: chat });
    expect(undo.exitCode).toBe(0);
    expect(JSON.parse(undo.stdout!)).toMatchObject({ reached: ["the coordinator", "W1"] });
    expect(f.store.rules(project.id).map((r) => r.text)).toEqual(["Old rule."]);
    // The same list again changes nothing and tells no one.
    f.send.mockClear();
    const again = await f.harness.runCli(JSON.parse(imported.stdout!).undo.split(" ").slice(2));
    expect(JSON.parse(again.stdout!)).toMatchObject({ note: "Unchanged." });
    expect(f.send).not.toHaveBeenCalled();
  });
});

describe("F7 an answer goes to the asking tab only while BB has it open", () => {
  it("a question from a since-archived discussion is answered to the coordinator tab", async () => {
    const { f, project } = await projectFixture();
    const chat = await discussion(f, project.id);
    const asked = await tool(f, "initiative_question", { question: "Pages or a queue consumer?", context: "Both work." }, chat);
    f.threads.set(chat, { ...f.threads.get(chat)!, archivedAt: Date.now() });
    await f.harness.emitThreadEvent("thread.archived", { thread: f.threads.get(chat) as never });
    f.send.mockClear();
    await f.harness.callRpc("command", { projectId: project.id, command: { action: "answer", decision: asked.ref, choice: null, note: "Pages." } });
    expect(f.send.mock.calls.map(([a]) => a.threadId)).toEqual(["coordinator"]);
    expect(f.store.decisionItem(project.id, Number(asked.ref.slice(1)))!.notification).toMatchObject({ coordinatorThreadId: "coordinator", state: "sent" });
  });

  it("control: while the discussion is open, the answer goes back to it", async () => {
    const { f, project } = await projectFixture();
    const chat = await discussion(f, project.id);
    const asked = await tool(f, "initiative_question", { question: "Pages or a queue consumer?", context: "Both work." }, chat);
    f.send.mockClear();
    await f.harness.callRpc("command", { projectId: project.id, command: { action: "answer", decision: asked.ref, choice: null, note: "Pages." } });
    expect(f.send.mock.calls.map(([a]) => a.threadId)).toEqual([chat]);
  });
});

const childOf = (f: Fx, id: string, parentThreadId: string, status = "active", at = Date.now()) => {
  const t = makeThreadResponse({ id, projectId: "proj_a", parentThreadId, status: status as never, title: `Thread ${id}`, createdAt: at });
  f.threads.set(id, t);
  return t;
};
const stopped = (f: Fx) => f.stop.mock.calls.map((call) => (call as unknown as [{ threadId: string }])[0].threadId);

describe("F8 the running-child context survives a reload", () => {
  it("a reviewer running before any event is named once the background discovery has listed it; a missed archive clears it", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "Search", purpose: "search", text: "Do it." });
    // Already running when the plugin (re)loaded: no lifecycle event will come for it.
    childOf(f, "review-r1", w.threadId);
    const review = async () => ((await (await f.harness.fetchHttp("GET", `/context/v1/thread?threadId=${w.threadId}`)).json()) as { membership: { review: unknown } }).membership.review;
    expect(await review()).toBeNull();
    await f.service.associateNativeChildren(project.id);
    expect(await review()).toMatchObject({ ref: "review-r1", worker: "W1", phase: "running" });
    // Archived while no event reached the plugin: the next listing ends it.
    f.threads.set("review-r1", { ...f.threads.get("review-r1")!, archivedAt: Date.now(), status: "idle" });
    await f.service.associateNativeChildren(project.id);
    expect(await review()).toBeNull();
  });
});

describe("F9 the Workers tab reaches every descendant", () => {
  it("pages past 50 children and lists a helper's own (running) child under it", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "Search", purpose: "search", text: "Do it." });
    await tool(f, "initiative_report", { outcome: "done", summary: "Done.", report: "Done." }, w.threadId);
    f.threads.set(w.threadId, { ...f.threads.get(w.threadId)!, status: "idle" });
    for (let n = 1; n <= 51; n++) childOf(f, `c${n}`, w.threadId, "idle", Date.now() - n);
    childOf(f, "gc", "c1", "active");
    // v9 r3: read live a level and a page at a time (childPage), never by the overview.
    const page = async (threadId: string) => {
      const answer = await settledChildPage(f.harness, { projectId: project.id, threadId });
      if (answer.status !== "ready") throw new Error(answer.error);
      return answer.value;
    };
    const top = await page(w.threadId);
    expect(top.rows).toHaveLength(51);
    expect(top.rows.map((r) => r.threadId)).toContain("c51");
    expect(top.next).toBeNull();
    expect((await page("c1")).rows).toEqual([expect.objectContaining({ threadId: "gc", running: "active" })]);
  });
});

describe("F10 cancelling a task or stopping all work stops the workers' children too", () => {
  it("task cancel", async () => {
    const { f, project } = await projectFixture();
    const t = f.task(project.id);
    const [w] = await tool(f, "initiative_spawn", { label: "Fix", purpose: "fix", text: "Fix it.", tasks: [t.ref] });
    childOf(f, "helper", w.threadId);
    childOf(f, "helper-child", "helper");
    f.stop.mockClear();
    await f.perform(project.id, { action: "task-status", task: t.ref, status: "cancelled", reason: "Dropped." }, "user", null);
    expect(stopped(f)).toEqual(expect.arrayContaining([w.threadId, "helper", "helper-child"]));
    expect(f.store.assignment(project.id, 1)!.state).toBe("cancelled");
  });

  it("stop initiative work", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "Fix", purpose: "fix", text: "Fix it." });
    childOf(f, "helper", w.threadId);
    f.stop.mockClear();
    const results = await f.perform(project.id, { action: "stop-work" }, "user", null);
    expect(stopped(f)).toEqual(expect.arrayContaining([w.threadId, "helper"]));
    expect(results).toEqual(["A1 stopped (1 running child thread stopped)"]);
  });
});

describe("F11 Stop says which child threads it could not stop", () => {
  it("a refused child Stop is named, not counted; a partial walk says so", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "Fix", purpose: "fix", text: "Fix it." });
    childOf(f, "ok", w.threadId);
    childOf(f, "offline", w.threadId);
    f.stop.mockImplementation((async ({ threadId }: { threadId: string }) => {
      if (threadId === "offline") throw new Error("host offline");
      return {};
    }) as never);
    const result = await tool(f, "initiative_worker", { action: "stop", worker: "W1", reason: "Dropped." });
    expect(result).toMatchObject({ worker: "W1", state: "cancelled", stoppedChildren: 1, notStopped: ['"Thread offline" (host offline)'] });
    expect(f.store.activity(project.id, 5).map((a) => a.summary)).toContain('W1 stopped: Dropped. (1 running child thread stopped; not stopped: "Thread offline" (host offline))');
    // A listing that fails claims nothing.
    f.stop.mockImplementation((async () => ({})) as never);
    f.intercept((path, args, call) => (path === "threads.list" && args.parentThreadId === w.threadId ? Promise.reject(new Error("BB unavailable")) : call()));
    const again = await tool(f, "initiative_worker", { action: "stop", worker: "W1", reason: "Again." });
    f.intercept();
    expect(again).toMatchObject({ stoppedChildren: 0, unverified: "its child threads could not be listed (BB unavailable)" });
    // The walk Stop and the Workers tab share says when it stopped at its budget.
    expect(await f.service.descendants(w.threadId, 1)).toMatchObject({ complete: false, threads: [{ id: "ok" }] });
  });
});
