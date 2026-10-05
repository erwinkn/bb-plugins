// Append-only migrations for the plugin's own SQLite database
// (bb.storage.database()). Never reorder or edit a shipped statement.

export const MIGRATIONS = [
  `CREATE TABLE watches (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL UNIQUE,
    origin TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    epoch INTEGER NOT NULL,
    title TEXT,
    project_id TEXT,
    environment_id TEXT,
    root_path TEXT,
    origin_plugin_id TEXT,
    thread_json TEXT,
    start_seq INTEGER,
    cursor INTEGER,
    tip INTEGER,
    at_tip INTEGER NOT NULL DEFAULT 0,
    seeded INTEGER NOT NULL DEFAULT 0,
    state_json TEXT NOT NULL DEFAULT '{}',
    last_drain_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE cards (
    watch_id TEXT NOT NULL,
    id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    ord INTEGER NOT NULL,
    kind TEXT NOT NULL,
    path TEXT,
    text TEXT NOT NULL,
    enc_bytes INTEGER NOT NULL,
    meta TEXT NOT NULL,
    judge INTEGER NOT NULL,
    reviewed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (watch_id, id)
  )`,
  `CREATE INDEX cards_fifo ON cards (watch_id, judge, reviewed, seq, ord)`,
  `CREATE INDEX cards_age ON cards (created_at)`,
  `CREATE TABLE requests (
    watch_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    row TEXT NOT NULL,
    PRIMARY KEY (watch_id, request_id)
  )`,
  `CREATE TABLE request_state (
    watch_id TEXT PRIMARY KEY,
    state TEXT NOT NULL
  )`,
  `CREATE TABLE gaps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    watch_id TEXT NOT NULL,
    layer TEXT NOT NULL,
    reason TEXT NOT NULL,
    from_seq INTEGER,
    to_seq INTEGER,
    detail TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX gaps_watch ON gaps (watch_id, id)`,
  `CREATE TABLE reviews (
    id TEXT PRIMARY KEY,
    watch_id TEXT NOT NULL,
    route TEXT NOT NULL,
    model TEXT,
    state TEXT NOT NULL,
    preview INTEGER NOT NULL DEFAULT 0,
    dispatch_tip INTEGER,
    card_ids TEXT NOT NULL,
    meta TEXT NOT NULL,
    dispatch_snapshot TEXT,
    settings_rev INTEGER NOT NULL,
    epoch INTEGER NOT NULL,
    outcome TEXT,
    error TEXT,
    result TEXT,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  )`,
  `CREATE INDEX reviews_watch ON reviews (watch_id, created_at)`,
  `CREATE TABLE ledger (
    id TEXT PRIMARY KEY,
    review_id TEXT NOT NULL,
    watch_id TEXT NOT NULL,
    route TEXT NOT NULL,
    model TEXT,
    billing TEXT NOT NULL,
    state TEXT NOT NULL,
    day TEXT NOT NULL,
    reserved_usd REAL NOT NULL DEFAULT 0,
    actual_usd REAL,
    reserved_tokens INTEGER NOT NULL DEFAULT 0,
    actual_tokens INTEGER,
    posted INTEGER NOT NULL DEFAULT 1,
    outcome TEXT,
    price_version TEXT,
    basis TEXT,
    note TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX ledger_day ON ledger (day, billing)`,
  `CREATE TABLE issues (
    watch_id TEXT NOT NULL,
    category TEXT NOT NULL,
    locator TEXT NOT NULL,
    state TEXT NOT NULL,
    subject_verified INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (watch_id, category, locator)
  )`,
  `CREATE TABLE occurrences (
    id TEXT PRIMARY KEY,
    watch_id TEXT NOT NULL,
    category TEXT NOT NULL,
    locator TEXT NOT NULL,
    severity TEXT NOT NULL,
    evidence TEXT NOT NULL,
    review_id TEXT NOT NULL,
    route TEXT NOT NULL,
    model TEXT,
    summary TEXT NOT NULL,
    shown TEXT NOT NULL,
    retained TEXT NOT NULL,
    as_of_seq INTEGER,
    coverage TEXT NOT NULL,
    score REAL,
    preview INTEGER NOT NULL DEFAULT 0,
    reconfirmed TEXT NOT NULL DEFAULT '[]',
    acknowledged_at INTEGER,
    cleared INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX occurrences_watch ON occurrences (watch_id, created_at)`,
  `CREATE TABLE notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    occurrence_id TEXT NOT NULL,
    watch_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    severity TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE settings_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    settings_rev INTEGER NOT NULL,
    keys TEXT NOT NULL,
    summary TEXT NOT NULL
  )`,
  `CREATE TABLE actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    watch_id TEXT,
    action TEXT NOT NULL,
    detail TEXT,
    via TEXT NOT NULL,
    caller TEXT NOT NULL DEFAULT 'unverified'
  )`,
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE checkpoints (watch_id TEXT PRIMARY KEY, snapshot TEXT NOT NULL)`,
  // A228: a held review keeps its first-held time; rechecks only move checked_at.
  `ALTER TABLE reviews ADD COLUMN held_at INTEGER`,
  `ALTER TABLE reviews ADD COLUMN checked_at INTEGER`,
  // A228: the later card that removed an open issue's cited lines (observed, not a verdict).
  `ALTER TABLE issues ADD COLUMN reversed_by TEXT`,
  `CREATE INDEX ledger_created ON ledger (billing, created_at)`,
  // T103: whole-Initiative watches and the members they have seen. Member
  // threads are ordinary watches (origin "initiative"), so a build without
  // these tables still observes them as thread watches.
  `CREATE TABLE initiative_watches (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    since INTEGER NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    synced_at INTEGER,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE initiative_members (
    initiative_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    role TEXT NOT NULL,
    worker TEXT,
    generation INTEGER,
    state TEXT NOT NULL,
    excluded INTEGER NOT NULL DEFAULT 0,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    PRIMARY KEY (initiative_id, thread_id)
  )`,
  `CREATE INDEX initiative_members_thread ON initiative_members (thread_id)`,
  // T105: the separate BB thread Erwin opened to discuss a finding (reused by later Discuss clicks).
  `CREATE TABLE discussions (
    occurrence_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX occurrences_feed ON occurrences (created_at, id)`,
];
