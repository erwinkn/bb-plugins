import { expect, it } from "vitest";
import { projectFixture } from "./fake-native";

// W239: reviewers are never reused. Work for a reviewer is refused with the fresh reviewer to
// spawn, and a review's report notice nudges the coordinator to retire its reviewer.

type Fx=Awaited<ReturnType<typeof projectFixture>>["f"];
const tool=async(f:Fx,name:string,input:unknown,threadId="coordinator")=>JSON.parse(await f.harness.callAgentTool(name,input,{threadId}) as string);
const notices=(f:Fx)=>f.send.mock.calls.map(([args]:any)=>args).filter((a:any)=>a.threadId==="coordinator").map((a:any)=>a.input[0].text as string);
let seq=200000;
async function finish(f:Fx,threadId:string,text:string){
 const at=Date.now();const requestId=`creq_${++seq}`;
 const brief=(f.store.db.prepare("SELECT brief_text FROM assignments ORDER BY rowid DESC LIMIT 1").get() as any).brief_text;
 f.history.push({type:"client/turn/requested",seq:++seq,createdAt:at,data:{requestId,initiator:"agent",input:[{type:"text",text:brief}]}});
 f.history.push({type:"turn/started",seq:++seq,createdAt:at});
 f.history.push({type:"turn/input/accepted",seq:++seq,createdAt:at,data:{clientRequestId:requestId}});
 f.history.push({type:"item/completed",seq:++seq,createdAt:at,data:{item:{type:"agentMessage",text}}});
 f.history.push({type:"turn/completed",seq:++seq,createdAt:at,data:{status:"completed"}});
 await f.runtime.onThreadIdle(f.idle(threadId));
}
/** W1 implements, W2 reviews it (A2), W3 fixes the findings. */
async function reviewedAndFixed(){
 const {f,project}=await projectFixture();
 const task=f.task(project.id);
 const [w]=await tool(f,"initiative_spawn",{label:"Implement",purpose:"implement",tasks:[task.ref],text:"Implement it"});
 await finish(f,w.threadId,"Original implementation");
 const [r]=await tool(f,"initiative_spawn",{role:"review",label:"Review",purpose:"review W1",reviews:w.worker,text:"Review it"});
 await finish(f,r.threadId,"Finding: off by one");
 const [fix]=await tool(f,"initiative_spawn",{label:"Fix",purpose:"fix W2's findings",tasks:[task.ref],handoffs:[r.worker],text:"Fix the off by one"});
 await finish(f,fix.threadId,"Fixed the off by one");
 return{f,project,task,w,r,fix};
}

it("refuses work for a reviewer and names the fresh reviewer to spawn; a plain message still goes through",async()=>{
 const {f,project,task,r}=await reviewedAndFixed();
 const before=f.store.assignments(project.id).length;
 for (const extra of [{work:true},{tasks:[task.ref]}])
  await expect(tool(f,"initiative_message",{to:r.worker,text:"Re-review the fix",...extra})).rejects.toThrow(
   'W2 is a reviewer, and reviews are not reused. Spawn a fresh reviewer instead: initiative_spawn {role:"review",reviews:"W1",handoffs:["A2"],label:"Review W1",purpose:"review the fixes",text:"<what changed, what to check>"}',
  );
 expect(f.store.assignments(project.id)).toHaveLength(before);
 await expect(tool(f,"initiative_message",{to:r.worker,text:"Which line was off by one?"})).resolves.toBeTruthy();
 expect(f.store.assignments(project.id)).toHaveLength(before);
});

it("the suggested fresh reviewer sees the fix worker's report and the earlier findings",async()=>{
 const {f,project,r,fix}=await reviewedAndFixed();
 const [next]=await tool(f,"initiative_spawn",{role:"review",label:"Review the fix",purpose:"review the fixes",reviews:fix.worker,handoffs:["A2"],text:"Check the off by one is gone"});
 const a=f.store.assignment(project.id,Number(next.assignment.slice(1)))!;
 expect(a.handoffSources!.map(h=>h.assignment)).toEqual(["A3","A2"]);
 expect(a.briefText).toContain("Fixed the off by one");
 expect(a.briefText).toContain("Finding: off by one");
 expect(next.worker).not.toBe(r.worker);
});

it("a review's report notice ends with the nudge to retire its reviewer; a work report's and a blocked review's do not",async()=>{
 // Notices go out for initiative_report; a final-message report reaches the coordinator natively.
 const {f}=await projectFixture();
 const [w]=await tool(f,"initiative_spawn",{label:"Implement",purpose:"implement",text:"Implement it"});
 await tool(f,"initiative_report",{outcome:"done",summary:"Implemented",report:"Implemented it."},w.threadId);
 const [r]=await tool(f,"initiative_spawn",{role:"review",label:"Review",purpose:"review W1",reviews:w.worker,text:"Review it"});
 await tool(f,"initiative_report",{outcome:"done",summary:"One finding",report:"Off by one in the pager."},r.threadId);
 const [implemented,reviewed]=notices(f);
 expect(implemented).not.toContain("Retire");
 expect(reviewed).toBe("Initiative · "+f.store.projects()[0]!.name+" · W2\n\nW2 reported (done) on A2: One finding\n\nOff by one in the pager.\n\nRetire W2 once read; reviews are not reused.");
 const [b]=await tool(f,"initiative_spawn",{role:"review",label:"Review again",purpose:"review W1",reviews:w.worker,text:"Review it"});
 await tool(f,"initiative_report",{outcome:"blocked",summary:"Which branch?",question:"Which branch should I review?",report:"Which branch should I review?"},b.threadId);
 expect(notices(f).at(-1)).not.toContain("Retire");
});
