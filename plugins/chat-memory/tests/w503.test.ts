import {expect, it} from "vitest";
import {fixture, fakeLuna, stuckLuna} from "./fixture";
import {turnView} from "../lib/turn";

it("requires every historical leaf, including the newest, and preserves the frozen prefix", async()=>{
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
it("fails visibly at the deadline and on cancellation with no raw fallback",async()=>{
 const f=fixture(); await f.attach("initiatives","p",f.thread("w")); f.memory.useSummarizer(stuckLuna); f.memory.waits.turn=100;
 f.turn("w","past","z".repeat(10_000));
 await expect(f.ask("w",f.say("w","go"),"go")).rejects.toThrow("no summary yet");
 const abort=new AbortController(); const request=f.say("w","again");
 const turn=f.memory.turnContext("w",{protocol:4,input:"again",requestId:request,sessionId:null},abort.signal);
 abort.abort(); await expect(turn).rejects.toThrow("the turn stopped");
});
it("turnView refuses an unbuilt line rather than clipping it",()=>{
 expect(()=>turnView({chat:[],fed:0,nodes:new Map(),cut:1,frozen:null})).toThrow("no summary yet");
});
