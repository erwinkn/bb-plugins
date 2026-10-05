import { describe, expect, it } from "vitest";
import { projectFixture } from "./fake-native";

const coordinator = { author: "coordinator" as const, threadId: "coordinator", assignment: null };
type Fixture = Awaited<ReturnType<typeof projectFixture>>["f"];

async function openQuestion() {
  const { f, project } = await projectFixture();
  const task = f.task(project.id);
  const q = f.service.recordQuestion(project.id, {
    title: "Home", humanAttention: "needs-opinion", question: "Which checkout should coordinators use?",
    context: "Pick the writer home", blocksTaskIds: [task.ref],
    options: [{ label: "Main", consequences: "One writer" }, { label: "Any", consequences: "Flexible" }],
  }, coordinator);
  return { f, project, task, q };
}
const answer = (ref: string, choice: string | null = "Main", note = "Linux main checkout") =>
  ({ action: "answer", decision: ref, choice, note });
const viaTool = (f: Fixture, threadId: string, input: object) =>
  f.harness.callAgentTool("initiative_decision", input, { threadId });
const viaCli = (f: Fixture, threadId: string, input: object, projectId?: string) =>
  f.harness.runCli(["command", JSON.stringify(input), ...(projectId ? [projectId] : [])], { threadId });

describe("T53 recording the user's explicit chat answer", () => {
  it("the coordinator closes the existing question as the user's choice, unblocking its task", async () => {
    const { f, project, task, q } = await openQuestion();
    const result = JSON.parse(await viaTool(f, "coordinator", answer(q.ref)) as string);
    expect(result).toMatchObject({ ref: q.ref, madeBy: "user", status: "answered", recordedBy: { author: "coordinator", threadId: "coordinator" } });
    const item = f.store.decisionItem(project.id, q.num)!;
    expect(item).toMatchObject({ madeBy: "user", review: null, provenance: coordinator });
    expect((item.body as { answer?: object }).answer).toMatchObject({ choice: "Main", note: "Linux main checkout", recordedBy: { author: "coordinator" } });
    expect(f.store.task(project.id, task.num)?.status).toBe("planned");
    expect(f.store.activity(project.id)[0]!.summary).toBe(`You answered ${q.ref} in chat; the coordinator recorded it`);
    // A closed question cannot be answered twice.
    await expect(viaTool(f, "coordinator", answer(q.ref))).rejects.toThrow(/not an open question/);
  });

  it("a current managed worker records the answer given in its own chat, through the tool or the retained-session CLI", async () => {
    const { f, project, q } = await openQuestion();
    const [worker] = await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id).ref] });
    const cli = await viaCli(f, worker.threadId!, answer(q.ref, null, "Use the main checkout on Linux."), project.id);
    expect(cli.exitCode).toBe(0);
    const item = f.store.decisionItem(project.id, q.num)!;
    expect(item.madeBy).toBe("user");
    const assignment = f.store.openAssignment(project.id, Number(worker.worker.slice(1)))!.num;
    expect((item.body as { answer?: object }).answer).toMatchObject({ choice: null, note: "Use the main checkout on Linux.", recordedBy: { author: "worker", threadId: worker.threadId, assignment } });
    const second = f.service.recordQuestion(project.id, { title: "Scope", humanAttention: "needs-opinion", question: "Include archives?", context: "Archived threads are large." }, coordinator);
    await viaTool(f, worker.threadId!, answer(second.ref, null, "Yes, include them."));
    expect(f.store.decisionItem(project.id, second.num)).toMatchObject({ madeBy: "user", status: "answered" });
  });

  it("former, retired, ad-hoc and foreign callers are refused and nothing is recorded", async () => {
    const { f, project, q } = await openQuestion();
    const [worker] = await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id).ref] });
    f.store.db.prepare("UPDATE workers SET state='retired' WHERE project_id=? AND thread_id=?").run(project.id, worker.threadId);
    await expect(viaTool(f, worker.threadId!, answer(q.ref))).rejects.toThrow(/current coordinator or a current worker/);
    expect((await viaCli(f, worker.threadId!, answer(q.ref), project.id)).exitCode).toBe(1);
    await expect(viaTool(f, "stranger", answer(q.ref))).rejects.toThrow();
    const foreign = await viaCli(f, "coordinator", answer(q.ref), "prj_elsewhere");
    expect(foreign.exitCode).toBe(1);
    expect(foreign.stderr).toMatch(/own Initiative/);
    // The replaced coordinator is a former generation.
    f.idle("coordinator");
    await f.service.replaceCoordinator(project.id, { reason: "Switch model" });
    await expect(viaTool(f, "coordinator", answer(q.ref))).rejects.toThrow();
    expect(f.store.decisionItem(project.id, q.num)).toMatchObject({ madeBy: null, status: "active" });
  });

  it("answers only open questions, with a real option or written answer; reviews stay the user's", async () => {
    const { f, project, q } = await openQuestion();
    const agentChoice = f.service.recordDecision(project.id, { decision: { description: "Reuse the index.", madeBy: "agent" } }, coordinator);
    await expect(viaTool(f, "coordinator", answer(agentChoice.ref))).rejects.toThrow(/not an open question/);
    await expect(viaTool(f, "coordinator", answer(q.ref, "Elsewhere"))).rejects.toThrow(/not one of the options/);
    await expect(viaTool(f, "coordinator", answer(q.ref, null, ""))).rejects.toThrow(/write an answer/);
    for (const action of ["decision-review", "acknowledge"]) {
      const denied = await viaCli(f, "coordinator", { action, decision: agentChoice.ref, verdict: "okay", message: "", note: "" }, project.id);
      expect(denied.exitCode).toBe(1);
    }
    expect(f.store.decisionItem(project.id, agentChoice.num)).toMatchObject({ madeBy: "agent", review: "pending" });
    // The panel's own answer path is unchanged and records no agent.
    await f.service.answerOpinion(project.id, q.ref, { choice: "Any", note: "" });
    expect((f.store.decisionItem(project.id, q.num)!.body as { answer?: object }).answer).not.toHaveProperty("recordedBy");
  });
});
