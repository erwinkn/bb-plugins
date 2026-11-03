import {expect, it} from "vitest";
import {fixture, fakeLuna, stuckLuna} from "./fixture";
import {turnView} from "../lib/turn";
import {pendingLine} from "../lib/tree";

it("waits, within its short wait, for every historical leaf, including the newest, and preserves the frozen prefix", async()=>{
 const f=fixture(); await f.attach("initiatives","p",f.thread("w"));
 f.turn("w","old","x".repeat(10_000));
 let release!:()=>void; const gate=new Promise<void>(r=>release=r);
 f.memory.useSummarizer(async r=>{await gate; return fakeLuna(r);});
 let answered=false; const turn=f.ask("w",f.say("w","go"),"go").then(r=>{answered=true;return r;});
 await new Promise(r=>setTimeout(r,50)); expect(answered).toBe(false); release();
 const a=await turn as {systemPrompt:string;input:string};
 expect(a.systemPrompt+a.input).toContain("summary of 1"); expect(a.systemPrompt+a.input).not.toContain("x".repeat(1000));
 f.reply("w","done"); f.done("w");
 const b=await f.ask("w",f.say("w","next"),"next") as typeof a;
 expect(b.systemPrompt).toBe(a.systemPrompt);
});
it("past its ceiling, fails visibly at the deadline; and on cancellation",async()=>{
 const f=fixture(); await f.attach("initiatives","p",f.thread("w")); f.memory.useSummarizer(stuckLuna); f.memory.waits.turn=100; f.memory.ceiling=300;
 f.turn("w","past","z".repeat(10_000));
 await expect(f.ask("w",f.say("w","go"),"go")).rejects.toThrow("over its 300-byte ceiling");
 const abort=new AbortController(); const request=f.say("w","again");
 const turn=f.memory.turnContext("w",{protocol:4,input:"again",requestId:request,sessionId:null},abort.signal);
 abort.abort(); await expect(turn).rejects.toThrow("the turn stopped");
});
it("R12: turnView shows a message without its summary by its start, never freezes it, and refuses an unbuilt merge",()=>{
 const pending=(i:number)=>pendingLine(`user: message ${i} ${"word ".repeat(200)}`);
 const nodes=new Map([["0:0","summary of 0"]]);
 const stalled=()=>false;
 const v=turnView({chat:[[0,0],[0,1]],fed:2,nodes,cut:3,frozen:null,pending,stalled});
 expect(v.frozenLines).toEqual(["0+1|summary of 0"]);
 expect(v.tailLines).toHaveLength(2);
 for(const [k,line] of v.tailLines.entries()){
  expect(line).toMatch(new RegExp(`^${k+1}\\+1\\|user: message ${k+1} word word .*word… \\(not summarized yet: zoom it\\)$`));
  expect(Buffer.byteLength(line.slice(4))).toBeLessThanOrEqual(512);
 }
 expect(v.pending).toBe(2);
 // A later turn keeps its frozen line and leaves the unsummarized ones out of it.
 expect(turnView({chat:[[0,0],[0,1]],fed:2,nodes,cut:3,frozen:v.frozenLines,pending,stalled}).frozenLines).toEqual(["0+1|summary of 0"]);
 expect(()=>turnView({chat:[[1,0]],fed:2,nodes:new Map(),cut:2,frozen:null,pending,stalled})).toThrow("no summary yet");
});
