import { describe, expect, it } from "vitest";
import { projectFixture, report } from "./fake-native";
import { needsYouCount } from "../lib/blockers";

// W482: a retired worker's blocker can never be answered, so it leaves the Inbox and Needs you.
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const question = "Which Railway env keys does Tekk Paris need?";
const context = "The deploy needs two secrets only Erwin has.";
const seen = { question, context };
const blocked = { ...report(), outcome: "blocked" as const, summary: "Blocked on secrets.", blocker: { question, context } };
const tree = async (f: Fx) => ((await f.harness.callRpc("tree", null)) as any).projects[0].needsYou as number;

async function blockedWorker() {
  const { f, project } = await projectFixture();
  const task = f.task(project.id, "Deploy Tekk Paris");
  const [a] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
  await f.service.report(a.threadId!, blocked as never);
  f.idle(a.threadId!);
  f.send.mockClear();
  return { f, project, worker: f.store.workers(project.id).find((w) => w.ref === a.worker)! };
}

/** Needs you as the tree (sidebar row, catalog) and the dashboard pill count it, and the Inbox list. */
async function counts(f: Fx, projectId: string) {
  const o = await f.overview(projectId, "summary");
  return { tree: await tree(f), dashboard: needsYouCount(o), inbox: o.blockers.length };
}

describe("W482 retired workers' blockers", () => {
  it("retiring the worker closes its blocker everywhere, sending nothing", async () => {
    const { f, project, worker } = await blockedWorker();
    expect(await counts(f, project.id)).toEqual({ tree: 1, dashboard: 1, inbox: 1 });
    await f.service.retireWorker(project.id, worker.ref, "Finished.");
    expect(await counts(f, project.id)).toEqual({ tree: 0, dashboard: 0, inbox: 0 });
    expect((await f.overview(project.id)).blockers).toEqual([]);
    expect(f.send).not.toHaveBeenCalled();
  });

  it("an item already open for a worker that is retired is hidden (existing data, no migration)", async () => {
    const { f, project, worker } = await blockedWorker();
    // As stored before this change: the worker is retired and its blocked report was never closed.
    f.store.updateWorker(project.id, worker.num, { state: "retired" });
    expect(f.store.decisions(project.id)).toEqual([]);
    expect(await counts(f, project.id)).toEqual({ tree: 0, dashboard: 0, inbox: 0 });
    expect((await f.overview(project.id)).blockers).toEqual([]);
  });

  it("only the retired worker's blocker goes; another worker's stays", async () => {
    const { f, project, worker } = await blockedWorker();
    const [b] = await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id, "Second").ref] });
    await f.service.report(b.threadId!, blocked as never);
    f.idle(b.threadId!);
    expect((await counts(f, project.id)).inbox).toBe(2);
    await f.service.retireWorker(project.id, worker.ref, "Finished.");
    expect(await counts(f, project.id)).toEqual({ tree: 1, dashboard: 1, inbox: 1 });
    expect((await f.overview(project.id)).blockers.map((x) => x.owner.worker)).toEqual([b.worker]);
  });

  it("an answer or dismissal that arrives after the retire fails visibly and saves nothing", async () => {
    const { f, project, worker } = await blockedWorker();
    await f.service.retireWorker(project.id, worker.ref, "Finished.");
    await expect(f.service.answerBlocker(project.id, "A1", seen, "Use the staging keys.", "worker")).rejects.toThrow(/worker was retired.*not saved/);
    await expect(f.service.answerBlocker(project.id, "A1", seen, "Use the staging keys.", "coordinator")).rejects.toThrow(/worker was retired.*not saved/);
    await expect(f.service.dismissBlocker(project.id, "A1", seen, { notify: false, note: "" })).rejects.toThrow(/worker was retired.*not saved/);
    expect(f.store.decisions(project.id)).toEqual([]);
    expect(f.send).not.toHaveBeenCalled();
    // Dismiss all reports it per item instead of failing the whole pass.
    const result = await f.service.dismissInbox(project.id, { questions: [], blockers: [{ assignment: "A1", ...seen }] });
    expect(result.failed).toEqual([{ ref: "A1", error: expect.stringMatching(/worker was retired/) }]);
  });
});
