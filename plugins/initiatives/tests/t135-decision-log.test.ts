import { describe, expect, it } from "vitest";
import { projectFixture, report } from "./fake-native";
import { DEFAULT_COORDINATOR_INSTRUCTIONS, DEFAULT_WORKER_INSTRUCTIONS } from "../lib/guidance";

// T135 (D402): the decision log is the user's steering record. Agents write it but nothing
// feeds it back into their context: briefs, handoffs, instructions and tool descriptions.
const recorder = { author: "coordinator" as const, threadId: "coordinator", assignment: null };

describe("T135 agents never receive the decision log", () => {
  it("spawn and work-message briefs carry no decision list, even with active decisions", async () => {
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
    for (const text of [fresh, continued]) {
      expect(text).not.toContain("Relevant decisions");
      expect(text).not.toMatch(/Erwin chose Linux|Keep native dispatch|D\d/);
    }
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

  it("tool descriptions and instructions record decisions for the user and never point agents at the log", async () => {
    const { f } = await projectFixture();
    const tools = f.harness.registrations.agentTools;
    const decision = tools.find(t => t.name === "initiative_decision")!.description;
    const read = tools.find(t => t.name === "initiative_read")!.description;
    expect(decision).toContain("never consult the log for your own work");
    expect(read).not.toMatch(/D12|decisions/);
    for (const text of [DEFAULT_COORDINATOR_INSTRUCTIONS, DEFAULT_WORKER_INSTRUCTIONS]) expect(text).not.toMatch(/read (the )?decisions|decisions first/i);
    expect(DEFAULT_COORDINATOR_INSTRUCTIONS).toContain("The decision log is the user's record; don't consult it to plan.");
  });
});
