// Durable coordinator state in the plugin database. Every table is versioned
// through the plugin's append-only migration list (see server.ts), and every
// JSON column is re-validated on read so a stale or hand-edited row cannot
// crash the bridge.
import { narratedSequenceSchema, narrationContextSchema } from "../narrated-sequence.ts";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  actionReceiptSchema,
  userRequestEnvelopeSchema,
  type ActionReceipt,
  type DeliveryState,
  type UserRequestEnvelope,
} from "./envelopes.ts";

/**
 * Appended to the plugin's migration list. Never reorder or edit shipped
 * statements; add new ones at the end.
 */
// Appended after all existing plugin migrations by server.ts.
export const QUICK_ACTION_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS voice_quick_cancellations (call_nonce TEXT NOT NULL, request_id TEXT NOT NULL, PRIMARY KEY (call_nonce, request_id))`,
];

// Retained at its original migration index for installed pre-operator databases.
export const MESSAGE_SEND_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS voice_message_sends (request_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL)`,
];
const messageSendSchema = z.object({
  threadId: z.string(), title: z.string(), text: z.string(), mode: z.enum(["queue", "steer"]),
  status: z.enum(["sending", "sent", "queued", "unknown"]),
  receipt: actionReceiptSchema.optional(),
});
export type MessageSendRecord = z.infer<typeof messageSendSchema>;

export const COORDINATOR_MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS voice_conversations (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    coordinator_thread_id TEXT,
    create_started_at INTEGER,
    coordinator_project_id TEXT,
    coordinator_environment_id TEXT,
    host_id TEXT,
    provider_id TEXT,
    model TEXT,
    current_call_nonce TEXT,
    current_call_sequence INTEGER,
    call_started_at INTEGER,
    resumed_at INTEGER,
    revision INTEGER NOT NULL DEFAULT 0,
    state_json TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE TABLE IF NOT EXISTS voice_conversation_control (
    slot INTEGER PRIMARY KEY CHECK (slot = 1),
    current_conversation_id TEXT
  )`,
  `INSERT OR IGNORE INTO voice_conversation_control (slot, current_conversation_id) VALUES (1, NULL)`,
  `CREATE TABLE IF NOT EXISTS voice_requests (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    call_nonce TEXT NOT NULL,
    call_sequence INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    status TEXT NOT NULL,
    envelope_json TEXT NOT NULL,
    receipt_json TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    dispatched_at INTEGER,
    settled_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_voice_requests_conversation ON voice_requests (conversation_id, seq)`,
  `CREATE TABLE IF NOT EXISTS voice_replies (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    request_id TEXT,
    batch_id TEXT,
    question_id TEXT,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    envelope_json TEXT NOT NULL,
    ready INTEGER NOT NULL DEFAULT 0,
    delivery TEXT NOT NULL DEFAULT 'pending',
    target_call_nonce TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_voice_replies_conversation ON voice_replies (conversation_id, seq)`,
  `CREATE TABLE IF NOT EXISTS voice_updates (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    title TEXT NOT NULL,
    kind TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    detail TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    batch_id TEXT,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_voice_updates_conversation ON voice_updates (conversation_id, status, created_at)`,
  `CREATE TABLE IF NOT EXISTS voice_batches (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS voice_watch (
    conversation_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    removed_at INTEGER,
    PRIMARY KEY (conversation_id, thread_id)
  )`,
  `CREATE TABLE IF NOT EXISTS voice_questions (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    request_id TEXT,
    coordinator_thread_id TEXT NOT NULL,
    interaction_id TEXT,
    question TEXT NOT NULL,
    options_json TEXT NOT NULL DEFAULT '[]',
    allow_free_text INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL,
    answer_json TEXT,
    submitted_via TEXT,
    cancel_reason TEXT,
    created_at INTEGER NOT NULL,
    submitted_at INTEGER,
    delivered_at INTEGER,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_voice_questions_conversation ON voice_questions (conversation_id, status)`,
  `CREATE TABLE IF NOT EXISTS voice_conversation_calls (call_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL)`,

];

export const conversationStateSchema = z
  .object({
    lastRequestContext: z.string().nullable().default(null),
    threadStates: z.record(z.string(),z.string()).default({}),
    topic: z.string().max(200).nullable().default(null),
    discussedThreadId: z.string().max(128).nullable().default(null),
    viewedThreadId: z.string().max(128).nullable().default(null),
    viewedProjectId: z.string().max(128).nullable().default(null),
    unresolvedQuestionId: z.string().max(64).nullable().default(null),
    activeTasks: z.array(z.object({ requestId: z.string(), summary: z.string().max(300), threadIds: z.array(z.string()) })).max(50).default([]),
    authorizedScopes: z.array(z.string().max(400)).max(50).default([]),
    narrating:narrationContextSchema.nullable().default(null),
    latestAnnouncement: z
      .object({ replyId: z.string(), threadIds: z.array(z.string()), text: z.string().max(1200), delivery: z.string() })
      .nullable()
      .default(null),
    /** Whether an opening request has been answered since the last resume. */
    openingAnswered: z.boolean().default(false),
  })
  .strict();
export type ConversationState = z.infer<typeof conversationStateSchema>;

export type ConversationStatus = "active" | "released";
export interface ConversationRow {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: ConversationStatus;
  coordinatorThreadId: string | null;
  createStartedAt: number | null;
  coordinatorProjectId: string | null;
  coordinatorEnvironmentId: string | null;
  hostId: string | null;
  providerId: string | null;
  model: string | null;
  currentCallNonce: string | null;
  currentCallSequence: number | null;
  callStartedAt: number | null;
  resumedAt: number | null;
  revision: number;
  state: ConversationState;
}

export type RequestStatus = "recorded" | "dispatching" | "accepted" | "dispatch_unknown" | "failed" | "settled" | "quick_running" | "quick_unknown" | "quick_cancelled";
export interface RequestReceipt {
  delivery: "sent" | "queued";
  coordinatorThreadId: string;
  mode: string;
  queuedMessageId?: string;
}
export interface RequestRow {
  id: string;
  conversationId: string;
  callNonce: string;
  callSequence: number;
  seq: number;
  status: RequestStatus;
  envelope: UserRequestEnvelope;
  receipt: RequestReceipt | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  dispatchedAt: number | null;
  settledAt: number | null;
}

export const storedReplySchema = z
  .object({
    speech: z.string(),
    detail: z.string().nullable(),
    threadIds: z.array(z.string()),
    receipts: z.array(actionReceiptSchema),
    focusThreadId: z.string().nullable(),
    sequence: narratedSequenceSchema.optional(),
  })
  .strict();
export type StoredReply = z.infer<typeof storedReplySchema>;
export interface ReplyRow {
  id: string;
  conversationId: string;
  requestId: string | null;
  batchId: string | null;
  questionId: string | null;
  seq: number;
  kind: string;
  source: "tool" | "fallback" | "bridge";
  body: StoredReply;
  ready: boolean;
  delivery: DeliveryState;
  targetCallNonce: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface UpdateRow {
  id: string;
  conversationId: string;
  threadId: string;
  title: string;
  kind: string;
  fingerprint: string;
  detail: string | null;
  status: "queued" | "reserved" | "delivered" | "skipped";
  batchId: string | null;
  createdAt: number;
  deliveredAt: number | null;
}

export type QuestionStatus = "pending" | "submitted" | "delivered" | "cancelled" | "unresolved";
export interface QuestionRow {
  id: string;
  conversationId: string;
  requestId: string | null;
  coordinatorThreadId: string;
  interactionId: string | null;
  question: string;
  options: string[];
  allowFreeText: boolean;
  status: QuestionStatus;
  answer: unknown;
  submittedVia: "ui" | "voice" | null;
  cancelReason: string | null;
  createdAt: number;
  submittedAt: number | null;
  deliveredAt: number | null;
  updatedAt: number;
}

export interface WatchRow {
  threadId: string;
  reason: string;
  addedAt: number;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

let idCounter = 0;
export function newId(prefix: string): string {
  idCounter += 1;
  const random = (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/-/g, "").slice(0, 12);
  return `${prefix}_${random}${idCounter.toString(36)}`;
}

/** Typed access to the coordinator tables. All methods are synchronous SQLite. */
export class CoordinatorStore {
  constructor(private readonly db: Database.Database, private readonly now: () => number = Date.now) {}

  getMessageSend(requestId: string): MessageSendRecord | null {
    const row = this.db.prepare("SELECT payload_json FROM voice_message_sends WHERE request_id = ?").get(requestId) as {payload_json: string} | undefined;
    return row ? messageSendSchema.parse(JSON.parse(row.payload_json)) : null;
  }

  putMessageSend(requestId: string, value: MessageSendRecord) {
    this.db.prepare("INSERT INTO voice_message_sends (request_id, payload_json) VALUES (?, ?) ON CONFLICT(request_id) DO UPDATE SET payload_json = excluded.payload_json")
      .run(requestId, JSON.stringify(messageSendSchema.parse(value)));
  }

  // ---- conversations ----

  private rowToConversation(row: Record<string, unknown>): ConversationRow {
    const state = conversationStateSchema.safeParse(parseJson(row.state_json as string, {}));
    return {
      id: row.id as string,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      status: row.status as ConversationStatus,
      coordinatorThreadId: (row.coordinator_thread_id as string | null) ?? null,
      createStartedAt: (row.create_started_at as number | null) ?? null,
      coordinatorProjectId: (row.coordinator_project_id as string | null) ?? null,
      coordinatorEnvironmentId: (row.coordinator_environment_id as string | null) ?? null,
      hostId: (row.host_id as string | null) ?? null,
      providerId: (row.provider_id as string | null) ?? null,
      model: (row.model as string | null) ?? null,
      currentCallNonce: (row.current_call_nonce as string | null) ?? null,
      currentCallSequence: (row.current_call_sequence as number | null) ?? null,
      callStartedAt: (row.call_started_at as number | null) ?? null,
      resumedAt: (row.resumed_at as number | null) ?? null,
      revision: row.revision as number,
      state: state.success ? state.data : conversationStateSchema.parse({}),
    };
  }

  currentConversationId(): string | null {
    const row = this.db.prepare("SELECT current_conversation_id AS id FROM voice_conversation_control WHERE slot = 1").get() as { id: string | null } | undefined;
    return row?.id ?? null;
  }

  setCurrentConversation(id: string | null) {
    this.db.prepare("UPDATE voice_conversation_control SET current_conversation_id = ? WHERE slot = 1").run(id);
  }

  createConversation(): ConversationRow {
    const id = newId("conv");
    const ts = this.now();
    this.db
      .prepare("INSERT INTO voice_conversations (id, created_at, updated_at, status, state_json) VALUES (?, ?, ?, 'active', '{}')")
      .run(id, ts, ts);
    this.setCurrentConversation(id);
    return this.getConversation(id)!;
  }

  getConversation(id: string): ConversationRow | null {
    const row = this.db.prepare("SELECT * FROM voice_conversations WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToConversation(row) : null;
  }

  listConversations(limit = 10): ConversationRow[] {
    const rows = this.db.prepare("SELECT * FROM voice_conversations ORDER BY updated_at DESC LIMIT ?").all(limit) as Record<string, unknown>[];
    return rows.map((row) => this.rowToConversation(row));
  }

  conversationByCoordinator(threadId: string): ConversationRow | null {
    const row = this.db.prepare("SELECT * FROM voice_conversations WHERE coordinator_thread_id = ? ORDER BY updated_at DESC LIMIT 1").get(threadId) as Record<string, unknown> | undefined;
    return row ? this.rowToConversation(row) : null;
  }

  coordinatorThreadIds(): Set<string> {
    const rows = this.db.prepare("SELECT coordinator_thread_id AS id FROM voice_conversations WHERE coordinator_thread_id IS NOT NULL").all() as { id: string }[];
    return new Set(rows.map((row) => row.id));
  }

  updateConversation(id: string, patch: Partial<Omit<ConversationRow, "id" | "createdAt" | "state">> & { state?: Partial<ConversationState> }): ConversationRow {
    const current = this.getConversation(id);
    if (!current) throw new Error(`Unknown conversation ${id}`);
    const next: ConversationRow = {
      ...current,
      ...patch,
      state: conversationStateSchema.parse({ ...current.state, ...(patch.state ?? {}) }),
      updatedAt: this.now(),
      revision: current.revision + 1,
    };
    this.db
      .prepare(
        `UPDATE voice_conversations SET updated_at = ?, status = ?, coordinator_thread_id = ?, create_started_at = ?, coordinator_project_id = ?,
         coordinator_environment_id = ?, host_id = ?, provider_id = ?, model = ?, current_call_nonce = ?, current_call_sequence = ?, call_started_at = ?,
         resumed_at = ?, revision = ?, state_json = ? WHERE id = ?`,
      )
      .run(
        next.updatedAt, next.status, next.coordinatorThreadId, next.createStartedAt, next.coordinatorProjectId,
        next.coordinatorEnvironmentId, next.hostId, next.providerId, next.model, next.currentCallNonce, next.currentCallSequence, next.callStartedAt,
        next.resumedAt, next.revision, JSON.stringify(next.state), id,
      );
    return next;
  }

  // ---- requests ----

  private rowToRequest(row: Record<string, unknown>): RequestRow | null {
    const stored = parseJson<Record<string, unknown> | null>(row.envelope_json as string, null);
    // A shipped local version called an actionable message "request". Decode
    // that historical label without admitting it into the current tool schema.
    const action = stored?.quickAction;
    if (action && typeof action === "object" && !Array.isArray(action)) {
      const legacy = action as Record<string, unknown>;
      if (legacy.kind === "send_message" && legacy.purpose === "request") legacy.purpose = "instruction";
    }
    const envelope = userRequestEnvelopeSchema.safeParse(stored);
    if (!envelope.success) return null;
    return {
      id: row.id as string,
      conversationId: row.conversation_id as string,
      callNonce: row.call_nonce as string,
      callSequence: row.call_sequence as number,
      seq: row.seq as number,
      status: row.status as RequestStatus,
      envelope: envelope.data,
      receipt: parseJson<RequestReceipt | null>((row.receipt_json as string | null) ?? null, null),
      error: (row.error as string | null) ?? null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      dispatchedAt: (row.dispatched_at as number | null) ?? null,
      settledAt: (row.settled_at as number | null) ?? null,
    };
  }

  /** A spoken request keeps one executor, even across separate tool calls. */
  requestsForUtterance(envelope: UserRequestEnvelope): RequestRow[] {
    const rows = this.db.prepare(`SELECT * FROM voice_requests WHERE conversation_id=? AND call_nonce=? AND id!=?
      AND status NOT IN ('failed','quick_cancelled') AND (
        (? IS NOT NULL AND json_extract(envelope_json,'$.utteranceId')=?
          AND COALESCE(json_extract(envelope_json,'$.utteranceVersion'),json_extract(envelope_json,'$.transcriptRevision'))=?)
        OR (? IS NULL AND EXISTS (SELECT 1 FROM json_each(envelope_json,'$.utteranceItemIds') old
          JOIN json_each(?) current ON old.value=current.value))) ORDER BY seq`).all(
      envelope.conversationId,envelope.callNonce,envelope.requestId,envelope.utteranceId??null,envelope.utteranceId??null,
      envelope.utteranceVersion??envelope.transcriptRevision,envelope.utteranceId??null,JSON.stringify(envelope.utteranceItemIds));
    return rows.map(row=>this.rowToRequest(row as Record<string,unknown>)).filter((row): row is RequestRow=>!!row);
  }

  priorQuickRequest(envelope: UserRequestEnvelope): RequestRow | null {
    if(envelope.utteranceId) {
      const row=this.db.prepare(`SELECT * FROM voice_requests WHERE conversation_id=? AND call_nonce=? AND id!=?
        AND json_extract(envelope_json,'$.utteranceId')=? AND json_extract(envelope_json,'$.utteranceVersion')=?
        AND json_extract(envelope_json,'$.quickAction')=json(?) ORDER BY seq DESC LIMIT 1`).get(envelope.conversationId,envelope.callNonce,envelope.requestId,envelope.utteranceId,envelope.utteranceVersion??envelope.transcriptRevision,JSON.stringify(envelope.quickAction)) as Record<string,unknown>|undefined;
      return row ? this.rowToRequest(row) : null;
    }
    const row = this.db.prepare(`SELECT * FROM voice_requests r WHERE r.conversation_id = ? AND r.call_nonce = ? AND r.id != ?
      AND json_type(r.envelope_json, '$.quickAction') IS NOT NULL
      AND EXISTS (SELECT 1 FROM json_each(r.envelope_json, '$.utteranceItemIds') old JOIN json_each(?) current ON old.value = current.value)
      ORDER BY r.seq DESC LIMIT 1`).get(envelope.conversationId, envelope.callNonce, envelope.requestId, JSON.stringify(envelope.utteranceItemIds)) as Record<string, unknown> | undefined;
    return row ? this.rowToRequest(row) : null;
  }

  cancelQuick(callNonce: string, requestId: string) {
    this.db.prepare("INSERT OR IGNORE INTO voice_quick_cancellations (call_nonce, request_id) VALUES (?, ?)").run(callNonce, requestId);
  }

  quickCancelled(callNonce: string, requestId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM voice_quick_cancellations WHERE call_nonce = ? AND request_id = ?").get(callNonce, requestId);
  }

  getRequest(id: string): RequestRow | null {
    const row = this.db.prepare("SELECT * FROM voice_requests WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToRequest(row) : null;
  }

  recordRequest(envelope: UserRequestEnvelope): RequestRow {
    const ts = this.now();
    const seqRow = this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM voice_requests WHERE conversation_id = ?").get(envelope.conversationId) as { seq: number };
    this.db
      .prepare(
        "INSERT INTO voice_requests (id, conversation_id, call_nonce, call_sequence, seq, status, envelope_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'recorded', ?, ?, ?)",
      )
      .run(envelope.requestId, envelope.conversationId, envelope.callNonce, envelope.callSequence, seqRow.seq, JSON.stringify(envelope), ts, ts);
    return this.getRequest(envelope.requestId)!;
  }

  updateRequest(id: string, patch: { status?: RequestStatus; receipt?: RequestReceipt | null; error?: string | null; dispatchedAt?: number | null; settledAt?: number | null }): RequestRow {
    const current = this.getRequest(id);
    if (!current) throw new Error(`Unknown request ${id}`);
    const next = { ...current, ...patch, updatedAt: this.now() };
    this.db
      .prepare("UPDATE voice_requests SET status = ?, receipt_json = ?, error = ?, updated_at = ?, dispatched_at = ?, settled_at = ? WHERE id = ?")
      .run(next.status, next.receipt ? JSON.stringify(next.receipt) : null, next.error, next.updatedAt, next.dispatchedAt, next.settledAt, id);
    return next;
  }

  listRequests(conversationId: string, statuses?: RequestStatus[], limit = 50): RequestRow[] {
    const rows = (statuses && statuses.length > 0
      ? this.db
          .prepare(`SELECT * FROM voice_requests WHERE conversation_id = ? AND status IN (${statuses.map(() => "?").join(",")}) ORDER BY seq ASC LIMIT ?`)
          .all(conversationId, ...statuses, limit)
      : this.db.prepare("SELECT * FROM voice_requests WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?").all(conversationId, limit)) as Record<string, unknown>[];
    return rows.map((row) => this.rowToRequest(row)).filter((row): row is RequestRow => row !== null);
  }

  // ---- replies ----

  private rowToReply(row: Record<string, unknown>): ReplyRow | null {
    const body = storedReplySchema.safeParse(parseJson(row.envelope_json as string, null));
    if (!body.success) return null;
    return {
      id: row.id as string,
      conversationId: row.conversation_id as string,
      requestId: (row.request_id as string | null) ?? null,
      batchId: (row.batch_id as string | null) ?? null,
      questionId: (row.question_id as string | null) ?? null,
      seq: row.seq as number,
      kind: row.kind as string,
      source: row.source as ReplyRow["source"],
      body: body.data,
      ready: row.ready === 1,
      delivery: row.delivery as DeliveryState,
      targetCallNonce: (row.target_call_nonce as string | null) ?? null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  recordReply(input: {
    conversationId: string;
    requestId: string | null;
    batchId: string | null;
    questionId: string | null;
    kind: string;
    source: ReplyRow["source"];
    body: StoredReply;
    ready: boolean;
    delivery: DeliveryState;
    targetCallNonce: string | null;
  }): ReplyRow {
    const id = newId("reply");
    const ts = this.now();
    const seqRow = this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM voice_replies WHERE conversation_id = ?").get(input.conversationId) as { seq: number };
    this.db
      .prepare(
        `INSERT INTO voice_replies (id, conversation_id, request_id, batch_id, question_id, seq, kind, source, envelope_json, ready, delivery, target_call_nonce, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.conversationId, input.requestId, input.batchId, input.questionId, seqRow.seq, input.kind, input.source, JSON.stringify(input.body), input.ready ? 1 : 0, input.delivery, input.targetCallNonce, ts, ts);
    return this.getReply(id)!;
  }

  getReply(id: string): ReplyRow | null {
    const row = this.db.prepare("SELECT * FROM voice_replies WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToReply(row) : null;
  }

  updateReply(id: string, patch: { ready?: boolean; delivery?: DeliveryState; targetCallNonce?: string | null }): ReplyRow {
    const current = this.getReply(id);
    if (!current) throw new Error(`Unknown reply ${id}`);
    const next = { ...current, ...patch, updatedAt: this.now() };
    this.db.prepare("UPDATE voice_replies SET ready = ?, delivery = ?, target_call_nonce = ?, updated_at = ? WHERE id = ?").run(next.ready ? 1 : 0, next.delivery, next.targetCallNonce, next.updatedAt, id);
    return next;
  }

  listReplies(conversationId: string, filter?: { requestId?: string; batchId?: string; ready?: boolean; delivery?: DeliveryState[] }, limit = 100): ReplyRow[] {
    const clauses = ["conversation_id = ?"];
    const params: unknown[] = [conversationId];
    if (filter?.requestId) { clauses.push("request_id = ?"); params.push(filter.requestId); }
    if (filter?.batchId) { clauses.push("batch_id = ?"); params.push(filter.batchId); }
    if (filter?.ready !== undefined) { clauses.push("ready = ?"); params.push(filter.ready ? 1 : 0); }
    if (filter?.delivery && filter.delivery.length > 0) { clauses.push(`delivery IN (${filter.delivery.map(() => "?").join(",")})`); params.push(...filter.delivery); }
    const rows = this.db.prepare(`SELECT * FROM voice_replies WHERE ${clauses.join(" AND ")} ORDER BY seq ASC LIMIT ?`).all(...params, limit) as Record<string, unknown>[];
    return rows.map((row) => this.rowToReply(row)).filter((row): row is ReplyRow => row !== null);
  }

  // ---- updates (inbox) ----

  private rowToUpdate(row: Record<string, unknown>): UpdateRow {
    return {
      id: row.id as string,
      conversationId: row.conversation_id as string,
      threadId: row.thread_id as string,
      title: row.title as string,
      kind: row.kind as string,
      fingerprint: row.fingerprint as string,
      detail: (row.detail as string | null) ?? null,
      status: row.status as UpdateRow["status"],
      batchId: (row.batch_id as string | null) ?? null,
      createdAt: row.created_at as number,
      deliveredAt: (row.delivered_at as number | null) ?? null,
    };
  }

  /** Persist a native event once, including after its update was delivered. */
  enqueueUpdate(input: { conversationId: string; threadId: string; title: string; kind: string; fingerprint: string; detail: string | null }): UpdateRow | null {
    const duplicate = this.db
      .prepare("SELECT id FROM voice_updates WHERE conversation_id = ? AND fingerprint = ? ")
      .get(input.conversationId, input.fingerprint) as { id: string } | undefined;
    if (duplicate) return null;
    const id = newId("upd");
    const ts = this.now();
    this.db
      .prepare("INSERT INTO voice_updates (id, conversation_id, thread_id, title, kind, fingerprint, detail, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)")
      .run(id, input.conversationId, input.threadId, input.title, input.kind, input.fingerprint, input.detail, ts);
    return this.getUpdate(id)!;
  }

  getUpdate(id: string): UpdateRow | null {
    const row = this.db.prepare("SELECT * FROM voice_updates WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToUpdate(row) : null;
  }

  listUpdates(conversationId: string, statuses: UpdateRow["status"][] = ["queued"], limit = 200): UpdateRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM voice_updates WHERE conversation_id = ? AND status IN (${statuses.map(() => "?").join(",")}) ORDER BY created_at ASC LIMIT ?`)
      .all(conversationId, ...statuses, limit) as Record<string, unknown>[];
    return rows.map((row) => this.rowToUpdate(row));
  }

  setUpdatesStatus(ids: string[], status: UpdateRow["status"], batchId: string | null) {
    if (ids.length === 0) return;
    const ts = this.now();
    const statement = this.db.prepare("UPDATE voice_updates SET status = ?, batch_id = COALESCE(?, batch_id), delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END WHERE id = ?");
    const run = this.db.transaction((list: string[]) => { for (const id of list) statement.run(status, batchId, status, ts, id); });
    run(ids);
  }

  createBatch(conversationId: string): string {
    const id = newId("batch");
    const ts = this.now();
    this.db.prepare("INSERT INTO voice_batches (id, conversation_id, status, created_at, updated_at) VALUES (?, ?, 'reserved', ?, ?)").run(id, conversationId, ts, ts);
    return id;
  }

  getBatch(id: string): { id: string; conversationId: string; status: string } | null {
    const row = this.db.prepare("SELECT id, conversation_id AS conversationId, status FROM voice_batches WHERE id = ?").get(id) as { id: string; conversationId: string; status: string } | undefined;
    return row ?? null;
  }

  setBatchStatus(id: string, status: "reserved" | "sent" | "answered" | "failed") {
    this.db.prepare("UPDATE voice_batches SET status = ?, updated_at = ? WHERE id = ?").run(status, this.now(), id);
  }

  listBatches(conversationId: string, statuses: string[]): { id: string; status: string; createdAt: number }[] {
    return this.db
      .prepare(`SELECT id, status, created_at AS createdAt FROM voice_batches WHERE conversation_id = ? AND status IN (${statuses.map(() => "?").join(",")}) ORDER BY created_at ASC`)
      .all(conversationId, ...statuses) as { id: string; status: string; createdAt: number }[];
  }

  // ---- watch set ----

  watchList(conversationId: string): WatchRow[] {
    return (this.db
      .prepare("SELECT thread_id AS threadId, reason, added_at AS addedAt FROM voice_watch WHERE conversation_id = ? AND removed_at IS NULL ORDER BY added_at ASC")
      .all(conversationId) as WatchRow[]);
  }

  isWatched(conversationId: string, threadId: string): boolean {
    return this.db.prepare("SELECT 1 FROM voice_watch WHERE conversation_id = ? AND thread_id = ? AND removed_at IS NULL").get(conversationId, threadId) !== undefined;
  }

  watch(conversationId: string, threadId: string, reason: string) {
    const ts = this.now();
    this.db
      .prepare("INSERT INTO voice_watch (conversation_id, thread_id, reason, added_at, removed_at) VALUES (?, ?, ?, ?, NULL) ON CONFLICT (conversation_id, thread_id) DO UPDATE SET reason = excluded.reason, added_at = excluded.added_at, removed_at = NULL")
      .run(conversationId, threadId, reason, ts);
  }

  unwatch(conversationId: string, threadId: string) {
    this.db.prepare("UPDATE voice_watch SET removed_at = ? WHERE conversation_id = ? AND thread_id = ?").run(this.now(), conversationId, threadId);
  }

  /** Conversations watching a thread, newest first. */
  watchersOf(threadId: string): string[] {
    return (this.db.prepare("SELECT conversation_id AS id FROM voice_watch WHERE thread_id = ? AND removed_at IS NULL").all(threadId) as { id: string }[]).map((row) => row.id);
  }

  // ---- questions ----

  private rowToQuestion(row: Record<string, unknown>): QuestionRow {
    return {
      id: row.id as string,
      conversationId: row.conversation_id as string,
      requestId: (row.request_id as string | null) ?? null,
      coordinatorThreadId: row.coordinator_thread_id as string,
      interactionId: (row.interaction_id as string | null) ?? null,
      question: row.question as string,
      options: parseJson<string[]>(row.options_json as string, []),
      allowFreeText: row.allow_free_text === 1,
      status: row.status as QuestionStatus,
      answer: parseJson<unknown>((row.answer_json as string | null) ?? null, null),
      submittedVia: (row.submitted_via as QuestionRow["submittedVia"]) ?? null,
      cancelReason: (row.cancel_reason as string | null) ?? null,
      createdAt: row.created_at as number,
      submittedAt: (row.submitted_at as number | null) ?? null,
      deliveredAt: (row.delivered_at as number | null) ?? null,
      updatedAt: row.updated_at as number,
    };
  }

  createQuestion(input: { conversationId: string; requestId: string | null; coordinatorThreadId: string; question: string; options: string[]; allowFreeText: boolean }): QuestionRow {
    const id = newId("q");
    const ts = this.now();
    this.db
      .prepare("INSERT INTO voice_questions (id, conversation_id, request_id, coordinator_thread_id, question, options_json, allow_free_text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)")
      .run(id, input.conversationId, input.requestId, input.coordinatorThreadId, input.question, JSON.stringify(input.options), input.allowFreeText ? 1 : 0, ts, ts);
    return this.getQuestion(id)!;
  }

  getQuestion(id: string): QuestionRow | null {
    const row = this.db.prepare("SELECT * FROM voice_questions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToQuestion(row) : null;
  }

  updateQuestion(id: string, patch: Partial<Pick<QuestionRow, "interactionId" | "status" | "answer" | "submittedVia" | "cancelReason" | "submittedAt" | "deliveredAt">>): QuestionRow {
    const current = this.getQuestion(id);
    if (!current) throw new Error(`Unknown question ${id}`);
    const next = { ...current, ...patch, updatedAt: this.now() };
    this.db
      .prepare("UPDATE voice_questions SET interaction_id = ?, status = ?, answer_json = ?, submitted_via = ?, cancel_reason = ?, submitted_at = ?, delivered_at = ?, updated_at = ? WHERE id = ?")
      .run(next.interactionId, next.status, next.answer === null || next.answer === undefined ? null : JSON.stringify(next.answer), next.submittedVia, next.cancelReason, next.submittedAt, next.deliveredAt, next.updatedAt, id);
    return next;
  }

  listQuestions(conversationId: string, statuses: QuestionStatus[]): QuestionRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM voice_questions WHERE conversation_id = ? AND status IN (${statuses.map(() => "?").join(",")}) ORDER BY created_at ASC`)
      .all(conversationId, ...statuses) as Record<string, unknown>[];
    return rows.map((row) => this.rowToQuestion(row));
  }
}

export type { ActionReceipt };
