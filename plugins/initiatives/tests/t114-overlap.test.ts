import { describe, expect, it } from "vitest";
import { projectFixture, report } from "./fake-native";
import { brief } from "./helpers";

// T114: the write-overlap guard reads each writer's actual checkout from BB's
// thread rows, so separate managed worktrees never block each other, and its
// refusals say what BB showed.
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const taskAt = (f: Fx, id: string, title: string, paths: string[]) =>
  f.service.createTask(id, { title, summary: "x", brief: brief("proj_a", paths) }, "coordinator");
const setThread = (f: Fx, id: string, patch: Record<string, unknown>) => f.threads.set(id, { ...(f.threads.get(id) as any), ...patch });
const refused = (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);
const quiet = { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activeGoalCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 };

/**
 * W1/A1 wrote src/ and reported, and its thread is still running. W2 finished
 * docs/ and is idle; T2 (src/lib) overlaps A1. No assignment records an environment.
 */
async function equisafe() {
  const { f, project } = await projectFixture();
  const t1 = taskAt(f, project.id, "Writer one", ["src"]);
  const [a1] = await f.service.delegate(project.id, { route: "fresh", tasks: [t1.ref] });
  await f.service.report(a1.threadId!, report());
  const t3 = taskAt(f, project.id, "Writer two", ["docs"]);
  const [a2] = await f.service.delegate(project.id, { route: "fresh", tasks: [t3.ref] });
  await f.service.report(a2.threadId!, report());
  await f.service.acceptTask(project.id, t3.ref, {});
  f.idle(a2.threadId!);
  setThread(f, a1.threadId!, { status: "active" });
  const t2 = taskAt(f, project.id, "Next", ["src/lib"]);
  const w2 = f.store.workers(project.id).find((w) => w.threadId === a2.threadId)!;
  f.store.db.prepare("UPDATE assignments SET environment_id=NULL WHERE project_id=?").run(project.id);
  f.store.db.prepare("UPDATE workers SET environment_id=NULL WHERE project_id=?").run(project.id);
  const continueW2 = () => f.service.delegate(project.id, { route: "continue", worker: w2.ref, tasks: [t2.ref] });
  const fresh = () => f.service.delegate(project.id, { route: "fresh", tasks: [t2.ref] });
  return { f, project, a1: a1.threadId!, a2: a2.threadId!, continueW2, fresh };
}

describe("T114 overlap guard reads the actual checkout", () => {
  it("allows a continuation in its own worktree past a running writer in another worktree", async () => {
    const x = await equisafe();
    setThread(x.f, x.a1, { environmentId: "env_wt1", environmentIsWorktree: true });
    setThread(x.f, x.a2, { environmentId: "env_wt2", environmentIsWorktree: true });
    expect(await refused(x.continueW2())).toBe("");
  });

  it("allows a fresh default-checkout write past a running writer in a managed worktree", async () => {
    const x = await equisafe();
    setThread(x.f, x.a1, { environmentId: "env_wt1", environmentIsWorktree: true });
    expect(await refused(x.fresh())).toBe("");
  });

  it("still refuses writers in the same checkout, and when the holder's checkout is unknown", async () => {
    const same = await equisafe();
    setThread(same.f, same.a1, { environmentId: "env_a", environmentIsWorktree: false });
    setThread(same.f, same.a2, { environmentId: "env_a", environmentIsWorktree: false });
    expect(await refused(same.continueW2())).toMatch(/A1 \(W1\) is reported, but its thread is still running \(turn active\)/);
    const unknown = await equisafe();
    setThread(unknown.f, unknown.a1, { environmentId: null });
    expect(await refused(unknown.fresh())).toMatch(/A1 \(W1\).*still running/);
  });

  it("a legacy investigation or review without a write scope never holds the project; legacy implementation still does", async () => {
    for (const [legacy, held] of [
      ["work_kind='investigation'", false],
      ["role='review'", false],
      ["work_kind='implementation'", true],
    ] as const) {
      const x = await equisafe();
      x.f.store.db.prepare(`UPDATE assignments SET write_scope=NULL, access='write', ${legacy} WHERE project_id=? AND num=1`).run(x.project.id);
      const message = await refused(x.fresh());
      if (held) expect(message).toMatch(/no recorded write scope, so it is held as the whole project/);
      else expect(message).toBe("");
    }
  });

  it("names what BB showed: queued input is quoted, unproven evidence never reads as running", async () => {
    const queued = await equisafe();
    setThread(queued.f, queued.a1, { status: "idle", queuedMessageCount: 1 });
    expect(await refused(queued.fresh())).toMatch(/still running \(idle, with queued input waiting to start a turn\)/);
    const background = await equisafe();
    setThread(background.f, background.a1, { status: "idle", activity: { ...quiet, activeBackgroundAgentCount: 2 } });
    expect(await refused(background.fresh())).toMatch(/still running \(idle, with 2 background agents active\)/);
    const unreadable = await equisafe();
    setThread(unreadable.f, unreadable.a1, { status: "idle", activity: { activeBackgroundAgentCount: 0 } });
    const message = await refused(unreadable.fresh());
    expect(message).toMatch(/could not be proven quiet \(its background counters were unreadable\)/);
    expect(message).not.toMatch(/still running/);
    // Idle and quiet: no hold at all.
    const idle = await equisafe();
    setThread(idle.f, idle.a1, { status: "idle" });
    expect(await refused(idle.fresh())).toBe("");
  });
});
