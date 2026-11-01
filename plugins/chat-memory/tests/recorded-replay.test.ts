import {readFileSync} from "node:fs";
import {expect,it} from "vitest";
import {fixture} from "./fixture";
import {LOG_EVENT_TYPES,type EventRow} from "../lib/log";

const files=process.env.UNII_REPLAY_FILES?.split(":")??[];
it.runIf(files.length)("streams representative recorded workers through production ingestion, summary readiness and fresh admission in isolation",async()=>{
 for(const file of files){
 const f=fixture();const thread=f.thread("replay",{originPluginId:"initiatives"});const scope=await f.attach("initiatives","replay:worker:1",thread);
 const cutoff=file.includes("w2502")?1331:7104;
 const rows=(JSON.parse(readFileSync(file,"utf8")) as EventRow[]).filter(r=>r.seq<=cutoff && (LOG_EVENT_TYPES as readonly string[]).includes(r.type));
 f.reads.length=0;
 for(let i=0;i<rows.length;i+=40){f.history.push(...rows.slice(i,i+40).map(r=>({...r,threadId:thread})));f.memory.kick(thread);await f.memory.settled();}
 const count=f.store.count(scope);expect(count).toBeGreaterThan(file.includes("w2502")?300:700);
 expect((await f.memory.status(scope)).tree.ready).toBe(true);
 expect(f.store.leavesBuilt(scope)).toBe(count);
 expect(f.reads.length).toBeLessThanOrEqual(Math.ceil(rows.length/40)*2);
 const seq=Math.max(...rows.map(r=>r.seq))+1;
 f.history.push({threadId:thread,seq,type:"client/turn/requested",data:{requestId:"new",input:[{type:"text",text:"new incoming request"}]}});
 const answer=await f.ask(thread,"new","new incoming request") as {systemPrompt:string;input:string};
 expect(answer.systemPrompt).not.toContain("new incoming request");expect(answer.input).toContain("New message:\nnew incoming request");
 expect(f.store.handle.prepare("SELECT MAX(length(CAST(text AS BLOB))) FROM nodes").pluck().get()).toBeLessThanOrEqual(576);
 const before=f.log(scope);await f.memory.ingest(thread);expect(f.log(scope)).toEqual(before);
 }
},30_000);
