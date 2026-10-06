import { expect, it, vi } from "vitest";

// W190 re-review of the A296 fixes (A297): each probe, made a regression test. Item 7 changed
// policy: the same reviewer may re-review its batch, read-only.
import { projectFixture } from "./fake-native";
import { clearCatalogCache } from "../lib/bb";

type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const tool = async (f: Fx, name: string, input: unknown, threadId = "coordinator") => JSON.parse(await f.harness.callAgentTool(name, input, { threadId }) as string);
let seq = 10000;
const brief = (f: Fx) => (f.store.db.prepare("SELECT brief_text FROM assignments ORDER BY rowid DESC LIMIT 1").get() as any)?.brief_text ?? "";
function start(f: Fx, input=brief(f), at=Date.now()) {
 const requestId=`creq_${++seq}`;
 f.history.push({type:"client/turn/requested",seq:++seq,createdAt:at,data:{requestId,initiator:"agent",input:[{type:"text",text:input}]}});
 f.history.push({type:"turn/started",seq:++seq,createdAt:at});
 f.history.push({type:"turn/input/accepted",seq:++seq,createdAt:at,data:{clientRequestId:requestId}});
}
function end(f: Fx, text: string, status="completed", at=Date.now()) {
 f.history.push({type:"item/completed",seq:++seq,createdAt:at,data:{item:{type:"agentMessage",text}}});
 f.history.push({type:"turn/completed",seq:++seq,createdAt:at,data:{status}});
}
function luna(f: Fx) { f.execution.set("catalog-probe",{model:"gpt-6-luna",reasoningLevel:"high"}); clearCatalogCache(); }

it("a queued recovery keeps its request until a replacement can be prepared",async()=>{
 const {f,project}=await projectFixture();
 luna(f);
 f.threads.set("coordinator",{...f.threads.get("coordinator")!,status:"active"});
 await f.service.recreateCoordinators([project.id],{dryRun:false,waitMs:0});
 const writer=f.store.handoverDraft(project.id)!.threadId!;
 start(f,"Write handover"); end(f,"Ready handover");
 await f.runtime.onThreadIdle(f.idle(writer));
 expect(f.store.pendingHandover(project.id)).not.toBeNull();
 f.threads.set("coordinator",{...f.threads.get("coordinator")!,status:"error"});
 let faulted=false;
 f.intercept((path,args,call)=>{
   if(path==="threads.defaultExecutionOptions" && args.threadId==="coordinator" && !faulted) {
     faulted=true; throw new Error("temporary settings read failure");
   }
   return call();
 });
 await f.service.drainHandover(project.id);
 f.intercept();
 // Once BB responds again, the next sweep should finish the already-requested recovery.
 await f.runtime.sweep();
 expect(f.store.project(project.id)!.coordinatorThreadId).not.toBe("coordinator");
});

it("a stale idle callback during a short-report turn must not discard the pending final attachment",async()=>{
 const {f,project}=await projectFixture();
 const [w]=await tool(f,"initiative_spawn",{label:"Work",purpose:"work",text:"First work"});
 start(f);end(f,"First report");
 const staleIdle=f.idle(w.threadId);
 await f.runtime.onThreadIdle(staleIdle);
 await tool(f,"initiative_message",{to:w.worker,work:true,text:"Second work"});
 start(f);
 await tool(f,"initiative_report",{outcome:"done",summary:"Done; detailed report follows."},w.threadId);
 // A delayed callback from the first turn reads the newer, still-running turn.
 await f.runtime.onThreadIdle(staleIdle);
 end(f,"Detailed final report.");
 await f.runtime.onThreadIdle(f.idle(w.threadId));
 expect(f.store.assignment(project.id,2)!.report!.finalMessage).toBe("Detailed final report.");
});

it("a transient event read failure must not discard a short report's final attachment",async()=>{
 const {f,project}=await projectFixture();
 const [w]=await tool(f,"initiative_spawn",{label:"Work",purpose:"work",text:"Do work"});
 start(f);
 await tool(f,"initiative_report",{outcome:"done",summary:"Done; detailed report follows."},w.threadId);
 end(f,"Detailed final report.");
 let fail=true;
 f.intercept((path,args,call)=>{
   if(path==="threads.events.list" && fail){fail=false;throw new Error("temporary event read failure");}
   return call();
 });
 await f.service.captureFinalMessage(f.idle(w.threadId));
 f.intercept();
 await f.service.captureFinalMessage(f.idle(w.threadId));
 expect(f.store.assignment(project.id,1)!.report!.finalMessage).toBe("Detailed final report.");
});

it("a completed turn after a native failure must not attach an unrelated reply to the failed turn's short report",async()=>{
 const {f,project}=await projectFixture();
 const [w]=await tool(f,"initiative_spawn",{label:"Work",purpose:"work",text:"Do work"});
 const at=Date.now();
 vi.spyOn(f.service,"now").mockReturnValue(at);
 start(f,brief(f),at);
 await tool(f,"initiative_report",{outcome:"blocked",summary:"Need a key",question:"Which key?"},w.threadId);
 end(f,"Blocked details","failed",at);
 const failed={...f.threads.get(w.threadId)!,status:"error"} as any;
 f.threads.set(w.threadId,failed);
 await f.runtime.onThreadFailed(failed,"provider failure");
 start(f,"Explain the issue more",at+100);
 end(f,"Unrelated later explanation","completed",at+200);
 await f.runtime.onThreadIdle(f.idle(w.threadId));
 expect(f.store.assignment(project.id,1)!.report!.finalMessage).toBeUndefined();
});

it("a marker received on an interrupted turn continues to identify that work after native resume",async()=>{
 const {f,project}=await projectFixture();
 const [w]=await tool(f,"initiative_spawn",{label:"Work",purpose:"work",text:"Do work"});
 start(f);end(f,"Investigation incomplete","interrupted");
 await f.runtime.onThreadIdle(f.idle(w.threadId));
 // Ordinary user continuation, preserving the existing assignment.
 await tool(f,"initiative_message",{to:w.worker,text:"Continue and finish the existing work."});
 start(f,"Continue and finish the existing work.");end(f,"The assigned work is complete.");
 await f.runtime.onThreadIdle(f.idle(w.threadId));
 expect(f.store.assignment(project.id,1)!.report?.finalMessage).toBe("The assigned work is complete.");
});

it("legacy adopt with tasks captures the adopted worker's final report",async()=>{
 const {f,project}=await projectFixture();
 const task=f.task(project.id);
 f.threads.set("adopt-me",{...f.threads.get("coordinator")!,id:"adopt-me",parentThreadId:null,status:"active"});
 const r=await tool(f,"initiative_worker",{action:"adopt",threadId:"adopt-me",role:"work",label:"Audit",area:"metrics",tasks:[task.ref]});
 start(f,"Audit the metrics");end(f,"The adopted metrics audit is complete.");
 await f.runtime.onThreadIdle(f.idle("adopt-me"));
 expect(f.store.assignment(project.id,1)!.report?.finalMessage).toBe("The adopted metrics audit is complete.");
});

it("the coordinator can ask the batch's reviewer to re-review the fixes, read-only, with the latest report; a reviewer never implements",async()=>{
 const {f,project}=await projectFixture();
 const task=f.task(project.id);
 const other=f.task(project.id,"Unrelated");
 const [w]=await tool(f,"initiative_spawn",{label:"Implement",purpose:"work",tasks:[task.ref],text:"Implement"});
 start(f);end(f,"Implemented");await f.runtime.onThreadIdle(f.idle(w.threadId));
 const [reviewer]=await tool(f,"initiative_spawn",{role:"review",label:"Review",purpose:"review",reviews:w.worker,text:"Review implementation"});
 start(f);end(f,"Needs fixes");await f.runtime.onThreadIdle(f.idle(reviewer.threadId));
 await tool(f,"initiative_message",{to:w.worker,work:true,tasks:[task.ref],text:"Fix the findings"});
 start(f);end(f,"Fixed both findings");await f.runtime.onThreadIdle(f.idle(w.threadId));
 const [again]=await tool(f,"initiative_message",{to:reviewer.worker,work:true,text:"Re-review the fixes"});
 const a=f.store.assignment(project.id,Number(again.assignment.slice(1)))!;
 expect(a).toMatchObject({role:"review",access:"read-only",route:"continue",workerNum:Number(reviewer.worker.slice(1)),reviewOf:[task.num],taskNums:[]});
 expect(a.handoffSources![0]).toMatchObject({worker:w.worker,assignment:"A3"});
 const text=f.send.mock.calls.at(-1)![0].input[0].text as string;
 expect(text).toContain("Fixed both findings");
 expect(text).toContain("This review is read-only");
 start(f);end(f,"Both fixes verified.");await f.runtime.onThreadIdle(f.idle(reviewer.threadId));
 expect(f.store.assignment(project.id,a.num)!.report).toMatchObject({outcome:"succeeded",finalMessage:"Both fixes verified."});
 // Only its own batch, and never implementation.
 await expect(tool(f,"initiative_message",{to:reviewer.worker,work:true,tasks:[other.ref],text:"Review this too"})).rejects.toThrow(/not in it/);
 await expect(f.service.delegate(project.id,{route:"continue",role:"work",worker:reviewer.worker,tasks:[task.ref]})).rejects.toThrow("Reviewers never implement");
 await expect(tool(f,"initiative_message",{to:reviewer.worker,text:"A plain question"})).resolves.toBeTruthy();
});

it("fallback retains user instructions when the allowed task, objective and note fields fill its budget",async()=>{
 const {f,project}=await projectFixture();
 f.store.updateProject(project.id,{objective:"O".repeat(4000)});
 for(let i=0;i<40;i++) {
   const task=f.task(project.id,`Task ${i}: `+"T".repeat(180));
   f.store.updateTask(project.id,task.num,{progress:"P".repeat(200)});
 }
 f.history.push({type:"client/turn/requested",seq:++seq,createdAt:Date.now(),data:{requestId:"creq_user",initiator:"user",input:[{type:"text",text:"Do not deploy until I approve."}]}});
 const draft=await f.service.startHandoverDraft(project.id,{note:"N".repeat(6000)});
 expect(draft.source).toBe("fallback");
 expect(draft.text).toContain("Do not deploy until I approve.");
});

it("a writer already generating before the tracking-table migration still gets archive retries",async()=>{
 const {f,project}=await projectFixture();
 luna(f);
 await f.service.startHandoverDraft(project.id);
 const writer=f.store.handoverDraft(project.id)!.threadId!;
 // A pre-fix database already has a generating draft but no handover_writers table.
 // Apply exactly the additive migration to that state.
 f.store.db.exec("DROP TABLE handover_writers");
 const { MIGRATIONS }=await import("../lib/store");
 f.store.db.exec(MIGRATIONS.at(-1)!);
 expect(f.store.trackedWriters()).toEqual([]);
 f.archive.mockRejectedValueOnce(new Error("archive temporarily unavailable"));
 await f.service.finishHandoverDraft(writer,"timeout");
 await f.service.sweepHandoverDrafts();
 expect(f.threads.get(writer)!.archivedAt).not.toBeNull();
});

it("saved instructions equal to the first T136 default move to the new default; edited ones stay",async()=>{
 const { fixture } = await import("./fake-native");
 const { DEFAULT_COORDINATOR_INSTRUCTIONS, GUIDANCE_RESET_FLAG, PREVIOUS_DEFAULTS } = await import("../lib/guidance");
 expect(DEFAULT_COORDINATOR_INSTRUCTIONS).toContain("ask that same reviewer to re-review");
 const f=fixture({coordinatorInstructions:PREVIOUS_DEFAULTS.coordinator[0]!});
 f.store.setFlag(GUIDANCE_RESET_FLAG);
 await f.preferences.ready;
 expect(f.preferences.configuration().coordinatorInstructions).toBe(DEFAULT_COORDINATOR_INSTRUCTIONS);
 expect((await f.preferences.handle.get()).coordinatorInstructions).toBe(DEFAULT_COORDINATOR_INSTRUCTIONS);
 await f.preferences.handle.experimental_set({coordinatorInstructions:"Erwin's own coordinator text."});
 expect(f.preferences.configuration().coordinatorInstructions).toBe("Erwin's own coordinator text.");
});
