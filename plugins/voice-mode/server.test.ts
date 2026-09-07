import test from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, { coordinatorToolSchemas } from "./server.ts";
import { legacyMigrations } from "./test-fixtures/legacy-migrations";

test("audio diagnostics remain stored but never appear as voice sessions", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "voice-mode" });
  try {
    await plugin(bb);
    await harness.behavior.callRpc("logEvent", { sessionId: "audio-diagnostics", kind: "client.hello", payload: {} });
    const empty = await harness.behavior.callRpc("listVoiceSessions", null) as { sessions: { id: string }[]; hasMore: boolean };
    assert.deepEqual(empty, { sessions: [], hasMore: false });
    await harness.behavior.callRpc("logEvent", { sessionId: "real-call", kind: "session.started", payload: {} });
    const result = await harness.behavior.callRpc("listVoiceSessions", null) as { sessions: { id: string }[] };
    assert.deepEqual(result.sessions.map(session => session.id), ["real-call"]);
    await assert.rejects(harness.behavior.callRpc("getVoiceSession", { sessionId: "audio-diagnostics" }), /not found/);
    const diagnostic = bb.storage.database().prepare("SELECT kind, payload FROM session_events WHERE session_id = 'audio-diagnostics'").all();
    assert.deepEqual(diagnostic, [{ kind: "client.hello", payload: "{}" }], "diagnostics remain stored without becoming sessions");
  } finally { await harness.lifecycle.dispose(); }
});

test("session history and plugin logs preserve the same actions and error details", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "voice-mode" });
  try {
    await plugin(bb);
    for (const kind of ["tool.call", "tool.result"]) await harness.behavior.callRpc("logEvent", {
      sessionId: "phone-call", kind,
      payload: { name: "focus_thread", callId: "tool-1", _id: { client: "phone", realm: "page" },
        ...(kind === "tool.result" ? { status: "error", output: "Could not open" } : { args: { thread_id: "a" } }) },
    });
    const { events } = await harness.behavior.callRpc("getVoiceSession", { sessionId: "phone-call" }) as { events: { id: number; ts: number; kind: string; payload: string; callId: string }[] };
    const logs = harness.inspection.logEntries.filter(log => log.message.includes('"sessionId":"phone-call"'));
    assert.equal(logs.length, 2);
    events.forEach(({ callId, ...event }, index) => {
      assert.equal(callId, "phone-call");
      assert.deepEqual(JSON.parse(logs[index].message), { ...event, sessionId: callId, payload: JSON.parse(event.payload) });
    });
    assert.equal(logs[1].level, "error");
    const { sessions } = await harness.behavior.callRpc("listVoiceSessions", null) as { sessions: { id: string; callIds: string[] }[] };
    assert.deepEqual(sessions.find(session => session.id === "phone-call")?.callIds, ["phone-call"]);
    assert.equal(JSON.parse(events.find(event => event.kind === "tool.result")!.payload).status, "error");
  } finally { await harness.lifecycle.dispose(); }
});

test("realtime tools expose bounded quick actions without destructive or arbitrary tools", () => {
  assert.deepEqual(coordinatorToolSchemas().map(tool => tool.name), ["lookup_targets", "quick_action", "delegate_to_coordinator", "remain_silent", "end_call"]);
});

test("obsolete view preferences are ignored without changing other saved settings", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "voice-mode" });
  try {
    await bb.storage.kv.set("config", { viewBehavior: "reuse", mobileViewBehavior: "reuse", notifications: false, voice: "cedar" });
    await plugin(bb);
    const current = await harness.behavior.callRpc("getConfig", null) as any;
    assert.equal("mobileViewBehavior" in current, false);
    assert.equal("viewBehavior" in current, false);
    assert.equal("notifications" in current, false);
    assert.equal(current.voice, "cedar");
  } finally { await harness.lifecycle.dispose(); }
});

test("concurrent settings patches preserve both changes", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "voice-mode" });
  try {
    await plugin(bb);
    await Promise.all([
      harness.behavior.callRpc("setConfig", { voice: "cedar" }),
      harness.behavior.callRpc("setConfig", { credentialPreference: "subscription" }),
    ]);
    const config = await harness.behavior.callRpc("getConfig", null) as any;
    assert.equal(config.voice, "cedar");
    assert.equal(config.credentialPreference, "subscription");
  } finally { await harness.lifecycle.dispose(); }
});

test("legacy voice tools cannot propose prompt changes; explicit settings edits still save", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "voice-mode" });
  try {
    await plugin(bb);
    await assert.rejects(harness.behavior.callRpc("runTool", { name: "update_instructions", args: {} }));
    await harness.behavior.callRpc("setPrompt",{content:"Keep replies short.",source:"user",note:"edited in settings"});
    assert.equal((await harness.behavior.callRpc("getPrompt",null) as any).content,"Keep replies short.");
  } finally { await harness.lifecycle.dispose(); }
});

test("session cursors retain older history when new sessions arrive, including timestamp ties", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "voice-mode" });
  try {
    await plugin(bb);
    const db = bb.storage.database();
    const insert = db.prepare("INSERT INTO session_events (session_id, ts, kind, payload) VALUES (?, ?, 'session.started', '{}')");
    for (let i = 0; i < 65; i++) insert.run(`session-${String(i).padStart(3, "0")}`, 1000);
    const first = await harness.behavior.callRpc("listVoiceSessions", null) as any;
    insert.run("new-session", 2000);
    const before = first.sessions.at(-1);
    const second = await harness.behavior.callRpc("listVoiceSessions", { before: { updatedAt: before.updatedAt, id: before.id } }) as any;
    const last = second.sessions.at(-1);
    const third = await harness.behavior.callRpc("listVoiceSessions", { before: { updatedAt: last.updatedAt, id: last.id } }) as any;
    assert.equal(new Set([...first.sessions, ...second.sessions, ...third.sessions].map((row: any) => row.id)).size, 65);
    assert.equal(third.hasMore, false);
  } finally { await harness.lifecycle.dispose(); }
});

test("event logging rejects oversized payloads", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "voice-mode" });
  try {
    await plugin(bb);
    await assert.rejects(harness.behavior.callRpc("logEvent", { sessionId: "call", kind: "user", payload: { text: "x".repeat(65536) } }), /input validation/);
    assert.deepEqual((await harness.behavior.callRpc("listVoiceSessions", null) as any).sessions, []);
  } finally { await harness.lifecycle.dispose(); }
});


test("full event storage rejects new logs but still sends stop controls", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "voice-mode" });
  try {
    const db = bb.storage.database();
    db.exec("CREATE TABLE session_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL)");
    // Simulate retained history before plugin startup so the quota is rebuilt.
    db.prepare("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 100000) INSERT INTO session_events(session_id,ts,kind,payload) SELECT 'old', x, 'user', '{}' FROM n").run();
    await plugin(bb);
    await assert.rejects(harness.behavior.callRpc("logEvent", { sessionId: "call", kind: "user", payload: {} }), /storage is full/);
    await harness.behavior.callRpc("forceStop", { nonce: "call" });
    assert.ok(harness.inspection.realtimeSignals.some(signal => signal.channel === "voice-command"));
  } finally { await harness.lifecycle.dispose(); }
});

test("newest call claim wins and CLI stop remains authoritative for a frozen owner", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "voice-mode" });
  try {
    await plugin(bb);
    const first = await harness.behavior.callRpc("claimCall", { nonce: "a" }) as any;
    const second = await harness.behavior.callRpc("claimCall", { nonce: "b" }) as any;
    assert.ok(second.sequence > first.sequence);
    await assert.rejects(harness.behavior.callRpc("createCall", { nonce: "a", sdp: "offer", threadId: null, projectId: null }), /stopped or replaced/);
    const stopped = await harness.behavior.runCli(["stop"]);
    assert.equal(stopped.exitCode, 0);
    const history = await harness.behavior.callRpc("getVoiceSession", { sessionId: "b" }) as any;
    assert.ok(history.events.some((event: any) => event.kind === "session.stopped"));
    await assert.rejects(harness.behavior.callRpc("createCall", { nonce: "b", sdp: "offer", threadId: null, projectId: null }), /stopped or replaced/);
    const startSignals = harness.inspection.realtimeSignals.length;
    // A frozen owner's heartbeat cannot resurrect a stopped call when it wakes.
    await harness.behavior.callRpc("publishPresence", { nonce: "b", phase: "live", startedAt: 1000 });
    const signals = harness.inspection.realtimeSignals.slice(startSignals);
    assert.equal(signals.some(signal => signal.channel === "voice-presence"), false);
    assert.ok(signals.some(signal => signal.channel === "voice-command"));
  } finally { await harness.lifecycle.dispose(); }
});


test("upgrade from the original five migrations preserves saved prompts and adds call control", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "voice-mode" });
  try {
    const db = bb.storage.database();
    bb.storage.migrate(db, legacyMigrations);
    db.prepare("INSERT INTO prompt_versions (ts, source, content) VALUES (1, 'user', 'Keep my prompt')").run();
    const historicalPayload = JSON.stringify({ text: "Original voice words", detail: "preserve exactly" });
    db.prepare("INSERT INTO session_events (session_id, ts, kind, payload) VALUES ('old-call', 10, 'user', ?)").run(historicalPayload);
    await plugin(bb);
    assert.equal((await harness.behavior.callRpc("getPrompt", null) as any).content, "Keep my prompt");
    const history = await harness.behavior.callRpc("getVoiceSession", { sessionId: "old-call" }) as any;
    assert.equal(history.session.legacy, true);
    assert.equal(history.session.title, "Original voice words");
    assert.equal(history.events[0].payload, historicalPayload);
    assert.equal(history.events[0].callId, "old-call");
    assert.equal((await harness.behavior.callRpc("claimCall", { nonce: "new" }) as any).sequence, 1);
  } finally { await harness.lifecycle.dispose(); }
});
