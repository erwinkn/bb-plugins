import type Database from "better-sqlite3";

// Append only. Extra columns hold dedupe and delivery evidence in these five tables.
export const LIVE_RUNTIME_MIGRATIONS = [
  `CREATE TABLE voice_operations (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, call_nonce TEXT NOT NULL,
    utterance_id TEXT NOT NULL, utterance_version INTEGER NOT NULL, utterance_text TEXT,
    response_origin TEXT NOT NULL, tool TEXT NOT NULL, args_json TEXT NOT NULL,
    args_hash TEXT NOT NULL, occurrence INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('accepted','queued','running','succeeded','failed','cancelled','unknown')),
    receipt_json TEXT NOT NULL, target_thread_id TEXT, body TEXT, queued_message_id TEXT,
    dispatched_at INTEGER, completed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(conversation_id, utterance_id, utterance_version, tool, args_hash, occurrence)
  )`,
  `CREATE UNIQUE INDEX voice_operation_utterance ON voice_operations(conversation_id, utterance_id, utterance_version) WHERE utterance_text IS NOT NULL`,
  `CREATE TABLE voice_watches (
    conversation_id TEXT NOT NULL, thread_id TEXT NOT NULL, root_thread_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('active','disabled')), cursor_seq INTEGER NOT NULL DEFAULT 0,
    last_status TEXT, last_text TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(conversation_id, thread_id)
  )`,
  `CREATE INDEX voice_watch_root ON voice_watches(root_thread_id, state)`,
  `CREATE TABLE voice_tasks (
    op_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, thread_id TEXT, kind TEXT NOT NULL CHECK(kind IN ('worker','thread')),
    profile TEXT, title TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('spawning','running','turn_ended','failed','stopped','unknown')),
    last_text TEXT, follow_ups_queued INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE voice_inbox (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, thread_id TEXT NOT NULL, root_thread_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('result','milestone','question','approval','failed','archived')),
    interaction_id TEXT, summary TEXT NOT NULL, detail TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued','offered','deferred','dismissed','spoken','resolved')),
    offer_count INTEGER NOT NULL DEFAULT 0, eligible INTEGER NOT NULL DEFAULT 1, event_key TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(conversation_id, thread_id, event_key)
  )`,
  `CREATE TABLE voice_offers (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, call_nonce TEXT NOT NULL, response_id TEXT,
    item_ids_json TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('pending','delivered','not_delivered','deferred','dismissed')),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX voice_open_offer ON voice_offers(conversation_id) WHERE outcome = 'pending'`,
  // Target IDs the model saw in a call. Persisted so a plugin reload mid-call keeps its authorizations.
  `CREATE TABLE voice_call_targets (call_nonce TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(call_nonce, id))`,
];

export type OperationStatus = "accepted" | "queued" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
export interface OperationRow {
  id: string; conversation_id: string; call_nonce: string; utterance_id: string; utterance_version: number;
  utterance_text: string | null; tool: string; args_json: string; status: OperationStatus; receipt_json: string;
  target_thread_id: string | null; body: string | null; queued_message_id: string | null;
  dispatched_at: number | null; completed_at: number | null; created_at: number; updated_at: number;
}
export interface WatchRow {
  conversation_id: string; thread_id: string; root_thread_id: string; state: "active" | "disabled";
  cursor_seq: number; last_status: string | null; last_text: string | null; created_at: number; updated_at: number;
}
export interface TaskRow {
  op_id: string; conversation_id: string; thread_id: string | null; kind: "worker" | "thread";
  profile: string | null; title: string; status: "spawning" | "running" | "turn_ended" | "failed" | "stopped" | "unknown";
  last_text: string | null; follow_ups_queued: number; created_at: number; updated_at: number;
}
export type InboxKind = "result" | "milestone" | "question" | "approval" | "failed" | "archived";
export interface InboxRow {
  id: string; conversation_id: string; thread_id: string; root_thread_id: string; kind: InboxKind;
  interaction_id: string | null; summary: string; detail: string;
  status: "queued" | "offered" | "deferred" | "dismissed" | "spoken" | "resolved";
  offer_count: number; eligible: number; event_key: string; created_at: number; updated_at: number;
}
export type OfferOutcome = "delivered" | "not_delivered" | "deferred" | "dismissed";
export interface OfferRow {
  id: string; conversation_id: string; call_nonce: string; response_id: string | null;
  item_ids_json: string; outcome: "pending" | OfferOutcome; created_at: number; updated_at: number;
}
export const critical = (kind: InboxKind) => ["question", "approval", "failed"].includes(kind);
export class LiveStore {
  constructor(readonly db: Database.Database, readonly now = Date.now) {}
  watches(conversationId?: string): WatchRow[] {
    return (conversationId ? this.db.prepare("SELECT * FROM voice_watches WHERE conversation_id = ? ORDER BY created_at, thread_id").all(conversationId)
      : this.db.prepare("SELECT * FROM voice_watches ORDER BY created_at, thread_id").all()) as WatchRow[];
  }
  tasks(conversationId?: string): TaskRow[] {
    return (conversationId ? this.db.prepare("SELECT * FROM voice_tasks WHERE conversation_id = ? ORDER BY created_at DESC, op_id").all(conversationId)
      : this.db.prepare("SELECT * FROM voice_tasks ORDER BY created_at DESC, op_id").all()) as TaskRow[];
  }
  inbox(conversationId: string): InboxRow[] {
    return this.db.prepare("SELECT * FROM voice_inbox WHERE conversation_id = ? ORDER BY created_at, id").all(conversationId) as InboxRow[];
  }
}
