import { describe, expect, it, vi } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { ThreadDto } from "../lib/bb";
import { projectFixture } from "./fake-native";

// T150: a worker thread that ends in an error BB does not retry closes its open assignment as
// failed, and the coordinator is told once. A retried failure leaves it open; a report from the
// thread once the user retries it is accepted as usual.
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const tool = async (f: Fx, name: string, input: unknown, threadId = "coordinator") => JSON.parse(await f.harness.callAgentTool(name, input, { threadId }) as string);
const POLICY = "This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request.";
const REPORT = "## Done\n\nThe review found two issues.\n\nNothing uncommitted.";
let seq = 5000;

async function failing() {
  const { f, project } = await projectFixture();
  const task = f.task(project.id, "Review the stack");
  const [w] = await tool(f, "initiative_spawn", { label: "Review stack", purpose: "review", text: "Review it.", tasks: [task.ref] });
  f.send.mockClear();
  let clock = Date.now();
  const now = vi.spyOn(f.service, "now").mockImplementation(() => clock);
  /** One sweep's failed-thread check, `ms` after the previous one. */
  const sweep = async (ms = 30_000) => { clock += ms; await f.service.checkWorkers(); };
  /** The worker's turn fails the way a Codex policy block does; `event` delivers thread.failed. */
  const fail = async (event = true) => {
    f.history.push({ type: "client/turn/requested", seq: ++seq, threadId: w.threadId, createdAt: clock - 1, data: { requestId: `creq_${seq}`, senderThreadId: "coordinator", input: [] } });
    f.history.push({ type: "turn/started", seq: ++seq, threadId: w.threadId, createdAt: clock });
    f.history.push({ type: "provider/error", seq: ++seq, threadId: w.threadId, createdAt: clock, data: { message: "Provider error", detail: POLICY } });
    f.history.push({ type: "turn/completed", seq: ++seq, threadId: w.threadId, createdAt: clock, data: { status: "failed", error: { message: POLICY } } });
    const thread = { ...f.threads.get(w.threadId)!, status: "error" as const };
    f.threads.set(w.threadId, thread);
    if (event) await f.runtime.onThreadFailed(thread, null);
  };
  const set = (patch: Record<string, unknown>) => f.threads.set(w.threadId, { ...f.threads.get(w.threadId)!, ...patch } as ThreadDto);
  return { f, project, task, w, now, sweep, fail, set, tick: (ms: number) => (clock += ms) };
}
const sentTexts = (f: Fx) => f.send.mock.calls.map(([args]) => args.input[0].text as string);
const failureNotices = (f: Fx) => sentTexts(f).filter(t => t.includes("ended without a report"));

describe("T150 a worker thread that fails without a retry", () => {
  it("closes the assignment as failed after the retry grace and tells the coordinator once", async () => {
    const { f, project, task, w, sweep, fail } = await failing();
    await fail();
    // BB's provider retry queues right after the failure: until the grace passes, nothing closes.
    await sweep(0);
    await sweep(30_000);
    expect(f.store.assignment(project.id, 1)!.state).toBe("running");
    expect(f.send).not.toHaveBeenCalled();
    await sweep(31_000);
    const a = f.store.assignment(project.id, 1)!;
    expect(a).toMatchObject({ state: "failed", report: null, stopReason: `Native thread failed, not retried: ${POLICY.replace(/\.$/, "")}.` });
    expect(f.store.task(project.id, task.num)).toMatchObject({ status: "blocked", progress: "W1's thread failed on A1 without a report" });
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0][0]).toMatchObject({ threadId: "coordinator", mode: "queue-if-active" });
    expect(f.send.mock.calls[0][0]).not.toHaveProperty("senderThreadId");
    expect(sentTexts(f)[0]).toBe(
      `Initiative · Search · W1\n\nW1 ended without a report on A1 (thread ${w.threadId}). ${a.stopReason}\n\nNo report; retire and respawn W1, or retry its thread.`);
    // Later sweeps, another failed event, a fresh process's memory and the stuck check add nothing.
    await f.runtime.onThreadFailed(f.threads.get(w.threadId)!, null);
    (f.service as unknown as { failedSeen: Map<string, unknown> }).failedSeen.clear();
    await sweep(STUCK);
    await sweep(STUCK);
    expect(f.send).toHaveBeenCalledTimes(1);
    // The overview shows the real state: nothing in flight, the task blocked with the cause.
    const overview = await f.overview(project.id, "full");
    expect(overview.inFlight).toEqual([]);
    expect(overview.remaining.find(t => t.ref === task.ref)).toMatchObject({ status: "blocked", why: "W1's thread failed on A1 without a report" });
    expect(overview.workers.current.find(x => x.ref === "W1")).toMatchObject({ runtime: "error" });
  });

  it("does not tell the coordinator twice through the stuck-worker check while the grace runs", async () => {
    const { f, project, fail, tick } = await failing();
    await fail();
    // The stuck check's interval has passed, the failure grace has not.
    tick(30_000);
    await f.service.checkWorkers();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.store.assignment(project.id, 1)!.state).toBe("running");
  });

  it("retries a notice BB refused, and sends it once", async () => {
    const { f, project, sweep, fail } = await failing();
    await fail();
    f.send.mockRejectedValueOnce(Object.assign(new Error("coordinator busy"), { status: 409 }));
    await sweep(0);
    await sweep(61_000);
    expect(f.store.assignment(project.id, 1)!.state).toBe("failed");
    expect(f.store.activity(project.id, 20).filter(x => x.summary.includes("Could not tell the coordinator"))).toHaveLength(1);
    await sweep();
    await sweep();
    expect(failureNotices(f)).toHaveLength(2); // the refused attempt and the one that went out
    expect(f.store.unnoticedThreadFailures()).toEqual([]);
  });

  it("catches a failure whose event the plugin missed", async () => {
    const { f, project, sweep, fail } = await failing();
    await fail(false);
    await sweep(0);
    expect(f.store.assignment(project.id, 1)!.state).toBe("running");
    await sweep(61_000);
    expect(f.store.assignment(project.id, 1)).toMatchObject({ state: "failed", stopReason: expect.stringContaining("possible cybersecurity risk") });
    expect(failureNotices(f)).toHaveLength(1);
  });

  it("falls back to the failed event's error when the thread's events carry no text", async () => {
    const { f, project, w, sweep } = await failing();
    const thread = { ...f.threads.get(w.threadId)!, status: "error" as const };
    f.threads.set(w.threadId, thread);
    await f.runtime.onThreadFailed(thread, "Workspace setup failed: base branch gone");
    await sweep(0);
    await sweep(61_000);
    expect(f.store.assignment(project.id, 1)!.stopReason).toBe("Native thread failed, not retried: Workspace setup failed: base branch gone.");
  });
});

describe("T150 failures BB retries, and reports after a retry", () => {
  it("a retry BB queued keeps the assignment open, however long it waits", async () => {
    const { f, project, sweep, fail, set } = await failing();
    await fail();
    // The first sweep can run before the retry is queued.
    await sweep(0);
    set({ queuedMessageCount: 1 });
    for (let i = 0; i < 12; i++) await sweep(STUCK);
    expect(f.store.assignment(project.id, 1)!.state).toBe("running");
    // The retry runs, then fails again with no further retry: the grace starts over there.
    set({ queuedMessageCount: 0, status: "active" });
    await sweep();
    await fail();
    await sweep(30_000);
    expect(f.store.assignment(project.id, 1)!.state).toBe("running");
    await sweep(31_000);
    expect(f.store.assignment(project.id, 1)!.state).toBe("failed");
    expect(failureNotices(f)).toHaveLength(1);
  });

  it("a thread busy with background work is not closed", async () => {
    const { f, project, sweep, fail, set } = await failing();
    await fail();
    set({ activeBackgroundAgentCount: 1 });
    await sweep(0);
    await sweep(STUCK);
    expect(f.store.assignment(project.id, 1)!.state).toBe("running");
  });

  it("accepts the worker's report once the user retries the thread", async () => {
    const { f, project, task, w, sweep, fail, set } = await failing();
    await fail();
    await sweep(0);
    await sweep(61_000);
    expect(f.store.assignment(project.id, 1)!.state).toBe("failed");
    f.send.mockClear();
    set({ status: "active" });
    const result = await tool(f, "initiative_report", { outcome: "done", summary: "Two issues found", report: REPORT }, w.threadId);
    expect(result.note).toBe("Report recorded and sent to the coordinator.");
    expect(f.store.assignment(project.id, 1)).toMatchObject({ state: "reported", stopReason: null, report: { summary: "Two issues found" } });
    expect(f.store.task(project.id, task.num)!.status).toBe("in_progress");
    expect(sentTexts(f)).toEqual([`Initiative · Search · W1\n\nW1 reported (done) on A1: Two issues found\n\n${REPORT}`]);
  });

  it("records the retried turn's final message when the worker does not file a report", async () => {
    const { f, project, w, sweep, fail } = await failing();
    await fail();
    await sweep(0);
    await sweep(61_000);
    // The user retries: the failed brief turn continues and completes with a final message.
    const brief = f.store.assignment(project.id, 1)!.briefText;
    const request = `creq_${++seq}`;
    f.history.push({ type: "client/turn/requested", seq: ++seq, threadId: w.threadId, createdAt: Date.now(), data: { requestId: request, input: [{ type: "text", text: brief }] } });
    f.history.push({ type: "turn/started", seq: ++seq, threadId: w.threadId, createdAt: Date.now() });
    f.history.push({ type: "turn/input/accepted", seq: ++seq, threadId: w.threadId, createdAt: Date.now(), data: { clientRequestId: request } });
    f.history.push({ type: "item/completed", seq: ++seq, threadId: w.threadId, createdAt: Date.now(), data: { item: { type: "agentMessage", id: `m${seq}`, text: REPORT } } });
    f.history.push({ type: "turn/completed", seq: ++seq, threadId: w.threadId, createdAt: Date.now(), data: { status: "completed" } });
    await f.runtime.onThreadIdle(f.idle(w.threadId));
    expect(f.store.assignment(project.id, 1)).toMatchObject({ state: "reported", stopReason: null, report: { finalMessage: REPORT } });
  });

  it("a failed dispatch stays terminal: a late report does not reopen it", async () => {
    const { f, project, w } = await failing();
    f.store.updateAssignment(project.id, 1, { state: "failed", stopReason: "Delegation failed" });
    await tool(f, "initiative_report", { outcome: "done", summary: "Late", report: REPORT }, w.threadId);
    expect(f.store.assignment(project.id, 1)).toMatchObject({ state: "failed", stopReason: "Delegation failed" });
  });
});

describe("T150 races (W340's and W343's review probes)", () => {
  // A worker whose turn failed without a failed event, so the first full scan starts its grace.
  async function failed(fillers = 0) {
    const { f, project } = await projectFixture();
    for (let i = 0; i < fillers; i++) f.threads.set(`filler-${i}`, makeThreadResponse({ id: `filler-${i}`, projectId: "proj_a", environmentId: "env_a", status: "idle" }));
    const task = f.task(project.id, "Work");
    const [w] = await tool(f, "initiative_spawn", { label: "Work", purpose: "Implement", text: "Do it.", tasks: [task.ref] });
    let clock = Date.now();
    vi.spyOn(f.service, "now").mockImplementation(() => clock);
    f.history.push({ type: "turn/started", threadId: w.threadId, seq: 8000, createdAt: clock });
    f.history.push({ type: "provider/error", threadId: w.threadId, seq: 8001, createdAt: clock, data: { detail: "Policy block" } });
    f.history.push({ type: "turn/completed", threadId: w.threadId, seq: 8002, createdAt: clock, data: { status: "failed", error: { message: "Policy block" } } });
    f.threads.set(w.threadId, { ...f.threads.get(w.threadId)!, status: "error" });
    f.send.mockClear();
    return { f, project, task, w, tick: (ms: number) => clock += ms };
  }
  const filed = (summary: string) => ({ outcome: "done", summary, report: `Completed ${summary}.` });
  const readsHistory = (path: string, args: any) => path === "threads.events.list" && args.types?.includes("provider/error");

  it("P1: finds a failure beyond the first 1000 project threads, with the stuck check on the same scan", async () => {
    const { f, project, tick } = await failed(1000);
    const offsets: number[] = [];
    f.intercept((path, args, call) => {
      if (path === "threads.list" && args.projectId === "proj_a" && !args.parentThreadId) offsets.push(args.offset ?? 0);
      return call();
    });
    for (let i = 0; i < 15; i++) { await f.service.checkWorkers(); tick(STUCK); }
    // Two rotations of the listing, then the failure's own page read again right before its close.
    expect(offsets).toEqual([...[0, 200, 400, 600, 800, 1000], ...[0, 200, 400, 600, 800, 1000], 1000]);
    expect(f.store.assignment(project.id, 1)!.state).toBe("failed");
    expect(failureNotices(f)).toHaveLength(1);
  });

  it("P2: does not close a successor assignment that lands during the error-history read", async () => {
    const { f, project, task, w, tick } = await failed();
    await f.service.checkWorkers();
    tick(61_000);
    let changed = false;
    f.intercept(async (path, args, call) => {
      if (readsHistory(path, args) && !changed) {
        changed = true;
        f.threads.set(w.threadId, { ...f.threads.get(w.threadId)!, status: "idle" });
        await tool(f, "initiative_report", filed("original work done"), w.threadId);
        await tool(f, "initiative_message", { to: w.worker, text: "Do the followup.", work: true, tasks: [task.ref] });
      }
      return call();
    });
    await f.service.checkWorkers();
    expect(changed).toBe(true);
    expect(f.store.assignment(project.id, 1)!.state).toBe("reported");
    expect(f.store.assignment(project.id, 2)!.state).toBe("running");
    expect(failureNotices(f)).toHaveLength(0);
  });

  it("P3: keeps the assignment open when a retry queues during the error-history read", async () => {
    const { f, project, w, tick } = await failed();
    await f.service.checkWorkers();
    tick(61_000);
    f.intercept((path, args, call) => {
      if (readsHistory(path, args)) f.threads.set(w.threadId, { ...f.threads.get(w.threadId)!, queuedMessageCount: 1 } as ThreadDto);
      return call();
    });
    await f.service.checkWorkers();
    expect(f.store.assignment(project.id, 1)!.state).toBe("running");
    expect(failureNotices(f)).toHaveLength(0);
  });

  it("P4: keeps a refused dispatch failed across any number of late reports", async () => {
    const { f, project, w } = await failed();
    await tool(f, "initiative_report", filed("original assignment done"), w.threadId);
    f.send.mockRejectedValueOnce(Object.assign(new Error("brief refused"), { status: 400 }));
    await expect(tool(f, "initiative_message", { to: w.worker, text: "Followup work", work: true })).rejects.toThrow("brief refused");
    expect(f.store.assignment(project.id, 2)).toMatchObject({ state: "failed", opState: "failed", briefDelivered: false });
    const stopReason = f.store.assignment(project.id, 2)!.stopReason;
    await tool(f, "initiative_report", filed("first late report"), w.threadId);
    await tool(f, "initiative_report", filed("second late report"), w.threadId);
    expect(f.store.assignment(project.id, 2)).toMatchObject({ state: "failed", stopReason });
  });

  it("P5: does not send the notice again when BB accepted it but the response was lost", async () => {
    const { f, project, tick } = await failed();
    await f.service.checkWorkers();
    tick(61_000);
    const accepted: string[] = [];
    f.intercept(async (path, args, call) => {
      const result = await call();
      if (path === "threads.send" && args.input[0].text.includes("ended without a report")) {
        accepted.push(args.input[0].text);
        if (accepted.length === 1) throw new Error("SDK response timed out after BB accepted the message");
      }
      return result;
    });
    await f.service.checkWorkers();
    tick(30_000);
    await f.service.checkWorkers();
    expect(accepted).toHaveLength(1);
    expect(f.store.activity(project.id, 20).filter(x => x.summary.includes("may not have been told"))).toHaveLength(1);
  });

  it("P6: does not send a stale notice for a worker that reports while an earlier notice is sending", async () => {
    const { f, project, w, tick } = await failed();
    const [second] = await tool(f, "initiative_spawn", { label: "More work", purpose: "Implement", text: "Do another thing." });
    f.threads.set(second.threadId, { ...f.threads.get(second.threadId)!, status: "error" });
    f.send.mockClear();
    await f.service.checkWorkers();
    tick(61_000);
    let reported = false;
    f.intercept(async (path, args, call) => {
      if (path === "threads.send" && args.input[0].text.includes(`${w.worker} ended without a report`) && !reported) {
        reported = true;
        f.threads.set(second.threadId, { ...f.threads.get(second.threadId)!, status: "active" });
        await tool(f, "initiative_report", filed("recovered second worker"), second.threadId);
      }
      return call();
    });
    await f.service.checkWorkers();
    expect(reported).toBe(true);
    expect(f.store.assignment(project.id, 2)!.state).toBe("reported");
    expect(failureNotices(f)).toHaveLength(1);
  });

  it("P7: between full scans, with no failed event, reads neither BB nor the worker ledger", async () => {
    const { f, project, w, tick } = await failed();
    f.threads.set(w.threadId, { ...f.threads.get(w.threadId)!, status: "active" });
    const template = f.store.assignment(project.id, 1)!;
    f.store.tx(() => {
      for (let i = 1; i < 500; i++) {
        const id = `perf-${i}`;
        const worker = f.store.createWorker({ projectId: project.id, role: "work", label: id, area: "perf", bbProjectId: "proj_a" });
        f.store.updateWorker(project.id, worker.num, { threadId: id, generation: 1, state: "active" });
        f.threads.set(id, makeThreadResponse({ id, projectId: "proj_a", environmentId: "env_a", status: "active" }));
        const a = f.store.createAssignment({ ...template, workerNum: worker.num, threadId: id, opId: `perf-op-${i}`, taskNums: [] });
        f.store.updateAssignment(project.id, a.num, { briefDelivered: true });
      }
    });
    const native: string[] = [];
    f.intercept((path, args, call) => { native.push(path); return call(); });
    const ledger = ["openAssignment", "latestAssignment", "workers", "failureClosable"].filter(m => m in f.store)
      .map(m => [m, vi.spyOn(f.store as any, m)] as const);
    await f.service.checkWorkers();
    expect(native.filter(p => p === "threads.list").length).toBeGreaterThan(0);
    native.length = 0;
    for (const [, spy] of ledger) spy.mockClear();
    tick(30_000);
    await f.service.checkWorkers();
    expect(native).toEqual([]);
    expect(ledger.filter(([, spy]) => spy.mock.calls.length).map(([m]) => m)).toEqual([]);
  });

  it.each(["activeBackgroundCommandCount", "activeWorkflowCount"])("F1: keeps the assignment open when %s starts during the error-history read", async (field) => {
    const { f, project, w, tick } = await failed();
    await f.service.checkWorkers();
    tick(61_000);
    let started = false;
    f.intercept((path, args, call) => {
      if (readsHistory(path, args)) {
        started = true;
        f.threads.set(w.threadId, { ...f.threads.get(w.threadId)!, activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activeWorkflowCount: 0, [field]: 1 } } as unknown as ThreadDto);
      }
      return call();
    });
    await f.service.checkWorkers();
    expect(started).toBe(true);
    expect(f.store.assignment(project.id, 1)!.state).toBe("running");
    expect(failureNotices(f)).toHaveLength(0);
  });

  it("F2: gives a failure that lands during the error-history read its own grace", async () => {
    const { f, project, w, tick } = await failed();
    await f.service.checkWorkers();
    tick(61_000);
    let refailed = false;
    f.intercept(async (path, args, call) => {
      if (readsHistory(path, args) && !refailed) {
        refailed = true;
        // A manual retry starts and fails again while the old failure's text is read.
        f.threads.set(w.threadId, { ...f.threads.get(w.threadId)!, status: "active" });
        const at = tick(1000);
        f.history.push({ type: "turn/started", threadId: w.threadId, seq: 9000, createdAt: at });
        f.history.push({ type: "turn/completed", threadId: w.threadId, seq: 9002, createdAt: at, data: { status: "failed", error: { message: "Second failure" } } });
        f.threads.set(w.threadId, { ...f.threads.get(w.threadId)!, status: "error" });
        await f.runtime.onThreadFailed(f.threads.get(w.threadId)!, "Second failure");
      }
      return call();
    });
    await f.service.checkWorkers();
    expect(refailed).toBe(true);
    expect(f.store.assignment(project.id, 1)!.state).toBe("running");
    tick(30_000);
    await f.service.checkWorkers();
    expect(f.store.assignment(project.id, 1)!.state).toBe("running");
    tick(31_000);
    await f.service.checkWorkers();
    expect(f.store.assignment(project.id, 1)).toMatchObject({ state: "failed", stopReason: "Native thread failed, not retried: Second failure." });
    expect(failureNotices(f)).toHaveLength(1);
  });

  it("F2: binds the close to the old assignment even when a successor's thread is also in error", async () => {
    const { f, project, task, w, tick } = await failed();
    await f.service.checkWorkers();
    tick(61_000);
    let replaced = false;
    f.intercept(async (path, args, call) => {
      if (readsHistory(path, args) && !replaced) {
        replaced = true;
        await tool(f, "initiative_report", filed("original work done"), w.threadId);
        await tool(f, "initiative_message", { to: w.worker, text: "Do the followup.", work: true, tasks: [task.ref] });
        f.threads.set(w.threadId, { ...f.threads.get(w.threadId)!, status: "error" });
      }
      return call();
    });
    await f.service.checkWorkers();
    expect(replaced).toBe(true);
    expect(f.store.assignment(project.id, 1)!.state).toBe("reported");
    expect(f.store.assignment(project.id, 2)!.state).toBe("running");
    expect(failureNotices(f)).toHaveLength(0);
  });

  it("F2: gives a successor whose failure event was missed the full grace from when it is first seen", async () => {
    const { f, project, task, w, tick } = await failed();
    await f.service.checkWorkers();
    tick(61_000);
    let replaced = false;
    f.intercept(async (path, args, call) => {
      if (readsHistory(path, args) && !replaced) {
        replaced = true;
        f.threads.set(w.threadId, { ...f.threads.get(w.threadId)!, status: "idle" });
        await tool(f, "initiative_report", filed("original work done"), w.threadId);
        await tool(f, "initiative_message", { to: w.worker, text: "Do the followup.", work: true, tasks: [task.ref] });
        const at = tick(1000);
        f.history.push({ type: "turn/started", threadId: w.threadId, seq: 9000, createdAt: at });
        f.history.push({ type: "turn/completed", threadId: w.threadId, seq: 9002, createdAt: at, data: { status: "failed", error: { message: "Successor failed" } } });
        // No failed event: only the native reads find this failure.
        f.threads.set(w.threadId, { ...f.threads.get(w.threadId)!, status: "error" });
      }
      return call();
    });
    await f.service.checkWorkers();
    expect(f.store.assignment(project.id, 1)!.state).toBe("reported");
    tick(30_000);
    await f.service.checkWorkers();
    expect(f.store.assignment(project.id, 2)!.state).toBe("running");
    expect(failureNotices(f)).toHaveLength(0);
    // The next full scan finds the successor's failure and starts its grace.
    tick(STUCK);
    await f.service.checkWorkers();
    expect(f.store.assignment(project.id, 2)!.state).toBe("running");
    tick(60_000);
    await f.service.checkWorkers();
    expect(f.store.assignment(project.id, 2)).toMatchObject({ state: "failed", stopReason: "Native thread failed, not retried: Successor failed." });
    expect(failureNotices(f)).toHaveLength(1);
  });

  it("W349: lets a ledger failure during a close reach the sweep's warning", async () => {
    const { f, project, task, tick } = await failed();
    await f.service.checkWorkers();
    tick(61_000);
    f.store.db.exec(`CREATE TEMP TRIGGER close_fails BEFORE UPDATE OF state ON assignments WHEN NEW.state = 'failed'
      BEGIN SELECT RAISE(ABORT, 'Ledger write failed'); END`);
    f.harness.inspection.logEntries.length = 0;
    await f.runtime.sweep();
    expect(f.store.assignment(project.id, 1)!.state).toBe("running");
    expect(f.store.task(project.id, task.num)!.status).toBe("in_progress");
    expect(f.harness.inspection.logEntries).toContainEqual({ level: "warn", message: "Worker check failed: Ledger write failed" });
    f.store.db.exec("DROP TRIGGER close_fails");
    await f.service.checkWorkers();
    expect(f.store.assignment(project.id, 1)!.state).toBe("failed");
  });

  it("W349: records a newer failure's cause when it replaces the one whose text was read", async () => {
    const { f, project, w, tick } = await failed();
    await f.service.checkWorkers();
    const [second] = await tool(f, "initiative_spawn", { label: "Second", purpose: "Implement", text: "Other work." });
    f.threads.set(second.threadId, { ...f.threads.get(second.threadId)!, status: "error" });
    f.service.noteThreadFailed(second.threadId, 2, "Second worker failed");
    tick(61_000);
    let refailed = false;
    f.intercept(async (path, args, call) => {
      if (readsHistory(path, args) && args.threadId === second.threadId && !refailed) {
        refailed = true;
        // W1 retries and fails again while W2's text is read, and that read outlasts the new grace.
        const at = tick(1000);
        f.history.push({ type: "turn/started", threadId: w.threadId, seq: 9000, createdAt: at });
        f.history.push({ type: "turn/completed", threadId: w.threadId, seq: 9002, createdAt: at, data: { status: "failed", error: { message: "Workspace disk full" } } });
        await f.runtime.onThreadFailed(f.threads.get(w.threadId)!, "Workspace disk full");
        tick(61_000);
      }
      return call();
    });
    await f.service.checkWorkers();
    expect(refailed).toBe(true);
    expect(f.store.assignment(project.id, 1)).toMatchObject({ state: "failed", stopReason: "Native thread failed, not retried: Workspace disk full." });
  });
});

describe("T150 closes page by page (W346's review probes)", () => {
  // W1 failed on the first page of a two-page listing, past its grace; a later worker sits on the
  // second page. BB lists newest first.
  async function twoPages() {
    const { f, project } = await projectFixture();
    const task = f.task(project.id, "First task");
    const [w] = await tool(f, "initiative_spawn", { label: "First", purpose: "Implement", text: "Do it.", tasks: [task.ref] });
    let clock = Date.now();
    vi.spyOn(f.service, "now").mockImplementation(() => clock);
    f.history.push({ type: "turn/started", threadId: w.threadId, seq: 8000, createdAt: clock });
    f.history.push({ type: "turn/completed", threadId: w.threadId, seq: 8002, createdAt: clock, data: { status: "failed", error: { message: "Policy block" } } });
    f.threads.set(w.threadId, { ...f.threads.get(w.threadId)!, status: "error" });
    for (let i = 0; i < 200; i++) f.threads.set(`filler-${i}`, makeThreadResponse({ id: `filler-${i}`, projectId: "proj_a", environmentId: "env_a", status: "idle" }));
    const [later] = await tool(f, "initiative_spawn", { label: "Later", purpose: "Implement", text: "Later task." });
    f.threads.set(later.threadId, { ...f.threads.get(later.threadId)!, status: "active" });
    let row = 0;
    for (const [id, thread] of f.threads) f.threads.set(id, { ...thread, createdAt: Date.now() - row++ * 1000 });
    await f.service.checkWorkers();
    clock += STUCK;
    f.send.mockClear();
    const offsets: number[] = [];
    const states: string[] = [];
    return { f, project, task, w, offsets, states, watch: (during: (path: string, args: any) => void = () => {}) => f.intercept((path, args, call) => {
      if (path === "threads.list" && !args.parentThreadId) {
        offsets.push(args.offset ?? 0);
        states.push(f.store.assignment(project.id, 1)!.state);
      }
      during(path, args);
      return call();
    }) };
  }

  it("closes first-page work from that page read again, before the next page is read", async () => {
    const { f, project, task, offsets, states, watch } = await twoPages();
    watch();
    await f.service.checkWorkers();
    expect(offsets).toEqual([0, 0, 200]);
    expect(states).toEqual(["running", "running", "failed"]);
    expect(f.store.task(project.id, task.num)!.status).toBe("blocked");
    expect(failureNotices(f)).toHaveLength(1);
  });

  it.each(["queuedMessageCount", "activeBackgroundAgentCount", "activeBackgroundCommandCount", "activeWorkflowCount"])(
    "keeps first-page work open when %s appears after its page was first read", async (field) => {
      const { f, project, task, w, offsets, watch } = await twoPages();
      watch((path, args) => {
        if (path !== "threads.events.list" || !args.types?.includes("provider/error")) return;
        const current = f.threads.get(w.threadId)!;
        f.threads.set(w.threadId, { ...current, ...(field === "queuedMessageCount" ? { queuedMessageCount: 1 }
          : { activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activeWorkflowCount: 0, [field]: 1 } }) } as unknown as ThreadDto);
      });
      await f.service.checkWorkers();
      expect(offsets).toEqual([0, 0, 200]);
      expect(f.store.assignment(project.id, 1)!.state).toBe("running");
      expect(f.store.task(project.id, task.num)!.status).toBe("in_progress");
      expect(failureNotices(f)).toHaveLength(0);
    });

  it("reads error history only for failures on the pages it lists", { timeout: 30_000 }, async () => {
    const { f, project, w, tick } = await failedAmong(3000, "error");
    for (let i = 1; i < 3000; i++) f.service.noteThreadFailed(`many-${i}`, i + 1, "Policy block");
    f.service.noteThreadFailed(w.threadId, 1, "Policy block");
    tick(61_000);
    const reads = { history: 0, rows: new Set<string>(), offsets: [] as number[] };
    f.intercept(async (path, args, call) => {
      if (path === "threads.events.list" && args.types?.includes("provider/error")) reads.history++;
      if (path !== "threads.list" || args.parentThreadId) return call();
      reads.offsets.push(args.offset ?? 0);
      const rows = await call() as { id: string }[];
      for (const row of rows) reads.rows.add(row.id);
      return rows;
    });
    const started = performance.now();
    await f.service.checkWorkers();
    console.log(JSON.stringify({ scenario: "3000 mature failures, full scan", historyReads: reads.history, rows: reads.rows.size, offsets: reads.offsets, closed: 3000 - f.store.failureClosable().length, ms: Math.round(performance.now() - started) }));
    // One page holds the coordinator; the other 999 listed rows are failures, each read once.
    expect(reads.history).toBe(999);
    expect(f.store.failureClosable()).toHaveLength(2001);
    reads.history = 0; reads.rows.clear(); reads.offsets.length = 0;
    tick(30_000);
    await f.service.checkWorkers();
    console.log(JSON.stringify({ scenario: "3000 mature failures, next sweep", historyReads: reads.history, rows: reads.rows.size, offsets: reads.offsets }));
    expect(f.store.failureClosable().filter(a => reads.rows.has(a.threadId!))).toEqual([]);
    expect(reads.history).toBe(0);
  });
});

describe("T150 cost and notices (W340's and W343's retained probes)", () => {
  it("between full scans makes no native call or ledger lookup at 100, 500, 1000 and 3000 open assignments", { timeout: 30_000 }, async () => {
    for (const count of [100, 500, 1000, 3000]) {
      const { f, tick } = await failedAmong(count, "active");
      const lists: unknown[] = [];
      f.intercept((path, args, call) => { if (path === "threads.list") lists.push(args); return call(); });
      const lookups = vi.spyOn(f.store, "openAssignment");
      const started = performance.now();
      await f.service.checkWorkers();
      const full = { ms: Math.round(performance.now() - started), lists: lists.length, lookups: lookups.mock.calls.length };
      lists.length = 0; lookups.mockClear();
      tick(30_000);
      await f.service.checkWorkers();
      console.log(JSON.stringify({ scenario: "idle sweeps", count, full, between: { lists: lists.length, lookups: lookups.mock.calls.length } }));
      expect(full.lookups).toBe(0);
      expect(lists).toHaveLength(0);
      expect(lookups).not.toHaveBeenCalled();
    }
  });

  it("watches one failure among 3000 open assignments with one ledger query and no per-worker lookups", { timeout: 30_000 }, async () => {
    const { f, project, w, tick } = await failedAmong(3000, "active");
    await f.service.checkWorkers();
    f.threads.set(w.threadId, { ...f.threads.get(w.threadId)!, status: "error" });
    f.service.noteThreadFailed(w.threadId, 1, "Policy block");
    tick(30_000);
    const native: string[] = [];
    f.intercept((path, args, call) => { native.push(path); return call(); });
    const bulk = vi.spyOn(f.store, "failureClosable");
    const perWorker = [vi.spyOn(f.store, "openAssignment"), vi.spyOn(f.store, "latestAssignment"), vi.spyOn(f.store, "workers")];
    const started = performance.now();
    await f.service.checkWorkers();
    console.log(JSON.stringify({ scenario: "one failure among 3000", ms: +(performance.now() - started).toFixed(2), native }));
    expect(native).toEqual(["threads.list"]);
    expect(bulk).toHaveBeenCalledTimes(1);
    expect(perWorker.every(s => !s.mock.calls.length)).toBe(true);
    expect(f.store.assignment(project.id, 1)!.state).toBe("running");
  });

  it("checks a notice's persisted flag again after an earlier send", async () => {
    const { f, project, w, tick } = await failedAmong(1, "error");
    const [second] = await tool(f, "initiative_spawn", { label: "Second", purpose: "Implement", text: "Do another thing." });
    f.threads.set(second.threadId, { ...f.threads.get(second.threadId)!, status: "error" });
    f.send.mockClear();
    await f.service.checkWorkers();
    tick(61_000);
    f.intercept((path, args, call) => {
      if (path === "threads.send" && args.input[0].text.includes(`${w.worker} ended without a report`)) f.store.setFlag(`failed:${project.id}:2`);
      return call();
    });
    await f.service.checkWorkers();
    expect(failureNotices(f)).toHaveLength(1);
    expect(f.store.unnoticedThreadFailures()).toEqual([]);
  });

  it("sends each pending notice to the coordinator current at its send", async () => {
    const { f, project, w, tick } = await failedAmong(1, "error");
    const [second] = await tool(f, "initiative_spawn", { label: "Second", purpose: "Implement", text: "Do another thing." });
    f.threads.set(second.threadId, { ...f.threads.get(second.threadId)!, status: "error" });
    f.threads.set("new-coordinator", makeThreadResponse({ id: "new-coordinator", projectId: "proj_a", environmentId: "env_a" }));
    f.send.mockClear();
    await f.service.checkWorkers();
    tick(61_000);
    f.intercept((path, args, call) => {
      if (path === "threads.send" && args.input[0].text.includes(`${w.worker} ended without a report`)) f.store.setCoordinator(project.id, "new-coordinator", "User switched during first notice");
      return call();
    });
    await f.service.checkWorkers();
    expect(f.send.mock.calls.filter(([a]) => a.input[0].text.includes("ended without a report")).map(([a]) => a.threadId)).toEqual(["coordinator", "new-coordinator"]);
  });
});

/**
 * `count` open assignments, each on its own worker thread with `status`; W1's turn failed with no
 * failed event (its row shows `status` too).
 */
async function failedAmong(count: number, status: "active" | "error") {
  const { f, project } = await projectFixture();
  const [w] = await tool(f, "initiative_spawn", { label: "Work", purpose: "Implement", text: "Do it.", tasks: [f.task(project.id, "Work").ref] });
  let clock = Date.now();
  vi.spyOn(f.service, "now").mockImplementation(() => clock);
  f.history.push({ type: "turn/started", threadId: w.threadId, seq: 8000, createdAt: clock });
  f.history.push({ type: "turn/completed", threadId: w.threadId, seq: 8002, createdAt: clock, data: { status: "failed", error: { message: "Policy block" } } });
  f.threads.set(w.threadId, { ...f.threads.get(w.threadId)!, status });
  const template = f.store.assignment(project.id, 1)!;
  f.store.tx(() => {
    for (let i = 1; i < count; i++) {
      const id = `many-${i}`;
      const worker = f.store.createWorker({ projectId: project.id, role: "work", label: id, area: "perf", bbProjectId: "proj_a" });
      f.store.updateWorker(project.id, worker.num, { threadId: id, generation: 1, state: "active" });
      f.threads.set(id, makeThreadResponse({ id, projectId: "proj_a", environmentId: "env_a", status }));
      const a = f.store.createAssignment({ ...template, workerNum: worker.num, threadId: id, opId: `many-op-${i}`, taskNums: [] });
      f.store.updateAssignment(project.id, a.num, { briefDelivered: true });
    }
  });
  f.send.mockClear();
  return { f, project, w, tick: (ms: number) => (clock += ms) };
}

/** The full-scan interval of the worker check (STUCK_CHECK_MS). */
const STUCK = 3 * 60_000;
