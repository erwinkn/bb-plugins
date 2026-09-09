import test from "node:test";
import assert from "node:assert/strict";
import { LiveClient, type ResponseBinding } from "./live-client.ts";
import type { InputController } from "./input-controller.ts";
import { nativeUi } from "./native-ui.ts";

const binding:ResponseBinding={origin:"user",utterance:{id:"u",version:1,text:"Open Build",startedAt:1}};
const input:Pick<InputController,"version"|"waitFor">={version:1,waitFor:async()=>({id:"u",version:1,text:"Open Build",items:[],view:{threadId:null,projectId:null,onNewThreadScreen:false},finalAt:1})};

test("occurrence follows canonical arguments and stays fixed on a retry of the same call",async()=>{
  const calls:any[]=[];
  const client=new LiveClient(async(_method,value)=>{calls.push(value);return {};},()=>true,input,"call","conversation");
  await client.execute("a","message_thread",{body:"Hi",thread_id:"build",mode:"normal"},binding);
  await client.execute("a","message_thread",{mode:"normal",thread_id:"build",body:"Hi"},binding);
  await client.execute("b","message_thread",{thread_id:"build",body:"Hi",mode:"normal"},binding);
  assert.deepEqual(calls.map(call=>call.occurrence),[0,0,1]);
  assert.ok(calls.every(call=>call.utterance===binding.utterance));
});

test("an accepted client effect executes once and a retry returns the stored receipt",async t=>{
  let begun=false;
  const calls:string[]=[];
  const execute=t.mock.method(nativeUi,"execute",async()=>({status:"succeeded" as const,detail:"Opened"}));
  const client=new LiveClient(async(method)=>{
    calls.push(method);
    if(method==="beginClientEffect") {const execute=!begun;begun=true;return {execute,operationId:"op",receipt:{status:"succeeded"},action:{kind:"show_voice"}};}
    return {status:"succeeded"};
  },()=>true,input,"call","conversation");
  for(let i=0;i<2;i++)assert.deepEqual(await client.execute("ui","control_ui",{action:"show_voice"},binding),{status:"succeeded"});
  assert.equal(execute.mock.callCount(),1);
  assert.deepEqual(calls,["beginClientEffect","finishClientEffect","beginClientEffect"]);
});

test("a nonce change during beginClientEffect prevents local execution",async t=>{
  let current=true;
  const execute=t.mock.method(nativeUi,"execute",async()=>({status:"succeeded" as const,detail:"Opened"}));
  const client=new LiveClient(async()=>{current=false;return {execute:true,operationId:"op",action:{kind:"show_voice"}};},()=>current,input,"call","conversation");
  const result=await client.execute("ui","control_ui",{action:"show_voice"},binding) as any;
  assert.equal(result.status,"cancelled");assert.equal(execute.mock.callCount(),0);
});
