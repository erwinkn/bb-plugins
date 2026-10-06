import { describe, expect, it } from "vitest";
import { buildOverview } from "../lib/overview";
import { projectFixture } from "./fake-native";

type Fixture = Awaited<ReturnType<typeof projectFixture>>["f"];

/** BB returns the spawned thread before it reports the attached checkout. */
function spawnWithoutCheckout(f: Fixture, { stored }: { stored: boolean }) {
  const original = f.spawn.getMockImplementation()!;
  f.spawn.mockImplementationOnce(async (args) => {
    const thread = await original(args);
    if (!stored) f.threads.set(thread.id, { ...thread, environmentId: null });
    return { ...thread, environmentId: null };
  });
}
const startRow = (f: Fixture, projectId: string) =>
  f.store.db.prepare("SELECT state, thread_id, reason FROM coordinator_starts WHERE project_id=?").get(projectId) as
    { state: string; thread_id: string | null; reason: string | null };

describe("T53 delayed native checkout receipt", () => {
  it("keeps a replacement pending instead of failing, and the sweep confirms it once BB reports the checkout", async () => {
    const { f, project } = await projectFixture();
    f.idle("coordinator");
    spawnWithoutCheckout(f, { stored: false });
    const result = await f.service.replaceCoordinator(project.id, { reason: "Switch model" });
    expect(result).toMatchObject({ state: "checkout-pending" });
    const successor = (result as { threadId: string }).threadId;
    expect(startRow(f, project.id)).toMatchObject({ state: "pending", thread_id: successor, reason: "Switch model" });
    expect(f.store.project(project.id)!.coordinatorThreadId).toBe("coordinator");
    expect(buildOverview(f.store, project.id, new Map(), Date.now()).project.coordinatorStart).toMatchObject({ checkoutPending: true });
    // An unreported checkout is not a home problem: the sweep stays quiet.
    const logged = f.store.activity(project.id).length;
    await f.service.reconcile();
    expect(startRow(f, project.id).state).toBe("pending");
    expect(f.store.activity(project.id)).toHaveLength(logged);
    // No second coordinator while the receipt waits.
    const again = await f.service.replaceCoordinator(project.id, { reason: "Again" });
    expect(again).toMatchObject({ state: "pending" });
    expect(f.spawn).toHaveBeenCalledTimes(1);
    // BB reports the default checkout: the same exact proof confirms it.
    f.threads.set(successor, { ...f.threads.get(successor)!, environmentId: "env_a" });
    await f.service.reconcile();
    expect(f.store.project(project.id)!.coordinatorThreadId).toBe(successor);
    expect(f.store.project(project.id)!.coordinatorGeneration).toBe(2);
    expect(startRow(f, project.id)).toMatchObject({ state: "done", thread_id: successor });
    expect(buildOverview(f.store, project.id, new Map(), Date.now()).project.coordinatorStart).toMatchObject({ checkoutPending: false });
  });

  it("re-reads the known receipt once and confirms immediately when BB already has the checkout", async () => {
    const { f, project } = await projectFixture();
    f.idle("coordinator");
    spawnWithoutCheckout(f, { stored: true });
    const result = await f.service.replaceCoordinator(project.id, { reason: "Switch model" });
    expect(result).toMatchObject({ note: null });
    const successor = (result as { threadId: string }).threadId;
    expect(f.store.project(project.id)!.coordinatorThreadId).toBe(successor);
    expect(startRow(f, project.id).state).toBe("done");
  });

  it("never confirms a late checkout that is not the default source checkout", async () => {
    const { f, project } = await projectFixture();
    f.idle("coordinator");
    spawnWithoutCheckout(f, { stored: false });
    const result = await f.service.replaceCoordinator(project.id, { reason: "Switch model" });
    const successor = (result as { threadId: string }).threadId;
    f.envs.set("env_wt", { ...f.envs.get("env_a")!, id: "env_wt", isWorktree: true, path: "/code/repo-wt" });
    f.threads.set(successor, { ...f.threads.get(successor)!, environmentId: "env_wt" });
    await f.service.reconcile();
    expect(f.store.project(project.id)!.coordinatorThreadId).toBe("coordinator");
    expect(startRow(f, project.id)).toMatchObject({ state: "pending", thread_id: successor });
    expect(startRow(f, project.id).reason).toContain("home unproven");
    expect(buildOverview(f.store, project.id, new Map(), Date.now()).project.coordinatorStart).toMatchObject({ checkoutPending: false });
    // The retained receipt can still be settled after inspection.
    await expect(f.service.settleCoordinator(project.id, { threadId: successor })).rejects.toThrow(/cannot be proven/);
  });

  it("still refuses a returned thread outside the primary member, checkout or not", async () => {
    const { f, project } = await projectFixture();
    f.idle("coordinator");
    const original = f.spawn.getMockImplementation()!;
    f.spawn.mockImplementationOnce(async (args) => {
      const thread = await original({ ...args, projectId: "proj_other" });
      f.threads.set(thread.id, { ...thread, environmentId: null });
      return { ...thread, environmentId: null };
    });
    await expect(f.service.replaceCoordinator(project.id, { reason: "Switch model" })).rejects.toThrow(/cannot be proven/);
    expect(startRow(f, project.id).state).toBe("uncertain");
  });
});
