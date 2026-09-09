import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

type Conversation = { id:string; status:string; currentCallNonce:string|null; callStartedAt:number|null };
/** Active conversation and call ownership only. Historical work is never resumed here. */
export class ConversationRecord {
  constructor(private db:Database.Database,private now=Date.now) {}
  currentConversationId():string|null {
    return (this.db.prepare("SELECT current_conversation_id AS id FROM voice_conversation_control WHERE slot=1").get() as {id:string|null}|undefined)?.id ?? null;
  }
  createConversation():Conversation {
    const id=`conv_${randomUUID()}`,at=this.now();
    this.db.prepare("INSERT INTO voice_conversations(id,created_at,updated_at,status,state_json) VALUES (?,?,?,'active','{}')").run(id,at,at);
    this.db.prepare("UPDATE voice_conversation_control SET current_conversation_id=? WHERE slot=1").run(id);
    return this.getConversation(id)!;
  }
  getConversation(id:string):Conversation|null {
    return this.db.prepare("SELECT id,status,current_call_nonce AS currentCallNonce,call_started_at AS callStartedAt FROM voice_conversations WHERE id=?").get(id) as Conversation|undefined ?? null;
  }
  listConversations(limit=100):Conversation[] {
    return this.db.prepare("SELECT id,status,current_call_nonce AS currentCallNonce,call_started_at AS callStartedAt FROM voice_conversations ORDER BY updated_at DESC LIMIT ?").all(limit) as Conversation[];
  }
  startCall(input:{nonce:string;sequence:number;view:{threadId:string|null;projectId:string|null};newConversation:boolean;conversationId?:string}) {
    const id=input.conversationId ?? this.currentConversationId();
    let conversation=input.newConversation || !id ? null : this.getConversation(id);
    if(conversation && !["active","released"].includes(conversation.status))conversation=null;
    const resumed=!!conversation?.callStartedAt;
    conversation ??= this.createConversation();
    const at=this.now();
    this.db.prepare("UPDATE voice_conversations SET status='active',current_call_nonce=?,current_call_sequence=?,call_started_at=?,resumed_at=CASE WHEN ? THEN ? ELSE resumed_at END,updated_at=?,revision=revision+1,state_json=json_set(state_json,'$.viewedThreadId',?,'$.viewedProjectId',?) WHERE id=?")
      .run(input.nonce,input.sequence,at,resumed?1:0,at,at,input.view.threadId,input.view.projectId,conversation.id);
    this.db.prepare("UPDATE voice_conversation_control SET current_conversation_id=? WHERE slot=1").run(conversation.id);
    return {conversationId:conversation.id,resumed,queuedUpdates:0};
  }
  endCall(nonce:string) {
    this.db.prepare("UPDATE voice_conversations SET current_call_nonce=NULL,status='released',updated_at=? WHERE current_call_nonce=?").run(this.now(),nonce);
  }
}
