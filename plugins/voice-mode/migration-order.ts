import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { LIVE_ACTION_MIGRATIONS } from "./live-action-store.ts";
import { MESSAGE_SEND_MIGRATIONS } from "./coordinator/store.ts";
import { SEQUENCE_MIGRATIONS } from "./sequence-manager.ts";

/** Two versions extended the same migration prefix before their code was reconciled.
 * Keep the recorded prefix for either version; never rewrite migration history.
 * Fresh installs use the order already deployed in the local Voice plugin.
 */
export function voiceFeatureMigrations(db: Database.Database, firstIndex: number): string[] {
  const exists = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  const hasHashes = exists("_bb_migrations") && (db.prepare("PRAGMA table_info(_bb_migrations)").all() as {name:string}[]).some(column => column.name === "statement_hash");
  const first = hasHashes ? db.prepare("SELECT statement_hash FROM _bb_migrations WHERE id = ?").get(firstIndex) as {statement_hash:string|null}|undefined : undefined;
  const hash = (sql: string) => createHash("sha256").update(sql).digest("hex");
  const liveFirst = first?.statement_hash
    ? first.statement_hash === hash(LIVE_ACTION_MIGRATIONS[0])
    : exists("voice_action_groups") && !exists("voice_sequences");
  return liveFirst
    ? [...LIVE_ACTION_MIGRATIONS, ...SEQUENCE_MIGRATIONS, ...MESSAGE_SEND_MIGRATIONS]
    : [...SEQUENCE_MIGRATIONS, ...MESSAGE_SEND_MIGRATIONS, ...LIVE_ACTION_MIGRATIONS];
}
