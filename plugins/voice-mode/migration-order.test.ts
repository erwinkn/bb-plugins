import test from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { voiceFeatureMigrations } from "./migration-order.ts";
import { LIVE_ACTION_MIGRATIONS } from "./legacy-migrations.ts";
import { SEQUENCE_MIGRATIONS } from "./legacy-migrations.ts";
import { MESSAGE_SEND_MIGRATIONS } from "./legacy-migrations.ts";

for (const [name, history] of [
  ["sequence-enabled installation", [...SEQUENCE_MIGRATIONS, ...MESSAGE_SEND_MIGRATIONS]],
  ["three-tier installation", LIVE_ACTION_MIGRATIONS],
] as const) {
  test(`migration reconciliation preserves the ${name} across repeated starts`, async () => {
    const {bb,harness}=createFakePluginHost({pluginId:"voice-mode"});
    try {
      const db=bb.storage.database();
      const common=["CREATE TABLE preserved_session (id TEXT PRIMARY KEY, transcript TEXT NOT NULL)"];
      bb.storage.migrate(db,[...common,...history]);
      db.prepare("INSERT INTO preserved_session VALUES ('session', 'Keep every word')").run();
      const before=db.prepare("SELECT id,statement_hash FROM _bb_migrations ORDER BY id").all();
      for(let i=0;i<2;i++)bb.storage.migrate(db,[...common,...voiceFeatureMigrations(db,common.length)]);
      assert.deepEqual(db.prepare("SELECT * FROM preserved_session").all(),[{id:"session",transcript:"Keep every word"}]);
      assert.deepEqual(db.prepare("SELECT id,statement_hash FROM _bb_migrations WHERE id < ? ORDER BY id").all(before.length),before);
      for(const table of ["voice_sequences","voice_message_sends","voice_action_groups","voice_action_steps","voice_workers"])
        assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table),table);
    } finally {await harness.lifecycle.dispose();}
  });
}

for(const branch of ["sequence","actions"] as const)test(`the ordered ${branch} migration list is unchanged by the runtime removal`,async()=>{
  const {readFileSync}=await import("node:fs");
  const expected=JSON.parse(readFileSync(new URL("./test-fixtures/feature-migrations-before-cutover.json",import.meta.url),"utf8"));
  const {bb,harness}=createFakePluginHost({pluginId:"voice-mode"});
  try {
    const db=bb.storage.database();
    if(branch==="actions")db.exec("CREATE TABLE voice_action_groups (id TEXT)");
    assert.deepEqual(voiceFeatureMigrations(db,0),expected[branch]);
  }finally{await harness.lifecycle.dispose();}
});
