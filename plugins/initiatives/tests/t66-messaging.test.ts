import { describe, expect, it, vi } from "vitest";
import { makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { projectFixture, report } from "./fake-native";
import { messageSchema } from "../lib/messaging";
import { z } from "zod";
import { messageCommand, messageToolAdvertised, messageToolSchema, workerMessageToolSchema } from "../lib/agent-tools";
import { delegateSchema } from "../lib/commands";
import { readCollection, readOptionsSchema } from "../lib/read";
import { MAX_GUIDANCE_CHARACTERS } from "../lib/settings";
const message = { target: "W2", text: "RPC contract is ready. No scope change." };
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
  it.each(["queued", "sent"] as const)("tool resolves current peers and forwards a worker's message queued with actual sender and honest %s receipt", async delivery => {
    const { f, caller, target } = await peers();
    const queued = { delivery: "queued", queuedMessage: { id: "q-message", senderThreadId: caller, initiator: "agent" } };
    if (delivery === "queued") f.send.mockResolvedValueOnce(queued);
    const result = JSON.parse(await f.harness.behavior.callAgentTool("initiative_message", message, { threadId: caller }) as string);
    // W215: the tool answers with a short receipt.
    expect(result).toEqual({ to: "W2", delivery });
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0][0]).toMatchObject({ threadId: target, senderThreadId: caller, mode: "queue-if-active" });
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
  describe("delivery is not chosen", () => {
    const plain = { target: "W2", text: "Interface fact." };
    it("a lead steers a running worker", async () => {
      const { f, target } = await peers();
      f.threads.set(target, { ...f.threads.get(target)!, status: "active" });
      await f.service.message("coordinator", plain);
      expect(f.send.mock.calls.map(c => c[0])).toMatchObject([{ threadId: target, senderThreadId: "coordinator", mode: "steer-if-active" }]);
    });
    it("a worker queues to the coordinator and to a peer", async () => {
      const { f, caller } = await peers();
      await f.service.message(caller, { target: "coordinator", text: "Blocked?" });
      await f.service.message(caller, plain);
      expect(f.send.mock.calls.map(c => c[0].mode)).toEqual(["queue-if-active", "queue-if-active"]);
    });
    it("a worker that has not started yet gets a lead's message as a queue instead of a refusal", async () => {
      const { f, target } = await peers();
      f.threads.set(target, { ...f.threads.get(target)!, status: "pending" });
      await f.service.message("coordinator", plain);
      expect(f.send.mock.calls[0][0]).toMatchObject({ threadId: target, mode: "queue-if-active" });
    });
    it.each(["queue", "steer"])("a message passing mode:%s is refused with the explanation, from the tool, a batch and the command", async mode => {
      const { f, project, caller } = await peers();
      const explained = /mode: delivery is no longer chosen, so this option was removed: a lead's message to a worker always steers/;
      await expect(f.harness.callAgentTool("initiative_message", { to: "W2", text: "x", mode }, { threadId: "coordinator" })).rejects.toThrow(explained);
      await expect(f.harness.callAgentTool("initiative_message", { to: "lead", text: "x", mode }, { threadId: caller })).rejects.toThrow(explained);
      const batch = JSON.parse(await f.harness.callAgentTool("initiative_batch", { actions: [{ tool: "message", to: "W2", text: "x", mode }] }, { threadId: "coordinator" }) as string);
      expect(batch[0] ?? batch.results?.[0]).toMatchObject({ ok: false, error: expect.stringMatching(explained) });
      expect(messageSchema.safeParse({ ...plain, mode }).success).toBe(false);
      const cli = await f.harness.runCli(["command", JSON.stringify({ action: "message", ...plain, mode }), project.id], { threadId: caller });
      expect(cli.exitCode).toBe(1);
      expect(`${cli.stdout}${cli.stderr}`).toMatch(/this option was removed/);
      expect(f.send).not.toHaveBeenCalled();
    });
    it("work with a mode or a command's delivery is refused too, and the tool never advertises either", () => {
      const removed = (r: { success: boolean; error?: z.ZodError }) => !r.success && r.error!.issues.some(i => i.path.length === 1 && /this option was removed/.test(i.message));
      expect(removed(messageToolSchema.safeParse({ to: "W2", text: "x", tasks: ["T1"], mode: "queue" }))).toBe(true);
      for (const delivery of ["queue", "steer", true, null]) expect(removed(delegateSchema.safeParse({ action: "delegate", route: "continue", worker: "W2", delivery }))).toBe(true);
      expect(JSON.stringify(z.toJSONSchema(messageToolAdvertised, { io: "input" }))).not.toMatch(/mode|queue/);
      expect(JSON.stringify(z.toJSONSchema(workerMessageToolSchema, { io: "input" }))).not.toMatch(/mode|queue/);
    });
    it("the tool leaves a plain message's delivery to the sender/target rule and steers more work", () => {
      expect(messageCommand(messageToolSchema.parse({ to: "W2", text: "x" }))).toEqual({ action: "message", target: "W2", text: "x" });
      expect(messageCommand(messageToolSchema.parse({ to: "W2", text: "x", work: true }))).toEqual({ action: "delegate", route: "continue", role: "work", worker: "W2", note: "x" });
    });
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
      // W492: a sender's own unsettled Stop or start keeps nothing it says from going out; it is
      // running, so nothing is woken. Only a target in that state is refused.
      if (side === "caller" && (kind === "cancelled" || kind === "uncertain")) {
        await f.service.message(caller, message); expect(f.send).toHaveBeenCalledTimes(1);
        continue;
      }
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
    expect(r.items[0]).toMatchObject({ ref: "W2", assignments: [{ ref: "A2", tasks: ["T2"] }] });
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
  await expect(f.service.message(caller, message)).rejects.toThrow(state === "archived" || state === "deleted" ? /W2's thread is archived, deleted or outside this Initiative/
    : new RegExp(`W2's thread is not running \\(status ${state}\\), and a message never resumes stopped or finished work. Give it more work with work:true, or spawn a fresh worker with handoffs:\\["W2"\\]`)); expect(f.send).not.toHaveBeenCalled();
});
it("definite native refusal is distinct from uncertainty, with resolved receipt-inspection target", async () => {
  const { f, caller, target } = await peers(); f.send.mockRejectedValueOnce(Object.assign(new Error("Refused"), { status: 400 }));
  await expect(f.service.message(caller, message)).rejects.toThrow(`refused to W2 at ${target} generation 1`); expect(f.send).toHaveBeenCalledTimes(1);
});
