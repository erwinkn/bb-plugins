import type { PublishedReply } from "./coordinator/envelopes.ts";
import { sequenceThreadIds, sequenceCommandId, sequenceStateSchema, type SequenceInput, type SequenceState } from "./narrated-sequence.ts";

export type SequenceControlResult = {status:"accepted"|"paused"|"missing"|"failed"|"held";message:string};

type Host = {
  callNonce():string|null;
  rpc(input:SequenceInput):Promise<{state:SequenceState|null}>;
  speak(reply:PublishedReply):void;
  cancelAction(requestId:string):void;
  context(text:string):void;
  changed():void;
  log(kind:string,data:Record<string,unknown>):void;
};

/** Advances only from a confirmed action or the matching audio playback receipt. */
export class SequencePlayer {
  state:SequenceState|null=null;
  private busy=false;
  private epoch=0;
  private suspended=false;
  private speechId:string|null=null;
  private disposed=false;
  private queuedReply:{replyId:string;requestId?:string|null}|undefined;
  private expectedRequestId:string|undefined;
  private pendingPause:Promise<void>=Promise.resolve();
  constructor(private host:Host,private conversationId:string) {}
  pending() { return this.busy || (!!this.state && !["complete","cancelled"].includes(this.state.phase)); }
  private input(operation:SequenceInput["operation"]):SequenceInput {
    return {conversationId:this.conversationId,callNonce:this.host.callNonce()!,operation,
      ...(this.state ? {replyId:this.state.replyId,index:this.state.index,revision:this.state.revision} : {})};
  }
  private accept(value:unknown) {
    if (value===null) return;
    const parsed=sequenceStateSchema.safeParse(value);
    if (!parsed.success || parsed.data.conversationId!==this.conversationId || parsed.data.callNonce!==this.host.callNonce()) return;
    this.state=parsed.data;
    this.host.log("sequence.state",{replyId:this.state.replyId,index:this.state.index,revision:this.state.revision,phase:this.state.phase,reason:this.state.reason});
    if (this.state.phase==="paused" || this.state.phase==="complete" || this.state.phase==="cancelled") this.describe();
  }
  private describe() {
    if (this.state) this.host.context(JSON.stringify({voice_sequence:{id:this.state.replyId,title:this.state.plan.title,step:this.state.index+1,total:this.state.plan.steps.length,phase:this.state.phase,reason:this.state.reason,blocked:this.state.blocked,instruction:"Use sequence_control for explicit pause/continue/skip/back/stop. Answer questions without losing this position. Do not execute planned actions yourself."}}));
  }
  async recover(replyId?:string,requestId?:string|null) {
    if (this.disposed || !this.host.callNonce()) return;
    if (this.busy) { if(replyId)this.queuedReply={replyId,requestId}; return; }
    if(replyId && this.expectedRequestId && requestId!==this.expectedRequestId)this.suspended=true;
    const epoch=++this.epoch;this.busy=true;
    try {
      const result=await this.host.rpc({...this.input("sync"),...(replyId ? {replyId} : {})});
      if (epoch!==this.epoch || this.disposed) return;
      this.accept(result.state);
      if (this.state) {
        this.describe();
        if ((this.suspended || this.state.phase==="speech" || this.state.phase==="action") && this.state.phase!=="paused") await this.pause("The user spoke while the plan was arriving.");
      }
    } catch { this.suspended=true; }
    finally { if (epoch===this.epoch) this.busy=false;this.host.changed(); const queued=this.queuedReply;this.queuedReply=undefined;if(queued)void this.recover(queued.replyId,queued.requestId); }
  }
  async pause(reason:string,restoreView=false) {
    this.suspended=true;
    const state=this.state;
    if (!state || !this.pending() || this.disposed) return;
    this.epoch++;this.busy=false;this.speechId=null;
    // next increments revision before starting the action; revoke both sides of that boundary locally.
    this.host.cancelAction(sequenceCommandId(state));
    this.host.cancelAction(sequenceCommandId({...state,revision:state.revision+1}));
    const input={...this.input("pause"),reason,restoreView};
    const epoch=this.epoch;
    const work=(async()=>{
      try {const result=await this.host.rpc(input);if (epoch===this.epoch && !this.disposed) this.accept(result.state);}
      catch { if (this.state) {this.state={...this.state,phase:"paused",reason:"Connection lost. Resume after reconnecting."};this.describe();} }
      this.host.changed();
    })();
    this.pendingPause=work;
    await work;
  }
  async control(operation:"pause"|"resume"|"skip"|"back"|"stop"):Promise<SequenceControlResult> {
    await this.pendingPause;
    if (!this.state || !this.pending()) return {status:"missing",message:"There is no paused or active sequence."};
    if (operation==="pause") {await this.pause("Paused by the user.");return {status:"paused",message:"The sequence is paused."};}
    // A control is a new user turn. Synchronize before resuming if transport lost the pause receipt.
    const epoch=++this.epoch;this.busy=true;
    try {
      const synced=await this.host.rpc(this.input("sync"));
      if (epoch!==this.epoch || this.disposed) return {status:"paused",message:"The sequence remains paused."};
      this.accept(synced.state);
      const result=await this.host.rpc(this.input(operation));
      if (epoch!==this.epoch || this.disposed) return {status:"paused",message:"The sequence remains paused."};
      this.accept(result.state);this.suspended=this.state?.phase==="paused";
      return this.suspended ? {status:"paused",message:`The sequence is paused: ${this.state?.reason ?? "the last action could not be confirmed"}. Skip this step or stop; do not claim success.`} : {status:"accepted",message:"Sequence control accepted. Wait silently; playback continues when this response ends."};
    } catch {this.suspended=true;return {status:"failed",message:"The sequence control could not be confirmed. It remains paused."};}
    finally {if(epoch===this.epoch)this.busy=false;this.host.changed();}
  }
  /** Caller must hold the normal speech/input/tool gate before entering here. */
  drain() {
    if (this.disposed || this.busy || this.suspended || !this.state || this.state.phase!=="ready" || !this.host.callNonce()) return;
    const epoch=this.epoch;this.busy=true;
    void this.host.rpc(this.input("next")).then(result=>{
      if (epoch!==this.epoch || this.disposed) return;
      this.accept(result.state);
      const state=this.state;
      if (state?.phase==="paused" && state.blocked) {
        this.host.speak({v:1,replyId:`local_sequence_failure_${state.replyId}_${state.revision}`,conversationId:this.conversationId,seq:state.index,requestId:null,batchId:null,questionId:null,kind:"failure",source:"bridge",speech:"I could not confirm that step. I've paused here. You can skip it or stop.",detail:null,threadIds:[],receipts:[],targetCallNonce:state.callNonce,createdAt:Date.now()});
      }
      if (state?.phase==="speech") {
        const step=state.plan.steps[state.index];
        if (step?.kind!=="speech") return;
        this.speechId=`sequence_speech:${state.replyId}:${state.index}:${state.revision}`;
        this.host.speak({v:1,replyId:this.speechId,conversationId:this.conversationId,seq:state.index,requestId:null,batchId:null,questionId:null,kind:"final",source:"bridge",speech:step.text,detail:null,threadIds:sequenceThreadIds(state.plan,state.index),receipts:[],targetCallNonce:state.callNonce,createdAt:Date.now()});
      }
    }).catch(()=>this.pause("The step result could not be confirmed.")).finally(()=>{if(epoch===this.epoch)this.busy=false;this.host.changed();});
  }
  playback(replyId:string,state:"delivered"|"interrupted"|"superseded"|"mismatch") {
    if (!replyId.startsWith("sequence_speech:")) return false;
    if (replyId!==this.speechId || this.disposed) return true;
    this.speechId=null;
    if (state!=="delivered") {void this.pause("Narration was interrupted. Say continue to repeat this part.");return true;}
    const epoch=this.epoch;this.busy=true;
    void this.host.rpc(this.input("delivered")).then(result=>{if(epoch===this.epoch && !this.disposed)this.accept(result.state);})
      .catch(()=>this.pause("Playback delivery could not be confirmed."))
      .finally(()=>{if(epoch===this.epoch)this.busy=false;this.host.changed();});
    return true;
  }
  // A new explicit request can receive a new sequence without inheriting an old pause.
  expectPlan(requestId:string) { this.expectedRequestId=requestId;this.suspended=false; }
  actionInFlight() { return this.busy && (this.state?.phase === "ready" || this.state?.phase === "action"); }
  dispose() {void this.pause("The call ended.");this.disposed=true;this.epoch++;}
}
