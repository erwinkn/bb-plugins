import test from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { defaultWorkerSettings, namedSettingsFromLegacy, readNamedWorkerSettings, NAMED_WORKER_PROFILE_KEY, WORKER_PROFILE_KEY } from "./worker-profiles.ts";
import { WORKER_BASE_PROMPT, DEFAULT_PROFILE_INSTRUCTIONS } from "./worker-prompt.ts";

const sdk = {
  hosts: { list: async () => [{ id: "desktop", name: "Desktop", status: "connected" }] },
  providers: { list: async () => [{ id: "codex", displayName: "Codex", available: true }], models: async () => ({ modelLoadError: null,
    models: [{ id: "chosen", model: "chosen", displayName: "Chosen", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "high" }] }],
    providers: [{ id: "codex", serviceTiers: [{ id: "default", label: "Default" }] }] }) },
};

test("plugin startup migrates v1 to named profiles once and preserves both old settings and history", async t => {
  const {bb,harness} = createFakePluginHost({pluginId:"voice-mode"}); t.after(()=>harness.lifecycle.dispose());
  const old=defaultWorkerSettings();old.maxActiveWorkers=12;old.profiles.review.model="old-choice";
  await bb.storage.kv.set(WORKER_PROFILE_KEY,old);await plugin(bb);
  const migrated=await bb.storage.kv.get<any>(NAMED_WORKER_PROFILE_KEY);
  assert.deepEqual(migrated,namedSettingsFromLegacy(old));assert.equal(migrated.defaultProfile,"implement");assert.equal(migrated.workerBasePrompt,WORKER_BASE_PROMPT);
  assert.equal(migrated.profiles[0].instructions,DEFAULT_PROFILE_INSTRUCTIONS.investigate);
  assert.deepEqual(migrated.profiles.map((p: any) => p.permissionMode), Array(4).fill("accept-edits"));
  const db=bb.storage.database();const before=db.prepare("SELECT * FROM voice_role_prompts").all();
  const edited={...migrated,maxActiveWorkers:9};await bb.storage.kv.set(NAMED_WORKER_PROFILE_KEY,edited);
  const reloaded=await harness.lifecycle.reload(plugin);t.after(()=>reloaded.harness.lifecycle.dispose());
  assert.deepEqual(await reloaded.bb.storage.kv.get(NAMED_WORKER_PROFILE_KEY),edited);assert.deepEqual(await reloaded.bb.storage.kv.get(WORKER_PROFILE_KEY),old);
  assert.deepEqual(reloaded.bb.storage.database().prepare("SELECT * FROM voice_role_prompts").all(),before);
});

test("a fresh installation reads defaults without writing either profile key", async t => {
  const {bb,harness}=createFakePluginHost({pluginId:"voice-mode"});t.after(()=>harness.lifecycle.dispose());await plugin(bb);
  assert.deepEqual(await harness.behavior.callRpc("getWorkerSettings",null),namedSettingsFromLegacy(defaultWorkerSettings()));
  assert.equal(await bb.storage.kv.get(WORKER_PROFILE_KEY),undefined);assert.equal(await bb.storage.kv.get(NAMED_WORKER_PROFILE_KEY),undefined);
});

test("v2 save validates names, default, model, reasoning, Fast, permissions, and selected machine before writing", async t => {
  const {bb,harness}=createFakePluginHost({pluginId:"voice-mode",sdk:sdk as any});t.after(()=>harness.lifecycle.dispose());await plugin(bb);
  const settings=namedSettingsFromLegacy(defaultWorkerSettings());settings.profiles[0].model="chosen";
  assert.deepEqual(await harness.behavior.callRpc("setWorkerSettings",{hostId:"desktop",settings}),settings);
  const invalid = [
    {...settings,defaultProfile:"missing"},
    {...settings,profiles:[settings.profiles[0],settings.profiles[0]]},
    {...settings,profiles:settings.profiles.filter(p=>p.name!==settings.defaultProfile)},
    {...settings,profiles:settings.profiles.map((p,i)=>i===0?{...p,model:"missing"}:p)},
    {...settings,profiles:settings.profiles.map((p,i)=>i===0?{...p,providerId:"missing"}:p)},
    {...settings,profiles:settings.profiles.map((p,i)=>i===0?{...p,reasoningLevel:"max"}:p)},
    {...settings,profiles:settings.profiles.map((p,i)=>i===0?{...p,serviceTier:"fast"}:p)},
    {...settings,profiles:settings.profiles.map((p,i)=>i===0?{...p,permissionMode:"invalid"}:p)},
  ];
  for(const value of invalid) await assert.rejects(harness.behavior.callRpc("setWorkerSettings",{hostId:"desktop",settings:value}));
  await assert.rejects(harness.behavior.callRpc("setWorkerSettings",{hostId:"offline",settings}),/no longer connected/);
  assert.deepEqual(await bb.storage.kv.get(NAMED_WORKER_PROFILE_KEY),settings);
  assert.ok(harness.inspection.sdk.callsTo("providers.models").every(call=>(call[0] as any).hostId==="desktop"));
});

test("existing v2 profiles without a permission mode read as accept-edits without rewriting storage", async t => {
  const { bb, harness } = createFakePluginHost({ pluginId: "voice-mode" }); t.after(() => harness.lifecycle.dispose());
  const settings = namedSettingsFromLegacy(defaultWorkerSettings());
  const stored = { ...settings, profiles: settings.profiles.map(({ permissionMode, ...profile }) => profile) };
  await bb.storage.kv.set(NAMED_WORKER_PROFILE_KEY, stored);
  assert.deepEqual(await readNamedWorkerSettings(bb), settings);
  assert.deepEqual(await bb.storage.kv.get(NAMED_WORKER_PROFILE_KEY), stored);
});

test("historical coordinator prompt is readable but cannot be saved by RPC", async t => {
  const {bb,harness}=createFakePluginHost({pluginId:"voice-mode"});t.after(()=>harness.lifecycle.dispose());await plugin(bb);
  const db=bb.storage.database();db.prepare("INSERT INTO voice_role_prompts(role,ts,source,content) VALUES ('coordinator',1,'user','Historical words')").run();
  const before=db.prepare("SELECT * FROM voice_role_prompts").all();
  assert.equal((await harness.behavior.callRpc("getPrompt",{role:"coordinator"}) as any).content,"Historical words");
  await assert.rejects(harness.behavior.callRpc("setPrompt",{role:"coordinator",content:"Replace",source:"user",note:null}),/read only/);
  assert.deepEqual(db.prepare("SELECT * FROM voice_role_prompts").all(),before);
});

test("ended session reads task tails and subscriptions without claiming a call", async t => {
  const {bb,harness}=createFakePluginHost({pluginId:"voice-mode"});t.after(()=>harness.lifecycle.dispose());await plugin(bb);
  const db=bb.storage.database();db.prepare("INSERT INTO voice_conversations(id,created_at,updated_at,status,state_json) VALUES ('saved',1,1,'released','{}')").run();
  db.prepare("INSERT INTO voice_tasks(op_id,conversation_id,thread_id,kind,profile,title,status,last_text,created_at,updated_at) VALUES ('op','saved','thread','worker','review','Check layout','turn_ended',?,1,2)").run("x".repeat(6200)+"Done");
  db.prepare("INSERT INTO voice_watches(conversation_id,thread_id,root_thread_id,state,created_at,updated_at) VALUES ('saved','thread','thread','disabled',1,2)").run();
  const sdkCalls=harness.inspection.sdk.calls.length;
  const detail=await harness.behavior.callRpc("getVoiceSession",{sessionId:"saved"}) as any;
  assert.equal(detail.work.tasks[0].last_text.length,6000);assert.ok(detail.work.tasks[0].last_text.endsWith("Done"));assert.equal(detail.work.tasks[0].truncated,true);
  assert.equal(detail.work.subscriptions[0].state,"disabled");assert.equal((db.prepare("SELECT nonce FROM voice_call_control").get() as any).nonce,null);
  assert.equal(harness.inspection.sdk.calls.length,sdkCalls);
});
