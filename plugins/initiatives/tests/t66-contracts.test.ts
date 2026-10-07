import { describe, expect, it, vi } from "vitest";
import { makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { projectFixture, fixture, report } from "./fake-native";
import { readCollection, readOptionsSchema } from "../lib/read";
import { DEFAULT_COORDINATOR_INSTRUCTIONS, DEFAULT_WORKER_INSTRUCTIONS } from "../lib/guidance";
import { MAX_GUIDANCE_CHARACTERS } from "../lib/settings";
async function work() {
  const { f, project } = await projectFixture(); const task = f.task(project.id);
  const [w] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
  return { f, project, task, w };
}

describe("T66 native origin/report contract", () => {
  it("an ordinary current-coordinator child with turn notices is still sent its report (D417)", async () => {
    const { f, w } = await work();
    f.parentNotices(w.threadId!, "turns");
    const r = await f.service.report(w.threadId!, report());
    expect(r.note).toBe("Report recorded and sent to the coordinator."); expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("a report whose send fails is kept, says so, and an identical re-file doesn't send again", async () => {
    const { f, project, w } = await work(); f.send.mockRejectedValueOnce(new Error("Lost response"));
    const r = await f.service.report(w.threadId!, report()); await f.service.report(w.threadId!, report());
    expect(r.note).toMatch(/sending it to the coordinator failed \(Lost response\); tell the coordinator with initiative_message/);
    expect(f.store.assignment(project.id, 1)?.report).toMatchObject({ outcome: "succeeded" }); expect(f.send).toHaveBeenCalledTimes(1);
  });
});

describe("T66 native ordinary fresh creation", () => {
  it.each([undefined, null])("native boundary rejects an ordinary actor with originKind %s before any creation", async originKind => {
    const { f, project } = await projectFixture();
    const threadsBefore = [...f.threads.entries()], metadataBefore = [...f.metadata.entries()];
    await expect(f.bb.sdk.threads.spawn({
      projectId: "proj_a", environment: { type: "reuse", environmentId: "env_a" },
      prompt: "Must be rejected before creation", parentThreadId: "coordinator",
      ...(originKind === null ? { originKind: null } : {}),
      startedOnBehalfOf: { initiator: "agent", senderThreadId: "coordinator" },
      pluginMetadata: { projectId: project.id, role: "worker" },
    })).rejects.toMatchObject({ status: 400, code: "invalid_request", message: "startedOnBehalfOf requires an originKind" });
    expect([...f.threads.entries()]).toEqual(threadsBefore);
    expect([...f.metadata.entries()]).toEqual(metadataBefore); expect(f.send).not.toHaveBeenCalled();
  });
  it("native origin check refuses a fork kind when neither explicit source nor parent source exists", async () => {
    const { f } = await projectFixture();
    await expect(f.bb.sdk.threads.spawn({
      projectId: "proj_a", environment: { type: "reuse", environmentId: "env_a" },
      prompt: "No source or parent", originKind: "fork",
      startedOnBehalfOf: { initiator: "agent", senderThreadId: "coordinator" },
    })).rejects.toMatchObject({ status: 400, message: "originKind requires a sourceThreadId" });
    expect(f.threads.size).toBe(1); expect(f.send).not.toHaveBeenCalled();
  });
  it("native origin validation uses the parent as the fork source, while ordinary plugin requests omit originKind", async () => {
    const { f } = await projectFixture();
    await expect(f.bb.sdk.threads.spawn({
      projectId: "proj_a", environment: { type: "reuse", environmentId: "env_a" },
      prompt: "Cross-field validation only", parentThreadId: "coordinator", originKind: "fork",
      startedOnBehalfOf: { initiator: "agent", senderThreadId: "coordinator" },
    })).resolves.toBeDefined();
    expect(f.spawn).toHaveBeenCalledTimes(1); expect(f.send).not.toHaveBeenCalled();
  });
  it("an agent-requested fresh reviewer binds actual implementation and preserves native/plugin/permission/profile provenance", async () => {
    const { f, project } = await projectFixture(); const task = f.task(project.id);
    const [implementer] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
    await f.service.report(implementer.threadId!, report()); f.spawn.mockClear(); f.send.mockClear();
    const result = await f.harness.runCli(["command", JSON.stringify({
      action: "delegate", route: "fresh", role: "review", label: "Independent review", area: "Review",
      reviewTargets: [{ task: task.ref, assignment: "A1", revision: report().handoff.workspaceRevision }],
      permissionMode: "full",
    }), project.id], { threadId: "coordinator" });
    expect(result.exitCode).toBe(0); expect(f.spawn).toHaveBeenCalledTimes(1);
    const args = f.spawn.mock.calls[0][0];
    expect(args).toMatchObject({ parentThreadId: "coordinator", origin: "plugin", originPluginId: "initiatives", permissionMode: "full", providerId: "codex", pluginMetadata: { projectId: project.id, role: "worker", worker: 2 } });
    expect(args.prompt).toMatch(/^W2 "Independent review" \(Review\) · review · T1/); expect(args.prompt).toContain('Review W1 "Historical search" (A1 · T1, done');
    expect(args).not.toHaveProperty("startedOnBehalfOf"); expect(args).not.toHaveProperty("originKind"); expect(args).not.toHaveProperty("senderThreadId");
    expect(f.threads.get([...f.threads.keys()].at(-1)!)).toMatchObject({ parentThreadId: "coordinator", originKind: null, originPluginId: "initiatives" });
    expect(f.send).not.toHaveBeenCalled();
  });
  it("fresh agent delegation omits unsupported actor, keeps parent and issues one seed", async () => {
    const { f, project } = await projectFixture();
    const r = await f.harness.runCli(["command", JSON.stringify({ action: "delegate", label: "Search", area: "Search", tasks: [f.task(project.id).ref] }), project.id], { threadId: "coordinator" });
    expect(r.exitCode).toBe(0); expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.spawn.mock.calls[0][0]).toHaveProperty("parentThreadId", "coordinator");
    expect(f.spawn.mock.calls[0][0]).not.toHaveProperty("startedOnBehalfOf");
    expect(f.spawn.mock.calls[0][0]).not.toHaveProperty("originKind");
    expect(f.spawn.mock.calls[0][0]).toMatchObject({ origin: "plugin", originPluginId: "initiatives", pluginMetadata: { projectId: project.id, role: "worker" } });
    expect(f.spawn.mock.calls[0][0].prompt).toMatch(/^W1 "Search" \(Search\) · work · T1/);
    expect(f.spawn.mock.calls[0][0]).not.toHaveProperty("senderThreadId"); expect(f.send).not.toHaveBeenCalled();
  });
  it("fresh dashboard delegation is human creation even though it has a native coordinator parent", async () => {
    const { f, project } = await projectFixture();
    await f.harness.callRpc("command", { projectId: project.id, command: { action: "delegate", label: "Search", area: "Search", tasks: [f.task(project.id).ref] } });
    expect(f.spawn.mock.calls[0][0]).toHaveProperty("parentThreadId", "coordinator"); expect(f.spawn.mock.calls[0][0]).not.toHaveProperty("startedOnBehalfOf"); expect(f.spawn.mock.calls[0][0]).not.toHaveProperty("senderThreadId");
    expect(f.spawn.mock.calls[0][0]).not.toHaveProperty("originKind"); expect(f.spawn).toHaveBeenCalledTimes(1); expect(f.send).not.toHaveBeenCalled();
  });
  it("agent and human coordinator starts omit unsupported actor and fake fork origin", async () => {
    for (const agent of [true, false]) {
      const f = fixture(); const cmd = { action: "create", name: "Test", objective: "Test", memberProjectIds: ["proj_a"], coordinator: { kind: "new" } };
      if (agent) await f.harness.callAgentTool("initiative_create", cmd, { threadId: "coordinator" }); else await f.harness.callRpc("command", { command: cmd });
      const call = f.spawn.mock.calls[0][0]; expect(call).not.toHaveProperty("senderThreadId");
      expect(call).not.toHaveProperty("startedOnBehalfOf"); expect(call).not.toHaveProperty("originKind");
      expect(call).toMatchObject({ origin: "plugin", originPluginId: "initiatives", pluginMetadata: { role: "coordinator" } });
      expect(f.store.projects()[0]?.coordinatorThreadId).toBe([...f.threads.keys()].at(-1));
      expect(f.spawn).toHaveBeenCalledTimes(1); expect(f.send).not.toHaveBeenCalled();
    }
  });
});

describe("T66 bounded configuration/discovery/default migration", () => {
  it("many workers and report histories keep bounded current references without global SDK or usage calls", async () => {
    const { f, project, w } = await work();
    f.store.tx(() => { for (let n = 0; n < 150; n++) f.store.createWorker({ projectId: project.id, label: `Worker ${n}`, role: "work", area: "Fixture", bbProjectId: "proj_a" }); });
    const usage = vi.spyOn(f.store, "projectUsage"), allAssignments = vi.spyOn(f.store, "assignments"), calls = f.harness.inspection.sdk.calls.length;
    const rows = readCollection(f.store, project.id, "workers", readOptionsSchema.parse({ limit: 8 }));
    expect(rows.items).toHaveLength(8); expect(rows.total).toBe(151); expect(rows.items[0]).toMatchObject({ assignments: [{ ref: "A1", tasks: ["T1"] }] });
    expect(JSON.stringify(rows).length).toBeLessThan(5000); expect(usage).not.toHaveBeenCalled(); expect(allAssignments).not.toHaveBeenCalled(); expect(f.harness.inspection.sdk.calls).toHaveLength(calls);
  });
  it("defaults remain within the editable guidance bound", () => {
    for (const text of [DEFAULT_COORDINATOR_INSTRUCTIONS, DEFAULT_WORKER_INSTRUCTIONS]) expect(text.length).toBeLessThanOrEqual(MAX_GUIDANCE_CHARACTERS);
  });
});

describe("T66 native event scoping through installed official harness", () => {
  it("actual member idle publishes its Initiative, known non-member idle publishes nothing", async () => {
    const { f, project, w } = await work(); const at = f.harness.realtimeSignals.length;
    const member = await f.harness.behavior.emitThreadEvent("thread.idle", { thread: { ...f.threads.get(w.threadId!)!, status: "idle" }, lastAssistantText: "Working checkpoint" });
    expect(member.errors).toEqual([]);
    expect(f.harness.realtimeSignals.slice(at)).toContainEqual({ channel: "initiatives-changed", payload: { projectId: project.id } });
    const next = f.harness.realtimeSignals.length;
    const other = await f.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "non-member" }), lastAssistantText: "No Initiative role" });
    expect(other.errors).toEqual([]); expect(f.harness.realtimeSignals.slice(next)).toEqual([]);
  });
  it("isolated wrapper keeps pre-removal membership and uses global fallback only without an identity", async () => {
    const { scopedNativeEvent } = await import("../lib/native-events");
    const { f, project, w } = await work(); const changed = vi.fn();
    await scopedNativeEvent(f.store, changed)(() => {
      f.store.db.prepare("DELETE FROM workers WHERE project_id=? AND num=1").run(project.id);
      f.store.db.prepare("DELETE FROM generations WHERE project_id=? AND worker_num=1").run(project.id);
    })({ thread: { id: w.threadId! } });
    expect(changed).toHaveBeenLastCalledWith(project.id);
    changed.mockClear(); await scopedNativeEvent(f.store, changed)(() => {})({}); expect(changed).toHaveBeenCalledWith();
  });
});
