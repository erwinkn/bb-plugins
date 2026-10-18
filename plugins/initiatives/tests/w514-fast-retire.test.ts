import { describe, expect, it, vi } from "vitest";
import { projectFixture, report } from "./fake-native";

// W514: retire answers once the worker is archived and recorded; BB's Stop runs behind it.
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const warnings = (f: Fx) => f.harness.logEntries.filter((e: { level: string }) => e.level === "warn").map((e: { message: string }) => e.message);

/** `count` workers whose work is reported, closed and idle: ready to retire. */
async function finishedWorkers(count: number) {
  const { f, project } = await projectFixture();
  const workers: { ref: string; threadId: string }[] = [];
  for (let i = 0; i < count; i++) {
    const task = f.task(project.id);
    const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
    await f.service.report(d.threadId!, report());
    await f.service.setTaskStatus(project.id, task.ref, "done", "Closed as done.", "the user");
    f.idle(d.threadId!);
    workers.push({ ref: d.worker, threadId: d.threadId! });
  }
  return { f, project, workers };
}
const retireBatch = (f: Fx, workers: { ref: string }[]) =>
  f.harness.callAgentTool("initiative_batch", {
    actions: workers.map((w) => ({ tool: "worker", action: "retire", worker: w.ref, reason: "Batch finished." })),
  }, { threadId: "coordinator" }) as Promise<string>;

describe("W514 retire does not wait for BB's Stop", () => {
  it("answers a batch of 20 retires in a bounded time while every Stop takes 400 ms", async () => {
    const { f, project, workers } = await finishedWorkers(20);
    f.stop.mockImplementation(async () => { await sleep(400); return {}; });
    const began = performance.now();
    const answer = JSON.parse(await retireBatch(f, workers));
    // Awaiting each Stop would take 20 x 400 ms = 8 s.
    expect(performance.now() - began).toBeLessThan(2500);
    expect(answer).toMatchObject({ succeeded: 20, failed: 0 });
    for (const w of workers) {
      expect(f.store.worker(project.id, Number(w.ref.slice(1)))!.state).toBe("retired");
      expect(f.threads.get(w.threadId)!.archivedAt).not.toBeNull();
    }
    // The Stops were asked for, and finish behind the answer.
    expect(f.stop).toHaveBeenCalledTimes(20);
    await f.service.settleBackgroundStops();
    expect(warnings(f)).toEqual([]);
  });

  it("records a failed Stop once, on the activity log and the handler log, and still retires", async () => {
    const { f, project, workers } = await finishedWorkers(2);
    f.stop.mockImplementationOnce(async () => { throw new Error("host daemon unreachable"); });
    const announce = vi.spyOn(f.service, "announce");
    const retired = await f.service.retireWorker(project.id, workers[0]!.ref, "Done.");
    expect(retired.state).toBe("retired");
    await f.service.retireWorker(project.id, workers[1]!.ref, "Done.");
    await f.service.settleBackgroundStops();
    const lines = f.store.activity(project.id, -1).map((a) => a.summary).filter((s) => s.includes("Stop"));
    expect(lines).toEqual([expect.stringMatching(new RegExp(`^${workers[0]!.ref} retired, but BB's Stop of the archived thread ${workers[0]!.threadId} failed \\(host daemon unreachable\\)`))]);
    expect(warnings(f).filter((m) => m.includes("host daemon unreachable"))).toHaveLength(1);
    expect(f.store.worker(project.id, 2)!.state).toBe("retired");
    // The late entry reaches open dashboards: it is announced, once.
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(project.id);
  });

  it("does not Stop or archive a thread that is still busy, and retires it later (W492)", async () => {
    const { f, project, workers } = await finishedWorkers(1);
    f.threads.set(workers[0]!.threadId, { ...f.threads.get(workers[0]!.threadId)!, status: "active" });
    await expect(f.service.retireWorker(project.id, workers[0]!.ref, "Done.")).resolves.toMatchObject({ state: "retiring" });
    await f.service.settleBackgroundStops();
    expect(f.archive).not.toHaveBeenCalled();
    expect(f.stop).not.toHaveBeenCalled();
    f.idle(workers[0]!.threadId);
    await f.service.finishRetirements(workers[0]!.threadId);
    expect(f.store.worker(project.id, 1)!.state).toBe("retired");
    expect(f.archive).toHaveBeenCalledTimes(1);
  });

  it("keeps the retire semantics: record, reason, blocker closed, a second retire a no-op", async () => {
    const { f, project, workers } = await finishedWorkers(1);
    const first = await f.service.retireWorker(project.id, workers[0]!.ref, "Merged.");
    expect(first).toMatchObject({ ref: workers[0]!.ref, state: "retired" });
    expect(f.store.activity(project.id, -1).map((a) => a.summary)).toContain(`${workers[0]!.ref} retired: Merged.`);
    await f.service.settleBackgroundStops();
    f.stop.mockClear();
    await expect(f.service.retireWorker(project.id, workers[0]!.ref, "Again.")).resolves.toMatchObject({ state: "retired" });
    expect(f.archive).toHaveBeenCalledTimes(1);
    expect(f.stop).not.toHaveBeenCalled();
  });
});

describe("W514 slow retires are logged once with their steps", () => {
  it("logs the retire's step breakdown and the batch action when a retire runs over a second", async () => {
    const { f, workers } = await finishedWorkers(2);
    let slow = true;
    f.intercept(async (path, _args, call) => {
      if (path === "threads.get" && slow) { slow = false; await sleep(1100); }
      return call();
    });
    await retireBatch(f, workers);
    await f.service.settleBackgroundStops();
    const lines = warnings(f).filter((m) => m.startsWith("Slow "));
    expect(lines).toHaveLength(2);
    // sleep() waits at least 1100 ms; a busy event loop may stretch it, so only the floor is asserted.
    const [, total, get] = lines[0]!.match(new RegExp(`^Slow retire of ${workers[0]!.ref} \\(.*\\): (\\d+) ms \\(get (\\d+)(?:, [a-z]+ \\d+)*\\)$`))!;
    expect(Number(get)).toBeGreaterThanOrEqual(1090);
    expect(Number(total)).toBeGreaterThanOrEqual(Number(get));
    expect(lines[1]).toMatch(/^Slow batch action 1 of 2 \(worker retire\): \d+ ms$/);
  });

  it("logs nothing for a quick retire", async () => {
    const { f, workers } = await finishedWorkers(1);
    await retireBatch(f, workers);
    await f.service.settleBackgroundStops();
    expect(warnings(f)).toEqual([]);
  });
});
