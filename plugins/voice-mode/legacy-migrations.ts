// Shipped schema history. Keep every statement and its ordering unchanged.
export const QUICK_ACTION_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS voice_quick_cancellations (call_nonce TEXT NOT NULL, request_id TEXT NOT NULL, PRIMARY KEY (call_nonce, request_id))`,
];

export const MESSAGE_SEND_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS voice_message_sends (request_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL)`,
];

export const CONVERSATION_HISTORY_MIGRATIONS: string[] = [
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

export const LIVE_ACTION_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS voice_action_groups (request_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, actor TEXT NOT NULL, actions_json TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS voice_action_steps (request_id TEXT NOT NULL, step INTEGER NOT NULL, action_json TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (request_id, step))`,
  `CREATE TABLE IF NOT EXISTS voice_workers (request_id TEXT NOT NULL, step INTEGER NOT NULL, conversation_id TEXT NOT NULL, thread_id TEXT UNIQUE, project_id TEXT NOT NULL, host_id TEXT NOT NULL, role TEXT NOT NULL, model TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, report_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (request_id, step))`,
];

export const UTTERANCE_EFFECT_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS voice_utterance_effects (call_nonce TEXT NOT NULL, utterance_id TEXT NOT NULL, version INTEGER NOT NULL, action_key TEXT NOT NULL, occurrence INTEGER NOT NULL, request_id TEXT NOT NULL, step INTEGER NOT NULL, PRIMARY KEY (call_nonce, utterance_id, version, action_key, occurrence))`,
];

export const SEQUENCE_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS voice_sequences (reply_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
];

export const UI_COMMAND_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS voice_ui_commands (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, call_nonce TEXT NOT NULL, command_json TEXT NOT NULL, state TEXT NOT NULL, result_json TEXT, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_voice_ui_commands_call ON voice_ui_commands (conversation_id, call_nonce, state)`,
];
