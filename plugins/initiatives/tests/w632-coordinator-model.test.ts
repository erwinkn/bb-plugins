import { describe, expect, it, vi } from "vitest";
import { commandSchema, createSchema } from "../lib/commands";
import { fixture, projectFixture } from "./fake-native";

const base = {
  action: "create" as const,
  name: "Search",
  objective: "Historical search",
  memberProjectIds: ["proj_a"],
};
const neon = { providerId: "acp-antigravity", model: "gemini-pro-orchestrator-neon", reasoningLevel: "high" } as const;

describe("W632 coordinator model at creation: schema", () => {
  it("accepts a profile on a new coordinator", () => {
    const parsed = createSchema.parse({ ...base, coordinator: { kind: "new", profile: neon } });
    expect(parsed.coordinator).toEqual({ kind: "new", profile: neon });
  });
  it("still accepts a new coordinator without one", () => {
    expect(createSchema.safeParse({ ...base, coordinator: { kind: "new" } }).success).toBe(true);
  });
  it("rejects a profile on an adopted coordinator", () => {
    expect(createSchema.safeParse({ ...base, coordinator: { kind: "adopt", threadId: "t", profile: neon } }).success).toBe(false);
  });
  it("rejects a malformed profile", () => {
    expect(createSchema.safeParse({ ...base, coordinator: { kind: "new", profile: { providerId: "x" } } }).success).toBe(false);
  });
});

/** A thread BB recorded on Antigravity puts its provider and model in the fake catalog. */
function withAntigravity(f: ReturnType<typeof fixture>) {
  f.threads.set("ag", { ...f.threads.get("coordinator")!, id: "ag", providerId: neon.providerId });
  f.execution.set("ag", { model: neon.model, reasoningLevel: neon.reasoningLevel });
}

describe("W632 coordinator model at creation: service", () => {
  it("spawns on the chosen model and stores it as the coordinator profile", async () => {
    const f = fixture();
    withAntigravity(f);
    const { project, note } = await f.service.createProject({ ...base, coordinator: { kind: "new", profile: neon } });
    expect(note).toBeNull();
    expect(f.spawn.mock.calls[0][0]).toMatchObject(neon);
    expect(f.store.project(project.id)!.policy.profiles.coordinator).toEqual(neon);
    // The service's own result and the store agree, so a later replacement starts from it.
    expect(project.policy.profiles.coordinator).toEqual(neon);
  });
  it("the picked model wins over a coordinator profile in the policy, keeping its other profiles", async () => {
    const f = fixture();
    withAntigravity(f);
    const other = { providerId: "claude-code", model: "claude-sonnet-5-5", reasoningLevel: "low" } as const;
    const { project } = await f.service.createProject({
      ...base,
      policy: { profiles: { coordinator: other, implementation: other } },
      coordinator: { kind: "new", profile: neon },
    });
    expect(f.spawn.mock.calls[0][0]).toMatchObject(neon);
    expect(f.store.project(project.id)!.policy.profiles).toEqual({ coordinator: neon, implementation: other });
  });
  it("without a picked model, uses the default and stores no coordinator profile", async () => {
    const f = fixture();
    const { project } = await f.service.createProject({ ...base, coordinator: { kind: "new" } });
    expect(f.spawn.mock.calls[0][0]).toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" });
    expect(f.store.project(project.id)!.policy.profiles.coordinator).toBeUndefined();
  });
});

describe("W632 per-Initiative models: persistence", () => {
  const sonnet = { providerId: "claude-code", model: "claude-sonnet-5-5", reasoningLevel: "low" } as const;
  it("shows a profile picked at creation as the Initiative's custom Coordinator override", async () => {
    const f = fixture();
    withAntigravity(f);
    const { project } = await f.service.createProject({ ...base, coordinator: { kind: "new", profile: neon } });
    const o = await f.overview(project.id);
    expect(o.project.policy.profiles).toEqual({ coordinator: neon });
  });
  it("removing a role from the policy sticks: it is not merged back in", async () => {
    const f = fixture();
    const { project } = await f.service.createProject({ ...base, policy: { profiles: { coordinator: neon, implementation: sonnet } }, coordinator: { kind: "new" } });
    f.service.editProject(project.id, { policy: { profiles: { implementation: sonnet } } });
    expect(f.store.project(project.id)!.policy.profiles).toEqual({ implementation: sonnet });
    f.service.editProject(project.id, { policy: { profiles: {} } });
    expect(f.store.project(project.id)!.policy.profiles).toEqual({});
    expect((await f.overview(project.id)).project.policy.profiles).toEqual({});
  });
  it("a per-role patch applies to the stored policy: two clients changing different roles both stick", async () => {
    const f = fixture();
    const other = { providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "xhigh" } as const;
    const { project } = await f.service.createProject({ ...base, policy: { profiles: { implementation: sonnet, reviewOfGpt: other } }, coordinator: { kind: "new" } });
    // Two clients read the same snapshot, then each changes its own role.
    f.service.editProject(project.id, { profiles: { coordinator: neon } });
    f.service.editProject(project.id, { profiles: { implementation: null } });
    expect(f.store.project(project.id)!.policy.profiles).toEqual({ coordinator: neon, reviewOfGpt: other });
    f.service.editProject(project.id, { profiles: { coordinator: null, reviewOfGpt: null } });
    expect(f.store.project(project.id)!.policy.profiles).toEqual({});
  });
  it("the command schema takes a per-role patch and rejects an unknown role", () => {
    expect(commandSchema.safeParse({ action: "edit", profiles: { coordinator: neon, implementation: null } }).success).toBe(true);
    expect(commandSchema.safeParse({ action: "edit", profiles: { nope: neon } }).success).toBe(false);
  });
});

describe("W632 per-Initiative models: handover", () => {
  const sonnet = { providerId: "claude-code", model: "claude-sonnet-5-5", reasoningLevel: "high" } as const;
  async function started() {
    const f = fixture();
    const { project } = await f.service.createProject({ ...base, coordinator: { kind: "new" } });
    return { f, id: project.id };
  }
  const spawnedModel = (f: ReturnType<typeof fixture>) => f.spawn.mock.calls.at(-1)![0].model;

  it("a coordinator model saved on the Initiative starts the replacement and stays saved", async () => {
    const { f, id } = await started();
    f.service.editProject(id, { profiles: { coordinator: sonnet } });
    f.idle(f.store.project(id)!.coordinatorThreadId!);
    await f.service.replaceCoordinator(id, { reason: "Fresh context" });
    expect(f.spawn.mock.calls.at(-1)![0]).toMatchObject(sonnet);
    expect(f.store.project(id)!.policy.profiles.coordinator).toEqual(sonnet);
  });
  it("clearing it, a replacement inherits the incumbent's model without saving it again", async () => {
    const { f, id } = await started();
    f.service.editProject(id, { profiles: { coordinator: sonnet } });
    f.idle(f.store.project(id)!.coordinatorThreadId!);
    await f.service.replaceCoordinator(id, { reason: "Fresh context" });
    f.service.editProject(id, { profiles: { coordinator: null } });
    f.idle(f.store.project(id)!.coordinatorThreadId!);
    await f.service.replaceCoordinator(id, { reason: "Fresh context again" });
    // The incumbent (started on the saved Sonnet) is what it inherits; nothing is saved from that.
    expect(spawnedModel(f)).toBe("claude-sonnet-5-5");
    expect(f.store.project(id)!.policy.profiles.coordinator).toBeUndefined();
  });
  it("an explicit profile on the replacement is still saved", async () => {
    const { f, id } = await started();
    f.idle(f.store.project(id)!.coordinatorThreadId!);
    await f.service.replaceCoordinator(id, { reason: "Switch", profile: sonnet });
    expect(f.store.project(id)!.policy.profiles.coordinator).toEqual(sonnet);
  });

  describe("through the handover drain", () => {
    const opus = { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" } as const;
    const drained = async (before?: (f: ReturnType<typeof fixture>, id: string) => void) => {
      const { f, project } = await projectFixture();
      f.execution.set("coordinator", { ...opus, permissionMode: "full" });
      before?.(f, project.id);
      f.service.requestHandover(project.id, { checkpoint: "Focused remaining work" }, "coordinator");
      await f.service.drainHandover(project.id);
      return { f, id: project.id };
    };
    it("a saved coordinator model wins over the incumbent's and stays saved", async () => {
      const { f, id } = await drained((f, id) => f.service.editProject(id, { profiles: { coordinator: sonnet } }));
      expect(f.spawn.mock.calls.at(-1)![0]).toMatchObject(sonnet);
      expect(f.store.project(id)!.policy.profiles.coordinator).toEqual(sonnet);
    });
    it("without a saved model it inherits the incumbent's and saves nothing", async () => {
      const { f, id } = await drained();
      expect(f.spawn.mock.calls.at(-1)![0]).toMatchObject({ model: opus.model, reasoningLevel: opus.reasoningLevel, permissionMode: "full" });
      expect(f.store.project(id)!.policy.profiles.coordinator).toBeUndefined();
    });
    it("an explicit profile on the request is used and saved", async () => {
      const { f, project } = await projectFixture();
      f.execution.set("coordinator", { ...opus, permissionMode: "full" });
      f.service.requestHandover(project.id, { checkpoint: "Focused remaining work", profile: sonnet }, "coordinator");
      await f.service.drainHandover(project.id);
      expect(f.spawn.mock.calls.at(-1)![0]).toMatchObject(sonnet);
      expect(f.store.project(project.id)!.policy.profiles.coordinator).toEqual(sonnet);
    });
  });

  it("a coordinator model cleared while the replacement prepares stays cleared", async () => {
    const { f, id } = await started();
    f.service.editProject(id, { profiles: { coordinator: sonnet } });
    f.idle(f.store.project(id)!.coordinatorThreadId!);
    // The incumbent's execution settings are read after the replacement chose the saved model.
    const get = f.execution.get.bind(f.execution);
    let edited = false;
    vi.spyOn(f.execution, "get").mockImplementation((key: string) => {
      if (!edited) {
        edited = true;
        f.service.editProject(id, { profiles: { coordinator: null } });
      }
      return get(key);
    });
    await f.service.replaceCoordinator(id, { reason: "Fresh context" });
    expect(edited).toBe(true);
    expect(f.store.project(id)!.policy.profiles.coordinator).toBeUndefined();
  });
});
