import { describe, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { projectFixture, report } from "./fake-native";

// W544: retire proves a thread quiet from its own list row. That row used to come from a
// whole-project scan capped at 1,000 rows, so in a project with thousands of threads an older
// worker was never reached and every retire refused. The row now comes from the thread's
// parent's listing on its side of archived.
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];

/** A reported, closed, idle worker: ready to retire. */
async function finishedWorker() {
  const { f, project } = await projectFixture();
  const task = f.task(project.id);
  const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
  await f.service.report(d.threadId!, report());
  await f.service.setTaskStatus(project.id, task.ref, "done", "Closed as done.", "the user");
  f.idle(d.threadId!);
  return { f, project, ref: d.worker, threadId: d.threadId! };
}

/**
 * 1,200 threads of the same project listed ahead of `threadId`: archived siblings under the
 * coordinator and live root threads, as in a long-running project.
 */
function bury(f: Fx, threadId: string) {
  for (let i = 0; i < 600; i++) {
    f.threads.set(`old_child_${i}`, makeThreadResponse({ id: `old_child_${i}`, projectId: "proj_a", parentThreadId: "coordinator", archivedAt: 1, status: "idle" }));
    f.threads.set(`old_root_${i}`, makeThreadResponse({ id: `old_root_${i}`, projectId: "proj_a", status: "idle" }));
  }
  const thread = f.threads.get(threadId)!;
  f.threads.delete(threadId);
  f.threads.set(threadId, thread);
  expect([...f.threads.keys()].indexOf(threadId)).toBeGreaterThan(1000);
}

/** Every threads.list query the service makes. */
function listQueries(f: Fx) {
  const queries: Record<string, unknown>[] = [];
  f.intercept(async (path, args, call) => {
    if (path === "threads.list") queries.push(args as Record<string, unknown>);
    return call();
  });
  return queries;
}

describe("W544 a thread's own list row is read through its parent", () => {
  it("retires a worker listed past the old 1,000-row project budget", async () => {
    const { f, project, ref, threadId } = await finishedWorker();
    bury(f, threadId);
    const queries = listQueries(f);
    await expect(f.service.retireWorker(project.id, ref, "Done.")).resolves.toMatchObject({ state: "retired" });
    expect(f.archive).toHaveBeenCalledTimes(1);
    expect(queries).toContainEqual(expect.objectContaining({ projectId: "proj_a", parentThreadId: "coordinator", archived: false, includeHidden: true }));
    // No whole-project scan: every listing is narrowed to one parent.
    expect(queries.every((q) => typeof q.parentThreadId === "string")).toBe(true);
    await f.service.settleBackgroundStops();
  });

  it("reads a root thread's row from the project's root threads", async () => {
    const { f, threadId } = await finishedWorker();
    f.threads.set("root", makeThreadResponse({ id: "root", projectId: "proj_a", status: "idle" }));
    // The worker's own children would not hold it; its unarchived siblings are skipped by hasParent.
    for (let i = 0; i < 1200; i++)
      f.threads.set(`sibling_${i}`, makeThreadResponse({ id: `sibling_${i}`, projectId: "proj_a", parentThreadId: threadId, status: "idle" }));
    bury(f, "root");
    const queries = listQueries(f);
    await expect((f.service as any).nativeEnd("root")).resolves.toMatchObject({ verdict: "ended" });
    // 602 live root threads: four pages of the root listing, none of the project's other threads.
    expect(queries).toHaveLength(4);
    for (const query of queries) {
      expect(query).toMatchObject({ projectId: "proj_a", hasParent: false, archived: false, includeHidden: true });
      expect(query).not.toHaveProperty("parentThreadId");
    }
  });

  it("settles a cancelled run from an archived event through the parent's archived listing", async () => {
    // A cancelled continuation whose brief provably dispatched: its reservation waits for a quiet end (A31).
    const { f, project } = await projectFixture();
    const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id).ref] });
    await f.service.report(d.threadId!, report());
    f.idle(d.threadId!);
    const worker = f.store.workers(project.id)[0]!;
    f.queueSend("q");
    await f.service.delegate(project.id, { route: "continue", worker: worker.ref, tasks: [f.task(project.id, "Next").ref] });
    f.queued.set(d.threadId!, [{ id: "q", content: f.send.mock.calls.at(-1)![0].input }]);
    f.harness.sdk.stub("threads.queuedMessages.delete", async () => { throw new Error("offline"); });
    await f.service.stopAssignment(project.id, "A2", "cancel");
    f.queued.set(d.threadId!, []);
    f.runtime.onMessageDispatched("q");
    expect(f.store.assignment(project.id, 2)).toMatchObject({ state: "cancelled", opState: "uncertain" });
    const archived = { ...f.threads.get(d.threadId!)!, status: "idle" as const, archivedAt: 2 };
    f.threads.set(d.threadId!, archived);
    bury(f, d.threadId!);
    const queries = listQueries(f);
    await f.service.settleCancelledExecutions(archived);
    expect(queries[0]).toMatchObject({ projectId: "proj_a", parentThreadId: "coordinator", archived: true });
    expect(f.store.assignment(project.id, 2)!.opState).toBe("done");
  });

  it("still refuses when the row is genuinely missing", async () => {
    const { f, project, ref, threadId } = await finishedWorker();
    f.intercept(async (path, _args, call) => {
      const result = await call();
      return path === "threads.list" ? (result as { id: string }[]).filter((row) => row.id !== threadId) : result;
    });
    await expect(f.service.retireWorker(project.id, ref, "Done.")).rejects.toThrow(/could not be proven quiet: BB's list row for it was missing or unreadable/);
    expect(f.archive).not.toHaveBeenCalled();
    expect(f.stop).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["a number", 7],
  ])("refuses when the thread's parent is %s, reading no listing for it", async (_kind, parentThreadId) => {
    const { f, project, ref, threadId } = await finishedWorker();
    const queries = listQueries(f);
    f.harness.sdk.stub("threads.get", async () => ({ ...f.threads.get(threadId)!, parentThreadId }) as any);
    await expect(f.service.retireWorker(project.id, ref, "Done.")).rejects.toThrow(/could not be proven quiet/);
    expect(queries).toEqual([]);
    expect(f.archive).not.toHaveBeenCalled();
  });
});
