import { expect, it, vi } from "vitest";

// W190 re-review of the A296 fixes (A297): each probe, made a regression test. Item 7 (the
// same reviewer re-reviews its batch) was reversed by W239: reviewers are never reused.
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
 const before=f.history.length;
 start(f,"Write handover"); end(f,"Ready handover");
 for(const row of f.history.slice(before)) row.threadId=writer;
 await f.runtime.onThreadIdle(f.idle(writer));
 expect(f.store.pendingHandover(project.id)).not.toBeNull();
 f.threads.set("coordinator",{...f.threads.get("coordinator")!,status:"error"});
 // W194: the coordinator failed after the preview, so recovery writes the handover again first.
 await f.service.drainHandover(project.id);
 const rewriter=f.store.handoverDraft(project.id)!.threadId!;
 expect(rewriter).not.toBe(writer);
 const again=f.history.length;
 start(f,"Write handover"); end(f,"Ready handover after the failure");
 for(const row of f.history.slice(again)) row.threadId=rewriter;
 await f.service.finishHandoverDraft(rewriter);
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
 f.store.db.exec(MIGRATIONS.find(m => m.startsWith("CREATE TABLE handover_writers"))!);
 expect(f.store.trackedWriters()).toEqual([]);
 f.archive.mockRejectedValueOnce(new Error("archive temporarily unavailable"));
 await f.service.finishHandoverDraft(writer,"timeout");
 await f.service.sweepHandoverDrafts();
 expect(f.threads.get(writer)!.archivedAt).not.toBeNull();
});

it("saved instructions equal to the first T136 default move to the new default; edited ones stay",async()=>{
 const { fixture } = await import("./fake-native");
 const { DEFAULT_COORDINATOR_INSTRUCTIONS, GUIDANCE_RESET_FLAG, PREVIOUS_DEFAULTS } = await import("../lib/guidance");
 expect(DEFAULT_COORDINATOR_INSTRUCTIONS).toContain("Never reuse a reviewer");
 const f=fixture({coordinatorInstructions:PREVIOUS_DEFAULTS.coordinator[0]!});
 f.store.setFlag(GUIDANCE_RESET_FLAG);
 await f.preferences.ready;
 expect(f.preferences.configuration().coordinatorInstructions).toBe(DEFAULT_COORDINATOR_INSTRUCTIONS);
 expect((await f.preferences.handle.get()).coordinatorInstructions).toBe(DEFAULT_COORDINATOR_INSTRUCTIONS);
 await f.preferences.handle.experimental_set({coordinatorInstructions:"Erwin's own coordinator text."});
 expect(f.preferences.configuration().coordinatorInstructions).toBe("Erwin's own coordinator text.");
});
