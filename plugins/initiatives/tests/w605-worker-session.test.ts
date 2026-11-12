import { describe, expect, it } from "vitest";
import { FALLBACK_ROLE } from "../lib/reviewer-fallback";
import { MAX_WORKER_ANCESTORS, WORKER_SETTINGS_ENV } from "../lib/worker-session";
import { projectFixture } from "./fake-native";

type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const workerInput = (task: string) => ({ route: "fresh" as const, tasks: [task], label: "Trim", area: "Tokens", permissionMode: "full" as const });

/** The claude-code provider env BB resolves for a session start of `threadId`. */
const sessionEnv = (f: Fx, threadId: string) =>
  f.harness.resolveProviderEnv("claude-code", { threadId, projectId: "proj_a", hostId: "host_a" });
const settingsOf = async (f: Fx, threadId: string) => {
  const entry = (await sessionEnv(f, threadId)).find((e: { name: string }) => e.name === WORKER_SETTINGS_ENV);
  return entry ? JSON.parse(entry.value as string) : null;
};
/** A thread some agent spawned with --parent-self: no Initiative origin or metadata. */
const child = (f: Fx, id: string, parentThreadId: string) =>
  f.threads.set(id, { ...f.threads.get("coordinator")!, id, parentThreadId, originPluginId: null });

describe("W605 worker sessions leave out unused tools and skills", () => {
  it("trims a worker and its descendants, also once they join the Initiative as nested threads", async () => {
    const { f, project } = await projectFixture();
    const [d] = await f.service.delegate(project.id, workerInput(f.task(project.id).ref));

    const worker = await settingsOf(f, d.threadId!);
    expect(worker.permissions.deny).toEqual(["Workflow", "ReportFindings", "AskUserQuestion", "ListAgents", "ScheduleWakeup"]);
    // Hidden from the model, still typable; workflow-authoring goes with the Workflow tool.
    expect(worker.skillOverrides).toMatchObject({ "workflow-authoring": "user-invocable-only", "bb-global-skills:thread-list": "user-invocable-only" });
    for (const kept of ["code-review", "principles", "simplify", "bb-global-skills:initiative-worker", "bb-global-skills:chat-memory"])
      expect(worker.skillOverrides).not.toHaveProperty([kept]);

    // Its reviewer, and a helper that reviewer spawns.
    child(f, "review", d.threadId!);
    child(f, "helper", "review");
    expect(await settingsOf(f, "review")).toEqual(worker);
    expect(await settingsOf(f, "helper")).toEqual(worker);
    // Once idle, BB's sweep records them as the Initiative's nested threads.
    for (const threadId of ["review", "helper"])
      f.store.associateNestedThread({ projectId: project.id, threadId, label: threadId, bbProjectId: "proj_a" });
    expect(f.store.membership("review")?.kind).toBe("adhoc");
    expect(await settingsOf(f, "review")).toEqual(worker);
    expect(await settingsOf(f, "helper")).toEqual(worker);
  });

  it("trims a worker's first session, before its spawn response confirms it", async () => {
    const { f, project } = await projectFixture();
    let firstStart: unknown = null;
    const spawn = f.spawn.getMockImplementation()!;
    f.spawn.mockImplementationOnce(async (args) => {
      const thread = await spawn(args);
      expect(f.store.membership(thread.id)).toBeNull();
      firstStart = await settingsOf(f, thread.id);
      return thread;
    });
    await f.service.delegate(project.id, workerInput(f.task(project.id).ref));
    expect(firstStart).toMatchObject({ permissions: { deny: expect.arrayContaining(["Workflow"]) } });
  });

  it("looks up to MAX_WORKER_ANCESTORS parents for a worker", async () => {
    const { f, project } = await projectFixture();
    const [d] = await f.service.delegate(project.id, workerInput(f.task(project.id).ref));
    let parent = d.threadId!;
    for (let depth = 1; depth <= MAX_WORKER_ANCESTORS; depth++) {
      child(f, `depth-${depth}`, parent);
      parent = `depth-${depth}`;
    }
    expect(await settingsOf(f, `depth-${MAX_WORKER_ANCESTORS}`)).not.toBeNull();
    child(f, "too-deep", parent);
    expect(await sessionEnv(f, "too-deep")).toEqual([]);
  });

  it("trims a fallback reviewer the plugin started", async () => {
    const { f } = await projectFixture();
    f.threads.set("fallback", { ...f.threads.get("coordinator")!, id: "fallback", originPluginId: "initiatives" });
    f.metadata.set("fallback", { role: FALLBACK_ROLE, projectId: "p", worker: 1, replaces: "r" });
    expect(await settingsOf(f, "fallback")).not.toBeNull();
  });

  it("leaves coordinators, former and retired workers, user threads and unknown threads whole", async () => {
    const { f, project } = await projectFixture();
    const [d] = await f.service.delegate(project.id, workerInput(f.task(project.id).ref));
    child(f, "coordinator-child", "coordinator");
    child(f, "someone-else", "nobody");
    for (const threadId of ["coordinator", "coordinator-child", "someone-else", "deleted"])
      expect(await sessionEnv(f, threadId)).toEqual([]);
    // A worker replaced by a new generation: someone resuming the old thread gets it whole.
    const num = f.store.membership(d.threadId!)!.workerNum;
    f.store.updateWorker(project.id, num, { threadId: "new-generation", generation: 2 });
    expect(f.store.membership(d.threadId!)?.former).toBe(true);
    expect(await sessionEnv(f, d.threadId!)).toEqual([]);
    // A retired worker: someone talking to it afterwards gets it whole.
    const [r] = await f.service.delegate(project.id, workerInput(f.task(project.id).ref));
    f.store.updateWorker(project.id, f.store.membership(r.threadId!)!.workerNum, { state: "retired" });
    expect(await sessionEnv(f, r.threadId!)).toEqual([]);
  });
});
