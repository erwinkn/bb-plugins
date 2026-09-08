import type Database from "better-sqlite3";
import { z } from "zod";
import { liveOperationSchema, type LiveOperation, type QuickAction } from "./quick-actions.ts";
import { actionReceiptSchema } from "./coordinator/envelopes.ts";

export const LIVE_ACTION_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS voice_action_groups (request_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, actor TEXT NOT NULL, actions_json TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS voice_action_steps (request_id TEXT NOT NULL, step INTEGER NOT NULL, action_json TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (request_id, step))`,
  `CREATE TABLE IF NOT EXISTS voice_workers (request_id TEXT NOT NULL, step INTEGER NOT NULL, conversation_id TEXT NOT NULL, thread_id TEXT UNIQUE, project_id TEXT NOT NULL, host_id TEXT NOT NULL, role TEXT NOT NULL, model TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, report_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (request_id, step))`,
];
export const stepResultSchema = z.object({
  status: z.enum(["succeeded", "failed", "unknown", "cancelled"]),
  speech: z.string(), detail: z.string(), threadIds: z.array(z.string()), receipts: z.array(actionReceiptSchema),
}).strict();
export type ActionResult = z.infer<typeof stepResultSchema>;
export const workerReportSchema = z.object({ outcome:z.enum(["complete","blocked","failed"]), speech:z.string().trim().min(1).max(500), detail:z.string().max(4000).optional() }).strict();
export interface WorkerRow {
  requestId: string; step: number; conversationId: string; threadId: string | null;
  projectId: string; hostId: string; role: string; model: string; title: string; status: string;
  createdAt: number; report: { outcome: string; speech: string; detail?: string } | null;
}

/** Durable effect identities come from the request + array position, not model-generated IDs. */
export class LiveActionStore {
  constructor(private readonly db: Database.Database, private readonly now: () => number = Date.now) {}
  admit(requestId: string, conversationId: string, actor: "live" | "coordinator", action: QuickAction) {
    const text = JSON.stringify(action);
    const inserted = this.db.prepare("INSERT OR IGNORE INTO voice_action_groups VALUES (?, ?, ?, ?, ?)").run(requestId, conversationId, actor, text, this.now()).changes === 1;
    const row = this.db.prepare("SELECT * FROM voice_action_groups WHERE request_id = ?").get(requestId) as {conversation_id:string;actor:string;actions_json:string};
    if (row.conversation_id !== conversationId || row.actor !== actor || row.actions_json !== text) throw new Error("This request already has a different recorded action group. Inspect its receipts; do not redispatch it.");
    return inserted;
  }
  results(requestId: string): (ActionResult | null)[] {
    return this.db.prepare("SELECT result_json FROM voice_action_steps WHERE request_id = ? ORDER BY step").all(requestId).map(value => {
      const row = value as {result_json:string|null}; return row.result_json ? stepResultSchema.parse(JSON.parse(row.result_json)) : null;
    });
  }
  step(requestId: string, step: number): { action: LiveOperation; status: string; result: ActionResult | null } | null {
    const row = this.db.prepare("SELECT * FROM voice_action_steps WHERE request_id = ? AND step = ?").get(requestId, step) as {action_json:string;status:string;result_json:string|null}|undefined;
    return row ? {action:liveOperationSchema.parse(JSON.parse(row.action_json)),status:row.status,result:row.result_json ? stepResultSchema.parse(JSON.parse(row.result_json)) : null} : null;
  }
  prepare(requestId: string, step: number, action: LiveOperation) {
    this.db.prepare("INSERT OR IGNORE INTO voice_action_steps VALUES (?, ?, ?, 'prepared', NULL, ?)").run(requestId, step, JSON.stringify(action), this.now());
    const existing = this.step(requestId, step)!;
    if (JSON.stringify(existing.action) !== JSON.stringify(action)) throw new Error("Recorded action arguments cannot change.");
    return existing;
  }
  claim(requestId: string, step: number): boolean {
    return this.db.prepare("UPDATE voice_action_steps SET status = 'executing', updated_at = ? WHERE request_id = ? AND step = ? AND status = 'prepared'").run(this.now(), requestId, step).changes === 1;
  }
  finish(requestId: string, step: number, result: ActionResult) {
    this.db.prepare("UPDATE voice_action_steps SET status = ?, result_json = ?, updated_at = ? WHERE request_id = ? AND step = ?").run(result.status, JSON.stringify(stepResultSchema.parse(result)), this.now(), requestId, step);
  }
  recent(conversationId: string) {
    return this.db.prepare("SELECT s.request_id AS requestId, s.step, s.status, s.result_json AS result FROM voice_action_steps s JOIN voice_action_groups g USING (request_id) WHERE g.conversation_id = ? ORDER BY g.created_at DESC, s.step LIMIT 20").all(conversationId).map(value => {
      const row = value as {requestId:string;step:number;status:string;result:string|null};
      const outcome=row.result ? stepResultSchema.parse(JSON.parse(row.result)) : null;
      return {...row,result:outcome ? {status:outcome.status,speech:outcome.speech,threadIds:outcome.threadIds,receipts:outcome.receipts} : null};
    });
  }
  reserveWorker(row: Omit<WorkerRow,"threadId"|"status"|"createdAt"|"report">) {
    this.db.prepare("INSERT OR IGNORE INTO voice_workers VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 'creating', NULL, ?, ?)").run(row.requestId,row.step,row.conversationId,row.projectId,row.hostId,row.role,row.model,row.title,this.now(),this.now());
  }
  workerAccepted(requestId: string, step: number, threadId: string) {
    this.db.prepare("UPDATE voice_workers SET thread_id = ?, status = 'active', updated_at = ? WHERE request_id = ? AND step = ?").run(threadId,this.now(),requestId,step);
  }
  workerStatus(requestId: string, step: number, status: string) {
    this.db.prepare("UPDATE voice_workers SET status = ?, updated_at = ? WHERE request_id = ? AND step = ?").run(status,this.now(),requestId,step);
  }
  report(threadId: string, report: NonNullable<WorkerRow["report"]>) {
    this.db.prepare("UPDATE voice_workers SET report_json = ?, updated_at = ? WHERE thread_id = ?").run(JSON.stringify(workerReportSchema.parse(report)),this.now(),threadId);
  }
  private decodeWorker(value: unknown): WorkerRow {
    const r = value as Record<string, unknown>;
    return {requestId:r.request_id as string,step:r.step as number,conversationId:r.conversation_id as string,threadId:r.thread_id as string|null,projectId:r.project_id as string,hostId:r.host_id as string,role:r.role as string,model:r.model as string,title:r.title as string,status:r.status as string,createdAt:r.created_at as number,report:r.report_json ? workerReportSchema.parse(JSON.parse(r.report_json as string)) : null};
  }
  workers(): WorkerRow[] {
    return this.db.prepare("SELECT * FROM voice_workers ORDER BY created_at DESC LIMIT 200").all().map(value => this.decodeWorker(value));
  }
  activeWorkers(): WorkerRow[] {
    return this.db.prepare("SELECT * FROM voice_workers WHERE status IN ('creating', 'active', 'unknown') ORDER BY created_at").all().map(value => this.decodeWorker(value));
  }
  activeWorkerCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM voice_workers WHERE status IN ('creating','active','unknown')").get() as {n:number}).n;
  }
  clearWorkerReport(threadId: string) {
    this.db.prepare("UPDATE voice_workers SET report_json = NULL WHERE thread_id = ?").run(threadId);
  }
  resumeWorker(threadId: string) {
    this.db.prepare("UPDATE voice_workers SET status = 'active', report_json = NULL, updated_at = ? WHERE thread_id = ?").run(this.now(),threadId);
  }
  workerForThread(threadId: string): WorkerRow | null {
    const row = this.db.prepare("SELECT * FROM voice_workers WHERE thread_id = ?").get(threadId);
    return row ? this.decodeWorker(row) : null;
  }
}
