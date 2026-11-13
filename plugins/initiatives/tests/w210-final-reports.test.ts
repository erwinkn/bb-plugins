import { describe, expect, it, vi } from "vitest";
import type { ThreadDto } from "../lib/bb";
import { fixture, projectFixture, report } from "./fake-native";
import { DEFAULT_COORDINATOR_INSTRUCTIONS, DEFAULT_WORKER_INSTRUCTIONS, GUIDANCE_RESET_FLAG, PREVIOUS_DEFAULTS } from "../lib/guidance";
import { baselineState } from "../lib/pr-watch";
import { BGJOB_WAIT_MAX_MS, PR_WAIT_MAX_MS } from "../lib/service";
import { parseBgjobUnits } from "../lib/bgjobs";

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
async function spawned() {
  const { f, project } = await projectFixture();
  const task = f.task(project.id, "Archived search");
  const [w] = await tool(f, "initiative_spawn", { label: "Search", purpose: "search", text: "Do it.", tasks: [task.ref] });
  return { f, project, task, w };
}
const sentTexts = (f: Fx) => f.send.mock.calls.map(([args]) => args.input[0].text as string);

describe("W210 spawning workers with final-reports-only notices", () => {
  it("workers are spawned explicit, under the coordinator", async () => {
    const { f, w } = await spawned();
    for (const [args] of f.spawn.mock.calls) expect(args).toMatchObject({ parentThreadId: "coordinator", parentNotices: "explicit" });
    expect(f.spawn).toHaveBeenCalledTimes(1);
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

  it("a report needs some text; a long one is sent as its summary", async () => {
    const { f, project, w } = await spawned();
    // W492: either of summary and report stands in for the other (w492-tool-friction), but not neither.
    await expect(tool(f, "initiative_report", { outcome: "done" }, w.threadId)).rejects.toThrow(/summary/);
    const long = `Start. ${"x".repeat(12000)} End.`;
    await tool(f, "initiative_report", { outcome: "done", summary: "Long", report: long }, w.threadId);
    expect(f.store.assignment(project.id, 1)!.report!.finalMessage).toBe(long);
    // W215: the message carries the summary and where to read the rest, not the report.
    const [text] = sentTexts(f);
    expect(text).toBe(`Initiative · Search · W1\n\nW1 reported (done) on A1: Long\n\nFull report (${long.length} characters): initiative_read {refs:["A1"],detailed:true,fields:["report"]}`);
  });

  it("a worker with turn notices is sent the report the same way", async () => {
    const { f, w } = await spawned();
    f.parentNotices(w.threadId, "turns");
    await tool(f, "initiative_report", { outcome: "done", summary: "Done", report: REPORT }, w.threadId);
    expect(sentTexts(f)).toEqual([`Initiative · Search · W1\n\nW1 reported (done) on A1: Done\n\n${REPORT}`]);
  });


  // W212: a capture is not the worker's filing, so filing the same text still sends it.


  it("a blocked report steers the coordinator, the only one it reaches (W555)", async () => {
    const { f, project, w } = await spawned();
    await tool(f, "initiative_report", { outcome: "blocked", summary: "Need the staging key", question: "Which staging key?", report: "Blocked on the key. Everything else is done." }, w.threadId);
    expect(f.send.mock.calls[0][0]).toMatchObject({ threadId: "coordinator", mode: "steer-if-active" });
    expect(sentTexts(f)).toEqual(["Initiative · Search · W1\n\nW1 is blocked on A1: Which staging key?\n\nBlocked on the key. Everything else is done."]);
    expect((await f.overview(project.id, "summary")).opinionNeeded).toEqual([]);
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
    const check = async () => { clock += 4 * 60_000; now.mockReturnValue(clock); await f.service.checkWorkers(); };
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

  // D527: BB runs several queued agent messages as one turn; the event's senderThreadId names only the first.
  it("counts a worker's message carried second in a batched turn", async () => {
    const { f, w, inputAt, check } = await stopped();
    const group = (sender: string, text: string) => [{ type: "text", text: `[bb message from thread:${sender}; sent 2026-10-14T14:02:11Z]\n\n${text}` }];
    const inputGroups = [group("other", "Report from another worker"), group(w.threadId, "Waiting for CI.")];
    f.history.push({ type: "client/turn/requested", seq: ++seq, threadId: "coordinator", createdAt: inputAt + 300, data: { requestId: `creq_${seq}`, initiator: "agent", senderThreadId: "other", input: inputGroups.flat(), inputGroups } });
    await check();
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
    await f.service.checkWorkers();
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
    expect(sentTexts(f)[0]).toBe(`Initiative · Search · W1\n\nW1 stopped (idle) without reporting since its last input. A1 has no report yet. Its last message:\n\nWaiting for CI.\n\nRead its thread (${w.threadId}).`);
    await check();
    expect(stuckSends(f)).toHaveLength(1);
    // A new input re-arms it.
    f.history.push({ type: "client/turn/requested", seq: ++seq, threadId: w.threadId, createdAt: Date.now(), data: { requestId: `creq_${seq}`, input: [] } });
    await check();
    expect(stuckSends(f)).toHaveLength(2);
  });

  // T150: open work on a failed thread is closed and reported by the failed-thread check instead.
  it("says error for a failed thread, and leaves open work on it to the failed-thread check", async () => {
    const { f, project, w, check } = await stopped();
    f.threads.set(w.threadId, { ...f.threads.get(w.threadId)!, status: "error" });
    await check();
    expect(stuckSends(f)).toHaveLength(0);
    await f.service.report(w.threadId, report(), { captured: true });
    expect(f.store.assignment(project.id, 1)!.state).toBe("reported");
    await check();
    expect(stuckSends(f)[0]).toContain("W1 stopped (error) without reporting");
  });

  it("checks at most every few minutes", async () => {
    const { f } = await stopped();
    await f.service.checkWorkers();
    await f.service.checkWorkers();
    expect(stuckSends(f)).toHaveLength(1);
    const later = await stopped();
    vi.spyOn(later.f.service, "now").mockReturnValue(Date.now());
    await later.f.service.checkWorkers();
    await later.f.service.checkWorkers();
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

  // W606: a worker whose ~/.bb/bin/bgjob still runs waits on the job's exit message.
  describe("W606 waiting on a bgjob", () => {
    /** The sweep reads these jobs (thread -> start), counting its reads. */
    function jobs(f: Fx, running: () => Map<string, number>) {
      const reads = { n: 0 };
      f.service.readBgjobs = async () => { reads.n++; return running(); };
      return reads;
    }
    const notice = (w: { threadId: string }, waited = "") =>
      `Initiative · Search · W1\n\nW1 stopped (idle) without reporting since its last input${waited}. A1 has no report yet. Its last message:\n\nWaiting for CI.\n\nRead its thread (${w.threadId}).`;

    it("leaves a worker with a running bgjob alone, sweep after sweep", async () => {
      const { f, w, check } = await stopped();
      jobs(f, () => new Map([[w.threadId, Date.now() - 30_000]]));
      await check();
      await check();
      expect(stuckSends(f)).toEqual([]);
    });

    it("flags it once the job ended and the worker, woken by its exit message, idles again without reporting", async () => {
      const { f, w, check } = await stopped();
      let running = true;
      jobs(f, () => new Map(running ? [[w.threadId, Date.now() - 30_000]] : []));
      await check();
      expect(stuckSends(f)).toEqual([]);
      // The job exits: bgjob tells the thread (a new input), which handles it and stops again.
      running = false;
      const wakeAt = Date.now();
      f.history.push({ type: "client/turn/requested", seq: ++seq, threadId: w.threadId, createdAt: wakeAt, data: { requestId: `creq_${seq}`, input: [] } });
      f.history.push({ type: "turn/started", seq: ++seq, threadId: w.threadId, createdAt: wakeAt });
      f.history.push({ type: "turn/completed", seq: ++seq, threadId: w.threadId, createdAt: wakeAt + 1, data: { status: "completed" } });
      await check();
      expect(stuckSends(f)).toHaveLength(1);
      await check();
      expect(stuckSends(f)).toHaveLength(1);
    });

    // W610: a reviewer idles while its review runs as a bgjob; the job's exit wakes it, and it
    // then reports to the worker.
    it("leaves a worker alone while a descendant's bgjob runs, and flags it once that job ends", async () => {
      const { f, w, check } = await stopped();
      const reviewer = "thr_reviewer";
      f.threads.set(reviewer, { ...f.threads.get(w.threadId)!, id: reviewer, title: "Review r1", parentThreadId: w.threadId });
      f.idle(reviewer);
      let running = true;
      jobs(f, () => new Map(running ? [[reviewer, Date.now() - 30_000]] : []));
      await check();
      await check();
      expect(stuckSends(f)).toEqual([]);
      running = false;
      await check();
      expect(stuckSends(f)).toEqual([notice(w)]);
    });

    it("flags it on the same input when the job ended but its message never came", async () => {
      const { f, w, check } = await stopped();
      let running = true;
      jobs(f, () => new Map(running ? [[w.threadId, Date.now() - 30_000]] : []));
      await check();
      running = false;
      await check();
      expect(stuckSends(f)).toEqual([notice(w)]);
    });

    it("flags as today with nothing pending: no job, another thread's job, or systemd unreadable", async () => {
      const cases: [() => Map<string, number>, number][] = [
        [() => new Map(), 0],
        [() => new Map([["thr_someone_else", Date.now()]]), 0],
        [() => { throw new Error("spawn systemctl ENOENT"); }, 1],
      ];
      for (const [running, logged] of cases) {
        const { f, w, check } = await stopped();
        const warn = vi.spyOn(f.service.bb.log, "warn");
        jobs(f, running);
        await check();
        await check();
        expect(stuckSends(f)).toEqual([notice(w)]);
        // A failed listing is logged once, not every sweep.
        expect(warn.mock.calls.filter(([m]) => String(m).includes("bgjobs"))).toHaveLength(logged);
      }
    });

    it("reads the jobs again before the send: a job listed only after the sweep's first read still counts", async () => {
      const { f, w, check } = await stopped();
      const reads = jobs(f, () => new Map(reads.n > 1 ? [[w.threadId, Date.now()]] : []));
      await check();
      expect(reads.n).toBe(2);
      expect(stuckSends(f)).toEqual([]);
    });

    it("skips a worker that gets a new input while the jobs are read before the send", async () => {
      const { f, w, check } = await stopped();
      const reads = jobs(f, () => {
        if (reads.n === 2) {
          const at = Date.now();
          f.history.push({ type: "client/turn/requested", seq: ++seq, threadId: w.threadId, createdAt: at, data: { requestId: `creq_${seq}`, senderThreadId: "coordinator", input: [] } });
          f.history.push({ type: "turn/started", seq: ++seq, threadId: w.threadId, createdAt: at });
        }
        return new Map();
      });
      await check();
      expect(reads.n).toBe(2);
      expect(stuckSends(f)).toEqual([]);
    });

    it("logs a failed listing once per outage", async () => {
      const { f, w, check } = await stopped();
      const warn = vi.spyOn(f.service.bb.log, "warn");
      let up = false;
      const reads = jobs(f, () => { if (!up) throw new Error("Failed to connect to bus"); return new Map(); });
      const logged = () => warn.mock.calls.filter(([m]) => String(m).includes("bgjobs")).length;
      // Each sweep finds the worker stopped on a new input, so each asks systemd.
      const sweep = async () => {
        const at = Date.now();
        f.history.push({ type: "client/turn/requested", seq: ++seq, threadId: w.threadId, createdAt: at, data: { requestId: `creq_${seq}`, input: [] } });
        f.history.push({ type: "turn/started", seq: ++seq, threadId: w.threadId, createdAt: at });
        f.history.push({ type: "turn/completed", seq: ++seq, threadId: w.threadId, createdAt: at + 1, data: { status: "completed" } });
        await check();
      };
      await sweep();
      await sweep();
      expect(logged()).toBe(1);
      up = true;
      await sweep();
      up = false;
      await sweep();
      expect(reads.n).toBe(8);
      expect(logged()).toBe(2);
    });

    it("counts the cap from the job's start or the latest input, whichever is later", async () => {
      // A job started long before the input: the input anchors the window.
      const early = await stopped();
      jobs(early.f, () => new Map([[early.w.threadId, early.inputAt - 10 * 3_600_000]]));
      const sweep = async (f: Fx, at: number) => { vi.spyOn(f.service, "now").mockReturnValue(at); await f.service.checkWorkers(); };
      await sweep(early.f, early.inputAt + BGJOB_WAIT_MAX_MS - 4 * 60_000);
      expect(stuckSends(early.f)).toEqual([]);
      await sweep(early.f, early.inputAt + BGJOB_WAIT_MAX_MS + 60_000);
      expect(stuckSends(early.f)).toHaveLength(1);
      // A job started 2 h after the input: its start anchors the window.
      const late = await stopped();
      const start = late.inputAt + 2 * 3_600_000;
      jobs(late.f, () => new Map([[late.w.threadId, start]]));
      await sweep(late.f, late.inputAt + BGJOB_WAIT_MAX_MS + 60_000);
      expect(stuckSends(late.f)).toEqual([]);
      await sweep(late.f, start + BGJOB_WAIT_MAX_MS + 60_000);
      expect(stuckSends(late.f)).toHaveLength(1);
      // A start ahead of the clock counts from now, not from the future.
      const future = await stopped();
      jobs(future.f, () => new Map([[future.w.threadId, future.inputAt + 100 * 3_600_000]]));
      await sweep(future.f, future.inputAt + 60_000);
      await sweep(future.f, future.inputAt + 10 * 60_000);
      expect(stuckSends(future.f)).toEqual([]);
      await sweep(future.f, future.inputAt + BGJOB_WAIT_MAX_MS + 20 * 60_000);
      expect(stuckSends(future.f)).toEqual([]);
    });

    it("flags it after BGJOB_WAIT_MAX_MS from the job's start or the latest input, whichever is later, saying a job still runs", async () => {
      const { f, w } = await stopped();
      const start = Date.now();
      jobs(f, () => new Map([[w.threadId, start]]));
      const sweepAt = async (at: number) => { vi.spyOn(f.service, "now").mockReturnValue(at); await f.service.checkWorkers(); };
      await sweepAt(start + BGJOB_WAIT_MAX_MS - 4 * 60_000);
      expect(stuckSends(f)).toEqual([]);
      await sweepAt(start + BGJOB_WAIT_MAX_MS + 60_000);
      expect(stuckSends(f)).toEqual([notice(w, ", though a bgjob of its still runs: nothing has woken it for 3 h")]);
    });

    it("asks systemd once a sweep, and only for a worker that got that far", async () => {
      const { f, w, check } = await stopped();
      const reads = jobs(f, () => new Map([[w.threadId, Date.now()]]));
      await check();
      expect(reads.n).toBe(1);
      // Reported: nothing to flag, nothing to ask.
      await tool(f, "initiative_report", { outcome: "done", summary: "Done", report: REPORT }, w.threadId);
      await check();
      expect(reads.n).toBe(1);
    });

    it("reads each thread's newest active unit from systemctl's listing", () => {
      const out = [
        // systemctl sorts by unit name, so a thread's older job comes first.
        "bgjob-thr_38zyerigmt-20261112T160000Z-12.service loaded active running [systemd-run] /home/erwin/.bb/bin/bgjob --run /y",
        "bgjob-thr_38zyerigmt-20261112T170045Z-303934.service  loaded active running [systemd-run] /home/erwin/.bb/bin/bgjob --run /x",
        "bgjob-nothread-20261112T165931Z-198881.service loaded deactivating stop-sigterm [systemd-run] bgjob",
        "bgjob-garbage.service loaded active running x",
        "",
      ].join("\n");
      expect(parseBgjobUnits(out)).toEqual(new Map([
        ["thr_38zyerigmt", Date.UTC(2026, 10, 12, 17, 0, 45)],
        ["nothread", Date.UTC(2026, 10, 12, 16, 59, 31)],
      ]));
    });
  });

  // W563: a worker that watches an open PR waits on its wake, as one with a live child waits on it.
  describe("W563 waiting on a watched PR", () => {
    const url = "https://github.com/eq/market/pull/7";
    /** `threadId` watches PR 7, its checks pending, from now (store time). */
    const watch = (f: Fx, projectId: string, threadId: string) =>
      f.service.prWatches.watch(url, projectId, threadId, "PR_7", baselineState({
        state: "OPEN", head: "abc", mergeable: "mergeable", createdAt: 0, checks: [{ name: "tests", outcome: "pending", required: false }], comments: [],
      }, f.store.now(), ""));
    /** A sweep at `at` (service time). */
    const sweepAt = async (f: Fx, at: number) => { vi.spyOn(f.service, "now").mockReturnValue(at); await f.service.checkWorkers(); };

    it("leaves a worker that watches an open PR alone, sweep after sweep", async () => {
      const { f, project, w, check } = await stopped();
      watch(f, project.id, w.threadId);
      await check();
      await check();
      expect(stuckSends(f)).toHaveLength(0);
    });

    it("flags it after PR_WAIT_MAX_MS with no input or new watch, saying it watches a PR, once", async () => {
      const { f, project, w } = await stopped();
      watch(f, project.id, w.threadId);
      const since = f.store.now();
      await sweepAt(f, since + PR_WAIT_MAX_MS - 4 * 60_000);
      expect(stuckSends(f)).toHaveLength(0);
      await sweepAt(f, since + PR_WAIT_MAX_MS + 60_000);
      expect(stuckSends(f)).toEqual([`Initiative · Search · W1\n\nW1 stopped (idle) without reporting since its last input, though it watches an open PR: nothing has woken it for 6 h. A1 has no report yet. Its last message:\n\nWaiting for CI.\n\nRead its thread (${w.threadId}).`]);
      await sweepAt(f, since + PR_WAIT_MAX_MS + 10 * 60_000);
      expect(stuckSends(f)).toHaveLength(1);
    });

    it("counts the window from its newest watch, or its latest input (a wake), whichever is later", async () => {
      const { f, project, w } = await stopped();
      const t0 = f.store.now();
      watch(f, project.id, w.threadId);
      // Watched again 5 h later (a push): the window restarts there.
      vi.spyOn(f.store, "now").mockReturnValue(t0 + 5 * 3_600_000);
      watch(f, project.id, w.threadId);
      await sweepAt(f, t0 + PR_WAIT_MAX_MS + 60_000);
      expect(stuckSends(f)).toHaveLength(0);
      // A wake 10 h in (a new input), handled, then quiet: the window restarts at the input.
      const wakeAt = t0 + 10 * 3_600_000;
      f.history.push({ type: "client/turn/requested", seq: ++seq, threadId: w.threadId, createdAt: wakeAt, data: { requestId: `creq_${seq}`, input: [] } });
      f.history.push({ type: "turn/started", seq: ++seq, threadId: w.threadId, createdAt: wakeAt });
      f.history.push({ type: "turn/completed", seq: ++seq, threadId: w.threadId, createdAt: wakeAt + 1, data: { status: "completed" } });
      await sweepAt(f, t0 + 5 * 3_600_000 + PR_WAIT_MAX_MS + 60_000);
      expect(stuckSends(f)).toHaveLength(0);
      await sweepAt(f, wakeAt + PR_WAIT_MAX_MS + 60_000);
      expect(stuckSends(f)).toHaveLength(1);
    });

    it("flags as before once the PR merges or closes, or the watch ends; another thread's watch doesn't count", async () => {
      for (const end of ["MERGED", "CLOSED", "unwatched", "other"] as const) {
        const { f, project, w, check } = await stopped();
        watch(f, project.id, end === "other" ? "thr_someone_else" : w.threadId);
        const row = f.service.prWatches.row(url)!;
        if (end === "unwatched") f.service.prWatches.unwatch(url, w.threadId);
        else if (end !== "other") f.service.prWatches.write([{ url, gen: row.gen, state: { ...row.state!, ended: end }, wake: null }]);
        await check();
        expect(stuckSends(f), end).toEqual([expect.stringContaining("W1 stopped (idle) without reporting since its last input. A1 has no report yet. Its last message:")]);
      }
    });

    // W564: the Workers tab words the wait from prWaits, which answers from the ledger and memory.
    it("prWaits lists the open PRs a thread watches, counting the wait from its newest watch or the input the sweep saw", async () => {
      const { f, project, w, inputAt, check } = await stopped();
      expect(f.service.prWaits().size).toBe(0);
      // The watch's time, held still: a millisecond's tick between the two reads failed this test.
      const watchedAt = f.store.now();
      vi.spyOn(f.store, "now").mockReturnValue(watchedAt);
      watch(f, project.id, w.threadId);
      // Before the sweep has read its input, the wait counts from the watch.
      expect(f.service.prWaits().get(w.threadId)).toEqual({ urls: [url], since: watchedAt });
      await check();
      expect(f.service.prWaits().get(w.threadId)).toEqual({ urls: [url], since: Math.max(watchedAt, inputAt) });
      // A second PR, then a merge of the first: only open ones count.
      const other = "https://github.com/eq/market/pull/9";
      f.service.prWatches.watch(other, project.id, w.threadId, "PR_9", f.service.prWatches.row(url)!.state!);
      expect(f.service.prWaits().get(w.threadId)!.urls).toEqual([url, other]);
      const row = f.service.prWatches.row(url)!;
      f.service.prWatches.write([{ url, gen: row.gen, state: { ...row.state!, ended: "MERGED" }, wake: null }]);
      expect(f.service.prWaits().get(w.threadId)!.urls).toEqual([other]);
      f.service.prWatches.unwatch(other, w.threadId);
      expect(f.service.prWaits().has(w.threadId)).toBe(false);
    });

    it("checks the watch again right before the send: one started while the sweep read the coordinator counts", async () => {
      const { f, project, w, check } = await stopped();
      const gate = hold(f, (path, args) => path === "threads.events.list" && args.threadId === "coordinator");
      const pending = check();
      await gate.at;
      watch(f, project.id, w.threadId);
      gate.release(); await pending;
      expect(stuckSends(f)).toHaveLength(0);
    });
  });
});

describe("W210 guidance", () => {
  it("defaults say how to report; the previous shipped defaults upgrade to them", async () => {
    expect(DEFAULT_WORKER_INSTRUCTIONS).toContain("Finish with initiative_report {outcome, summary, report}.");
    expect(DEFAULT_WORKER_INSTRUCTIONS).toContain("Ending a turn reports nothing.");
    expect(DEFAULT_COORDINATOR_INSTRUCTIONS).toContain("A worker reports once: done (clean review: verdict correct, no P1 or P2) or blocked");
    const before = { coordinator: PREVIOUS_DEFAULTS.coordinator.find(text => text.includes("Read it, send fixes back"))!, worker: PREVIOUS_DEFAULTS.worker.find(text => text.includes("Your final message is your report"))! };
    const f = fixture({ coordinatorInstructions: before.coordinator, workerInstructions: before.worker });
    f.store.setFlag(GUIDANCE_RESET_FLAG);
    await f.preferences.ready;
    expect(f.preferences.configuration()).toMatchObject({ coordinatorInstructions: DEFAULT_COORDINATOR_INSTRUCTIONS, workerInstructions: DEFAULT_WORKER_INSTRUCTIONS });
    expect(before.worker).toBeDefined();
    expect(before.coordinator).toBeDefined();
  });
});
