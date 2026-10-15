import { describe, expect, it } from "vitest";
import { projectFixture, report } from "./fake-native";
import { needsYouCount } from "../lib/blockers";

// W487: Needs you means the user has something to answer: the worker's blocker is open in their
// Inbox, neither answered nor dismissed. A blocked worker with nothing left for the user waits on
// its coordinator, under Waiting, in the Workers tab and the sidebar alike (both read workerGroups).
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const question = "Which Railway env keys does Tekk Paris need?";
const context = "The deploy needs two secrets only Erwin has.";
const seen = { question, context };
const blocked = { ...report(), outcome: "blocked" as const, summary: "Blocked on secrets.", blocker: { question, context } };

async function blockedWorker() {
  const { f, project } = await projectFixture();
  const task = f.task(project.id, "Deploy Tekk Paris");
  const [a] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
  await f.service.report(a.threadId!, blocked as never);
  f.idle(a.threadId!);
  f.send.mockClear();
  return { f, project, task, ref: a.worker };
}

/** The worker's group as both views read it, and Needs you as the tree, the dashboard pill and the Inbox count it. */
async function state(f: Fx, projectId: string, ref: string) {
  const o = await f.overview(projectId, "summary");
  const tree = ((await f.harness.callRpc("tree", null)) as any).projects[0].needsYou as number;
  return { group: o.workerGroups?.[ref]?.group ?? null, quiet: o.workerGroups?.[ref]?.quiet ?? null, tree, dashboard: needsYouCount(o), cards: o.blockers.length };
}

describe("W487 Needs you is an open question to the user", () => {
  it("an open, unanswered blocker in the Inbox needs you", async () => {
    const { f, project, ref } = await blockedWorker();
    expect(await state(f, project.id, ref)).toEqual({ group: "needs", quiet: "needs", tree: 1, dashboard: 1, cards: 1 });
  });

  it("once answered, the worker waits on the coordinator; its card stays until the coordinator acts", async () => {
    const { f, project, ref } = await blockedWorker();
    await f.service.answerBlocker(project.id, "A1", seen, "Use the staging keys.", "coordinator");
    expect(await state(f, project.id, ref)).toEqual({ group: "waiting", quiet: "waiting", tree: 0, dashboard: 0, cards: 1 });
  });

  it("once dismissed, the worker waits on the coordinator", async () => {
    const { f, project, ref } = await blockedWorker();
    await f.service.dismissBlocker(project.id, "A1", seen, { notify: false, note: "" });
    expect(await state(f, project.id, ref)).toEqual({ group: "waiting", quiet: "waiting", tree: 0, dashboard: 0, cards: 0 });
  });

  it("with no question left in the Inbox (its tasks closed), the worker still waits on the coordinator", async () => {
    const { f, project, task, ref } = await blockedWorker();
    await f.service.setTaskStatus(project.id, task.ref, "cancelled", "Not needed.", "the user");
    expect(await state(f, project.id, ref)).toEqual({ group: "waiting", quiet: "waiting", tree: 0, dashboard: 0, cards: 0 });
  });

  it("a retired worker's question stays hidden, and the worker leaves the groups", async () => {
    const { f, project, ref } = await blockedWorker();
    await f.service.retireWorker(project.id, ref, "Finished.");
    expect(await state(f, project.id, ref)).toEqual({ group: null, quiet: null, tree: 0, dashboard: 0, cards: 0 });
  });
});
