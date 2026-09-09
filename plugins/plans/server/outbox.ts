import { randomUUID } from "node:crypto";
import type { ReviewEvent } from "../lib/message";
import type { PlanStore } from "./store";

export interface OutboxItem {
  id: string; planId: string; event: ReviewEvent; state: "pending" | "queued" | "delivered" | "dropped";
  attempts: number; nextAttemptAt: number; createdAt: number; deliveredAt?: number;
}
interface Row { id: string; plan_id: string; payload: string; state: OutboxItem["state"]; attempts: number; next_attempt_at: number }
const decode = (row: Row): OutboxItem => ({
  id: row.id, planId: row.plan_id, ...JSON.parse(row.payload), state: row.state, attempts: row.attempts, nextAttemptAt: row.next_attempt_at,
});
const BACKOFF = [5_000, 30_000, 120_000, 300_000];
export function createOutbox(store: PlanStore) {
  const { db } = store;
  const list = (planId: string) => (db.prepare("SELECT * FROM outbox WHERE plan_id = ? ORDER BY rowid").all(planId) as Row[]).map(decode);
  const add = (planId: string, event: ReviewEvent, id: string = randomUUID()) => {
    const now = Date.now();
    db.prepare("INSERT INTO outbox (id, plan_id, kind, payload, state, attempts, next_attempt_at) VALUES (?, ?, ?, ?, 'pending', 0, ?)")
      .run(id, planId, event.kind, JSON.stringify({ event, createdAt: now }), now + 1_500);
    return id;
  };
  const state = (ids: string[], value: OutboxItem["state"]) => {
    const update = db.prepare("UPDATE outbox SET state = ? WHERE id = ?");
    for (const id of ids) {
      update.run(value, id);
      if (value === "delivered") db.prepare("UPDATE outbox SET payload = json_set(payload, '$.deliveredAt', COALESCE(json_extract(payload, '$.deliveredAt'), ?)) WHERE id = ?").run(Date.now(), id);
      if (value === "queued" || value === "delivered") db.prepare("UPDATE outbox SET attempts = 0 WHERE id = ?").run(id);
    }
  };
  const replace = (item: OutboxItem, event: ReviewEvent) => db.prepare("UPDATE outbox SET payload = ? WHERE id = ?")
    .run(JSON.stringify({ event, createdAt: item.createdAt, deliveredAt: item.deliveredAt }), item.id);
  const retry = (items: OutboxItem[]) => {
    for (const item of items) db.prepare("UPDATE outbox SET attempts = attempts + 1, next_attempt_at = ? WHERE id = ? AND state <> 'delivered'")
      .run(Date.now() + BACKOFF[Math.min(item.attempts, BACKOFF.length - 1)]!, item.id);
  };
  const delivered = (planId: string, ids: string[]) => {
    // The durable receipt must never roll back with a document write.
    if (ids.length) db.prepare(`UPDATE outbox SET state = 'delivered', attempts = 0, payload = json_set(payload, '$.deliveredAt', COALESCE(json_extract(payload, '$.deliveredAt'), ?)) WHERE plan_id = ? AND id IN (${ids.map(() => "?").join(",")})`).run(Date.now(), planId, ...ids);
    try {
      const plan = store.get(planId);
      const selected = list(planId).filter((item) => ids.includes(item.id));
      for (const { event, deliveredAt } of selected) {
        if (event.kind !== "annotation" && event.kind !== "edited" && event.kind !== "reply") continue;
        const annotation = plan.comments.find((item) => item.id === event.annotationId);
        if (!annotation) continue;
        if (event.kind !== "reply") annotation.deliveredAt ??= deliveredAt!;
        else {
          const reply = annotation.replies.find((item) => item.id === event.replyId);
          if (reply) reply.deliveredAt ??= deliveredAt!;
        }
      }
      plan.delivery.itemIds = plan.delivery.itemIds.filter((id) => !ids.includes(id));
      for (const id of ids) delete plan.delivery.itemRevisions?.[id];
      if (!plan.delivery.itemIds.length) {
        plan.delivery.queuedMessageId = null; plan.delivery.queuedUpdatedAt = null;
      }
      store.save(plan);
    } catch (error) { store.warn(`Plan ${planId} delivery receipt saved; document metadata update failed: ${String(error)}`); }
  };
  return { list, add, state, replace, retry, delivered };
}
export type Outbox = ReturnType<typeof createOutbox>;
