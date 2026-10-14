import { describe, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { projectFixture } from "./fake-native";
import { renderAssignment, reviewerCommand, workLoopBlock, ownBriefText } from "../lib/brief";
import { RunningChildren } from "../lib/context";
import { settledChildPage } from "./helpers";

// v9 round 3 (W438's review A623, D522): one regression per finding, each failing on the r2 patch.

type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const tool = async (f: Fx, name: string, input: unknown, threadId = "coordinator") =>
  JSON.parse((await f.harness.callAgentTool(name, input, { threadId })) as string);
const childOf = (f: Fx, id: string, parentThreadId: string, status = "active", extra: Record<string, unknown> = {}) => {
  const t = { ...makeThreadResponse({ id, projectId: "proj_a", parentThreadId, status: status as never, title: `Thread ${id}`, createdAt: Date.now() }), ...extra };
  f.threads.set(id, t as never);
  return t;
};
const stopped = (f: Fx) => f.stop.mock.calls.map((call) => (call as unknown as [{ threadId: string }])[0].threadId);
const refusedWith = (message: string) => (async () => { throw Object.assign(new Error(message), { status: 503 }); }) as never;
/** BB's real child listing: archived children too, unless `archived` picks a side (the fake hides them). */
const realChildListing = (f: Fx) => f.intercept((path, args, call) => {
  if (path !== "threads.list" || !args?.parentThreadId) return call();
  return Promise.resolve([...f.threads.values()]
    .filter((t: any) => t.parentThreadId === args.parentThreadId && t.deletedAt == null)
    .filter((t: any) => args.archived === true ? t.archivedAt != null : args.archived === false ? t.archivedAt == null : true)
    .slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 200))
    .map((t: any) => ({ ...t, activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activeGoalCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 }, hasPendingInteraction: false, queuedWork: "none" })));
});
const within = <T,>(promise: Promise<T>, ms = 1000) =>
  Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms))]);

describe("R1 the dashboard's first answer never waits on a descendant walk", () => {
  it("summary and full overviews answer while a worker's child listing hangs, and list nothing natively for it", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "Search", purpose: "search", text: "Do it." });
    childOf(f, "helper", w.threadId, "idle");
    const listed: string[] = [];
    f.intercept((path, args, call) => {
      if (path === "threads.list" && args?.parentThreadId) {
        listed.push(args.parentThreadId);
        return new Promise(() => undefined);
      }
      return call();
    });
    await within(f.harness.callRpc("overview", { projectId: project.id, detail: "summary" }));
    await within(f.harness.callRpc("overview", { projectId: project.id }));
    await within(f.harness.callRpc("panel", { threadId: w.threadId }));
    f.intercept();
    expect(listed).toEqual([]);
  });
});

describe("R2 Stop and waiting read the native activity archive reads", () => {
  it("an idle helper with a background agent and one with a queued message are stopped, and the worker waits on them", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "Fix", purpose: "fix", text: "Fix it." });
    childOf(f, "agent", w.threadId, "idle", { activeBackgroundAgentCount: 1 });
    childOf(f, "queued", w.threadId, "idle", { queuedMessageCount: 1 });
    childOf(f, "quiet", w.threadId, "idle");
    f.stop.mockClear();
    const result = await tool(f, "initiative_worker", { action: "stop", worker: "W1", reason: "Dropped." });
    expect(stopped(f)).toEqual(expect.arrayContaining(["agent", "queued"]));
    expect(stopped(f)).not.toContain("quiet");
    expect(result).toMatchObject({ stoppedChildren: 2 });
    // The sweep's listing feeds the same predicate to the Workers tab.
    await f.service.associateNativeChildren(project.id);
    const o = (await f.harness.callRpc("overview", { projectId: project.id })) as { workerWaiting: Record<string, { on: { threadId: string; running: string } | null }> };
    expect(o.workerWaiting.W1!.on).toMatchObject({ running: expect.stringMatching(/background work|queued work/) });
  });
});

describe("R3 the walk goes through archived children", () => {
  it("Stop reaches an active grandchild BB restored under an archived helper, and the worker waits on it", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "Fix", purpose: "fix", text: "Fix it." });
    childOf(f, "helper", w.threadId, "idle", { archivedAt: Date.now() });
    childOf(f, "restored", "helper", "active");
    realChildListing(f);
    f.stop.mockClear();
    const result = await tool(f, "initiative_worker", { action: "stop", worker: "W1", reason: "Dropped." });
    expect(stopped(f)).toContain("restored");
    expect(stopped(f)).not.toContain("helper");
    expect(result).toMatchObject({ stoppedChildren: 1 });
    // Stop's walk filled the cache the Workers tab reads, through the archived helper.
    const o = (await f.harness.callRpc("overview", { projectId: project.id })) as { workerWaiting: Record<string, { on: { threadId: string } | null; checked: boolean }> };
    expect(o.workerWaiting.W1).toMatchObject({ on: { threadId: "restored" }, checked: true });
  });
});

describe("R4 Stop all work includes idle open work", () => {
  it("cancels an idle_no_report assignment and stops the reviewer under it", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "Adopted", purpose: "adopted", text: "Do it." });
    // As adoption leaves it: open, idle, no report.
    f.store.updateAssignment(project.id, 1, { state: "idle_no_report" });
    f.threads.set(w.threadId, { ...f.threads.get(w.threadId)!, status: "idle" });
    childOf(f, "reviewer", w.threadId, "active");
    f.stop.mockClear();
    const results = await f.perform(project.id, { action: "stop-work" }, "user", null);
    expect(results).toEqual(["A1 stopped (1 running child thread stopped)"]);
    expect(stopped(f)).toContain("reviewer");
    expect(f.store.assignment(project.id, 1)!.state).toBe("cancelled");
  });
});

describe("R5 a refused Stop of the worker's own thread is reported", () => {
  it("cancelling open work through worker Stop names the parent Stop BB refused", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "Fix", purpose: "fix", text: "Fix it." });
    f.threads.set(w.threadId, { ...f.threads.get(w.threadId)!, status: "active" });
    f.store.updateAssignment(project.id, 1, { state: "running" });
    f.stop.mockImplementation(refusedWith("host offline"));
    const result = await tool(f, "initiative_worker", { action: "stop", worker: "W1", reason: "Dropped." });
    expect(result).toMatchObject({ worker: "W1", assignment: "A1", state: "cancelled", notStopped: ["W1's thread (host offline)"] });
    expect(f.store.activity(project.id, 5).map((a) => a.summary)).toContain("W1 stopped: Dropped. (not stopped: W1's thread (host offline))");
  });
});

describe("R6 Cancel task says which work may still run", () => {
  it("returns the helper BB refused to stop with the cancelled task", async () => {
    const { f, project } = await projectFixture();
    const t = f.task(project.id);
    const [w] = await tool(f, "initiative_spawn", { label: "Fix", purpose: "fix", text: "Fix it.", tasks: [t.ref] });
    childOf(f, "helper", w.threadId, "active");
    f.stop.mockImplementation((async ({ threadId }: { threadId: string }) => {
      if (threadId === "helper") throw new Error("host offline");
      return {};
    }) as never);
    const result = await f.perform(project.id, { action: "task-status", task: t.ref, status: "cancelled", reason: "Dropped." }, "user", null);
    expect(result).toMatchObject({ ref: t.ref, status: "cancelled", notStopped: ['"Thread helper" (host offline)'] });
  });
});

describe("R7 an answer to a deleted discussion goes to the coordinator", () => {
  it("BB's 404 for the asking tab is a deleted tab, not a target", async () => {
    const { f, project } = await projectFixture();
    const { threadId: chat } = (await f.harness.callRpc("discussionCreate", { projectId: project.id })) as { threadId: string };
    const asked = await tool(f, "initiative_question", { question: "Pages or a queue consumer?", context: "Both work." }, chat);
    f.threads.delete(chat);
    f.intercept((path, args, call) => path === "threads.get" && args?.threadId === chat
      ? Promise.reject(Object.assign(new Error("Thread not found"), { status: 404 })) : call());
    f.send.mockClear();
    await f.harness.callRpc("command", { projectId: project.id, command: { action: "answer", decision: asked.ref, choice: null, note: "Pages." } });
    expect(f.send.mock.calls.map(([a]) => a.threadId)).toEqual(["coordinator"]);
  });

  it("control: another read failure keeps the tab, so its send says what happened", async () => {
    const { f, project } = await projectFixture();
    const { threadId: chat } = (await f.harness.callRpc("discussionCreate", { projectId: project.id })) as { threadId: string };
    f.intercept((path, args, call) => path === "threads.get" && args?.threadId === chat
      ? Promise.reject(Object.assign(new Error("BB unavailable"), { status: 503 })) : call());
    expect(await f.service.liveLead(f.store.project(project.id)!, chat)).toBe(chat);
  });
});

describe("R8 the shared appendix is cut where the brief puts it", () => {
  it("guidance that names a PR and then quotes the loop heading leaves no PR in the worker's own text", () => {
    const heading = "How you work in this Initiative (current; replaces anything earlier):";
    const guidance = `Follow the patterns in https://github.com/o/r/pull/7.\n\nWhen you brief a helper, paste the block that starts:\n\n${heading}\n\nand keep it whole.`;
    const reviewer = reviewerCommand({ providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "high", serviceTier: null } as never);
    const text = renderAssignment({ assignmentRef: "A2", workerRef: "W1", workerLabel: "Fix", workerPurpose: "fix", role: "work", tasks: [], reviewOf: [],
      reviewed: null, priorReports: [], text: "Also fix https://github.com/o/r/pull/8.", appendix: workLoopBlock(guidance, reviewer, "Standing rules: none yet."), opId: "op_abc" });
    const own = ownBriefText(text);
    expect(own).toContain("pull/8");
    expect(own).not.toContain("pull/7");
    expect(own.endsWith("Finish by calling initiative_report with your full report.")).toBe(true);
  });
});

describe("R9 a child read that fails is a failure, never a complete empty tree", () => {
  it("before any listing the worker's tree is unchecked; a failed page rejects instead of answering no children", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "Fix", purpose: "fix", text: "Fix it." });
    childOf(f, "helper", w.threadId, "idle");
    const o = (await f.harness.callRpc("overview", { projectId: project.id })) as { workerWaiting: Record<string, unknown> };
    expect(o.workerWaiting.W1).toEqual({ on: null, checked: false });
    f.intercept((path, args, call) => path === "threads.list" && args?.parentThreadId === w.threadId ? Promise.reject(new Error("BB unavailable")) : call());
    expect(await settledChildPage(f.harness, { projectId: project.id, threadId: w.threadId })).toEqual({ status: "failed", error: expect.stringMatching(/BB unavailable/) });
    // A failed sweep listing keeps what the last good one said.
    f.intercept();
    await f.service.associateNativeChildren(project.id);
    f.intercept((path, args, call) => path === "threads.list" && args?.parentThreadId === w.threadId ? Promise.reject(new Error("BB unavailable")) : call());
    await f.service.associateNativeChildren(project.id).catch(() => undefined);
    const after = (await f.harness.callRpc("overview", { projectId: project.id })) as { workerWaiting: Record<string, unknown> };
    expect(after.workerWaiting.W1).toEqual({ on: null, checked: true });
  });
});

describe("R10 every child is reachable, page by page", () => {
  it("501 direct children: the last one is on the sixth page", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "Fix", purpose: "fix", text: "Fix it." });
    for (let n = 1; n <= 501; n++) childOf(f, `c${n}`, w.threadId, n === 501 ? "active" : "idle");
    const seen: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = await settledChildPage(f.harness, { projectId: project.id, threadId: w.threadId, offset });
      if (page.status !== "ready") throw new Error(page.error);
      seen.push(...page.value.rows.map((r) => r.threadId));
      offset = page.value.next;
    }
    expect(seen).toHaveLength(501);
    expect(seen.at(-1)).toBe("c501");
  });
});

describe("R11 an older listing does not overwrite a newer lifecycle event", () => {
  it("a reviewer that went idle during the listing stays finished; one started during it stays running", () => {
    const cache = new RunningChildren();
    const row = (id: string, status: string) => ({ id, parentThreadId: "W", status: status as never, archivedAt: null, deletedAt: null, title: id });
    const epoch = cache.begin();
    // Events that land while the listing is in flight.
    cache.observe(row("old", "idle"));
    cache.observe(row("new", "active"));
    // The listing, read before both events.
    cache.listed("W", [row("old", "active")], epoch);
    expect(cache.of("W")).toMatchObject({ threadId: "new" });
    cache.observe(row("new", "idle"));
    expect(cache.of("W")).toBeNull();
  });
});

describe("R12 every accepted rule round-trips through export and import", () => {
  it("the agent tool refuses a rule on two lines and a source with a comma, as the commands do", async () => {
    const { f, project } = await projectFixture();
    await expect(tool(f, "initiative_rule", { action: "add", text: "Every PR targets dev.\nNever force-push." })).rejects.toThrow(/one line/);
    await expect(tool(f, "initiative_rule", { action: "add", text: "Every PR targets dev.", sources: ["D1, D2"] })).rejects.toThrow(/without commas/);
    await tool(f, "initiative_rule", { action: "add", text: "Every PR targets dev. Never force-push.", sources: ["D1", "D2"] });
    await expect(tool(f, "initiative_rule", { action: "edit", rule: "R1", text: "Every PR targets dev.\nNever force-push." })).rejects.toThrow(/one line/);
    const exported = f.service.exportRules(project.id);
    expect(await f.service.importRules(project.id, exported, null)).toMatchObject({ note: "Unchanged." });
  });
});

describe("Legacy assignment Stop", () => {
  it("bb initiative command assignment-stop ends the work's running descendants too", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "Fix", purpose: "fix", text: "Fix it." });
    childOf(f, "helper", w.threadId, "active");
    f.stop.mockClear();
    const result = await f.perform(project.id, { action: "assignment-stop", assignment: "A1", reason: "Replaced." }, "coordinator", "coordinator");
    expect(stopped(f)).toContain("helper");
    expect(result).toMatchObject({ assignment: "A1", state: "cancelled", stoppedChildren: 1 });
  });
});
