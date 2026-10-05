import { describe, expect, it } from "vitest";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { fixture, projectFixture } from "./fake-native";

type Fixture = ReturnType<typeof fixture>;
const checkout = {
  type: "host",
  hostId: "host_a",
  workspace: { type: "unmanaged", path: "/code/repo" },
};
const execution = {
  providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "high",
  serviceTier: "fast", permissionMode: "full",
};

/** Model native automatic placement remembering/selecting a worker worktree. */
function rememberWorktree(f: Fixture) {
  f.envs.set("env_remembered", {
    ...f.envs.get("env_a")!, id: "env_remembered",
    path: "/code/repo-wt", isWorktree: true,
  });
  const original = f.spawn.getMockImplementation()!;
  f.spawn.mockImplementation(async (args) => {
    let environmentId = args.environment?.environmentId;
    if (args.environment?.type === "project-default") environmentId = "env_remembered";
    if (args.environment?.type === "host") {
      environmentId = [...f.envs.values()].find((env) =>
        env.hostId === args.environment.hostId &&
        env.path === args.environment.workspace.path && env.isWorktree === false,
      )?.id;
      if (!environmentId) throw new Error("No checkout matches the requested host/path");
    }
    return original({ ...args, environment: { type: "reuse", environmentId } });
  });
}
function inheritExecution(f: Fixture) {
  f.threads.set("coordinator", { ...f.threads.get("coordinator")!, providerId: "codex" });
  f.execution.set("coordinator", execution);
}
function startRow(f: Fixture, projectId: string) {
  return f.store.db.prepare("SELECT state, thread_id FROM coordinator_starts WHERE project_id=?").get(projectId);
}

describe("T56 proven coordinator default checkout", () => {
  it("creates on the proven primary checkout despite automatic worktree placement", async () => {
    const f = fixture();
    rememberWorktree(f);
    const result = await f.service.createProject({
      name: "Search", objective: "Historical search", memberProjectIds: ["proj_a"],
      coordinator: { kind: "new" },
    });
    expect(result.note).toBeNull();
    expect(f.spawn.mock.calls[0][0].environment).toEqual(checkout);
    expect(result.project.coordinatorThreadId).toBeTruthy();
    expect(startRow(f, result.project.id)).toMatchObject({ state: "done", thread_id: result.project.coordinatorThreadId });
  });

  it("direct replacement bypasses remembered worktrees and preserves all execution settings", async () => {
    const { f, project } = await projectFixture();
    rememberWorktree(f);
    inheritExecution(f);
    f.idle("coordinator");
    const result = await f.service.replaceCoordinator(project.id, { reason: "Fresh context" });
    expect(result).toMatchObject({ note: null });
    expect(f.spawn.mock.calls[0][0]).toMatchObject(execution);
    expect(f.spawn.mock.calls[0][0].environment).toEqual(checkout);
    expect(f.store.project(project.id)!.coordinatorThreadId).toBe((result as { threadId: string }).threadId);
  });

  it.each([undefined, { type: "project-default" } as const])("queued handover selects the proven checkout when the incumbent home is wrong: %j", async (environment) => {
    const { f, project } = await projectFixture();
    rememberWorktree(f);
    inheritExecution(f);
    f.threads.set("coordinator", { ...f.threads.get("coordinator")!, environmentId: "env_remembered", status: "active" });
    const result = await f.service.replaceCoordinator(project.id, { reason: "Repair home", environment });
    expect(result).toMatchObject({ state: "pending" });
    expect(f.spawn).not.toHaveBeenCalled();
    f.idle("coordinator");
    await f.service.drainHandover(project.id);
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.spawn.mock.calls[0][0].environment).toEqual(checkout);
    expect(f.spawn.mock.calls[0][0]).toMatchObject(execution);
    expect(startRow(f, project.id)).toMatchObject({ state: "done" });
    expect(f.store.project(project.id)!.coordinatorThreadId).not.toBe("coordinator");
  });

  it("an explicit queued default overrides even a valid incumbent reuse", async () => {
    const { f, project } = await projectFixture();
    rememberWorktree(f);
    f.service.requestHandover(project.id, { environment: { type: "project-default" } }, "coordinator");
    await f.service.drainHandover(project.id);
    expect(f.spawn.mock.calls[0][0].environment).toEqual(checkout);
  });

  it("routes to the explicit default source host/path, not the first source or old home", async () => {
    const { f, project } = await projectFixture();
    rememberWorktree(f);
    f.harness.sdk.stub("projects.get", async () => ({
      id: "proj_a", name: "Repository", sources: [
        { hostId: "host_a", path: "/code/repo", isDefault: false },
        { hostId: "host_primary", path: "/srv/primary", isDefault: true },
      ],
    }));
    f.envs.set("env_primary", { ...f.envs.get("env_a")!, id: "env_primary", hostId: "host_primary", path: "/srv/primary" });
    f.idle("coordinator");
    const result = await f.service.replaceCoordinator(project.id, { reason: "Use the primary source" });
    expect(result).toMatchObject({ note: null });
    expect(f.spawn.mock.calls[0][0].environment).toEqual({ type: "host", hostId: "host_primary", workspace: { type: "unmanaged", path: "/srv/primary" } });
    expect(f.harness.sdk.callsTo("providers.models").at(-1)?.[0]).toMatchObject({ hostId: "host_primary" });
    expect(f.threads.get((result as { threadId: string }).threadId)?.environmentId).toBe("env_primary");
  });

  it.each(["direct", "queued", "incumbent"] as const)("retains proven ready reuse for %s replacement", async (route) => {
    const { f, project } = await projectFixture();
    rememberWorktree(f);
    const environment = { type: "reuse", environmentId: "env_a" } as const;
    if (route === "direct") {
      f.idle("coordinator");
      await f.service.replaceCoordinator(project.id, { reason: "Fresh context", environment });
    } else {
      f.service.requestHandover(project.id, route === "queued" ? { environment } : {}, "coordinator");
      await f.service.drainHandover(project.id);
    }
    expect(f.spawn.mock.calls[0][0].environment).toEqual(environment);
    expect(startRow(f, project.id)).toMatchObject({ state: "done" });
  });

  it.each([
    { sources: [] },
    { sources: [{ hostId: "host_a", path: "/code/repo", isDefault: false }] },
    { sources: [{ hostId: "host_a", isDefault: true }] },
    { sources: [{ path: "/code/repo", isDefault: true }] },
  ])("fails visibly before initial native spawn when no default checkout is provable: %j", async ({ sources }) => {
    const f = fixture();
    f.harness.sdk.stub("projects.get", async () => ({ id: "proj_a", name: "Repository", sources }));
    const result = await f.service.createProject({
      name: "Search", objective: "Historical search", memberProjectIds: ["proj_a"], coordinator: { kind: "new" },
    });
    expect(result.note).toContain("cannot be proven");
    expect(result.project.coordinatorThreadId).toBeNull();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(startRow(f, result.project.id)).toBeUndefined();
  });

  it.each(["direct", "queued"] as const)("fails visibly before %s replacement when the default source is unreadable", async (route) => {
    const { f, project } = await projectFixture();
    f.harness.sdk.stub("projects.get", async () => { throw new Error("Source lookup unavailable"); });
    f.idle("coordinator");
    if (route === "direct") {
      await expect(f.service.replaceCoordinator(project.id, { reason: "Fresh context" })).rejects.toThrow(/default source.*could not be read/);
    } else {
      f.service.requestHandover(project.id, { environment: { type: "project-default" } }, "coordinator");
      await f.service.drainHandover(project.id);
      expect(f.store.handover(project.id)).toMatchObject({ state: "failed", detail: expect.stringContaining("could not be read") });
    }
    expect(f.spawn).not.toHaveBeenCalled();
    expect(startRow(f, project.id)).toBeUndefined();
    expect(f.store.project(project.id)!.coordinatorThreadId).toBe("coordinator");
    expect(f.threads.get("coordinator")!.archivedAt).toBeNull();
  });

  it("retains a mismatched receipt even when native ignores the exact checkout request", async () => {
    const { f, project } = await projectFixture();
    f.idle("coordinator");
    f.envs.set("env_wrong", { ...f.envs.get("env_a")!, id: "env_wrong", hostId: "host_other" });
    const original = f.spawn.getMockImplementation()!;
    f.spawn.mockImplementationOnce(async (args) => original({ ...args, environment: { type: "reuse", environmentId: "env_wrong" } }));
    await expect(f.service.replaceCoordinator(project.id, { reason: "Fresh context" })).rejects.toThrow(/cannot be proven/);
    const candidate = [...f.threads.values()].at(-1)!;
    expect(f.spawn.mock.calls[0][0].environment).toEqual(checkout);
    expect(startRow(f, project.id)).toMatchObject({ state: "uncertain", thread_id: candidate.id });
    expect(f.store.project(project.id)!.coordinatorThreadId).toBe("coordinator");
    await expect(f.service.settleCoordinator(project.id, { threadId: candidate.id })).rejects.toThrow(/cannot be proven/);
    expect(await f.service.replaceCoordinator(project.id, { reason: "Again" })).toMatchObject({ state: "pending" });
    expect(f.spawn).toHaveBeenCalledTimes(1);
  });

  it("cannot atomically confirm against a primary member changed during returned-home proof", async () => {
    const { f, project } = await projectFixture();
    f.idle("coordinator");
    f.harness.sdk.stub("environments.get", async ({ environmentId }: { environmentId: string }) => {
      f.store.updateProject(project.id, { memberProjectIds: ["proj_b", "proj_a"] });
      return f.envs.get(environmentId);
    });
    await expect(f.service.replaceCoordinator(project.id, { reason: "Fresh context" })).rejects.toThrow(/primary member changed/);
    const candidate = [...f.threads.values()].at(-1)!;
    expect(f.spawn.mock.calls[0][0].environment).toEqual(checkout);
    expect(startRow(f, project.id)).toMatchObject({ state: "uncertain", thread_id: candidate.id });
    expect(f.store.project(project.id)).toMatchObject({ coordinatorThreadId: "coordinator", coordinatorGeneration: 1 });
    expect(f.threads.get("coordinator")!.archivedAt).toBeNull();
  });

  it("pending bootstrap does not claim coordinator authority or already-transferred workers", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id);
    const [worker] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref], label: "Search", area: "Historical search" });
    f.spawn.mockClear();
    f.idle("coordinator");
    const original = f.spawn.getMockImplementation()!;
    f.spawn.mockImplementationOnce(async (args) => {
      const thread = await original(args);
      f.threads.set(thread.id, { ...thread, environmentId: null });
      return { ...thread, environmentId: null };
    });
    const result = await f.service.replaceCoordinator(project.id, { reason: "Fresh context" });
    expect(result).toMatchObject({ state: "checkout-pending" });
    expect(f.store.project(project.id)!.coordinatorThreadId).toBe("coordinator");
    expect(f.threads.get(worker.threadId!)!.parentThreadId).toBe("coordinator");
    expect(f.threads.get("coordinator")!.archivedAt).toBeNull();
    const seed = f.spawn.mock.calls[0][0].prompt;
    expect(seed).toContain("Until confirmation");
    expect(seed).toContain("membership is unavailable");
    expect(seed).not.toContain("are your native children now");
    expect(seed).not.toContain("You are taking over as coordinator");
    const successor = f.threads.get((result as { threadId: string }).threadId)!;
    const config = await f.harness.resolveAgentConfiguration(makePluginAgentConfigurationContext({
      thread: successor,
      origin: { pluginId: "projects" },
      pluginMetadata: f.spawn.mock.calls[0][0].pluginMetadata,
    }));
    expect(config.instructions).not.toContain("Read initiative state freely");
    expect(config.instructions).toContain("once this thread is confirmed");
    await expect(f.harness.callAgentTool("initiative_read", {}, { threadId: successor.id })).rejects.toThrow(/does not belong/);
    await expect(f.harness.callAgentTool("initiative_task", { action: "task-create", title: "Premature task", summary: "Must wait for confirmation" }, { threadId: successor.id })).rejects.toThrow(/coordinator/);
    expect(f.store.project(project.id)!.coordinatorThreadId).toBe("coordinator");
    expect(startRow(f, project.id)).toMatchObject({ state: "pending", thread_id: successor.id });
  });
});
