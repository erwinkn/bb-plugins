import { describe, expect, it, vi } from "vitest";
import { projectFixture, report } from "./fake-native";
import { opMarker } from "../lib/brief";

type Fixture = Awaited<ReturnType<typeof projectFixture>>["f"];

/** A continuation whose send response was lost: A2 stays an unconfirmed op. */
async function lostContinuation() {
  const { f, project } = await projectFixture();
  const t1 = f.task(project.id);
  const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [t1.ref] });
  await f.service.report(d.threadId!, report());
  await f.service.closeTask(project.id, t1.ref, "done");
  f.idle(d.threadId!);
  const worker = f.store.workers(project.id)[0]!;
  const t2 = f.task(project.id, "Next");
  f.send.mockImplementationOnce(async () => {
    throw new Error("lost response");
  });
  await f.service
    .delegate(project.id, { route: "continue", worker: worker.ref, tasks: [t2.ref] })
    .catch(() => undefined);
  expect(f.store.assignment(project.id, 2)!.opState).not.toBe("done");
  let now = f.store.now();
  vi.spyOn(f.store, "now").mockImplementation(() => now);
  return { f, project, worker, advance: (ms: number) => { now += ms; } };
}

const refusals = (f: Fixture, projectId: string) =>
  f.store.activity(projectId, 300).filter((a) => a.summary.startsWith("Could not reconcile A2 yet"));

/** Count native reads of the worker thread during `run`. */
async function reads(f: Fixture, threadId: string, run: () => Promise<unknown>) {
  let count = 0;
  f.intercept((path, args, call) => {
    if (args?.threadId === threadId) count++;
    return call();
  });
  await run();
  f.intercept();
  return count;
}

describe("T111 assignment-op reconcile retries", () => {
  it("logs an unchanged refusal once, backs off, and logs again when the reason changes", async () => {
    const { f, project, worker, advance } = await lostContinuation();
    let reason = "history offline";
    f.harness.sdk.stub("threads.promptHistory", async () => {
      throw new Error(reason);
    });
    await f.service.reconcile();
    expect(refusals(f, project.id).map((a) => a.summary)).toEqual(["Could not reconcile A2 yet: history offline"]);
    // A new refusal retries on the next sweep; the same one again backs off.
    await f.service.reconcile();
    expect(refusals(f, project.id)).toHaveLength(1);
    expect(await reads(f, worker.threadId!, () => f.service.reconcile())).toBe(0);
    advance(60_000);
    expect(await reads(f, worker.threadId!, () => f.service.reconcile())).toBeGreaterThan(0);
    expect(refusals(f, project.id)).toHaveLength(1);
    // The delay grows while the refusal repeats.
    advance(60_000);
    expect(await reads(f, worker.threadId!, () => f.service.reconcile())).toBe(0);
    advance(60_000);
    reason = "history moved";
    await f.service.reconcile();
    expect(refusals(f, project.id).map((a) => a.summary)).toEqual([
      "Could not reconcile A2 yet: history moved",
      "Could not reconcile A2 yet: history offline",
    ]);
    // Settlement is untouched: the op stays open for evidence or an explicit settle.
    expect(f.store.assignment(project.id, 2)!.opState).not.toBe("done");
  });

  it("stops re-reading a continuation whose worker thread is archived, until it is unarchived", async () => {
    const { f, project, worker, advance } = await lostContinuation();
    advance(3 * 60_000);
    f.threads.set(worker.threadId!, { ...f.threads.get(worker.threadId!)!, archivedAt: Date.now() });
    expect(await reads(f, worker.threadId!, () => f.service.reconcile())).toBeGreaterThan(0);
    expect(f.store.assignment(project.id, 2)!.opState).toBe("uncertain");
    expect(await reads(f, worker.threadId!, () => f.service.reconcile())).toBe(0);
    expect(f.store.assignment(project.id, 2)!.opState).toBe("uncertain");
    const unarchived = { ...f.threads.get(worker.threadId!)!, archivedAt: null };
    f.threads.set(worker.threadId!, unarchived);
    await f.harness.emitThreadEvent("thread.unarchived", { thread: unarchived });
    expect(await reads(f, worker.threadId!, () => f.service.reconcile())).toBeGreaterThan(0);
  });

  it("stops re-reading after a 404 refusal, but keeps retrying unreadable lifecycle evidence", async () => {
    const { f, project, worker, advance } = await lostContinuation();
    f.harness.sdk.stub("threads.promptHistory", async () => {
      throw Object.assign(new Error("gone"), { status: 404 });
    });
    f.threads.set(worker.threadId!, { ...f.threads.get(worker.threadId!)!, archivedAt: undefined as never });
    await f.service.reconcile();
    // Unreadable lifecycle evidence is not an end: the refusal is logged and retried.
    expect(refusals(f, project.id)).toHaveLength(1);
    advance(15 * 60_000);
    expect(await reads(f, worker.threadId!, () => f.service.reconcile())).toBeGreaterThan(0);
    advance(15 * 60_000);
    f.threads.delete(worker.threadId!);
    await f.service.reconcile();
    // Positively gone: parked, so no backoff expiry brings it back.
    advance(60 * 60_000);
    expect(await reads(f, worker.threadId!, () => f.service.reconcile())).toBe(0);
    expect(refusals(f, project.id)).toHaveLength(1);
    expect(f.store.assignment(project.id, 2)!.opState).not.toBe("done");
  });

  it("an unarchive that lands during the lifecycle read keeps the continuation in the sweep (A264)", async () => {
    const { f, project, worker, advance } = await lostContinuation();
    advance(3 * 60_000);
    const archived = { ...f.threads.get(worker.threadId!)!, archivedAt: Date.now() };
    f.threads.set(worker.threadId!, archived);
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const seen = new Promise<void>((resolve) => { started = resolve; });
    f.intercept(async (path, args, call) => {
      if (path !== "threads.get" || args.threadId !== worker.threadId) return call();
      const captured = await call();
      started();
      await gate;
      return captured;
    });
    const reconciling = f.service.reconcile();
    await seen;
    const unarchived = { ...archived, archivedAt: null };
    f.threads.set(worker.threadId!, unarchived);
    await f.harness.emitThreadEvent("thread.unarchived", { thread: unarchived });
    release();
    await reconciling;
    f.intercept();
    const a2 = f.store.assignment(project.id, 2)!;
    f.harness.sdk.stub("threads.promptHistory", async () => [{ input: [{ type: "text", text: opMarker(a2.opId) }] }]);
    advance(60 * 60_000);
    await f.service.reconcile();
    expect(f.store.assignment(project.id, 2)!.opState).toBe("done");
  });
});
