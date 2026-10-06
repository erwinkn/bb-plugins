import { describe, expect, it } from "vitest";
import { commandSchema, delegateSchema } from "../lib/commands";
import { DEFAULT_PROFILES, profileSchema, storedPolicySchema, type Profile } from "../lib/schema";
import { buildOverview } from "../lib/overview";
import { brief } from "./helpers";
import { projectFixture, report } from "./fake-native";

const fast: Profile = {
  providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "high", serviceTier: "fast",
};
const fresh = (task: string, profile: Profile = fast) => ({
  route: "fresh" as const, tasks: [task], label: "Search", area: "Archived search", profile, permissionMode: "full" as const,
});
async function completedWorker() {
  const { f, project } = await projectFixture();
  const task = f.task(project.id);
  const [d] = await f.service.delegate(project.id, fresh(task.ref));
  await f.service.report(d.threadId!, report());
  await f.service.closeTask(project.id, task.ref, "done");
  f.idle(d.threadId!);
  f.send.mockClear();
  return { f, project, d };
}

describe("A94 native execution and complete startup", () => {
  it("keeps old profiles/policies compatible without changing Initiative defaults", () => {
    const old = { ...fast }; delete old.serviceTier;
    expect(profileSchema.parse(old)).toEqual(old);
    expect(storedPolicySchema.parse({ profiles: { implementation: old } }).profiles.implementation).toEqual(old);
    expect(DEFAULT_PROFILES.implementation).toEqual({ providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" });
    expect(DEFAULT_PROFILES.investigation).not.toHaveProperty("serviceTier");
  });

  it.each(["default", "fast"] as const)("validates %s in policy/task/delegation/replacement CLI commands", (serviceTier) => {
    const profile = { ...fast, serviceTier };
    const commands = [
      { action: "delegate", ...fresh("T1", profile) },
      { action: "task-update", task: "T1", profile },
      { action: "replace-coordinator", reason: "Fresh context", profile },
      { action: "coordinator-handover", profile },
      { action: "edit", policy: { profiles: { implementation: profile } } },
    ];
    for (const command of commands) expect(commandSchema.safeParse(command).success).toBe(true);
  });

  it.each(["priority", "", null, 1])("rejects invalid service tier %s instead of dropping it", (serviceTier) => {
    expect(profileSchema.safeParse({ ...fast, serviceTier }).success).toBe(false);
    expect(delegateSchema.safeParse({ action: "delegate", ...fresh("T1", { ...fast, serviceTier } as Profile) }).success).toBe(false);
  });

  it("publishes service-tier enum and full permissions in generated native tool schema", async () => {
    const { f } = await projectFixture();
    const tool = f.harness.registrations.agentTools.find((tool) => tool.name === "initiative_spawn")!;
    expect(tool).toBeDefined();
    const schema = tool.inputSchema as any;
    expect((schema.properties!.profile as any).properties.serviceTier.enum).toEqual(["default", "fast"]);
    expect((schema.properties!.permissionMode as any).enum).toEqual(["accept-edits", "auto", "full"]);
    expect(tool.description).toContain("Give work to a new worker");
  });

  it("CLI launches one native child with full brief, identity, assignment and explicit execution", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id);
    const result = await f.harness.runCli(["command", JSON.stringify({ action: "delegate", ...fresh(task.ref) }), project.id]);
    expect(result.exitCode).toBe(0);
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
    const spawn = f.spawn.mock.calls[0][0];
    expect(spawn).toMatchObject({ ...fast, permissionMode: "full", parentThreadId: "coordinator", title: "W1 Search — Archived search" });
    expect(spawn.prompt).toMatch(/^W1 "Search" \(Archived search\) · work · T1\n\nT1 Historical search\n/);
    expect(spawn.prompt).toContain("Objective: Make the thing work");
    expect(spawn.prompt).toContain("npm test");
    expect(spawn.prompt).toContain("codex / gpt-6.1-sol / high / fast; permissions: full");
    expect(f.store.assignment(project.id, 1)!.briefText).toBe(spawn.prompt);
    expect(f.store.assignment(project.id, 1)!.profile).toEqual(fast);
  });

  it("native-parent report stays canonical without another coordinator result send", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id);
    const [d] = await f.service.delegate(project.id, fresh(task.ref));
    await f.service.report(d.threadId!, report());
    expect(f.send).not.toHaveBeenCalled();
    const a = f.store.assignment(project.id, 1)!;
    expect(a.report?.summary).toBe(report().summary);
    expect(a.actualProfile).toEqual(fast);
    const o = buildOverview(f.store, project.id, new Map([[d.threadId!, { status: "active", archived: false, title: null }]]), Date.now());
    expect(o.inFlight[0]!.owner.profile).toBe("codex / gpt-6.1-sol / high / fast");
    expect(o.workers.current[0]!.profile).toBe("codex / gpt-6.1-sol / high / fast");
  });

  it("preserves the existing report fallback for an unparented worker", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id);
    const [d] = await f.service.delegate(project.id, fresh(task.ref));
    f.threads.set(d.threadId!, { ...f.threads.get(d.threadId!)!, parentThreadId: null });
    f.store.updateWorker(project.id, 1, { nativeParent: false });
    await f.service.report(d.threadId!, report());
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0][0].threadId).toBe("coordinator");
    expect(f.store.assignment(project.id, 1)!.report?.summary).toBe(report().summary);
  });

  it("continues with current native reasoning and tier, not stale ledger/policy settings", async () => {
    const { f, project, d } = await completedWorker();
    f.execution.set(d.threadId!, { ...fast, reasoningLevel: "xhigh", permissionMode: "full" });
    const task = f.task(project.id, "Focused correction");
    await f.service.delegate(project.id, { route: "continue", worker: d.worker, tasks: [task.ref], permissionMode: "full" });
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0][0]).toMatchObject({ threadId: d.threadId, model: fast.model, reasoningLevel: "xhigh", serviceTier: "fast", permissionMode: "full", mode: "queue-if-active" });
    expect(f.store.assignment(project.id, 2)!.profile).toEqual({ ...fast, reasoningLevel: "xhigh" });
  });

  it("continue honors explicit default tier and reasoning while leaving permission inheritance intact", async () => {
    const { f, project, d } = await completedWorker();
    const task = f.task(project.id, "Correction");
    const profile = { ...fast, reasoningLevel: "xhigh" as const, serviceTier: "default" as const };
    await f.service.delegate(project.id, { route: "continue", worker: d.worker, tasks: [task.ref], profile });
    expect(f.send.mock.calls[0][0]).toMatchObject({ model: fast.model, reasoningLevel: "xhigh", serviceTier: "default" });
    expect(f.send.mock.calls[0][0]).not.toHaveProperty("permissionMode");
    expect(f.execution.get(d.threadId!)?.permissionMode).toBe("full");
  });

  it("user task tier overrides current worker tier on continuation", async () => {
    const { f, project, d } = await completedWorker();
    const profile = { ...fast, serviceTier: "default" as const };
    const task = f.service.createTask(project.id, { title: "User correction", summary: "Focused", brief: brief(), profile }, "user");
    await f.service.delegate(project.id, { route: "continue", worker: d.worker, tasks: [task.ref] });
    expect(f.send.mock.calls[0][0].serviceTier).toBe("default");
  });

  it("refuses a coordinator tier choice conflicting with an explicit user task choice", async () => {
    const { f, project } = await projectFixture();
    const task = f.service.createTask(project.id, { title: "User task", summary: "Focused", brief: brief(), profile: { ...fast, serviceTier: "default" } }, "user");
    await expect(f.service.delegate(project.id, fresh(task.ref))).rejects.toThrow(/user chose/);
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("carries an explicit user tier on a later task in a fresh batch", async () => {
    const { f, project } = await projectFixture();
    const profile = { ...fast }; delete profile.serviceTier;
    f.store.updateProject(project.id, { policy: { profiles: { implementation: profile } } });
    const first = f.task(project.id);
    const second = f.service.createTask(project.id, { title: "Explicit tier", summary: "Same scope", brief: brief(), profile: fast }, "user");
    await f.service.delegate(project.id, { route: "fresh", tasks: [first.ref, second.ref], label: "Search", area: "Archived search", permissionMode: "full" });
    expect(f.spawn.mock.calls[0][0].serviceTier).toBe("fast");
    expect(f.store.assignment(project.id, 1)!.profile).toEqual(fast);
  });

  it("surfaces a native rejection of explicit Fast without retrying on another tier", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id);
    f.spawn.mockRejectedValueOnce(Object.assign(new Error("Native fast tier refused"), { status: 400 }));
    await expect(f.service.delegate(project.id, fresh(task.ref))).rejects.toThrow(/Native fast tier refused/);
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.spawn.mock.calls[0][0].serviceTier).toBe("fast");
    expect(f.store.assignment(project.id, 1)!.state).toBe("failed");
  });

  it("legacy user profile without a tier preserves native Fast on continuation", async () => {
    const { f, project, d } = await completedWorker();
    const profile = { ...fast }; delete profile.serviceTier;
    const task = f.service.createTask(project.id, { title: "Legacy choice", summary: "Focused", brief: brief(), profile }, "user");
    await f.service.delegate(project.id, { route: "continue", worker: d.worker, tasks: [task.ref] });
    expect(f.send.mock.calls[0][0].serviceTier).toBe("fast");
  });




  it.each(["continue"] as const)("rejects %s when native settings cannot be proven", async (route) => {
    const { f, project, d } = await completedWorker();
    f.harness.sdk.stub("threads.defaultExecutionOptions", async () => null);
    const task = f.task(project.id, "Correction");
    await expect(f.service.delegate(project.id, { route, worker: d.worker, tasks: [task.ref] })).rejects.toThrow(/native execution settings could not be resolved/);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.fork).not.toHaveBeenCalled();
  });

  it("rejects unavailable explicit Fast without creating a worker or silently lowering the tier", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id);
    await expect(f.service.delegate(project.id, fresh(task.ref, { ...DEFAULT_PROFILES.implementation, serviceTier: "fast" }))).rejects.toThrow(/No fallback tier/);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.store.workers(project.id)).toHaveLength(0);
  });

  it.each([undefined, "default"] as const)("fresh tier %s keeps native compatibility", async (serviceTier) => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id);
    const profile = { ...DEFAULT_PROFILES.implementation, ...(serviceTier ? { serviceTier } : {}) };
    await f.service.delegate(project.id, fresh(task.ref, profile));
    expect(f.spawn.mock.calls[0][0].serviceTier).toBe(serviceTier);
  });

  it.each([undefined, "default"] as const)("replacement tier %s preserves permissions and honors explicit override", async (serviceTier) => {
    const { f, project } = await projectFixture();
    f.threads.set("coordinator", { ...f.threads.get("coordinator")!, providerId: "codex" });
    f.execution.set("coordinator", { ...fast, permissionMode: "full" });
    f.idle("coordinator");
    const profile = { ...fast }; delete profile.serviceTier;
    if (serviceTier) profile.serviceTier = serviceTier;
    await f.service.replaceCoordinator(project.id, { reason: "Fresh context", profile });
    expect(f.spawn.mock.calls[0][0]).toMatchObject({ model: fast.model, permissionMode: "full", serviceTier: serviceTier ?? "fast" });
  });

  it("deferred replacement honors explicit tier without dropping inherited full permissions", async () => {
    const { f, project } = await projectFixture();
    f.threads.set("coordinator", { ...f.threads.get("coordinator")!, providerId: "codex" });
    f.execution.set("coordinator", { ...fast, permissionMode: "full" });
    f.service.requestHandover(project.id, { checkpoint: "Focused remaining work", profile: { ...fast, serviceTier: "default" } }, "coordinator");
    await f.service.drainHandover(project.id);
    expect(f.spawn.mock.calls[0][0]).toMatchObject({ model: fast.model, permissionMode: "full", serviceTier: "default" });
  });
});
