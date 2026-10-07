import { expect, it } from "vitest";
import { projectFixture } from "./fake-native";

// W190 re-check of the A297 fixes: cancelled recovery, re-review batch pinning, sweep retry.

type Fx=Awaited<ReturnType<typeof projectFixture>>["f"];
const tool=async(f:Fx,name:string,input:unknown,threadId="coordinator")=>JSON.parse(await f.harness.callAgentTool(name,input,{threadId}) as string);
let seq=100000;
const brief=(f:Fx)=>(f.store.db.prepare("SELECT brief_text FROM assignments ORDER BY rowid DESC LIMIT 1").get() as any)?.brief_text??"";
function start(f:Fx,input=brief(f),at=Date.now()){
 const requestId=`creq_${++seq}`;
 f.history.push({type:"client/turn/requested",seq:++seq,createdAt:at,data:{requestId,initiator:"agent",input:[{type:"text",text:input}]}});
 f.history.push({type:"turn/started",seq:++seq,createdAt:at});
 f.history.push({type:"turn/input/accepted",seq:++seq,createdAt:at,data:{clientRequestId:requestId}});
}
function end(f:Fx,text:string,status="completed",at=Date.now()){
 f.history.push({type:"item/completed",seq:++seq,createdAt:at,data:{item:{type:"agentMessage",text}}});
 f.history.push({type:"turn/completed",seq:++seq,createdAt:at,data:{status}});
}
async function reviewedFixture(){
 const {f,project}=await projectFixture();
 const task=f.task(project.id,"Original batch");const other=f.task(project.id,"Other batch");
 const [w]=await tool(f,"initiative_spawn",{label:"Implement",purpose:"implement",tasks:[task.ref],text:"Implement original batch"});
 start(f);end(f,"Original implementation");await f.runtime.onThreadIdle(f.idle(w.threadId));
 const [r]=await tool(f,"initiative_spawn",{role:"review",label:"Review",purpose:"review original batch",reviews:w.worker,text:"Review original batch"});
 start(f);end(f,"Original review");await f.runtime.onThreadIdle(f.idle(r.threadId));
 return{f,project,task,other,w,r};
}

it("a re-review with omitted tasks cannot switch to the implementer's later unrelated batch",async()=>{
 const {f,project,other,w,r}=await reviewedFixture();
 await tool(f,"initiative_message",{to:w.worker,work:true,tasks:[other.ref],text:"Implement a different batch"});
 start(f);end(f,"Unrelated batch implemented");await f.runtime.onThreadIdle(f.idle(w.threadId));
 const [again]=await tool(f,"initiative_message",{to:r.worker,work:true,text:"Re-review your original batch"});
 const a=f.store.assignment(project.id,Number(again.assignment.slice(1)))!;
 expect(a.reviewOf).not.toContain(other.num);
 // Pinned to the batch it was spawned for: those tasks, and that worker's report on them.
 expect(a.reviewOf).toEqual([f.store.assignment(project.id,1)!.taskNums[0]]);
 expect(a.handoffSources![0]).toMatchObject({worker:w.worker,assignment:"A1"});
});

it("legacy continued review cannot switch the reviewer to another worker",async()=>{
 const {f,other,r}=await reviewedFixture();
 const [w2]=await tool(f,"initiative_spawn",{label:"Other implementer",purpose:"other batch",tasks:[other.ref],text:"Implement other batch"});
 start(f);end(f,"Other worker implementation");await f.runtime.onThreadIdle(f.idle(w2.threadId));
 await expect(tool(f,"initiative_delegate",{action:"delegate",route:"continue",role:"review",worker:r.worker,reviews:w2.worker,tasks:[other.ref],note:"Review another worker"})).rejects.toThrow(/reviews W1's batch, not W3's/);
});

it("cancelling queued recovery during preparation prevents the new coordinator spawn",async()=>{
 const {f,project}=await projectFixture();
 f.threads.set("coordinator",{...f.threads.get("coordinator")!,status:"active"});
 f.service.requestHandover(project.id,{reason:"Restart",handover:"Reviewed handover"},"user");
 f.threads.set("coordinator",{...f.threads.get("coordinator")!,status:"error"});
 let release!:()=>void;let reached!:()=>void;
 const gate=new Promise<void>(resolve=>release=resolve);
 const atGate=new Promise<void>(resolve=>reached=resolve);
 f.intercept(async(path,args,call)=>{
  if(path==="threads.defaultExecutionOptions"&&args.threadId==="coordinator"){
   reached();await gate;
  }
  return call();
 });
 const drain=f.service.drainHandover(project.id);
 await atGate;
 const cancelled=f.service.cancelHandover(project.id,"user");
 expect(cancelled.state).toBe("cancelled");
 release();await drain;f.intercept();
 expect(f.store.project(project.id)!.coordinatorThreadId).toBe("coordinator");
 expect(f.spawn.mock.calls.filter(([args]:any)=>args.pluginMetadata?.role==="coordinator")).toHaveLength(0);
 expect(f.store.pendingHandover(project.id)).toBeNull();
});

async function gatedRecovery(){
 const {f,project}=await projectFixture();
 f.threads.set("coordinator",{...f.threads.get("coordinator")!,status:"active"});
 f.service.requestHandover(project.id,{reason:"Restart",handover:"Reviewed handover"},"user");
 f.threads.set("coordinator",{...f.threads.get("coordinator")!,status:"error"});
 let release!:()=>void;let reached!:()=>void;
 const gate=new Promise<void>(resolve=>release=resolve);
 const atGate=new Promise<void>(resolve=>reached=resolve);
 let held=true;
 f.intercept(async(path,args,call)=>{
  if(held&&path==="threads.defaultExecutionOptions"&&args.threadId==="coordinator"){held=false;reached();await gate;}
  return call();
 });
 const drain=f.service.drainHandover(project.id);
 await atGate;
 return {f,project,drain,release};
}
const coordinatorSpawns=(f:Fx)=>f.spawn.mock.calls.filter(([args]:any)=>args.pluginMetadata?.role==="coordinator").length;

it("pausing during recovery preparation holds the request and spawns nothing; resuming lets the sweep finish it",async()=>{
 const {f,project,drain,release}=await gatedRecovery();
 f.service.setPaused(project.id,true);
 release();await drain;
 expect(coordinatorSpawns(f)).toBe(0);
 expect(f.store.pendingHandover(project.id)).toMatchObject({detail:"the Initiative is paused"});
 f.intercept();
 f.service.setPaused(project.id,false);
 await f.runtime.sweep();
 expect(f.store.project(project.id)!.coordinatorThreadId).not.toBe("coordinator");
});

it("the request's revision cannot change under a recovery in preparation; it starts as requested",async()=>{
 const {f,project,drain,release}=await gatedRecovery();
 expect(()=>f.service.requestHandover(project.id,{reason:"Newer reason",handover:"Newer handover"},"user")).toThrow(/already in progress/);
 release();await drain;f.intercept();
 expect(coordinatorSpawns(f)).toBe(1);
 expect(f.spawn.mock.calls.at(-1)![0].prompt).toContain("Reason: Restart.");
 expect(f.spawn.mock.calls.at(-1)![0].prompt).toContain("Reviewed handover");
 expect(f.store.pendingHandover(project.id)).toBeNull();
});

