import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectFixture } from "./fake-native";

// Real coordinator payloads from A172 (Solera, Marbre, Equisafe, Coffre, bb-plugins), each now
// either recorded as intended or refused with an actionable example. Nothing is inferred.
type Fixture = Awaited<ReturnType<typeof projectFixture>>["f"];
const coordinator = { author: "coordinator" as const, threadId: "coordinator", assignment: null };
const tool = (f: Fixture, input: unknown, threadId = "coordinator") =>
  f.harness.callAgentTool("initiative_decision", input, { threadId }).then(r => JSON.parse(r as string));
const cli = (f: Fixture, input: unknown, threadId = "coordinator", projectId?: string) =>
  f.harness.runCli(["command", JSON.stringify(input), ...(projectId ? [projectId] : [])], { threadId });
const refused = (f: Fixture, input: unknown, threadId = "coordinator") =>
  f.harness.callAgentTool("initiative_decision", input, { threadId }).then(() => "", (e: Error) => e.message);
const options = [
  { label: "(a) removal", consequences: "A re-add at the same version is never redelivered." },
  { label: "(c) retryable", consequences: "Correct and visible; waits for the next commit." },
];

// BB's Claude Code bridge advertises only object roots; anything else becomes {type:"object"}.
const INSTALLED_BRIDGE = join(homedir(), ".npm-global/lib/node_modules/bb-app/server/dist/builtin-plugins/provider-claude-code/dist/host.js");
function claudeNormalize(): (schema: unknown) => any {
  if (existsSync(INSTALLED_BRIDGE)) {
    const source = readFileSync(INSTALLED_BRIDGE, "utf8").match(/function normalizeInputSchema\(inputSchema\) \{[\s\S]*?\n\}/)?.[0];
    if (source) return new Function(`${source}; return normalizeInputSchema;`)();
  }
  return (s: any) => s !== null && typeof s === "object" && !Array.isArray(s) && s.type === "object" ? s : { type: "object" };
}

describe("T85 Claude receives meaningful initiative_decision parameters", () => {
  it("publishes one object root with an action enum and visible canonical fields that survive Claude normalization", async () => {
    const { f } = await projectFixture();
    const record = f.harness.registrations.agentTools.find(t => t.name === "initiative_decision")! as { inputSchema: any };
    const schema = record.inputSchema;
    expect(schema.type).toBe("object");
    for (const key of ["oneOf", "anyOf", "allOf"]) expect(schema[key]).toBeUndefined();
    expect(schema.properties.action.enum).toEqual(expect.arrayContaining(["user-choice", "veto-request", "question", "answer", "withdraw"]));
    for (const field of ["description", "madeBy", "question", "context", "options", "recommendation", "blocksTaskIds", "title", "ref", "choice", "note", "notify", "reason", "topic", "scope", "supersedes"])
      expect(Object.keys(schema.properties)).toContain(field);
    expect(schema.properties.madeBy.enum).toEqual(["user", "agent"]);
    expect(schema.required).toEqual(["action"]);
    const advertised = claudeNormalize()(schema);
    expect(advertised).toBe(schema);
    expect(advertised.properties.action.enum).toContain("question");
  });
});

describe("T85 questions: question + context is enough", () => {
  it("records a minimal canonical question as an open user choice, titled from the question, through tool and CLI", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id);
    const asked = await tool(f, { action: "question", question: "Where is the Monolith repo?", context: "It is not under ~/Code.", blocksTaskIds: [task.ref] });
    expect(asked).toMatchObject({ madeBy: null, status: "active" });
    const item = f.store.decisionItem(project.id, Number(asked.ref.slice(1)))!;
    expect(item).toMatchObject({ title: "Where is the Monolith repo?", humanAttention: "needs-opinion", madeBy: null });
    // v9: a question no longer blocks a task; its status follows its work.
    expect(f.store.task(project.id, task.num)?.status).toBe("planned");
    const viaCli = await cli(f, { action: "question", question: "Run CI on PRs?", context: "Costs Actions minutes.", options: ["Yes", { label: "No" }] }, "coordinator", project.id);
    expect(viaCli.exitCode).toBe(0);
    const second = f.store.decisions(project.id).find(d => d.title === "Run CI on PRs?")!;
    expect((second.body as { options: unknown }).options).toEqual([{ label: "Yes", consequences: "" }, { label: "No", consequences: "" }]);
  });

  it("bounds a long default title and keeps the full question", async () => {
    const { f, project } = await projectFixture();
    const question = `Should ${"the engine ".repeat(40)}space woken ticks?`;
    const asked = await tool(f, { action: "question", question, context: "Hot-loop insurance." });
    const item = f.store.decisionItem(project.id, Number(asked.ref.slice(1)))!;
    expect(item.title.length).toBeLessThanOrEqual(200);
    expect((item.body as { question: string }).question).toBe(question);
  });

  it("a nested question without humanAttention is an open question, not a taken decision", async () => {
    const { f, project } = await projectFixture();
    const asked = await tool(f, { action: "question", question: { title: "Monolith trial", question: "Where is the Monolith repo?", context: "Not found.", options, recommendation: "(c) retryable", blocksTaskIds: [f.task(project.id).ref] } });
    expect(asked).toMatchObject({ madeBy: null, status: "active" });
  });

  it("Solera 23751 / Equisafe 7396: a taken-decision-shaped question is refused with a question example, never redirected to an agent decision", async () => {
    const { f, project } = await projectFixture();
    const message = await refused(f, { action: "question", question: { title: "F33", question: "Which?", context: "Missing row.", options, outcome: "Proposed, pending Erwin: (c)", rationale: "Trace loses k1." } });
    expect(message).toMatch(/outcome/);
    expect(message).toMatch(/recommendation/);
    expect(message).toContain('"action":"question"');
    expect(message).not.toMatch(/decision action|"action":"decision"/);
    expect(f.store.decisions(project.id)).toHaveLength(0);
    const flat = await refused(f, { action: "question", question: "Which?", context: "Missing row.", outcome: "Proposed: (c)" });
    expect(flat).toMatch(/outcome/);
    expect(flat).toContain('"action":"question"');
  });

  it("Marbre 10429/10463: guessed or legacy non-question humanAttention values get a corrective example", async () => {
    const { f, project } = await projectFixture();
    for (const humanAttention of ["needs-review", "needs-action", "second-pass", "none"]) {
      const message = await refused(f, { action: "question", question: { title: "Borders", humanAttention, question: "Should borders take space?", context: "Craie paints only." } });
      expect(message).toMatch(/humanAttention/);
      expect(message).toContain('"action":"question"');
    }
    expect(f.store.decisions(project.id)).toHaveLength(0);
  });

  it("Equisafe 7390 / Solera 23731: option description/consequence keys name consequences and show an example", async () => {
    const { f, project } = await projectFixture();
    for (const key of ["description", "consequence"]) {
      const message = await refused(f, { action: "question", question: "Approve two CI runs?", context: "About two full runs.", options: [{ label: "Approve", [key]: "Run both" }] });
      expect(message).toMatch(/consequences/);
      expect(message).toContain('"action":"question"');
    }
    expect(f.store.decisions(project.id)).toHaveLength(0);
  });

  it("Solera 23739 (exact): a title-only question is refused with a useful error; the title is never used as the question", async () => {
    const { f, project } = await projectFixture();
    const real = { action: "question", question: { title: "Monolith trial: where it lives, and what 'usable' means", context: "Erwin wants Solera usable for Monolith by the morning. The coordinator couldn't find a Monolith repo on the server (~/Code has red-metal, not monolith) and doesn't know which parts must run: the asset pipeline, which stores (Postgres, S3/Railway buckets), deployed on Railway or run locally first.", options: [{ label: "Point the coordinator at the repo and the target pipeline", consequences: "A worker maps Monolith's needs against Solera and closes the gaps." }, { label: "Start with a local run of a small Monolith slice", consequences: "Fastest path to a first trial; Railway deployment follows." }], recommendation: "Give the repo location and one pipeline to port first; the coordinator then launches a readiness worker that maps gaps and ports that slice.", blocksTaskIds: [] } };
    const message = await refused(f, real);
    expect(message).toMatch(/question is required/);
    expect(message).toMatch(/title is only a short label/);
    expect(message).toContain('"action":"question"');
    expect(f.store.decisions(project.id)).toHaveLength(0);
  });

  it("error text has single punctuation between the issue and the example", async () => {
    const { f } = await projectFixture();
    const message = await refused(f, { action: "question", question: { title: "Scope", humanAttention: "needs-opinion", question: "Include archives?" } });
    expect(message).toMatch(/context: Explain the context in plain words\. Example:/);
    expect(message).not.toMatch(/\.\./);
  });

  it("keeps valid legacy needs-opinion payloads with their old optional fields", async () => {
    const { f, project } = await projectFixture();
    const legacy = { title: "Sign-off", humanAttention: "needs-opinion", question: "Who signs off?", context: "Native check.", options, recommendation: "Erwin", outcome: "Proposed: Erwin", rationale: "Has the machine.", tradeoff: "Slower", deadline: "2026-10-05T08:00:00Z" };
    const asked = await tool(f, { action: "question", question: legacy });
    const item = f.store.decisionItem(project.id, Number(asked.ref.slice(1)))!;
    expect(item.body).toMatchObject({ outcome: "Proposed: Erwin", rationale: "Has the machine.", tradeoff: "Slower" });
    // Needs-opinion records display their question, not a proposed outcome (D56/D60).
    expect(item.description).toBe("Who signs off?");
    const read = await f.harness.callAgentTool("initiative_read", { refs: [asked.ref] }, { threadId: "coordinator" });
    expect(JSON.parse(read as string).items[0].description).toBe("Who signs off?");
  });

  it("still lets only coordinators ask", async () => {
    const { f, project } = await projectFixture();
    const [worker] = await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id).ref] });
    expect(await refused(f, { action: "question", question: "Q?", context: "C" }, worker.threadId!)).toMatch(/through your lead/);
  });
});


describe("T85 answers and cleanup", () => {
  async function question() {
    const { f, project } = await projectFixture();
    const q = f.service.recordQuestion(project.id, { title: "F33", humanAttention: "needs-opinion", question: "Which?", context: "c", options }, coordinator);
    return { f, project, q };
  }

  it("answers with ref or legacy decision target; conflicting targets are refused", async () => {
    const { f, project, q } = await question();
    expect(await refused(f, { action: "answer", ref: q.ref, decision: "D99", choice: "(c) retryable" })).toMatch(/ref/);
    expect(await tool(f, { action: "answer", ref: q.ref, choice: "(c) retryable", note: "Erwin said so." })).toMatchObject({ status: "answered", madeBy: "user" });
    const other = f.service.recordQuestion(project.id, { title: "Scope", humanAttention: "needs-opinion", question: "Include archives?", context: "Large." }, coordinator);
    expect(await tool(f, { action: "answer", decision: other.ref, choice: null, note: "Yes." })).toMatchObject({ status: "answered" });
    expect(f.send).not.toHaveBeenCalled();
  });

  it("Solera 12138: identical re-answer of a panel answer stays idempotent; a different one is refused", async () => {
    const { f, project, q } = await question();
    await f.service.answerOpinion(project.id, q.ref, { choice: "(c) retryable", note: "" });
    expect(await tool(f, { action: "answer", ref: q.ref, choice: "(c) retryable" })).toMatchObject({ status: "answered", madeBy: "user" });
    const message = await refused(f, { action: "answer", ref: q.ref, choice: "(a) removal" });
    expect(message).toMatch(/not an open question/);
    expect(message).toMatch(/already answered; the recorded answer stands/);
    expect(message).not.toMatch(/different answer/);
    expect((f.store.decisionItem(project.id, q.num)!.body as { answer: { choice: string } }).answer.choice).toBe("(c) retryable");
  });


});

