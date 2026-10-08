// Kept apart from write-receipts.ts, which needs node:crypto: store.ts reaches the app bundle.
export const WRITE_RECEIPT_MIGRATIONS = [
  `CREATE TABLE write_receipts (
    key TEXT PRIMARY KEY,
    project_id TEXT,
    command TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    state TEXT NOT NULL,
    answer TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX write_receipts_created ON write_receipts(created_at)`,
];
