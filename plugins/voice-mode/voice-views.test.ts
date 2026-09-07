import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { VoiceAgent, type Bindings } from "./voice-agent.ts";
import { nativeUi } from "./native-ui.ts";
import type { UiCommand, UiAction, UiActionResult } from "./ui-actions.ts";

const command = (extra: Partial<UiCommand> = {}): UiCommand => ({
  id: "ui-1", conversationId: "conv-1", requestId: "request-1", callNonce: "call-1",
  action: { kind: "open_thread", threadId: "other-project-thread", split: false }, ...extra,
});
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
function fixture(t: TestContext) {
  const agent = new VoiceAgent();
  const internal = agent as any;
  const calls: { method: string; args: any }[] = [];
  let pendingWait: Promise<void> | undefined;
  let pendingFailures = 0;
  let claimWait: Promise<void> | undefined;
  let reportFailures = 0;
  let claimFailures = 0;
  let revokedCommandIds: string[] = [];
  const rpc = { call: async (method: string, args: any) => {
    calls.push({ method, args });
    if (method === "claimUiCommand") { if (claimFailures-- > 0) throw Error("offline before claim"); await claimWait; return { claimed: true, command: command({ id: args.commandId, callNonce: args.callNonce }) }; }
    if (method === "reportUiCommandResult") { if (reportFailures-- > 0) throw Error("offline"); return { accepted: true }; }
    if (method === "pendingUiCommands") { await pendingWait; if (pendingFailures-- > 0) throw Error("pending commands unavailable"); return { commands: [command()], revokedCommandIds }; }
    return { ok: true };
  } } as Bindings["rpc"];
  agent.bindGlobal({ rpc, context: { threadId: "start", projectId: "start-project", onNewThreadScreen: false } });
  agent.setUiConnectionState(true);
  internal.uiReady = true;
  internal.nonce = "call-1";
  internal.logicalConversationId = "conv-1";
  internal.state = "live";
  internal.session = { dc: null, pc: { close() {} }, stream: { getTracks: () => [] }, audio: { remove() {} } };
  const execute = t.mock.method(nativeUi, "execute", async (_action: UiAction, isCurrent: () => boolean): Promise<UiActionResult> => ({ status: isCurrent() ? "succeeded" as const : "cancelled" as const, detail: "Thread shown" }));
  t.after(() => agent.stop());
  return { agent, internal, calls, execute, failPending: () => { pendingFailures++; }, waitForPending: (wait: Promise<void>) => { pendingWait = wait; }, waitForClaim: (wait: Promise<void>) => { claimWait = wait; }, failReport: () => { reportFailures++; }, failClaim: () => { claimFailures++; }, revokeOnSync: () => { revokedCommandIds = ["ui-1"]; } };
}

test("only the owning active call executes native cross-project navigation once", async t => {
  const f = fixture(t);
  await Promise.all([f.agent.ingestUiCommand(command()), f.agent.ingestUiCommand(command())]);
  assert.equal(f.execute.mock.callCount(), 1);
  assert.deepEqual(f.execute.mock.calls[0].arguments[0], command().action);
  assert.equal(f.calls.filter(call => call.method === "claimUiCommand").length, 1);
  assert.equal(f.calls.find(call => call.method === "reportUiCommandResult")?.args.result.status, "succeeded");
  assert.equal(f.agent.getState(), "live");
});

test("mirrors, stale calls, other conversations, and expired commands have no effects", async t => {
  const f = fixture(t);
  await f.agent.ingestUiCommand(command({ callNonce: "old-call" }));
  await f.agent.ingestUiCommand(command({ conversationId: "another-conversation" }));
  await f.agent.ingestUiCommand(command({ expiresAt: Date.now() - 1 }));
  f.internal.session = null;
  await f.agent.ingestUiCommand(command());
  assert.equal(f.execute.mock.callCount(), 0);
  assert.equal(f.calls.some(call => call.method === "claimUiCommand"), false);
});

test("hangup while claim is pending prevents execution", async t => {
  const f = fixture(t);
  const wait = deferred();
  f.waitForClaim(wait.promise);
  const pending = f.agent.ingestUiCommand(command());
  await Promise.resolve();
  f.agent.stop();
  wait.resolve();
  await pending;
  assert.equal(f.execute.mock.callCount(), 0);
});

test("hangup during native execution invalidates every later stage", async t => {
  const f = fixture(t);
  const wait = deferred();
  let effect = false;
  f.execute.mock.mockImplementation(async (_action: UiAction, isCurrent: () => boolean): Promise<UiActionResult> => {
    await wait.promise;
    effect = isCurrent();
    return { status: effect ? "succeeded" : "cancelled", detail: "Cancelled" };
  });
  const pending = f.agent.ingestUiCommand(command());
  await new Promise<void>(resolve => setImmediate(resolve));
  f.agent.stop();
  wait.resolve();
  await pending;
  assert.equal(effect, false);
});

test("failed reports retry the receipt on reconnect without repeating the UI action", async t => {
  const f = fixture(t);
  f.failReport();
  await f.agent.ingestUiCommand(command());
  await f.agent.syncUiCommands();
  await f.agent.ingestUiCommand(command());
  assert.equal(f.execute.mock.callCount(), 1);
  assert.equal(f.calls.filter(call => call.method === "reportUiCommandResult").length, 2);
  assert.equal(f.calls.filter(call => call.method === "claimUiCommand").length, 1);
});

test("UI commands serialize independently of speech generation", async t => {
  const f = fixture(t);
  f.internal.responseActive = true;
  f.internal.assistantSpeaking = true;
  const wait = deferred();
  const effects: string[] = [];
  f.execute.mock.mockImplementation(async (): Promise<UiActionResult> => { effects.push("start"); await wait.promise; effects.push("end"); return { status: "succeeded", detail: "Shown" }; });
  const first = f.agent.ingestUiCommand(command());
  const second = f.agent.ingestUiCommand(command({ id: "ui-2" }));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(effects, ["start"]);
  wait.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(effects, ["start", "end", "start", "end"]);
});

test("a claim transport failure can recover through pending commands before any effect", async t => {
  const f = fixture(t);
  f.failClaim();
  await f.agent.ingestUiCommand(command());
  assert.equal(f.execute.mock.callCount(), 0);
  await f.agent.syncUiCommands();
  await f.agent.ingestUiCommand(command());
  assert.equal(f.execute.mock.callCount(), 1);
  assert.equal(f.calls.filter(call => call.method === "claimUiCommand").length, 2);
});

test("request cancellation stops later native stages while the call stays live", async t => {
  const f = fixture(t);
  const wait = deferred();
  let effect = false;
  f.execute.mock.mockImplementation(async (_action: UiAction, isCurrent: () => boolean): Promise<UiActionResult> => {
    await wait.promise;
    effect = isCurrent();
    return { status: effect ? "succeeded" : "cancelled", detail: "Request cancelled" };
  });
  const pending = f.agent.ingestUiCommand(command());
  await new Promise<void>(resolve => setImmediate(resolve));
  f.agent.ingestUiCancellation({ commandId: "ui-1", conversationId: "conv-1", callNonce: "call-1" });
  wait.resolve();
  await pending;
  assert.equal(effect, false);
  assert.equal(f.agent.getState(), "live");
});

test("a cancellation received before its command prevents even a claim", async t => {
  const f = fixture(t);
  f.agent.ingestUiCancellation({ commandId: "ui-1", conversationId: "conv-1", callNonce: "call-1" });
  await f.agent.ingestUiCommand(command());
  assert.equal(f.calls.some(call => call.method === "claimUiCommand"), false);
});

test("transport loss cancels an in-flight effect even after transport reconnects", async t => {
  const f = fixture(t);
  const wait = deferred();
  let effect = false;
  f.execute.mock.mockImplementation(async (_action: UiAction, isCurrent: () => boolean): Promise<UiActionResult> => {
    await wait.promise;
    effect = isCurrent();
    return { status: effect ? "succeeded" : "cancelled", detail: "Connection changed" };
  });
  const pending = f.agent.ingestUiCommand(command());
  await new Promise<void>(resolve => setImmediate(resolve));
  f.agent.setUiConnectionState(false);
  f.agent.setUiConnectionState(true);
  wait.resolve();
  await pending;
  assert.equal(effect, false);
  assert.equal(f.execute.mock.callCount(), 1);
});

test("reconciliation applies revocations before buffered signal commands", async t => {
  const f = fixture(t);
  f.internal.uiReady = false;
  f.revokeOnSync();
  await f.agent.ingestUiCommand(command());
  await f.agent.syncUiCommands();
  assert.equal(f.execute.mock.callCount(), 0);
  assert.equal(f.calls.some(call => call.method === "claimUiCommand"), false);
});

test("a transient initial sync failure retries while connected and executes a buffered command once", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t);
  await Promise.resolve();
  f.internal.uiReady = false;
  f.failPending();
  await f.agent.syncUiCommands();
  await f.agent.ingestUiCommand(command());
  assert.equal(f.execute.mock.callCount(), 0);
  t.mock.timers.tick(500);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.execute.mock.callCount(), 1);
  await f.agent.ingestUiCommand(command());
  assert.equal(f.execute.mock.callCount(), 1);
  assert.equal(f.calls.filter(call => call.method === "pendingUiCommands").length, 2);
});

test("concurrent recovery requests share one pending RPC", async t => {
  const f = fixture(t);
  await Promise.resolve();
  const wait = deferred();
  f.waitForPending(wait.promise);
  const first = f.agent.syncUiCommands();
  const second = f.agent.syncUiCommands();
  assert.equal(first, second);
  assert.equal(f.calls.filter(call => call.method === "pendingUiCommands").length, 1);
  wait.resolve();
  await Promise.all([first, second]);
  assert.equal(f.execute.mock.callCount(), 1);
});

for (const end of ["disconnect", "stop"] as const) {
  test(`${end} clears scheduled UI recovery`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const f = fixture(t);
    await Promise.resolve();
    f.failPending();
    await f.agent.syncUiCommands();
    if (end === "disconnect") f.agent.setUiConnectionState(false); else f.agent.stop();
    t.mock.timers.tick(10000);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.calls.filter(call => call.method === "pendingUiCommands").length, 1);
    assert.equal(f.execute.mock.callCount(), 0);
  });
}
