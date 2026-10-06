import { describe, expect, it, vi } from "vitest";
import { makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { projectFixture, report } from "./fake-native";
import { messageSchema } from "../lib/messaging";
import { readCollection, readOptionsSchema } from "../lib/read";
import { MAX_GUIDANCE_CHARACTERS } from "../lib/settings";
const message = { target: "W2", text: "RPC contract is ready. No scope change.", mode: "queue" as const };
async function peers() {
  const { f, project } = await projectFixture();
  const workers = [];
  for (let n = 0; n < 2; n++) {
    const [w] = await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id).ref], access: "read-only" });
    workers.push(w);
  }
  return { f, project, caller: workers[0].threadId!, target: workers[1].threadId! };
}

describe("T66 trusted thin native messaging", () => {
  it.each(["steer", "queue"] as const)("tool resolves current peers and forwards %s with actual sender and honest receipt", async mode => {
    const { f, caller, target } = await peers();
    const queued = { delivery: "queued", queuedMessage: { id: "q-message", senderThreadId: caller, initiator: "agent" } };
    if (mode === "queue") f.send.mockResolvedValueOnce(queued);
    const result = JSON.parse(await f.harness.behavior.callAgentTool("initiative_message", { ...message, mode }, { threadId: caller }) as string);
    expect(result).toMatchObject({ target: "W2", threadId: target, generation: 1, receipt: { delivery: mode === "queue" ? "queued" : "sent" } });
    if (mode === "queue") expect(result.receipt).toEqual(queued);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0][0]).toMatchObject({ threadId: target, senderThreadId: caller, mode: `${mode}-if-active` });
    expect(f.send.mock.calls[0][0].input[0].text).toContain("From W1 (work)");
    expect(f.stop).not.toHaveBeenCalled();
  });
  it("retained worker CLI and typed command use the same boundary; coordinator is resolved now", async () => {
    const { f, project, caller } = await peers();
    for (const args of [["message", JSON.stringify({ ...message, target: "coordinator" })], ["command", JSON.stringify({ action: "message", ...message }), project.id]]) {
      const r = await f.harness.runCli(args, { threadId: caller }); expect(r.exitCode).toBe(0);
    }
    expect(f.send.mock.calls[0][0]).toMatchObject({ threadId: "coordinator", senderThreadId: caller });
    expect(messageSchema.safeParse({ ...message, senderThreadId: "spoof" }).success).toBe(false);
    await expect(f.harness.callRpc("command", { projectId: project.id, command: { action: "message", ...message } })).rejects.toThrow(/managed agent/);
    const foreign = await f.harness.runCli(["command", JSON.stringify({ action: "message", ...message }), "foreign"], { threadId: caller });
    expect(foreign.exitCode).toBe(1); expect(f.send).toHaveBeenCalledTimes(2);
  });
  it("T136: a worker that already reported can still send and receive messages", async () => {
    const { f, project, caller } = await peers();
    f.store.updateAssignment(project.id, 2, { state: "reported", report: report() });
    f.store.updateAssignment(project.id, 1, { state: "reported", report: report() });
    await f.service.message(caller, message);
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it.each(["stopped", "cancelled", "retired", "former", "uncertain", "foreign", "adhoc"])("refuses %s caller and target without sending", async kind => {
    for (const side of ["caller", "target"] as const) {
      const { f, project, caller, target } = await peers(); const tid = side === "caller" ? caller : target; const num = side === "caller" ? 1 : 2;
      if (kind === "stopped") f.store.updateWorker(project.id, num, { userStopped: true });
      if (kind === "retired") f.store.updateWorker(project.id, num, { state: "retired" });
      if (kind === "cancelled") f.store.updateAssignment(project.id, num, { cancelRequested: true });
      if (kind === "finished") f.store.updateAssignment(project.id, num, { state: "reported", report: report() });
      if (kind === "uncertain") f.store.updateAssignment(project.id, num, { opState: "uncertain" });
      if (kind === "former") f.store.updateWorker(project.id, num, { threadId: "new-generation", generation: 2 });
      if (kind === "foreign") f.threads.set(tid, { ...f.threads.get(tid)!, projectId: "foreign" });
      if (kind === "adhoc") f.store.db.prepare("DELETE FROM workers WHERE project_id=? AND num=?").run(project.id, num);
      await expect(f.service.message(caller, message)).rejects.toThrow(); expect(f.send).not.toHaveBeenCalled();
    }
  });
  it("denies ad-hoc and former coordinator callers with positive stored membership", async () => {
    const { f, project, caller } = await peers();
    f.store.openProjectThread({ projectId: project.id, opId: "adhoc-op", label: "User", bbProjectId: "proj_a" });
    f.store.confirmProjectThread("adhoc-op", "adhoc"); f.threads.set("adhoc", makeThreadResponse({ id: "adhoc", projectId: "proj_a" }));
    await expect(f.service.message("adhoc", message)).rejects.toThrow(/user-owned/);
    f.store.openGeneration(project.id, 0, 1, "former-coordinator"); f.store.closeGeneration(project.id, 0, "replaced");
    await expect(f.service.message("former-coordinator", message)).rejects.toThrow(/former/);
    await expect(f.service.message(caller, { ...message, target: "coordinator" }, "foreign")).rejects.toThrow(/another Initiative/);
    expect(f.send).not.toHaveBeenCalled();
  });
  it("review independence permits coordinator escalation and prevents peer instruction exchange", async () => {
    const { f, project, caller, target } = await peers();
    f.store.db.prepare("UPDATE workers SET role='review' WHERE project_id=? AND num=2").run(project.id);
    await expect(f.service.message(caller, message)).rejects.toThrow(/Independent reviewers/);
    await expect(f.service.message(target, { ...message, target: "W1" })).rejects.toThrow(/Independent reviewers/);
    await f.service.message(target, { ...message, target: "coordinator" });
    await f.service.message("coordinator", message);
    expect(f.send).toHaveBeenCalledTimes(2);
  });
  it.each(["coordinator", "generation", "cancel"])("rechecks %s change during native reads, with no reroute or send", async kind => {
    const { f, project, caller } = await peers();
    f.harness.sdk.stub("threads.get", async ({ threadId }) => {
      if (kind === "coordinator") f.store.db.prepare("UPDATE projects SET coordinator_thread_id='replacement' WHERE id=?").run(project.id);
      if (kind === "generation") f.store.updateWorker(project.id, 2, { threadId: "replacement", generation: 2 });
      if (kind === "cancel") f.store.updateAssignment(project.id, 2, { cancelRequested: true });
      return f.threads.get(threadId);
    });
    await expect(f.service.message(caller, { ...message, target: kind === "coordinator" ? "coordinator" : "W2" })).rejects.toThrow();
    expect(f.send).not.toHaveBeenCalled();
  });
  it("a lost send response is an error, never an automatic retry or plugin inbox", async () => {
    const { f, project, caller } = await peers(); const history = f.store.inbox(project.id);
    f.send.mockRejectedValueOnce(new Error("Response lost; delivery uncertain"));
    await expect(f.service.message(caller, message)).rejects.toThrow(/uncertain/);
    expect(f.send).toHaveBeenCalledTimes(1); expect(f.store.inbox(project.id)).toEqual(history);
  });
  it("bounded discovery and current fork identity require no usage, overview or global native calls", async () => {
    const { f, project, caller } = await peers();
    const usage = vi.spyOn(f.store, "projectUsage"), assignments = vi.spyOn(f.store, "assignments");
    const r = readCollection(f.store, project.id, "workers", readOptionsSchema.parse({ limit: 1 }));
    expect(r.items[0]).toMatchObject({ ref: "W1", assignments: [{ ref: "A1", tasks: ["T1"] }] });
    expect(r.nextOffset).toBe(1); expect(usage).not.toHaveBeenCalled(); expect(assignments).not.toHaveBeenCalled();
    const before = f.harness.inspection.sdk.calls.length;
    const config = await f.harness.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: f.threads.get(caller)! }));
    expect(config.tools.map(t => t.name)).toContain("initiative_message"); expect(config.tools.map(t => t.name)).not.toContain("project_message");
    expect(config.instructions).toContain('You are W1 "Historical search" (src), role work.');
    expect(f.harness.inspection.sdk.calls).toHaveLength(before);
    await f.preferences.handle.experimental_set({ workerInstructions: "x".repeat(MAX_GUIDANCE_CHARACTERS) });
    const max = await f.harness.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: f.threads.get(caller)! }));
    expect(max.instructions!.length).toBeLessThanOrEqual(4096);
  });
});

it.each(["error", "stopping", "archived", "deleted"])("native unavailable %s targets cannot be resumed", async state => {
  const { f, caller, target } = await peers();
  const row = f.threads.get(target)!;
  f.threads.set(target, { ...row, ...(state === "archived" ? { archivedAt: Date.now() } : state === "deleted" ? { deletedAt: Date.now() } : { status: state as "error" | "stopping" }) });
  await expect(f.service.message(caller, message)).rejects.toThrow(/unavailable/); expect(f.send).not.toHaveBeenCalled();
});
it("definite native refusal is distinct from uncertainty, with resolved receipt-inspection target", async () => {
  const { f, caller, target } = await peers(); f.send.mockRejectedValueOnce(Object.assign(new Error("Refused"), { status: 400 }));
  await expect(f.service.message(caller, message)).rejects.toThrow(`refused to W2 at ${target} generation 1`); expect(f.send).toHaveBeenCalledTimes(1);
});
