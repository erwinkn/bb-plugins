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
    expect(schema.properties.action.enum).toEqual(expect.arrayContaining(["decision", "question", "answer", "cleanup"]));
    for (const field of ["description", "madeBy", "question", "context", "options", "recommendation", "blocksTaskIds", "title", "ref", "choice", "note", "notify", "operation", "reason", "topic", "scope", "supersedes"])
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
    expect(asked).toMatchObject({ madeBy: null, status: "active", description: "Where is the Monolith repo?" });
    const item = f.store.decisionItem(project.id, Number(asked.ref.slice(1)))!;
    expect(item).toMatchObject({ title: "Where is the Monolith repo?", humanAttention: "needs-opinion", madeBy: null });
    expect(f.store.task(project.id, task.num)?.status).toBe("blocked");
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
    expect(asked.description).toBe("Who signs off?");
    expect(item.description).toBe("Who signs off?");
    const read = await f.harness.callAgentTool("initiative_read", { refs: [asked.ref] }, { threadId: "coordinator" });
    expect(JSON.parse(read as string).items[0].description).toBe("Who signs off?");
  });

  it("still lets only coordinators ask", async () => {
    const { f, project } = await projectFixture();
    const [worker] = await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id).ref] });
    expect(await refused(f, { action: "question", question: "Q?", context: "C" }, worker.threadId!)).toMatch(/through the coordinator/);
  });
});

describe("T85 decisions: explicit owner, flat fields, legacy nesting", () => {
  it("records flat and nested choices; agreeing duplicates are fine, conflicts and missing owners are refused", async () => {
    const { f, project } = await projectFixture();
    expect(await tool(f, { action: "decision", madeBy: "user", description: "Erwin chose Base UI." })).toMatchObject({ madeBy: "user", status: "active" });
    // bb-plugins 17390: madeBy repeated at top level with the same value.
    const d = await tool(f, { action: "decision", madeBy: "user", decision: { madeBy: "user", description: "Accept, not delete." }, topic: "Bulk" });
    expect(d).toMatchObject({ madeBy: "user" });
    // Solera 11767: supersedes written inside the nested object.
    expect(await tool(f, { action: "decision", decision: { madeBy: "user", description: "Accept quietly.", supersedes: d.ref } })).toMatchObject({ madeBy: "user" });
    const before = f.store.decisions(project.id).length;
    const conflict = await refused(f, { action: "decision", madeBy: "agent", decision: { madeBy: "user", description: "X" } });
    expect(conflict).toMatch(/madeBy/);
    // Solera 19369: no owner is never defaulted.
    const missing = await refused(f, { action: "decision", description: "Vocabulary for the observed-set model." });
    expect(missing).toMatch(/madeBy/);
    expect(missing).toContain('"action":"decision"');
    expect(f.store.decisions(project.id)).toHaveLength(before);
  });

  it("Solera 14213 (exact): an approval-shaped decision is refused with the coordinator question path, through tool and CLI, writing nothing", async () => {
    const { f, project } = await projectFixture();
    const real = { action: "decision", decision: { description: "Naming, needs Erwin (coordinator's proposal): keep concurrency= on @asset (at most N partitions run at once, across runs; 7645ab8). Rename the per-key input's concurrency=16 (keys of one batch processed in parallel) to parallel=. Rename the sensor 'tick claim', which isn't a claim, to 'in-flight tick', matching the code's status 'ticking'. Reason: one name per concept.", review: "needs-opinion" } };
    const activity = f.store.activity(project.id).length;
    const message = await refused(f, real);
    expect(message).toMatch(/If the user still has to choose/);
    expect(message).toMatch(/coordinator asks with action question/);
    expect(message).toContain('"action":"question"');
    // A taken significant agent choice that merely awaits review stays possible, conditionally phrased.
    expect(message).toMatch(/already made .* awaits the user's review/);
    expect(message).not.toMatch(/"madeBy":"user"/);
    const viaCli = await cli(f, real, "coordinator", project.id);
    expect(viaCli.exitCode).toBe(1);
    expect(viaCli.stderr).toBe(message);
    expect(f.store.decisions(project.id)).toHaveLength(0);
    expect(f.store.activity(project.id)).toHaveLength(activity);
  });

  it("question-only fields on a decision, flat or nested, get the same conditional question guidance", async () => {
    const { f, project } = await projectFixture();
    const signals: Record<string, unknown>[] = [
      { humanAttention: "needs-opinion" }, { humanAttention: "second-pass" }, { question: "Rename concurrency=?" }, { context: "Two knobs." },
      { options: ["Rename", "Keep"] }, { recommendation: "Rename" }, { blocksTaskIds: ["T1"] }, { review: "needs-opinion" },
    ];
    for (const signal of signals) for (const input of [
      { action: "decision", madeBy: "agent", description: "Rename concurrency= to parallel=.", ...signal },
      { action: "decision", decision: { madeBy: "agent", description: "Rename concurrency= to parallel=.", ...signal } },
    ]) {
      const message = await refused(f, input);
      expect(message, JSON.stringify(input)).toMatch(/If the user still has to choose/);
      expect(message).toContain('"action":"question"');
    }
    // Other unknown fields alongside are still named; conflicts and owner rules are unchanged.
    expect(await refused(f, { action: "decision", madeBy: "agent", description: "X", humanAttention: "second-pass", rationale: "Y" })).toMatch(/"rationale"/);
    expect(await refused(f, { action: "decision", madeBy: "agent", decision: { madeBy: "user", description: "X", review: "needs-opinion" } })).toMatch(/Conflicting madeBy/);
    expect(f.store.decisions(project.id)).toHaveLength(0);
  });

  it("negative controls: legitimate choices still record, and an unrelated review value is an ordinary unknown field", async () => {
    const { f } = await projectFixture();
    expect(await tool(f, { action: "decision", madeBy: "agent", description: "Rename concurrency= to parallel=.", topic: "Naming" })).toMatchObject({ madeBy: "agent", review: "pending" });
    expect(await tool(f, { action: "decision", decision: { madeBy: "user", description: "Erwin chose parallel=." } })).toMatchObject({ madeBy: "user" });
    const other = await refused(f, { action: "decision", madeBy: "agent", description: "X", review: "okay" });
    expect(other).toMatch(/Unknown field "review"/);
    expect(other).not.toMatch(/If the user still has to choose/);
  });

  it("Coffre 32460 / Solera 13804 / Solera 11753: guessed actions and fields are refused with an example", async () => {
    const { f, project } = await projectFixture();
    const record = await refused(f, { action: "record", madeBy: "user", text: "Erwin chose Base UI." });
    expect(record).toMatch(/decision, question, answer or cleanup/);
    expect(record).toMatch(/bb initiative describe/);
    expect(await refused(f, { action: "list-actions" })).toMatch(/decision, question, answer or cleanup/);
    const text = await refused(f, { action: "decision", madeBy: "user", text: "Erwin chose Base UI." });
    expect(text).toMatch(/"text"/);
    expect(text).toMatch(/description/);
    expect(text).toContain('"action":"decision"');
    expect(await refused(f, { action: "decision", madeBy: "user", description: "X", review: "needs Erwin" })).toMatch(/"review"/);
    expect(f.store.decisions(project.id)).toHaveLength(0);
  });

  it("Equisafe 751: superseding an open question states that only an explicit user answer closes it", async () => {
    const { f, project } = await projectFixture();
    const q = f.service.recordQuestion(project.id, { title: "CI cadence", humanAttention: "needs-opinion", question: "Run CI on PRs?", context: "Cost" }, coordinator);
    const message = await refused(f, { action: "decision", madeBy: "user", description: "CI runs on push only.", supersedes: q.ref });
    expect(message).toMatch(/explicit/);
    expect(message).toContain('"action":"answer"');
    expect(f.store.decisionItem(project.id, q.num)).toMatchObject({ status: "active", madeBy: null });
    expect(f.store.decisions(project.id)).toHaveLength(1);
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

  it("Solera 12139: answering an agent choice points to coordinator cleanup instead", async () => {
    const { f, project } = await projectFixture();
    const d = await tool(f, { action: "decision", madeBy: "agent", description: "Overnight team is four threads." });
    const message = await refused(f, { action: "answer", ref: d.ref, choice: "okay" });
    expect(message).toMatch(/agent decision/);
    expect(message).toContain('"action":"cleanup"');
    const viaCli = await cli(f, { action: "answer", decision: d.ref, choice: "okay" }, "coordinator", project.id);
    expect(viaCli.exitCode).toBe(1);
    expect(viaCli.stderr).toContain('"action":"cleanup"');
    expect(f.store.decisionItem(project.id, Number(d.ref.slice(1)))).toMatchObject({ review: "pending", status: "active" });
  });

  it("runs flat cleanup and the decision-cleanup alias for the current coordinator only", async () => {
    const { f, project } = await projectFixture();
    const d = await tool(f, { action: "decision", madeBy: "agent", description: "Keep native dispatch." });
    const reason = "Erwin asked to mark all agent decisions OK.";
    expect(await tool(f, { action: "cleanup", ref: d.ref, operation: "accept", reason })).toMatchObject({ review: "okay", madeBy: "agent" });
    expect((await cli(f, { action: "cleanup", ref: d.ref, operation: "veto", reason }, "coordinator", project.id)).exitCode).toBe(0);
    expect(await tool(f, { action: "decision-cleanup", decision: d.ref, operation: "accept", reason })).toMatchObject({ review: "okay" });
    const [worker] = await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id).ref] });
    expect(await refused(f, { action: "cleanup", ref: d.ref, operation: "remove", reason }, worker.threadId!)).toMatch(/current coordinator/);
    expect(await refused(f, { action: "cleanup", ref: d.ref, operation: "remove" })).toMatch(/reason/);
    expect(f.store.decisionItem(project.id, Number(d.ref.slice(1)))?.status).toBe("active");
    expect(f.send).not.toHaveBeenCalled();
  });
});

describe("T85 describe examples are canonical and valid", () => {
  it("every decision-family example records through the real tool", async () => {
    const { f, project } = await projectFixture();
    const examples = JSON.parse((await f.harness.runCli(["describe"], { threadId: "coordinator" })).stdout!).commands as string[];
    for (const name of ["question", "decision"]) {
      const example = JSON.parse((await f.harness.runCli(["describe", name], { threadId: "coordinator" })).stdout!);
      expect(examples).toContain(name);
      expect(example.decision === undefined || typeof example.decision === "string").toBe(true);
      const input = name === "question" ? { ...example, blocksTaskIds: [f.task(project.id).ref] } : example;
      expect(await tool(f, input)).toMatchObject({ status: "active" });
    }
  });
});
