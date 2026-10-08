import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { projectFixture } from "./fake-native";
import { buildSummary } from "../lib/overview";

// D340: the current coordinator may withdraw an open question it recorded itself, with a
// reason kept in history. Withdrawal is never an answer and releases only that question.
type Fixture = Awaited<ReturnType<typeof projectFixture>>["f"];
const coordinator = { author: "coordinator" as const, threadId: "coordinator", assignment: null };
const reason = "Settled by D15: Erwin chose Base UI in chat.";
const withdraw = (ref: string, why = reason) => ({ action: "withdraw", ref, reason: why });
const tool = (f: Fixture, input: unknown, threadId = "coordinator") =>
  f.harness.callAgentTool("initiative_decision", input, { threadId }).then(r => JSON.parse(r as string));
const refused = (f: Fixture, input: unknown, threadId = "coordinator") =>
  f.harness.callAgentTool("initiative_decision", input, { threadId }).then(() => "", (e: Error) => e.message);
// threadId null runs the CLI from a plain terminal, with no calling thread.
const cli = (f: Fixture, input: unknown, threadId: string | null = "coordinator", projectId?: string) =>
  f.harness.runCli(["command", JSON.stringify(input), ...(projectId ? [projectId] : [])], threadId ? { threadId } : {});
const options = [{ label: "Base UI", consequences: "Headless" }, { label: "Radix", consequences: "Styled" }];

async function question(by = coordinator) {
  const { f, project } = await projectFixture();
  const task = f.task(project.id);
  const q = f.service.recordQuestion(project.id, {
    title: "Kit", humanAttention: "needs-opinion", question: "Which component kit?",
    context: "The kit choice blocks the form work.", options, recommendation: "Base UI", blocksTaskIds: [task.ref],
  }, by);
  return { f, project, task, q };
}
const activity = (f: Fixture, projectId: string, ref: string) =>
  f.store.activity(projectId, 100).filter(row => row.summary.includes(ref) && /withdr/i.test(row.summary));

describe("T98 the current coordinator withdraws its own open question", () => {
  it("records a distinct withdrawal, keeps the question, releases its task and invents no answer", async () => {
    const { f, project, task, q } = await question();
    expect(f.store.task(project.id, task.num)).toMatchObject({ status: "blocked", progress: `Waiting for your opinion on ${q.ref}` });
    const receipt = { state: "uncertain" as const, op: "old", coordinatorThreadId: "coordinator", detail: "Lost native reply" };
    f.store.updateDecision(project.id, q.num, { notification: receipt });

    const result = await tool(f, withdraw(q.ref));
    expect(result).toMatchObject({ ref: q.ref, status: "withdrawn", madeBy: null, tasks: [{ ref: task.ref, status: "planned" }] });
    expect(result.answer).toBeUndefined();

    const stored = f.store.decisionItem(project.id, q.num)!;
    expect(stored).toMatchObject({ status: "withdrawn", madeBy: null, review: null, notification: receipt, provenance: coordinator, blocks: [task.num],
      body: { question: "Which component kit?", context: "The kit choice blocks the form work.", recommendation: "Base UI", options: [{ label: "Base UI" }, { label: "Radix" }] } });
    expect(stored.body).not.toHaveProperty("answer");
    expect(stored.body.resolution).toEqual({ note: reason, at: expect.any(Number), withdrawnBy: coordinator });
    expect(f.store.task(project.id, task.num)).toMatchObject({ status: "planned", progress: `The coordinator withdrew ${q.ref}` });
    expect(activity(f, project.id, q.ref)).toHaveLength(1);
    expect(activity(f, project.id, q.ref)[0]!.summary).toContain(reason);
    expect(f.send).not.toHaveBeenCalled();
  });

  it("reads, dashboard, Inbox and summaries show the withdrawal and drop its open attention", async () => {
    const { f, project, q } = await question();
    await tool(f, withdraw(q.ref));
    const detailed = JSON.parse(await f.harness.callAgentTool("initiative_read", { refs: [q.ref], detailed: true }, { threadId: "coordinator" }) as string);
    expect(detailed.items[0]).toMatchObject({ status: "withdrawn", madeBy: null, answer: null, question: "Which component kit?", recordedBy: coordinator, resolution: { note: reason, withdrawnBy: coordinator } });
    const compact = JSON.parse(await f.harness.callAgentTool("initiative_read", {}, { threadId: "coordinator" }) as string);
    expect(compact.counts.questions).toBe(0);
    const dashboard = await f.overview(project.id);
    expect(dashboard.opinionNeeded).toEqual([]);
    expect(dashboard.counts.opinionNeeded).toBe(0);
    expect(dashboard.answered).toEqual([]);
    expect(dashboard.decisions.map(d => d.ref)).not.toContain(q.ref);
    expect(dashboard.closedQuestions).toEqual([{ ref: q.ref, question: "Which component kit?", note: reason, closedAt: expect.any(Number), withdrawn: true }]);
    expect(buildSummary(f.store, project.id).opinions).toBe(0);
    const log = await f.harness.callRpc("read", { projectId: project.id, view: "activity", limit: 5 });
    expect(JSON.stringify(log)).toContain(`withdrew ${q.ref}`);
  });

  it("a lost-response repeat returns the same record without a second effect; a different reason is refused", async () => {
    const { f, project, task, q } = await question();
    const first = await tool(f, withdraw(q.ref));
    // The task moves on after the release; a repeat must not touch it again.
    f.store.updateTask(project.id, task.num, { status: "in_progress", progress: "Worker started" });
    const again = await tool(f, withdraw(q.ref));
    // Same saved record; tasks report their current state, which has moved on since.
    expect({ ...again, tasks: null }).toEqual({ ...first, tasks: null });
    expect(again.tasks).toEqual([{ ref: task.ref, status: "in_progress", progress: "Worker started" }]);
    expect(activity(f, project.id, q.ref)).toHaveLength(1);
    expect(f.store.task(project.id, task.num)).toMatchObject({ status: "in_progress", progress: "Worker started" });
    const other = await refused(f, withdraw(q.ref, "Another reason"));
    expect(other).toMatch(/already withdrawn/);
    expect(other).toContain(reason);
    expect(f.store.decisionItem(project.id, q.num)!.body.resolution?.note).toBe(reason);
    expect(f.send).not.toHaveBeenCalled();
  });

  it("works through the agent CLI flat and nested, and describe shows a valid example", async () => {
    const { f, project, q } = await question();
    const flat = await cli(f, withdraw(q.ref), "coordinator", project.id);
    expect(flat.exitCode).toBe(0);
    expect(f.store.decisionItem(project.id, q.num)?.status).toBe("withdrawn");
    const second = f.service.recordQuestion(project.id, { title: "Scope", humanAttention: "needs-opinion", question: "Include archives?", context: "Scope" }, coordinator);
    const nested = await cli(f, { action: "question-withdraw", decision: second.ref, reason }, "coordinator");
    expect(nested.exitCode).toBe(0);
    expect(f.store.decisionItem(project.id, second.num)?.status).toBe("withdrawn");
    const names = JSON.parse((await f.harness.runCli(["describe"], { threadId: "coordinator" })).stdout!).commands as string[];
    expect(names).toContain("withdraw");
    const example = JSON.parse((await f.harness.runCli(["describe", "withdraw"], { threadId: "coordinator" })).stdout!);
    const third = f.service.recordQuestion(project.id, { title: "Third", humanAttention: "needs-opinion", question: "Ship Friday?", context: "Date" }, coordinator);
    expect(await tool(f, { ...example, ref: third.ref })).toMatchObject({ status: "withdrawn" });
    expect(f.send).not.toHaveBeenCalled();
  });

  it("requires a nonempty bounded reason and refuses answer-shaped fields, each with a valid example", async () => {
    const { f, project, q } = await question();
    for (const input of [{ action: "withdraw", ref: q.ref }, withdraw(q.ref, "   "), withdraw(q.ref, "x".repeat(2001)), { action: "withdraw", reason }]) {
      const message = await refused(f, input);
      expect(message, JSON.stringify(input).slice(0, 80)).toContain('"action":"withdraw"');
      expect(message).toMatch(/bb initiative describe withdraw/);
    }
    const choice = await refused(f, { ...withdraw(q.ref), choice: "Base UI" });
    expect(choice).toMatch(/"choice"/);
    expect(choice).toMatch(/answer/);
    expect((await cli(f, { action: "withdraw", ref: q.ref }, "coordinator", project.id)).exitCode).toBe(1);
    expect(f.store.decisionItem(project.id, q.num)).toMatchObject({ status: "active", madeBy: null });
  });
});

describe("T98 protected callers and records", () => {
  it("workers, retired workers, user chats and threadless or dashboard callers cannot withdraw", async () => {
    const { f, project, task, q } = await question();
    const [worker] = await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id).ref] });
    expect(await refused(f, withdraw(q.ref), worker.threadId!)).toMatch(/current coordinator/);
    expect((await cli(f, withdraw(q.ref), worker.threadId!, project.id)).exitCode).toBe(1);
    f.store.db.prepare("UPDATE workers SET state='retired' WHERE thread_id=?").run(worker.threadId);
    expect(await refused(f, withdraw(q.ref), worker.threadId!)).toMatch(/current/);
    await expect(f.harness.callAgentTool("initiative_decision", withdraw(q.ref), { threadId: "foreign" })).rejects.toThrow();
    // The user's panel and terminal keep question-close; withdrawal is the coordinator's own act.
    await expect(f.harness.callRpc("command", { projectId: project.id, command: { action: "question-withdraw", decision: q.ref, reason } })).rejects.toThrow(/coordinator/);
    expect((await cli(f, withdraw(q.ref), null, project.id)).exitCode).toBe(1);
    expect(f.store.decisionItem(project.id, q.num)).toMatchObject({ status: "active" });
    expect(f.store.task(project.id, task.num)?.status).toBe("blocked");
  });

  it("a former coordinator cannot withdraw, and its replacement cannot withdraw the predecessor's question", async () => {
    const { f, project, task, q } = await question();
    f.store.db.prepare("UPDATE projects SET coordinator_thread_id='replacement' WHERE id=?").run(project.id);
    expect(await refused(f, withdraw(q.ref))).toMatch(/current/);
    expect((await cli(f, withdraw(q.ref), "coordinator", project.id)).exitCode).toBe(1);
    const message = await refused(f, withdraw(q.ref), "replacement");
    expect(message).toMatch(/recorded by/);
    expect((await cli(f, withdraw(q.ref), "replacement", project.id)).exitCode).toBe(1);
    expect(f.store.decisionItem(project.id, q.num)).toMatchObject({ status: "active" });
    expect(f.store.task(project.id, task.num)?.status).toBe("blocked");
    // The replacement's own question stays withdrawable.
    const own = f.service.recordQuestion(project.id, { title: "Own", humanAttention: "needs-opinion", question: "Ship Friday?", context: "Date" }, { ...coordinator, threadId: "replacement" });
    expect(await tool(f, withdraw(own.ref), "replacement")).toMatchObject({ status: "withdrawn" });
  });

  it("answered, closed and already-decided records and user-recorded questions stay protected", async () => {
    const { f, project, q } = await question();
    await f.service.answerOpinion(project.id, q.ref, { choice: "Radix", note: "", notify: false });
    const answered = await refused(f, withdraw(q.ref));
    expect(answered).toMatch(/already answered; the recorded answer stands/);
    expect(f.store.decisionItem(project.id, q.num)).toMatchObject({ status: "answered", madeBy: "user", body: { answer: { choice: "Radix" } } });
    const closed = f.service.recordQuestion(project.id, { title: "Closed", humanAttention: "needs-opinion", question: "Archive?", context: "c" }, coordinator);
    f.service.closeQuestion(project.id, closed.ref, "Done in chat");
    expect(await refused(f, withdraw(closed.ref))).toMatch(/user closed it/);
    expect(f.store.decisionItem(project.id, closed.num)).toMatchObject({ status: "closed", body: { resolution: { note: "Done in chat" } } });
    const agent = await tool(f, { action: "decision", madeBy: "agent", description: "Keep native dispatch." });
    const user = await tool(f, { action: "decision", madeBy: "user", description: "Erwin chose Linux." });
    for (const ref of [agent.ref, user.ref]) expect(await refused(f, withdraw(ref))).toMatch(/not an open question/);
    const asked = f.service.recordQuestion(project.id, { title: "User", humanAttention: "needs-opinion", question: "Mine?", context: "c" }, { author: "user", threadId: null, assignment: null });
    expect(await refused(f, withdraw(asked.ref))).toMatch(/recorded by/);
    expect(f.store.decisionItem(project.id, asked.num)?.status).toBe("active");
    expect(f.send).not.toHaveBeenCalled();
  });
});

describe("T98 task blocking and answer races", () => {
  it("releases only this question: other open questions, unrelated blocks and delegation guards still hold", async () => {
    const { f, project, task, q } = await question();
    const second = f.service.recordQuestion(project.id, { title: "Scope", humanAttention: "needs-opinion", question: "Include archives?", context: "Scope", blocksTaskIds: [task.ref] }, coordinator);
    const unrelated = f.task(project.id);
    f.store.updateTask(project.id, unrelated.num, { status: "blocked", progress: "Waiting for upstream SDK" });
    f.store.db.prepare("UPDATE knowledge SET blocks=? WHERE project_id=? AND num=?").run(JSON.stringify([task.num, unrelated.num]), project.id, q.num);
    await tool(f, withdraw(q.ref));
    expect(f.store.task(project.id, task.num)).toMatchObject({ status: "blocked", progress: `Waiting for your opinion on ${second.ref}` });
    expect(f.store.task(project.id, unrelated.num)).toMatchObject({ status: "blocked", progress: "Waiting for upstream SDK" });
    await expect(f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] })).rejects.toThrow(/waiting for the user's answer to a question/);
    expect((await f.overview(project.id)).opinionNeeded.map(o => o.ref)).toEqual([second.ref]);
  });

  it("a task with running work resumes in progress, and its assignment and receipts are untouched", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id);
    const [work] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
    const q = f.service.recordQuestion(project.id, { title: "Mid", humanAttention: "needs-opinion", question: "Keep going?", context: "c", blocksTaskIds: [task.ref] }, coordinator);
    expect(f.store.task(project.id, task.num)?.status).toBe("blocked");
    const before = f.store.assignments(project.id).find(a => a.ref === work.assignment)!;
    await tool(f, withdraw(q.ref));
    expect(f.store.task(project.id, task.num)).toMatchObject({ status: "in_progress", nextCheckpoint: null });
    expect(f.store.assignments(project.id).find(a => a.ref === work.assignment)).toEqual(before);
  });

  it("an answer that lands first stands; withdrawal is refused without a second message or release", async () => {
    const { f, project, task, q } = await question();
    let finish!: (result: unknown) => void;
    f.send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const answering = f.harness.callRpc("command", { projectId: project.id, command: { action: "answer", decision: q.ref, choice: "Radix", note: "" } });
    await vi.waitFor(() => expect(f.store.decisionItem(project.id, q.num)?.notification?.state).toBe("pending"));
    f.store.updateTask(project.id, task.num, { status: "in_progress", progress: "Worker started" });
    expect(await refused(f, withdraw(q.ref))).toMatch(/already answered/);
    finish({ delivery: "sent", thread: f.threads.get("coordinator") });
    await answering;
    expect(f.store.decisionItem(project.id, q.num)).toMatchObject({ status: "answered", madeBy: "user", notification: { state: "sent" }, body: { answer: { choice: "Radix" } } });
    expect(f.store.decisionItem(project.id, q.num)!.body.resolution).toBeUndefined();
    expect(f.store.task(project.id, task.num)).toMatchObject({ status: "in_progress", progress: "Worker started" });
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("an answer after withdrawal is refused with the reason and a path to record the user's choice", async () => {
    const { f, project, q } = await question();
    await tool(f, withdraw(q.ref));
    const panel = await f.harness.callRpc("command", { projectId: project.id, command: { action: "answer", decision: q.ref, choice: "Radix", note: "" } }).then(() => "", (e: Error) => e.message);
    expect(panel).toContain(`The coordinator withdrew ${q.ref}: ${reason}`);
    const [worker] = await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id).ref] });
    const chat = await refused(f, { action: "answer", ref: q.ref, choice: "Radix" }, worker.threadId!);
    expect(chat).toContain(reason);
    expect(chat).toContain('initiative_decision {"action":"user-choice","description":"<the user\'s choice>"}');
    expect(await refused(f, { action: "decision", madeBy: "user", description: "x", supersedes: q.ref })).toMatch(/withdrawn/);
    await expect(f.harness.callRpc("command", { projectId: project.id, command: { action: "question-close", decision: q.ref, note: "" } })).rejects.toThrow(/not an open question/);
    expect(f.store.decisionItem(project.id, q.num)).toMatchObject({ status: "withdrawn", madeBy: null });
    expect(f.store.decisionItem(project.id, q.num)!.body).not.toHaveProperty("answer");
    expect(f.send).not.toHaveBeenCalled();
  });
});

describe("T98 A238 follow-ups", () => {
  // P3-1: the panel user cannot run agent JSON; tell them plainly their answer was not saved.
  it("a panel or terminal answer after withdrawal says it was not saved and points to chat, without agent JSON", async () => {
    const { f, project, q } = await question();
    await tool(f, withdraw(q.ref));
    const answer = { action: "answer", decision: q.ref, choice: "Radix", note: "Use Radix" };
    const panel = await f.harness.callRpc("command", { projectId: project.id, command: answer }).then(() => "", (e: Error) => e.message);
    const terminal = await cli(f, answer, null, project.id);
    expect(terminal.exitCode).toBe(1);
    for (const message of [panel, terminal.stderr!]) {
      expect(message).toContain(`The coordinator withdrew ${q.ref}: ${reason}`);
      expect(message).toContain("Your answer was not saved");
      expect(message).toMatch(/tell the coordinator in chat/);
      expect(message).not.toMatch(/[{}]|"action"|madeBy|the user/);
    }
    // Agent and CLI recorders keep the actionable madeBy:user path.
    const recorded = await refused(f, { action: "answer", ref: q.ref, choice: "Radix" });
    expect(recorded).toContain(reason);
    expect(recorded).toContain('{"action":"user-choice"');
    const agentCli = await cli(f, { action: "answer", ref: q.ref, choice: "Radix" }, "coordinator", project.id);
    expect(agentCli.stderr).toContain('"action":"user-choice"');
    // W188 (F5): the suggested call works as written once its placeholder is filled in.
    const example = JSON.parse(/initiative_decision (\{.*?\})\./.exec(recorded)![1]!);
    expect(await tool(f, { ...example, description: "Erwin chose Radix." })).toMatchObject({ madeBy: "user", status: "active" });
    expect(f.store.decisionItem(project.id, q.num)).toMatchObject({ status: "withdrawn", madeBy: null, notification: null });
    expect(f.store.decisionItem(project.id, q.num)!.body).not.toHaveProperty("answer");
    expect(f.send).not.toHaveBeenCalled();
  });

  it("other refused panel answers keep their existing wording", async () => {
    const { f, project, q } = await question();
    await f.service.answerOpinion(project.id, q.ref, { choice: "Radix", note: "", notify: false });
    const again = await f.harness.callRpc("command", { projectId: project.id, command: { action: "answer", decision: q.ref, choice: "Base UI", note: "" } }).then(() => "", (e: Error) => e.message);
    expect(again).toBe(`${q.ref} is not an open question: it is already answered; the recorded answer stands.`);
  });

  // P3-3: the service itself enforces the current-coordinator guard, not only the tool/CLI membership checks.
  it("the service refuses a former coordinator's own question and writes nothing", async () => {
    const { f, project, task, q } = await question();
    f.store.db.prepare("UPDATE projects SET coordinator_thread_id='replacement' WHERE id=?").run(project.id);
    const row = () => f.store.db.prepare("SELECT * FROM knowledge WHERE project_id=? AND num=?").get(project.id, q.num);
    const before = { row: row(), task: f.store.task(project.id, task.num), activity: f.store.activity(project.id, 100) };
    expect(() => f.service.withdrawQuestion(project.id, q.ref, reason, coordinator)).toThrow(/Only the current coordinator/);
    for (const by of [{ ...coordinator, author: "worker" as const }, { ...coordinator, threadId: null }, { author: "user" as const, threadId: null, assignment: null }])
      expect(() => f.service.withdrawQuestion(project.id, q.ref, reason, by)).toThrow(/Only the current coordinator/);
    expect({ row: row(), task: f.store.task(project.id, task.num), activity: f.store.activity(project.id, 100) }).toEqual(before);
    expect(f.send).not.toHaveBeenCalled();
  });
});

// BB's Claude Code bridge advertises only object roots; anything else becomes {type:"object"}.
const INSTALLED_BRIDGE = join(homedir(), ".npm-global/lib/node_modules/bb-app/server/dist/builtin-plugins/provider-claude-code/dist/host.js");
function claudeNormalize(): (schema: unknown) => any {
  if (existsSync(INSTALLED_BRIDGE)) {
    const source = readFileSync(INSTALLED_BRIDGE, "utf8").match(/function normalizeInputSchema\(inputSchema\) \{[\s\S]*?\n\}/)?.[0];
    if (source) return new Function(`${source}; return normalizeInputSchema;`)();
  }
  return (s: any) => s !== null && typeof s === "object" && !Array.isArray(s) && s.type === "object" ? s : { type: "object" };
}

describe("T98 published schema", () => {
  it("advertises withdraw with ref and reason through Claude normalization, keeping every existing action", async () => {
    const { f } = await projectFixture();
    const record = f.harness.registrations.agentTools.find(t => t.name === "initiative_decision")! as { inputSchema: any; description: string };
    const schema = claudeNormalize()(record.inputSchema);
    expect(schema).toBe(record.inputSchema);
    expect(schema.properties.action.enum).toEqual(["user-choice", "veto-request", "question", "answer", "withdraw", "decision"]);
    expect(schema.properties.action.description).toMatch(/withdraw/);
    expect(schema.properties.ref.description).toMatch(/withdraw/);
    expect(schema.properties.reason).toMatchObject({ type: "string", maxLength: 2000 });
    expect(schema.properties.reason.description).toMatch(/withdraw/);
    expect(record.description).toContain('{action:"withdraw",ref:"D12",reason}');
  });
});
