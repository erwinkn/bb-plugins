import type Database from "better-sqlite3";
import { createHash } from "node:crypto";

/**
 * BB 0.43.1's `bb.storage.migrate` (runPluginStorageMigrations in
 * start-server.js), for offline tools only: the dry run and tests build an
 * empty ledger exactly as an install would, `_bb_migrations` hashes included.
 */
export function applyMigrations(db: Database.Database, statements: string[]) {
  db.exec("CREATE TABLE IF NOT EXISTS _bb_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, statement_hash TEXT)");
  const applied = new Set((db.prepare("SELECT id FROM _bb_migrations").all() as { id: number }[]).map((row) => row.id));
  const record = db.prepare("INSERT INTO _bb_migrations (id, applied_at, statement_hash) VALUES (?, ?, ?)");
  db.transaction(() => {
    statements.forEach((statement, index) => {
      if (applied.has(index)) return;
      db.exec(statement);
      record.run(index, Date.now(), createHash("sha256").update(statement).digest("hex"));
    });
  })();
}
