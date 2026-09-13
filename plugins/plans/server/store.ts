import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { planSchema, type Plan } from "../contract";
import { randomUUID } from "node:crypto";

export const PLAN_CONTENT_LIMIT = 2_000_000;
export function planContentBytes(plan: Plan): number {
  const bytes = (text: string) => Buffer.byteLength(text);
  return plan.versions.reduce((total, version) => total + bytes(version.markdown) + bytes(version.summary) + bytes(version.reviewHeading ?? "") + bytes(version.reviewSummary ?? "") + version.resolves.reduce((sum, id) => sum + bytes(id), 0), 0)
    + plan.comments.reduce((total, item) => total + bytes(item.body) + bytes(item.quote) + item.replies.reduce((sum, reply) => sum + bytes(reply.body), 0), 0);
}

export const MIGRATIONS = [
  "CREATE TABLE plans (id TEXT PRIMARY KEY, body TEXT NOT NULL)",
  "CREATE TABLE deliveries (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL)",
  "ALTER TABLE deliveries ADD COLUMN decision TEXT",
  "CREATE TABLE waits (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, expires_at INTEGER NOT NULL)",
  "CREATE TABLE outbox (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL)",
  "CREATE INDEX outbox_plan_state ON outbox (plan_id, state, next_attempt_at)",
  "DROP TABLE waits",
  "DROP TABLE deliveries",
];

export function createStore(bb: BbPluginApi) {
  const db = bb.storage.database();
  // Keep statement indexes stable, but preserve old feedback before either DROP.
  bb.storage.migrate(db, MIGRATIONS.slice(0, 6));
  const decode = (row: { body: string }) => planSchema.parse(JSON.parse(row.body));
  const all = () => (db.prepare("SELECT body FROM plans ORDER BY rowid DESC").all() as { body: string }[]).map(decode);
  const get = (id: string): Plan => {
    const row = db.prepare("SELECT body FROM plans WHERE id = ?").get(id) as { body: string } | undefined;
    if (!row) throw new Error("Plan not found.");
    return repairDelivery(decode(row));
  };
  const write = (plan: Plan, guard = true, increment = true) => {
    const parsed = planSchema.parse(plan);
    if (increment) {
      const current = db.prepare("SELECT body FROM plans WHERE id = ?").get(plan.id) as { body: string } | undefined;
      parsed.revision = Math.max(parsed.revision, current ? decode(current).revision : 0) + 1;
    }
    const body = JSON.stringify(parsed);
    if (guard && planContentBytes(parsed) > PLAN_CONTENT_LIMIT) throw new Error("This plan has reached the history limit. Create a new plan to continue.");
    db.prepare("INSERT INTO plans (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body").run(plan.id, body);
    return parsed;
  };
  const changed = (id: string) => bb.realtime.publish("plans-changed", { id });
  const save = (plan: Plan) => write({ ...plan, updatedAt: Date.now() });
  const saveDelivery = (plan: Plan) => write({ ...get(plan.id), delivery: plan.delivery }, false);
  const warn = (message: string) => bb.log.warn(message);
  const repairDelivery = (plan: Plan): Plan => {
    const rows = db.prepare("SELECT payload FROM outbox WHERE plan_id = ? AND kind = 'annotation' AND state = 'delivered'").all(plan.id) as { payload: string }[];
    let repaired = false;
    for (const row of rows) {
      const { event, deliveredAt } = JSON.parse(row.payload);
      const item = plan.comments.find((item) => item.id === event.annotationId);
      if (item && item.deliveredAt === null) { item.deliveredAt = deliveredAt; repaired = true; }
    }
    if (!repaired) return plan;
    try { return write(plan, false); }
    catch (error) {
      warn(`Plan ${plan.id} delivery metadata repair could not be saved: ${String(error)}`);
      // The durable outbox still governs edit and withdrawal decisions.
      return plan;
    }
  };
  // Old receipts have no dispatch time. Record recovery time once as a fallback.
  db.prepare("UPDATE outbox SET payload = json_set(payload, '$.deliveredAt', ?) WHERE state = 'delivered' AND json_extract(payload, '$.deliveredAt') IS NULL").run(Date.now());
  // Persist defaults and stable annotation numbers once, including old JSON rows.
  db.transaction(() => {
    for (const stored of all()) {
      const plan = repairDelivery(stored);
      if (planContentBytes(plan) > PLAN_CONTENT_LIMIT) warn(`Plan ${plan.id} exceeds the history limit; preserving the saved content during migration.`);
      write(plan, false, false);
      if (plan.status === "approved" || !plan.threadId) continue;
      for (const item of plan.comments) {
        if (item.deliveredAt !== null || item.state === "withdrawn") continue;
        const exists = db.prepare("SELECT id FROM outbox WHERE plan_id = ? AND json_extract(payload, '$.event.annotationId') = ? LIMIT 1").get(plan.id, item.id);
        if (exists) continue;
        const event = { kind: "annotation", annotationId: item.id, number: item.number, annotationKind: item.kind, quote: item.quote, body: item.body, revision: item.revision ?? 0 };
        db.prepare("INSERT INTO outbox (id, plan_id, kind, payload, state, attempts, next_attempt_at) VALUES (?, ?, 'annotation', ?, 'pending', 0, ?)")
          .run(randomUUID(), plan.id, JSON.stringify({ event, createdAt: Date.now() }), Date.now() + 1_500);
      }
    }
    if (db.prepare("SELECT name FROM sqlite_master WHERE name = 'deliveries'").get()) {
      const pending = db.prepare("SELECT id FROM deliveries WHERE state = 'pending' ORDER BY id").all() as { id: string }[];
      if (pending.length) warn(`Dropping old pending deliveries: ${pending.map((row) => row.id).join(", ")}. Unsent annotations have been moved to the outbox.`);
    }
  })();
  bb.storage.migrate(db, MIGRATIONS);
  return { db, all, get, save, saveDelivery, changed, warn };
}
export type PlanStore = ReturnType<typeof createStore>;
