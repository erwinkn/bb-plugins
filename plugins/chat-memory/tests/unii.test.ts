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
it("R12: shows a message whose summary is unavailable by its start only, in a summary's size", async()=>{
 const f=fixture(); await f.attach("initiatives","p",f.thread("w")); f.memory.useSummarizer(stuckLuna); f.memory.waits.turn=100;
 f.turn("w","past","RAW".repeat(1000));
 const a=await f.ask("w",f.say("w","next"),"next") as {systemPrompt:string;input:string};
 const line=(a.systemPrompt+"\n"+a.input).split("\n").find(l=>l.startsWith("1+1|"))!;
 expect(line).toMatch(/^1\+1\|agent: RAW[RAW]*… \(not summarized yet: zoom it\)$/);
 expect(Buffer.byteLength(line.slice("1+1|".length))).toBeLessThanOrEqual(512);
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
it("keeps accepted inputs from a prior scope out of a new private worker scope",async()=>{
 const f=fixture();const old=await f.attach("initiatives","p",f.thread("w"));const id=f.say("w","pending old scope");
 await f.memory.ingest("w");const next=await f.attach("initiatives","p:worker:1","w");
 f.history.push({threadId:"w",seq:1000,type:"turn/input/accepted",data:{clientRequestId:id}});
 await f.memory.ingest("w");expect(f.log(next)).toEqual([]);expect(f.log(old)).toEqual([]);
});
it("past its ceiling, waits for only the merges needed to bound the historical view, after out-of-order completion and recovery",async()=>{
 const f=fixture();const s=await f.attach("initiatives","p:worker:1",f.thread("w"));
 const {fakeLuna}=await import("./fixture");
 f.store.append("w",Array.from({length:300},(_,i)=>({kind:"agent" as const,text:"source ".repeat(200),at:i,threadId:"w",seq:i+1})),300);
 const tree=f.store.tree(s);
 for(let i=0;i<300;i++)tree.saveNode(0,i,"x".repeat(576),"model",1);
 tree.saveViews({fed:300,chat:Array.from({length:300},(_,i)=>[0,i]),compaction:[],merging:true});
 f.memory.dispose();await f.memory.settled();f.memory.start();
 const held:Array<()=>void>=[];
 f.memory.useSummarizer(async r=>{await new Promise<void>(resolve=>{held.push(resolve);r.signal.addEventListener("abort",()=>resolve(),{once:true});});return fakeLuna(r);});
 // R12: 175 KB, over the 128 KB target but under the ceiling, goes without waiting for merges.
 expect(await f.dispatch("w")).toEqual({action:"proceed"});f.memory.ceiling=128_000;
 expect((await f.memory.status(s)).tree.ready).toBe(false);
 // Past the ceiling, the dispatch still goes at once: the turn is what waits.
 expect(await f.dispatch("w")).toEqual({action:"proceed"});
 f.history.push({threadId:"w",seq:10000,type:"client/turn/requested",data:{requestId:"after-recovery",input:[{type:"text",text:"go"}]}});
 let answered=false;
 const asked=f.ask("w","after-recovery","go").finally(()=>{answered=true;}) as Promise<{systemPrompt:string;input:string}>;
 const tick=()=>new Promise<void>(r=>setImmediate(r));
 for(let n=0;n<1000 && !answered;n++){held.pop()?.();await tick();}
 const answer=await asked;
 expect((await f.memory.status(s)).tree.ready).toBe(true);
 expect(held.length).toBeGreaterThan(0);
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
