import { describe, expect, it } from "vitest";
import { projectFixture } from "./fake-native";
import { MAX_GUIDANCE_CHARACTERS } from "../lib/settings";
import { upgradeDecisionGuidance, DEFAULT_COORDINATOR_INSTRUCTIONS, DEFAULT_WORKER_INSTRUCTIONS } from "../lib/guidance";
const shippedParagraphs = [
  [
    "coordinator",
    "Coordinate outcomes and dispatch work; workers implement and verify. Start with bounded initiative_read after context loss. Read full briefs/reports by ref only when needed for a decision, never whole coordinator transcripts."
  ],
  [
    "coordinator",
    "Use native messages for decisions, blockers or new facts changing another agent's next action. Routine phases belong in initiative_progress or human-facing commentary. Never wake an agent solely to publish progress. Preserve genuine errors, Stop semantics, permission and ownership boundaries. Require one canonical initiative_report and a short final pointer, without a duplicate result tell before native completion. Native notifications and the report fallback for workers without a native parent remain BB/Initiative responsibilities."
  ],
  [
    "coordinator",
    "Keep tasks/follow-ups to outcome, scope, interfaces, checked revision, remaining checks and evidence. Name dependencies; overlapping writers wait or isolate. Declare access read-only per audit assignment, including continue/fork; omitted work may write. Readers may overlap readers/writers. This is coordination, not a sandbox: full permissions still forbid source/install writes on audits. Identify actual source state checked amid live edits. Reuse context for corrections and bounded handoffs at milestones; preserve useful design and checks."
  ],
  [
    "worker",
    "Use native messages when a decision, blocker or new fact changes another agent's next action. For example, tell the coordinator when a shared interface needs a decision before another worker can proceed. Routine phases such as reading files, building or starting checks belong in initiative_progress or human-facing commentary. Do not wake another agent merely to publish progress. Preserve genuine errors, Stop requests, permission and ownership boundaries."
  ],
  [
    "worker",
    "Read the brief, referenced handoff and explicit user decisions first. Use initiative_read refs and excerpts rather than whole reports or coordinator transcripts. Expand reads for specific unanswered questions. Reuse verified results with their exact revision and scope. Keep continuations to the remaining outcome, scope, necessary interfaces, checked revision, remaining checks and evidence references. Productive design exploration and verification remain useful; changed behavior or failed checks can justify repeating tests."
  ]
] as const;

describe("T59 narrow stored workflow guidance", () => {
  it.each(shippedParagraphs)("upgrades known %s wording even with a maximum-sized custom suffix", async (role, old) => {
    const suffix = "\n" + "Our custom checklist. ".repeat(250);
    const custom = (old + suffix).slice(0, MAX_GUIDANCE_CHARACTERS);
    const { f } = await projectFixture({ [role + "Instructions"]: custom });
    await f.preferences.ready;
    const key = role === "worker" ? "workerInstructions" : "coordinatorInstructions";
    const saved = (await f.preferences.handle.get())[key];
    expect(saved).not.toContain(old);
    expect(saved.endsWith(custom.slice(old.length))).toBe(true);
    expect(saved.length).toBeLessThanOrEqual(custom.length);
    expect(upgradeDecisionGuidance(saved, role, MAX_GUIDANCE_CHARACTERS)).toBe(saved);
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it("populated defaults keep questions, exact reads and native delivery alongside A102 decision rules", () => {
    for (const text of [DEFAULT_COORDINATOR_INSTRUCTIONS, DEFAULT_WORKER_INSTRUCTIONS]) {
      expect(text.length).toBeLessThanOrEqual(MAX_GUIDANCE_CHARACTERS);
      expect(text).toContain("steer");
      expect(text).toContain("question/context");
      expect(text).toContain("options/consequences");
      expect(text).toContain("recommendation");
      expect(text).toContain("non-obvious significant");
      expect(text).toContain("agent-added defaults");
    }
    expect(DEFAULT_COORDINATOR_INSTRUCTIONS).toContain("task-checkpoint");
    expect(DEFAULT_COORDINATOR_INSTRUCTIONS).toContain("reviewTargets");
    expect(DEFAULT_WORKER_INSTRUCTIONS).toContain("detailed:true");
  });
});
