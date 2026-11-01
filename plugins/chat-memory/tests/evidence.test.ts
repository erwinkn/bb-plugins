import {expect,it} from "vitest";
import {fixture} from "./fixture";
import {eventEntries} from "../lib/log";
it("recovers the missing middle of a clipped echo, pages every UTF-8 byte, and selects neither arguments nor reasoning",async()=>{
 const f=fixture();const s=await f.attach("initiatives","p",f.thread("w"));
 const original="é".repeat(40_000)+"MIDDLE-EVIDENCE"+"€".repeat(40_000);
 const row={threadId:"w",seq:1000,type:"item/completed",data:{item:{type:"toolCall",tool:"read",arguments:{path:"unrelated-input"},result:original},thoughts:"private-thought"}};
 f.history.push(row); f.history.push({threadId:"w",seq:1001,type:"turn/completed",data:{status:"completed"}});
 await f.memory.ingest("w"); const id=f.store.messages(s).find(m=>m.kind==="echo")!.i;
 expect(f.store.message(s,id)!.text).not.toContain("MIDDLE-EVIDENCE");
 let offset=0, recovered="";
 do { const result=await f.memory.evidence(s,id,1,offset); if(typeof result==="string")throw Error("expected content");
 const text=result.content[0]!;if(text.type!=="text")throw Error("expected text");
 const [header,...body]=text.text.split("\n");recovered+=body.join("\n");
 expect(header).toContain("source w:1000"); const match=/next offset (\d+)/.exec(header!); if(!match)break;offset=Number(match[1]);
 }while(true);
 expect(recovered).toBe(original);expect(recovered).not.toContain("private-thought");
});
it("returns tool images as image content, excludes opaque data from summaries, and preserves RPC text aliases",async()=>{
 const f=fixture();const s=await f.attach("initiatives","p",f.thread("w"));
 f.history.push({threadId:"w",seq:1000,type:"client/turn/requested",data:{requestId:"r",input:[{type:"localImage",path:"image.png"}]}});
 f.history.push({threadId:"w",seq:1001,type:"turn/input/accepted",data:{clientRequestId:"r"}});
 await f.memory.ingest("w");
 f.memory["deps"].attachment=async()=>({bytes:new Uint8Array([1,2,3]),mimeType:"image/png"});
 const result=await f.memory.evidence(s,0,1,0,0);
 expect(result).toMatchObject({content:[{type:"text"},{type:"image",mimeType:"image/png",data:"AQID"}]});
 const entries=eventEntries({seq:1,type:"item/completed",data:{item:{type:"toolCall",tool:"image",result:{content:[{type:"image",data:"OPAQUE",mimeType:"image/png"}]}}}},"w",{spawnedByPlugin:false,sender:x=>x});
 expect(JSON.stringify(entries)).not.toContain("OPAQUE");
});
it("marks missing and expired originals honestly",async()=>{
 const f=fixture();const s=await f.attach("initiatives","p",f.thread("w"));f.turn("w","past");await f.memory.ingest("w");f.history.length=0;
 expect(await f.memory.zoomText(s,0,1)).toContain("saved copy only");
});
it("keeps split source parts tied to the same semantic message and excludes nested subagent output",async()=>{
 const f=fixture();const s=await f.attach("initiatives","p",f.thread("w"));
 const text="A".repeat(30_000)+"SECOND-PART";
 f.history.push({threadId:"w",seq:1000,type:"item/completed",data:{item:{type:"agentMessage",text}}});
 f.history.push({threadId:"w",seq:1001,type:"item/completed",data:{item:{type:"agentMessage",text:"nested secret",parentToolCallId:"nested"}}});
 f.history.push({threadId:"w",seq:1002,type:"turn/completed",data:{status:"completed"}});
 await f.memory.ingest("w");expect(f.log(s)).toHaveLength(2);
 expect(await f.memory.zoomText(s,1,1,24_000)).toContain("SECOND-PART");
 expect(await f.memory.zoomText(s,0,1)).not.toContain("nested secret");
});
it("does not serialize inline image data into the text manifest",async()=>{
 const f=fixture();const s=await f.attach("initiatives","p",f.thread("w"));
 f.history.push({threadId:"w",seq:1000,type:"client/turn/requested",data:{requestId:"image",input:[{type:"image",url:"data:image/png;base64,AQID"}]}});
 f.history.push({threadId:"w",seq:1001,type:"turn/input/accepted",data:{clientRequestId:"image"}});
 await f.memory.ingest("w");
 const result=await f.memory.evidence(s,0,1,0,0);
 expect(result).toMatchObject({content:[{type:"text"},{type:"image",data:"AQID"}]});
 if(typeof result!=="string") expect(result.content.filter(c=>c.type==="text").map(c=>c.text).join("")).not.toContain("AQID");
});
