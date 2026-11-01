import { expect, it } from "vitest";
import { fixture, stuckLuna } from "./fixture";
it("ingests active accepted input and semantic output exactly once across restart", async () => {
 const f=fixture(); const s=await f.attach("initiatives","p:worker:1",f.thread("w"));
 const requestId=f.say("w","accepted brief");
 f.history.push({threadId:"w",seq:1000,type:"turn/input/accepted",data:{clientRequestId:requestId}});
 f.history.push({threadId:"w",seq:1001,type:"item/completed",data:{item:{type:"agentMessage",text:"stable reply"}}});
 await f.memory.ingest("w"); expect(f.log(s)).toEqual(["user: accepted brief","agent: stable reply"]);
 f.memory.dispose(); await f.memory.settled(); f.memory.start(); await f.memory.ingest("w"); expect(f.log(s)).toHaveLength(2);
});
it("never admits raw history when summaries are unavailable", async()=>{
 const f=fixture(); await f.attach("initiatives","p",f.thread("w")); f.memory.useSummarizer(stuckLuna); f.memory.waits.turn=100;
 f.turn("w","past","RAW".repeat(1000));
 await expect(f.ask("w",f.say("w","next"),"next")).rejects.toThrow("no summary yet");
});

it("keeps unaccepted queued input durable across a completed turn and restart, then logs it only on acceptance",async()=>{
 const f=fixture();const s=await f.attach("initiatives","p:worker:1",f.thread("w"));
 const a=f.say("w","first");
 f.history.push({threadId:"w",seq:200,type:"turn/input/accepted",data:{clientRequestId:a}});
 await f.memory.ingest("w");
 f.history.push({threadId:"w",seq:201,type:"client/turn/requested",data:{requestId:"queued",input:[{type:"text",text:"later"}]}});
 f.history.push({threadId:"w",seq:202,type:"turn/completed",data:{status:"completed"}});
 await f.memory.ingest("w"); expect(f.log(s)).toEqual(["user: first"]);
 f.memory.dispose(); await f.memory.settled(); f.memory.start();
 f.history.push({threadId:"w",seq:203,type:"turn/input/accepted",data:{clientRequestId:"queued"}});
 await f.memory.ingest("w"); expect(f.log(s)).toEqual(["user: first","user: later"]);
 await f.memory.ingest("w"); expect(f.log(s)).toHaveLength(2);
});
it("coalesces a burst of 1000 already-debounced semantic notifications to at most two page reads",async()=>{
 const f=fixture(); await f.attach("initiatives","p",f.thread("w")); f.reads.length=0;
 const {makeThreadResponse}=await import("@get-bb/plugin-sdk/testing");
 await Promise.all(Array.from({length:1000},()=>f.harness.behavior.emitThreadEvent("experimental_thread.events",{thread:makeThreadResponse({id:"w"}),sequence:100} as never)));
 await f.memory.settled(); expect(f.reads.length).toBeLessThanOrEqual(2);
});
it("dispatch waits promptly for preparation, then rechecks the durable core queue once ready",async()=>{
 const f=fixture(); const s=await f.attach("initiatives","p:worker:1",f.thread("w"));
 f.memory.useSummarizer(stuckLuna); f.turn("w","past","x".repeat(1000));
 f.memory.kick("w"); await new Promise(r=>setTimeout(r,10));
 let rechecks=0; f.memory["deps"].recheck=()=>{rechecks++;};
 expect(await f.dispatch("w")).toMatchObject({action:"wait",reason:expect.stringContaining("preparing")});
 expect((await f.memory.status(s)).tree.ready).toBe(false);
 f.memory.dispose();await f.memory.settled();f.memory.start();
 const {fakeLuna}=await import("./fixture");f.memory.useSummarizer(fakeLuna);f.memory.build(s);await f.memory.settled();
 expect(rechecks).toBe(1);expect((await f.memory.status(s)).tree.ready).toBe(true);
 expect(await f.dispatch("w")).toEqual({action:"proceed"});
});
it("keeps accepted inputs from a prior scope out of a new private worker scope",async()=>{
 const f=fixture();const old=await f.attach("initiatives","p",f.thread("w"));const id=f.say("w","pending old scope");
 await f.memory.ingest("w");const next=await f.attach("initiatives","p:worker:1","w");
 f.history.push({threadId:"w",seq:1000,type:"turn/input/accepted",data:{clientRequestId:id}});
 await f.memory.ingest("w");expect(f.log(next)).toEqual([]);expect(f.log(old)).toEqual([]);
});
it("waits for only the merges needed to bound the historical view, after out-of-order completion and recovery",async()=>{
 const f=fixture();const s=await f.attach("initiatives","p:worker:1",f.thread("w"));
 const {fakeLuna}=await import("./fixture");
 f.store.append("w",Array.from({length:300},(_,i)=>({kind:"agent" as const,text:"source ".repeat(200),at:i,threadId:"w",seq:i+1})),300);
 const tree=f.store.tree(s);
 for(let i=0;i<300;i++)tree.saveNode(0,i,"x".repeat(576),"model",1);
 tree.saveViews({fed:300,chat:Array.from({length:300},(_,i)=>[0,i]),compaction:[],merging:true});
 f.memory.dispose();await f.memory.settled();f.memory.start();
 const held:Array<()=>void>=[];
 f.memory.useSummarizer(async r=>{await new Promise<void>(resolve=>{held.push(resolve);r.signal.addEventListener("abort",()=>resolve(),{once:true});});return fakeLuna(r);});
 let rechecks=0;f.memory["deps"].recheck=()=>{rechecks++;};
 expect((await f.memory.status(s)).tree.ready).toBe(false);
 expect(await f.dispatch("w")).toMatchObject({action:"wait"});
 const tick=()=>new Promise<void>(r=>setImmediate(r));
 for(let n=0;n<1000 && !(await f.memory.status(s)).tree.ready;n++){held.pop()?.();await tick();}
 expect((await f.memory.status(s)).tree.ready).toBe(true);
 expect(rechecks).toBe(1);expect(held.length).toBeGreaterThan(0);
 expect(await f.dispatch("w")).toEqual({action:"proceed"});
 f.history.push({threadId:"w",seq:10000,type:"client/turn/requested",data:{requestId:"after-recovery",input:[{type:"text",text:"go"}]}});
 const answer=await f.ask("w","after-recovery","go") as {systemPrompt:string;input:string};
 const lines=(answer.systemPrompt+"\n"+answer.input).split("\n").filter(l=>/^\d+\+\d+\|/.test(l));
 expect(Buffer.byteLength(lines.join("\n"))+lines.length).toBeLessThanOrEqual(128_000);
 expect(lines.join("\n")).not.toContain("not summarized yet");
 f.memory.dispose();await f.memory.settled();
});
it("logs a previously unsent original once when a retry is finally accepted",async()=>{
 const f=fixture();const s=await f.attach("initiatives","p",f.thread("w"));
 const id=f.say("w","original question");
 // Establish modern provider semantics without accepting this pending request.
 f.history.push({threadId:"w",seq:1000,type:"turn/input/accepted",data:{clientRequestId:"other"}});
 f.history.push({threadId:"w",seq:1001,type:"provider/error",data:{detail:"OptChat memory unavailable for this turn"}});
 f.history.push({threadId:"w",seq:1002,type:"turn/completed",data:{status:"failed"}});
 await f.memory.ingest("w");expect(f.log(s)).toEqual([]);
 f.history.push({threadId:"w",seq:1003,type:"client/turn/requested",data:{requestId:"retry",retryOfRequestId:id,input:[{type:"text",text:"original question"}]}});
 f.history.push({threadId:"w",seq:1004,type:"turn/input/accepted",data:{clientRequestId:"retry"}});
 await f.memory.ingest("w");expect(f.log(s)).toEqual(["user: original question"]);
});
