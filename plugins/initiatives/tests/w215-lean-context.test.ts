import { describe, expect, it, vi } from "vitest";
import { projectFixture } from "./fake-native";
import { toolReceipt } from "../lib/receipts";
import { clearCatalogCache } from "../lib/bb";

// W215 (D428): the coordinator's context grows by what tools answer and what reports send it.
// Write tools answer with short receipts, a long report arrives as its summary, task listings
// are one line per task, and a coordinator whose context passes a limit is compacted between turns.
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const tool = async (f: Fx, name: string, input: unknown, threadId = "coordinator") => JSON.parse(await f.harness.callAgentTool(name, input, { threadId }) as string);
const sentTexts = (f: Fx) => f.send.mock.calls.map(([args]) => args.input[0].text as string);
let seq = 300000;

describe("W215 write receipts", () => {
  it("records come back as their ref and new state, without the text the coordinator wrote", () => {
    const task = { projectId: "p", num: 20, ref: "T20", title: "Review", summary: "x".repeat(2000), brief: { objective: "y" }, status: "done", progress: null };
    expect(toolReceipt(task)).toEqual({ ref: "T20", state: "done" });
    const worker = { ref: "W154", state: "retired", label: "L", area: "A", handoff: { summary: "z".repeat(2000) }, model: "m" };
    expect(toolReceipt(worker)).toEqual({ ref: "W154", state: "retired" });
    const stopped = { ref: "A187", workerNum: 121, state: "cancelled", opState: "pending", briefText: "b".repeat(3000), report: null };
    expect(toolReceipt(stopped)).toEqual({ ref: "A187", worker: "W121", state: "cancelled", opState: "pending" });
    expect(toolReceipt({ ...stopped, opState: "done" })).toEqual({ ref: "A187", worker: "W121", state: "cancelled" });
    expect(toolReceipt({ settlement: "A3: delivery confirmed.", ...stopped })).toMatchObject({ ref: "A187", settlement: "A3: delivery confirmed." });
    // A spawn receipt keeps what the coordinator acts on, minus nulls.
    expect(toolReceipt([{ assignment: "A1", worker: "W1", threadId: "t1", state: "running", profile: "p", rationale: null, note: null, warnings: ["W2 is also writing in this checkout (A2, running)."] }]))
      .toEqual([{ assignment: "A1", worker: "W1", threadId: "t1", state: "running", profile: "p", warnings: ["W2 is also writing in this checkout (A2, running)."] }]);
    expect(toolReceipt({ target: "W2", threadId: "t2", generation: 1, receipt: { ok: true, delivery: "sent" } })).toEqual({ to: "W2", delivery: "sent" });
    expect(toolReceipt({ prs: [{ url: "u", stage: "working", note: "long note" }] })).toEqual({ prs: [{ url: "u", stage: "working" }] });
  });

  it("a batch that stops a worker and closes a task answers in a few dozen bytes per action", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id, "Archived search");
    const [w] = await tool(f, "initiative_spawn", { label: "Search", purpose: "search", text: "Do it. ".repeat(500), tasks: [task.ref] });
    expect(w).toEqual({ assignment: "A1", worker: "W1", threadId: w.threadId, state: "running", profile: expect.any(String), note: expect.any(String) });
    const raw = await f.harness.callAgentTool("initiative_batch", { actions: [
      { tool: "worker", action: "stop", worker: "W1", reason: "Moved on." },
      { tool: "task", action: "close", task: task.ref, outcome: "done", note: "Shipped." },
      { tool: "worker", action: "retire", worker: "W1" },
    ] }, { threadId: "coordinator" }) as string;
    const result = JSON.parse(raw);
    expect(result.results[0]).toMatchObject({ tool: "worker", ok: true, ref: "A1", worker: "W1", state: "cancelled" });
    expect(result.results[1]).toEqual({ tool: "task", ok: true, ref: task.ref, state: "done" });
    // Retiring right after a stop is refused while the stop settles; the error stays whole.
    expect(result.results[2]).toMatchObject({ tool: "worker", ok: false, error: expect.stringMatching(/W1/) });
    expect(raw.length).toBeLessThan(700);
    expect(raw).not.toContain("Do it.");
    // The full records stay one read away.
    const read = await tool(f, "initiative_read", { refs: ["A1"], fields: ["briefText"] });
    expect(read.items[0].briefText).toContain("Do it. Do it.");
  });

  it("task create, update and plain messages answer with receipts too", async () => {
    const { f } = await projectFixture();
    expect(await tool(f, "initiative_task", { action: "create", title: "Merge queue", text: "Long text. ".repeat(100) })).toEqual({ ref: "T1", state: "planned" });
    expect(await tool(f, "initiative_task", { action: "update", task: "T1", note: "Half done." })).toEqual({ ref: "T1", state: "planned" });
    const [w] = await tool(f, "initiative_spawn", { label: "Search", purpose: "search", text: "Do it." });
    expect(await tool(f, "initiative_message", { to: w.worker, text: "One fact." })).toEqual({ to: "W1", delivery: "sent" });
    expect(await tool(f, "initiative_update", { text: "Search is half done. ".repeat(20) })).toEqual({ ref: "U1" });
  });

  it("writers sharing a checkout get one warning naming them all", async () => {
    const { f } = await projectFixture();
    await tool(f, "initiative_spawn", { label: "One", purpose: "one", text: "Do it." });
    await tool(f, "initiative_spawn", { label: "Two", purpose: "two", text: "Do it." });
    const [third] = await tool(f, "initiative_spawn", { label: "Three", purpose: "three", text: "Do it." });
    expect(third.warnings).toEqual(['W1 (A1, running), W2 (A2, running) are also writing in this checkout. Sequence the work, or give one of them a worktree (environment {"type":"worktree"}).']);
  });

  it("a writer whose new worktree was provisioned after its spawn is not in this checkout (W218)", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "Isolated", purpose: "iso", text: "Do it.", environment: { type: "worktree" } });
    // BB answers the spawn before the managed worktree exists, so the ledger has no environment.
    f.store.updateWorker(project.id, 1, { environmentId: null });
    f.threads.set(w.threadId, { ...f.threads.get(w.threadId)!, environmentId: null as never });
    f.store.updateAssignment(project.id, 1, { environmentId: null });
    // Still unknown: warned, conservatively.
    const [early] = await tool(f, "initiative_spawn", { label: "Early", purpose: "early", text: "Do it.", environment: { type: "reuse", environmentId: "env_b" } });
    expect(early.warnings).toEqual([expect.stringMatching(/^W1 is also writing in this checkout/)]);
    // Provisioned: the live thread names its own worktree.
    f.threads.set(w.threadId, { ...f.threads.get(w.threadId)!, environmentId: "env_wt" });
    const [late] = await tool(f, "initiative_spawn", { label: "Late", purpose: "late", text: "Do it.", environment: { type: "reuse", environmentId: "env_c" } });
    expect(late.warnings).toBeUndefined();
  });
});

describe("W215 task listing", () => {
  it("lists a task as one line; refs keep its summary", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id, "Archived search");
    f.store.updateTask(project.id, task.num, { progress: "W1 is on it" });
    const page = await tool(f, "initiative_read", { view: "tasks" });
    expect(page.items[0]).toEqual({ ref: task.ref, status: "planned", title: "Archived search", priority: expect.any(Number), progress: "W1 is on it" });
    expect(page.detail).toContain('refs:["T4"] adds its summary');
    const overview = await tool(f, "initiative_read", {});
    expect(overview.tasks[0]).not.toHaveProperty("summary");
    const exact = await tool(f, "initiative_read", { refs: [task.ref] });
    expect(exact.items[0].summary).toBe("Include archived records and explain the matches.");
  });
});

describe("W215 report notices", () => {
  async function spawned() {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "Search", purpose: "search", text: "Do it." });
    f.send.mockClear();
    return { f, project, w };
  }
  const LONG = [
    "## What I did",
    "Rebased #2077 on dev and fixed the three CodeRabbit threads. ".repeat(40),
    "PR: https://github.com/Equisafe/equisafe-market/pull/2077 (head ce301ecaeb), stacked: https://github.com/equisafe/equisafe-market/pull/2084.",
    "## Verified",
    "npm test: 650 passed. ".repeat(60),
  ].join("\n\n").trim();

  it("a short report is sent whole", async () => {
    const { f, w } = await spawned();
    await tool(f, "initiative_report", { outcome: "done", summary: "Done", report: "Short report." }, w.threadId);
    expect(sentTexts(f)).toEqual(["Initiative · Search · W1\n\nW1 reported (done) on A1: Done\n\nShort report."]);
  });

  it("a long one is sent as its summary, the PRs its body names, and where to read the rest", async () => {
    const { f, project, w } = await spawned();
    const summary = "#2077 approved at ce301ecaeb; merge it before #2084. Nothing needed from you.";
    await tool(f, "initiative_report", { outcome: "done", summary, report: LONG }, w.threadId);
    const [text] = sentTexts(f);
    expect(text).toBe([
      `Initiative · Search · W1\n\nW1 reported (done) on A1: ${summary}`,
      "PRs in the report: https://github.com/equisafe/equisafe-market/pull/2077, https://github.com/equisafe/equisafe-market/pull/2084",
      `Full report (${LONG.length} characters): initiative_read {refs:["A1"],detailed:true,fields:["report"]}`,
    ].join("\n\n"));
    expect(text.length).toBeLessThan(1500);
    // The report is stored whole and read on demand.
    const read = await tool(f, "initiative_read", { refs: ["A1"], detailed: true, fields: ["report"] });
    expect(read.items[0].report.finalMessage).toBe(LONG);
    expect(f.store.assignment(project.id, 1)!.report!.finalMessage).toBe(LONG);
  });

  it("the summary beyond the dashboard line is kept, up to 1000 characters; PRs it names are not repeated", async () => {
    const { f, w } = await spawned();
    const summary = `See https://github.com/equisafe/equisafe-market/pull/2077. ${"Detail. ".repeat(200)}`;
    await tool(f, "initiative_report", { outcome: "done", summary, report: LONG }, w.threadId);
    const [text] = sentTexts(f);
    expect(text).toContain(`W1 reported (done) on A1: ${summary.slice(0, 900)}`);
    expect(text).toContain("…\n\nPRs in the report: https://github.com/equisafe/equisafe-market/pull/2084\n\nFull report");
    expect(text.length).toBeLessThan(1500);
  });

  it("PRs the summary names are matched by number, not by URL prefix (W218)", async () => {
    const { f, w } = await spawned();
    const summary = "Merge https://github.com/o/r/pull/123 first; o/r#7 is done.";
    const report = `${LONG}\n\nAlso https://github.com/o/r/pull/12, https://github.com/O/R/pull/123 and https://github.com/o/r/pull/7.`;
    await tool(f, "initiative_report", { outcome: "done", summary, report }, w.threadId);
    const [text] = sentTexts(f);
    expect(text).toContain("PRs in the report: https://github.com/equisafe/equisafe-market/pull/2077, https://github.com/equisafe/equisafe-market/pull/2084, https://github.com/o/r/pull/12\n\n");
  });

  it("a blocked one leads with the question and keeps the summary", async () => {
    const { f, w } = await spawned();
    await tool(f, "initiative_report", { outcome: "blocked", summary: "Rebased; CI needs a secret.", question: "Should I add STRIPE_KEY to CI?", report: LONG }, w.threadId);
    const [text] = sentTexts(f);
    expect(text).toMatch(/^Initiative · Search · W1\n\nW1 is blocked on A1: Should I add STRIPE_KEY to CI\?\n\nRebased; CI needs a secret\.\n\nPRs in the report: /);
    expect(f.send.mock.calls[0][0].mode).toBe("steer-if-active");
  });
});

describe("W215 coordinator compaction", () => {
  /** The coordinator's turn ends with this context size. */
  function turnEnds(f: Fx, usedTokens: number, threadId = "coordinator") {
    f.history.push({ type: "thread/contextWindowUsage/updated", seq: ++seq, createdAt: Date.now(), threadId, data: { contextWindowUsage: { usedTokens, modelContextWindow: 1_000_000, estimated: true } } } as never);
  }
  /** The thread goes idle and the detached compaction check finishes. */
  async function idles(f: Fx, threadId = "coordinator") {
    await f.runtime.onThreadIdle(f.idle(threadId));
    await f.runtime.compactionsSettled();
  }
  const compactions = (f: Fx) => f.compact.mock.calls.length;
  const isEvidenceRead = (path: string, args: { types?: readonly string[] }) => path === "threads.events.list" && !!args.types?.includes("thread/context/cleared") && !args.types.includes("thread/tokenUsage/updated");
  const held = () => {
    let release!: () => void;
    return { gate: new Promise<void>(resolve => (release = resolve)), release: () => release() };
  };

  it("compacts an idle coordinator past the limit, once per turn's snapshot", async () => {
    const { f, project } = await projectFixture();
    turnEnds(f, 350_000);
    await idles(f);
    expect(f.compact).toHaveBeenCalledWith(expect.objectContaining({ threadId: "coordinator" }));
    expect(f.store.activity(project.id, 20).map(a => a.summary)).toContain("Coordinator context at ~350k tokens (limit 300k): compacting it between turns");
    // The compaction's own turn ends: the same snapshot never triggers another.
    await idles(f);
    expect(compactions(f)).toBe(1);
  });

  it("leaves a small context, a context compacted since, workers, and a turned-off setting alone", async () => {
    const { f } = await projectFixture();
    turnEnds(f, 120_000);
    await idles(f);
    turnEnds(f, 400_000);
    f.history.push({ type: "thread/compacted", seq: ++seq, createdAt: Date.now() + 1, threadId: "coordinator", data: {} } as never);
    await idles(f);
    expect(compactions(f)).toBe(0);

    const [w] = await tool(f, "initiative_spawn", { label: "Search", purpose: "search", text: "Do it." });
    turnEnds(f, 900_000, w.threadId);
    await idles(f, w.threadId);
    expect(compactions(f)).toBe(0);

    // Turned off, the idle handler reads nothing for it.
    const off = (await projectFixture({ coordinatorCompactTokens: 0 })).f;
    turnEnds(off, 900_000);
    const reads: string[] = [];
    off.intercept((path, args, call) => {
      if (isEvidenceRead(path, args)) reads.push(path);
      return call();
    });
    await idles(off);
    expect(reads).toEqual([]);
    expect(off.compact).not.toHaveBeenCalled();
  });

  it("the limit is a setting; a paused Initiative is not compacted", async () => {
    const { f, project } = await projectFixture({ coordinatorCompactTokens: 100_000 });
    f.service.setPaused(project.id, true);
    turnEnds(f, 150_000);
    await idles(f);
    expect(compactions(f)).toBe(0);
    f.service.setPaused(project.id, false);
    turnEnds(f, 160_000);
    await idles(f);
    expect(compactions(f)).toBe(1);
  });

  it("BB's refusal (the thread started a turn) is logged, never retried on the same snapshot", async () => {
    const { f, project } = await projectFixture();
    turnEnds(f, 350_000);
    const thread = f.idle("coordinator");
    f.threads.set("coordinator", { ...thread, status: "running" } as never);
    await f.runtime.onThreadIdle(thread);
    await f.runtime.compactionsSettled();
    expect(compactions(f)).toBe(1);
    expect(f.store.activity(project.id, 20).map(a => a.summary).join("\n")).toMatch(/could not be compacted: Context can only be compacted while the thread is idle/);
    await idles(f);
    expect(compactions(f)).toBe(1);
  });

  // W218 -------------------------------------------------------------------------------------

  it("reads the latest snapshot, however far the usage sampler's cursor lags", async () => {
    const { f, project } = await projectFixture();
    turnEnds(f, 100_000);
    await idles(f);
    // One long turn: 30 snapshots, more than the sampler's 25-row page, ending at 400k.
    for (let i = 1; i <= 30; i++) turnEnds(f, 100_000 + i * 10_000);
    await idles(f);
    expect(f.store.usage("coordinator")!.contextUsed).toBeLessThan(400_000);
    expect(compactions(f)).toBe(1);
    expect(f.store.activity(project.id, 20).map(a => a.summary)).toContain("Coordinator context at ~400k tokens (limit 300k): compacting it between turns");
  });

  it("skips the attempt when the latest evidence cannot be read, whatever usage stored", async () => {
    const { f } = await projectFixture();
    turnEnds(f, 350_000);
    // The sampler stores 350k; the compaction's own read then fails.
    await f.runtime.sampleUsage(f.store.membership("coordinator")!, "coordinator");
    expect(f.store.usage("coordinator")!.contextUsed).toBe(350_000);
    turnEnds(f, 100_000);
    f.intercept((path, args, call) => {
      if (isEvidenceRead(path, args)) throw new Error("events unavailable");
      return call();
    });
    await idles(f);
    expect(compactions(f)).toBe(0);
  });

  it("the idle handler does not wait for the check, and shutdown cancels it before any compaction", async () => {
    const { f } = await projectFixture();
    const service = new AbortController();
    f.runtime.start(service.signal);
    turnEnds(f, 350_000);
    const read = held();
    let signal: AbortSignal | undefined;
    f.intercept(async (path, args, call) => {
      if (isEvidenceRead(path, args)) {
        signal = args.signal;
        await read.gate;
      }
      return call();
    });
    await f.runtime.onThreadIdle(f.idle("coordinator"));
    expect(signal?.aborted).toBe(false);
    service.abort();
    f.runtime.dispose();
    expect(signal?.aborted).toBe(true);
    read.release();
    await f.runtime.compactionsSettled();
    expect(compactions(f)).toBe(0);
  });

  it("a compaction call that outlives shutdown touches no store once it returns", async () => {
    const { f } = await projectFixture();
    const service = new AbortController();
    f.runtime.start(service.signal);
    turnEnds(f, 350_000);
    const call = held();
    let issued = false;
    // BB's SDK does not cancel the POST: it still answers after shutdown.
    f.intercept(async (path, _args, next) => {
      if (path === "threads.compact") {
        issued = true;
        await call.gate;
      }
      return next();
    });
    await f.runtime.onThreadIdle(f.idle("coordinator"));
    await vi.waitFor(() => expect(issued).toBe(true));
    service.abort();
    f.runtime.dispose();
    const store = f.store as unknown as Record<string, unknown>;
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(f.store)).filter(k => k !== "constructor" && typeof store[k] === "function");
    const spies = methods.map(k => vi.spyOn(store as never, k as never));
    call.release();
    await f.runtime.compactionsSettled();
    expect(methods.filter((_, i) => spies[i]!.mock.calls.length)).toEqual([]);
    for (const spy of spies) spy.mockRestore();
  });

  it("never runs while a replacement waits for its handover writer", async () => {
    const { f, project } = await projectFixture();
    turnEnds(f, 350_000);
    f.idle("coordinator");
    f.execution.set("catalog-probe", { model: "gpt-6-luna", reasoningLevel: "high" });
    clearCatalogCache();
    // No handover text: the replacement claims a draft and Luna starts writing it.
    const result = await f.service.replaceCoordinator(project.id, { reason: "Fresh context" });
    expect(result).toMatchObject({ state: "writing-handover" });
    expect(f.store.handoverDraft(project.id)).toMatchObject({ state: "generating", thenReplace: expect.objectContaining({ reason: "Fresh context" }) });
    await idles(f);
    expect(compactions(f)).toBe(0);
  });

  it("never overlaps a coordinator replacement in flight", async () => {
    const { f, project } = await projectFixture();
    turnEnds(f, 350_000);
    f.idle("coordinator");
    const spawn = held();
    f.intercept(async (path, args, call) => {
      if (path === "threads.spawn" && args.pluginMetadata?.role === "coordinator") await spawn.gate;
      return call();
    });
    const replacing = f.service.replaceCoordinator(project.id, { reason: "Fresh context", handover: "Start with T4." });
    await vi.waitFor(() => expect(f.store.db.prepare("SELECT state FROM coordinator_starts WHERE project_id=?").get(project.id)).toEqual({ state: "pending" }));
    await f.runtime.onThreadIdle(f.idle("coordinator"));
    await f.runtime.compactionsSettled();
    expect(compactions(f)).toBe(0);
    spawn.release();
    await replacing;
    f.intercept();
  });

  it("a replacement that starts while a compaction call is in flight waits for it", async () => {
    const { f, project } = await projectFixture();
    turnEnds(f, 350_000);
    const call = held();
    const order: string[] = [];
    f.intercept(async (path, args, next) => {
      if (path === "threads.compact") {
        order.push("compact");
        await call.gate;
        order.push("compacted");
      }
      if (path === "threads.spawn" && args.pluginMetadata?.role === "coordinator") order.push("spawn");
      return next();
    });
    await f.runtime.onThreadIdle(f.idle("coordinator"));
    await vi.waitFor(() => expect(order).toEqual(["compact"]));
    const replacing = f.service.replaceCoordinator(project.id, { reason: "Fresh context", handover: "Start with T4." });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(order).toEqual(["compact"]);
    call.release();
    await Promise.allSettled([replacing, f.runtime.compactionsSettled()]);
    expect(order).toEqual(["compact", "compacted", "spawn"]);
    f.intercept();
  });

  it("a handover writer claimed while a compaction call is in flight captures after it", async () => {
    const { f, project } = await projectFixture();
    f.execution.set("catalog-probe", { model: "gpt-6-luna", reasoningLevel: "high" });
    clearCatalogCache();
    turnEnds(f, 350_000);
    const call = held();
    const order: string[] = [];
    f.intercept(async (path, args, next) => {
      if (path === "threads.compact") {
        order.push("compact");
        await call.gate;
        order.push("compacted");
      }
      if (path === "threads.spawn" && args.pluginMetadata?.role === "handover-writer") order.push("writer");
      return next();
    });
    await f.runtime.onThreadIdle(f.idle("coordinator"));
    await vi.waitFor(() => expect(order).toEqual(["compact"]));
    const replacing = f.service.replaceCoordinator(project.id, { reason: "Fresh context" });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(order).toEqual(["compact"]);
    call.release();
    await Promise.allSettled([replacing, f.runtime.compactionsSettled()]);
    expect(order).toEqual(["compact", "compacted", "writer"]);
    f.intercept();
  });
});
