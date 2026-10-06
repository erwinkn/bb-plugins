import { describe, expect, it } from "vitest";
import { projectFixture, report } from "./fake-native";
import { DECISION_LOG_GUIDANCE_UPGRADES, DEFAULT_COORDINATOR_INSTRUCTIONS, DEFAULT_WORKER_INSTRUCTIONS, upgradeDecisionGuidance } from "../lib/guidance";
import { MAX_GUIDANCE_CHARACTERS } from "../lib/settings";

// T135 (D402): the decision log is the user's steering record. Agents write it but nothing
// feeds it back into their context: briefs, handoffs, guidance and tool descriptions.
const recorder = { author: "coordinator" as const, threadId: "coordinator", assignment: null };
const current = { coordinator: DEFAULT_COORDINATOR_INSTRUCTIONS, worker: DEFAULT_WORKER_INSTRUCTIONS };
/** The defaults shipped just before T135. */
const previous = (role: "coordinator" | "worker") =>
  [...DECISION_LOG_GUIDANCE_UPGRADES[role]].reverse().reduce<string>((t, [old, next]) => t.replace(next, old), current[role]);

describe("T135 agents never receive the decision log", () => {
  it("fresh, continued and forked briefs carry no decision list, even with active decisions", async () => {
    const { f, project } = await projectFixture();
    f.service.recordDecision(project.id, { decision: { description: "Erwin chose Linux for every host", madeBy: "user" } }, recorder);
    f.service.recordDecision(project.id, { decision: { description: "Keep native dispatch everywhere", madeBy: "agent" } }, recorder);
    const t1 = f.task(project.id, "First");
    const [w] = await f.service.delegate(project.id, { route: "fresh", tasks: [t1.ref] });
    const fresh = f.spawn.mock.calls.at(-1)![0].prompt as string;
    await f.service.report(w.threadId!, report() as never);
    f.idle(w.threadId!);
    await f.service.delegate(project.id, { route: "continue", worker: "W1", tasks: [f.task(project.id, "Second").ref] });
    const continued = f.send.mock.calls.at(-1)![0].input[0].text as string;
    await f.service.delegate(project.id, { route: "fork", worker: "W1", tasks: [f.task(project.id, "Third").ref], forkAtSeq: 1 });
    const fork = f.fork.mock.calls[0]![0].input[0].text as string;
    for (const text of [fresh, continued, fork]) {
      expect(text).not.toContain("Relevant decisions");
      expect(text).not.toMatch(/Erwin chose Linux|Keep native dispatch/);
    }
    expect(fresh).toContain("never consult the decision log for your own work");
    expect(fresh).not.toContain('"D#"');
  });

  it("the overview counts unchecked agent decisions by ref without their bodies and keeps open questions", async () => {
    const { f, project } = await projectFixture();
    const agent = f.service.recordDecision(project.id, { decision: { description: "Keep native dispatch everywhere", madeBy: "agent" } }, recorder);
    f.service.recordQuestion(project.id, { title: "Scope", question: "Include archives?", context: "Need scope", humanAttention: "needs-opinion" }, recorder);
    const raw = await f.harness.callAgentTool("initiative_read", {}, { threadId: "coordinator" }) as string;
    const overview = JSON.parse(raw);
    expect(overview.counts).toMatchObject({ questions: 1, uncheckedAgentDecisions: 1 });
    expect(overview.humanAttention.uncheckedAgentDecisions).toEqual([agent.ref]);
    expect(overview.humanAttention.questions[0].question).toBe("Include archives?");
    expect(raw).not.toContain("Keep native dispatch");
    // The explicit decisions view stays available for the dashboard and deliberate lookups.
    const read = JSON.parse(await f.harness.callAgentTool("initiative_read", { refs: [agent.ref], detailed: true }, { threadId: "coordinator" }) as string);
    expect(read.items[0].description).toBe("Keep native dispatch everywhere");
  });

  it("tool descriptions record decisions for the user and stop advertising decision reads", async () => {
    const { f } = await projectFixture();
    const tools = f.harness.registrations.agentTools;
    const decision = tools.find(t => t.name === "initiative_decision")!.description;
    const read = tools.find(t => t.name === "initiative_read")!.description;
    expect(decision).toContain("never consult it for your own work");
    expect(read).not.toContain("D12");
    expect(read).not.toMatch(/artifacts, decisions/);
  });
});

describe("T135 guidance", () => {
  it("defaults drop 'read decisions' advice, say to record for the user, and fit the bound", () => {
    for (const text of Object.values(current)) {
      expect(text).not.toMatch(/explicit user decisions first|read (the )?decisions/i);
      expect(text).toMatch(/never consult/);
      expect(text.length).toBeLessThanOrEqual(MAX_GUIDANCE_CHARACTERS);
    }
    expect(DEFAULT_COORDINATOR_INSTRUCTIONS).toContain("put needed user instructions in briefs");
    expect(DEFAULT_WORKER_INSTRUCTIONS).toContain("Read the brief/handoff first. Decisions record significant choices for the user");
  });

  it.each(["coordinator", "worker"] as const)("upgrades the saved %s default once, idempotently", role => {
    const old = previous(role);
    expect(old).not.toBe(current[role]);
    const once = upgradeDecisionGuidance(old, role, MAX_GUIDANCE_CHARACTERS);
    expect(once).toBe(current[role]);
    expect(upgradeDecisionGuidance(once, role, MAX_GUIDANCE_CHARACTERS)).toBe(once);
    for (const [before, after] of DECISION_LOG_GUIDANCE_UPGRADES[role]) expect(after).not.toContain(before);
  });

  it.each(["coordinator", "worker"] as const)("keeps custom %s text around the rewritten clauses", role => {
    const custom = `Our checklist first.\n${previous(role)}\nShip notes last.`;
    const upgraded = upgradeDecisionGuidance(custom, role, MAX_GUIDANCE_CHARACTERS + 100);
    expect(upgraded).toBe(`Our checklist first.\n${current[role]}\nShip notes last.`);
  });

  it("loads saved old worker guidance upgraded, keeping custom text", async () => {
    const { f } = await projectFixture({ workerInstructions: "Custom start. Read the brief/handoff and explicit user decisions first. Custom end." });
    await f.preferences.ready;
    expect((await f.preferences.handle.get()).workerInstructions).toBe(
      "Custom start. Read the brief/handoff first. Decisions record significant choices for the user; never consult the decision log for your own work. Custom end.");
  });
});
