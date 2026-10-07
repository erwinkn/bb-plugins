import { describe, expect, it, vi } from "vitest";
import type { ThreadDto } from "../lib/bb";
import { fixture, projectFixture, report } from "./fake-native";
import { DEFAULT_COORDINATOR_INSTRUCTIONS, DEFAULT_WORKER_INSTRUCTIONS, GUIDANCE_RESET_FLAG, PREVIOUS_DEFAULTS } from "../lib/guidance";

// W210 (D417): workers run with "explicit" parent notices (final reports only), so their turn
// ends never wake the coordinator. initiative_report sends the report once as an ordinary
// message; a periodic check tells the coordinator about workers that stopped without reporting.
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const tool = async (f: Fx, name: string, input: unknown, threadId = "coordinator") => JSON.parse(await f.harness.callAgentTool(name, input, { threadId }) as string);
const REPORT = "## Done\n\nArchived records are indexed and ranked below live ones.\n\nRan npm test: 14 passed. Nothing uncommitted.";
let seq = 1000;
/** A turn that received the latest brief and ends with this final message. */
function finishTurn(f: Fx, text: string, status = "completed") {
  const brief = (f.store.db.prepare("SELECT brief_text FROM assignments ORDER BY rowid DESC LIMIT 1").get() as { brief_text: string }).brief_text;
  const request = `creq_${++seq}`;
  f.history.push({ type: "client/turn/requested", seq: ++seq, createdAt: Date.now(), data: { requestId: request, initiator: "agent", input: [{ type: "text", text: brief }] } });
  // The turn began before anything the test filed in it.
  f.history.push({ type: "turn/started", seq: ++seq, createdAt: Date.now() - 60_000 });
  f.history.push({ type: "turn/input/accepted", seq: ++seq, createdAt: Date.now(), data: { clientRequestId: request } });
  f.history.push({ type: "item/completed", seq: ++seq, createdAt: Date.now(), data: { item: { type: "agentMessage", id: `m${seq}`, text } } });
  f.history.push({ type: "turn/completed", seq: ++seq, createdAt: Date.now() + 1, data: { status } });
}
async function spawned(role: "work" | "review" = "work") {
  const { f, project } = await projectFixture();
  const task = f.task(project.id, "Archived search");
  const [w] = await tool(f, "initiative_spawn", { label: "Search", purpose: "search", text: "Do it.", tasks: [task.ref] });
  if (role === "work") return { f, project, task, w };
  await tool(f, "initiative_report", { outcome: "done", summary: "Search covers archives", report: REPORT }, w.threadId);
  f.send.mockClear();
  const [r] = await tool(f, "initiative_spawn", { label: "Review", purpose: "review search", text: "Review it.", role: "review", reviews: "W1" });
  return { f, project, task, w: r };
}
const sentTexts = (f: Fx) => f.send.mock.calls.map(([args]) => args.input[0].text as string);

describe("W210 spawning workers with final-reports-only notices", () => {
  it("work and review workers are spawned explicit, under the coordinator", async () => {
    const { f, w } = await spawned("review");
    for (const [args] of f.spawn.mock.calls) expect(args).toMatchObject({ parentThreadId: "coordinator", parentNotices: "explicit" });
    expect(f.spawn).toHaveBeenCalledTimes(2);
    expect(f.threads.get(w.threadId)).toMatchObject({ parentNotices: "explicit" });
    expect(f.update.mock.calls.filter(([args]) => "parentNotices" in args)).toHaveLength(0);
  });

  it("a coordinator keeps ordinary turn notices", async () => {
    const { f, project } = await projectFixture();
    expect((await f.harness.runCli(["recreate-coordinators", project.id, "--wait=0"])).exitCode).toBe(0);
    expect(f.store.project(project.id)!.coordinatorThreadId).not.toBe("coordinator");
    expect(f.spawn.mock.calls.at(-1)![0]).not.toHaveProperty("parentNotices");
  });

  it("an older server that drops the field gets an update; refused, it logs once and works as before", async () => {
    const { f, project } = await projectFixture();
    let updates = 0;
    f.intercept((path, args, call) => {
      if (path === "threads.update" && "parentNotices" in args && ++updates)
        throw Object.assign(new Error("At least one field must be provided"), { status: 400 });
      if (path !== "threads.spawn") return call();
      return (async () => {
        const { parentNotices: _dropped, ...thread } = await (call() as Promise<Record<string, unknown>>);
        f.threads.set(thread.id as string, thread as never);
        return thread;
      })();
    });
    const [w1] = await tool(f, "initiative_spawn", { label: "One", purpose: "one", text: "Do it." });
    const [w2] = await tool(f, "initiative_spawn", { label: "Two", purpose: "two", text: "Do it." });
    expect([w1.state, w2.state]).toEqual(["running", "running"]);
    expect(updates).toBe(2);
    expect(f.store.activity(project.id, 100).filter(a => a.summary.includes("final-reports-only"))).toHaveLength(1);
    // The plugin still sends the report itself.
    f.intercept(undefined);
    await tool(f, "initiative_report", { outcome: "done", summary: "One is done", report: REPORT }, w1.threadId);
    expect(sentTexts(f)).toEqual([`Initiative · Search · W1\n\nW1 reported (done) on A1: One is done\n\n${REPORT}`]);
  });

  it("a server that refuses the field on spawn spawns again without it", async () => {
    const { f } = await projectFixture();
    f.intercept((path, args, call) => {
      if (path === "threads.spawn" && "parentNotices" in args)
        throw Object.assign(new Error('Unrecognized key: "parentNotices"'), { status: 400 });
      return call();
    });
    const [w] = await tool(f, "initiative_spawn", { label: "One", purpose: "one", text: "Do it." });
    expect(w.state).toBe("running");
    expect(f.threads.get(w.threadId)).toMatchObject({ parentNotices: "explicit" });
    expect(f.update.mock.calls.filter(([args]) => "parentNotices" in args)).toHaveLength(1);
  });
});

describe("W210 report delivery", () => {
  it("initiative_report records the report and sends it once, as a message from the worker", async () => {
    const { f, project, w } = await spawned();
    const result = await tool(f, "initiative_report", { outcome: "done", summary: "Search covers archives", report: REPORT }, w.threadId);
    expect(result.note).toBe("Report recorded and sent to the coordinator.");
    expect(f.store.assignment(project.id, 1)!.report).toMatchObject({ outcome: "succeeded", summary: "Search covers archives", finalMessage: REPORT });
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0][0]).toMatchObject({ threadId: "coordinator", senderThreadId: w.threadId, mode: "queue-if-active" });
    expect(sentTexts(f)[0]).toBe(`Initiative · Search · W1\n\nW1 reported (done) on A1: Search covers archives\n\n${REPORT}`);
    // The same call again, and the turn's end, send nothing more and keep the reported text.
    await tool(f, "initiative_report", { outcome: "done", summary: "Search covers archives", report: REPORT }, w.threadId);
    finishTurn(f, "Reported.");
    await f.runtime.onThreadIdle(f.idle(w.threadId));
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.store.assignment(project.id, 1)!.report!.finalMessage).toBe(REPORT);
  });

  it("the report text is required and bounded; a long one is clipped in the message", async () => {
    const { f, project, w } = await spawned();
    await expect(tool(f, "initiative_report", { outcome: "done", summary: "No text" }, w.threadId)).rejects.toThrow(/report/);
    await expect(tool(f, "initiative_report", { outcome: "done", summary: "Too long", report: "x".repeat(20001) }, w.threadId)).rejects.toThrow();
    const long = `Start. ${"x".repeat(12000)} End.`;
    await tool(f, "initiative_report", { outcome: "done", summary: "Long", report: long }, w.threadId);
    expect(f.store.assignment(project.id, 1)!.report!.finalMessage).toBe(long);
    const [text] = sentTexts(f);
    expect(text).toContain("Start. ");
    expect(text).not.toContain(" End.");
    expect(text).toMatch(/\[… \d+ more characters\. The full report: initiative_read \{refs:\["A1"\],detailed:true,fields:\["report"\]\}\]$/);
  });

  it("a worker with turn notices is sent the report the same way", async () => {
    const { f, w } = await spawned();
    f.parentNotices(w.threadId, "turns");
    await tool(f, "initiative_report", { outcome: "done", summary: "Done", report: REPORT }, w.threadId);
    expect(sentTexts(f)).toEqual([`Initiative · Search · W1\n\nW1 reported (done) on A1: Done\n\n${REPORT}`]);
  });

  it("without initiative_report, the final message is recorded for the dashboard and not sent", async () => {
    const { f, project, w } = await spawned();
    finishTurn(f, REPORT);
    await f.runtime.onThreadIdle(f.idle(w.threadId));
    expect(f.store.assignment(project.id, 1)).toMatchObject({ state: "reported", report: { outcome: "succeeded", summary: "Done", finalMessage: REPORT } });
    expect(f.send).not.toHaveBeenCalled();
  });

  // W212: a capture is not the worker's filing, so filing the same text still sends it.
  it("a worker's own filing of a captured report's text is sent", async () => {
    const { f, project, w } = await spawned();
    finishTurn(f, REPORT);
    await f.runtime.onThreadIdle(f.idle(w.threadId));
    expect(f.send).not.toHaveBeenCalled();
    const { summary } = f.store.assignment(project.id, 1)!.report!;
    await tool(f, "initiative_report", { outcome: "done", summary, report: REPORT }, w.threadId);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.store.assignment(project.id, 1)!.report).not.toHaveProperty("captured");
  });

  it("a captured final message never replaces a report filed while capture was reading", async () => {
    const { f, project, w } = await spawned();
    finishTurn(f, "Captured final");
    let release!: () => void, reached!: () => void, held = false;
    const at = new Promise<void>(r => (reached = r)), gate = new Promise<void>(r => (release = r));
    // Hold capture's read of where the brief entered the thread.
    f.intercept(async (path, args, call) => {
      if (path === "threads.events.list" && !held && args.types?.[0] === "turn/input/accepted" && args.order === "desc") { held = true; reached(); await gate; }
      return call();
    });
    const capture = f.runtime.onThreadIdle(f.idle(w.threadId));
    await at;
    await tool(f, "initiative_report", { outcome: "done", summary: "Filed", report: REPORT }, w.threadId);
    release(); await capture;
    expect(f.store.assignment(project.id, 1)!.report).toMatchObject({ summary: "Filed", finalMessage: REPORT });
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("a blocked report steers the coordinator and waits in the Inbox as before", async () => {
    const { f, project, w } = await spawned();
    await tool(f, "initiative_report", { outcome: "blocked", summary: "Need the staging key", question: "Which staging key?", report: "Blocked on the key. Everything else is done." }, w.threadId);
    expect(f.send.mock.calls[0][0]).toMatchObject({ threadId: "coordinator", mode: "steer-if-active" });
    expect(sentTexts(f)).toEqual(["Initiative · Search · W1\n\nW1 is blocked on A1: Which staging key?\n\nBlocked on the key. Everything else is done."]);
    expect((await f.overview(project.id, "summary")).blockers.map(b => b.question)).toEqual(["Which staging key?"]);
  });

  it("a reviewer reports the same way", async () => {
    const { f, project, w } = await spawned("review");
    await tool(f, "initiative_report", { outcome: "done", summary: "Two findings", report: "1. Ranking ignores archives.\n2. No test for empty queries." }, w.threadId);
    expect(f.store.assignment(project.id, 2)!.report!.finalMessage).toContain("Ranking ignores archives");
    expect(sentTexts(f)).toEqual(["Initiative · Search · W2\n\nW2 reported (done) on A2: Two findings\n\n1. Ranking ignores archives.\n2. No test for empty queries."]);
  });
});

describe("W210 stuck workers", () => {
  /** A worker whose turn took the latest input and ended with `last`; then a stuck check, the clock moved past its interval. */
  async function stopped(last = "Waiting for CI.") {
    const { f, project, w } = await spawned();
    const inputAt = Date.now() - 60_000;
    f.history.push({ type: "client/turn/requested", seq: ++seq, threadId: w.threadId, createdAt: inputAt, data: { requestId: `creq_${seq}`, senderThreadId: "coordinator", input: [] } });
    f.history.push({ type: "turn/started", seq: ++seq, threadId: w.threadId, createdAt: inputAt });
    f.history.push({ type: "item/completed", seq: ++seq, threadId: w.threadId, createdAt: inputAt + 1, data: { item: { type: "agentMessage", text: last } } });
    f.history.push({ type: "turn/completed", seq: ++seq, threadId: w.threadId, createdAt: inputAt + 2, data: { status: "completed" } });
    f.idle(w.threadId);
    let clock = Date.now();
    const now = vi.spyOn(f.service, "now");
    const check = async () => { clock += 4 * 60_000; now.mockReturnValue(clock); await f.service.flagStuckWorkers(); };
    return { f, project, w, inputAt, check };
  }
  const stuckSends = (f: Fx) => sentTexts(f).filter(t => t.includes("without reporting"));
  /** The coordinator received a message from `sender` at `at`. */
  const delivered = (f: Fx, sender: string, at: number) =>
    f.history.push({ type: "client/turn/requested", seq: ++seq, threadId: "coordinator", createdAt: at, data: { requestId: `creq_${seq}`, senderThreadId: sender, input: [] } });
  /** Holds the first SDK call matching `match` until released. */
  function hold(f: Fx, match: (path: string, args: any) => boolean) {
    let reached!: () => void, release!: () => void, held = false;
    const at = new Promise<void>(r => (reached = r)), gate = new Promise<void>(r => (release = r));
    f.intercept(async (path, args, call) => {
      if (!held && match(path, args)) { held = true; reached(); await gate; }
      return call();
    });
    return { at, release };
  }

  // W212: eligibility is checked again right before each send.
  it("skips a worker that reports while the check reads its thread", async () => {
    const { f, w, check } = await stopped();
    const gate = hold(f, (path, args) => path === "threads.events.list" && args.threadId === w.threadId && args.types?.includes("turn/started"));
    const pending = check();
    await gate.at;
    await tool(f, "initiative_report", { outcome: "done", summary: "Done", report: REPORT }, w.threadId);
    gate.release(); await pending;
    expect(stuckSends(f)).toHaveLength(0);
  });

  it("skips a worker retired while the check reads the coordinator", async () => {
    const { f, project, w, check } = await stopped();
    await f.service.report(w.threadId, report(), { captured: true });
    const gate = hold(f, (path, args) => path === "threads.events.list" && args.threadId === "coordinator");
    const pending = check();
    await gate.at;
    await f.service.retireWorker(project.id, w.worker, "Finished.");
    gate.release(); await pending;
    expect(stuckSends(f)).toHaveLength(0);
  });

  it("skips a worker that took a new input after the list read", async () => {
    const { f, w, check } = await stopped();
    const gate = hold(f, (path, args) => path === "threads.events.list" && args.threadId === w.threadId && args.limit === "1");
    const pending = check();
    await gate.at;
    f.history.push({ type: "client/turn/requested", seq: ++seq, threadId: w.threadId, createdAt: Date.now(), data: { requestId: `creq_${seq}`, input: [] } });
    f.history.push({ type: "turn/started", seq: ++seq, threadId: w.threadId, createdAt: Date.now() });
    gate.release(); await pending;
    expect(stuckSends(f)).toHaveLength(0);
  });

  it("pages the coordinator's inputs back past the worker's latest input", async () => {
    const { f, w, inputAt, check } = await stopped();
    delivered(f, w.threadId, inputAt + 300);
    for (let n = 0; n < 250; n++) delivered(f, `other-${n}`, inputAt + 400 + n);
    await check();
    expect(stuckSends(f)).toHaveLength(0);
    // Without that message, its silence is proven only by reading past the other 250.
    const silent = await stopped();
    for (let n = 0; n < 250; n++) delivered(silent.f, `other-${n}`, silent.inputAt + 400 + n);
    await silent.check();
    expect(stuckSends(silent.f)).toHaveLength(1);
  });

  it("reaches workers beyond one list scan in later sweeps", async () => {
    const { f, w, check } = await stopped();
    const [row] = (await f.bb.sdk.threads.list({ projectId: "proj_a" })).filter(r => r.id === w.threadId);
    const rows = [...Array.from({ length: 1000 }, (_, i) => ({ ...row!, id: `unrelated-${i}` })), row!];
    f.intercept((path, args, call) => path === "threads.list" && args.parentThreadId === undefined ? rows.slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 200)) : call());
    await check();
    expect(stuckSends(f)).toHaveLength(0);
    await check();
    expect(stuckSends(f)).toHaveLength(1);
  });

  it("reads the coordinator's inputs once for all workers", async () => {
    const { f } = await projectFixture();
    for (let i = 0; i < 100; i++) {
      const [w] = await tool(f, "initiative_spawn", { label: `Worker ${i}`, purpose: "search", text: "Do the batch." });
      const at = Date.now() - 60_000;
      f.history.push({ type: "client/turn/requested", seq: ++seq, threadId: w.threadId, createdAt: at, data: { requestId: `creq_${seq}`, input: [] } });
      f.history.push({ type: "turn/completed", seq: ++seq, threadId: w.threadId, createdAt: at + 1, data: { status: "completed" } });
      f.idle(w.threadId);
      delivered(f, w.threadId, at + 500);
    }
    f.send.mockClear();
    const calls: { path: string; args: any }[] = [];
    f.intercept((path, args, call) => { calls.push({ path, args }); return call(); });
    await f.service.flagStuckWorkers();
    expect(f.send).not.toHaveBeenCalled();
    const reads = (thread: (id: string) => boolean) => calls.filter(c => c.path === "threads.events.list" && thread(c.args.threadId)).length;
    expect(reads(id => id === "coordinator")).toBeLessThanOrEqual(2);
    expect(reads(id => id !== "coordinator")).toBe(100);
    expect(calls.filter(c => c.path === "threads.list")).toHaveLength(1);
  });

  it("flags a stopped worker that hasn't messaged the coordinator, once per input", async () => {
    const { f, w, check } = await stopped();
    await check();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0][0]).toMatchObject({ threadId: "coordinator", mode: "queue-if-active" });
    expect(f.send.mock.calls[0][0]).not.toHaveProperty("senderThreadId");
    expect(sentTexts(f)[0]).toBe(`Initiative · Search · W1\n\nW1 stopped (idle) without reporting since its last input. Its last message:\n\nWaiting for CI.\n\nRead its thread (${w.threadId}).`);
    await check();
    expect(stuckSends(f)).toHaveLength(1);
    // A new input re-arms it.
    f.history.push({ type: "client/turn/requested", seq: ++seq, threadId: w.threadId, createdAt: Date.now(), data: { requestId: `creq_${seq}`, input: [] } });
    await check();
    expect(stuckSends(f)).toHaveLength(2);
  });

  it("says error for a failed thread", async () => {
    const { f, w, check } = await stopped();
    f.threads.set(w.threadId, { ...f.threads.get(w.threadId)!, status: "error" });
    await check();
    expect(stuckSends(f)[0]).toContain("W1 stopped (error) without reporting");
  });

  it("checks at most every few minutes", async () => {
    const { f } = await stopped();
    await f.service.flagStuckWorkers();
    await f.service.flagStuckWorkers();
    expect(stuckSends(f)).toHaveLength(1);
    const later = await stopped();
    vi.spyOn(later.f.service, "now").mockReturnValue(Date.now());
    await later.f.service.flagStuckWorkers();
    await later.f.service.flagStuckWorkers();
    expect(stuckSends(later.f)).toHaveLength(1);
  });

  it("skips a worker that is running, has queued input, or runs background work", async () => {
    for (const state of [{ status: "active" }, { queuedMessageCount: 1 }, { activeBackgroundAgentCount: 1 }]) {
      const { f, w, check } = await stopped();
      f.threads.set(w.threadId, { ...f.threads.get(w.threadId)!, ...state } as ThreadDto);
      await check();
      expect(f.send).not.toHaveBeenCalled();
    }
  });

  it("skips when the background-task data is unknown", async () => {
    const { f, check } = await stopped();
    f.intercept(async (path, _args, call) => {
      const result = await call();
      return path === "threads.list" ? (result as Record<string, unknown>[]).map(({ activity: _unknown, ...row }) => row) : result;
    });
    await check();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("skips a worker that messaged the coordinator since its last input, delivered or still queued", async () => {
    const delivered = await stopped();
    delivered.f.history.push({ type: "client/turn/requested", seq: ++seq, threadId: "coordinator", createdAt: delivered.inputAt + 10, data: { requestId: `creq_${seq}`, senderThreadId: delivered.w.threadId, input: [] } });
    await delivered.check();
    expect(delivered.f.send).not.toHaveBeenCalled();
    const queued = await stopped();
    queued.f.queued.set("coordinator", [{ id: "q1", content: [], senderThreadId: queued.w.threadId } as never]);
    await queued.check();
    expect(queued.f.send).not.toHaveBeenCalled();
    // A message from before the latest input doesn't count.
    const earlier = await stopped();
    earlier.f.history.push({ type: "client/turn/requested", seq: ++seq, threadId: "coordinator", createdAt: earlier.inputAt - 10, data: { requestId: `creq_${seq}`, senderThreadId: earlier.w.threadId, input: [] } });
    await earlier.check();
    expect(stuckSends(earlier.f)).toHaveLength(1);
  });

  it("skips retired workers", async () => {
    const { f, project, check } = await stopped();
    f.store.updateWorker(project.id, 1, { state: "retired" });
    await check();
    expect(f.send).not.toHaveBeenCalled();
  });
});

describe("W210 guidance", () => {
  it("defaults say how to report; the previous shipped defaults upgrade to them", async () => {
    expect(DEFAULT_WORKER_INSTRUCTIONS).toContain("Finish with initiative_report {outcome, summary, report}, which sends your report to the coordinator.");
    expect(DEFAULT_WORKER_INSTRUCTIONS).toContain("Stop background servers first.");
    expect(DEFAULT_COORDINATOR_INSTRUCTIONS).toContain('A "stopped without reporting" message means a worker is stuck; read its thread.');
    const f = fixture({ coordinatorInstructions: PREVIOUS_DEFAULTS.coordinator[0]!, workerInstructions: PREVIOUS_DEFAULTS.worker[0]! });
    f.store.setFlag(GUIDANCE_RESET_FLAG);
    await f.preferences.ready;
    expect(f.preferences.configuration()).toMatchObject({ coordinatorInstructions: DEFAULT_COORDINATOR_INSTRUCTIONS, workerInstructions: DEFAULT_WORKER_INSTRUCTIONS });
    expect(PREVIOUS_DEFAULTS.worker[0]).toContain("Your final message is your report");
  });
});
