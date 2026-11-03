import {expect,it} from "vitest";
import {TreeBuilder,type TreeStore} from "../lib/builder";
import {task,tooLong} from "../lib/prompt";
import {capLine,emptyViews,bytes,key} from "../lib/tree";
import {fixture} from "./fixture";

async function run(messages:string[],outputs:string[]){
 const nodes=new Map<string,string>();const requests:string[]=[];
 const store:TreeStore={messageCount:()=>messages.length,message:i=>({kind:"user",text:messages[i]!}),node:(l,i)=>nodes.get(key(l,i))??null,built:(l,a,b)=>Array.from({length:b-a},(_,i)=>a+i).filter(i=>nodes.has(key(l,i))),saveNode:(l,i,t)=>{nodes.set(key(l,i),t);},saveViews:()=>{},recordCall:()=>{}};
 const b=new TreeBuilder(store,emptyViews(),{summarize:async r=>{requests.push(r.input.map(m=>m.content.map(c=>c.text).join("\n")).join("\n"));return {ok:true,text:outputs.shift()??"summary",usage:{input:0,cached:0,output:0,reasoning:0},latencyMs:0};},instructions:()=>"",effort:()=>"high",concurrency:()=>1,cacheKey:"cap"});
 await b.run(new AbortController().signal);return {nodes,requests};
}
it("asks for448 with a448 ruler (W574) while accepting449..576 in one attempt",async()=>{
 const prompt=task([0,0],new Map(),{kind:"user",text:"source"});expect(prompt).toContain("at most 448 bytes (about 60 words)");expect(prompt.split("\n")[1]).toHaveLength(448);
 const merge=task([1,0],new Map([["0:0","a"],["0:1","b"]]));expect(merge).toContain("into one line of at most 448 bytes (about 60 words)");expect(merge.split("\n")[1]).toHaveLength(448);
 for(const size of [449,513,544,576]){const r=await run(["source".repeat(200)],["x".repeat(size)]);expect(r.requests).toHaveLength(1);expect(bytes(r.nodes.get("0:0")!)).toBe(size);}
});
it("retries577 bytes once, in the same conversation, at the same448 budget (W574), with no cutoff feedback",async()=>{
 const r=await run(["source".repeat(200)],["x".repeat(577),"retry".repeat(70)]);expect(r.requests).toHaveLength(2);expect(r.requests[1]).toContain("x".repeat(577)+"\nToo long: your line is 577 bytes, over the 576-byte limit. Write the whole line again for the same <input> in at most 448 bytes (about 60 words), the length of this ruler:\n"+"-".repeat(448)+"\nDrop");expect(r.requests[1]).not.toContain("← LIMIT");expect(tooLong("x".repeat(577))).toContain("576-byte limit");
});
it("stores free exact leaves and free joins through576 without artificial model calls",async()=>{
 const leaf="x".repeat(570);const a=await run([leaf],[]);expect(a.requests).toEqual([]);expect(a.nodes.get("0:0")).toBe("user: "+leaf);
 const pair=await run(["a".repeat(280),"b".repeat(283)],[]);expect(pair.requests).toEqual([]);expect(bytes(pair.nodes.get("1:0")!)).toBe(576);
});
it("caps both oversized attempts at576 with an honest UTF8 cut marker",async()=>{
 const r=await run(["source".repeat(200)],["é".repeat(400),"日".repeat(220)]);expect(r.requests).toHaveLength(2);const text=r.nodes.get("0:0")!;expect(bytes(text)).toBeLessThanOrEqual(576);expect(text).toMatch(/ \[cut\]$/);expect(text).not.toContain("�");expect(capLine("x".repeat(576))).toHaveLength(576);
});
it("preserves persisted512 nodes and rejects oversized writes at the storage boundary",async()=>{
 const f=fixture();const s=await f.attach("initiatives","p",f.thread("w"));const tree=f.store.tree(s);tree.saveNode(0,0,"x".repeat(512),"model",1);
 expect(f.store.node(s,0,0)).toHaveLength(512);expect(()=>tree.saveNode(0,1,"x".repeat(577),"model",1)).toThrow(/576/);expect(f.store.node(s,0,0)).toHaveLength(512);
});
