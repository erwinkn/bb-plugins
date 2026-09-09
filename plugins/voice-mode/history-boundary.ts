import type Database from "better-sqlite3";

/** Historical coordinator threads are readable records, never live effect targets. */
export function isHistoricalAgentThread(db: Database.Database, threadId: string) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='voice_conversations'").get()) return false;
  return !!db.prepare("SELECT 1 FROM voice_conversations WHERE coordinator_thread_id=? LIMIT 1").get(threadId);
}
