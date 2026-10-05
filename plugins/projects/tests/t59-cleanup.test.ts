import { describe, expect, it } from "vitest";
import { projectFixture } from "./fake-native";
import { commandSchema, parseCommandInput } from "../lib/commands";
import { DEFAULT_COORDINATOR_INSTRUCTIONS, upgradeDecisionGuidance } from "../lib/guidance";

const recorder = { author: "coordinator" as const, threadId: "coordinator", assignment: null };
const cleanup = (decision: string, operation: "accept" | "veto" | "remove") => ({ action: "decision-cleanup", decision, operation, reason: "Erwin requested scoped cleanup of routine steps." });
async function choices() {
  const { f, project } = await projectFixture();
  const agent = f.service.recordDecision(project.id, { decision: { description: "Keep native dispatch", madeBy: "agent" } }, recorder);
  const user = f.service.recordDecision(project.id, { decision: { description: "Erwin chose Linux", madeBy: "user" } }, recorder);
  const question = f.service.recordQuestion(project.id, { title: "Scope", question: "Include archives?", context: "Need scope", humanAttention: "needs-opinion" }, recorder);
  return { f, project, agent, user, question };
}

describe("T59 explicitly requested coordinator decision cleanup", () => {
  it("accepts and vetoes through existing verdicts, preserves ownership and records cleanup without self-notifying", async () => {
    const { f, project, agent } = await choices();
    const accepted = JSON.parse(await f.harness.callAgentTool("initiative_decision", cleanup(agent.ref, "accept"), { threadId: "coordinator" }) as string);
    expect(accepted).toMatchObject({ ref: agent.ref, madeBy: "agent", review: "okay", recordedBy: recorder });
    const veto = await f.harness.runCli(["command", JSON.stringify(cleanup(agent.ref, "veto")), project.id], { threadId: "coordinator" });
    expect(veto.exitCode).toBe(0);
    const result = f.store.decisionItem(project.id, agent.num)!;
    expect(result).toMatchObject({ review: "not-okay", reviewMessage: cleanup(agent.ref, "veto").reason, notification: null, provenance: agent.provenance, madeBy: "agent" });
    expect(result.body.cleanupHistory?.map(c => c.operation)).toEqual(["accept", "veto"]);
    expect(result.body.cleanupHistory?.every(c => c.recordedBy === "coordinator" && c.reason)).toBe(true);
    expect(f.send).not.toHaveBeenCalled();
  });

  it("removes active attention while retaining detailed history/provenance and any uncertain native receipt", async () => {
    const { f, project, agent } = await choices();
    const receipt = { state: "uncertain" as const, op: "old-review", coordinatorThreadId: "coordinator", detail: "Lost native reply" };
    f.store.updateDecision(project.id, agent.num, { notification: receipt });
    const command = cleanup(agent.ref, "remove");
    await f.harness.callAgentTool("initiative_decision", command, { threadId: "coordinator" });
    await f.harness.callAgentTool("initiative_decision", command, { threadId: "coordinator" });
    expect(f.store.decisions(project.id).map(d => d.ref)).not.toContain(agent.ref);
    const history = JSON.parse(await f.harness.callAgentTool("initiative_read", { refs: [agent.ref], detailed: true }, { threadId: "coordinator" }) as string);
    expect(history.items[0]).toMatchObject({ status: "removed", madeBy: "agent", description: agent.description, recordedBy: agent.provenance, notification: receipt, body: { cleanupHistory: [{ operation: "remove", recordedBy: "coordinator", reason: command.reason }] } });
    const overview = JSON.parse(await f.harness.callAgentTool("initiative_read", {}, { threadId: "coordinator" }) as string);
    expect(overview.counts.uncheckedAgentDecisions).toBe(0);
    const dashboard = await f.overview(project.id);
    expect(dashboard.decisions.map(d => d.ref)).not.toContain(agent.ref);
    expect(dashboard.revisit.map(d => d.ref)).not.toContain(agent.ref);
    expect(f.send).not.toHaveBeenCalled();
    const denied = await f.harness.runCli(["command", JSON.stringify(cleanup(agent.ref, "accept")), project.id], { threadId: "coordinator" });
    expect(denied.exitCode).toBe(1);
  });

  it("protects user choices, open and answered questions and rejects a missing reason", async () => {
    const { f, project, user, question } = await choices();
    for (const ref of [user.ref, question.ref]) await expect(f.harness.callAgentTool("initiative_decision", cleanup(ref, "remove"), { threadId: "coordinator" })).rejects.toThrow(/protected/);
    await f.service.answerOpinion(project.id, question.ref, { choice: null, note: "Yes", notify: false });
    await expect(f.harness.callAgentTool("initiative_decision", cleanup(question.ref, "remove"), { threadId: "coordinator" })).rejects.toThrow(/protected/);
    expect(commandSchema.safeParse({ ...cleanup(user.ref, "veto"), reason: " " }).success).toBe(false);
    expect(f.send).not.toHaveBeenCalled();
  });

  it("denies workers, retired workers, ad-hoc, former and foreign coordinators through real tool/CLI handlers", async () => {
    const { f, project, agent } = await choices();
    const [worker] = await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id).ref] });
    const command = cleanup(agent.ref, "remove");
    await expect(f.harness.callAgentTool("initiative_decision", command, { threadId: worker.threadId! })).rejects.toThrow(/current coordinator/);
    expect((await f.harness.runCli(["command", JSON.stringify(command), project.id], { threadId: worker.threadId! })).exitCode).toBe(1);
    f.store.db.prepare("UPDATE workers SET state='retired' WHERE thread_id=?").run(worker.threadId);
    await expect(f.harness.callAgentTool("initiative_decision", command, { threadId: worker.threadId! })).rejects.toThrow(/current/);
    await expect(f.harness.callAgentTool("initiative_decision", command, { threadId: "foreign" })).rejects.toThrow();
    f.store.db.prepare("INSERT INTO project_nested_threads (project_id,thread_id,label,bb_project_id,created_at) VALUES(?,?,?,?,?)").run(project.id, "user-chat", "User chat", "proj_a", Date.now());
    await expect(f.harness.callAgentTool("initiative_decision", command, { threadId: "user-chat" })).rejects.toThrow(/current/);
    expect((await f.harness.runCli(["command", JSON.stringify(command), project.id], { threadId: "user-chat" })).exitCode).toBe(1);
    f.store.db.prepare("UPDATE projects SET coordinator_thread_id='replacement' WHERE id=?").run(project.id);
    await expect(f.harness.callAgentTool("initiative_decision", command, { threadId: "coordinator" })).rejects.toThrow(/current/);
    expect((await f.harness.runCli(["command", JSON.stringify(command), project.id], { threadId: "coordinator" })).exitCode).toBe(1);
    expect(f.store.decisionItem(project.id, agent.num)?.status).toBe("active");
    expect(f.send).not.toHaveBeenCalled();
  });

  it("rejects threadless cleanup and foreign Initiative CLI targets; dashboard review still messages normally", async () => {
    const { f, project, agent } = await choices();
    const command = cleanup(agent.ref, "remove");
    await expect(f.harness.callRpc("command", { projectId: project.id, command })).rejects.toThrow(/current coordinator/);
    const other = f.store.createProject({ id: "other-initiative", name: "Other", objective: "Isolation", memberProjectIds: ["proj_a"], policy: project.policy, coordinatorThreadId: null });
    expect((await f.harness.runCli(["command", JSON.stringify(command), other.id], { threadId: "coordinator" })).exitCode).toBe(1);
    await f.harness.callRpc("command", { projectId: project.id, command: { action: "decision-review", decision: agent.ref, verdict: "not-okay", message: "Use the other design" } });
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0][0]).toMatchObject({ mode: "steer-if-active", threadId: "coordinator" });
    expect(f.store.decisionItem(project.id, agent.num)?.body.cleanupHistory).toBeUndefined();
  });

  it("makes the explicit-user-request boundary discoverable without resetting custom instructions", async () => {
    expect(DEFAULT_COORDINATOR_INSTRUCTIONS).toContain("Explicit user-requested decision-cleanup only");
    const { f } = await projectFixture();
    const example = await f.harness.runCli(["describe", "decision-cleanup"], { threadId: "coordinator" });
    expect(() => parseCommandInput(JSON.parse(example.stdout!))).not.toThrow();
    const custom = "Our custom workflow, do not rewrite it.";
    expect(upgradeDecisionGuidance(custom, "coordinator", 3584)).toBe(custom);
  });
});
