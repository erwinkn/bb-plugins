import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { LiveActionExecutor, formatVoiceInstruction, type ActionContext } from "./live-action-executor.ts";
import { LIVE_ACTION_MIGRATIONS, UTTERANCE_EFFECT_MIGRATIONS, LiveActionStore } from "./live-action-store.ts";
import { quickActionSchema, type QuickAction } from "./quick-actions.ts";
import { defaultWorkerSettings, WORKER_PROFILE_KEY } from "./worker-profiles.ts";
import type { UserRequestEnvelope } from "./coordinator/envelopes.ts";

type Any = any;
const settle = () => new Promise<void>(resolve=>setImmediate(resolve));
function fixture() {
  const db=new Database(":memory:");for(const sql of [...LIVE_ACTION_MIGRATIONS,...UTTERANCE_EFFECT_MIGRATIONS])db.exec(sql);
  const world={ overrides:{} as Record<string,(args?:Any)=>Promise<Any>>, sends:[] as Any[],spawns:[] as Any[],stops:[] as string[],watched:[] as string[],ui:[] as Any[],
    threads:new Map<string,Any>([["build",makeThreadResponse({id:"build",projectId:"app",title:"Build Fix",status:"active",visibility:"visible"})]]),
    hosts:[{id:"mac",name:"Desktop",status:"connected"},{id:"studio",name:"Studio",status:"disconnected"}],
    projects:[{id:"app",name:"BB Plugins",kind:"standard",sources:[{hostId:"mac",isDefault:true},{hostId:"studio",isDefault:false}]}],
    providers:[{id:"codex",available:true,displayName:"Codex"}],
    catalog:{models:[{id:"worker-id",model:"worker-model",displayName:"Worker",isDefault:true,supportedReasoningEfforts:[{reasoningEffort:"high"}]},{id:"strong-id",model:"strong-model",displayName:"Strong",isDefault:false,supportedReasoningEfforts:[{reasoningEffort:"high"}]}],providers:[{id:"codex",serviceTiers:[{id:"default",label:"Default"},{id:"fast",label:"Fast"}]}],modelLoadError:null},
  };
  const sdk:Any={
    projects:{list:async()=>world.projects},hosts:{list:async()=>world.hosts},providers:{list:async()=>world.providers,models:async()=>world.overrides.models ? world.overrides.models() : world.catalog},
    threads:{
      get:async({threadId}:Any)=>{const thread=world.threads.get(threadId);if(!thread)throw new Error("Unknown target");return thread;},
      spawn:async(args:Any)=>{if(world.overrides.spawn)return world.overrides.spawn(args);world.spawns.push(args);const thread=makeThreadResponse({id:`worker-${world.spawns.length}`,title:args.title,projectId:args.projectId,visibility:args.visibility,status:"active"});world.threads.set(thread.id,thread);return thread;},
      send:async(args:Any)=>{if(world.overrides.send)return world.overrides.send(args);world.sends.push(args);return {ok:true,delivery:"queued",queuedMessage:{id:"message-1"}};},
      stop:async({threadId}:Any)=>{world.stops.push(threadId);return {ok:true};},
    },
  };
  const {bb,harness}=createFakePluginHost({pluginId:"voice-mode",sdk});
  const store=new LiveActionStore(db);
  const executor=()=>new LiveActionExecutor(bb,store,{coordinatorParent:async()=>"coordinator",watch:(_c,id)=>world.watched.push(id),isCoordinator:thread=>thread.title?.startsWith("Voice coordinator ") ?? false});
  const controller=new AbortController();
  const context:ActionContext={signal:controller.signal,current:()=>!controller.signal.aborted,ui:async action=>{world.ui.push(action);return {status:"succeeded",detail:"Accepted"};}};
  const envelope=(id="req-1",text="Open Build Fix and ask it to add regression tests."):UserRequestEnvelope=>({v:1,conversationId:"conversation",callNonce:"call",callSequence:1,requestId:id,utteranceItemIds:[`item-${id}`],transcriptRevision:1,transcriptAvailable:true,originalText:text,transcriptDelta:[{itemId:`item-${id}`,text}],interpretation:null,urgency:"new",answersQuestionId:null,view:{threadId:"build",projectId:"app",onNewThreadScreen:false}});
  const close=async()=>{await harness.lifecycle.dispose();db.close();};
  return {db,bb,harness,world,sdk,store,executor,controller,context,envelope,close};
}
const send=():QuickAction=>({kind:"send_message",threadId:"build",purpose:"instruction"});
const start=():QuickAction=>({kind:"start_thread",projectId:"app",role:"investigate",title:"Retry investigation"});

test("operator schemas allow task dispatch and bounded groups, not shell/deletion/permission overrides",()=>{
  for (const kind of ["delete_worktree","archive_thread","shell","run_plugin_cli","approve_permission"]) assert.equal(quickActionSchema.safeParse({kind}).success,false);
  assert.equal(quickActionSchema.safeParse(start()).success,true);
  assert.equal(quickActionSchema.safeParse({...start(),permissionMode:"full"}).success,false);
  assert.equal(quickActionSchema.safeParse({...start(),model:"mini"}).success,false);
  assert.equal(quickActionSchema.safeParse({kind:"group",actions:[]}).success,false);
  assert.equal(quickActionSchema.safeParse({kind:"group",actions:Array(5).fill(send())}).success,false);
  assert.equal(quickActionSchema.safeParse({kind:"group",actions:[{kind:"group",actions:[send()]}]}).success,false);
  assert.equal(quickActionSchema.safeParse({kind:"prepare_draft",target:{kind:"thread",threadId:"build"},text:"Draft"}).success,true);
});

test("direct instructions preserve conditional questions and provenance and announce destination",async t=>{
  const h=fixture();t.after(h.close);const text="Ask Build whether we still need it. If upstream fixed it, maybe not; don't remove anything yet.";
  const envelope={...h.envelope("conditional",text),interpretation:"The retry workaround"};
  const outcome=await h.executor().execute(envelope,send(),"live",h.context);
  assert.equal(outcome.status,"succeeded");assert.equal(outcome.speech,"Queued for Build Fix.");
  const message=h.world.sends[0].input[0].text;
  const body=JSON.parse(message.split("\n").at(-1)!);
  assert.equal(body.user.text,text);assert.equal(body.model_interpretation,envelope.interpretation);
  assert.equal(body.provenance.request_id,"conditional");assert.equal(body.destination.thread_id,"build");
  assert.equal(h.world.sends[0].mode,"queue-if-active");assert.deepEqual(h.world.watched,["build"]);assert.equal(h.world.spawns.length,0);
  assert.match(message,/does not grant new permissions/);
});

test("a requested report remains model-authored content beside the full user scope",async t=>{
  const h=fixture();t.after(h.close);
  const words="Send Build the report we discussed, then open Build. Do not implement yet.";
  const message="Report: two dispatch bugs. Please investigate; do not implement yet.";
  const outcome=await h.executor().execute(h.envelope("report",words),{kind:"group",actions:[{kind:"send_message",threadId:"build",purpose:"instruction",text:message},{kind:"open_thread",threadId:"build",split:false}]},"live",h.context);
  assert.equal(outcome.status,"succeeded");assert.equal(h.world.ui.length,1);assert.equal(h.world.sends.length,1);
  const body=JSON.parse(h.world.sends[0].input[0].text.split("\n").at(-1)!);
  assert.equal(body.user.text,words);assert.equal(body.message,message);assert.equal(body.destination.thread_id,"build");
  assert.equal(body.excerpt,undefined);assert.equal(h.world.sends[0].mode,"queue-if-active");
  assert.doesNotMatch(outcome.speech,/two dispatch bugs|do not implement/i);
});

test("concurrent repeats execute each recorded step exactly once and reject changed arguments",async t=>{
  const h=fixture();t.after(h.close);const executor=h.executor();const action:QuickAction={kind:"group",actions:[{kind:"open_thread",threadId:"build",split:false},send() as Any]};
  const [a,b]=await Promise.all([executor.execute(h.envelope(),action,"live",h.context),executor.execute(h.envelope(),action,"live",h.context)]);
  assert.deepEqual(a,b);assert.equal(h.world.ui.length,1);assert.equal(h.world.sends.length,1);assert.equal(a.receipts.length,2);
  await assert.rejects(()=>executor.execute(h.envelope(),send(),"live",h.context),/different recorded action group/);
  await assert.rejects(()=>executor.execute(h.envelope(),action,"coordinator",h.context),/different recorded action group/);
  await h.executor().execute(h.envelope(),action,"live",h.context);
  assert.equal(h.world.sends.length,1,"a new executor after reload reuses receipts");
});

test("partial groups never replay or perform their remaining effects after restart",async t=>{
  const h=fixture();t.after(h.close);
  h.context.ui=async()=>({status:"failed",detail:"No UI handler"});
  const action:QuickAction={kind:"group",actions:[send() as Any,{kind:"open_thread",threadId:"build",split:false},start() as Any]};
  const result=await h.executor().execute(h.envelope(),action,"live",h.context);
  assert.equal(result.status,"failed");assert.equal(h.world.sends.length,1);assert.equal(h.world.spawns.length,0);
  h.context.ui=async()=>({status:"succeeded",detail:"Now available"});
  assert.deepEqual(await h.executor().execute(h.envelope(),action,"live",h.context),result);
  assert.equal(h.world.spawns.length,0);
});

test("SDK effects are durably claimed before the call, with unknown delivery never resent",async t=>{
  const h=fixture();t.after(h.close);let calls=0;
  h.world.overrides.send=async()=>{calls++;assert.equal(h.store.step("req-1",0)?.status,"executing");throw new Error("receipt lost after send");};
  const result=await h.executor().execute(h.envelope(),send(),"live",h.context);
  assert.equal(result.status,"unknown");assert.match(result.speech,/not repeated/);
  await h.executor().execute(h.envelope(),send(),"live",h.context);assert.equal(calls,1);
});

test("cancellation during send preserves a late result without running the rest of the group",async t=>{
  const h=fixture();t.after(h.close);let resolve!: (value:Any)=>void;const late:Any[]=[];
  h.world.overrides.send=async(args:Any)=>{h.world.sends.push(args);return new Promise(r=>{resolve=r;});};h.context.lateResult=value=>late.push(value);
  const action:QuickAction={kind:"group",actions:[send() as Any,start() as Any]};
  const pending=h.executor().execute(h.envelope(),action,"live",h.context);await settle();h.controller.abort();
  assert.equal((await pending).status,"unknown");assert.equal(h.world.spawns.length,0);
  resolve({ok:true,delivery:"sent"});await settle();assert.equal(late.length,1);assert.equal(h.store.step("req-1",0)?.result?.status,"succeeded");
  const fresh={...h.context,signal:new AbortController().signal,current:()=>true};
  await h.executor().execute(h.envelope(),action,"live",fresh);assert.equal(h.world.spawns.length,0);assert.equal(h.world.sends.length,1);
});

test("cancellation during preflight prevents worker creation and releases a late reservation",async t=>{
  const h=fixture();t.after(h.close);let resolve!: (value:Any)=>void;
  h.world.overrides.models=async()=>new Promise(r=>{resolve=r;});
  const pending=h.executor().execute(h.envelope(),start(),"live",h.context);await settle();h.controller.abort();
  assert.equal((await pending).status,"cancelled");resolve(h.world.catalog);await settle();
  assert.equal(h.world.spawns.length,0);assert.equal(h.store.activeWorkerCount(),0);
});

test("direct worker dispatch uses role settings and managed workspaces independently of coordinator",async t=>{
  const h=fixture();t.after(h.close);const settings=defaultWorkerSettings();settings.profiles.investigate={providerId:"codex",model:"strong-model",reasoningLevel:"high",serviceTier:"fast"};
  await h.bb.storage.kv.set(WORKER_PROFILE_KEY,settings);await h.bb.storage.kv.set("config",{coordinator:{providerId:"codex",model:"tiny-coordinator"}});
  const result=await h.executor().execute(h.envelope("new","Investigate missing transcriptions; don't edit files."),start(),"live",h.context);
  assert.equal(result.status,"succeeded");assert.match(result.speech,/started investigating Retry investigation/);
  const args=h.world.spawns[0];assert.equal(args.model,"strong-model");assert.equal(args.reasoningLevel,"high");assert.equal(args.serviceTier,"fast");
  assert.equal(args.visibility,"hidden");assert.equal(args.parentThreadId,"coordinator");assert.equal(args.permissionMode,"accept-edits");
  assert.deepEqual(args.environment,{type:"host",hostId:"mac",workspace:{type:"managed-worktree",baseBranch:{kind:"default"}}});
  assert.match(args.prompt,/don't edit files/);assert.match(args.prompt,/voice_worker_report/);assert.match(args.prompt,/not a read-only sandbox/);
  assert.deepEqual(h.world.watched,["worker-1"]);assert.equal(h.store.workerForThread("worker-1")?.role,"investigate");
});

test("multiple machines require an explicit matching host",async t=>{
  const h=fixture();t.after(h.close);h.world.hosts[1].status="connected";
  const bad=await h.executor().execute(h.envelope(),start(),"live",h.context);assert.equal(bad.status,"failed");assert.match(bad.speech,/Choose a machine/);assert.equal(h.world.spawns.length,0);
  const wrong=await h.executor().execute(h.envelope("wrong"),{...start(),hostId:"unknown"} as QuickAction,"live",h.context);assert.equal(wrong.status,"failed");
  const good=await h.executor().execute(h.envelope("good"),{...start(),hostId:"studio"} as QuickAction,"live",h.context);assert.equal(good.status,"succeeded");assert.equal(h.world.spawns[0].environment.hostId,"studio");
});

for(const scenario of ["provider","model","reasoning","fast","catalog"] as const) test(`unsupported worker ${scenario} fails without substitution`,async t=>{
  const h=fixture();t.after(h.close);const settings=defaultWorkerSettings();
  if(scenario==="provider")h.world.providers[0].available=false;
  if(scenario==="model")settings.profiles.investigate.model="not-present";
  if(scenario==="reasoning")settings.profiles.investigate.reasoningLevel="ultra";
  if(scenario==="fast"){settings.profiles.investigate.serviceTier="fast";h.world.catalog.providers[0].serviceTiers=[];}
  if(scenario==="catalog")h.world.overrides.models=async()=>({...h.world.catalog,modelLoadError:{code:"unavailable"}});
  await h.bb.storage.kv.set(WORKER_PROFILE_KEY,settings);
  const result=await h.executor().execute(h.envelope(),start(),"live",h.context);
  assert.equal(result.status,"failed");assert.equal(h.world.spawns.length,0);assert.equal(h.store.activeWorkerCount(),0);
});

test("concurrent creations share the worker quota and completed work frees its slot",async t=>{
  const h=fixture();t.after(h.close);const settings=defaultWorkerSettings();settings.maxActiveWorkers=1;await h.bb.storage.kv.set(WORKER_PROFILE_KEY,settings);
  const executor=h.executor();const outcomes=await Promise.all([executor.execute(h.envelope("a"),start(),"live",h.context),executor.execute(h.envelope("b"),start(),"live",h.context)]);
  assert.equal(outcomes.filter(r=>r.status==="succeeded").length,1);assert.equal(h.world.spawns.length,1);assert.equal(h.store.activeWorkerCount(),1);
  h.world.threads.get("worker-1").status="idle";h.world.threads.get("worker-1").queuedMessageCount=0;
  assert.equal((await executor.execute(h.envelope("c"),start(),"live",h.context)).status,"succeeded");assert.equal(h.world.spawns.length,2);
});

test("an unconfirmed creation consumes quota after reload and cannot spawn a duplicate",async t=>{
  const h=fixture();t.after(h.close);const settings=defaultWorkerSettings();settings.maxActiveWorkers=1;await h.bb.storage.kv.set(WORKER_PROFILE_KEY,settings);
  let spawns=0;h.world.overrides.spawn=async()=>{spawns++;throw new Error("create response lost");};
  assert.equal((await h.executor().execute(h.envelope(),start(),"live",h.context)).status,"unknown");
  await h.executor().execute(h.envelope(),start(),"live",h.context);assert.equal(spawns,1);
  assert.equal((await h.executor().execute(h.envelope("new"),start(),"live",h.context)).status,"failed");assert.equal(spawns,1);
});

test("task stopping is explicit, does not claim process exit, and is deduplicated",async t=>{
  const h=fixture();t.after(h.close);const action:QuickAction={kind:"stop_thread",threadId:"build"};
  const result=await h.executor().execute(h.envelope("stop","Stop the build task now"),action,"live",h.context);
  assert.match(result.speech,/Stop requested for Build Fix/);assert.equal(result.receipts[0].outcome,"pending");
  await h.executor().execute(h.envelope("stop","Stop the build task now"),action,"live",h.context);assert.deepEqual(h.world.stops,["build"]);
});

for(const state of ["hidden","archived","deleted","coordinator"] as const)test(`direct messages reject ${state} targets before execution`,async t=>{
  const h=fixture();t.after(h.close);const thread=h.world.threads.get("build");
  if(state==="hidden")thread.visibility="hidden";if(state==="archived")thread.archivedAt=1;if(state==="deleted")thread.deletedAt=1;if(state==="coordinator")thread.title="Voice coordinator abc";
  assert.equal((await h.executor().execute(h.envelope(),send(),"live",h.context)).status,"failed");assert.equal(h.world.sends.length,0);
});

test("reserved coordinator titles cannot turn a new worker into a coordinator",async t=>{
  const h=fixture();t.after(h.close);
  const result=await h.executor().execute(h.envelope(),{...start(),title:"Voice coordinator mistaken"} as QuickAction,"live",h.context);
  assert.equal(result.status,"failed");assert.match(result.speech,/reserved/);assert.equal(h.world.spawns.length,0);
});

test("opening an archived thread is a read/navigation operation, not a new instruction",async t=>{
  const h=fixture();t.after(h.close);h.world.threads.get("build").archivedAt=1;
  const result=await h.executor().execute(h.envelope(),{kind:"open_thread",threadId:"build",split:false},"live",h.context);
  assert.equal(result.status,"succeeded");assert.equal(h.world.ui.length,1);assert.equal(h.world.sends.length,0);
});

test("distinct operations share an utterance while duplicate effects survive new tool ids and reload",async t=>{
  const h=fixture();t.after(h.close);
  const envelope=(id:string)=>({...h.envelope(id),utteranceId:"utterance-1",utteranceVersion:1});
  await h.executor().execute(envelope("send"),send(),"live",h.context);
  const result=await h.executor().execute(envelope("group"),{kind:"group",actions:[{kind:"open_thread",threadId:"build"},send() as Any]},"live",h.context);
  assert.equal(result.status,"succeeded");assert.equal(h.world.ui.length,1);assert.equal(h.world.sends.length,1);
  await h.executor().execute({...envelope("new-turn"),utteranceId:"utterance-2",utteranceVersion:2},send(),"live",h.context);
  assert.equal(h.world.sends.length,2,"a new spoken request can explicitly repeat the action");
});

test("uncertain effects cannot be repeated under another request in the same utterance",async t=>{
  const h=fixture();t.after(h.close);let attempts=0;
  h.world.overrides.send=async()=>{attempts++;throw Error("Connection lost after acceptance");};
  const envelope=(id:string)=>({...h.envelope(id),utteranceId:"utterance-1",utteranceVersion:1});
  assert.equal((await h.executor().execute(envelope("first"),send(),"live",h.context)).status,"unknown");
  assert.equal((await h.executor().execute(envelope("second"),send(),"live",h.context)).status,"unknown");
  assert.equal(attempts,1);
});

test("hidden internal workers remain controllable only from their own voice conversation",async t=>{
  const h=fixture();t.after(h.close);
  await h.executor().execute(h.envelope("worker","Investigate missing transcripts."),start(),"live",h.context);
  const threadId="worker-1";
  assert.equal(h.world.threads.get(threadId).visibility,"hidden");
  const message:QuickAction={kind:"send_message",threadId,purpose:"instruction"};
  const foreign={...h.envelope("foreign","Also inspect errors."),conversationId:"other"};
  assert.equal((await h.executor().execute(foreign,message,"coordinator",h.context)).status,"failed");
  assert.equal(h.world.sends.length,0);
  const reply=await h.executor().execute(h.envelope("follow-up","Also inspect errors."),message,"coordinator",h.context);
  assert.equal(reply.status,"succeeded");assert.equal(h.world.sends.length,1);assert.match(reply.speech,/I’ve queued your update/);
  assert.equal((await h.executor().execute(h.envelope("stop-worker","Stop the investigation."),{kind:"stop_thread",threadId},"coordinator",h.context)).status,"succeeded");
  assert.deepEqual(h.world.stops,[threadId]);
});
