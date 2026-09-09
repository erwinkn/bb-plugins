import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { PromptStore, PROMPT_MIGRATIONS, promptDefault, promptLimit } from "./prompt-store.ts";
import { LIVE_PROMPT } from "./live-prompt.ts";
import { WORKER_BASE_PROMPT } from "./worker-prompt.ts";

test("editable roles use the live and worker defaults within their limits",()=>{
  assert.equal(promptDefault("aide"),LIVE_PROMPT);assert.equal(promptDefault("worker"),WORKER_BASE_PROMPT);
  for(const role of ["aide","worker"] as const)assert.ok(promptDefault(role).length<=promptLimit(role));
});

test("aide defaults need no migration rows and saved aide edits win without changing rollback prompts",()=>{
  const db=new Database(":memory:");try{
    db.exec(PROMPT_MIGRATIONS.join(";"));
    db.prepare("INSERT INTO voice_role_prompts(role,ts,source,content) VALUES ('live',1,'user','Earlier live edit'),('coordinator',2,'user','Historical coordinator')").run();
    const before=db.prepare("SELECT * FROM voice_role_prompts").all();const store=new PromptStore(db);
    assert.equal(store.read("aide"),LIVE_PROMPT);assert.deepEqual(store.versions("aide"),[]);
    assert.deepEqual(db.prepare("SELECT * FROM voice_role_prompts").all(),before);
    store.save("aide","A new live edit",null);store.save("worker","Worker instructions",null);
    assert.equal(new PromptStore(db).read("aide"),"A new live edit");assert.equal(store.read("worker"),"Worker instructions");
    assert.equal(store.read("live"),"Earlier live edit");assert.equal(store.read("coordinator"),"Historical coordinator");
    assert.throws(()=>store.save("live","Cannot replace",null),/read only/);assert.throws(()=>store.save("coordinator","Cannot replace",null),/read only/);
    assert.deepEqual(db.prepare("SELECT * FROM voice_role_prompts WHERE role IN ('live','coordinator')").all(),before);
  }finally{db.close();}
});
