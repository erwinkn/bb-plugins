import { describe, expect, it } from "vitest";
import { projectFixture, report } from "./fake-native";
import { needsYouCount } from "../lib/blockers";

// W488: the user answers a worker's blocker in the coordinator's chat instead of in the Inbox.
// The coordinator records it on the card (initiative_question answered), which clears Needs you
// and keeps the answer in Decisions, as an Inbox answer to the coordinator would; nothing is sent.
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const question = "Which Railway env keys does Tekk Paris need?";
const context = "The deploy needs two secrets only Erwin has.";
const seen = { question, context };
const said = "Erwin: use the staging keys from 1Password, not prod.";
const blocked = { ...report(), outcome: "blocked" as const, summary: "Blocked on secrets.", blocker: { question, context } };
const tool = (f: Fx, input: unknown, threadId = "coordinator") =>
  f.harness.callAgentTool("initiative_question", input, { threadId }).then((r) => JSON.parse(r as string));
const refused = (f: Fx, input: unknown, threadId = "coordinator") =>
  f.harness.callAgentTool("initiative_question", input, { threadId }).then(() => "", (e: Error) => e.message);

async function blockedWorker() {
  const { f, project } = await projectFixture();
  const task = f.task(project.id, "Deploy Tekk Paris");
  const [a] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
  await f.service.report(a.threadId!, blocked as never);
  f.idle(a.threadId!);
  f.send.mockClear();
  return { f, project, task, ref: a.worker, threadId: a.threadId! };
}

async function state(f: Fx, projectId: string, ref: string) {
  const o = await f.overview(projectId, "summary");
  const tree = ((await f.harness.callRpc("tree", null)) as any).projects[0].needsYou as number;
  return { group: o.workerGroups?.[ref]?.group ?? null, tree, dashboard: needsYouCount(o), cards: o.blockers.length };
}

describe("W488 the coordinator records the user's chat answer on a blocker card", () => {
  it("clears Needs you, keeps the card answered until the coordinator acts, and sends nothing", async () => {
    const { f, project, ref } = await blockedWorker();
    expect(await state(f, project.id, ref)).toEqual({ group: "needs", tree: 1, dashboard: 1, cards: 1 });
    const result = await tool(f, { answered: "A1", question, text: said });
    expect(result).toMatchObject({ ref: "D1", status: "active" });
    expect(await state(f, project.id, ref)).toEqual({ group: "waiting", tree: 0, dashboard: 0, cards: 1 });
    expect(f.send).not.toHaveBeenCalled();

    const [card] = (await f.overview(project.id)).blockers;
    expect(card!.answer).toMatchObject({ ref: "D1", choice: null, note: said, to: "coordinator", inChat: true, notification: null, delivery: null });
    // The ledger keeps it as the user's answer, recorded by the coordinator's thread.
    const d = f.store.decisions(project.id)[0]!;
    expect(d).toMatchObject({ madeBy: "user", provenance: { author: "coordinator", threadId: "coordinator", assignment: null } });
    expect((d.body as { description: string }).description).toBe(`Answer to ${ref}'s blocker on T1 (A1), given in chat: ${said}`);
    expect(f.store.activity(project.id, 20).some((row) => row.summary.includes("in chat; the coordinator recorded it"))).toBe(true);

    // The relay closes the card, as after an Inbox answer.
    await f.service.delegate(project.id, { route: "continue", role: "work", worker: ref, note: said } as never);
    expect((await state(f, project.id, ref)).cards).toBe(0);
  });

  it("an Inbox answer's card says nothing of chat", async () => {
    const { f, project } = await blockedWorker();
    await f.service.answerBlocker(project.id, "A1", seen, "Use the staging keys.", "coordinator");
    expect((await f.overview(project.id)).blockers[0]!.answer).toMatchObject({ inChat: false });
  });

  it("refuses a card the user already answered or dismissed, keeping theirs", async () => {
    const { f, project } = await blockedWorker();
    await f.service.answerBlocker(project.id, "A1", seen, "Use the staging keys.", "coordinator");
    expect(await refused(f, { answered: "A1", question, text: said })).toMatch(/already answered A1's blocker \(D1\).*not saved/);
    // Even the same words twice: a chat answer is recorded once.
    const second = await blockedWorker();
    await tool(second.f, { answered: "A1", question, text: said });
    expect(await refused(second.f, { answered: "A1", question, text: said })).toMatch(/already answered A1's blocker \(D1\)/);
    expect(second.f.store.decisions(second.project.id)).toHaveLength(1);
    expect(f.store.decisions(project.id).map((d) => d.body.answer?.note)).toEqual(["Use the staging keys."]);

    const third = await blockedWorker();
    await third.f.service.dismissBlocker(third.project.id, "A1", seen, { notify: false, note: "" });
    expect(await refused(third.f, { answered: "A1", question, text: said })).toMatch(/already dismissed A1's blocker \(D1\).*not saved/);
    // Undoing the dismissal reopens the card for an answer.
    third.f.service.undoBlockerDismissal(third.project.id, "D1");
    await tool(third.f, { answered: "A1", question, text: said });
    expect((await third.f.overview(third.project.id)).blockers[0]!.answer).toMatchObject({ note: said, inChat: true });
  });

  it("refuses a retired worker's blocker and one the coordinator already acted on", async () => {
    const { f, project, ref } = await blockedWorker();
    await f.service.retireWorker(project.id, ref, "Finished.");
    expect(await refused(f, { answered: "A1", question, text: said })).toMatch(/worker was retired.*not saved/);
    const other = await blockedWorker();
    await other.f.service.delegate(other.project.id, { route: "continue", role: "work", worker: other.ref, note: said } as never);
    expect(await refused(other.f, { answered: "A1", question, text: said })).toMatch(/no longer waiting on a blocker.*not saved/);
    expect([...f.store.decisions(project.id), ...other.f.store.decisions(other.project.id)]).toEqual([]);
  });

  it("answers only the question the user answered: a worker that re-filed another one on the same A# is refused", async () => {
    const { f, project, ref, threadId } = await blockedWorker();
    const rotate = "May I rotate the production signing key?";
    await f.service.report(threadId, { ...blocked, blocker: { question: rotate, context } } as never);
    expect((await f.overview(project.id)).blockers.map((b) => b.question)).toEqual([rotate]);
    expect(await refused(f, { answered: "A1", question, text: said })).toMatch(/A1's blocker now asks: "May I rotate the production signing key\?".*ask them this one.*not saved/);
    expect(f.store.decisions(project.id)).toEqual([]);
    expect((await state(f, project.id, ref)).dashboard).toBe(1);
    // The question as the coordinator copied it: spacing and case do not count.
    expect(await tool(f, { answered: "A1", question: "  may I rotate the PRODUCTION\nsigning key? ", text: "Erwin: yes, rotate it." })).toMatchObject({ ref: "D1" });
    expect((await state(f, project.id, ref)).dashboard).toBe(0);
  });

  it("a blocker re-filed while the record is made is refused, even with the same question", async () => {
    const { f, project, threadId } = await blockedWorker();
    const svc = f.service as unknown as { workerLead: (...args: unknown[]) => Promise<string | null> };
    const lead = svc.workerLead.bind(f.service);
    let calls = 0;
    svc.workerLead = async (...args) => {
      if (++calls === 1) await f.service.report(threadId, { ...blocked, blocker: { question, context: "Prod keys are needed after all." } } as never);
      return lead(...args);
    };
    expect(await refused(f, { answered: "A1", question, text: said })).toMatch(/blocker changed since.*not saved/);
    expect(f.store.decisions(project.id)).toEqual([]);
  });

  it("an Inbox answer that lands while the record is being made wins; the record is refused", async () => {
    const { f, project } = await blockedWorker();
    const svc = f.service as unknown as { workerLead: (...args: unknown[]) => Promise<string | null> };
    const lead = svc.workerLead.bind(f.service);
    // answerBlocker's lead lookup, just before its write.
    let calls = 0;
    svc.workerLead = async (...args) => {
      const id = await lead(...args);
      if (++calls === 1) await f.service.answerBlocker(project.id, "A1", seen, "Use the staging keys.", "coordinator");
      return id;
    };
    expect(await refused(f, { answered: "A1", question, text: said })).toMatch(/already answered A1's blocker \(D1\)/);
    expect(f.store.decisions(project.id).map((d) => d.body.answer?.note)).toEqual(["Use the staging keys."]);
    // The record's lookup, and the Inbox answer's.
    expect(calls).toBe(2);
  });

  it("a coordinator replaced while the record is made is refused", async () => {
    const { f, project } = await blockedWorker();
    const svc = f.service as unknown as { workerLead: (...args: unknown[]) => Promise<string | null> };
    const lead = svc.workerLead.bind(f.service);
    let calls = 0;
    // The replacement commits during the lookup; answerBlocker still holds the old project record.
    svc.workerLead = async (...args) => {
      if (++calls === 1) f.store.setCoordinator(project.id, "next", "Switch model");
      return lead(...args);
    };
    expect(await refused(f, { answered: "A1", question, text: said })).toMatch(/coordinator was replaced.*not saved/);
    expect(calls).toBe(1);
    expect(f.store.decisions(project.id)).toEqual([]);
    expect(f.send).not.toHaveBeenCalled();
  });

  it("only the coordinator tab records it: never a discussion, the worker, a former coordinator or a thread outside the Adventure", async () => {
    const { f, project, ref, threadId } = await blockedWorker();
    const discussion = ((await f.harness.callRpc("discussionCreate", { projectId: project.id })) as { threadId: string }).threadId;
    expect(await refused(f, { answered: "A1", question, text: said }, discussion)).toMatch(/Only this Adventure's coordinator tab.*not saved/);
    expect(await refused(f, { answered: "A1", question, text: said }, threadId)).toMatch(/coordinator|lead/i);
    expect(await refused(f, { answered: "A1", question, text: said }, "stranger")).not.toBe("");
    await expect(f.service.recordChatBlockerAnswer(project.id, "A1", question, said, { author: "worker", threadId, assignment: 1 })).rejects.toThrow(/Only this Adventure's coordinator tab/);
    await expect(f.service.recordChatBlockerAnswer(project.id, "A1", question, said, { author: "coordinator", threadId: "stranger", assignment: null })).rejects.toThrow(/Only this Adventure's coordinator tab/);
    f.store.setCoordinator(project.id, "next", "Switch model");
    expect(await refused(f, { answered: "A1", question, text: said }, "coordinator")).not.toBe("");
    expect(f.store.decisions(project.id)).toEqual([]);
    expect(f.send).not.toHaveBeenCalled();
    expect((await state(f, project.id, ref)).dashboard).toBe(1);
  });

  it("needs the user's words and a card ref, and is not mixed with asking", async () => {
    const { f } = await blockedWorker();
    expect(await refused(f, { answered: "A1", question })).toMatch(/needs text/);
    expect(await refused(f, { answered: "A1", text: said })).toMatch(/needs question/);
    expect(await refused(f, { answered: "W1", question, text: said })).toMatch(/A# of the blocked report/);
    expect(await refused(f, { answered: "D1", question, text: said })).toMatch(/A# of the blocked report/);
    expect(await refused(f, { answered: "A1", question, text: said, context: "C." })).toMatch(/separate call/);
    expect(await refused(f, { answered: "A9", question, text: said })).toMatch(/Unknown assignment A9/);
  });

  it("is advertised on initiative_question with the use-only-a-real-answer rule", () => {
    return projectFixture().then(({ f }) => {
      const t = f.harness.registrations.agentTools.find((x) => x.name === "initiative_question")! as { description: string; inputSchema: any };
      expect(t.description).toContain('{answered:"A31",question:');
      expect(t.description).toMatch(/only after the user actually answered/);
      expect(Object.keys(t.inputSchema.properties)).toEqual(expect.arrayContaining(["answered", "text"]));
    });
  });
});
