import { describe, expect, it, vi } from "vitest";
import { projectFixture } from "./fake-native";

type Fixture = Awaited<ReturnType<typeof projectFixture>>["f"];
const recorder = { author: "coordinator" as const, threadId: "coordinator", assignment: null };
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** An Initiative with a long history: retired workers, done tasks and settled decisions. */
async function longHistory() {
  const { f, project } = await projectFixture();
  const result = "Shipped. ".repeat(60);
  f.store.tx(() => {
    for (let n = 0; n < 150; n++) {
      const w = f.store.createWorker({ projectId: project.id, role: "work", label: `Worker ${n}`, area: "fixture", bbProjectId: "proj_a" });
      f.store.updateWorker(project.id, w.num, { state: "retired" });
    }
    for (let n = 0; n < 100; n++) {
      const task = f.task(project.id, `Done ${n}`);
      f.store.updateTask(project.id, task.num, { status: "done", result });
    }
  });
  for (let n = 0; n < 100; n++)
    f.service.recordDecision(project.id, { decision: { description: `User choice ${n} ${result}`, madeBy: "user" } }, recorder);
  const unchecked = f.service.recordDecision(project.id, { decision: { description: "Unchecked agent choice", madeBy: "agent" } }, recorder);
  return { f, project, unchecked };
}

/** Count SDK calls by dotted path during `run`. */
async function calls(f: Fixture, run: () => Promise<unknown>) {
  const counts = new Map<string, number>();
  f.intercept((path, _args, call) => {
    counts.set(path, (counts.get(path) ?? 0) + 1);
    return call();
  });
  try {
    await run();
  } finally {
    f.intercept();
  }
  return counts;
}

describe("T112 dashboard first paint", () => {
  it("serves a small summary and keeps history lists for the tiers that show them", async () => {
    const { f, project, unchecked } = await longHistory();
    const summary = (await f.harness.callRpc("overview", { projectId: project.id, detail: "summary" })) as any;
    const history = (await f.harness.callRpc("overview", { projectId: project.id, detail: "history" })) as any;
    const full = (await f.harness.callRpc("overview", { projectId: project.id, detail: "full" })) as any;
    // The summary carries current work and what the Inbox acts on, not the record.
    expect(summary).toMatchObject({ historyLoaded: false, detailsLoaded: false, done: [], workers: { retired: [] } });
    expect(summary.decisions.map((d: { ref: string }) => d.ref)).toEqual([unchecked.ref]);
    expect(summary.counts.done).toBe(100);
    expect(bytes(summary)).toBeLessThan(20_000);
    expect(bytes(summary) * 8).toBeLessThan(bytes(history));
    expect(history).toMatchObject({ historyLoaded: true, detailsLoaded: false });
    expect(history.done).toHaveLength(100);
    expect(history.workers.retired).toHaveLength(150);
    expect(history.decisions).toHaveLength(101);
    expect(full).toMatchObject({ historyLoaded: true, detailsLoaded: true });
    // The older boolean still means summary/full.
    expect(await f.harness.callRpc("overview", { projectId: project.id, detailed: false })).toEqual(summary);
  });

  it("reads each member's native status once across repeated dashboard opens; events keep it current", async () => {
    const { f, project } = await projectFixture();
    const open = () => f.harness.callRpc("overview", { projectId: project.id, detail: "summary" });
    const first = await calls(f, open);
    expect(first.get("threads.get")).toBeGreaterThan(0);
    const again = await calls(f, open);
    expect(again.get("threads.get") ?? 0).toBe(0);
    expect(again.get("projects.get") ?? 0).toBe(0);
    expect(again.get("environments.list") ?? 0).toBe(0);
    expect(again.get("threads.defaultExecutionOptions") ?? 0).toBe(0);
    // A lifecycle event updates the shown status without another read.
    const active = { ...f.threads.get("coordinator")!, status: "active" as const };
    f.threads.set("coordinator", active);
    await f.harness.emitThreadEvent("thread.active", { thread: active });
    let shown: any;
    const evented = await calls(f, async () => { shown = await open(); });
    expect(evented.get("threads.get") ?? 0).toBe(0);
    expect(shown.project.coordinatorStatus).toBe("active");
    // Agent and CLI reads stay fresh.
    const fresh = await calls(f, () => f.overview(project.id));
    expect(fresh.get("threads.get")).toBeGreaterThan(0);
  });

  it("answers stale facts at once, re-reads them in the background and announces a change", async () => {
    const { f, project } = await projectFixture();
    const now = vi.spyOn(Date, "now");
    const start = Date.now();
    now.mockReturnValue(start);
    try {
      const open = () => f.harness.callRpc("overview", { projectId: project.id, detail: "summary" }) as Promise<any>;
      await open();
      now.mockReturnValue(start + 29_000);
      expect((await calls(f, open)).get("threads.get") ?? 0).toBe(0);
      // Natively active, with no event: past the TTL the open still answers
      // from the cache, while a background read catches the change.
      f.threads.set("coordinator", { ...f.threads.get("coordinator")!, status: "active" });
      now.mockReturnValue(start + 31_000);
      let held!: () => void;
      const gate = new Promise<void>((resolve) => { held = resolve; });
      f.intercept(async (path, _args, call) => {
        if (path === "threads.get") await gate;
        return call();
      });
      const signals = f.harness.inspection.realtimeSignals.length;
      const stale = await open();
      expect(stale.project.coordinatorStatus).toBe("idle");
      held();
      await vi.waitFor(() =>
        expect(f.harness.inspection.realtimeSignals.slice(signals)).toContainEqual({ channel: "initiatives-changed", payload: { projectId: project.id } }));
      f.intercept();
      let current: any;
      expect((await calls(f, async () => { current = await open(); })).get("threads.get") ?? 0).toBe(0);
      expect(current.project.coordinatorStatus).toBe("active");
    } finally {
      now.mockRestore();
    }
  });
});

describe("T112 fresh reads (A264)", () => {
  it("a CLI overview reads native status itself instead of joining a pending dashboard read", async () => {
    const { f, project } = await projectFixture();
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    try {
      const open = () => f.harness.callRpc("overview", { projectId: project.id, detail: "summary" });
      await open();
      clock.mockReturnValue(start + 31_000);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let reads = 0;
      f.intercept(async (path, args, call) => {
        if (path !== "threads.get" || args.threadId !== "coordinator") return call();
        reads++;
        const captured = { ...(await call() as object) };
        if (reads === 1) await gate;
        return captured;
      });
      await open();
      f.threads.set("coordinator", { ...f.threads.get("coordinator")!, status: "active" });
      const reply = await f.harness.runCli(["overview", project.id], {});
      release();
      expect(reply.exitCode).toBe(0);
      expect(JSON.parse(reply.stdout!).project.coordinatorStatus).toBe("active");
      expect(reads).toBe(2);
      // The older dashboard read lands after the fresh one and does not undo it.
      await new Promise((resolve) => setTimeout(resolve, 0));
      f.intercept();
      const shown = (await open()) as any;
      expect(shown.project.coordinatorStatus).toBe("active");
    } finally {
      clock.mockRestore();
    }
  });
});

describe("T112 sidebar tree and sweep signals", () => {
  it("rebuilds the tree only after a ledger write", async () => {
    const { f, project } = await projectFixture();
    const projects = vi.spyOn(f.store, "projects");
    const first = await f.harness.callRpc("tree", null);
    const builds = projects.mock.calls.length;
    expect(await f.harness.callRpc("tree", null)).toEqual(first);
    expect(projects.mock.calls.length).toBe(builds);
    f.task(project.id, "A new task");
    const next = (await f.harness.callRpc("tree", null)) as any;
    expect(projects.mock.calls.length).toBeGreaterThan(builds);
    expect(next.projects[0].remaining).toBe((first as any).projects[0].remaining + 1);
  });

  it("a sweep that wrote nothing announces nothing", async () => {
    const { f, project } = await projectFixture();
    // Settle the fixture's first-sweep work, so the next one is quiet.
    await f.runtime.sweep();
    const sweep = vi.spyOn(f.runtime, "sweep");
    const run = async () => {
      const before = f.harness.inspection.realtimeSignals.length;
      const service = f.harness.runService("initiatives-sweep");
      await vi.waitFor(() => expect(sweep).toHaveBeenCalled());
      await sweep.mock.results.at(-1)!.value;
      await new Promise((resolve) => setTimeout(resolve, 0));
      service.controller.abort();
      await service.done;
      sweep.mockClear();
      return f.harness.inspection.realtimeSignals.slice(before);
    };
    expect(await run()).toEqual([]);
    // A sweep that records something still tells every view.
    f.task(project.id, "Pending");
    sweep.mockImplementationOnce(async () => { f.store.log(project.id, "thread", "Sweep wrote"); });
    expect((await run()).map((signal) => signal.channel)).toContain("initiatives-changed");
  });
});
