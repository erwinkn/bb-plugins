import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { MIGRATIONS } from "../lib/store";
import { projectFixture } from "./fake-native";

// W573: BB queues a decision's notice while the coordinator is busy, and the send-time receipt says
// "queued". The sweep reads it back like a report notice: queue row gone and a turn carrying the
// notice's op taken → sent; queue row gone and no such turn → uncertain; row still there → left.
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const coordinator = { author: "coordinator" as const, threadId: "coordinator", assignment: null };
let seq = 9000;

/** An open question the user answers while BB queues the notice as `qm7`. */
async function answered() {
  const { f, project } = await projectFixture();
  const q = f.service.recordQuestion(project.id, {
    title: "Writer home", humanAttention: "needs-opinion", question: "Which checkout?", context: "Choose the writer home",
    options: [{ label: "Main", consequences: "One writer" }],
  }, coordinator);
  f.queueSend("qm7");
  await f.service.answerOpinion(project.id, q.ref, { choice: "Main", note: "Linux checkout" });
  f.queued.set("coordinator", [{ id: "qm7", payload: { kind: "inline" }, content: [] } as never]);
  return { f, project, q };
}
const receipt = (f: Fx, projectId: string, num: number) => f.store.decisionItem(projectId, num)!.notification!;
/** BB dispatched the queued message as a turn request, and then took it, refused it, or said nothing. */
const dispatched = (f: Fx, outcome: "accepted" | "rejected" | "unresolved") => {
  const sent = f.send.mock.calls[0][0];
  const requestId = `creq_${++seq}`;
  const row = (type: string, data: Record<string, unknown>) => f.history.push({ type, threadId: "coordinator", seq: ++seq, createdAt: Date.now(), data });
  row("client/turn/requested", { requestId, initiator: "agent", input: sent.input });
  if (outcome === "accepted") row("turn/input/accepted", { clientRequestId: requestId });
  if (outcome === "rejected") row("client/turn/rejected", { requestId });
};
/** The receipt was written long enough ago for the log to hold BB's verdict. */
const aged = (f: Fx) => f.store.db.prepare("UPDATE knowledge SET updated_at = updated_at - 60000").run();

describe("W573 queued decision receipts", () => {
  it("a receipt stays queued while BB's queue still holds the message", async () => {
    const { f, project, q } = await answered();
    aged(f);
    await f.service.settleDecisionReceipts();
    expect(receipt(f, project.id, q.num)).toMatchObject({ state: "queued", queuedId: "qm7" });
  });

  it("queued becomes sent once BB took the turn that carries the notice", async () => {
    const { f, project, q } = await answered();
    f.queued.set("coordinator", []);
    dispatched(f, "accepted");
    await f.service.checkWorkers();
    expect(receipt(f, project.id, q.num)).toEqual({ op: receipt(f, project.id, q.num).op, state: "sent", coordinatorThreadId: "coordinator" });
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("queued becomes uncertain when the row is gone and the log has no such turn", async () => {
    const { f, project, q } = await answered();
    f.queued.set("coordinator", []);
    // Too soon: the log may not have caught up with the dispatch.
    await f.service.settleDecisionReceipts();
    expect(receipt(f, project.id, q.num).state).toBe("queued");
    aged(f);
    await f.service.settleDecisionReceipts();
    expect(receipt(f, project.id, q.num).state).toBe("uncertain");
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("a turn BB refused with no retry is failed, so the answer can be sent again", async () => {
    const { f, project, q } = await answered();
    f.queued.set("coordinator", []);
    dispatched(f, "rejected");
    await f.service.settleDecisionReceipts();
    expect(receipt(f, project.id, q.num).state).toBe("failed");
  });

  it("a request BB has not answered yet is left queued", async () => {
    const { f, project, q } = await answered();
    f.queued.set("coordinator", []);
    dispatched(f, "unresolved");
    await f.service.settleDecisionReceipts();
    expect(receipt(f, project.id, q.num).state).toBe("queued");
  });

  it("a turn carrying another notice's op does not settle this one", async () => {
    const { f, project, q } = await answered();
    f.queued.set("coordinator", []);
    f.history.push({ type: "client/turn/requested", threadId: "coordinator", seq: ++seq, createdAt: Date.now(), data: { requestId: "creq_other", initiator: "agent", input: [{ type: "text", text: "Your answer\n\n[initiatives:op_other]" }] } });
    f.history.push({ type: "turn/input/accepted", threadId: "coordinator", seq: ++seq, createdAt: Date.now(), data: { clientRequestId: "creq_other" } });
    aged(f);
    await f.service.settleDecisionReceipts();
    expect(receipt(f, project.id, q.num).state).toBe("uncertain");
  });

  it("an old decision reads the log from the send, not from its creation, however busy the coordinator was since", async () => {
    const { f, project } = await projectFixture();
    const q = f.service.recordQuestion(project.id, {
      title: "Old", humanAttention: "needs-opinion", question: "Which?", context: "Old question",
      options: [{ label: "Main", consequences: "One" }],
    }, coordinator);
    // Asked two days ago; the coordinator then handled 1,200 turns before the user answered.
    f.store.db.prepare("UPDATE knowledge SET created_at = ? WHERE project_id = ? AND num = ?").run(Date.now() - 2 * 86_400_000, project.id, q.num);
    for (let i = 0; i < 1200; i++)
      f.history.push({ type: "client/turn/requested", threadId: "coordinator", seq: ++seq, createdAt: Date.now() - 3_600_000, data: { requestId: `creq_busy${i}`, initiator: "agent", input: [{ type: "text", text: "unrelated" }] } });
    f.queueSend("qm7");
    await f.service.answerOpinion(project.id, q.ref, { choice: "Main", note: "" });
    f.queued.set("coordinator", []);
    aged(f);
    await f.service.settleDecisionReceipts();
    expect(receipt(f, project.id, q.num).state).toBe("uncertain");
  });

  it("a newer notice owns the record: the older op's verdict never overwrites it", async () => {
    const { f, project, q } = await answered();
    f.queued.set("coordinator", []);
    dispatched(f, "accepted");
    // While the old receipt is read back, the decision gets a newer notice.
    const newer = { op: "op_newer", state: "pending" as const, coordinatorThreadId: "coordinator" };
    f.queued.get = () => { f.store.updateDecision(project.id, q.num, { notification: newer }); return []; };
    await f.service.settleDecisionReceipts();
    expect(receipt(f, project.id, q.num)).toEqual(newer);
  });
});

describe("W573 migration", () => {
  it("is appended after main's 110 migrations, so a database already at main still loads and gains the column", () => {
    const ledger = MIGRATIONS.slice(0, 110);
    expect(MIGRATIONS[110]).toBe("ALTER TABLE knowledge ADD COLUMN decision_notification_at INTEGER");
    const db = new Database(":memory:");
    const host = createFakePluginHost();
    host.bb.storage.migrate(db, ledger);
    expect(db.prepare("SELECT name FROM pragma_table_info('knowledge')").pluck().all()).not.toContain("decision_notification_at");
    host.bb.storage.migrate(db, MIGRATIONS);
    expect(db.prepare("SELECT name FROM pragma_table_info('knowledge')").pluck().all()).toContain("decision_notification_at");
    expect(db.prepare("SELECT COUNT(*) FROM _bb_migrations").pluck().get()).toBe(MIGRATIONS.length);
  });
});
