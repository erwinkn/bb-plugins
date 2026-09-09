import { isLegacyCoordinator } from "./legacy-watch-import.ts";
import { randomUUID } from "node:crypto";
import type { BbPluginApi, PluginThreadEventPayloads } from "@get-bb/plugin-sdk";
import { critical, LiveStore, type InboxKind, type InboxRow, type OfferOutcome, type OfferRow, type OperationRow, type WatchRow } from "./live-store.ts";
import { Operations } from "./operations.ts";

export type Thread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;
export type Interaction = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["interactions"]["get"]>>;
type StoredEvent = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>>[number];
export const threadName = (thread: Pick<Thread, "title" | "titleFallback">) => thread.title ?? thread.titleFallback ?? "Untitled thread";
export const tail = (text: string | null, limit = 6000) => ({ text: text === null ? null : limit === 0 ? "" : text.slice(-limit), truncated: (text?.length ?? 0) > limit });
export function interactionData(interaction: Interaction) {
  return { id: interaction.id, kind: interaction.payload.kind, status: interaction.status,
    createdAt: interaction.createdAt, payload: interaction.payload };
}
export class Watches {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(readonly bb: BbPluginApi, readonly store: LiveStore, readonly operations: Operations) {}
  // Serialize event routing and recovery. Inbox writes and cursor advances commit together.
  serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work); this.chain = next.catch(() => undefined); return next;
  }
  async root(thread: Thread): Promise<string> {
    const seen = new Set<string>();
    while (thread.parentThreadId) {
      if (seen.has(thread.id) || seen.size >= 100) throw new Error("Thread parent chain is cyclic or too deep");
      seen.add(thread.id);
      const parent = await this.bb.sdk.threads.get({ threadId: thread.parentThreadId });
      if (isLegacyCoordinator(this, parent)) break;
      thread = parent;
    }
    return thread.id;
  }
  async watch(conversationId: string, threadId: string, explicit = false) {
    const thread = await this.bb.sdk.threads.get({ threadId });
    const root = await this.root(thread);
    const previous = this.store.watches(conversationId).find(w => w.thread_id === threadId);
    // Preserve pending evidence before the next send boundary.
    if (previous?.state === "active") await this.serial(() => this.reconcileThread(thread));
    const [event] = await this.bb.sdk.threads.events.list({ threadId, order: "desc", limit: "1" });
    const at = this.store.now();
    const disabled = this.store.watches(conversationId).some(w => w.root_thread_id === root && w.state === "disabled");
    this.store.db.prepare(`INSERT INTO voice_watches (conversation_id, thread_id, root_thread_id, state, cursor_seq, last_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(conversation_id, thread_id) DO UPDATE SET updated_at = excluded.updated_at`).run(conversationId, threadId, root, disabled ? "disabled" : "active", event?.seq ?? 0, thread.status, at, at);
    if (explicit) this.store.db.prepare("UPDATE voice_watches SET state = 'active', updated_at = ? WHERE conversation_id = ? AND root_thread_id = ?").run(at, conversationId, root);
    if (previous?.state === "disabled" && !explicit) this.store.db.prepare("UPDATE voice_watches SET cursor_seq = ? WHERE conversation_id = ? AND thread_id = ?").run(event?.seq ?? 0, conversationId, threadId);
    return { ...this.store.watches(conversationId).find(w => w.thread_id === threadId)!, title: threadName(thread) };
  }
  async unsubscribe(conversationId: string, threadId: string) {
    const watch = await this.watch(conversationId, threadId);
    this.store.db.transaction(() => {
      this.store.db.prepare("UPDATE voice_watches SET state = 'disabled', updated_at = ? WHERE conversation_id = ? AND root_thread_id = ?").run(this.store.now(), conversationId, watch.root_thread_id);
      this.store.db.prepare("DELETE FROM voice_inbox WHERE conversation_id = ? AND root_thread_id = ? AND status IN ('queued','deferred')").run(conversationId, watch.root_thread_id);
    })();
  }
  reserveTask(opId: string, conversationId: string, kind: "worker" | "thread", title: string, profile: string | null) {
    const at = this.store.now();
    this.store.db.transaction(() => {
      this.store.db.prepare("INSERT INTO voice_tasks (op_id, conversation_id, kind, title, profile, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'spawning', ?, ?)").run(opId, conversationId, kind, title, profile, at, at);
      this.store.db.prepare("INSERT INTO voice_watches (conversation_id, thread_id, root_thread_id, state, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)").run(conversationId, `spawn:${opId}`, `spawn:${opId}`, at, at);
    })();
  }
  async spawned(opId: string, thread: Thread) {
    this.store.db.transaction(() => {
      this.store.db.prepare("UPDATE voice_tasks SET thread_id = ?, status = 'running', updated_at = ? WHERE op_id = ?").run(thread.id, this.store.now(), opId);
      this.store.db.prepare("UPDATE voice_watches SET thread_id = ?, root_thread_id = ? WHERE thread_id = ?").run(thread.id, thread.id, `spawn:${opId}`);
    })();
    // The spawn response is launch evidence. This one fresh read closes the fast finish race.
    const fresh = await this.bb.sdk.threads.get({ threadId: thread.id });
    await this.serial(() => this.reconcileThread(fresh));
  }
  private add(watch: WatchRow, thread: Thread, kind: InboxKind, detail: unknown, key: string, interactionId: string | null = null) {
    const at = this.store.now();
    const text = typeof detail === "string" ? detail : JSON.stringify(detail);
    const id = randomUUID();
    const inserted = this.store.db.prepare(`INSERT OR IGNORE INTO voice_inbox (id, conversation_id, thread_id, root_thread_id, kind,
      interaction_id, summary, detail, status, event_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`).run(
      id, watch.conversation_id, thread.id, watch.root_thread_id, kind, interactionId, `${threadName(thread)}: ${text.slice(-600)}`, text, key, at, at);
    if (!inserted.changes) return;
    this.trigger(watch.conversation_id, "event", watch.root_thread_id, id);
    if (kind === "result") this.store.db.prepare("UPDATE voice_inbox SET status = 'resolved', eligible = 0, updated_at = ? WHERE conversation_id = ? AND root_thread_id = ? AND kind = 'failed' AND id != ?").run(at, watch.conversation_id, watch.root_thread_id, id);
  }
  trigger(conversationId: string, reason: "event" | "exchange" | "resume" | "ask", root?: string, except?: string) {
    for (const item of this.store.inbox(conversationId)) {
      if (item.id === except || item.status === "resolved" || item.status === "spoken" || (root && item.root_thread_id !== root)) continue;
      const active = this.store.watches(conversationId).some(w => w.root_thread_id === item.root_thread_id && w.state === "active");
      if (!active && reason !== "ask") continue;
      if (reason === "exchange" && item.status !== "deferred") continue;
      if (reason === "resume" && item.status === "dismissed") continue;
      this.store.db.prepare("UPDATE voice_inbox SET eligible = 1, status = ?, updated_at = ? WHERE id = ?").run(critical(item.kind) && item.status === "offered" ? "offered" : "queued", this.store.now(), item.id);
    }
  }
  async event<E extends keyof PluginThreadEventPayloads>(name: E, payload: PluginThreadEventPayloads[E]) {
    const receivedAt = this.store.now();
    return this.serial(async () => {
      if (name === "message.dispatched") {
        const { entry } = payload as PluginThreadEventPayloads["message.dispatched"];
        if (!this.store.watches().some(w => w.state === "active" && w.thread_id === entry.threadId)) return;
        for (const row of this.store.db.prepare("SELECT * FROM voice_operations WHERE queued_message_id = ? AND target_thread_id = ? AND completed_at IS NULL").all(entry.id, entry.threadId) as OperationRow[]) {
          this.store.db.prepare("UPDATE voice_operations SET dispatched_at = ? WHERE id = ?").run(receivedAt, row.id);
          this.operations.finish(row.id, "running", { delivery: "dispatched" });
        }
        return;
      }
      if (!("thread" in payload)) return;
      const thread = payload.thread;
      if (!this.store.watches().some(w => w.state === "active")) return;
      if (name === "interaction.pending") {
        const { interaction } = payload as PluginThreadEventPayloads["interaction.pending"];
        for (const watch of await this.match(thread)) this.pending(watch, thread, interaction);
        return;
      }
      if (name === "thread.idle" || name === "thread.failed" || name === "thread.active" || name === "thread.archived") {
        await this.reconcileThread(thread, name === "thread.idle" ? (payload as PluginThreadEventPayloads["thread.idle"]).lastAssistantText : undefined,
          name === "thread.failed" ? (payload as PluginThreadEventPayloads["thread.failed"]).error : undefined);
      }
    });
  }
  private async match(thread: Thread) {
    const root = await this.root(thread);
    const matched = new Map<string, WatchRow>();
    for (const w of this.store.watches()) if (w.state === "active" && w.root_thread_id === root) {
      if (!this.store.watches(w.conversation_id).some(row => row.thread_id === thread.id)) {
        // Begin at subscription time. The lifecycle branch reports the current state.
        const [latest] = await this.bb.sdk.threads.events.list({ threadId: thread.id, order: "desc", limit: "1" });
        this.store.db.prepare(`INSERT OR IGNORE INTO voice_watches (conversation_id, thread_id, root_thread_id, state, cursor_seq, created_at, updated_at)
          VALUES (?, ?, ?, 'active', ?, ?, ?)`).run(w.conversation_id, thread.id, root, latest?.seq ?? 0, this.store.now(), this.store.now());
      }
      matched.set(w.conversation_id, this.store.watches(w.conversation_id).find(v => v.thread_id === thread.id)!);
    }
    return [...matched.values()];
  }
  private pending(watch: WatchRow, thread: Thread, interaction: Interaction) {
    if (interaction.status !== "pending") return;
    const kind = interaction.payload.kind === "approval" ? "approval" : interaction.payload.kind === "user_question" ? "question" : null;
    if (kind) this.add(watch, thread, kind, interactionData(interaction), `interaction:${interaction.id}`, interaction.id);
  }
  private correlate(conversationId: string, threadId: string, endAt: number, terminal: boolean, outcome = "completed") {
    const rows = this.store.db.prepare("SELECT * FROM voice_operations WHERE conversation_id = ? AND target_thread_id = ? AND tool = 'message_thread' AND completed_at IS NULL AND created_at <= ? AND status IN ('queued','running')").all(conversationId, threadId, endAt) as OperationRow[];
    return rows.map(row => {
      const before = row.status === "queued" || (row.dispatched_at !== null && row.dispatched_at > endAt);
      const correlation = before ? "finished a turn while your message was still queued" : JSON.parse(row.args_json).mode === "steer" ? "finished the turn your steer joined" : "finished the turn that included your message";
      if (!before && terminal) {
        this.store.db.prepare("UPDATE voice_operations SET completed_at = ? WHERE id = ?").run(endAt, row.id);
        this.operations.finish(row.id, outcome === "failed" ? "failed" : outcome === "interrupted" ? "cancelled" : "succeeded", { correlation, turnOutcome: outcome });
      }
      return { operationId: row.id, correlation };
    });
  }
  private async eventsAfter(threadId: string, cursor: number): Promise<StoredEvent[]> {
    const all: StoredEvent[] = [];
    for (;;) {
      const page = await this.bb.sdk.threads.events.list({ threadId, afterSeq: String(cursor), order: "asc", limit: "200" });
      if (!page.length) return all;
      all.push(...page); const next = page.at(-1)!.seq;
      if (next <= cursor) throw new Error("Thread event cursor did not advance");
      cursor = next;
      if (page.length < 200) return all;
    }
  }
  private async reconcileThread(thread: Thread, suppliedText?: string | null, suppliedError?: string | null) {
    const matches = await this.match(thread);
    if (!matches.length) return;
    if (this.store.db.prepare("SELECT 1 FROM voice_operations WHERE target_thread_id = ? AND tool = 'message_thread' AND status = 'unknown'").get(thread.id))
      await this.reconcileUnknown(thread.id);
    const output = suppliedText !== undefined ? suppliedText : (await this.bb.sdk.threads.output({ threadId: thread.id })).output;
    const interactions = await this.bb.sdk.threads.interactions.list({ threadId: thread.id });
    for (const watch of matches) {
      const events = await this.eventsAfter(thread.id, watch.cursor_seq);
      this.store.db.transaction(() => {
        const ends = events.filter(e => e.type === "turn/completed");
        const lastEnd = ends.at(-1);
        const idle = thread.status === "idle", failed = thread.status === "error", archived = thread.archivedAt !== null;
        const queued = thread.queuedMessageCount > 0;
        let turnText: string | null = null;
        let previousText = watch.last_text;
        for (const event of events) {
          if ((event.type === "item/started" || event.type === "item/completed") && event.data.item.type === "agentMessage") turnText = event.data.item.text;
          if (event.type !== "turn/completed") continue;
          const latest = event.seq === lastEnd?.seq;
          const endedText = turnText ?? (latest && (idle || failed) ? output : null);
          const kind: InboxKind = event.data.status === "failed" ? "failed" : latest && queued ? "milestone" : "result";
          if (kind !== "milestone" || endedText !== previousText) {
            const correlations = this.correlate(watch.conversation_id, thread.id, event.createdAt, true, event.data.status);
            this.add(watch, thread, kind, { title: threadName(thread), ...tail(endedText), error: event.data.error?.message ?? (latest ? suppliedError ?? null : null),
              correlations, asOf: event.createdAt, queuedAtEnd: latest && idle ? thread.queuedMessageCount : null,
              outputMissing: endedText === null, source: turnText !== null ? "stored thread events" : "thread lifecycle and latest output" }, `turn:${event.seq}`);
          }
          previousText = endedText; turnText = null;
        }
        // Some lifecycle announcements have no stored turn boundary, including fast spawns.
        const kind: InboxKind | null = archived ? "archived" : failed && lastEnd?.data.status !== "failed" ? "failed" : idle && !lastEnd ? queued ? "milestone" : "result" : null;
        if (kind && (watch.last_status !== thread.status || output !== watch.last_text || archived)
          && (kind !== "milestone" || output !== watch.last_text)) {
          const correlations = idle ? this.correlate(watch.conversation_id, thread.id, thread.updatedAt, true) : [];
          this.add(watch, thread, kind, { title: threadName(thread), ...tail(output), error: suppliedError ?? null,
            correlations, asOf: thread.updatedAt, source: "thread lifecycle" }, `state:${thread.updatedAt}:${kind}`);
        }
        const taskStatus = archived || (idle && lastEnd?.type === "turn/completed" && lastEnd.data.status === "interrupted") ? "stopped" : failed ? "failed" : idle && !queued ? "turn_ended" : "running";
        this.store.db.prepare("UPDATE voice_tasks SET status = ?, last_text = ?, follow_ups_queued = ?, updated_at = ? WHERE conversation_id = ? AND thread_id = ?").run(taskStatus, output, thread.queuedMessageCount, thread.updatedAt, watch.conversation_id, thread.id);
        for (const interaction of interactions) this.pending(watch, thread, interaction);
        const pending = new Set(interactions.filter(i => i.status === "pending").map(i => i.id));
        for (const item of this.store.inbox(watch.conversation_id)) if (item.thread_id === thread.id && item.interaction_id && !pending.has(item.interaction_id))
          this.store.db.prepare("UPDATE voice_inbox SET status = 'resolved', eligible = 0 WHERE id = ?").run(item.id);
        this.store.db.prepare("UPDATE voice_watches SET cursor_seq = ?, last_status = ?, last_text = ?, updated_at = ? WHERE conversation_id = ? AND thread_id = ?").run(events.at(-1)?.seq ?? watch.cursor_seq, thread.status, output, this.store.now(), watch.conversation_id, thread.id);
      })();
    }
  }
  async reconcileUnknown(threadId?: string) {
    for (const row of this.store.db.prepare("SELECT * FROM voice_operations WHERE status IN ('unknown','queued') AND tool = 'message_thread' AND (? IS NULL OR target_thread_id = ?)").all(threadId ?? null, threadId ?? null) as OperationRow[]) {
      try {
      if (!row.target_thread_id || !row.body) continue;
      const queued = await this.bb.sdk.threads.queuedMessages.list({ threadId: row.target_thread_id });
      const matches = queued.filter(q => q.content.filter(p => p.type === "text").map(p => p.text).join("\n") === row.body && q.createdAt >= row.created_at);
      if (matches.length === 1) {
        if (row.status === "queued") continue;
        this.store.db.prepare("UPDATE voice_operations SET queued_message_id = ? WHERE id = ?").run(matches[0].id, row.id);
        this.operations.finish(row.id, "queued", { queuedMessageId: matches[0].id, reconciled: true }); continue;
      }
      const events = await this.bb.sdk.threads.events.list({ threadId: row.target_thread_id, order: "desc", limit: "200" });
      const sent = events.filter(e => e.createdAt >= row.created_at && (e.type === "item/started" || e.type === "item/completed") && userMessageBody(e.data) === row.body);
      const distinct = new Set(sent.map(e => (e.data as { item: { id: string } }).item.id));
      if (distinct.size === 1) {
        this.store.db.prepare("UPDATE voice_operations SET dispatched_at = ? WHERE id = ?").run(Math.min(...sent.map(e => e.createdAt)), row.id);
        this.operations.finish(row.id, "running", { delivery: "sent", reconciled: true });
      }
      } catch (error) { this.bb.log.warn(`Live runtime delivery reconciliation failed for ${row.id}; receipt retained: ${String(error)}`); }
    }
  }
  prepareRecovery(conversationId?: string) {
    for (const task of this.store.tasks(conversationId)) if (task.status === "spawning" && !task.thread_id)
      this.store.db.prepare("UPDATE voice_tasks SET status = 'unknown', updated_at = ? WHERE op_id = ?").run(this.store.now(), task.op_id);
    const offers = this.store.db.prepare("SELECT * FROM voice_offers WHERE outcome = 'pending'").all() as OfferRow[];
    for (const offer of offers) if (!conversationId || offer.conversation_id === conversationId) this.close(offer.id, "not_delivered");
  }
  async recover(conversationId?: string) {
    this.prepareRecovery(conversationId);
    return this.reconcileRecovery(conversationId);
  }
  async reconcileRecovery(conversationId?: string) {
    return this.serial(async () => {
      await this.reconcileUnknown();
      const active = this.store.watches(conversationId).filter(w => w.state === "active" && !w.thread_id.startsWith("spawn:"));
      const ids = new Set(active.map(w => w.thread_id));
      // Discover children created while the plugin was down, including hidden children.
      for (const id of [...ids]) {
        try { for (const child of await this.descendants(id)) ids.add(child.id); }
        catch (error) { this.bb.log.warn(`Live runtime child recovery failed for ${id}: ${String(error)}`); }
      }
      for (const id of ids) {
        try { await this.reconcileThread(await this.bb.sdk.threads.get({ threadId: id })); }
        catch (error) { this.bb.log.warn(`Live runtime recovery failed for ${id}; cursor retained: ${String(error)}`); }
      }
    });
  }
  async refreshInteractions(conversationId: string) {
    for (const item of this.store.inbox(conversationId)) if (item.interaction_id && item.status !== "resolved") {
      const interaction = await this.bb.sdk.threads.interactions.get({ threadId: item.thread_id, interactionId: item.interaction_id });
      if (interaction.status !== "pending") this.store.db.prepare("UPDATE voice_inbox SET status = 'resolved', eligible = 0, updated_at = ? WHERE id = ?").run(this.store.now(), item.id);
    }
  }
  async refreshThread(threadId: string) {
    return this.serial(async () => this.reconcileThread(await this.bb.sdk.threads.get({ threadId })));
  }
  async descendants(threadId: string): Promise<Thread[]> {
    const result: Thread[] = [], pending = [threadId], seen = new Set(pending);
    while (pending.length) {
      const parentThreadId = pending.shift()!;
      for (const archived of [false, true]) for (let offset = 0; ; offset += 100) {
        const page = await this.bb.sdk.threads.list({ parentThreadId, includeHidden: true, archived, limit: 100, offset });
        for (const child of page) if (!seen.has(child.id)) { seen.add(child.id); pending.push(child.id); result.push(await this.bb.sdk.threads.get({ threadId: child.id })); }
        if (page.length < 100) break;
      }
    }
    return result;
  }
  next(conversationId: string, nonce: string) {
    return this.store.db.transaction(() => {
      if (this.store.db.prepare("SELECT 1 FROM voice_offers WHERE conversation_id = ? AND outcome = 'pending'").get(conversationId)) return null;
      const roots = new Set<string>(), items: InboxRow[] = [];
      const candidates = this.store.inbox(conversationId).filter(i => i.eligible && ["queued", "offered"].includes(i.status)
        && this.store.watches(conversationId).some(w => w.root_thread_id === i.root_thread_id && w.state === "active"));
      candidates.sort((a, b) => Number(critical(b.kind)) - Number(critical(a.kind)) || a.created_at - b.created_at);
      for (const item of candidates) {
        if (roots.has(item.root_thread_id)) continue;
        roots.add(item.root_thread_id); items.push(item);
        if (items.length === 3) break;
      }
      if (!items.length) return null;
      // Non-critical child results share one root item. Critical rows remain separate for the next batch.
      const groups = items.map(item => ({ item, children: critical(item.kind) ? [] : candidates.filter(c => c.id !== item.id && c.root_thread_id === item.root_thread_id && !critical(c.kind)) }));
      const all = groups.flatMap(g => [g.item, ...g.children]);
      const offerId = randomUUID(), at = this.store.now();
      this.store.db.prepare("INSERT INTO voice_offers (id, conversation_id, call_nonce, item_ids_json, outcome, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)").run(offerId, conversationId, nonce, JSON.stringify(all.map(i => i.id)), at, at);
      const presented = (item: InboxRow) => ({ ...item, offered_before: !!this.store.db.prepare("SELECT 1 FROM voice_offers, json_each(item_ids_json) WHERE json_each.value = ? AND voice_offers.id != ?").get(item.id, offerId) });
      const result = groups.map(({ item, children }) => ({ ...presented(item), children: children.map(presented) }));
      for (const item of all) this.store.db.prepare("UPDATE voice_inbox SET status = 'offered', eligible = 0, updated_at = ? WHERE id = ?").run(at, item.id);
      return { offerId, items: result, asOf: at };
    })();
  }
  offer(id: string) { return this.store.db.prepare("SELECT * FROM voice_offers WHERE id = ?").get(id) as OfferRow | undefined; }
  close(id: string, outcome: OfferOutcome, responseId?: string) {
    return this.store.db.transaction(() => {
      const offer = this.offer(id);
      if (!offer || offer.outcome !== "pending") return false;
      this.store.db.prepare("UPDATE voice_offers SET outcome = ?, response_id = ?, updated_at = ? WHERE id = ?").run(outcome, responseId ?? null, this.store.now(), id);
      const ids = new Set<string>(JSON.parse(offer.item_ids_json));
      for (const item of this.store.inbox(offer.conversation_id)) if (ids.has(item.id) && item.status !== "resolved") {
        const status = outcome === "not_delivered" ? "queued" : critical(item.kind) ? "offered" : outcome === "delivered" ? "spoken" : outcome;
        this.store.db.prepare("UPDATE voice_inbox SET status = ?, eligible = ?, offer_count = offer_count + ?, updated_at = ? WHERE id = ?").run(status, outcome === "not_delivered" ? 1 : 0, outcome === "not_delivered" ? 1 : 0, this.store.now(), item.id);
      }
      return true;
    })();
  }
}

// Accept only native user-message items, never assistant quotes or tool output.
function userMessageBody(data: unknown): string | null {
  if (!data || typeof data !== "object" || !("item" in data)) return null;
  const item = data.item as { type?: string; content?: { type: string; text?: string }[] };
  if (item?.type !== "userMessage" || !Array.isArray(item.content)) return null;
  return item.content.filter(p => p.type === "text").map(p => p.text ?? "").join("\n");
}
