// Frozen schema from Voice Mode before call control and prompt proposals.
export const legacyMigrations = [
  "CREATE TABLE IF NOT EXISTS usage_events (\n      id INTEGER PRIMARY KEY AUTOINCREMENT,\n      ts INTEGER NOT NULL,\n      model TEXT NOT NULL,\n      input_text INTEGER NOT NULL DEFAULT 0,\n      input_audio INTEGER NOT NULL DEFAULT 0,\n      cached_text INTEGER NOT NULL DEFAULT 0,\n      cached_audio INTEGER NOT NULL DEFAULT 0,\n      output_text INTEGER NOT NULL DEFAULT 0,\n      output_audio INTEGER NOT NULL DEFAULT 0\n    )",
  "ALTER TABLE usage_events ADD COLUMN session_id TEXT",
  "CREATE TABLE IF NOT EXISTS session_events (\n      id INTEGER PRIMARY KEY AUTOINCREMENT,\n      session_id TEXT NOT NULL,\n      ts INTEGER NOT NULL,\n      kind TEXT NOT NULL,\n      payload TEXT NOT NULL DEFAULT '{}'\n    )",
  "CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events (session_id, ts)",
  "CREATE TABLE IF NOT EXISTS prompt_versions (\n      id INTEGER PRIMARY KEY AUTOINCREMENT,\n      ts INTEGER NOT NULL,\n      source TEXT NOT NULL,\n      note TEXT,\n      content TEXT NOT NULL\n    )"
];
