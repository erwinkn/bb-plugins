// Read-only access to the retired coordinator records. No runtime owns these rows.
import type Database from "better-sqlite3";

export class CoordinatorStore {
  constructor(private db: Database.Database) {}
  getConversation(id: string) {
    return this.db.prepare("SELECT * FROM voice_conversations WHERE id=?").get(id) ?? null;
  }
  listRequests(conversationId: string) {
    return this.db.prepare("SELECT * FROM voice_requests WHERE conversation_id=? ORDER BY seq").all(conversationId);
  }
  listReplies(conversationId: string) {
    return this.db.prepare("SELECT * FROM voice_replies WHERE conversation_id=? ORDER BY seq").all(conversationId);
  }
  listQuestions(conversationId: string) {
    return this.db.prepare("SELECT * FROM voice_questions WHERE conversation_id=? ORDER BY created_at").all(conversationId);
  }
  listUpdates(conversationId: string) {
    return this.db.prepare("SELECT * FROM voice_updates WHERE conversation_id=? ORDER BY created_at").all(conversationId);
  }
  watchList(conversationId: string) {
    return this.db.prepare("SELECT * FROM voice_watch WHERE conversation_id=? ORDER BY added_at").all(conversationId);
  }
}
