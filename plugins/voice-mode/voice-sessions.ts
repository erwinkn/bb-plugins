import type Database from "better-sqlite3";
import { z } from "zod";

export const voiceSessionSchema = z.object({
  id: z.string(), title: z.string(), createdAt: z.number(), updatedAt: z.number(),
  coordinatorThreadId: z.string().nullable(), callIds: z.array(z.string()),
  currentCallNonce: z.string().nullable(), legacy: z.boolean(),
}).strict();
export type VoiceSession = z.infer<typeof voiceSessionSchema>;

/** Read-only projection. Historical events are never rewritten or removed. */
export class VoiceSessions {
  constructor(private readonly db: Database.Database) {}
  rows(): VoiceSession[] {
    const conversations = this.db.prepare("SELECT id, created_at, updated_at, coordinator_thread_id, current_call_nonce FROM voice_conversations").all() as Array<{id:string;created_at:number;updated_at:number;coordinator_thread_id:string|null;current_call_nonce:string|null}>;
    const links = new Map((this.db.prepare("SELECT call_id, conversation_id FROM voice_conversation_calls").all() as Array<{call_id:string;conversation_id:string}>).map(r => [r.call_id,r.conversation_id]));
    // Older releases logged the association without a dedicated relation.
    for (const r of this.db.prepare("SELECT session_id, payload FROM session_events WHERE kind = 'coordinator.conversation' ORDER BY id").all() as Array<{session_id:string;payload:string}>) {
      try { const p = JSON.parse(r.payload); if (!links.has(r.session_id) && typeof p.conversationId === "string") links.set(r.session_id,p.conversationId); } catch { /* historical malformed diagnostics */ }
    }
    for (const r of this.db.prepare("SELECT DISTINCT call_nonce, conversation_id FROM voice_requests").all() as Array<{call_nonce:string;conversation_id:string}>) if (!links.has(r.call_nonce)) links.set(r.call_nonce,r.conversation_id);
    const result = new Map<string, VoiceSession>(conversations.map(c => [c.id,{id:c.id,title:"Voice conversation",createdAt:c.created_at,updatedAt:c.updated_at,coordinatorThreadId:c.coordinator_thread_id,currentCallNonce:c.current_call_nonce,callIds:[],legacy:false}]));
    const calls = this.db.prepare("SELECT session_id, MIN(ts) started, MAX(ts) ended FROM session_events WHERE session_id != 'audio-diagnostics' GROUP BY session_id ORDER BY started").all() as Array<{session_id:string;started:number;ended:number}>;
    for (const call of calls) {
      const id = links.get(call.session_id) ?? call.session_id;
      let row = result.get(id);
      if (!row) { row = {id:call.session_id,title:"Voice conversation",createdAt:call.started,updatedAt:call.ended,coordinatorThreadId:null,currentCallNonce:null,callIds:[],legacy:true}; result.set(row.id,row); }
      row.callIds.push(call.session_id); row.createdAt = Math.min(row.createdAt,call.started); row.updatedAt = Math.max(row.updatedAt,call.ended);
      if (row.title === "Voice conversation") {
        const first = this.db.prepare("SELECT payload FROM session_events WHERE session_id = ? AND kind = 'user' ORDER BY id LIMIT 1").get(call.session_id) as {payload:string}|undefined;
        try { const text = first && JSON.parse(first.payload).text; if (typeof text === "string" && text.trim()) row.title = text.trim().slice(0,100); } catch { /* keep generic title */ }
      }
    }
    return [...result.values()].sort((a,b) => b.updatedAt-a.updatedAt || b.id.localeCompare(a.id));
  }
  list(before?: {updatedAt:number;id:string}) {
    const rows = this.rows().filter(r => !before || r.updatedAt < before.updatedAt || (r.updatedAt === before.updatedAt && r.id < before.id));
    return {sessions:rows.slice(0,40),hasMore:rows.length>40};
  }
  get(id:string) {
    const session = this.rows().find(r => r.id === id || r.callIds.includes(id));
    if (!session) throw new Error("Voice session not found.");
    const query = this.db.prepare("SELECT id, ts, kind, payload, session_id AS callId FROM session_events WHERE session_id = ? ORDER BY id");
    const events = session.callIds.flatMap(id => query.all(id) as Array<{id:number;ts:number;kind:string;payload:string;callId:string}>).sort((a,b)=>a.ts-b.ts || a.id-b.id);
    return {session,events};
  }
  link(callId:string,conversationId:string) {
    this.db.prepare("INSERT OR IGNORE INTO voice_conversation_calls (call_id, conversation_id) VALUES (?, ?)").run(callId,conversationId);
  }
}
