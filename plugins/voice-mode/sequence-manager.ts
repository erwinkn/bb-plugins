import type Database from "better-sqlite3";
import type { CoordinatorStore } from "./coordinator/store.ts";
import type { UiAction, UiActionResult, UiCommand } from "./ui-actions.ts";
import { sequenceThreadIds, sequenceCommandId, sequenceStateSchema, type SequenceState, type SequenceInput } from "./narrated-sequence.ts";

export const SEQUENCE_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS voice_sequences (reply_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
];

/** Durable cursor. Only the call owner can run the current, coordinator-authored step. */
export class SequenceManager {
  constructor(private db:Database.Database, private store:CoordinatorStore,
    private live:(conversationId:string,nonce:string)=>boolean,
    private execute:(state:SequenceState, action:UiAction)=>Promise<UiActionResult>,
    private cancel:(requestId:string)=>void) {
    for (const state of this.rows()) if (!["complete","cancelled","paused"].includes(state.phase)) this.pause(state,"Voice Mode restarted.",true);
  }
  private rows(conversationId?:string):SequenceState[] {
    const rows = (conversationId ? this.db.prepare("SELECT state_json FROM voice_sequences WHERE conversation_id = ? ORDER BY updated_at DESC").all(conversationId) : this.db.prepare("SELECT state_json FROM voice_sequences").all()) as {state_json:string}[];
    return rows.flatMap(row => { try { const result=sequenceStateSchema.safeParse(JSON.parse(row.state_json)); return result.success ? [result.data] : []; } catch { return []; } });
  }
  private get(id:string):SequenceState|null {
    const row=this.db.prepare("SELECT state_json FROM voice_sequences WHERE reply_id = ?").get(id) as {state_json:string}|undefined;
    if(!row)return null;
    try {const parsed=sequenceStateSchema.safeParse(JSON.parse(row.state_json));return parsed.success ? parsed.data : null;}catch{return null;}
  }
  private save(state:SequenceState) {
    this.db.prepare("INSERT INTO voice_sequences VALUES (?, ?, ?, ?) ON CONFLICT(reply_id) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at").run(state.replyId,state.conversationId,JSON.stringify(state),Date.now());
    return state;
  }
  private pause(state:SequenceState,reason:string,restoreView=false) {
    if (["complete","cancelled"].includes(state.phase)) return state;
    const commandId=sequenceCommandId(state);
    const action=state.plan.steps[state.index];
    // A draft can append text. Never replay one whose execution was uncertain.
    state.blocked ||= state.phase === "action" && action?.kind === "action" && action.action.kind === "prepare_draft";
    if (restoreView && action?.kind==="speech") {
      // Restore the view on another device before repeating its narration.
      let previous=state.index-1;
      while(previous>=0 && state.plan.steps[previous].kind==="action") previous--;
      const first=previous+1;
      if(first<state.index && !state.plan.steps.slice(first,state.index).some(step=>step.kind==="action" && step.action.kind==="prepare_draft")) state.index=first;
    }
    state.phase="paused"; state.reason=reason; state.revision++;
    this.save(state); this.cancel(commandId);
    return state;
  }
  pauseCall(nonce:string,reason="The call ended.") { for (const state of this.rows()) if (state.callNonce===nonce) this.pause(state,reason,true); }
  hasPending(conversationId:string) { return this.rows(conversationId).some(s=>!["complete","cancelled"].includes(s.phase)); }
  owns(command:UiCommand) {
    const match=/^sequence:([^:]+):([0-9]+)$/.exec(command.requestId);
    const state=match ? this.get(match[1]) : null;
    return !!state && sequenceCommandId(state)===command.requestId && state.conversationId===command.conversationId && state.phase==="action" && state.callNonce===command.callNonce && this.live(state.conversationId,state.callNonce)
      && state.plan.steps[state.index]?.kind==="action"
      && JSON.stringify((state.plan.steps[state.index] as {action:UiAction}).action)===JSON.stringify(command.action);
  }
  async run(input:SequenceInput):Promise<{state:SequenceState|null}> {
    if (!this.live(input.conversationId,input.callNonce)) throw new Error("This device does not own the voice call.");
    let state=input.replyId ? this.get(input.replyId) : this.rows(input.conversationId).find(s=>!["complete","cancelled"].includes(s.phase)) ?? null;
    if (input.replyId && !state && input.operation==="sync") {
      const reply=this.store.getReply(input.replyId);
      if (!reply?.body.sequence || !reply.ready || reply.kind!=="final" || reply.batchId || reply.conversationId!==input.conversationId || reply.targetCallNonce!==input.callNonce || reply.delivery!=="pending") return {state:null};
      const request=reply.requestId ? this.store.getRequest(reply.requestId) : null;
      const newer=this.rows(input.conversationId).some(prior=>{
        const priorReply=this.store.getReply(prior.replyId);
        const priorRequest=priorReply?.requestId ? this.store.getRequest(priorReply.requestId) : null;
        return request && priorRequest ? priorRequest.seq>request.seq : (priorReply?.seq ?? 0)>reply.seq;
      });
      if(newer){this.store.updateReply(reply.id,{delivery:"superseded"});return {state:null};}
      for (const prior of this.rows(input.conversationId)) if (!["complete","cancelled"].includes(prior.phase)) {
        this.pause(prior,"A new sequence replaced this one."); prior.phase="cancelled"; this.save(prior);
      }
      state=this.save({replyId:reply.id,conversationId:input.conversationId,callNonce:input.callNonce,plan:reply.body.sequence,index:0,revision:0,phase:"ready",reason:null,blocked:false,completedDrafts:[]});
    }
    if (!state) return {state:null};
    if (state.conversationId!==input.conversationId) throw new Error("Sequence belongs to another conversation.");
    if (state.callNonce!==input.callNonce) {
      state=this.pause(state,"The call moved or resumed. Say continue to resume the sequence.",true);
      state.callNonce=input.callNonce; this.save(state);
    }
    if (input.operation==="sync") return {state};
    if (["complete","cancelled"].includes(state.phase)) return {state};
    if (input.operation==="pause" || input.operation==="stop") {
      state=this.pause(state,input.reason ?? "Paused by the user.",input.restoreView);
      if (input.operation==="stop") { state.phase="cancelled"; this.save(state); this.store.updateReply(state.replyId,{delivery:"superseded"}); }
      return {state};
    }
    if (input.revision!==state.revision || input.index!==state.index) return {state};
    if (["resume","skip","back"].includes(input.operation)) {
      if (state.phase!=="paused") return {state};
      if ((input.operation==="resume" || input.operation==="back") && state.blocked) return {state};
      if (input.operation==="skip") {
        const next=state.plan.steps.findIndex((step,index)=>index>state!.index && step.kind==="action");
        state.index=next>=0 ? next : state.plan.steps[state.index]?.kind==="speech" ? state.index+1 : state.plan.steps.length;
      }
      if (input.operation==="back") {
        // Replay only read-only view changes and speech, never a composer edit.
        const previous=Math.max(0,state.index-1);
        const step=state.plan.steps[previous];
        if (step?.kind==="action" && step.action.kind==="prepare_draft") { state.reason="A draft cannot be repeated. Say continue or skip."; return {state:this.save(state)}; }
        state.index=previous;
      }
      state.phase="ready";state.reason=null;state.blocked=false;state.revision++;
    } else if (input.operation==="delivered") {
      if (state.phase!=="speech") return {state};
      const spoken=state.plan.steps[state.index];
      if(spoken.kind==="speech") {
        const threadIds=sequenceThreadIds(state.plan,state.index);
        this.store.updateConversation(state.conversationId,{state:{openingAnswered:true,
          ...(threadIds[0] ? {discussedThreadId:threadIds[0]} : {}),
          latestAnnouncement:{replyId:state.replyId,threadIds,text:spoken.text,delivery:"delivered"},
        }});
      }
      state.index++;state.phase="ready";state.revision++;
    } else if (input.operation==="next") {
      if (state.phase!=="ready") return {state};
      const step=state.plan.steps[state.index];
      if (!step) return {state:this.complete(state)};
      if (step.kind==="action" && step.action.kind==="prepare_draft" && state.completedDrafts.includes(state.index)) {
        state.index++;state.revision++;return {state:state.index>=state.plan.steps.length ? this.complete(state) : this.save(state)};
      }
      state.phase=step.kind; state.revision++; this.save(state);
      if (step.kind==="speech") return {state};
      const revision=state.revision;
      let result:UiActionResult;
      try { result=await this.execute(state,step.action); }
      catch { result={status:"unknown",detail:"The action result could not be confirmed."}; }
      const current=this.get(state.replyId);
      if (!current || current.revision!==revision || current.phase!=="action" || !this.live(state.conversationId,state.callNonce)) return {state:current};
      state=current;
      if (result.status!=="succeeded") {
        state=this.pause(state,result.detail);state.blocked=true;
      } else { if(step.action.kind==="prepare_draft")state.completedDrafts.push(state.index);state.index++;state.phase="ready";state.revision++; }
    }
    if (state.index>=state.plan.steps.length) return {state:this.complete(state)};
    return {state:this.save(state)};
  }
  private complete(state:SequenceState) {
    state.phase="complete";state.revision++;this.save(state);
    this.store.updateReply(state.replyId,{delivery:"delivered"});
    this.store.updateConversation(state.conversationId,{state:{openingAnswered:true}});
    return state;
  }
}
