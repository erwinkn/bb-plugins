import { describe, expect, it } from "vitest";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { DEFAULT_COORDINATOR_INSTRUCTIONS, DEFAULT_WORKER_INSTRUCTIONS, upgradeDecisionGuidance } from "../lib/guidance";
import { MAX_GUIDANCE_CHARACTERS } from "../lib/settings";
import { renderAssignment } from "../lib/brief";
import { projectFixture } from "./fake-native";

const oldCoordinatorParagraph = "Retirement is explicit after the native thread is idle and assignments settled. Do not resurrect stopped/cancelled work or retry unconfirmed operations without receipts or inspection. Pause holds new delegations, not running work. User-owned threads have no worker/report duties. After meaningful batches, update Initiative context and task status, close superseded tasks and publish a concise human update. Record user and agent choices with initiative_decision in one or two sentences naming who made them; record an explicit user chat answer on its open question with action answer, never inferring one. Okay is private; Not okay requires a message and notifies the coordinator.";
const oldWorkerParagraph = "When finished or blocked, submit one canonical initiative_report with outcome, concise result, meaningful check evidence and results, artifact references, a bounded handoff and linked implementation details. Record your choices separately with initiative_decision: one or two sentences, madeBy agent. Record an explicit user chat answer on its open question with initiative_decision action answer, never inferring one. Describe the result for a human who has not read the code. Name the exact workspace and verification revision, relevant/dirty files, open questions, next steps, recovery artifacts and pending commands with their state. State unverified checks and unfinished background work plainly. If blocked, include the actual question and context. Idle or a final message alone is not a report.";
const oldWorker = "Record your choices separately with initiative_decision: one or two sentences, madeBy agent. Record an explicit user chat answer on its open question with initiative_decision action answer, never inferring one.";

describe("T57 saved guidance upgrades", () => {
  it("upgrades known shipped clauses while preserving custom text and unrelated settings", async () => {
    const custom = `Use our custom deployment checklist.\n${oldWorker}\nKeep our release notes.`;
    const { f, project } = await projectFixture({ workerInstructions: custom, coordinatorInstructions: "My own coordinator workflow" });
    await f.preferences.ready;
    const saved = await f.preferences.handle.get();
    expect(saved.workerInstructions).toContain("custom deployment checklist");
    expect(saved.workerInstructions).toContain("Keep our release notes.");
    expect(saved.workerInstructions).toMatch(/significant independent non-obvious forks/i);
    expect(saved.workerInstructions).toContain("user choices use madeBy user");
    expect(saved.workerInstructions).toContain("Notify the coordinator unless notify false");
    expect(saved.workerInstructions).not.toContain("Record your choices separately");
    expect(saved.coordinatorInstructions).toBe("My own coordinator workflow");
    const again = upgradeDecisionGuidance(saved.workerInstructions, "worker", MAX_GUIDANCE_CHARACTERS);
    expect(again).toBe(saved.workerInstructions);
    const [worker] = await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id).ref] });
    const config = await f.harness.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: f.threads.get(worker.threadId!)! }));
    expect(config.instructions).toContain(saved.workerInstructions);
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("keeps custom instructions without known clauses byte-for-byte and defaults within native limits", async () => {
    const { f } = await projectFixture({ workerInstructions: "Custom wording without shipped clauses", coordinatorInstructions: "Custom coordinator" });
    await f.preferences.ready;
    expect((await f.preferences.handle.get()).workerInstructions).toBe("Custom wording without shipped clauses");
    for (const instructions of [DEFAULT_COORDINATOR_INSTRUCTIONS, DEFAULT_WORKER_INSTRUCTIONS]) {
      expect(instructions.length).toBeLessThanOrEqual(MAX_GUIDANCE_CHARACTERS);
      expect(instructions).toMatch(/non-obvious/);
      expect(instructions).toMatch(/normal steps, checks, restatements, mandated/i);
      expect(instructions).toMatch(/explicit user choices madeBy user|user for explicit user chat choices/i);
    }
    expect(f.send).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it.each(["coordinator", "worker"] as const)("upgrades a maximum-sized saved %s paragraph without losing custom additions", async role => {
    const old = role === "coordinator" ? oldCoordinatorParagraph : oldWorkerParagraph;
    const custom = `${old}\n${"Custom checks. ".repeat(300)}`.slice(0, MAX_GUIDANCE_CHARACTERS);
    const { f } = await projectFixture({ [role + "Instructions"]: custom });
    await f.preferences.ready;
    const saved = (await f.preferences.handle.get())[role === "coordinator" ? "coordinatorInstructions" : "workerInstructions"];
    expect(saved).not.toContain(old);
    expect(saved.endsWith(custom.slice(old.length))).toBe(true);
    expect(saved).toContain("audit/review setup and requested clean SHA/execution settings");
    expect(saved).toContain("agent-added defaults");
    expect(saved.length).toBeLessThanOrEqual(custom.length);
    expect(upgradeDecisionGuidance(saved, role, MAX_GUIDANCE_CHARACTERS)).toBe(saved);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.stop).not.toHaveBeenCalled();
  });

  it("keeps the attribution and significance rules in assignment text independently of custom Settings", async () => {
    const { f, project } = await projectFixture({ workerInstructions: "My custom audit workflow." });
    const task = f.task(project.id);
    const [worker] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
    const config = await f.harness.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: f.threads.get(worker.threadId!)! }));
    expect(config.instructions).toContain("My custom audit workflow.");
    const fresh = f.spawn.mock.calls.at(-1)![0].prompt;
    // Both new and retained-context assignments use this same renderer.
    const retained = renderAssignment({ project: { name: "Test" }, workerLabel: "Audit", workerPurpose: "Check", workerRef: "W1", assignmentRef: "A2", role: "review", tasks: [], reviewOf: [], note: null, opId: "op_test", guidance: "Custom review", access: "read-only" });
    for (const prompt of [fresh, retained]) {
      expect(prompt).toContain("Require explicit madeBy");
      expect(prompt).toContain("audit/review setup or requested clean SHA/execution settings");
      expect(prompt).toContain("excluding any agent-added defaults");
      expect(prompt).not.toContain("Record your own short choices");
      expect(prompt).not.toContain("The coordinator records explicit user choices");
    }
    const description = f.harness.registrations.agentTools.find(t => t.name === "initiative_decision")!.description;
    expect(description).toContain("Choose madeBy explicitly");
    expect(description).toContain("agent-added defaults");
    expect(description).toContain("audit/review setup and requested clean SHA/execution settings");
    expect(f.harness.registrations.cli!.commands!.find(c => c.name === "command")!.summary).toContain("Decisions require madeBy");
  });

});
