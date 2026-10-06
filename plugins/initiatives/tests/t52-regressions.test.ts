import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, Store } from "../lib/store";
import { ProjectsService } from "../lib/service";
import { decisionSchema } from "../lib/schema";
import { projectFixture, report } from "./fake-native";

const coordinator = { author: "coordinator" as const, threadId: "coordinator", assignment: null };
const repair = MIGRATIONS.find((sql) => sql.startsWith("UPDATE knowledge SET decision_owner=NULL, decision_review=NULL"))!;
const tentative = { title: "Index", humanAttention: "needs-opinion" as const, question: "Approve the tentative index?", context: "Still awaiting your choice.", outcome: "Tentatively use the existing index", options: [{ label: "Yes", consequences: "Keep the index" }] };
const rawRow = (db: Database.Database, table: "knowledge" | "assignments", project: string, num: number) =>
  db.prepare(`SELECT * FROM ${table} WHERE project_id=? AND num=?`).get(project, num) as Record<string, unknown>;

describe("T52 legacy history regressions", () => {
  it("a status-only patch keeps the raw legacy report and archives nothing", async () => {
    const { f, project } = await projectFixture();
    await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id).ref] });
    const a = f.store.assignments(project.id)[0];
    const raw = JSON.stringify({ ...report(), proposedKnowledge: [{ kind: "decision", title: "Original", body: "Keep me" }] });
    f.store.db.prepare("UPDATE assignments SET report=? WHERE project_id=? AND num=?").run(raw, project.id, a.num);
    f.store.updateAssignment(project.id, a.num, { state: "reported" });
    expect(rawRow(f.store.db, "assignments", project.id, a.num).report).toBe(raw);
    expect(f.store.assignment(project.id, a.num)!.report).not.toHaveProperty("proposedKnowledge");
    expect(f.store.db.prepare("SELECT COUNT(*) AS n FROM legacy_session_payloads").get()).toEqual({ n: 0 });
  });

  it("replacing a legacy report archives the exact old report text first", async () => {
    const { f, project } = await projectFixture();
    await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id).ref] });
    const a = f.store.assignments(project.id)[0];
    const old = { ...report(), proposedKnowledge: [{ kind: "fact", title: "Original", body: "Keep me" }] };
    f.store.db.prepare("UPDATE assignments SET report=? WHERE project_id=? AND num=?").run(JSON.stringify(old), project.id, a.num);
    const next = { ...report(), summary: "Replacement summary." };
    f.store.updateAssignment(project.id, a.num, { report: next });
    const archived = f.store.db.prepare("SELECT thread_id, payload FROM legacy_session_payloads").all() as { thread_id: string; payload: string }[];
    expect(archived).toHaveLength(1);
    expect(JSON.parse(archived[0].payload)).toEqual({ assignment: a.ref, report: JSON.stringify(old) });
    expect(archived[0].thread_id).toBe(a.threadId);
    expect(JSON.parse(rawRow(f.store.db, "assignments", project.id, a.num).report as string)).toEqual(next);
  });

  it("a fresh migration leaves an unanswered question with a tentative outcome unowned and answerable", async () => {
    const db = new Database(":memory:");
    const firstNew = MIGRATIONS.findIndex((s) => s.includes("ADD COLUMN decision_owner"));
    for (const sql of MIGRATIONS.slice(0, firstNew)) db.exec(sql);
    const store = new Store(db);
    store.createProject({ id: "p", name: "p", objective: "o", memberProjectIds: ["repo"], coordinatorThreadId: "c" });
    const body = JSON.stringify(decisionSchema.parse(tentative));
    const provenance = JSON.stringify({ author: "coordinator", threadId: "c", assignment: null });
    db.prepare("INSERT INTO knowledge VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("p", 1, "index", 1, "decision", "active", "project", "Index", body, "needs-opinion", "[]", null, provenance, null, 1, 1);
    for (const sql of MIGRATIONS.slice(firstNew)) db.exec(sql);
    expect(store.decisionItem("p", 1)).toMatchObject({ madeBy: null, review: null });
    expect(rawRow(db, "knowledge", "p", 1)).toMatchObject({ body, provenance });
    const answered = await new ProjectsService({} as never, store, {} as never).answerOpinion("p", "D1", { choice: "Yes", note: "", notify: false });
    expect(answered).toMatchObject({ status: "answered", madeBy: "user" });
    db.close();
  });

  it("repairs an already-migrated question in place, unblocking its task on answer", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id);
    const q = f.service.recordQuestion(project.id, { ...tentative, blocksTaskIds: [task.ref] }, coordinator);
    const db = f.store.db;
    // The state the faulty ownership pass left behind.
    db.prepare("UPDATE knowledge SET decision_owner='agent', decision_review='pending' WHERE project_id=? AND num=?").run(project.id, q.num);
    const before = rawRow(db, "knowledge", project.id, q.num);
    db.exec(repair);
    const after = rawRow(db, "knowledge", project.id, q.num);
    expect(after).toEqual({ ...before, decision_owner: null, decision_review: null });
    expect(f.store.task(project.id, task.num)?.status).toBe("blocked");
    await f.service.answerOpinion(project.id, q.ref, { choice: "Yes", note: "" });
    expect(f.store.decisionItem(project.id, q.num)).toMatchObject({ madeBy: "user", status: "answered" });
    expect(f.store.task(project.id, task.num)?.status).toBe("planned");
  });

  it("keeps explicit answers and later explicit reviews exactly as recorded", async () => {
    const { f, project } = await projectFixture();
    const answered = f.service.recordQuestion(project.id, tentative, coordinator);
    await f.service.answerOpinion(project.id, answered.ref, { choice: "Yes", note: "" });
    const reviewed = f.service.recordQuestion(project.id, tentative, coordinator);
    f.store.db.prepare("UPDATE knowledge SET decision_owner='agent', decision_review='pending' WHERE project_id=? AND num=?").run(project.id, reviewed.num);
    await f.service.reviewDecision(project.id, reviewed.ref, "okay");
    const before = f.store.db.prepare("SELECT * FROM knowledge ORDER BY num").all();
    f.store.db.exec(repair);
    expect(f.store.db.prepare("SELECT * FROM knowledge ORDER BY num").all()).toEqual(before);
    expect(f.store.decisionItem(project.id, answered.num)).toMatchObject({ madeBy: "user" });
    expect(f.store.decisionItem(project.id, reviewed.num)).toMatchObject({ madeBy: "agent", review: "okay" });
  });
});
