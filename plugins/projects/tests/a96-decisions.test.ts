import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { MIGRATIONS, Store } from "../lib/store";
import { commandSchema } from "../lib/commands";
import { reportSchema, decisionFieldsSchema } from "../lib/schema";
import { READ_VIEWS } from "../lib/read";
import { DEFAULT_COORDINATOR_INSTRUCTIONS, DEFAULT_WORKER_INSTRUCTIONS } from "../lib/guidance";
import { projectFixture, report } from "./fake-native";

const coordinator = { author: "coordinator" as const, threadId: "coordinator", assignment: null };
const choice = (description = "Reuse the existing index.", madeBy: "agent" | "user" = "agent") => ({ decision: { description, madeBy } });
const config = (f: Awaited<ReturnType<typeof projectFixture>>["f"], id = "coordinator") => f.harness.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: f.threads.get(id)! }));

function legacyFixture(reviewed = false) {
  const db = new Database(":memory:");
  const firstNew = MIGRATIONS.findIndex(s => s.includes("ADD COLUMN decision_owner"));
  for (const migration of MIGRATIONS.slice(0, firstNew)) db.exec(migration);
  const rows = [
    { kind: "fact", status: "active", body: { text: "SDK fork is bounded." }, author: "coordinator" },
    { kind: "decision", status: "active", body: decisionFieldsSchema.parse({ title: "Agent choice", outcome: "Reuse the index", rationale: "Avoid a migration" }), author: "coordinator" },
    { kind: "decision", status: "active", body: decisionFieldsSchema.parse({ title: "User choice", outcome: "Use the main checkout", rationale: "One writer" }), author: "user" },
    { kind: "decision", status: "answered", body: { ...decisionFieldsSchema.parse({ title: "Home", humanAttention: "needs-opinion", question: "Which checkout?", context: "Choose a home" }), answer: { choice: "Main", note: "Linux", at: 50 } }, author: "coordinator" },
    { kind: "decision", status: "proposed", body: { text: "Worker implementation fork" }, author: "worker" },
    { kind: "decision", status: "active", body: decisionFieldsSchema.parse({ title: "Open", humanAttention: "needs-opinion", question: "Include private notes?", context: "Privacy matters" }), author: "coordinator" },
    { kind: "fact", status: "active", body: "{malformed", author: "worker" },
  ];
  rows.forEach((row, index) => db.prepare(`INSERT INTO knowledge VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "p", index + 1, `topic${index}`, 1, row.kind, row.status, "project", `legacy${index}`,
    typeof row.body === "string" ? row.body : JSON.stringify(row.body),
    (row.body as any).humanAttention ?? "none", "[]", null,
    JSON.stringify({ author: row.author, threadId: "c", assignment: null }), null, 1, 1,
  ));
  if (reviewed) db.prepare("INSERT INTO activity(project_id,at,kind,summary) VALUES(?,?,?,?)").run("p", 2, "decision", "You reviewed K2: Looks good.");
  const before = db.prepare("SELECT * FROM knowledge").all();
  for (const migration of MIGRATIONS.slice(firstNew)) db.exec(migration);
  return { db, before, store: new Store(db) };
}

describe("A96 lightweight decisions and safe history", () => {
  it("preserves every legacy byte, distinguishes user answers from agent choices, and archives non-decisions", () => {
    const { db, before, store } = legacyFixture();
    const after = db.prepare("SELECT * FROM knowledge").all() as Record<string, unknown>[];
    expect(after.map(({ decision_owner, decision_review, decision_review_message, decision_notification, ...original }) => original)).toEqual(before);
    const decisions = store.decisions("p");
    expect(decisions.map(d => [d.ref, d.madeBy, d.review])).toEqual([
      ["D2", "agent", "pending"], ["D3", "user", null], ["D4", "user", null], ["D6", null, null],
    ]);
    expect(decisions[2].description).toBe("Main · Linux");
    expect(decisions[2].provenance.author).toBe("coordinator");
    expect(store.decisionItem("p", 1)).toBeNull();
    expect(store.decisionItem("p", 5)).toBeNull();
    db.close();
  });

  it("preserves proven prior user acknowledgment without changing who made the agent choice", () => {
    const { db, store } = legacyFixture(true);
    expect(store.decisionItem("p", 2)).toMatchObject({ madeBy: "agent", review: "okay" });
    db.close();
  });

  it("records one or two sentences without title, quote, citation or rationale requirements", async () => {
    const { f, project } = await projectFixture();
    const parsed = commandSchema.parse({ action: "decision", ...choice() });
    expect(parsed).toEqual({ action: "decision", ...choice() });
    const item = f.service.recordDecision(project.id, choice(), coordinator);
    expect(item).toMatchObject({ ref: "D1", description: "Reuse the existing index.", madeBy: "agent", review: "pending" });
    expect(item.provenance.threadId).toBe("coordinator");
    const user = f.service.recordDecision(project.id, choice("Use GPT6.1 Sol High Fast.", "user"), coordinator);
    expect(user).toMatchObject({ ref: "D2", madeBy: "user", review: null });
  });

  it("new configurations advertise only initiative tools and current guidance", async () => {
    const { f, project } = await projectFixture();
    const c = await config(f);
    expect(c.tools.map(tool => tool.name)).toContain("initiative_decision");
    expect(c.tools.every(tool => tool.name.startsWith("initiative_"))).toBe(true);
    const [worker] = await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id).ref] });
    const w = await config(f, worker.threadId!);
    expect(w.tools.map(tool => tool.name).sort()).toEqual(["initiative_decision", "initiative_message", "initiative_progress", "initiative_read", "initiative_report"]);
    for (const instructions of [c.instructions!, w.instructions!, DEFAULT_COORDINATOR_INSTRUCTIONS, DEFAULT_WORKER_INSTRUCTIONS]) {
      expect(instructions).not.toMatch(/proposedKnowledge|knowledge-review|scoped knowledge|project_read|project_report/);
      expect(instructions.length).toBeLessThanOrEqual(4096);
    }
    expect(f.stop).not.toHaveBeenCalled();
  });

  it("workers distinguish their agent choices from explicitly stated user choices", async () => {
    const { f, project } = await projectFixture();
    const [worker] = await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id).ref] });
    const result = await f.harness.callAgentTool("initiative_decision", { action: "decision", ...choice() }, { threadId: worker.threadId! });
    expect(JSON.parse(result as string)).toMatchObject({ ref: "D1", madeBy: "agent", recordedBy: { author: "worker", threadId: worker.threadId! } });
    const stated = await f.harness.callAgentTool("initiative_decision", { action: "decision", ...choice("Erwin chose the Linux checkout.", "user") }, { threadId: worker.threadId! });
    expect(JSON.parse(stated as string)).toMatchObject({ madeBy: "user", review: null, recordedBy: { author: "worker", threadId: worker.threadId! } });
  });

  it("agent revisions cannot silently supersede an explicit user choice or another worker's choice", async () => {
    const { f, project } = await projectFixture();
    const user = f.service.recordDecision(project.id, choice("Use the main checkout.", "user"), coordinator);
    expect(() => f.service.recordDecision(project.id, { ...choice(), supersedes: user.ref }, coordinator)).toThrow(/cannot replace an explicit user/);
    expect(f.store.decisionItem(project.id, user.num)?.status).toBe("active");
    const agent = f.service.recordDecision(project.id, choice(), coordinator);
    const worker = { author: "worker" as const, threadId: "worker", assignment: null };
    expect(() => f.service.recordDecision(project.id, { ...choice(), supersedes: agent.ref }, worker)).toThrow(/revise only their own/);
    const original = f.service.recordDecision(project.id, choice("Use a narrow index."), worker);
    const revised = f.service.recordDecision(project.id, { ...choice("Use a smaller index."), supersedes: original.ref }, worker);
    expect(revised.supersedes).toBe(original.num);
    const confirmed = f.service.recordDecision(project.id, { ...choice("Use a new checkout.", "user"), supersedes: user.ref }, coordinator);
    expect(confirmed).toMatchObject({ madeBy: "user", supersedes: user.num });
  });

  it("Okay is bookkeeping and never sends or wakes anyone", async () => {
    const { f, project } = await projectFixture();
    const item = f.service.recordDecision(project.id, choice(), coordinator);
    const okay = await f.service.reviewDecision(project.id, item.ref, "okay");
    expect(okay).toMatchObject({ review: "okay", notification: null, reviewMessage: null });
    expect(f.send).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("Not okay requires a message at both contract and service boundaries", async () => {
    const { f, project } = await projectFixture();
    const item = f.service.recordDecision(project.id, choice(), coordinator);
    expect(commandSchema.safeParse({ action: "decision-review", decision: item.ref, verdict: "not-okay" }).success).toBe(false);
    await expect(f.service.reviewDecision(project.id, item.ref, "not-okay", "  ")).rejects.toThrow(/needs a message/);
    expect(f.store.decisionItem(project.id, item.num)?.review).toBe("pending");
    expect(f.send).not.toHaveBeenCalled();
  });

  it("Not okay saves the message and sends only to the current coordinator with a native receipt", async () => {
    const { f, project } = await projectFixture();
    const item = f.service.recordDecision(project.id, choice(), coordinator);
    f.queueSend("review-queue");
    const result = await f.service.reviewDecision(project.id, item.ref, "not-okay", "Use a smaller index instead.");
    expect(result).toMatchObject({ review: "not-okay", reviewMessage: "Use a smaller index instead.", notification: { state: "queued", coordinatorThreadId: "coordinator", queuedId: "review-queue" } });
    expect(f.send).toHaveBeenCalledTimes(1);
    const sent = f.send.mock.calls[0][0];
    expect(sent).toMatchObject({ threadId: "coordinator", mode: "steer-if-active" });
    expect(sent.input[0].text).toContain("Your review of D1");
    expect(sent.input[0].text).toContain("Use a smaller index instead.");
    await f.service.reviewDecision(project.id, item.ref, "not-okay", "Use a smaller index instead.");
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("a lost send response keeps uncertainty and the review rather than blindly sending twice", async () => {
    const { f, project } = await projectFixture();
    const item = f.service.recordDecision(project.id, choice(), coordinator);
    f.send.mockRejectedValueOnce(new Error("lost response"));
    const result = await f.service.reviewDecision(project.id, item.ref, "not-okay", "Change it.");
    expect(result.notification?.state).toBe("uncertain");
    await f.service.reviewDecision(project.id, item.ref, "not-okay", "Change it.");
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.store.decisionItem(project.id, item.num)?.reviewMessage).toBe("Change it.");
  });

  it("a definite send refusal is visible and permits a user retry", async () => {
    const { f, project } = await projectFixture();
    const item = f.service.recordDecision(project.id, choice(), coordinator);
    f.send.mockRejectedValueOnce(Object.assign(new Error("refused"), { status: 400 }));
    const result = await f.service.reviewDecision(project.id, item.ref, "not-okay", "Change it.");
    expect(result.notification?.state).toBe("failed");
    await f.service.reviewDecision(project.id, item.ref, "not-okay", "Change it.");
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.store.decisionItem(project.id, item.num)?.notification?.state).toBe("sent");
  });

  it("reviewing does not turn an agent choice into a user decision and user choices need no review", async () => {
    const { f, project } = await projectFixture();
    const agent = f.service.recordDecision(project.id, choice(), coordinator);
    expect((await f.service.reviewDecision(project.id, agent.ref, "okay")).madeBy).toBe("agent");
    const user = f.service.recordDecision(project.id, choice("Main checkout", "user"), coordinator);
    await expect(f.service.reviewDecision(project.id, user.ref, "okay")).rejects.toThrow(/Only agent/);
  });

  it("human answers become user choices, unblock named tasks, and remain retrievable by legacy refs", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id);
    const q = f.service.recordQuestion(project.id, { title: "Home", humanAttention: "needs-opinion", question: "Which checkout?", context: "Pick the writer home", blocksTaskIds: [task.ref], options: [{ label: "Main", consequences: "One writer" }] }, coordinator);
    expect(q.madeBy).toBeNull();
    // A migrated blocked task still names the old K reference.
    f.store.updateTask(project.id, task.num, { progress: `Waiting for your opinion on K${q.num}` });
    const result = await f.service.answerOpinion(project.id, "K1", { choice: "Main", note: "Linux" });
    expect(result).toMatchObject({ ref: "D1", madeBy: "user", description: "Main · Linux" });
    expect(f.store.task(project.id, task.num)?.status).toBe("planned");
    const read = await f.harness.callRpc("read", { projectId: project.id, view: "decisions", refs: ["K1"], detailed: true });
    expect((read as any).items[0]).toMatchObject({ ref: "D1", madeBy: "user", description: "Main · Linux" });
  });

  it("retained report aliases preserve old payloads without publishing rows or exposing removed fields", async () => {
    const { f, project } = await projectFixture();
    const [worker] = await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id).ref] });
    const payload = { ...report(), proposedKnowledge: [{ kind: "decision", title: "Old design choice", body: "A branch rationale" }] };
    expect(reportSchema.safeParse(payload).success).toBe(false);
    await f.harness.callAgentTool("project_report", payload, { threadId: worker.threadId! });
    expect(f.store.decisions(project.id)).toHaveLength(0);
    expect(f.store.assignments(project.id)[0].report).not.toHaveProperty("proposedKnowledge");
    const archived = f.store.db.prepare("SELECT payload FROM legacy_session_payloads").get() as { payload: string };
    expect(JSON.parse(archived.payload)).toEqual(payload);
    await expect(f.harness.callAgentTool("project_knowledge", { action: "fact", title: "Old", text: "Do not revive" }, { threadId: "coordinator" })).rejects.toThrow(/removed/);
    expect(READ_VIEWS).toContain("decisions");
    expect(READ_VIEWS).not.toContain("knowledge");
  });

  it("legacy read/progress handlers remain usable without a restart and decision retrieval stays bounded", async () => {
    const { f, project } = await projectFixture();
    const result = await f.harness.callAgentTool("project_read", { view: "tasks" }, { threadId: "coordinator" });
    expect(JSON.parse(result as string)).toMatchObject({ items: [], total: 0 });
    const archivedView = await f.harness.callAgentTool("project_read", { view: "knowledge" }, { threadId: "coordinator" });
    expect(JSON.parse(archivedView as string)).toMatchObject({ items: [], total: 0 });
    for (let i = 0; i < 25; i++) f.service.recordDecision(project.id, choice(`Agent choice ${i}`), coordinator);
    const page = await f.harness.callAgentTool("initiative_read", { view: "decisions" }, { threadId: "coordinator" });
    expect(JSON.parse(page as string)).toMatchObject({ total: 25, nextOffset: 20 });
    expect(JSON.parse(page as string).items).toHaveLength(20);
  });
});
