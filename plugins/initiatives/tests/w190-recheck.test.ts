import { expect, it } from "vitest";
import { projectFixture } from "./fake-native";

// W190 re-check of the A297 fixes: cancelled recovery and sweep retry. Re-review batch
// pinning went with re-reviews (W239: reviewers are never reused).

type Fx=Awaited<ReturnType<typeof projectFixture>>["f"];
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

