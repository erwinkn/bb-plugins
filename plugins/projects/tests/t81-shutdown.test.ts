import { describe, expect, it } from "vitest";
import { projectFixture, report } from "./fake-native";

// T81: aborting projects-sweep stops new native work promptly. The sweep
// checks its signal before each new unit of work and right after each pure
// read; only the hot threads.list scan read carries the signal. A mutation
// issued before abort still settles with its receipt, and every unconfirmed
// op or pending handover stays for the next sweep. Held reads and mutations
// are released by hand, so nothing here depends on timing.

type Fixture = Awaited<ReturnType<typeof projectFixture>>["f"];

const MUTATIONS = new Set([
  "threads.spawn",
  "threads.fork",
  "threads.send",
  "threads.archive",
  "threads.stop",
  "threads.update",
  "threads.updatePluginMetadata",
  "threads.queuedMessages.delete",
]);

/** Journal every SDK call with its abort phase; `hold` holds selected calls. */
function journal(f: Fixture) {
  const calls: { path: string; afterAbort: boolean; signal: unknown }[] = [];
  const holds = new Map<string, Hold>();
  let aborted = false;
  f.intercept((path, args, call) => {
    calls.push({ path, afterAbort: aborted, signal: args?.signal });
    const hold = holds.get(path);
    if (!hold || hold.calls.length || !hold.match(args)) return call();
    return hold.take(args, call);
  });
  const changes = () =>
    (f.store.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
  return {
    calls,
    changes,
    /** Hold the first (matching) call to `path` until released (or its signal aborts). */
    hold: (
      path: string,
      options: { ignoreSignal?: boolean; match?: (args: any) => boolean } = {},
    ) => {
      const hold = new Hold(options.ignoreSignal ?? false, options.match);
      holds.set(path, hold);
      return hold;
    },
    abort: (controller: AbortController) => {
      aborted = true;
      controller.abort();
    },
    after: () => calls.filter((c) => c.afterAbort).map((c) => c.path),
    mutationsAfter: () =>
      calls.filter((c) => c.afterAbort && MUTATIONS.has(c.path)).map((c) => c.path),
  };
}

/** One held SDK call; a signalled read rejects when its signal aborts. */
class Hold {
  calls: { signal?: AbortSignal; release: () => void }[] = [];
  settled = false;
  constructor(
    private readonly ignoreSignal: boolean,
    readonly match: (args: any) => boolean = () => true,
  ) {}
  take(args: any, call: () => unknown) {
    return new Promise((resolve, reject) => {
      const signal: AbortSignal | undefined = args?.signal;
      this.calls.push({ signal, release: () => resolve(call()) });
      if (!this.ignoreSignal)
        signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
    }).finally(() => (this.settled = true));
  }
  release() {
    this.calls[0]!.release();
  }
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 2000 && !cond(); i++)
    await new Promise((r) => setTimeout(r, 1));
  expect(cond()).toBe(true);
};
/** Whether `p` settles once every pending macrotask and microtask ran. */
const settlesNow = async (p: Promise<unknown>) => {
  let settled = false;
  void p.then(() => (settled = true), () => (settled = true));
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  return settled;
};

async function withChildren(n: number) {
  const { f, project } = await projectFixture();
  for (let i = 0; i < n; i++)
    await f.spawn({ projectId: "proj_a", parentThreadId: "coordinator" });
  f.spawn.mockClear();
  return { f, project };
}

/** A worker with an accepted task, then a continue send whose response is lost after BB queued it. */
async function lostQueuedSend() {
  const { f, project } = await projectFixture();
  const t1 = f.task(project.id);
  const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [t1.ref] });
  await f.service.report(d.threadId!, report());
  await f.service.acceptTask(project.id, t1.ref, {});
  f.idle(d.threadId!);
  const worker = f.store.workers(project.id)[0]!;
  const t2 = f.task(project.id, "Next task");
  f.send.mockImplementationOnce(async (args: any) => {
    f.queued.set(worker.threadId!, [{ id: "lost-q", content: args.input }]);
    throw new Error("lost response");
  });
  await f.service.delegate(project.id, { route: "continue", worker: worker.ref, tasks: [t2.ref] });
  return { f, project, t2 };
}

/**
 * Three workers left under a live former coordinator: the switch landed but
 * every reparent failed, so convergence still has the whole transfer to do.
 */
async function formerCoordinatorWithWorkers() {
  const { f, project } = await projectFixture();
  const workers: string[] = [];
  for (let i = 0; i < 3; i++) {
    const t = f.task(project.id, `Task ${i}`);
    const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [t.ref] });
    workers.push(d.threadId!);
    await f.service.report(d.threadId!, report());
    // The native turn ends after its report (T91 keeps a running reporter's scope).
    f.idle(d.threadId!);
  }
  const reparent = f.update.getMockImplementation()!;
  f.update.mockImplementation(async () => {
    throw new Error("down");
  });
  f.idle("coordinator");
  await f.service.replaceCoordinator(project.id, { reason: "swap" });
  f.update.mockImplementation(reparent);
  const successor = f.store.project(project.id)!.coordinatorThreadId!;
  expect(successor).not.toBe("coordinator");
  expect(f.threads.get("coordinator")!.archivedAt).toBeNull();
  for (const w of workers) expect(f.threads.get(w)!.parentThreadId).toBe("coordinator");
  const parentOf = () => workers.map((w) => f.threads.get(w)!.parentThreadId);
  /** The next service run moves every worker and archives the predecessor. */
  const nextSweepConverges = async () => {
    f.intercept();
    const next = f.harness.runService("projects-sweep");
    await until(() => f.threads.get("coordinator")!.archivedAt !== null);
    next.controller.abort();
    await next.done;
    expect(parentOf()).toEqual(workers.map(() => successor));
  };
  return { f, project, workers, successor, parentOf, nextSweepConverges };
}

/** Every parent-op hold a transfer took is released again. */
const parentOpsBalanced = (f: Fixture, projectId: string) =>
  (
    f.service as unknown as { parentOps: Map<string, Map<string, number>> }
  ).parentOps.get(projectId)?.size ?? 0;

describe("T81 responsive projects-sweep shutdown", () => {
  it("control: an unaborted sweep claims every native child and drains a pending handover", async () => {
    const { f, project } = await withChildren(40);
    f.service.requestHandover(project.id, { reason: "handoff" }, "coordinator");
    f.idle("coordinator");
    const io = journal(f);
    const { controller, done } = f.harness.runService("projects-sweep");
    await until(() => !f.store.pendingHandover(project.id));
    controller.abort();
    await done;
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.store.projectThreads(project.id).length).toBeGreaterThanOrEqual(40);
    expect(f.store.project(project.id)!.coordinatorThreadId).not.toBe("coordinator");
    expect(f.store.pendingHandover(project.id)).toBeFalsy();
    // Only the scan read is signalled; no mutation ever carries the signal.
    expect(io.calls.filter((c) => c.signal).every((c) => c.path === "threads.list")).toBe(true);
  });

  it("overscan: abort during the first association read claims nothing and reads no further", async () => {
    const { f, project } = await withChildren(40);
    const io = journal(f);
    const scan = io.hold("threads.list");
    const { controller, done } = f.harness.runService("projects-sweep");
    await until(() => scan.calls.length === 1);
    const before = io.changes();
    io.abort(controller);
    scan.release(); // completes an unsignalled read; no-op after an abort
    await done;
    expect(io.after().filter((p) => p === "threads.list")).toEqual([]);
    expect(io.changes() - before).toBe(0);
    expect(f.store.projectThreads(project.id)).toHaveLength(0);
  });

  it("pending read: a scan read that only ends on its own signal does not hold shutdown", async () => {
    const { f } = await withChildren(3);
    const io = journal(f);
    const scan = io.hold("threads.list"); // never released
    const { controller, done } = f.harness.runService("projects-sweep");
    await until(() => scan.calls.length === 1);
    const before = io.changes();
    io.abort(controller);
    try {
      await done;
      expect(scan.calls[0]!.signal).toBeInstanceOf(AbortSignal);
      expect(io.changes() - before).toBe(0);
    } finally {
      scan.release();
    }
  });

  it("late read: a result that ignores the signal and arrives after abort is never applied", async () => {
    const { f, project } = await withChildren(40);
    const io = journal(f);
    // A read that ignores its signal resolves late with real data.
    const scan = io.hold("threads.list", { ignoreSignal: true });
    const { controller, done } = f.harness.runService("projects-sweep");
    await until(() => scan.calls.length === 1);
    const before = io.changes();
    io.abort(controller);
    scan.release();
    await done;
    expect(io.after()).toEqual([]);
    expect(io.changes() - before).toBe(0);
    expect(f.store.projectThreads(project.id)).toHaveLength(0);
  });

  it("held mutation: a queue delete issued before abort settles with its receipt, then nothing new", async () => {
    const { f, project, t2 } = await lostQueuedSend();
    await f.service.stopAssignment(project.id, "A2", "cancel uncertain send");
    const io = journal(f);
    const del = io.hold("threads.queuedMessages.delete");
    const { controller, done } = f.harness.runService("projects-sweep");
    await until(() => del.calls.length === 1);
    io.abort(controller);
    // The mutation is owned: shutdown waits for it rather than abandoning it.
    expect(await settlesNow(done)).toBe(false);
    expect(del.calls[0]!.signal).toBeUndefined();
    del.release();
    await done;
    const a = f.store.assignment(project.id, 2)!;
    expect(del.settled).toBe(true);
    expect(a.queuedMessageId).toBeNull(); // the settled delete's receipt is kept
    expect(a.opState).toBe("uncertain"); // never dropped; a later sweep settles it
    expect(f.store.task(project.id, t2.num)!.status).toBe("blocked");
    expect(io.after()).toEqual([]);
  });

  it("handover: abort during association never spawns a replacement coordinator", async () => {
    const { f, project } = await withChildren(2);
    f.service.requestHandover(project.id, { reason: "handoff" }, "coordinator");
    f.idle("coordinator");
    const io = journal(f);
    const scan = io.hold("threads.list");
    const { controller, done } = f.harness.runService("projects-sweep");
    await until(() => scan.calls.length === 1);
    io.abort(controller);
    scan.release();
    await done;
    expect(io.mutationsAfter()).toEqual([]);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.store.project(project.id)!.coordinatorThreadId).toBe("coordinator");
    expect(f.store.pendingHandover(project.id)).toBeTruthy();
  });

  it("handover mid-attempt: abort during the predecessor history read stops at the gate", async () => {
    const { f, project } = await projectFixture();
    f.service.requestHandover(project.id, { reason: "handoff" }, "coordinator");
    f.idle("coordinator");
    const io = journal(f);
    const history = io.hold("threads.events.list");
    const { controller, done } = f.harness.runService("projects-sweep");
    await until(() => history.calls.length === 1);
    const before = io.changes();
    io.abort(controller);
    history.release();
    await done;
    expect(io.mutationsAfter()).toEqual([]);
    expect(io.changes() - before).toBe(0);
    expect(f.store.project(project.id)!.coordinatorThreadId).toBe("coordinator");
    expect(f.store.pendingHandover(project.id)).toBeTruthy();
  });

  it("late receipt: a lost-response queued send seen during shutdown is confirmed by the next sweep", async () => {
    const { f, project } = await lostQueuedSend();
    const io = journal(f);
    const queue = io.hold("threads.queuedMessages.list");
    const first = f.harness.runService("projects-sweep");
    await until(() => queue.calls.length === 1);
    const before = io.changes();
    io.abort(first.controller);
    queue.release();
    await first.done;
    expect(io.changes() - before).toBe(0);
    expect(["pending", "uncertain"]).toContain(f.store.assignment(project.id, 2)!.opState);
    // The next service run (a reload's fresh start) confirms the same receipt.
    f.intercept();
    const next = f.harness.runService("projects-sweep");
    await until(() => f.store.assignment(project.id, 2)!.opState === "done");
    next.controller.abort();
    await next.done;
    expect(f.store.assignment(project.id, 2)!.queuedMessageId).toBe("lost-q");
  });

  it("an idle event after shutdown leaves the handover pending but still records native facts", async () => {
    const { f, project } = await withChildren(1);
    const { controller, done } = f.harness.runService("projects-sweep");
    controller.abort();
    await done;
    // BB keeps delivering events to a disposing instance during reload.
    f.service.requestHandover(project.id, { reason: "handoff" }, "coordinator");
    const orphan = await f.spawn({ projectId: "proj_a", parentThreadId: "coordinator" });
    f.spawn.mockClear();
    const io = journal(f);
    await f.runtime.onThreadIdle(f.idle("coordinator"));
    await f.runtime.onThreadIdle(f.idle(orphan.id));
    expect(io.calls.filter((c) => MUTATIONS.has(c.path))).toEqual([]);
    expect(f.store.project(project.id)!.coordinatorThreadId).toBe("coordinator");
    expect(f.store.pendingHandover(project.id)).toBeTruthy();
    // Native-fact bookkeeping is not suppressed.
    expect(f.store.membership(orphan.id)).toBeTruthy();
    // A restarted service drains it.
    f.intercept();
    const next = f.harness.runService("projects-sweep");
    await until(() => f.spawn.mock.calls.length === 1);
    next.controller.abort();
    await next.done;
    expect(f.store.pendingHandover(project.id)).toBeFalsy();
  });

  it("transfer: abort during a worker read stops the round before its reparent", async () => {
    const { f, project, workers, parentOf, nextSweepConverges } =
      await formerCoordinatorWithWorkers();
    const io = journal(f);
    const read = io.hold("threads.get", { match: (a) => a?.threadId === workers[0] });
    const controller = new AbortController();
    const run = f.service.convergeFormerCoordinators(project.id, controller.signal);
    await until(() => read.calls.length === 1);
    const before = io.changes();
    io.abort(controller);
    read.release();
    await run;
    expect(io.after()).toEqual([]);
    expect(io.changes() - before).toBe(0);
    expect(parentOf()).toEqual(workers.map(() => "coordinator"));
    expect(f.threads.get("coordinator")!.archivedAt).toBeNull();
    expect(parentOpsBalanced(f, project.id)).toBe(0);
    await nextSweepConverges();
  });

  it("transfer: a reparent issued before abort finishes with its confirmation, then no further worker moves", async () => {
    const { f, project, workers, successor, parentOf, nextSweepConverges } =
      await formerCoordinatorWithWorkers();
    // The update lands natively but its response is lost, so the receipt
    // comes from the confirmation read.
    const reparent = f.update.getMockImplementation()!;
    f.update.mockImplementationOnce(async (args: any) => {
      await reparent(args);
      throw new Error("lost response");
    });
    const io = journal(f);
    const update = io.hold("threads.update");
    const controller = new AbortController();
    const run = f.service.convergeFormerCoordinators(project.id, controller.signal);
    await until(() => update.calls.length === 1);
    io.abort(controller);
    // The mutation is owned: convergence waits for it rather than abandoning it.
    expect(await settlesNow(run)).toBe(false);
    update.release();
    await run;
    expect(update.calls[0]!.signal).toBeUndefined();
    // Only the issued update's own confirmation read follows the abort.
    const after = io.calls.filter((c) => c.afterAbort);
    expect(after.map((c) => c.path)).toEqual(["threads.get"]);
    expect(after[0]!.signal).toBeUndefined();
    expect(parentOf()).toEqual([successor, "coordinator", "coordinator"]);
    expect(f.store.workers(project.id).map((w) => w.nativeParent)).toEqual([true, false, false]);
    expect(f.threads.get("coordinator")!.archivedAt).toBeNull();
    expect(parentOpsBalanced(f, project.id)).toBe(0);
    await nextSweepConverges();
  });

  it("handover spawn issued before abort: the switch lands, the transfer waits for the next sweep", async () => {
    const { f, project } = await projectFixture();
    const workers: string[] = [];
    for (let i = 0; i < 3; i++) {
      const t = f.task(project.id, `Task ${i}`);
      const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [t.ref] });
      workers.push(d.threadId!);
      await f.service.report(d.threadId!, report());
      // The native turn ends after its report (T91 keeps a running reporter's scope).
      f.idle(d.threadId!);
    }
    const parentOf = () => workers.map((w) => f.threads.get(w)!.parentThreadId);
    f.service.requestHandover(project.id, { reason: "handoff" }, "coordinator");
    f.idle("coordinator");
    const io = journal(f);
    const spawn = io.hold("threads.spawn", { ignoreSignal: true });
    const controller = new AbortController();
    const run = f.service.drainHandover(project.id, controller.signal);
    await until(() => spawn.calls.length === 1);
    io.abort(controller);
    spawn.release();
    await run;
    // Only the issued spawn's own home-proof reads follow the abort.
    expect(io.after()).toEqual(["environments.get", "projects.get"]);
    const successor = f.store.project(project.id)!.coordinatorThreadId!;
    expect(successor).not.toBe("coordinator");
    expect(f.store.pendingHandover(project.id)).toBeFalsy();
    // The predecessor stays live with its children until the next sweep.
    expect(parentOf()).toEqual(workers.map(() => "coordinator"));
    expect(f.threads.get("coordinator")!.archivedAt).toBeNull();
    expect(f.stop).not.toHaveBeenCalled();
    expect(parentOpsBalanced(f, project.id)).toBe(0);
    f.intercept();
    const next = f.harness.runService("projects-sweep");
    await until(() => f.threads.get("coordinator")!.archivedAt !== null);
    next.controller.abort();
    await next.done;
    expect(parentOf()).toEqual(workers.map(() => successor));
    expect(f.store.project(project.id)!.coordinatorThreadId).toBe(successor);
  });

  it("control: a restarted service's idle event drains the handover again", async () => {
    const { f, project } = await projectFixture();
    const first = f.harness.runService("projects-sweep");
    first.controller.abort();
    await first.done;
    f.service.requestHandover(project.id, { reason: "handoff" }, "coordinator");
    // Park the restarted sweep in its scan read so only the idle event can drain.
    const io = journal(f);
    const scan = io.hold("threads.list");
    const next = f.harness.runService("projects-sweep");
    await until(() => scan.calls.length === 1);
    await f.runtime.onThreadIdle(f.idle("coordinator"));
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.store.project(project.id)!.coordinatorThreadId).not.toBe("coordinator");
    expect(f.store.pendingHandover(project.id)).toBeFalsy();
    next.controller.abort();
    await next.done;
  });

  it("control: without a stopped service an idle coordinator drains its handover", async () => {
    const { f, project } = await projectFixture();
    f.service.requestHandover(project.id, { reason: "handoff" }, "coordinator");
    await f.runtime.onThreadIdle(f.idle("coordinator"));
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.store.project(project.id)!.coordinatorThreadId).not.toBe("coordinator");
  });
});
