import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { projectFixture, report } from "./fake-native";
import { readCollection, readRefs, readOptionsSchema } from "../lib/read";
import { DEFAULT_WORKER_INSTRUCTIONS, DEFAULT_COORDINATOR_INSTRUCTIONS, upgradeDecisionGuidance } from "../lib/guidance";
import { MAX_GUIDANCE_CHARACTERS } from "../lib/settings";

describe("A115 notification and native pending boundaries", () => {
  it.each(["accepted", "rejected"] as const)("a %s report settles its unissued notice during native parent inspection", async state => {
    const { f, project } = await projectFixture();
    const [w] = await f.service.delegate(project.id, { route: "fresh", access: "read-only", tasks: [f.task(project.id).ref] });
    f.harness.sdk.stub("threads.get", async ({ threadId }) => {
      f.store.updateAssignment(project.id, 1, { state });
      return { ...f.threads.get(threadId)!, originKind: "fork" };
    });
    const result = await f.service.report(w.threadId!, report());
    expect(result).toMatchObject({ state, notification: null });
    expect(f.store.assignment(project.id, 1)).toMatchObject({ state, report: report(), reportNotice: null });
    expect(f.send).not.toHaveBeenCalled();
  });
  it("confirmed pending recipients queue with actual sender/receipt; steer and Stop cannot bypass guards", async () => {
    const { f, project } = await projectFixture();
    const [w] = await f.service.delegate(project.id, { route: "fresh", access: "read-only", tasks: [f.task(project.id).ref] });
    f.threads.set(w.threadId!, { ...f.threads.get(w.threadId!)!, status: "pending" });
    f.queueSend("pending-peer");
    const input = { target: w.worker, text: "Future interface fact", mode: "queue" as const };
    const r = await f.service.message("coordinator", input);
    expect(r).toMatchObject({ threadId: w.threadId, generation: 1, receipt: { delivery: "queued", queuedMessage: { id: "pending-peer" } } });
    expect(f.send.mock.calls[0][0]).toMatchObject({ threadId: w.threadId, senderThreadId: "coordinator", mode: "queue-if-active" });
    await expect(f.service.message("coordinator", { ...input, mode: "steer" })).rejects.toThrow(/status pending.*queue mode/);
    f.store.updateWorker(project.id, 1, { userStopped: true });
    await expect(f.service.message("coordinator", input)).rejects.toThrow(/stopped/);
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it.each(["cancel", "generation", "role"])("pending queue still refuses a %s change during native reads", async change => {
    const { f, project } = await projectFixture();
    const [w] = await f.service.delegate(project.id, { route: "fresh", access: "read-only", tasks: [f.task(project.id).ref] });
    const [caller] = await f.service.delegate(project.id, { route: "fresh", access: "read-only", tasks: [f.task(project.id).ref] });
    f.threads.set(w.threadId!, { ...f.threads.get(w.threadId!)!, status: "pending" });
    f.harness.sdk.stub("threads.get", ({ threadId }) => {
      if (change === "cancel") f.store.updateAssignment(project.id, 1, { cancelRequested: true });
      if (change === "generation") f.store.updateWorker(project.id, 1, { generation: 2 });
      if (change === "role") f.store.db.prepare("UPDATE workers SET role='review' WHERE project_id=? AND num=1").run(project.id);
      return f.threads.get(threadId);
    });
    await expect(f.service.message(caller.threadId!, { target: w.worker, text: "Fact", mode: "queue" })).rejects.toThrow();
    expect(f.send).not.toHaveBeenCalled();
  });
});

describe("A115 bounded summary work and native ordinary start paths", () => {
  it("a page of eight over61 workers queries assignment summaries only for that page; refs select only their rows", async () => {
    const { f, project } = await projectFixture();
    for (let n = 0; n < 61; n++) f.store.createWorker({ projectId: project.id, label: `Worker ${n}`, role: "work", area: "Fixture", bbProjectId: "proj_a" });
    const prep = vi.spyOn(f.store.db, "prepare");
    const summaries = () => prep.mock.calls.filter(([sql]) => sql.includes("SELECT num,state,task_nums,cancel_requested"));
    const paged = readCollection(f.store, project.id, "workers", readOptionsSchema.parse({ offset: 8, limit: 8 }));
    expect(paged.items).toHaveLength(8); expect(paged.items[0]?.ref).toBe("W9"); expect(summaries()).toHaveLength(8);
    prep.mockClear();
    const refs = readRefs(f.store, project.id, readOptionsSchema.parse({ refs: ["W3", "W59", "W61"], offset: 1, limit: 1 }));
    expect(refs.items.map(x => x.ref)).toEqual(["W59"]); expect(summaries()).toHaveLength(1);
    prep.mockClear();
    readRefs(f.store, project.id, readOptionsSchema.parse({ refs: ["W3"], detailed: true, fields: ["handoff"] }));
    expect(summaries()).toHaveLength(0);
    expect(f.send).not.toHaveBeenCalled();
  });
  it("ordinary coordinator handover and human replacement omit unsupported actor", async () => {
    const { f, project } = await projectFixture();
    const cmd = { action: "coordinator-handover", reason: "Fresh context", checkpoint: "Scope unchanged" };
    const result = await f.harness.runCli(["command", JSON.stringify(cmd), project.id], { threadId: "coordinator" });
    expect(result.exitCode).toBe(0); f.idle("coordinator"); await f.service.drainHandover(project.id);
    expect(f.spawn).toHaveBeenCalledTimes(1); expect(f.spawn.mock.calls[0][0]).not.toHaveProperty("startedOnBehalfOf");
    expect(f.spawn.mock.calls[0][0]).not.toHaveProperty("originKind");
    expect(f.spawn.mock.calls[0][0]).not.toHaveProperty("senderThreadId");
    const human = await projectFixture(); human.f.idle("coordinator");
    await human.f.harness.callRpc("command", { projectId: human.project.id, command: { action: "replace-coordinator", reason: "Human requested replacement" } });
    expect(human.f.spawn).toHaveBeenCalledTimes(1); expect(human.f.spawn.mock.calls[0][0]).not.toHaveProperty("startedOnBehalfOf");
    expect(human.f.send).not.toHaveBeenCalled();
  });
  it("CLI usage documents the exact message path and manifest changes only its Settings display name", async () => {
    const { f } = await projectFixture(); const r = await f.harness.runCli(["message", "{}", "extra"]);
    expect(r.exitCode).toBe(1); expect(r.stderr).toContain("message '<json>'");
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    expect(manifest.name).toBe("bb-plugin-initiatives"); expect(manifest.bb.name).toBe("Initiatives"); expect(manifest.bb.server).toBe("./server.ts");
  });
  it("readable defaults and exact A113 phrasing upgrade preserve maximum-sized custom text", () => {
    const old = 'initiative_read {view:"workers",limit:8}: peers. initiative_message {target:"W4",text:"RPC",mode:"queue"}: facts; steer blockers/corrections. Reviewers use coordinator. Escalate scope/dependencies; no work grants. Human choices: coordinator question/context, options/consequences, recommendation, tasks; never infer. Routine progress never wakes. Keep errors/Stop/ownership/permissions. BB owns queues; inspect uncertain receipts.';
    const custom = old + "x".repeat(MAX_GUIDANCE_CHARACTERS - old.length);
    const updated = upgradeDecisionGuidance(custom, "worker", MAX_GUIDANCE_CHARACTERS);
    expect(updated).toContain("Use initiative_message for peer facts"); expect(updated.endsWith(custom.slice(old.length))).toBe(true);
    expect(updated.length).toBeLessThanOrEqual(custom.length); expect(upgradeDecisionGuidance(updated, "worker", MAX_GUIDANCE_CHARACTERS)).toBe(updated);
    for (const text of [DEFAULT_WORKER_INSTRUCTIONS, DEFAULT_COORDINATOR_INSTRUCTIONS]) { expect(text).toContain("Reviewers use the coordinator."); expect(text.length).toBeLessThanOrEqual(MAX_GUIDANCE_CHARACTERS); }
  });
});
