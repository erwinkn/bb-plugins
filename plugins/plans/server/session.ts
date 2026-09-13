import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { renderMessage } from "../lib/message";
import type { PlanStore } from "./store";
import type { Outbox, OutboxItem } from "./outbox";

// These timing options are test overrides.
export interface SessionOptions { interactionChunkMs?: number; holdRetryMs?: number }
const textInput = (text: string) => [{ type: "text" as const, text, mentions: [] }];
const missingRow = (error: unknown) => /not found|no longer|does not exist|\b404\b|row.*gone/i.test(String(error));
const revisions = (items: OutboxItem[]) => Object.fromEntries(items.flatMap((item) =>
  "revision" in item.event ? [[item.id, item.event.revision ?? 0]] : []));
const unavailableNotice = "The linked thread is archived or deleted. Feedback was not delivered.";

/** One serial sender and one detached attention prompt per plan. */
export class LiveSession {
  private timer?: ReturnType<typeof setTimeout>;
  private firstEventAt?: number;
  private controller?: AbortController;
  private disposed = false;
  private paused = false;
  private inFlight?: Promise<void>;
  private dispatchedRows = new Map<string, string>();
  private updatingRow?: string;
  private recovering = false;
  private holdTimer?: ReturnType<typeof setTimeout>;
  private cancelledRows = new Set<string>();
  private restoreHold = false;
  constructor(readonly id: string, private bb: BbPluginApi, private store: PlanStore, private outbox: Outbox, private options: SessionOptions = {}) {}

  get busy() { return !!this.inFlight; }
  release() {
    this.controller?.abort(); this.controller = undefined;
    clearTimeout(this.holdTimer);
  }
  /** Refresh an already-visible prompt without creating one during agent work. */
  refreshHold() { if (this.controller) { this.release(); this.hold(); } }
  hold() {
    const plan = this.store.get(this.id);
    if (this.disposed || plan.status === "approved" || !plan.threadId || this.controller) return;
    // Do not put a new interaction in front of an already queued message.
    if (this.store.get(this.id).delivery.queuedMessageId) return;
    const controller = new AbortController();
    this.controller = controller;
    void this.runHold(controller);
  }
  private async runHold(controller: AbortController) {
    while (!controller.signal.aborted && !this.disposed) {
      const plan = this.store.get(this.id);
      if (plan.status === "approved" || !plan.threadId) break;
      const version = plan.versions.at(-1)!;
      try {
        const result = await this.bb.ui.requestInput({
          threadId: plan.threadId, rendererId: "plan-review", title: `Plan: ${version.reviewHeading ?? plan.title}`,
          payload: { planId: plan.id, versionId: version.id, title: plan.title, versionNumber: version.number, reviewSummary: version.reviewSummary },
          timeoutMs: Math.min(this.options.interactionChunkMs ?? 3_600_000, 3_600_000),
        }, { signal: controller.signal });
        if (controller.signal.aborted || this.disposed || result.outcome === "submitted" || result.reason === "user") break;
        if (result.reason === "timeout") continue;
      } catch (error) {
        if (controller.signal.aborted || this.disposed) break;
        this.bb.log.warn(`Plan review prompt failed: ${String(error)}`);
      }
      // Avoid spinning when core cannot display an interaction yet.
      await new Promise<void>((resolve) => {
        const finish = () => { clearTimeout(this.holdTimer); controller.signal.removeEventListener("abort", finish); resolve(); };
        controller.signal.addEventListener("abort", finish, { once: true });
        this.holdTimer = setTimeout(finish, this.options.holdRetryMs ?? 15_000);
      });
    }
    if (this.controller === controller) this.controller = undefined;
  }
  resume() { this.paused = false; this.recovering = true; this.schedule(false); }
  async pause() { this.paused = true; clearTimeout(this.timer); this.release(); await this.inFlight; }
  private work() {
    const rows = this.outbox.list(this.id);
    const delivery = this.store.get(this.id).delivery;
    return rows.filter((item) => item.state === "pending" || (delivery.itemIds.includes(item.id) && (item.state === "dropped" || this.recovering)));
  }
  schedule(coalesce = true) {
    if (this.disposed || this.paused) return;
    const pending = this.work();
    if (!pending.length) return;
    const now = Date.now();
    this.firstEventAt ??= now;
    const retryAt = Math.max(0, ...pending.filter((item) => item.attempts > 0).map((item) => item.nextAttemptAt));
    const due = retryAt > now ? retryAt : coalesce ? Math.min(now + 1_500, this.firstEventAt + 5_000) : Math.max(now, Math.min(...pending.map((item) => item.nextAttemptAt)));
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, Math.max(0, due - now));
  }
  /** The user deleted a queued row on this plan's thread. Matching rows are never resent. */
  cancelled(rowId: string) {
    if (this.disposed) return;
    // While a send is in flight the deleted row can be the one it just created
    // before its pointer was persisted; record it and let flush() settle it.
    if (this.store.get(this.id).delivery.queuedMessageId !== rowId && !this.busy) return;
    this.cancelledRows.add(rowId);
    if (!this.busy) this.applyCancellations();
  }
  private applyCancellations() {
    let applied = false;
    for (const rowId of this.cancelledRows) {
      const plan = this.store.get(this.id);
      if (plan.delivery.queuedMessageId === rowId) {
        const ids = plan.delivery.itemIds;
        this.store.db.transaction(() => {
          this.outbox.state(ids, "cancelled");
          plan.delivery = { ...plan.delivery, queuedMessageId: null, queuedUpdatedAt: null, itemIds: [], itemRevisions: {} };
          this.store.saveDelivery(plan);
        })();
        this.store.changed(this.id);
        applied = true;
      }
      this.cancelledRows.delete(rowId);
    }
    // The thread has nothing queued from this plan, so the review prompt can come back.
    if (applied) this.hold();
  }
  /** The thread came back from the archive. Dropped feedback stays dropped. */
  unarchived() {
    if (this.disposed) return;
    const plan = this.store.get(this.id);
    if (plan.delivery.notice === unavailableNotice) {
      plan.delivery.notice = null; this.store.saveDelivery(plan); this.store.changed(this.id);
    }
    if (plan.status === "approved") return;
    this.release(); this.hold();
  }
  dispatched(rowId: string, text: string) {
    const plan = this.store.get(this.id);
    if (this.busy) this.dispatchedRows.set(rowId, text);
    // The update response decides which snapshot actually reached the thread.
    if (this.updatingRow === rowId) return;
    if (plan.delivery.queuedMessageId !== rowId) return;
    this.reconcile(plan.delivery.itemIds, plan.delivery.itemRevisions, text);
    this.store.changed(this.id); this.schedule();
  }
  private reconcile(ids: string[], deliveredRevisions: Record<string, number> = {}, text?: string) {
    const plan = this.store.get(this.id);
    const selected = this.outbox.list(this.id).filter((item) => ids.includes(item.id) && item.state !== "delivered");
    // Persist corrections before the receipt. This also makes repeated dispatch
    // notifications harmless if the document metadata could not be saved.
    for (const row of selected) {
      const event = row.event;
      if (event.kind !== "annotation" && event.kind !== "edited") continue;
      const item = plan.comments.find((item) => item.id === event.annotationId);
      if (!item) continue;
      const correctionId = `${row.id}:correction:${item.revision ?? 0}:${item.state === "withdrawn" ? "withdrawn" : "edited"}`;
      if (this.outbox.list(this.id).some((item) => item.id === correctionId)) continue;
      if (item.state === "withdrawn" && row.state === "dropped"
        && (text === undefined || text.split("\n").some((line) => line.startsWith(`#${item.number} `)))) {
        this.outbox.add(this.id, { kind: "withdrawn", annotationId: item.id, number: item.number }, correctionId);
      } else if (item.state !== "withdrawn" && (item.revision ?? 0) > (deliveredRevisions[row.id] ?? 0)) {
        this.outbox.add(this.id, { kind: "edited", annotationId: item.id, number: item.number, quote: item.quote, body: item.body, revision: item.revision ?? 0 }, correctionId);
      }
    }
    this.outbox.delivered(this.id, ids);
  }
  async flush() {
    if (this.disposed || this.paused) return;
    if (this.inFlight) { await this.inFlight; this.schedule(false); return; }
    this.firstEventAt = undefined;
    this.inFlight = Promise.resolve().then(() => this.deliver());
    try { await this.inFlight; } finally {
      this.inFlight = undefined; this.dispatchedRows.clear();
      if (!this.disposed && this.cancelledRows.size) this.applyCancellations();
      // hold() is a no-op while a newer batch sits in the queue.
      if (!this.disposed && this.restoreHold) { this.restoreHold = false; this.hold(); }
      if (!this.disposed) this.schedule(false);
    }
  }
  private async deliver() {
    let pending = this.outbox.list(this.id).filter((item) => item.state === "pending" && (!item.attempts || item.nextAttemptAt <= Date.now()));
    const work = this.work();
    if (!work.length) { this.recovering = false; return; }
    this.release();
    try {
      let plan = this.store.get(this.id);
      if (!plan.threadId) {
        this.outbox.delivered(this.id, pending.map((item) => item.id)); this.store.changed(this.id); return;
      }
      const thread = await this.bb.sdk.threads.get({ threadId: plan.threadId });
      plan = this.store.get(this.id);
      const currentPending = new Set(this.outbox.list(this.id).filter((item) => item.state === "pending").map((item) => item.id));
      pending = pending.filter((item) => currentPending.has(item.id));
      if (thread.archivedAt !== null || thread.deletedAt !== null) {
        this.outbox.state(this.outbox.list(this.id).filter((item) => item.state === "pending" || item.state === "queued").map((item) => item.id), "dropped");
        plan = this.store.get(this.id);
        plan.delivery = { queuedMessageId: null, queuedUpdatedAt: null, itemIds: [], itemRevisions: {}, notice: unavailableNotice };
        this.store.saveDelivery(plan); this.store.changed(this.id); this.recovering = false; return;
      }
      if (plan.delivery.notice === unavailableNotice) { plan.delivery.notice = null; this.store.saveDelivery(plan); }
      if (this.recovering && plan.delivery.queuedMessageId && plan.threadId) {
        const rows = await this.bb.sdk.threads.queuedMessages.list({ threadId: plan.threadId });
        const row = rows.find((item) => item.id === plan.delivery.queuedMessageId);
        if (!row) {
          const oldIds = plan.delivery.itemIds;
          this.reconcile(oldIds, plan.delivery.itemRevisions);
          pending = pending.filter((item) => !oldIds.includes(item.id));
        } else {
          plan = this.store.get(this.id); plan.delivery.queuedUpdatedAt = row.updatedAt; this.store.saveDelivery(plan);
        }
        this.store.changed(this.id);
        plan = this.store.get(this.id);
      }
      this.recovering = false;
      if (plan.delivery.queuedMessageId && (pending.length || work.some((item) => item.state === "dropped"))) {
        const rowId = plan.delivery.queuedMessageId;
        const all = this.outbox.list(this.id).filter((item) => item.state === "queued" || pending.some((next) => next.id === item.id));
        try {
          if (!all.length) {
            await this.bb.sdk.threads.queuedMessages.delete({ threadId: plan.threadId!, queuedMessageId: rowId });
            plan = this.store.get(this.id);
            plan.delivery = { ...plan.delivery, queuedMessageId: null, queuedUpdatedAt: null, itemIds: [], itemRevisions: {} };
            this.store.saveDelivery(plan); this.store.changed(this.id); return;
          }
          this.updatingRow = rowId;
          const result = await this.bb.sdk.threads.queuedMessages.update({
            threadId: plan.threadId!, queuedMessageId: rowId,
            expectedUpdatedAt: plan.delivery.queuedUpdatedAt!, input: textInput(renderMessage(plan, all.map((item) => item.event))),
          });
          plan = this.store.get(this.id);
          plan.delivery = { ...plan.delivery, queuedMessageId: rowId, queuedUpdatedAt: result.updatedAt, itemIds: all.map((item) => item.id), itemRevisions: revisions(all) };
          this.store.db.transaction(() => { this.outbox.state(plan.delivery.itemIds, "queued"); this.store.saveDelivery(plan); })();
          if (this.dispatchedRows.has(rowId)) {
            // The append succeeded before dispatch. The row carried this batch too.
            this.reconcile(all.map((item) => item.id), revisions(all), this.dispatchedRows.get(rowId));
          }
          this.store.changed(this.id); return;
        } catch (error) {
          if (!missingRow(error) && !this.dispatchedRows.has(rowId)) {
            // Refresh the CAS token on the next attempt after a concurrent edit.
            this.recovering = true; throw error;
          }
          // A gone row cannot be appended. Do not replay the batch it already held.
          const oldIds = plan.delivery.itemIds;
          if (this.cancelledRows.has(rowId)) {
            // The user deleted the row; its batch was never delivered.
            this.store.db.transaction(() => {
              this.outbox.state(oldIds, "cancelled");
              plan = this.store.get(this.id);
              plan.delivery = { ...plan.delivery, queuedMessageId: null, queuedUpdatedAt: null, itemIds: [], itemRevisions: {} };
              this.store.saveDelivery(plan);
            })();
            this.cancelledRows.delete(rowId); this.restoreHold = true;
          } else this.reconcile(oldIds, plan.delivery.itemRevisions, this.dispatchedRows.get(rowId));
          plan = this.store.get(this.id);
          pending = pending.filter((item) => !oldIds.includes(item.id));
        } finally { this.updatingRow = undefined; }
      }
      if (!pending.length) return;
      const input = textInput(renderMessage(plan, pending.map((item) => item.event)));
      let result;
      try {
        result = await this.bb.sdk.threads.send({ threadId: plan.threadId!, mode: plan.deliveryMode, input });
      } catch (error) {
        if (plan.deliveryMode !== "steer-if-active" || !/(?:steer|steering).*(?:unsupported|not supported|not support)|(?:unsupported|not supported|not support).*(?:steer|steering)/i.test(String(error))) throw error;
        plan = this.store.get(this.id);
        plan.delivery.notice = "This provider does not support steering. This message uses queue-if-active.";
        this.store.saveDelivery(plan); this.store.changed(this.id);
        result = await this.bb.sdk.threads.send({ threadId: plan.threadId!, mode: "queue-if-active", input });
      }
      const ids = pending.map((item) => item.id);
      if (result.delivery === "queued" && !this.dispatchedRows.has(result.queuedMessage.id)) {
        if (this.cancelledRows.has(result.queuedMessage.id)) {
          // The row was deleted before its pointer could be saved; the batch was never delivered.
          this.store.db.transaction(() => {
            this.outbox.state(ids, "cancelled");
            plan = this.store.get(this.id);
            plan.delivery = { ...plan.delivery, queuedMessageId: null, queuedUpdatedAt: null, itemIds: [], itemRevisions: {} };
            this.store.saveDelivery(plan);
          })();
          this.cancelledRows.delete(result.queuedMessage.id); this.restoreHold = true;
        } else {
          plan = this.store.get(this.id);
          plan.delivery = { ...plan.delivery, queuedMessageId: result.queuedMessage.id, queuedUpdatedAt: result.queuedMessage.updatedAt, itemIds: ids, itemRevisions: revisions(pending) };
          this.store.db.transaction(() => { this.outbox.state(ids, "queued"); this.store.saveDelivery(plan); })();
        }
      } else this.outbox.delivered(this.id, ids);
      this.store.changed(this.id);
    } catch (error) {
      this.outbox.retry(work);
      this.store.changed(this.id);
      this.bb.log.warn(`Plan feedback not delivered; retrying: ${String(error)}`);
    }
  }
  async dispose() {
    this.disposed = true; clearTimeout(this.timer); this.release();
    await this.inFlight;
  }
}
