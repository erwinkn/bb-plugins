import {expect,it} from "vitest";
import {fixture} from "./fixture";
import {CEILING_BYTES} from "../lib/turn";
import {VIEW_BYTES} from "../lib/tree";

it("retains the preceding final reply when the next input was queued mid-turn, across ingestion passes",async()=>{
 const f=fixture();await f.attach("initiatives","p",f.thread("w"));
 const first=f.say("w","first task");f.history.push({threadId:"w",seq:200,type:"turn/input/accepted",data:{clientRequestId:first}});await f.memory.ingest("w");
 f.history.push({threadId:"w",seq:201,type:"client/turn/requested",data:{requestId:"queued",input:[{type:"text",text:"use that result"}]}});
 await f.memory.ingest("w");
 f.history.push({threadId:"w",seq:202,type:"item/completed",data:{item:{type:"agentMessage",text:"IMPORTANT previous answer"}}});
 f.history.push({threadId:"w",seq:203,type:"turn/completed",data:{status:"completed"}});await f.memory.ingest("w");
 const answer=await f.ask("w","queued","use that result") as {systemPrompt:string;input:string};
 expect(answer.systemPrompt+answer.input).toContain("IMPORTANT previous answer");
});
it("excludes the accepted retry's normalized original entry from history across passes and restart",async()=>{
 const f=fixture();const scope=await f.attach("initiatives","p",f.thread("w"));const original=f.say("w","unique question");
 f.history.push({threadId:"w",seq:200,type:"turn/input/accepted",data:{clientRequestId:"other"}});
 f.history.push({threadId:"w",seq:201,type:"provider/error",data:{detail:"OptChat memory unavailable for this turn"}});
 f.history.push({threadId:"w",seq:202,type:"turn/completed",data:{status:"failed"}});await f.memory.ingest("w");
 f.history.push({threadId:"w",seq:203,type:"client/turn/requested",data:{requestId:"retry",retryOfRequestId:original,input:[{type:"text",text:"unique question"}]}});await f.memory.ingest("w");
 f.history.push({threadId:"w",seq:204,type:"turn/input/accepted",data:{clientRequestId:"retry"}});await f.memory.ingest("w");
 f.memory.dispose();await f.memory.settled();f.memory.start();
 const answer=await f.ask("w","retry","unique question") as {systemPrompt:string;input:string};
 expect(f.log(scope)).toEqual(["user: unique question"]);
 expect(answer.systemPrompt).not.toContain("unique question");expect(answer.input.split("unique question")).toHaveLength(2);
});
it("R12: a failed summary holds no turn under the ceiling; past it, the turn is refused visibly after a queue recheck, rather than repeating wait",async()=>{
 const f=fixture();f.memory.ceiling=300;const s=await f.attach("initiatives","p",f.thread("w"));
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 f.memory.useSummarizer(async()=>{await gate;return {ok:false,reason:"failed",error:"permanent failure"};});
 f.turn("w","first","x".repeat(1000));f.memory.kick("w");
 let rechecks=0;f.memory["deps"].recheck=()=>{rechecks++;};
 expect(await f.dispatch("w")).toMatchObject({action:"wait"});release();await f.memory.settled();expect(rechecks).toBe(1);
 for(let i=0;i<3;i++)expect(await f.dispatch("w")).toMatchObject({action:"reject",message:expect.stringContaining("permanent failure")});
 expect((await f.memory.status(s)).tree).toMatchObject({requiredFailure:expect.stringContaining("permanent failure")});
 f.memory.ceiling=CEILING_BYTES;expect(await f.dispatch("w")).toEqual({action:"proceed"});
 expect((await f.memory.status(s)).tree).toMatchObject({ready:true,requiredFailure:null,failed:1});
});
it("recovers both chunks and only the correct sender's image in a long batched worker report",async()=>{
 const f=fixture();const s=await f.attach("initiatives","p",f.thread("target"));f.thread("a",{title:"W1"});f.thread("b",{title:"W2"});
 const groups=[[{type:"text",text:"REPORT ".repeat(5000)+"FINAL-WORKER-EVIDENCE"},{type:"image",url:"data:image/png;base64,AQID"}],[{type:"text",text:"[bb message from thread:b; sent 2026-11-01T12:00:00Z]\nOTHER-WORKER"},{type:"image",url:"data:image/png;base64,BAUG"}]];
 f.history.push({threadId:"target",seq:1000,type:"client/turn/requested",data:{requestId:"batched",initiator:"agent",senderThreadId:"a",inputGroups:groups,input:groups.flat()}});
 f.history.push({threadId:"target",seq:1001,type:"turn/input/accepted",data:{clientRequestId:"batched"}});await f.memory.ingest("target");
 f.threads.get("a")!.title="a much longer mutable worker title";
 for(const legacy of [false,true]) for(const id of [0,1]){
  if(legacy) f.store.handle.prepare("UPDATE log SET source_part = NULL WHERE scope = ? AND i = ?").run(s,id);
  const text=await f.memory.zoomText(s,id,1,24_000);expect(text).toContain("FINAL-WORKER-EVIDENCE");expect(text).not.toContain("OTHER-WORKER");
  expect(await f.memory.evidence(s,id,1,0,0)).toMatchObject({content:[{type:"text"},{type:"image",data:"AQID"}]});
 }
});
it("past the ceiling, rejects blocked merge preparation only after legitimate pending merges settle",async()=>{
 const f=fixture();const scope=await f.attach("initiatives","p",f.thread("w"));
 f.store.append("w",Array.from({length:300},(_,i)=>({kind:"agent" as const,text:"source".repeat(200),at:i,threadId:"w",seq:i+1})),300);
 const tree=f.store.tree(scope);for(let i=0;i<300;i++)tree.saveNode(0,i,"x".repeat(512),"model",1);
 tree.saveViews({fed:300,chat:Array.from({length:300},(_,i)=>[0,i]),compaction:[],merging:true});
 // R12: 155 KB, over the 128 KB target but under the ceiling, goes without waiting for merges.
 expect(await f.dispatch("w")).toEqual({action:"proceed"});f.memory.ceiling=VIEW_BYTES.chat[0];
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);let held=false;
 f.memory.useSummarizer(async r=>{
  const text=r.input.map(m=>m.content.map(c=>c.text).join("\n")).join("\n");
  if(text.includes("merge lines 298+1 and 299+1")){held=true;await gate;}
  return {ok:false,reason:"failed",error:"permanent merge failure"};
 });
 let rechecks=0;f.memory["deps"].recheck=()=>{rechecks++;};expect(await f.dispatch("w")).toMatchObject({action:"wait"});
 for(let i=0;i<1000 && (!held || (await f.memory.status(scope)).tree.failed<149);i++)await new Promise<void>(r=>setImmediate(r));
 expect(held).toBe(true);expect((await f.memory.status(scope)).tree.failed).toBeGreaterThan(0);
 expect((await f.memory.status(scope)).tree.requiredFailure).toBeNull();expect(await f.dispatch("w")).toMatchObject({action:"wait"});
 release();await f.memory.settled();
 expect((await f.memory.status(scope)).tree.requiredFailure).toContain("permanent merge failure");
 expect(rechecks).toBe(1);for(let i=0;i<3;i++)expect(await f.dispatch("w")).toMatchObject({action:"reject",message:expect.stringContaining("merge")});
});
it("does not reject a bounded healthy view for an unused failed ancestor",async()=>{
 const f=fixture();const scope=await f.attach("initiatives","p",f.thread("w"));
 f.store.append("w",[0,1].map(i=>({kind:"agent" as const,text:"source".repeat(200),at:i,threadId:"w",seq:i+1})),2);
 const tree=f.store.tree(scope);for(let i=0;i<2;i++)tree.saveNode(0,i,"x".repeat(512),"model",1);
 tree.saveViews({fed:2,chat:[[0,0],[0,1]],compaction:[],merging:false});
 f.memory.useSummarizer(async()=>({ok:false,reason:"failed",error:"unused ancestor failure"}));f.memory.build(scope);await f.memory.settled();
 expect((await f.memory.status(scope)).tree).toMatchObject({ready:true,requiredFailure:null,failed:1});expect(await f.dispatch("w")).toEqual({action:"proceed"});
});
it("retains an unsent first request for a later genuinely accepted retry, before any acceptance event exists",async()=>{
 const f=fixture();const scope=await f.attach("initiatives","p",f.thread("w"));const original=f.say("w","first unsent question");
 f.providerError("w","OptChat memory unavailable for this turn");f.done("w","failed");await f.memory.ingest("w");expect(f.log(scope)).toEqual([]);
 f.history.push({threadId:"w",seq:1000,type:"client/turn/requested",data:{requestId:"retry-first",retryOfRequestId:original,input:[{type:"text",text:"first unsent question"}]}});
 f.history.push({threadId:"w",seq:1001,type:"turn/input/accepted",data:{clientRequestId:"retry-first"}});await f.memory.ingest("w");
 expect(f.log(scope)).toEqual(["user: first unsent question"]);
 const a=await f.ask("w","retry-first","first unsent question") as {systemPrompt:string;input:string};expect(a.systemPrompt).not.toContain("first unsent question");
});
it("uses stable source ordinals for identical reports and preserves honest ambiguous legacy fallback",async()=>{
 const f=fixture();const scope=await f.attach("initiatives","p",f.thread("w"));
 const groups=[[{type:"text",text:"same report"},{type:"image",url:"data:image/png;base64,AQID"}],[{type:"text",text:"[bb message from thread:b; sent 2026-11-01T12:00:00Z]\nsame report"},{type:"image",url:"data:image/png;base64,BAUG"}]];
 f.history.push({threadId:"w",seq:1000,type:"client/turn/requested",data:{requestId:"same",initiator:"agent",senderThreadId:"a",inputGroups:groups,input:groups.flat()}});
 f.history.push({threadId:"w",seq:1001,type:"turn/input/accepted",data:{clientRequestId:"same"}});await f.memory.ingest("w");
 expect(await f.memory.evidence(scope,1,1,0,0)).toMatchObject({content:[{type:"text"},{type:"image",data:"BAUG"}]});
 f.store.handle.prepare("UPDATE log SET source_part = NULL WHERE scope = ?").run(scope);
 expect(await f.memory.zoomText(scope,1,1)).toContain("could not be matched");
 await expect(f.memory.evidence(scope,1,1,0,0)).rejects.toThrow("No attachment");
});
