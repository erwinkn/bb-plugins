import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { PromptStore, PROMPT_MIGRATIONS, promptDefault, promptLimit } from "./prompt-store.ts";
import { LIVE_PROMPT } from "./live-prompt.ts";
import { WORKER_BASE_PROMPT } from "./worker-prompt.ts";

test("the new live prompt is the exact approved text and both live roles fit their limits",()=>{
  const plan=readFileSync(new URL("../../.bb/aide-live-workers-plan.md",import.meta.url),"utf8");
  assert.equal(LIVE_PROMPT,plan.match(/### Live prompt\n\n```text\n([\s\S]*?)\n```/)![1]);
  assert.equal(promptDefault("worker"),WORKER_BASE_PROMPT);
  for(const role of ["live","worker"] as const)assert.ok(promptDefault(role).length<=promptLimit(role));
});

test("live cutover activates once, preserving older role prompts and later user edits",()=>{
  const db=new Database(":memory:");try{
    db.exec(PROMPT_MIGRATIONS.join(";"));
    const store=new PromptStore(db);
    store.save("live","Earlier live edit",null);store.save("coordinator","Historical coordinator",null);
    store.activateLiveDefault();
    assert.equal(store.read("live"),LIVE_PROMPT);
    assert.ok(store.versions("live").some(row=>row.content==="Earlier live edit"));
    assert.equal(store.read("coordinator"),"Historical coordinator");
    store.save("live","A new live edit",null);store.save("worker","Worker instructions",null);
    new PromptStore(db).activateLiveDefault();
    assert.equal(store.read("live"),"A new live edit");assert.equal(store.read("worker"),"Worker instructions");
    assert.equal(store.versions("coordinator").length,1);
  }finally{db.close();}
});
