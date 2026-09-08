import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { UI_COMMAND_MIGRATIONS, UiCommandManager } from "./ui-command-manager.ts";
import { UiActionSchema, UiCommandSchema, type UiCommand } from "./ui-actions.ts";

function setup(timeout = 1000) {
  const db = new Database(":memory:");
  UI_COMMAND_MIGRATIONS.forEach(sql => db.exec(sql));
  const commands: UiCommand[] = [];
  let nonce: string | null = "call";
  const manager = new UiCommandManager(db, command => command.callNonce === nonce, command => commands.push(command), timeout);
  const input = { conversationId: "conversation", callNonce: "call", requestId: "request", action: UiActionSchema.parse({ kind: "open_thread", threadId: "thread" }) };
  const identity = { conversationId: input.conversationId, callNonce: input.callNonce };
  return { db, commands, manager, input, identity, end() { nonce = null; manager.cancelCall("call"); }, close() { manager.dispose(); db.close(); } };
}

test("UI schemas reject malformed actions and supply conservative defaults", () => {
  assert.deepEqual(UiActionSchema.parse({ kind: "open_thread", threadId: "thread" }), { kind: "open_thread", threadId: "thread", split: false });
  assert.equal(UiActionSchema.parse({ kind: "prepare_draft", target: { kind: "new" }, text: "draft" }).kind, "prepare_draft");
  for (const action of [{ kind: "delete_thread", threadId: "thread" }, { kind: "preview_file", target: { kind: "workspace", environmentId: "env", path: "../secret" } }]) assert.equal(UiActionSchema.safeParse(action).success, false);
});

test("pending recovery, atomic claim, and result receipt execute one command once", async () => {
  const h = setup();
  try {
    const result = h.manager.issue(h.input);
    const command = h.commands[0];
    const claim = { ...h.identity, commandId: command.id };
    assert.deepEqual(h.manager.pending(h.identity), [command]);
    assert.equal(h.manager.claim({ ...claim, callNonce: "other" }).claimed, false);
    assert.equal(h.manager.claim(claim).claimed, true);
    assert.equal(h.manager.claim(claim).claimed, false);
    assert.deepEqual(h.manager.pending(h.identity), []);
    const receipt = { status: "succeeded" as const, detail: "Thread opened." };
    assert.equal(h.manager.report({ ...claim, result: receipt }).accepted, true);
    assert.deepEqual(await result, receipt);
    assert.equal(h.manager.report({ ...claim, result: receipt }).accepted, true);
    assert.equal(h.manager.claim(claim).claimed, false);
    const next = h.manager.issue(h.input);
    h.end();
    assert.equal((await next).status, "cancelled", "same request allows subsequent actions but hangup cancels pending work");
  } finally { h.close(); }
});

test("hangup blocks late claims and reports; started outcomes are unknown", async () => {
  for (const started of [false, true]) {
    const h = setup();
    try {
      const result = h.manager.issue(h.input);
      const claim = { ...h.identity, commandId: h.commands[0].id };
      if (started) assert.equal(h.manager.claim(claim).claimed, true);
      h.end();
      assert.equal((await result).status, started ? "unknown" : "cancelled");
      assert.equal(h.manager.claim(claim).claimed, false);
      assert.equal(h.manager.report({ ...claim, result: { status: "succeeded", detail: "Late" } }).accepted, false);
    } finally { h.close(); }
  }
});

test("timeouts distinguish untouched commands from ambiguous started effects", async () => {
  for (const started of [false, true]) {
    const h = setup(15);
    try {
      const result = h.manager.issue(h.input);
      if (started) h.manager.claim({ ...h.identity, commandId: h.commands[0].id });
      assert.equal((await result).status, started ? "unknown" : "cancelled");
    } finally { h.close(); }
  }
});

test("restart preserves terminal receipts and never replays a started command", () => {
  const h = setup();
  try {
    const command = UiCommandSchema.parse({ ...h.input, id: "crashed", expiresAt: Date.now() + 1000 });
    h.db.prepare("INSERT INTO voice_ui_commands VALUES (?, ?, ?, ?, 'started', NULL, ?)").run(command.id, command.conversationId, command.callNonce, JSON.stringify(command), Date.now());
    const restarted = new UiCommandManager(h.db, () => true, () => assert.fail("must not publish"));
    assert.equal(restarted.claim({ ...h.identity, commandId: command.id }).claimed, false);
    assert.deepEqual(restarted.pending(h.identity), []);
    const row = h.db.prepare("SELECT result_json FROM voice_ui_commands WHERE id = ?").get(command.id) as { result_json: string };
    assert.equal(JSON.parse(row.result_json).status, "unknown");
    restarted.dispose();
  } finally { h.close(); }
});

test("request cancellation revokes a started command while the call remains live", async () => {
  const db = new Database(":memory:"); UI_COMMAND_MIGRATIONS.forEach(sql => db.exec(sql));
  const commands: UiCommand[] = [], revoked: UiCommand[] = [];
  const manager = new UiCommandManager(db, () => true, command => commands.push(command), 1000, command => revoked.push(command));
  try {
    const controller = new AbortController();
    const input = { conversationId: "conversation", callNonce: "call", requestId: "request", action: UiActionSchema.parse({ kind: "show_voice" }) };
    const waiting = manager.issue(input, controller.signal);
    manager.claim({ ...input, commandId: commands[0].id });
    controller.abort();
    assert.equal((await waiting).status, "unknown");
    assert.deepEqual(revoked, commands);
    assert.deepEqual(manager.revoked(input), [commands[0].id]);
  } finally { manager.dispose(); db.close(); }
});

test("request settlement rejects new results and timeout resolves started work as unknown", async () => {
  const db = new Database(":memory:"); UI_COMMAND_MIGRATIONS.forEach(sql => db.exec(sql));
  let active = true;
  const commands: UiCommand[] = [];
  const manager = new UiCommandManager(db, () => active, command => commands.push(command), 15, () => {}, () => true);
  try {
    const input = { conversationId: "conversation", callNonce: "call", requestId: "request", action: UiActionSchema.parse({ kind: "show_voice" }) };
    const waiting = manager.issue(input);
    const claim = { ...input, commandId: commands[0].id };
    manager.claim(claim);
    active = false;
    assert.equal(manager.report({ ...claim, result: { status: "succeeded", detail: "Late" } }).accepted, false);
    assert.equal((await waiting).status, "unknown");
  } finally { manager.dispose(); db.close(); }
});

test("a lost successful report response can be acknowledged after request settlement", async () => {
  const db = new Database(":memory:"); UI_COMMAND_MIGRATIONS.forEach(sql => db.exec(sql));
  let active = true;
  const commands: UiCommand[] = [];
  const manager = new UiCommandManager(db, () => active, command => commands.push(command), 1000, () => {}, () => true);
  try {
    const input = { conversationId: "conversation", callNonce: "call", requestId: "request", action: UiActionSchema.parse({ kind: "show_voice" }) };
    const waiting = manager.issue(input);
    const claim = { ...input, commandId: commands[0].id };
    manager.claim(claim);
    const result = { status: "succeeded" as const, detail: "Voice shown" };
    assert.equal(manager.report({ ...claim, result }).accepted, true);
    await waiting;
    active = false;
    assert.equal(manager.report({ ...claim, result }).accepted, true);
    assert.equal(manager.report({ ...claim, result: { ...result, detail: "different" } }).accepted, false);
  } finally { manager.dispose(); db.close(); }
});

test("an elapsed timeout resolves even if wall time has not reached expiresAt",async t=>{
  const h=setup(5);
  t.mock.method(Date,"now",()=>1000);
  try {
    const waiting=h.manager.issue(h.input);
    h.manager.claim({...h.identity,commandId:h.commands[0].id});
    assert.equal((await waiting).status,"unknown");
  }finally{h.close();}
});
