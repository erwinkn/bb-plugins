import { describe, expect, it, vi } from "vitest";
import { projectFixture } from "./fake-native";
import { commandSchema } from "../lib/commands";

const coordinator = { author: "coordinator" as const, threadId: "coordinator", assignment: null };
async function question() {
  const { f, project } = await projectFixture();
  const task = f.task(project.id);
  const q = f.service.recordQuestion(project.id, {
    title: "Writer home", humanAttention: "needs-opinion", question: "Which checkout?",
    context: "Choose the writer home", blocksTaskIds: [task.ref],
    options: [{ label: "Main", consequences: "One writer" }],
  }, coordinator);
  return { f, project, task, q };
}
const answer = (decision: string, notify?: boolean) => ({ action: "answer", decision, choice: "Main", note: "Linux checkout", ...(notify === undefined ? {} : { notify }) });

describe("T57 question resolution and ownership", () => {
  it("requires an explicit decision owner instead of defaulting user choices to agent", () => {
    expect(commandSchema.safeParse({ action: "decision", decision: { description: "Use the Linux checkout." } }).success).toBe(false);
  });
  it("dashboard answers save the user choice and notify the current coordinator by default", async () => {
    const { f, project, task, q } = await question();
    f.queueSend("answer-queue");
    const result = await f.harness.callRpc("command", { projectId: project.id, command: answer(q.ref) });
    expect(result).toMatchObject({ madeBy: "user", status: "answered", notification: { state: "queued", coordinatorThreadId: "coordinator", queuedId: "answer-queue" } });
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0][0]).toMatchObject({ threadId: "coordinator", mode: "steer-if-active" });
    for (const text of [q.ref, "Main", "Linux checkout"]) expect(f.send.mock.calls[0][0].input[0].text).toContain(text);
    expect(f.store.task(project.id, task.num)?.status).toBe("planned");
  });

  it("an explicit quiet answer records the choice without any message", async () => {
    const { f, project, task, q } = await question();
    await f.harness.callRpc("command", { projectId: project.id, command: answer(q.ref, false) });
    expect(f.store.decisionItem(project.id, q.num)).toMatchObject({ madeBy: "user", status: "answered", notification: null, description: "Main · Linux checkout" });
    expect(f.store.task(project.id, task.num)?.status).toBe("planned");
    expect(f.send).not.toHaveBeenCalled();
  });

  it("quiet closure keeps the question and note, releases its task, and invents no answer", async () => {
    const { f, project, task, q } = await question();
    f.store.updateTask(project.id, task.num, { progress: `Waiting for your opinion on K${q.num}` });
    const result = await f.harness.callRpc("command", { projectId: project.id, command: { action: "question-close", decision: q.ref, note: "Already settled in chat." } });
    expect(result).toMatchObject({ status: "closed", madeBy: null, notification: null, body: { question: "Which checkout?", resolution: { note: "Already settled in chat." } } });
    expect((result as any).body).not.toHaveProperty("answer");
    expect(f.store.task(project.id, task.num)?.status).toBe("planned");
    const overview = await f.harness.callRpc("overview", { projectId: project.id });
    expect((overview as any).opinionNeeded).toEqual([]);
    expect((overview as any).decisions).toEqual([]);
    expect((overview as any).closedQuestions).toEqual([expect.objectContaining({ ref: q.ref, note: "Already settled in chat." })]);
    const history = await f.harness.callRpc("read", { projectId: project.id, view: "decisions", refs: [q.ref], detailed: true });
    expect((history as any).items[0]).toMatchObject({ status: "closed", madeBy: null, resolution: { note: "Already settled in chat." }, question: "Which checkout?" });
    expect(f.send).not.toHaveBeenCalled();
    await expect(f.harness.runCli(["command", JSON.stringify({ action: "question-close", decision: q.ref }), project.id], { threadId: "coordinator" })).resolves.toMatchObject({ exitCode: 1 });
  });

  it("resolution cannot release another open question or an unrelated blocked reason", async () => {
    const { f, project, task, q } = await question();
    const second = f.service.recordQuestion(project.id, { title: "Scope", humanAttention: "needs-opinion", question: "Include archives?", context: "Scope", blocksTaskIds: [task.ref] }, coordinator);
    await f.harness.callRpc("command", { projectId: project.id, command: answer(q.ref, false) });
    expect(f.store.task(project.id, task.num)).toMatchObject({ status: "blocked", progress: `Waiting for your opinion on ${second.ref}` });
    f.store.updateTask(project.id, task.num, { progress: "Waiting for upstream SDK" });
    await f.harness.callRpc("command", { projectId: project.id, command: { action: "question-close", decision: second.ref } });
    expect(f.store.task(project.id, task.num)).toMatchObject({ status: "blocked", progress: "Waiting for upstream SDK" });
  });

  it("coordinator chat answers stay quiet, worker chat answers propagate by default", async () => {
    const { f, project, q } = await question();
    await f.harness.callAgentTool("initiative_decision", answer(q.ref), { threadId: "coordinator" });
    expect(f.send).not.toHaveBeenCalled();
    const [worker] = await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id).ref] });
    const second = f.service.recordQuestion(project.id, { title: "Other", humanAttention: "needs-opinion", question: "Which checkout?", context: "Writer home", options: [{ label: "Main", consequences: "One writer" }] }, coordinator);
    await f.harness.callAgentTool("initiative_decision", answer(second.ref), { threadId: worker.threadId! });
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.store.decisionItem(project.id, second.num)).toMatchObject({ madeBy: "user", notification: { state: "sent" }, body: { answer: { recordedBy: { author: "worker", threadId: worker.threadId } } } });
    const third = f.service.recordQuestion(project.id, { title: "Quiet", humanAttention: "needs-opinion", question: "Which checkout?", context: "Writer home", options: [{ label: "Main", consequences: "One writer" }] }, coordinator);
    const cli = await f.harness.runCli(["command", JSON.stringify(answer(third.ref, false)), project.id], { threadId: worker.threadId! });
    expect(cli.exitCode).toBe(0);
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("current workers record explicit user choices with owner distinct from recorder", async () => {
    const { f, project } = await question();
    const [worker] = await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id).ref] });
    const input = { action: "decision", decision: { description: "Erwin chose the Linux checkout.", madeBy: "user" } };
    const result = JSON.parse(await f.harness.callAgentTool("initiative_decision", input, { threadId: worker.threadId! }) as string);
    expect(result).toMatchObject({ madeBy: "user", review: null });
    expect(f.store.decisionItem(project.id, Number(result.ref.slice(1)))!.provenance).toMatchObject({ author: "worker", threadId: worker.threadId });
    const cli = await f.harness.runCli(["command", JSON.stringify(input), project.id], { threadId: worker.threadId! });
    expect(cli.exitCode).toBe(0);
    f.store.db.prepare("UPDATE workers SET state='retired' WHERE thread_id=?").run(worker.threadId);
    await expect(f.harness.callAgentTool("initiative_decision", input, { threadId: worker.threadId! })).rejects.toThrow(/current/);
    expect(f.send).not.toHaveBeenCalled();
  });

  it("uncertain delivery stays recorded and identical retries never send twice", async () => {
    const { f, project, q } = await question();
    f.send.mockRejectedValueOnce(new Error("lost response"));
    const first = await f.harness.callRpc("command", { projectId: project.id, command: answer(q.ref) });
    expect(first).toMatchObject({ madeBy: "user", status: "answered", notification: { state: "uncertain" } });
    await f.harness.callRpc("command", { projectId: project.id, command: answer(q.ref) });
    expect(f.send).toHaveBeenCalledTimes(1);
    await expect(f.harness.callRpc("command", { projectId: project.id, command: { ...answer(q.ref), note: "Changed answer" } })).rejects.toThrow(/not an open question/);
  });

  it("a retry while the first native send is pending cannot send twice", async () => {
    const { f, project, q } = await question();
    let finish!: (result: unknown) => void;
    f.send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = f.harness.callRpc("command", { projectId: project.id, command: answer(q.ref) });
    await vi.waitFor(() => expect(f.store.decisionItem(project.id, q.num)?.notification?.state).toBe("pending"));
    await f.harness.callRpc("command", { projectId: project.id, command: answer(q.ref) });
    expect(f.send).toHaveBeenCalledTimes(1);
    finish({ delivery: "sent", thread: f.threads.get("coordinator") });
    await first;
    expect(f.store.decisionItem(project.id, q.num)?.notification?.state).toBe("sent");
  });

  it("a missing coordinator leaves the answer saved with a visible failure receipt", async () => {
    const { f, project, q } = await question();
    f.store.db.prepare("UPDATE projects SET coordinator_thread_id=NULL WHERE id=?").run(project.id);
    const result = await f.harness.callRpc("command", { projectId: project.id, command: answer(q.ref) });
    expect(result).toMatchObject({ madeBy: "user", status: "answered", notification: { state: "failed", coordinatorThreadId: null, detail: "No current coordinator. Your answer is saved." } });
    expect(f.send).not.toHaveBeenCalled();
  });

  it("older unresolved answer delivery remains visible after ten newer answers", async () => {
    const { f, project, q } = await question();
    f.send.mockRejectedValueOnce(Object.assign(new Error("refused"), { status: 400 }));
    await f.harness.callRpc("command", { projectId: project.id, command: answer(q.ref) });
    for (let i = 0; i < 11; i++) {
      const newer = f.service.recordQuestion(project.id, { title: `Next ${i}`, humanAttention: "needs-opinion", question: "Scope?", context: "Next choice" }, coordinator);
      await f.service.answerOpinion(project.id, newer.ref, { choice: null, note: "Already resolved", notify: false });
      const item = f.store.decisionItem(project.id, newer.num)!;
      f.store.updateDecision(project.id, newer.num, { body: { ...item.body, answer: { ...item.body.answer!, at: Date.now() + i + 1 } } });
    }
    const overview = await f.overview(project.id);
    expect(overview.answered).toHaveLength(11);
    expect(overview.answered).toContainEqual(expect.objectContaining({ ref: q.ref, choice: "Main", note: "Linux checkout" }));
    expect(overview.decisions.find(d => d.ref === q.ref)?.notification?.state).toBe("failed");
  });

  it("definite refusal permits an explicit same-answer retry to the current replacement", async () => {
    const { f, project, q } = await question();
    f.send.mockRejectedValueOnce(Object.assign(new Error("refused"), { status: 400 }));
    await f.harness.callRpc("command", { projectId: project.id, command: answer(q.ref) });
    expect(f.store.decisionItem(project.id, q.num)?.notification?.state).toBe("failed");
    f.store.db.prepare("UPDATE projects SET coordinator_thread_id='replacement' WHERE id=?").run(project.id);
    await f.harness.callRpc("command", { projectId: project.id, command: answer(q.ref) });
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls[1][0].threadId).toBe("replacement");
    expect(f.store.decisionItem(project.id, q.num)?.description).toBe("Main · Linux checkout");
  });
});
