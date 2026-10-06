import { describe, expect, it } from "vitest";
import type { NewThreadRequest } from "@get-bb/plugin-sdk/app";
import { commandSchema, runCommand } from "../lib/commands";
import { projectFixture } from "./fake-native";

const request = (): NewThreadRequest => ({
  projectId: "proj_a", providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "high",
  serviceTier: "fast", permissionMode: "full", executionInputSources: { model: "explicit", permissionMode: "explicit" },
  environment: { type: "reuse", environmentId: "env_a" },
  input: [{ type: "text", text: "My own question", mentions: [] }], sendAt: Date.now() + 300_000,
});

describe("A96 native composer boundary", () => {
  it("forwards native controls/input/schedule unchanged and confirms a user-owned child without worker duties", async () => {
    const { f, project } = await projectFixture();
    const native = request();
    const result = await f.harness.callRpc("command", { projectId: project.id, command: { action: "thread-create", request: native } }) as { threadId: string };
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.spawn.mock.calls[0][0]).toMatchObject({ ...native, parentThreadId: "coordinator", pluginMetadata: { role: "adhoc", projectId: project.id } });
    expect(f.store.membership(result.threadId)).toMatchObject({ kind: "adhoc", workerNum: -1 });
    expect(f.store.workers(project.id)).toEqual([]);
    expect(f.store.assignments(project.id)).toEqual([]);
    expect(f.store.projectThreadByThreadId(result.threadId)).toMatchObject({ state: "active" });
    expect(f.send).not.toHaveBeenCalled();
  });

  it("requires a member repository and a live current coordinator before issuing a create", async () => {
    const { f, project } = await projectFixture();
    await expect(f.service.createUserThread(project.id, { request: { ...request(), projectId: "foreign" } })).rejects.toThrow(/repositories/);
    f.threads.set("coordinator", { ...f.threads.get("coordinator")!, archivedAt: Date.now() });
    await expect(f.service.createUserThread(project.id, { request: request() })).rejects.toThrow(/current coordinator/);
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("blocks agent-origin thread creation and excludes the old form payload from canonical commands", async () => {
    const { f, project } = await projectFixture();
    const cmd = commandSchema.parse({ action: "thread-create", request: request() });
    await expect(runCommand(f.service, project.id, cmd, "coordinator", "coordinator")).rejects.toThrow(/Only the user/);
    expect(commandSchema.safeParse({ action: "thread-create", prompt: "Old first message" }).success).toBe(false);
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("keeps only the existing RPC caller's old payload working with identical parent/ownership guards", async () => {
    const { f, project } = await projectFixture();
    const result = await f.harness.callRpc("command", { projectId: project.id, command: { action: "thread-create", prompt: "Existing Sidebar message", bbProjectId: "proj_a" } }) as { threadId: string };
    expect(f.spawn.mock.calls[0][0]).toMatchObject({ parentThreadId: "coordinator", input: [{ type: "text", text: "Existing Sidebar message" }], pluginMetadata: { role: "adhoc" } });
    expect(f.store.membership(result.threadId)?.kind).toBe("adhoc");
  });

  it("preserves an uncertain create receipt without claiming success or issuing another native operation", async () => {
    const { f, project } = await projectFixture();
    f.spawn.mockRejectedValueOnce(new Error("Lost create response"));
    const result = await f.service.createUserThread(project.id, { request: request() });
    expect(result).toMatchObject({ threadId: null, state: "uncertain" });
    expect(f.store.projectThreads(project.id)).toHaveLength(1);
    expect(f.store.projectThreads(project.id)[0].state).toBe("uncertain");
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
  });

  it("lets a retained worker distinguish user ownership from its recording provenance using the canonical CLI", async () => {
    const { f, project } = await projectFixture();
    const [worker] = await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id).ref] });
    expect(f.harness.registrations.cli?.name).toBe("initiative");
    const result = await f.harness.runCli(["command", JSON.stringify({ action: "decision", decision: { description: "Reuse the index.", madeBy: "agent" } }), project.id], { threadId: worker.threadId! });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ref: "D1", madeBy: "agent", provenance: { author: "worker", threadId: worker.threadId } });
    const userChoice = await f.harness.runCli(["command", JSON.stringify({ action: "decision", decision: { description: "The user chose this.", madeBy: "user" } }), project.id], { threadId: worker.threadId! });
    expect(userChoice.exitCode).toBe(0);
    expect(JSON.parse(userChoice.stdout)).toMatchObject({ madeBy: "user", description: "The user chose this.", provenance: { author: "worker", threadId: worker.threadId } });
  });
});
