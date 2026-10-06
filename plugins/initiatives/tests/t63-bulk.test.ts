import { describe, expect, it, vi } from "vitest";
import { projectFixture } from "./fake-native";
const recorder = { author: "coordinator" as const, threadId: "coordinator", assignment: null };
describe("T63 human quiet bulk acceptance", () => {
  it("accepts only unchecked active agent choices in one transaction and retains every record and original provenance", async () => {
    const { f, project } = await projectFixture();
    const choices = ["pending", "okay", "not-okay"].map(review => {
      const d = f.service.recordDecision(project.id, { decision: { description: `Choice ${review}`, madeBy: "agent" } }, recorder);
      if (review !== "pending") f.store.updateDecision(project.id, d.num, { review: review as "okay" | "not-okay", reviewMessage: "Existing verdict", notification: { op: "existing-notification", state: "failed", coordinatorThreadId: "coordinator", detail: "Original receipt" } });
      return f.store.decisionItem(project.id, d.num)!;
    });
    const user = f.service.recordDecision(project.id, { decision: { description: "Human choice", madeBy: "user" } }, recorder);
    const q = f.service.recordQuestion(project.id, { title: "Scope", question: "More?", context: "Choose", humanAttention: "needs-opinion" }, recorder);
    const old = f.service.recordDecision(project.id, { decision: { description: "Old", madeBy: "agent" } }, recorder); f.store.updateDecision(project.id, old.num, { status: "superseded" });
    const removed = f.service.recordDecision(project.id, { decision: { description: "Removed", madeBy: "agent" } }, recorder); f.store.updateDecision(project.id, removed.num, { status: "removed" });
    const protectedNums = [choices[1]!.num, choices[2]!.num, user.num, q.num, old.num, removed.num];
    const before = protectedNums.map(num => f.store.decisionItem(project.id, num));
    const other = f.store.createProject({ id: "other", name: "Other", objective: "Foreign fixture", memberProjectIds: ["proj_a"], coordinatorThreadId: null });
    const foreign = f.service.recordDecision(other.id, { decision: { description: "Foreign", madeBy: "agent" } }, recorder);
    const tx = vi.spyOn(f.store, "tx");
    const result = await f.harness.callRpc("command", { projectId: project.id, command: { action: "decision-accept-all" } });
    expect(result).toEqual({ accepted: 1, refs: [choices[0]!.ref] }); expect(tx).toHaveBeenCalledTimes(1);
    expect(f.store.decisionItem(project.id, choices[0]!.num)).toMatchObject({ status: "active", humanAttention: "none", madeBy: "agent", provenance: choices[0]!.provenance, review: "okay", body: choices[0]!.body });
    expect(protectedNums.map(num => f.store.decisionItem(project.id, num))).toEqual(before);
    expect(f.store.decisionItem(other.id, foreign.num)).toEqual(foreign); expect(f.send).not.toHaveBeenCalled();
    const o = await f.overview(project.id); expect(o.decisions.find(d => d.ref === choices[0]!.ref)).toMatchObject({ review: "okay", acceptEligible: false }); expect(o.opinionNeeded).toHaveLength(1);
    expect(o.decisions.every(d => !d.acceptEligible)).toBe(true);
    expect(await f.harness.callRpc("command", { projectId: project.id, command: { action: "decision-accept-all" } })).toEqual({ accepted: 0, refs: [] });
  });
  it("retired bulk removal gives old callers a corrective error without touching records", async () => {
    const { f, project } = await projectFixture(); const d = f.service.recordDecision(project.id, { decision: { description: "Choice", madeBy: "agent" } }, recorder);
    await expect(f.harness.callRpc("command", { projectId: project.id, command: { action: "decision-clear" } })).rejects.toThrow(/Refresh the dashboard.*decision-accept-all/);
    expect(f.store.decisionItem(project.id, d.num)).toEqual(d); expect(f.send).not.toHaveBeenCalled();
  });
  it("denies coordinator and worker agent CLI bulk authority", async () => {
    const { f, project } = await projectFixture(); const [worker] = await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id).ref] });
    for (const threadId of ["coordinator", worker.threadId!]) {
      const result = await f.harness.runCli(["command", JSON.stringify({ action: "decision-accept-all" }), project.id], { threadId });
      expect(result.exitCode).toBe(1); expect(result.stderr).toMatch(/human dashboard|current initiative coordinator/);
    }
  });
  it("a failed transaction rolls back the entire bulk acceptance", async () => {
    const { f, project } = await projectFixture();
    const first = f.service.recordDecision(project.id, { decision: { description: "First", madeBy: "agent" } }, recorder);
    const second = f.service.recordDecision(project.id, { decision: { description: "Second", madeBy: "agent" } }, recorder);
    const update = f.store.updateDecision.bind(f.store); let count = 0;
    vi.spyOn(f.store, "updateDecision").mockImplementation((...args) => { if (++count === 2) throw new Error("Storage refused"); return update(...args); });
    await expect(f.harness.callRpc("command", { projectId: project.id, command: { action: "decision-accept-all" } })).rejects.toThrow("Storage refused");
    expect(f.store.decisionItem(project.id, first.num)).toEqual(first); expect(f.store.decisionItem(project.id, second.num)).toEqual(second);
    expect(f.send).not.toHaveBeenCalled();
  });

  it("an older Not okay send cannot reattach its receipt after a newer Okay verdict", async () => {
    const { f, project } = await projectFixture(); const d = f.service.recordDecision(project.id, { decision: { description: "Native route", madeBy: "agent" } }, recorder);
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    f.send.mockImplementationOnce(async () => { await held; return { delivery: "sent" } as never; });
    const old = f.service.reviewDecision(project.id, d.ref, "not-okay", "Change it");
    await f.service.reviewDecision(project.id, d.ref, "okay"); release(); await old;
    expect(f.store.decisionItem(project.id, d.num)).toMatchObject({ review: "okay", notification: null });
  });
});
