import test from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin, { toolSchemas, threadViewInstructions } from "./server.ts";
import { legacyMigrations } from "./test-fixtures/legacy-migrations";

test("audio diagnostics stay readable but never appear as voice sessions", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "voice-mode" });
  try {
    await plugin(bb);
    await harness.behavior.callRpc("logEvent", { sessionId: "audio-diagnostics", kind: "client.hello", payload: {} });
    const empty = await harness.behavior.callRpc("listSessions", null) as { sessions: { id: string }[]; hasMore: boolean };
    assert.deepEqual(empty, { sessions: [], hasMore: false });
    await harness.behavior.callRpc("logEvent", { sessionId: "real-call", kind: "session.started", payload: {} });
    const result = await harness.behavior.callRpc("listSessions", null) as { sessions: { id: string }[] };
    assert.deepEqual(result.sessions.map(session => session.id), ["real-call"]);
    const diagnostic = await harness.behavior.callRpc("getSessionEvents", { sessionId: "audio-diagnostics" }) as { events: unknown[] };
    assert.equal(diagnostic.events.length, 1);
  } finally { await harness.lifecycle.dispose(); }
});

test("session history and plugin logs describe the same stored action, and failed tools mark sessions", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "voice-mode" });
  try {
    await plugin(bb);
    for (const kind of ["tool.call", "tool.result"]) await harness.behavior.callRpc("logEvent", {
      sessionId: "phone-call", kind,
      payload: { name: "focus_thread", callId: "tool-1", _id: { client: "phone", realm: "page" },
        ...(kind === "tool.result" ? { status: "error", output: "Could not open" } : { args: { thread_id: "a" } }) },
    });
    const { events } = await harness.behavior.callRpc("getSessionEvents", { sessionId: "phone-call" }) as { events: { id: number; ts: number; kind: string; payload: string }[] };
    const logs = harness.inspection.logEntries.filter(log => log.message.includes('"sessionId":"phone-call"'));
    assert.equal(logs.length, 2);
    events.forEach((event, index) => assert.deepEqual(JSON.parse(logs[index].message), {
      ...event, sessionId: "phone-call", payload: JSON.parse(event.payload),
    }));
    assert.equal(logs[1].level, "error");
    const { sessions } = await harness.behavior.callRpc("listSessions", null) as { sessions: { id: string; hasError: boolean }[] };
    assert.equal(sessions.find(session => session.id === "phone-call")?.hasError, true);
  } finally { await harness.lifecycle.dispose(); }
});

test("thread metadata is resolved once per ID and the saved preference applies immediately", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "voice-mode", sdk: {
    threads: { get: async ({ threadId }) => makeThreadResponse({ id: threadId, title: `Title ${threadId}`, projectId: "project" }) },
  } });
  try {
    await plugin(bb);
    let result = await harness.behavior.callRpc("resolveThreadViews", { threadIds: ["a", "b", "a"] }) as any;
    assert.equal(result.preference, "reuse");
    assert.deepEqual(result.views.map((view: any) => view.id), ["thread:a", "thread:b"]);
    assert.equal(harness.inspection.sdk.callsTo("threads.get").length, 2);
    const saved = await harness.behavior.callRpc("runTool", {
      name: "set_view_behavior", args: { behavior: "new" }, threadId: null, projectId: null,
    }) as any;
    assert.equal(saved.status, "success");
    result = await harness.behavior.callRpc("resolveThreadViews", { threadIds: ["a"] }) as any;
    assert.equal(result.preference, "new");
    assert.ok(harness.inspection.realtimeSignals.some(signal => signal.channel === "config-changed"));
    await assert.rejects(harness.behavior.callRpc("resolveThreadViews", { threadIds: [] }));
  } finally { await harness.lifecycle.dispose(); }
});

test("server tool failures carry explicit status and do not create a separate server-only action log", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "voice-mode", sdk: {
    threads: { get: async () => { throw new Error("Thread was deleted"); } },
  } });
  try {
    await plugin(bb);
    await assert.rejects(harness.behavior.callRpc("resolveThreadViews", { threadIds: ["deleted"] }), /deleted/);
    const result = await harness.behavior.callRpc("runTool", { name: "read_thread", args: { thread_id: "deleted" }, threadId: null, projectId: null }) as any;
    assert.equal(result.status, "error");
    assert.match(result.output, /deleted/);
    assert.equal(harness.inspection.logEntries.some(log => log.message.includes("voice tool")), false);
    const unknown = await harness.behavior.callRpc("runTool", { name: "not-a-tool", args: {}, threadId: null, projectId: null }) as any;
    assert.equal(unknown.status, "error");
  } finally { await harness.lifecycle.dispose(); }
});

test("desktop calls retain the original focus tool and exclude mobile-only controls", () => {
  const desktop = toolSchemas([], false);
  const mobile = toolSchemas([], true);
  for (const name of ["focus_threads", "manage_views", "set_view_behavior"]) {
    assert.equal(desktop.some(tool => tool.name === name), false);
    assert.equal(mobile.some(tool => tool.name === name), true);
  }
  const focusDesktop = desktop.find(tool => tool.name === "focus_thread") as any;
  const focusMobile = mobile.find(tool => tool.name === "focus_thread") as any;
  assert.equal("disposition" in focusDesktop.parameters.properties, false);
  assert.equal("disposition" in focusMobile.parameters.properties, true);
  assert.match(threadViewInstructions(false), /navigates to the requested thread/);
  assert.match(threadViewInstructions(true), /do not navigate away/);
  assert.deepEqual(toolSchemas(), desktop);
});

test("mobile settings never replace desktop navigation and migrate the prototype preference", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "voice-mode" });
  try {
    await bb.storage.kv.set("config", { viewBehavior: "new" });
    await plugin(bb);
    const current = await harness.behavior.callRpc("getConfig", null) as any;
    assert.equal(current.mobileViewBehavior, "new");
    assert.equal("viewBehavior" in current, false);
    const saved = await harness.behavior.callRpc("setConfig", { mobileViewBehavior: "reuse" }) as any;
    assert.equal(saved.mobileViewBehavior, "reuse");
    await assert.rejects(harness.behavior.callRpc("setConfig", { mobileViewBehavior: "auto" }));
  } finally { await harness.lifecycle.dispose(); }
});

test("desktop focus still opens the real bb thread through the original SDK operation", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "voice-mode", sdk: {
    threads: { open: async () => ({ delivered: 1 }) },
  } });
  try {
    await plugin(bb);
    const result = await harness.behavior.callRpc("runTool", {
      name: "focus_thread", args: { thread_id: "target" }, threadId: "source", projectId: "project",
    }) as any;
    assert.deepEqual(result, { output: "Focused.", status: "success" });
    assert.equal(harness.inspection.sdk.callsTo("threads.open").length, 1);
  } finally { await harness.lifecycle.dispose(); }
});


test("concurrent settings patches preserve both changes", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "voice-mode" });
  try {
    await plugin(bb);
    await Promise.all([
      harness.behavior.callRpc("setConfig", { notifications: false }),
      harness.behavior.callRpc("setConfig", { mobileViewBehavior: "new" }),
    ]);
    const config = await harness.behavior.callRpc("getConfig", null) as any;
    assert.equal(config.notifications, false);
    assert.equal(config.mobileViewBehavior, "new");
  } finally { await harness.lifecycle.dispose(); }
});

test("agent prompt proposals do not change active instructions until the user saves", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "voice-mode" });
  try {
    await plugin(bb);
    const before = await harness.behavior.callRpc("getPrompt", null) as any;
    const suggest = (instructions: string) => harness.behavior.callRpc("runTool", {
      name: "update_instructions", args: { instructions, reason: "User asked for short replies" }, threadId: null, projectId: null,
    });
    await suggest("Keep replies short.");
    const pending = await harness.behavior.callRpc("getPrompt", null) as any;
    assert.equal(pending.content, before.content);
    assert.equal(pending.versions.length, before.versions.length);
    assert.equal(pending.proposal.content, "Keep replies short.");
    await suggest("Ask before starting work.");
    await harness.behavior.callRpc("setPrompt", { content: pending.proposal.content, source: "user", note: "reviewed", proposalId: pending.proposal.id });
    const after = await harness.behavior.callRpc("getPrompt", null) as any;
    assert.equal(after.content, "Keep replies short.");
    assert.equal(after.proposal.content, "Ask before starting work.", "a newer suggestion survives saving an older one");
    await harness.behavior.callRpc("setPrompt", { content: after.proposal.content, source: "user", note: "reviewed", proposalId: after.proposal.id });
    assert.equal((await harness.behavior.callRpc("getPrompt", null) as any).proposal, null);
  } finally { await harness.lifecycle.dispose(); }
});

test("session cursors retain older history when new sessions arrive, including timestamp ties", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "voice-mode" });
  try {
    await plugin(bb);
    const db = bb.storage.database();
    const insert = db.prepare("INSERT INTO session_events (session_id, ts, kind, payload) VALUES (?, ?, 'session.started', '{}')");
    for (let i = 0; i < 65; i++) insert.run(`session-${String(i).padStart(3, "0")}`, 1000);
    const first = await harness.behavior.callRpc("listSessions", null) as any;
    insert.run("new-session", 2000);
    const before = first.sessions.at(-1);
    const second = await harness.behavior.callRpc("listSessions", { before: { startedAt: before.startedAt, id: before.id } }) as any;
    const last = second.sessions.at(-1);
    const third = await harness.behavior.callRpc("listSessions", { before: { startedAt: last.startedAt, id: last.id } }) as any;
    assert.equal(new Set([...first.sessions, ...second.sessions, ...third.sessions].map((row: any) => row.id)).size, 65);
    assert.equal(third.hasMore, false);
  } finally { await harness.lifecycle.dispose(); }
});

test("event logging rejects oversized payloads", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "voice-mode" });
  try {
    await plugin(bb);
    await assert.rejects(harness.behavior.callRpc("logEvent", { sessionId: "call", kind: "user", payload: { text: "x".repeat(65536) } }), /input validation/);
    assert.deepEqual((await harness.behavior.callRpc("listSessions", null) as any).sessions, []);
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
    const history = await harness.behavior.callRpc("getSessionEvents", { sessionId: "b" }) as any;
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
    await plugin(bb);
    assert.equal((await harness.behavior.callRpc("getPrompt", null) as any).content, "Keep my prompt");
    assert.equal((await harness.behavior.callRpc("claimCall", { nonce: "new" }) as any).sequence, 1);
  } finally { await harness.lifecycle.dispose(); }
});
