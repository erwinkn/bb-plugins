import test from "node:test";
import Database from "better-sqlite3";
import assert from "node:assert/strict";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { LiveRuntime } from "./live-runtime.ts";
import { LIVE_RUNTIME_MIGRATIONS } from "./live-store.ts";
import { hash, canonical } from "./operations.ts";
import { liveToolSchemas, LIVE_EFFECTS } from "./live-tools.ts";
import { defaultWorkerSettings, WORKER_PROFILE_KEY, readNamedWorkerSettings, NAMED_WORKER_PROFILE_KEY } from "./worker-profiles.ts";
import { WORKER_BASE_PROMPT } from "./worker-prompt.ts";
import plugin from "./server.ts";
import { legacyMigrations } from "./test-fixtures/legacy-migrations.ts";
import { voiceFeatureMigrations } from "./migration-order.ts";
import { CONVERSATION_HISTORY_MIGRATIONS, QUICK_ACTION_MIGRATIONS } from "./legacy-migrations.ts";
import { UI_COMMAND_MIGRATIONS } from "./legacy-migrations.ts";
import { UTTERANCE_EFFECT_MIGRATIONS, LIVE_ACTION_MIGRATIONS } from "./legacy-migrations.ts";
import { PROMPT_MIGRATIONS } from "./prompt-store.ts";
import { SEQUENCE_MIGRATIONS } from "./legacy-migrations.ts";
import { MESSAGE_SEND_MIGRATIONS } from "./legacy-migrations.ts";

type Any = any;
async function fixture() {
  let at = 10000, nonce = "call";
  const world = {
    threads: new Map<string, Any>([["build", makeThreadResponse({ id: "build", projectId: "app", title: "Build Fix", status: "active", updatedAt: 9000 })]]),
    outputs: new Map<string, string>(), events: new Map<string, Any[]>(), interactions: new Map<string, Any[]>(), queue: new Map<string, Any[]>(),
    list: null as null | ((args: Any) => Promise<Any[]>), interactionReads: 0,
    sends: [] as Any[], spawns: [] as Any[], archives: [] as string[], resolutions: [] as Any[], answers: [] as Any[], stops: [] as string[],
    send: null as null | ((args: Any) => Promise<Any>), spawn: null as null | ((args: Any) => Promise<Any>), get: null as null | ((args: Any) => Promise<Any>),
  };
  const sdk: Any = {
    projects: { list: async () => [{ id: "proj_personal", name: "Personal", kind: "personal", sources: [] }, { id: "app", name: "BB Plugins", kind: "standard", sources: [{ hostId: "mac" }] }, { id: "docs", name: "docs-site", kind: "standard", sources: [{ hostId: "mac" }] }] },
    hosts: { list: async () => [{ id: "laptop", name: "Laptop", status: "connected" }, { id: "mac", name: "Desktop", status: "connected" }, { id: "away", name: "Away", status: "disconnected" }] },
    providers: { list: async () => [{ id: "codex", available: true }], models: async () => ({ models: [{ id: "worker", model: "worker", isDefault: true }], modelLoadError: null }) },
    threads: {
      search: async () => ({}),
      get: async (args: Any) => { if (world.get) return world.get(args); const t = world.threads.get(args.threadId); if (!t) throw new Error("Missing thread"); return t; },
      output: async ({ threadId }: Any) => ({ output: world.outputs.get(threadId) ?? null }),
      list: async (args: Any) => world.list ? world.list(args) : [...world.threads.values()].filter(t => (!args.parentThreadId || t.parentThreadId === args.parentThreadId) && (args.hasParent !== false || !t.parentThreadId) && !!t.archivedAt === !!args.archived && (args.includeHidden || t.visibility !== "hidden")).slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 100)),
      events: { list: async ({ threadId, afterSeq, order, limit, beforeSeq }: Any) => {
        const events = (world.events.get(threadId) ?? []).filter(e => (!afterSeq || e.seq > +afterSeq) && (!beforeSeq || e.seq < +beforeSeq));
        return (order === "desc" ? [...events].reverse() : events).slice(0, +(limit ?? 100));
      } },
      queuedMessages: { list: async ({ threadId }: Any) => world.queue.get(threadId) ?? [] },
      send: async (args: Any) => { world.sends.push(args); if (world.send) return world.send(args); return { delivery: "sent", ok: true }; },
      spawn: async (args: Any) => {
        world.spawns.push(args); if (world.spawn) return world.spawn(args);
        const t = makeThreadResponse({ id: `worker-${world.spawns.length}`, title: args.title, projectId: args.projectId, visibility: args.visibility, status: "active", parentThreadId: null, updatedAt: at }); world.threads.set(t.id, t); return t;
      },
      stop: async ({ threadId }: Any) => { world.stops.push(threadId); return { ok: true }; },
      archive: async ({ threadId }: Any) => { world.archives.push(threadId); const t = world.threads.get(threadId); t.archivedAt = at; return { ok: true, archivedThreadIds: [threadId] }; },
      interactions: {
        list: async ({ threadId }: Any) => (world.interactions.get(threadId) ?? []).filter(i => i.status === "pending"),
        get: async ({ threadId, interactionId }: Any) => { world.interactionReads++; const i = world.interactions.get(threadId)?.find(i => i.id === interactionId); if (!i) throw new Error("Missing interaction"); return i; },
        resolve: async (args: Any) => { world.resolutions.push(args); const i = world.interactions.get(args.threadId)!.find(i => i.id === args.interactionId); i.status = "resolved"; return i; },
        respond: async (args: Any) => { world.answers.push(args); const i = world.interactions.get(args.threadId)!.find(i => i.id === args.interactionId); i.status = "resolved"; return i; },
      },
    },
  };
  const { bb, harness } = createFakePluginHost({ pluginId: "voice-mode", sdk });
  const db = bb.storage.database(); bb.storage.migrate(db, LIVE_RUNTIME_MIGRATIONS);
  db.exec("CREATE TABLE session_events (id INTEGER PRIMARY KEY, session_id TEXT, ts INTEGER, kind TEXT, payload TEXT); CREATE TABLE voice_conversation_calls (call_id TEXT PRIMARY KEY, conversation_id TEXT)");
  const makeRuntime = () => new LiveRuntime(bb, () => ({ nonce, conversationId: "conversation" }), () => at, 20);
  let runtime = makeRuntime();
  const start = () => runtime.callStartContext({ nonce, conversationId: "conversation", view: { threadId: "build", projectId: "app" } });
  await start();
  await runtime.watches.serial(async () => {});
  const input = (tool: Any, args: Any, overrides: Any = {}) => ({ nonce, conversationId: "conversation", utterance: { id: "u1", version: 1, text: "Please check the build", startedAt: at - 100 }, responseOrigin: "user", tool, args, occurrence: 0, ...overrides });
  const run = (tool: Any, args: Any, overrides: Any = {}): Promise<Any> => runtime.runTool(input(tool, args, overrides));
  const idle = async (threadId = "build", text = "Done", queued = 0) => {
    at += 10; const thread = world.threads.get(threadId); thread.status = "idle"; thread.updatedAt = at; thread.queuedMessageCount = queued; world.outputs.set(threadId, text);
    const events = world.events.get(threadId) ?? []; events.push({ id: `e${events.length + 1}`, threadId, scope: { kind: "thread" }, seq: events.length + 1, type: "turn/completed", createdAt: at, data: { status: "completed", providerThreadId: null } }); world.events.set(threadId, events);
    await runtime.watches.event("thread.idle", { thread, lastAssistantText: text });
  };
  const watch = () => runtime.watches.watch("conversation", "build");
  const drain = (responseId = "r1") => { at += 10; runtime.reportDrain({ nonce, responseId, at }); };
  const approval = (id = "approval") => {
    const i = { id, threadId: "build", createdAt: at, status: "pending", payload: { kind: "approval", reason: "Check build output", subject: { kind: "command", command: "npm test", cwd: "/repo" }, availableDecisions: ["allow_once", "allow_for_session", "deny"] } };
    world.interactions.set("build", [i]); return i;
  };
  const later = (id = "u2") => { at += 10; return { utterance: { id, version: 1, text: "Yes, once", startedAt: at } }; };
  return { bb, harness, db, world, input, run, idle, watch, drain, approval, later, start,
    get runtime() { return runtime; }, tick: (ms = 10) => at += ms, now: () => at,
    switch: async () => { nonce = "new-call"; await start(); },
    restart: async () => { runtime = makeRuntime(); await runtime.initialize(); await start(); },
    close: async () => { await runtime.watches.serial(async () => {}); await harness.lifecycle.dispose(); } };
}
const message = { thread_id: "build", body: "Check the build", mode: "normal" };
const worker = { profile: "investigate", title: "Build investigation", task: "Find the cause. Do not implement.", project_id: "app" };

test("worker spawn passes each configured profile permission mode to BB", async t => {
  const h = await fixture(); t.after(h.close);
  const settings = await readNamedWorkerSettings(h.bb);
  for (const mode of ["accept-edits", "auto", "full"] as const) {
    settings.profiles.find(p => p.name === "investigate")!.permissionMode = mode;
    await h.bb.storage.kv.set(NAMED_WORKER_PROFILE_KEY, settings);
    const receipt = await h.run("spawn_worker", { ...worker, title: `Investigation ${mode}` });
    assert.equal(receipt.status, "running");
    assert.equal(h.world.spawns.at(-1).permissionMode, mode);
  }
  assert.equal(h.world.spawns.length, 3);
});

test("live tools expose all fourteen strict argument schemas", () => {
  const schemas = liveToolSchemas(); assert.equal(schemas.length, 14); assert.equal(new Set(schemas.map(s => s.name)).size, 14);
  for (const s of schemas) assert.equal(s.parameters.additionalProperties, false);
  assert.equal(canonical({ z: 2, a: { b: 1 } }), '{"a":{"b":1},"z":2}');
  assert.equal(hash({ a: 1, b: 2 }), hash({ b: 2, a: 1 }));
});

test("ledger retries, reconnects, and device switches never send twice", async t => {
  const h = await fixture(); t.after(h.close);
  const first = await h.run("message_thread", message);
  assert.equal(first.status, "running"); assert.deepEqual(await h.run("message_thread", { mode: "normal", body: message.body, thread_id: "build" }), first);
  await h.switch(); assert.deepEqual(await h.run("message_thread", message), first);
  await h.restart(); assert.deepEqual(await h.run("message_thread", message), first); assert.equal(h.world.sends.length, 1);
});

test("ledger is stored before the first SDK lookup and shares utterance text once", async t => {
  const h = await fixture(); t.after(h.close);
  h.world.get = async ({ threadId }) => { assert.ok(h.db.prepare("SELECT 1 FROM voice_operations").get()); return h.world.threads.get(threadId); };
  await h.run("message_thread", message);
  await h.run("stop_thread", { thread_id: "build" });
  const rows = h.db.prepare("SELECT utterance_text FROM voice_operations").all() as Any[];
  assert.equal(rows.filter(r => r.utterance_text !== null).length, 1);
  assert.equal(h.world.sends[0].input[0].text, "Check the build\nSpoken request: Please check the build");
  assert.equal(h.world.sends[0].mode, "queue-if-active");
  const bad = await h.run("message_thread", message, { utterance: { id: "u1", version: 1, text: "changed", startedAt: h.now() } });
  assert.match(bad.error, /text changed/);
});

test("new utterance, version, and occurrence each permit an intentional repeat", async t => {
  const h = await fixture(); t.after(h.close);
  await h.run("message_thread", message); await h.run("message_thread", message, { occurrence: 1 });
  await h.run("message_thread", message, { utterance: { id: "u1", version: 2, text: "Again", startedAt: h.now() } });
  await h.run("message_thread", message, h.later()); assert.equal(h.world.sends.length, 4);
});

test("background effects and navigation are refused before any SDK effect", async t => {
  const h = await fixture(); t.after(h.close);
  for (const tool of LIVE_EFFECTS) {
    const args: Any = { message_thread: message, spawn_worker: worker, create_thread: { project_id: "app", title: "Work", body: "Do it" }, prepare_draft: { thread_id: "build", text: "Draft", mode: "append" }, control_ui: { action: "show_voice" }, stop_thread: { thread_id: "build" }, archive_threads: { preview_id: "fake" }, answer_interaction: { thread_id: "build", interaction_id: "fake", decision: "deny" } };
    assert.match((await h.run(tool, args[tool], { responseOrigin: "background", utterance: null })).error, /Not authorized: background updates cannot act/);
  }
  assert.equal((h.db.prepare("SELECT count(*) n FROM voice_operations").get() as {n:number}).n, 0);
});

test("unknown target IDs and replaced nonces fail, returned IDs permit effects", async t => {
  const h = await fixture(); t.after(h.close);
  h.world.threads.set("other", makeThreadResponse({ id: "other", title: "Other", projectId: "app" }));
  assert.match((await h.run("message_thread", { ...message, thread_id: "other" })).error, /unknown target ID/);
  await h.run("find_targets", { query: "Other" });
  assert.equal((await h.run("message_thread", { ...message, thread_id: "other" })).status, "running");
  assert.match((await h.run("message_thread", message, { nonce: "old" })).error, /stopped or replaced/);
  assert.match((await h.run("message_thread", message, { conversationId: "other-conversation" })).error, /conversation does not own/);
  await assert.rejects(h.runtime.nextUpdateBatch({ nonce: "old" }), /Not authorized/);
});

test("unsubscribe then send stays muted; explicit subscribe re-enables", async t => {
  const h = await fixture(); t.after(h.close); await h.watch(); await h.idle();
  await h.run("subscriptions", { op: "unsubscribe", thread_id: "build" });
  assert.equal(h.runtime.store.inbox("conversation").length, 0);
  const sent = await h.run("message_thread", message); assert.equal(sent.updatesMuted, true); assert.match(sent.updates, /muted/);
  await h.idle("build", "Second result"); assert.equal(h.runtime.store.inbox("conversation").length, 0);
  await h.run("subscriptions", { op: "subscribe", thread_id: "build" });
  assert.equal(h.runtime.store.watches("conversation")[0].state, "active"); assert.equal(h.runtime.store.inbox("conversation").length, 1);
});

test("spawn reserves task and watch before SDK, hidden root finishes once before return", async t => {
  const h = await fixture(); t.after(h.close);
  h.world.spawn = async args => {
    assert.equal(h.runtime.store.tasks()[0].status, "spawning"); assert.match(h.runtime.store.watches()[0].thread_id, /^spawn:/);
    const thread = makeThreadResponse({ id: "fast", title: args.title, projectId: args.projectId, visibility: "hidden", parentThreadId: null, status: "idle", updatedAt: h.tick() });
    h.world.threads.set(thread.id, thread); h.world.outputs.set(thread.id, "Done");
    await h.runtime.watches.event("thread.idle", { thread, lastAssistantText: "Done" }); return thread;
  };
  const result = await h.run("spawn_worker", worker); assert.equal(result.status, "running"); assert.equal(result.launchAccepted, true);
  const spawned = h.world.spawns[0]; assert.equal(spawned.visibility, "hidden"); assert.equal(spawned.parentThreadId, undefined);
  assert.match(spawned.prompt, /Spoken request: Please check the build$/); assert.ok(spawned.prompt.startsWith(WORKER_BASE_PROMPT));
  assert.equal(h.runtime.store.tasks()[0].status, "turn_ended"); assert.equal(h.runtime.store.inbox("conversation").length, 1);
  await h.runtime.watches.event("thread.idle", { thread: h.world.threads.get("fast"), lastAssistantText: "Done" });
  assert.equal(h.runtime.store.inbox("conversation").length, 1);
  assert.deepEqual(await h.run("spawn_worker", worker), result); assert.equal(h.world.spawns.length, 1);
});

test("visible create uses body as prompt and is idempotent across device switch", async t => {
  const h = await fixture(); t.after(h.close); const args = { project_id: "app", title: "Visible", body: "Check tests" };
  const result = await h.run("create_thread", args); assert.equal(result.visibility, "visible"); assert.equal(h.world.spawns[0].prompt, "Check tests");
  await h.switch(); assert.deepEqual(await h.run("create_thread", args), result); assert.equal(h.world.spawns.length, 1);
});

test("worker quota reserves concurrent spawns and keeps unknown launches in the cap", async t => {
  const h = await fixture(); t.after(h.close); const settings = defaultWorkerSettings(); settings.maxActiveWorkers = 1; await h.bb.storage.kv.set(WORKER_PROFILE_KEY, settings);
  const results = await Promise.all([h.run("spawn_worker", worker), h.run("spawn_worker", { ...worker, title: "Second" }, { occurrence: 1 })]);
  assert.equal(h.world.spawns.length, 1); assert.equal(results.filter(r => r.status === "failed").length, 1);
  assert.match(results.find(r => r.error)!.error, /limit of 1/);
});

test("restart catches missed worker completion and never respawns an uncertain launch", async t => {
  const h = await fixture(); t.after(h.close); await h.run("spawn_worker", worker);
  const thread = h.world.threads.get("worker-1"); thread.status = "idle"; thread.updatedAt = h.tick(); h.world.outputs.set(thread.id, "Finished while offline");
  h.world.events.set(thread.id, [{ id: "missed", seq: 1, threadId: thread.id, type: "turn/completed", createdAt: h.now(), data: { status: "completed" } }]);
  h.runtime.watches.reserveTask("uncertain", "conversation", "worker", "Lost spawn", "investigate");
  await h.restart(); assert.equal(h.runtime.store.tasks().find(t => t.op_id === "uncertain")!.status, "unknown");
  assert.equal(h.runtime.store.inbox("conversation").length, 1); assert.equal(h.world.spawns.length, 1);
  await h.restart(); assert.equal(h.runtime.store.inbox("conversation").length, 1);
});

test("queued correlation distinguishes turns before and after dispatch", async t => {
  const h = await fixture(); t.after(h.close);
  h.world.send = async () => ({ delivery: "queued", queuedMessage: { id: "q1" } });
  const sent = await h.run("message_thread", message); assert.equal(sent.queuedMessageId, "q1");
  await h.idle("build", "Old turn", 1);
  assert.match(h.runtime.store.inbox("conversation")[0].detail, /while your message was still queued/);
  assert.equal(h.runtime.store.tasks().length, 0);
  h.tick(); await h.runtime.watches.event("message.dispatched", { entry: { id: "q1", threadId: "build" } as Any });
  assert.equal(h.runtime.operations.get(sent.operationId)!.status, "running");
  await h.idle("build", "Your answer");
  assert.match(h.runtime.store.inbox("conversation").at(-1)!.detail, /turn that included your message/);
  assert.equal(h.runtime.operations.get(sent.operationId)!.status, "succeeded");
});

test("steer uses steer-if-active and reports only that it joined the turn", async t => {
  const h = await fixture(); t.after(h.close); await h.run("message_thread", { ...message, mode: "steer" });
  assert.equal(h.world.sends[0].mode, "steer-if-active"); await h.idle(); assert.match(h.runtime.store.inbox("conversation")[0].detail, /turn your steer joined/);
});

test("SDK failure is failed; timeout stays unknown until matching queued body is found", async t => {
  const h = await fixture(); t.after(h.close);
  h.world.send = async () => { throw new Error("Unavailable"); }; assert.equal((await h.run("message_thread", message)).status, "failed");
  h.world.send = async () => new Promise(() => {}); const unknown = await h.run("message_thread", message, h.later()); assert.equal(unknown.status, "unknown");
  h.world.queue.set("build", [{ id: "accepted-late", content: [{ type: "text", text: "Check the build\nSpoken request: Yes, once" }], createdAt: h.now() }]);
  await h.runtime.watches.reconcileUnknown(); assert.equal(h.runtime.operations.get(unknown.operationId)!.status, "queued");
  assert.equal(h.world.sends.length, 2);
});

test("unknown send reconciles native user events but not assistant quoted bodies", async t => {
  const h = await fixture(); t.after(h.close); h.world.send = async () => { throw new Error("ETIMEDOUT"); };
  const unknown = await h.run("message_thread", message), body = "Check the build\nSpoken request: Please check the build";
  h.world.events.set("build", [{ seq: 1, type: "item/completed", createdAt: h.tick(), data: { item: { type: "agentMessage", content: [{ type: "text", text: body }] } } }]);
  await h.runtime.watches.reconcileUnknown(); assert.equal(h.runtime.operations.get(unknown.operationId)!.status, "unknown");
  h.world.events.get("build")!.push({ seq: 2, type: "item/started", createdAt: h.tick(), data: { item: { type: "userMessage", content: [{ type: "text", text: body }] } } });
  await h.runtime.watches.reconcileUnknown(); assert.equal(h.runtime.operations.get(unknown.operationId)!.status, "running");
});

test("scheduled delivery arguments fail instead of silently queueing", async t => {
  const h = await fixture(); t.after(h.close); const r = await h.run("message_thread", { ...message, send_at: "tomorrow" }); assert.match(r.error, /Sending later is not supported/); assert.equal(h.world.sends.length, 0);
});

test("interrupted offers requeue once, show offered_before, and no-audio is not heard", async t => {
  const h = await fixture(); t.after(h.close); await h.watch(); await h.idle();
  const batch = await h.runtime.nextUpdateBatch({ nonce: "call" }) as Any; assert.equal(batch.items[0].offered_before, false);
  assert.equal(await h.runtime.nextUpdateBatch({ nonce: "call" }), null);
  assert.deepEqual(h.runtime.closeOffer({ nonce: "call", offerId: batch.offerId, outcome: "delivered", responseId: "no-audio" }), { closed: true });
  assert.equal(h.runtime.watches.offer(batch.offerId)!.outcome, "not_delivered");
  assert.deepEqual(h.runtime.closeOffer({ nonce: "call", offerId: batch.offerId, outcome: "not_delivered" }), { closed: false });
  assert.equal(h.runtime.store.inbox("conversation")[0].offer_count, 1);
  const retry = await h.runtime.nextUpdateBatch({ nonce: "call" }) as Any; assert.equal(retry.items[0].offered_before, true);
  h.drain(); h.runtime.closeOffer({ nonce: "call", offerId: retry.offerId, outcome: "delivered", responseId: "r1" });
  assert.equal(h.runtime.store.inbox("conversation")[0].status, "spoken"); assert.equal(await h.runtime.nextUpdateBatch({ nonce: "call" }), null);
});

test("defer waits for the next exchange, dismiss waits for an event or explicit ask", async t => {
  const h = await fixture(); t.after(h.close); await h.run("message_thread", message); await h.idle();
  h.runtime.finishUserExchange({ nonce: "call", utteranceId: "u1" });
  const batch = await h.runtime.nextUpdateBatch({ nonce: "call" }) as Any; h.runtime.closeOffer({ nonce: "call", offerId: batch.offerId, outcome: "deferred" });
  assert.equal(await h.runtime.nextUpdateBatch({ nonce: "call" }), null);
  h.runtime.finishUserExchange({ nonce: "call", utteranceId: "u1" }); assert.equal(await h.runtime.nextUpdateBatch({ nonce: "call" }), null);
  h.runtime.finishUserExchange({ nonce: "call", utteranceId: "u2" }); const retry = await h.runtime.nextUpdateBatch({ nonce: "call" }) as Any; assert.ok(retry);
  h.runtime.closeOffer({ nonce: "call", offerId: retry.offerId, outcome: "dismissed" });
  h.runtime.finishUserExchange({ nonce: "call", utteranceId: "u3" }); assert.equal(await h.runtime.nextUpdateBatch({ nonce: "call" }), null);
  await h.run("read_threads", { thread_ids: ["build"], what: "updates" }); assert.ok(await h.runtime.nextUpdateBatch({ nonce: "call" }));
});

test("critical items survive dismiss and are reoffered at resume, not on quiet ticks", async t => {
  const h = await fixture(); t.after(h.close); await h.watch(); const interaction = h.approval();
  await h.runtime.watches.event("interaction.pending", { thread: h.world.threads.get("build"), interaction: interaction as Any });
  const batch = await h.runtime.nextUpdateBatch({ nonce: "call" }) as Any; h.runtime.closeOffer({ nonce: "call", offerId: batch.offerId, outcome: "dismissed" });
  assert.equal(h.runtime.store.inbox("conversation")[0].status, "offered"); assert.equal(await h.runtime.nextUpdateBatch({ nonce: "call" }), null);
  h.runtime.finishUserExchange({ nonce: "call", utteranceId: "next" }); assert.equal(await h.runtime.nextUpdateBatch({ nonce: "call" }), null);
  await h.switch(); assert.ok(await h.runtime.nextUpdateBatch({ nonce: "new-call" }));
});

test("offers group child results by root without merging critical items away", async t => {
  const h = await fixture(); t.after(h.close); await h.watch();
  for (const id of ["child1", "child2"]) { h.world.threads.set(id, makeThreadResponse({ id, title: id, projectId: "app", parentThreadId: "build", status: "active" })); await h.idle(id, `Result ${id}`); }
  const batch = await h.runtime.nextUpdateBatch({ nonce: "call" }) as Any; assert.equal(batch.items.length, 1); assert.equal(batch.items[0].children.length, 1); assert.equal(batch.items[0].root_thread_id, "build");
  h.runtime.closeOffer({ nonce: "call", offerId: batch.offerId, outcome: "dismissed" });
  await h.runtime.watches.event("thread.failed", { thread: { ...h.world.threads.get("child1"), status: "error", updatedAt: h.tick() }, error: "Failure" });
  const failure = await h.runtime.nextUpdateBatch({ nonce: "call" }) as Any; assert.equal(failure.items[0].kind, "failed");
});

test("archive rejects an earlier yes, changed scope, and second use; later drained yes succeeds", async t => {
  const h = await fixture(); t.after(h.close);
  const preview = await h.run("prepare_archive", { thread_ids: ["build"] });
  assert.match((await h.run("archive_threads", { preview_id: preview.previewId }, h.later())).error, /not been spoken/);
  h.drain();
  assert.match((await h.run("archive_threads", { preview_id: preview.previewId }, { utterance: { id: "early", version: 1, text: "Yes", startedAt: 1 } })).error, /after the spoken/);
  h.world.threads.get("build").queuedMessageCount = 1;
  assert.match((await h.run("archive_threads", { preview_id: preview.previewId }, h.later("changed"))).error, /scope changed/);
  const next = await h.run("prepare_archive", { thread_ids: ["build"] }, h.later("preview2")); h.drain("r2");
  const yes = h.later("yes"); assert.equal((await h.run("archive_threads", { preview_id: next.previewId }, yes)).status, "succeeded");
  assert.match((await h.run("archive_threads", { preview_id: next.previewId }, h.later("again"))).error, /already used/); assert.equal(h.world.archives.length, 1);
});

test("archive preview includes hidden children and detects changed queued body", async t => {
  const h = await fixture(); t.after(h.close);
  h.world.threads.set("child", makeThreadResponse({ id: "child", parentThreadId: "build", visibility: "hidden", status: "idle", title: "Child" }));
  h.world.queue.set("child", [{ id: "q", content: [{ type: "text", text: "Before" }] }]);
  const preview = await h.run("prepare_archive", { thread_ids: ["build"] }); assert.equal(preview.threads.length, 2); h.drain();
  h.world.queue.get("child")![0].content[0].text = "After";
  assert.match((await h.run("archive_threads", { preview_id: preview.previewId }, h.later())).error, /scope changed/);
});

test("approval requires spoken subject, later utterance, pending status, and user origin", async t => {
  const h = await fixture(); t.after(h.close); await h.watch(); const approval = h.approval();
  await h.runtime.watches.event("interaction.pending", { thread: h.world.threads.get("build"), interaction: approval as Any });
  const batch = await h.runtime.nextUpdateBatch({ nonce: "call" }) as Any; assert.match(batch.items[0].detail, /npm test/); assert.match(batch.items[0].detail, /Check build output/);
  const args = { thread_id: "build", interaction_id: approval.id, decision: "allow_once" };
  assert.match((await h.run("answer_interaction", args)).error, /not been spoken/); h.drain();
  assert.match((await h.run("answer_interaction", args, { utterance: { id: "early", version: 1, text: "Yes", startedAt: 1 } })).error, /after the spoken/);
  assert.match((await h.run("answer_interaction", args, { responseOrigin: "background", utterance: null })).error, /background/);
  assert.equal((await h.run("answer_interaction", args, h.later())).status, "succeeded");
  assert.deepEqual(h.world.resolutions[0].resolution, { decision: "allow_once", grantedPermissions: null });
  assert.match((await h.run("answer_interaction", args, h.later("again"))).error, /no longer pending/);
});

test("read_threads carries native user questions and responds with structured answer", async t => {
  const h = await fixture(); t.after(h.close);
  h.world.interactions.set("build", [{ id: "question", threadId: "build", createdAt: h.now(), status: "pending", payload: { kind: "user_question", questions: [{ id: "q", question: "Which branch?" }] } }]);
  const read = await h.run("read_threads", { thread_ids: ["build"], what: "status" }); assert.equal(read.threads[0].pendingInteractions[0].id, "question"); h.drain();
  const answer = { answers: { q: { selected: [], freeText: "main" } } };
  assert.equal((await h.run("answer_interaction", { thread_id: "build", interaction_id: "question", answer }, h.later())).status, "succeeded"); assert.deepEqual(h.world.answers[0].value, answer);
});

test("draft begin and finish are idempotent; restart and device switch cannot apply again", async t => {
  const h = await fixture(); t.after(h.close); const args = { thread_id: "build", text: "Draft", mode: "append" };
  const begun = await h.runtime.beginClientEffect(h.input("prepare_draft", args)) as Any; assert.equal(begun.execute, true);
  assert.equal((await h.runtime.beginClientEffect(h.input("prepare_draft", args)) as Any).execute, false);
  const result = h.runtime.finishClientEffect({ nonce: "call", operationId: begun.operationId, status: "succeeded", result: { applied: true } });
  assert.deepEqual((await h.runtime.beginClientEffect(h.input("prepare_draft", args)) as Any).receipt, result);
  await h.switch(); assert.equal((await h.runtime.beginClientEffect(h.input("prepare_draft", args)) as Any).execute, false);
  const pending = await h.runtime.beginClientEffect(h.input("control_ui", { action: "show_voice" })) as Any;
  await h.restart(); assert.equal(h.runtime.operations.get(pending.operationId)!.status, "unknown");
});

test("read output keeps the tail and reads tasks with disabled watches", async t => {
  const h = await fixture(); t.after(h.close); await h.run("spawn_worker", worker);
  await h.run("subscriptions", { op: "unsubscribe", thread_id: "worker-1" });
  h.world.outputs.set("worker-1", "x".repeat(6500) + "The conclusion");
  const read = await h.run("read_threads", { thread_ids: ["worker-1"], what: "output" }); assert.equal(read.threads[0].output.truncated, true); assert.ok(read.threads[0].output.text.endsWith("The conclusion"));
  const targets = await h.run("find_targets", { query: "investigation" }); assert.equal(targets.threads[0].id, "worker-1");
});

test("call start returns bounded history and does not overwrite old worker settings", async t => {
  const h = await fixture(); t.after(h.close); const old = defaultWorkerSettings(); old.profiles.review.model = "custom"; await h.bb.storage.kv.set(WORKER_PROFILE_KEY, old);
  const next = await readNamedWorkerSettings(h.bb); assert.equal(next.profiles.find(p => p.name === "review")!.model, "custom"); assert.equal(next.defaultProfile, "implement");
  assert.deepEqual(await h.bb.storage.kv.get(WORKER_PROFILE_KEY), old); assert.equal(await h.bb.storage.kv.get(NAMED_WORKER_PROFILE_KEY), undefined);
  for (let i = 0; i < 15; i++) h.db.prepare("INSERT INTO session_events(session_id,ts,kind,payload) VALUES ('conversation',?,'user',?)").run(i, JSON.stringify({ text: "x".repeat(500) }));
  const context = await h.start() as Any; assert.ok(context.recentTurns.length <= 12); assert.ok(context.recentTurns.reduce((n: number, r: Any) => n + r.text.length, 0) <= 2000);
});


test("append-only migration upgrades a database copy with old tables and a running worker", async t => {
  const { bb, harness } = createFakePluginHost({ pluginId: "voice-mode" }); t.after(() => harness.lifecycle.dispose());
  const source = bb.storage.database();
  const common = [...legacyMigrations,
    `CREATE TABLE IF NOT EXISTS voice_call_control (
      slot INTEGER PRIMARY KEY CHECK (slot = 1),
      sequence INTEGER NOT NULL,
      nonce TEXT
    )`,
    `INSERT OR IGNORE INTO voice_call_control (slot, sequence, nonce) VALUES (1, 0, NULL)`,
    `CREATE TABLE IF NOT EXISTS prompt_proposals (
      slot INTEGER PRIMARY KEY CHECK (slot = 1),
      id TEXT NOT NULL,
      content TEXT NOT NULL,
      reason TEXT NOT NULL
    )`, ...CONVERSATION_HISTORY_MIGRATIONS, ...UI_COMMAND_MIGRATIONS, ...QUICK_ACTION_MIGRATIONS];
  const old = [...common, ...SEQUENCE_MIGRATIONS, ...MESSAGE_SEND_MIGRATIONS, ...LIVE_ACTION_MIGRATIONS, ...UTTERANCE_EFFECT_MIGRATIONS, ...PROMPT_MIGRATIONS];
  bb.storage.migrate(source, old);
  source.prepare("INSERT INTO session_events(session_id, ts, kind, payload) VALUES ('old-call', 1, 'user', ?)").run(JSON.stringify({text:"Keep this"}));
  source.prepare("INSERT INTO prompt_versions(ts,source,content) VALUES (1,'user','Keep this prompt')").run();
  source.prepare("INSERT INTO voice_workers(request_id,step,conversation_id,thread_id,project_id,host_id,role,model,title,status,created_at,updated_at) VALUES ('old-request',0,'old','old-worker','app','mac','review','saved-model','Running worker','running',1,1)").run();
  const copy = new Database(source.serialize()); t.after(() => copy.close());
  const tables = (source.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[]).map(r=>r.name);
  const before = new Map(tables.map(name=>[name,source.prepare(`SELECT * FROM "${name}"`).all()]));
  bb.storage.migrate(copy, [...common, ...voiceFeatureMigrations(copy, common.length)]);
  for (const name of tables.filter(n=>n!=="_bb_migrations")) assert.deepEqual(copy.prepare(`SELECT * FROM "${name}"`).all(),before.get(name),name);
  assert.deepEqual(copy.prepare("SELECT * FROM _bb_migrations WHERE id < ? ORDER BY id").all(old.length),before.get("_bb_migrations"));
  for (const name of ["voice_operations","voice_watches","voice_tasks","voice_inbox","voice_offers"]) assert.ok(copy.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  bb.storage.migrate(copy, old);
  assert.equal((copy.prepare("SELECT status FROM voice_workers").get() as Any).status,"running");
  assert.equal(source.prepare("SELECT 1 FROM sqlite_master WHERE name='voice_operations'").get(),undefined,"source copy was not changed");
});

test("server registers live RPCs alongside legacy handlers", async t => {
  const { bb, harness } = createFakePluginHost({pluginId:"voice-mode",sdk:{threads:{list:async()=>[]}} as Any}); t.after(()=>harness.lifecycle.dispose());
  await plugin(bb);
  const db=bb.storage.database(); db.prepare("UPDATE voice_call_control SET nonce='new' WHERE slot=1").run();
  db.prepare("INSERT INTO voice_conversation_calls(call_id,conversation_id) VALUES ('new','conversation')").run();
  const context = await harness.behavior.callRpc("callStartContext",{nonce:"new",conversationId:"conversation"}) as Any;
  assert.equal(context.type,"call_start_context");
  assert.deepEqual((await harness.behavior.callRpc("listLiveTasks",{nonce:"new",conversationId:"conversation"}) as Any).items,[]);
  const invalid=await harness.behavior.callRpc("runTool",{nonce:"old",conversationId:"conversation",utterance:null,responseOrigin:"background",tool:"end_call",args:{}}) as Any;
  assert.match(invalid.error,/Not authorized/);
  await assert.rejects(harness.behavior.callRpc("reportDrain",{nonce:"old",responseId:"r",at:Date.now()}),/Not authorized/);
});

test("concurrent confirmations consume an archive preview only once", async t => {
  const h=await fixture();t.after(h.close);const preview=await h.run("prepare_archive",{thread_ids:["build"]});h.drain();
  const results=await Promise.all([h.run("archive_threads",{preview_id:preview.previewId},h.later("a")),h.run("archive_threads",{preview_id:preview.previewId},h.later("b"))]);
  assert.equal(results.filter(r=>r.status==="succeeded").length,1);assert.equal(h.world.archives.length,1);
});

test("dispatch callbacks before send returns are matched after the receipt write", async t => {
  const h=await fixture();t.after(h.close);let dispatched:Promise<void>|undefined;
  h.world.send=async()=>{dispatched=h.runtime.watches.event("message.dispatched",{entry:{id:"q-fast",threadId:"build"} as Any});return {delivery:"queued",queuedMessage:{id:"q-fast"}};};
  const sent=await h.run("message_thread",message);await dispatched;
  assert.equal(h.runtime.operations.get(sent.operationId)!.status,"running");
});

test("a slow parallel read cannot use a drain before its result was returned", async t => {
  const h=await fixture();t.after(h.close);h.approval();h.world.threads.set("slow",makeThreadResponse({id:"slow",title:"Slow"}));
  let release:()=>void=()=>{};const wait=new Promise<void>(resolve=>release=resolve);
  h.world.get=async({threadId})=>{if(threadId==="slow")await wait;return h.world.threads.get(threadId);};
  const read=h.run("read_threads",{thread_ids:["build","slow"],what:"status"});
  await new Promise(resolve=>setImmediate(resolve));h.drain();release();await read;
  const result=await h.run("answer_interaction",{thread_id:"build",interaction_id:"approval",decision:"allow_once"},h.later());
  assert.match(result.error,/not been spoken/);
});

test("critical defer reoffers after the next exchange and resolved native items disappear", async t => {
  const h=await fixture();t.after(h.close);await h.watch();const approval=h.approval();
  await h.runtime.watches.event("interaction.pending",{thread:h.world.threads.get("build"),interaction:approval as Any});
  const batch=await h.runtime.nextUpdateBatch({nonce:"call"}) as Any;
  h.runtime.closeOffer({nonce:"call",offerId:batch.offerId,outcome:"deferred"});
  assert.equal(await h.runtime.nextUpdateBatch({nonce:"call"}),null);
  h.runtime.finishUserExchange({nonce:"call",utteranceId:"next"});
  const retry=await h.runtime.nextUpdateBatch({nonce:"call"}) as Any;assert.ok(retry);
  h.runtime.closeOffer({nonce:"call",offerId:retry.offerId,outcome:"dismissed"});
  approval.status="resolved";
  await h.run("read_threads",{thread_ids:["build"],what:"updates"});
  assert.equal(await h.runtime.nextUpdateBatch({nonce:"call"}),null);
  assert.equal(h.runtime.store.inbox("conversation")[0].status,"resolved");
});

test("restart returns an open offer to queued and preserves offered_before", async t => {
  const h=await fixture();t.after(h.close);await h.watch();await h.idle();
  const batch=await h.runtime.nextUpdateBatch({nonce:"call"}) as Any;await h.restart();
  assert.equal(h.runtime.watches.offer(batch.offerId)!.outcome,"not_delivered");
  const retry=await h.runtime.nextUpdateBatch({nonce:"call"}) as Any;assert.equal(retry.items[0].offered_before,true);assert.equal(retry.items[0].offer_count,1);
});

test("recovery matches a queued send dispatched while the plugin was down", async t => {
  const h=await fixture();t.after(h.close);h.world.send=async()=>({delivery:"queued",queuedMessage:{id:"q"}});
  const sent=await h.run("message_thread",message);
  h.world.events.set("build",[{seq:1,type:"item/started",createdAt:h.tick(),data:{item:{id:"native-user",type:"userMessage",content:[{type:"text",text:"Check the build\nSpoken request: Please check the build"}]}}}]);
  await h.restart();assert.equal(h.runtime.operations.get(sent.operationId)!.status,"running");
  await h.idle();assert.match(h.runtime.store.inbox("conversation").at(-1)!.detail,/included your message/);
});

test("events without a watch are ignored and a later result resolves a failure", async t => {
  const h=await fixture();t.after(h.close);await h.idle();assert.equal(h.runtime.store.inbox("conversation").length,0);
  await h.watch();const thread=h.world.threads.get("build");thread.status="error";thread.updatedAt=h.tick();
  await h.runtime.watches.event("thread.failed",{thread,error:"Build failed"});
  const batch=await h.runtime.nextUpdateBatch({nonce:"call"}) as Any;assert.equal(batch.items[0].kind,"failed");
  h.runtime.closeOffer({nonce:"call",offerId:batch.offerId,outcome:"deferred"});await h.idle("build","Fixed");
  assert.equal(h.runtime.store.inbox("conversation").find(i=>i.kind==="failed")!.status,"resolved");
});

test("failed worker launch and unavailable models cannot silently substitute", async t => {
  const h=await fixture();t.after(h.close);const settings=defaultWorkerSettings();settings.profiles.investigate.model="unavailable";await h.bb.storage.kv.set(WORKER_PROFILE_KEY,settings);
  const missing=await h.run("spawn_worker",worker);assert.match(missing.error,/unavailable/);assert.equal(h.world.spawns.length,0);
  settings.profiles.investigate.model=null;await h.bb.storage.kv.set(WORKER_PROFILE_KEY,settings);
  h.world.spawn=async()=>{throw new Error("Spawn refused");};const failed=await h.run("spawn_worker",worker,{occurrence:1});
  assert.equal(failed.status,"failed");assert.equal(h.runtime.store.tasks()[0].status,"failed");
});

test("call replacement during target lookup prevents the SDK mutation", async t => {
  const h=await fixture();t.after(h.close);let release:()=>void=()=>{};const wait=new Promise<void>(resolve=>release=resolve);let first=true;
  h.world.get=async({threadId})=>{if(first){first=false;await wait;}return h.world.threads.get(threadId);};
  const send=h.run("message_thread",message);await new Promise(resolve=>setImmediate(resolve));await h.switch();release();
  const result=await send;assert.match(result.error,/stopped or replaced/);assert.equal(h.world.sends.length,0);
});

test("recovery preserves each missed turn and its own output, including failures", async t => {
  const h=await fixture();t.after(h.close);await h.watch();
  h.world.events.set("build",[
    {seq:1,type:"item/completed",createdAt:h.tick(),data:{item:{id:"a",type:"agentMessage",text:"First evidence"}}},
    {seq:2,type:"turn/completed",createdAt:h.tick(),data:{status:"completed"}},
    {seq:3,type:"item/completed",createdAt:h.tick(),data:{item:{id:"b",type:"agentMessage",text:"Second evidence"}}},
    {seq:4,type:"turn/completed",createdAt:h.tick(),data:{status:"failed",error:{message:"Second turn failed"}}},
  ]);
  h.world.outputs.set("build","A new turn is running");await h.restart();
  const items=h.runtime.store.inbox("conversation");assert.equal(items.length,2);
  assert.match(items.find(i=>i.kind==="result")!.detail,/First evidence/);assert.match(items.find(i=>i.kind==="failed")!.detail,/Second evidence/);
  assert.ok(items.every(i=>!i.detail.includes("new turn is running")));await h.restart();assert.equal(h.runtime.store.inbox("conversation").length,2);
});

test("a timed-out spawn stays unknown and occupies worker capacity", async t => {
  const h=await fixture();t.after(h.close);const settings=defaultWorkerSettings();settings.maxActiveWorkers=1;await h.bb.storage.kv.set(WORKER_PROFILE_KEY,settings);
  h.world.spawn=async()=>new Promise(()=>{});const first=await h.run("spawn_worker",worker);assert.equal(first.status,"unknown");
  assert.equal(h.runtime.store.tasks()[0].status,"unknown");await h.restart();
  const second=await h.run("spawn_worker",{...worker,title:"Another"},h.later());assert.match(second.error,/limit of 1/);assert.equal(h.world.spawns.length,1);
});

test("offer delivery accepts the documented shape after a natural drain", async t => {
  const h=await fixture();t.after(h.close);await h.watch();await h.idle();const batch=await h.runtime.nextUpdateBatch({nonce:"call"}) as Any;
  h.drain();assert.deepEqual(h.runtime.closeOffer({nonce:"call",offerId:batch.offerId,outcome:"delivered"}),{closed:true});
  assert.equal(h.runtime.watches.offer(batch.offerId)!.response_id,"r1");
});


test("worker quota refresh releases finished muted workers without re-enabling their watch", async t => {
  const h=await fixture();t.after(h.close);const settings=defaultWorkerSettings();settings.maxActiveWorkers=1;await h.bb.storage.kv.set(WORKER_PROFILE_KEY,settings);
  await h.run("spawn_worker",worker);await h.run("subscriptions",{op:"unsubscribe",thread_id:"worker-1"});await h.idle("worker-1","Done");
  const next=await h.run("spawn_worker",{...worker,title:"Next"},h.later());assert.equal(next.status,"running");assert.equal(h.world.spawns.length,2);
  assert.equal(h.runtime.store.watches().find(w=>w.thread_id==="worker-1")!.state,"disabled");assert.equal(h.runtime.store.inbox("conversation").length,0);
});

test("an unknown effect cannot be retried through another tool in the same utterance", async t => {
  const h=await fixture();t.after(h.close);h.world.spawn=async()=>{throw new Error("ETIMEDOUT");};
  const unknown=await h.run("spawn_worker",worker);assert.equal(unknown.status,"unknown");
  assert.deepEqual(await h.run("spawn_worker",worker),unknown);
  const retry=await h.run("create_thread",{project_id:"app",title:worker.title,body:worker.task});assert.match(retry.error,/unknown effect/);assert.equal(h.world.spawns.length,1);
});

test("find_targets ranks title matches with scores and merges bounded SDK search results",async t=>{
  const h=await fixture();t.after(h.close);
  h.world.threads.set("editor",makeThreadResponse({id:"editor",title:"Editor mobile fixes",updatedAt:12000}));
  h.world.threads.set("other",makeThreadResponse({id:"other",title:"Mobile API fixes",updatedAt:13000}));
  const searched=makeThreadResponse({id:"remote-editor",title:"Mobile editor notes",updatedAt:14000});
  const queries:string[]=[];
  h.harness.inspection.sdk.stub("threads.search",async({query}:Any)=>{queries.push(query);return {matches:{total:2,results:[{thread:searched}]}};});
  const result=await h.run("find_targets",{query:"the latest editor mobile thread"});
  assert.deepEqual(result.threads.map((thread:Any)=>[thread.id,thread.match]),[["remote-editor",1],["editor",1],["other",0.5]]);
  assert.equal(result.threads[0].foundInMessages,true);assert.equal(result.threads[1].foundInMessages,undefined);
  assert.deepEqual(queries,["the latest editor mobile thread"]);
  assert.deepEqual(result.searched.words,["editor","mobile"]);
  assert.equal(result.truncated,true);
  const recent=await h.run("find_targets",{query:"the latest threads"});
  assert.deepEqual(recent.threads.map((thread:Any)=>thread.id),["other","editor","build"]);
  assert.equal(recent.threads[2].projectName,"BB Plugins");
  assert.deepEqual(queries,["the latest editor mobile thread"]);
});

test("find_targets resolves misheard descriptions, keeps near misses, and always ranks projects",async t=>{
  const h=await fixture();t.after(h.close);
  h.world.threads.set("parent",makeThreadResponse({id:"parent",title:"Overhaul well plans plugin",updatedAt:15000}));
  h.world.threads.set("child",makeThreadResponse({id:"child",title:"Live plan review trial",parentThreadId:"parent",createdAt:15500,updatedAt:16000}));
  h.world.threads.set("older",makeThreadResponse({id:"older",title:"Plans live review: backend",parentThreadId:"parent",createdAt:13000,updatedAt:17500}));
  h.world.threads.set("voice",makeThreadResponse({id:"voice",title:"Make voice mode more reliable",updatedAt:17000}));
  const spoken=await h.run("find_targets",{query:"planned plugin child thread for new plans feature",include_children:true});
  assert.deepEqual(spoken.threads.map((thread:Any)=>[thread.id,thread.match]),[["parent",0.71],["older",0.46],["child",0.45]]);
  const children=await h.run("find_targets",{query:"",parent_id:"parent"});
  assert.deepEqual(children.threads.map((thread:Any)=>[thread.id,thread.createdAt]),[["child",15500],["older",13000]]);
  assert.equal(children.searched.parentId,"parent");
  const active=await h.run("find_targets",{query:"",include_children:true});
  assert.deepEqual(active.threads.slice(0,2).map((thread:Any)=>thread.id),["older","voice"]);
  const project=await h.run("find_targets",{query:"BB plugin project"});
  assert.deepEqual(project.projects.map((p:Any)=>[p.name,p.match,p.outsideProject]),[["BB Plugins",0.95,false],["Personal",0,true],["docs-site",0,false]]);
  assert.deepEqual(project.threads.map((thread:Any)=>thread.id),["parent"]);
  const spelled=await h.run("find_targets",{query:"BB_plugins"});
  assert.equal(spelled.projects[0].name,"BB Plugins");assert.equal(spelled.projects[0].match,1);
});

test("workers run outside any project on the primary machine unless a project is given",async t=>{
  const h=await fixture();t.after(h.close);
  const receipt=await h.run("spawn_worker",{title:"Find the plans child thread",task:"Find the parent and its newest child."});
  assert.equal(receipt.status,"running");assert.equal(receipt.profile,"implement");assert.equal(receipt.outsideProject,true);
  assert.equal(receipt.projectId,"proj_personal");assert.equal(receipt.hostId,"mac");assert.equal(receipt.hostName,"Desktop");
  const spawn=h.world.spawns.at(-1);
  assert.deepEqual(spawn.environment,{type:"host",hostId:"mac",workspace:{type:"personal"}});
  assert.equal(spawn.projectId,"proj_personal");assert.equal(spawn.visibility,"hidden");
  assert.match(spawn.prompt,/## Profile: implement/);
  const explicit=await h.run("spawn_worker",{title:"Elsewhere",task:"Look around.",host_id:"laptop"},h.later());
  assert.equal(explicit.hostId,"laptop");
  const inProject=await h.run("spawn_worker",{...worker,title:"In project"},h.later("u3"));
  assert.equal(inProject.outsideProject,false);assert.deepEqual(h.world.spawns.at(-1).environment,{type:"host",hostId:"mac",workspace:{type:"managed-worktree",baseBranch:{kind:"default"}}});
  const created=await h.run("create_thread",{title:"Visible",body:"Do it"} as Any,h.later("u4"));
  assert.match(created.error,/project_id/);
});

test("worker profiles resolve leniently and unknown names list the configured choices",async t=>{
  const h=await fixture();t.after(h.close);
  const first=await h.run("spawn_worker",{...worker,profile:"default"});assert.equal(first.profile,"implement");
  const settings=await readNamedWorkerSettings(h.bb);settings.profiles.push({...settings.profiles[0],name:"default"});await h.bb.storage.kv.set(NAMED_WORKER_PROFILE_KEY,settings);
  const named=await h.run("spawn_worker",{...worker,profile:"Default",title:"Named default"},h.later("u0"));assert.equal(named.profile,"default");
  settings.profiles.pop();await h.bb.storage.kv.set(NAMED_WORKER_PROFILE_KEY,settings);
  const second=await h.run("spawn_worker",{...worker,profile:"Investigation",title:"Second"},h.later());assert.equal(second.profile,"investigate");
  assert.match(second.hostId,/mac/);assert.match(h.world.spawns.at(-1).prompt,/## Profile: investigate/);
  const unknown=await h.run("spawn_worker",{...worker,profile:"wizard",title:"Third"},h.later("u3"));
  assert.equal(unknown.status,"failed");assert.match(unknown.error,/Unknown worker profile "wizard". Configured profiles: investigate, plan, implement, review. Omit profile for implement./);
  assert.equal(h.world.spawns.length,3);
});

test("call tool schemas enumerate configured profiles",()=>{
  const bare=liveToolSchemas().find(tool=>tool.name==="spawn_worker")!;
  assert.deepEqual((bare.parameters as Any).required,["title","task"]);
  const profiles=[{name:"investigate",instructions:"Gather evidence and explain causes or options. Return sources and uncertainties. Do not implement."},{name:"implement",instructions:"Make the change."}];
  const shown=liveToolSchemas({profiles,defaultProfile:"implement"}).find(tool=>tool.name==="spawn_worker")!;
  assert.deepEqual((shown.parameters as Any).properties.profile.enum,["investigate","implement"]);
  assert.deepEqual((shown.parameters as Any).required,["title","task"]);
  assert.match(shown.description,/Profiles: investigate \(Gather evidence and explain causes or options\. Return sources and uncertainties\. Do not\.\.\.\); implement \(Make the change\.\)\. Default: implement\.$/);
  assert.equal(liveToolSchemas({profiles,defaultProfile:"missing"}).find(tool=>tool.name==="spawn_worker")!.description.endsWith("Default: investigate."),true);
});

test("client file previews resolve the thread workspace into a native UI action",async t=>{
  const h=await fixture();t.after(h.close);
  h.world.threads.get("build").environmentId="workspace";
  const result=await h.runtime.beginClientEffect(h.input("control_ui",{action:"preview_file",thread_id:"build",source:"workspace",path:"README.md"})) as Any;
  assert.equal(result.execute,true);
  assert.deepEqual(result.action,{kind:"preview_file",target:{kind:"workspace",environmentId:"workspace",path:"README.md"}});
});

test("historical coordinator threads cannot be messaged or used as client effect targets",async t=>{
  const h=await fixture();t.after(h.close);
  h.db.exec("CREATE TABLE voice_conversations (id TEXT PRIMARY KEY, coordinator_thread_id TEXT); INSERT INTO voice_conversations VALUES ('history','build')");
  const result=await h.run("message_thread",message);
  assert.equal(result.status,"failed");assert.match(result.error,/historical agent threads/);assert.equal(h.world.sends.length,0);
  await assert.rejects(h.runtime.beginClientEffect(h.input("prepare_draft",{thread_id:"build",text:"Run",mode:"append"})),/historical agent threads/);
});

for (const offset of [-5000, 5000]) test(`drains use the correct clock with a ${offset} ms device offset`, async t => {
  const h = await fixture(); t.after(h.close); await h.watch();
  const preview = await h.run("prepare_archive", { thread_ids: ["build"] });
  const approval = h.approval();
  await h.runtime.watches.event("interaction.pending", { thread: h.world.threads.get("build"), interaction: approval as Any });
  const batch = await h.runtime.nextUpdateBatch({ nonce: "call" }) as Any;
  const clientAt = h.tick() + offset;
  h.runtime.reportDrain({ nonce: "call", responseId: "offset", at: clientAt });
  assert.deepEqual(h.runtime.closeOffer({ nonce: "call", offerId: batch.offerId, outcome: "delivered", responseId: "offset" }), { closed: true });
  assert.equal(h.runtime.watches.offer(batch.offerId)!.outcome, "delivered");
  const later = { utterance: { id: "after-device-drain", version: 1, text: "Yes, once", startedAt: clientAt + 1 } };
  assert.equal((await h.run("archive_threads", { preview_id: preview.previewId }, later)).status, "succeeded");
  assert.equal((await h.run("answer_interaction", { thread_id: "build", interaction_id: approval.id, decision: "allow_once" }, later)).status, "succeeded");
});

for (const outcome of ["not_delivered", "deferred", "dismissed"] as const) test(`${outcome} removes offer presentation evidence before unrelated speech`, async t => {
  const h = await fixture(); t.after(h.close); await h.watch();
  const approval = h.approval();
  await h.runtime.watches.event("interaction.pending", { thread: h.world.threads.get("build"), interaction: approval as Any });
  await h.run("read_threads", { thread_ids: ["build"], what: "updates" });
  const batch = await h.runtime.nextUpdateBatch({ nonce: "call" }) as Any;
  h.runtime.closeOffer({ nonce: "call", offerId: batch.offerId, outcome });
  const before = h.runtime.store.inbox("conversation").map(row => row.status);
  h.drain("unrelated");
  const args = { thread_id: "build", interaction_id: approval.id, decision: "allow_once" };
  assert.match((await h.run("answer_interaction", args, h.later("unrelated-yes"))).error, /not been spoken/);
  assert.equal(h.world.resolutions.length, 0);
  assert.deepEqual(h.runtime.store.inbox("conversation").map(row => row.status), before);
  await h.run("read_threads", { thread_ids: ["build"], what: "status" }); h.drain("explained");
  assert.equal((await h.run("answer_interaction", args, h.later("explained-yes"))).status, "succeeded");
});

test("new child watches begin at the latest event and report only current output", async t => {
  const h = await fixture(); t.after(h.close); await h.watch();
  h.world.threads.set("child", makeThreadResponse({ id: "child", title: "Child", projectId: "app", parentThreadId: "build", status: "active" }));
  h.world.events.set("child", [1, 2, 3].map(seq => ({ seq, type: "turn/completed", createdAt: seq, data: { status: "completed" } })));
  await h.idle("child", "New result");
  assert.equal(h.runtime.store.watches().find(w => w.thread_id === "child")!.cursor_seq, 4);
  assert.equal(h.runtime.store.inbox("conversation").length, 1);
  assert.match(h.runtime.store.inbox("conversation")[0].detail, /New result/);
  await h.runtime.watches.recover();
  assert.equal(h.runtime.store.inbox("conversation").length, 1);
  await h.idle("child", "Next result");
  assert.equal(h.runtime.store.inbox("conversation").length, 2);
});

test("recovery records untracked children silently and skips archived ones", async t => {
  const h = await fixture(); t.after(h.close); await h.watch();
  // Children that existed before the watch was ever reconciled: one idle with output, one archived.
  h.world.threads.set("old-child", makeThreadResponse({ id: "old-child", title: "Old child", projectId: "app", parentThreadId: "build", status: "idle", updatedAt: 500 }));
  h.world.outputs.set("old-child", "Old result");
  h.world.events.set("old-child", [{ seq: 7, type: "turn/completed", createdAt: 1, data: { status: "completed" } }]);
  h.world.threads.set("gone-child", makeThreadResponse({ id: "gone-child", title: "Gone child", projectId: "app", parentThreadId: "build", status: "idle", updatedAt: 600 }));
  h.world.threads.get("gone-child").archivedAt = 650;
  await h.runtime.watches.recover();
  const watched = h.runtime.store.watches().map(w => w.thread_id).sort();
  assert.deepEqual(watched, ["build", "old-child"]);
  assert.equal(h.runtime.store.watches().find(w => w.thread_id === "old-child")!.last_status, "idle");
  assert.equal(h.runtime.store.inbox("conversation").length, 0);
  // A later change on the discovered child is still reported.
  await h.idle("old-child", "Next result");
  assert.equal(h.runtime.store.inbox("conversation").length, 1);
  assert.match(h.runtime.store.inbox("conversation")[0].detail, /Next result/);
});

test("background end_call is refused while an explicit user end_call remains available", async t => {
  const h = await fixture(); t.after(h.close);
  assert.match((await h.run("end_call", {}, { responseOrigin: "background", utterance: null })).error, /background updates cannot act/);
  assert.deepEqual(await h.run("end_call", {}), { action: "end_call", afterDrain: true });
});

test("archive preview rejects every unreturned ID before reading its scope", async t => {
  const h = await fixture(); t.after(h.close);
  h.world.threads.set("unreturned", makeThreadResponse({ id: "unreturned", title: "Unreturned", projectId: "app" }));
  const reads: string[] = [];
  h.world.get = async ({ threadId }) => { reads.push(threadId); return h.world.threads.get(threadId); };
  assert.match((await h.run("prepare_archive", { thread_ids: ["build", "unreturned"] })).error, /unknown target ID/);
  assert.deepEqual(reads, []);
  await h.run("find_targets", { query: "Unreturned" });
  assert.ok((await h.run("prepare_archive", { thread_ids: ["build", "unreturned"] })).previewId);
});

test("dispatch uses arrival time even when recovery holds the serial queue", async t => {
  const h = await fixture(); t.after(h.close);
  h.world.send = async () => ({ delivery: "queued", queuedMessage: { id: "delayed" } });
  const operation = await h.run("message_thread", message);
  let release!: () => void;
  const barrier = h.runtime.watches.serial(() => new Promise<void>(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const dispatchAt = h.tick();
  const dispatched = h.runtime.watches.event("message.dispatched", { entry: { id: "delayed", threadId: "build" } as Any });
  const ended = h.idle("build", "Reply to your message");
  h.tick(1000); release(); await Promise.all([barrier, dispatched, ended]);
  const row = h.runtime.operations.get(operation.operationId)!;
  assert.equal(row.dispatched_at, dispatchAt); assert.equal(row.status, "succeeded");
  assert.match(h.runtime.store.inbox("conversation").at(-1)!.detail, /included your message/);
});

test("defer uses the most recent completed exchange even if it ran no tools", async t => {
  const h = await fixture(); t.after(h.close); await h.watch(); await h.idle();
  h.runtime.finishUserExchange({ nonce: "call", utteranceId: "pure-conversation" });
  const batch = await h.runtime.nextUpdateBatch({ nonce: "call" }) as Any;
  h.runtime.closeOffer({ nonce: "call", offerId: batch.offerId, outcome: "deferred" });
  assert.equal((h.runtime as Any).call.deferredAfter.get(batch.items[0].id), "pure-conversation");
  h.runtime.finishUserExchange({ nonce: "call", utteranceId: "pure-conversation" });
  assert.equal(await h.runtime.nextUpdateBatch({ nonce: "call" }), null);
  h.runtime.finishUserExchange({ nonce: "call", utteranceId: "next-conversation" });
  assert.ok(await h.runtime.nextUpdateBatch({ nonce: "call" }));
});

test("an idle event reconciles an unknown send before correlating its answer", async t => {
  const h = await fixture(); t.after(h.close);
  h.world.send = async () => { throw new Error("SDK timeout"); };
  const unknown = await h.run("message_thread", message);
  assert.equal(unknown.status, "unknown");
  h.world.events.set("build", [{ seq: 1, type: "item/started", createdAt: h.tick(), data: { item: {
    id: "native-message", type: "userMessage", content: [{ type: "text", text: "Check the build\nSpoken request: Please check the build" }],
  } } }]);
  await h.idle("build", "Your requested answer");
  assert.equal(h.runtime.operations.get(unknown.operationId)!.status, "succeeded");
  assert.match(h.runtime.store.inbox("conversation").at(-1)!.detail, /included your message/);
  assert.equal(h.world.sends.length, 1);
});

test("quiet polls with no eligible inbox item do not refresh interactions", async t => {
  const h = await fixture(); t.after(h.close); await h.watch(); const approval = h.approval();
  await h.runtime.watches.event("interaction.pending", { thread: h.world.threads.get("build"), interaction: approval as Any });
  const batch = await h.runtime.nextUpdateBatch({ nonce: "call" }) as Any;
  h.runtime.closeOffer({ nonce: "call", offerId: batch.offerId, outcome: "dismissed" });
  const reads = h.world.interactionReads;
  for (let i = 0; i < 5; i++) { h.tick(2000); assert.equal(await h.runtime.nextUpdateBatch({ nonce: "call" }), null); }
  assert.equal(h.world.interactionReads, reads);
});

test("call context returns saved state while watched-thread recovery is blocked", async t => {
  const h = await fixture(); t.after(h.close); await h.watch(); await h.idle();
  const offered = await h.runtime.nextUpdateBatch({ nonce: "call" }) as Any;
  h.runtime.watches.reserveTask("pending-worker", "conversation", "worker", "Pending", "investigate");
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let reads = 0; h.world.list = async () => { reads++; await blocked; return []; };
  try {
    const nextRuntime = new LiveRuntime(h.bb, () => ({ nonce: "new-call", conversationId: "conversation" }), h.now);
    const context = await Promise.race([
      nextRuntime.callStartContext({ nonce: "new-call", conversationId: "conversation" }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Context waited for thread recovery")), 100)),
    ]) as Any;
    // The context is ready before the queued SDK work can finish.
    assert.equal(h.runtime.watches.offer(offered.offerId)!.outcome, "not_delivered");
    assert.equal(h.runtime.store.tasks().find(task => task.op_id === "pending-worker")!.status, "unknown");
    assert.equal(context.type, "call_start_context");
    assert.equal(context.tasks.find((task: Any) => task.op_id === "pending-worker").status, "unknown");
    assert.ok(reads > 0);
    release(); await nextRuntime.watches.serial(async () => {});
  } finally { release(); await h.runtime.watches.serial(async () => {}); }
});

test("startup imports legacy watches and workers once without replay or coordinator subscriptions",async t=>{
  const h=await fixture();t.after(h.close);
  const {importLegacyWatches,LEGACY_WATCH_IMPORT_KEY}=await import("./legacy-watch-import.ts");
  h.db.exec([...CONVERSATION_HISTORY_MIGRATIONS,...LIVE_ACTION_MIGRATIONS].join(";"));
  h.db.prepare("INSERT INTO voice_conversations(id,created_at,updated_at,coordinator_thread_id) VALUES ('conversation',1,1,'coord-id')").run();
  for(const [id,title,parentThreadId] of [["coord-id","Renamed coordinator",null],["coord-title","Voice coordinator old",null],["removed","Removed",null],["worker-active","Active worker","coord-id"],["worker-unknown","Unknown worker",null],["settled","Settled",null],["archived","Archived work",null]] as const)
    h.world.threads.set(id,makeThreadResponse({id,title,parentThreadId,projectId:"app",status:"active"}));
  h.world.threads.get("archived").archivedAt=5;
  h.world.threads.get("build").status="idle";h.world.outputs.set("build","Old result");
  h.world.events.set("build",[{seq:25,type:"turn/completed",createdAt:1,data:{status:"completed"}}]);
  h.world.events.set("worker-active",[{seq:9,type:"turn/completed",createdAt:1,data:{status:"completed"}}]);
  const addWatch=h.db.prepare("INSERT INTO voice_watch(conversation_id,thread_id,reason,added_at,removed_at) VALUES ('conversation',?,'legacy',1,?)");
  for(const id of ["build","coord-id","coord-title","missing","worker-active","archived"])addWatch.run(id,null);
  addWatch.run("removed",2);
  const addWorker=h.db.prepare(`INSERT INTO voice_workers(request_id,step,conversation_id,thread_id,project_id,host_id,role,model,title,status,created_at,updated_at)
    VALUES (?,0,'conversation',?,'app','mac','investigate','worker','Legacy work',?,1,1)`);
  for(const [id,thread,status] of [["active","worker-active","active"],["creating",null,"creating"],["unknown","worker-unknown","unknown"],["missing","gone","active"],["settled","settled","settled"]])addWorker.run(id,thread,status);
  const oldWatches=h.db.prepare("SELECT * FROM voice_watch").all(),oldWorkers=h.db.prepare("SELECT * FROM voice_workers").all();
  const migrations=h.db.prepare("SELECT * FROM _bb_migrations").all();
  await importLegacyWatches(h.bb,h.runtime.watches);
  assert.equal(await h.bb.storage.kv.get(LEGACY_WATCH_IMPORT_KEY),true);
  // A creating worker without a thread id is not imported: the new runtime could never resolve it and it would hold a slot.
  assert.deepEqual(h.runtime.store.tasks().map(task=>[task.op_id,task.status]).sort(),[["legacy:active:0","running"],["legacy:unknown:0","unknown"]]);
  const watched=h.runtime.store.watches();
  assert.deepEqual(watched.map(w=>w.thread_id).sort(),["build","worker-active","worker-unknown"]);
  assert.equal(watched.find(w=>w.thread_id==="build")!.cursor_seq,25);
  assert.equal(watched.find(w=>w.thread_id==="build")!.last_status,"idle");
  assert.equal(watched.find(w=>w.thread_id==="worker-active")!.root_thread_id,"worker-active");
  assert.equal(watched.find(w=>w.thread_id==="worker-active")!.cursor_seq,9);
  await h.runtime.watches.recover();assert.equal(h.runtime.store.inbox("conversation").length,0);
  assert.deepEqual(h.db.prepare("SELECT * FROM voice_watch").all(),oldWatches);
  assert.deepEqual(h.db.prepare("SELECT * FROM voice_workers").all(),oldWorkers);
  assert.deepEqual(h.db.prepare("SELECT * FROM _bb_migrations").all(),migrations);
  h.db.prepare("UPDATE voice_watches SET state='disabled' WHERE thread_id='build'").run();
  const before=h.runtime.store.watches();let reads=0;
  h.world.get=async()=>{reads++;throw new Error("Import ran twice");};
  await importLegacyWatches(h.bb,h.runtime.watches);
  assert.equal(reads,0);assert.deepEqual(h.runtime.store.watches(),before);
});

test("legacy import retries an SDK outage without marking completion",async t=>{
  const h=await fixture();t.after(h.close);
  const {importLegacyWatches,LEGACY_WATCH_IMPORT_KEY}=await import("./legacy-watch-import.ts");
  h.db.exec(CONVERSATION_HISTORY_MIGRATIONS.join(";"));
  h.db.prepare("INSERT INTO voice_watch(conversation_id,thread_id,reason,added_at) VALUES ('conversation','build','legacy',1)").run();
  h.world.get=async()=>{throw new Error("Connection unavailable");};
  await assert.rejects(importLegacyWatches(h.bb,h.runtime.watches),/Connection unavailable/);
  assert.equal(await h.bb.storage.kv.get(LEGACY_WATCH_IMPORT_KEY),undefined);
  assert.equal(h.runtime.store.watches().length,0);
  h.world.get=null;await importLegacyWatches(h.bb,h.runtime.watches);
  assert.equal(h.runtime.store.watches().length,1);
  assert.equal(await h.bb.storage.kv.get(LEGACY_WATCH_IMPORT_KEY),true);
});

test("call resume preserves historical state and omits retired update counts",async t=>{
  const h=await fixture();t.after(h.close);
  const {ConversationRecord}=await import("./conversation-record.ts");
  h.db.exec(CONVERSATION_HISTORY_MIGRATIONS.join(";"));
  const state='{"viewedThreadId":"old-view","topic":"Saved history"}';
  h.db.prepare("INSERT INTO voice_conversations(id,created_at,updated_at,call_started_at,state_json) VALUES ('conversation',1,1,1,?)").run(state);
  const record=new ConversationRecord(h.db,h.now);
  assert.deepEqual(record.startCall({nonce:"new",sequence:2,view:{threadId:"new-view",projectId:"app"},newConversation:false,conversationId:"conversation"}),{conversationId:"conversation",resumed:true});
  assert.equal((h.db.prepare("SELECT state_json FROM voice_conversations WHERE id='conversation'").get() as Any).state_json,state);
  assert.equal(record.getConversation("conversation")!.currentCallNonce,"new");
});
