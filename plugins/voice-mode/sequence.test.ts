import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { CoordinatorStore, COORDINATOR_MIGRATIONS } from "./coordinator/store.ts";
import { SequenceManager, SEQUENCE_MIGRATIONS } from "./sequence-manager.ts";
import { SequencePlayer } from "./sequence-player.ts";
import { narratedSequenceSchema, type SequenceInput, type SequenceState } from "./narrated-sequence.ts";
import type { PublishedReply } from "./coordinator/envelopes.ts";
import type { UiActionResult } from "./ui-actions.ts";

const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
const plan=narratedSequenceSchema.parse({title:"Current work",steps:[
  {kind:"speech",text:"Here is the current work."},
  {kind:"action",action:{kind:"open_thread",threadId:"thread-a"}},
  {kind:"speech",text:"This is the editor work. The diff view is ready."},
  {kind:"action",action:{kind:"open_thread",threadId:"thread-b"}},
  {kind:"speech",text:"This is the planning work."},
]});
function fixture(t:TestContext,execute?:()=>Promise<UiActionResult>) {
  const db=new Database(":memory:");for(const sql of [...COORDINATOR_MIGRATIONS,...SEQUENCE_MIGRATIONS])db.exec(sql);
  const store=new CoordinatorStore(db);const conversation=store.createConversation();
  let nonce="desktop";
  store.updateConversation(conversation.id,{currentCallNonce:nonce});
  const reply=store.recordReply({conversationId:conversation.id,requestId:"r",batchId:null,questionId:null,kind:"final",source:"tool",body:{speech:"",detail:null,threadIds:[],receipts:[],focusThreadId:null,sequence:plan},ready:true,delivery:"pending",targetCallNonce:nonce});
  const actions:string[]=[];const speech:PublishedReply[]=[];const cancelled:string[]=[];const context:string[]=[];
  const manager=new SequenceManager(db,store,(_id,n)=>n===nonce,async(_s,a)=>{actions.push(a.kind);return execute ? execute() : {status:"succeeded",detail:"Opened"};},id=>cancelled.push(id));
  let gate=true;
  const player=new SequencePlayer({callNonce:()=>nonce,rpc:input=>manager.run(input),speak:r=>speech.push(r),cancelAction:id=>cancelled.push(id),context:text=>context.push(text),log:()=>{},changed:()=>{if(gate)player.drain();}},conversation.id);
  const input=(state:SequenceState,operation:SequenceInput["operation"]):SequenceInput=>({conversationId:conversation.id,callNonce:nonce,replyId:reply.id,revision:state.revision,index:state.index,operation});
  t.after(()=>{gate=false;player.dispose();db.close();});
  return {db,store,manager,player,reply,conversation,actions,speech,cancelled,context,input,setNonce:(n:string)=>{nonce=n;},setGate:(v:boolean)=>{gate=v;}};
}

test("a plan interweaves speech and actions; generating audio alone never advances it",async t=>{
  const f=fixture(t);await f.player.recover(f.reply.id);await settle();
  assert.equal(f.speech.length,1);assert.equal(f.actions.length,0);
  await settle();assert.equal(f.actions.length,0,"no next action before playback receipt");
  f.player.playback(f.speech[0].replyId,"delivered");await settle();
  assert.equal(f.actions.length,1);assert.equal(f.speech.length,2);
  f.player.playback(f.speech[0].replyId,"delivered");await settle();
  assert.equal(f.actions.length,1,"duplicate delivery cannot advance the next step");
  f.player.playback(f.speech[1].replyId,"delivered");await settle();
  assert.equal(f.actions.length,2);assert.equal(f.speech.length,3);
  f.player.playback(f.speech[2].replyId,"delivered");await settle();
  assert.equal(f.player.state?.phase,"complete");assert.equal(f.store.getReply(f.reply.id)?.delivery,"delivered");
});

test("user interruption retains the spoken step and ignores its late completion",async t=>{
  const f=fixture(t);await f.player.recover(f.reply.id);await settle();const first=f.speech[0];
  await f.player.pause("User speaking");f.player.playback(first.replyId,"delivered");await settle();
  assert.equal(f.actions.length,0);assert.equal(f.player.state?.phase,"paused");
  await f.player.control("resume");await settle();assert.equal(f.speech.length,2);assert.notEqual(f.speech[1].replyId,first.replyId);
  f.player.playback(f.speech[1].replyId,"delivered");await settle();assert.equal(f.actions.length,1);
});

test("playback mismatch pauses and the caller's idle gate prevents the next action",async t=>{
  const f=fixture(t);await f.player.recover(f.reply.id);await settle();
  f.player.playback(f.speech[0].replyId,"mismatch");await settle();assert.equal(f.player.state?.phase,"paused");assert.equal(f.actions.length,0);
  f.setGate(false);await f.player.control("resume");await settle();assert.equal(f.speech.length,1);
  f.setGate(true);f.player.drain();await settle();assert.equal(f.speech.length,2);
});

test("a late action receipt cannot advance a paused sequence",async t=>{
  let resolve!:(r:UiActionResult)=>void;const f=fixture(t,()=>new Promise(r=>resolve=r));
  await f.player.recover(f.reply.id);await settle();f.player.playback(f.speech[0].replyId,"delivered");await settle();
  assert.equal(f.actions.length,1);await f.player.pause("User speaking");
  resolve({status:"succeeded",detail:"Opened"});await settle();assert.equal(f.player.state?.phase,"paused");assert.equal(f.speech.length,1);assert.ok(f.cancelled.length>0);
});

test("device transfer preserves position, pauses, and fences the old owner",async t=>{
  const f=fixture(t);await f.player.recover(f.reply.id);await settle();const old=f.player.state!;
  f.setNonce("mobile");
  await assert.rejects(f.manager.run({...f.input(old,"delivered"),callNonce:"desktop"}),/does not own/);
  const {state}=await f.manager.run({conversationId:f.conversation.id,callNonce:"mobile",operation:"sync"});
  assert.equal(state?.phase,"paused");assert.equal(state?.index,0);
  const stale=await f.manager.run({...f.input(old,"delivered"),callNonce:"mobile"});assert.equal(stale.state?.index,0);
});

test("uncertain actions require skip or stop; resume cannot replay them",async t=>{
  const f=fixture(t,async()=>({status:"unknown",detail:"Receipt lost"}));await f.player.recover(f.reply.id);await settle();
  f.player.playback(f.speech[0].replyId,"delivered");await settle();assert.equal(f.player.state?.blocked,true);
  await f.player.control("resume");await settle();assert.equal(f.actions.length,1);assert.equal(f.player.state?.phase,"paused");
  await f.player.control("stop");assert.equal(f.player.state?.phase,"cancelled");assert.equal(f.store.getReply(f.reply.id)?.delivery,"superseded");
});

test("sequence data rejects arbitrary tools, destructive actions, and excess steps",()=>{
  for(const action of [{kind:"archive_thread",threadId:"a"},{kind:"send_message",threadId:"a",text:"hi"},{kind:"shell",command:"ls"}]) {
    assert.equal(narratedSequenceSchema.safeParse({title:"test",steps:[{kind:"action",action},{kind:"speech",text:"Done"}]}).success,false);
  }
  assert.equal(narratedSequenceSchema.safeParse({title:"test",steps:Array(41).fill({kind:"speech",text:"Hi"})}).success,false);
});

test("resume on another device restores the view before its narration",async t=>{
  const f=fixture(t);await f.player.recover(f.reply.id);await settle();
  f.player.playback(f.speech[0].replyId,"delivered");await settle();assert.equal(f.player.state?.index,2);
  f.setGate(false);f.manager.pauseCall("desktop");f.setNonce("mobile");
  let state=(await f.manager.run({conversationId:f.conversation.id,callNonce:"mobile",operation:"sync"})).state!;
  assert.equal(state.phase,"paused");assert.equal(state.index,1,"return to the action before the unfinished speech");
  state=(await f.manager.run(f.input(state,"resume"))).state!;
  state=(await f.manager.run(f.input(state,"next"))).state!;
  assert.equal(f.actions.length,2);assert.equal(state.index,2);
});

test("skipping a failed action also skips the speech that depends on it",async t=>{
  let attempt=0;const f=fixture(t,async()=>++attempt===1 ? {status:"failed",detail:"Missing target"} : {status:"succeeded",detail:"Opened"});
  await f.player.recover(f.reply.id);await settle();f.player.playback(f.speech[0].replyId,"delivered");await settle();
  await f.player.control("skip");await settle();
  assert.equal(f.actions.length,2);assert.ok(!f.speech.some(reply=>reply.speech.includes("editor work")));
  assert.ok(f.speech.some(reply=>reply.speech.includes("planning work")));
});

test("interrupted narration identifies the current thread without claiming its speech was delivered",async t=>{
  const f=fixture(t);await f.player.recover(f.reply.id);await settle();
  f.player.started(f.speech[0].replyId);await settle();
  f.player.playback(f.speech[0].replyId,"delivered");await settle();
  const heard=f.store.getConversation(f.conversation.id)!.state.latestAnnouncement;
  const current=f.speech.at(-1)!;f.player.started(current.replyId);await settle();
  assert.deepEqual(f.player.narrating()?.threadIds,["thread-a"]);
  await f.player.pause("User asks about this thread");
  assert.equal(f.player.narrating()?.delivery,"interrupted");
  const state=f.store.getConversation(f.conversation.id)!.state;
  assert.deepEqual(state.latestAnnouncement,heard);
  assert.deepEqual(state.narrating?.threadIds,["thread-a"]);assert.equal(state.narrating?.delivery,"interrupted");
  f.player.started(f.speech[0].replyId);await settle();
  assert.deepEqual(f.player.narrating()?.threadIds,["thread-a"],"late starts cannot change the referenced thread");
  await f.player.control("stop");assert.equal(f.player.narrating(),null);
});
