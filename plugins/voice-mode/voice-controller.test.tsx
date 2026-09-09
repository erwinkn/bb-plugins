// The app overlay: it binds the native UI controller to bb's hooks, forwards
// the UI command channels to the agent, reports the transport, and draws the
// global call controls everywhere except the Voice page.
import test, { after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/threads/thr_a", pretendToBeVisual: true });
for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, HTMLSelectElement: dom.window.HTMLSelectElement, IS_REACT_ACT_ENVIRONMENT: true })) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
const { installTestPluginRuntime, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
/** Shared rpc stubs: presence on bind, config for the shortcut mirror, diagnostics. */
const rpc = { requestPresence: () => ({ ok: true }), logEvent: () => ({ ok: true }), getConfig: () => { throw new Error("no config in this test"); } };
/** Owns the call for the first check only, so waits end right after the SDK call is issued. */
const onceCurrent = () => { let checks = 0; return () => checks++ === 0; };
const { act, within } = await import("@testing-library/react");
installTestPluginRuntime();
const { voiceAgent } = await import("./voice-agent.ts");
const { nativeUi } = await import("./native-ui.ts");
const { VoiceComposerBinding, VoiceController } = await import("./voice-realtime.ts");
after(() => dom.window.close());

function callControl(t: TestContext) {
  const call = voiceAgent as unknown as { state: "idle" | "connecting" | "live" | "muted"; emitChange(): void };
  const setState = (state: typeof call.state) => { call.state = state; call.emitChange(); };
  t.after(() => setState("idle"));
  return { setState };
}

test("the overlay binds live route context and navigation to the native UI controller", async () => {
  const slot = renderSlot({ component: VoiceController }, {}, { context: { threadId: "thr_a", projectId: "proj_1" }, rpc });
  try {
    const snapshot = nativeUi.snapshot();
    assert.equal(snapshot.bound, true);
    assert.equal(snapshot.threadId, "thr_a");
    assert.equal(snapshot.projectId, "proj_1");
    assert.equal(snapshot.route, "/threads/thr_a");
    const result = await nativeUi.execute({ kind: "open_project", projectId: "proj_2" }, onceCurrent());
    assert.equal(result.status, "cancelled", "the harness never changes the route, so nothing is claimed");
    assert.deepEqual(slot.inspection.navigateCalls, [{ method: "toProject", projectId: "proj_2" }]);
    await nativeUi.execute({ kind: "open_thread", threadId: "thr_b", split: true }, onceCurrent());
    assert.deepEqual(slot.inspection.sidebarActionCalls.at(-1), { method: "open", threadId: "thr_b", options: { split: true } });
    // The overlay's own navigate hook cannot preview files (bb resolves that per
    // surface), so with no page or composer bound the action fails precisely.
    const preview = await nativeUi.execute({ kind: "preview_file", target: { kind: "thread-storage", threadId: "thr_a", path: "notes.md" } }, () => true);
    assert.equal(preview.status, "failed");
    assert.match(preview.detail, /no file preview panel/);
    assert.equal(slot.inspection.navigateCalls.some(call => call.method === "experimental_openFilePreview"), false);
  } finally { slot.lifecycle.unmount(); }
  assert.equal(nativeUi.snapshot().bound, false);
});

test("retired UI command signals cannot act and native transport state stays current", async t => {
  const execute=t.mock.method(nativeUi,"execute",async()=>({status:"succeeded" as const,detail:"Unexpected action"}));
  const slot=renderSlot({component:VoiceController},{},{rpc});
  try {
    await slot.behavior.emitRealtime("voice-ui-command",{id:"old-command"});
    await slot.behavior.emitRealtime("voice-ui-cancelled",{commandId:"old-command"});
    assert.equal(execute.mock.callCount(),0);
    assert.equal(nativeUi.transportConnected(),true);
    await slot.behavior.setRealtimeConnectionState("reconnecting");assert.equal(nativeUi.transportConnected(),false);
    await slot.behavior.setRealtimeConnectionState("connected");assert.equal(nativeUi.transportConnected(),true);
  }finally{slot.lifecycle.unmount();}
  assert.equal(nativeUi.transportConnected(),false);
  nativeUi.setTransportConnected(true);
});

test("global call controls appear during a call, stay out of the composer's way, and hide on the Voice page", async (t) => {
  const { setState } = callControl(t);
  const slot = renderSlot({ component: VoiceController }, {}, { rpc });
  const ui = within(slot.container);
  try {
    assert.equal(ui.queryByRole("region", { name: "Voice call" }), null);
    act(() => setState("live"));
    const region = ui.getByRole("region", { name: "Voice call" });
    assert.ok(region.className.includes("fixed"));
    assert.ok(region.className.includes("pointer-events-none"), "the wrapper never blocks clicks beneath it");
    assert.match(region.style.top, /safe-area-inset-top/);
    assert.ok(ui.getByRole("button", { name: "Mute Aide microphone" }));
    assert.ok(ui.getByRole("button", { name: "Stop Aide voice session" }));
    // The Voice page draws its own console.
    act(() => { dom.window.history.pushState({}, "", "/plugins/voice-mode/sessions"); dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate")); });
    assert.equal(ui.queryByRole("region", { name: "Voice call" }), null);
    act(() => { dom.window.history.pushState({}, "", "/threads/thr_a"); dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate")); });
    assert.ok(ui.getByRole("region", { name: "Voice call" }));
  } finally { slot.lifecycle.unmount(); }
});

test("the composer customization renders nothing and lends its live scope to the controller", async () => {
  nativeUi.setTransportConnected(true);
  const slot = renderSlot({ component: VoiceComposerBinding }, {}, { composer: { scope: { kind: "thread", threadId: "thr_a" }, text: "keep" }, rpc });
  try {
    assert.equal(slot.container.textContent, "");
    assert.equal(slot.container.querySelector("button"), null, "no voice button inside composers");
    assert.deepEqual(nativeUi.snapshot().composers, [{ kind: "thread", threadId: "thr_a" }]);
    const appended = await nativeUi.execute({ kind: "prepare_draft", target: { kind: "thread", threadId: "thr_a" }, text: "more", mode: "append" }, () => true);
    assert.equal(appended.status, "failed", "no app binding: nothing to navigate with");
  } finally { slot.lifecycle.unmount(); }
});

test("a draft lands in the exact composer scope, follows a scope change, and is never submitted", async () => {
  const controller = renderSlot({ component: VoiceController }, {}, { context: { threadId: "thr_a", projectId: "proj_1" }, rpc });
  const slot = renderSlot({ component: VoiceComposerBinding }, {}, { composer: { scope: { kind: "thread", threadId: "thr_a" }, text: "keep" }, rpc, openFilePreview: () => true });
  try {
    // File preview runs through this composer's surface, the one on screen.
    const preview = await nativeUi.execute({ kind: "preview_file", target: { kind: "thread-storage", threadId: "thr_a", path: "notes.md" }, location: { kind: "range", startLine: 2, endLine: 4 } }, () => true);
    assert.equal(preview.status, "succeeded");
    assert.deepEqual(slot.inspection.navigateCalls, [{ method: "experimental_openFilePreview", options: { target: { kind: "thread-storage", threadId: "thr_a", path: "notes.md" }, location: { kind: "range", startLine: 2, endLine: 4 } } }]);
    assert.equal(controller.inspection.navigateCalls.length, 0);
    const appended = await nativeUi.execute({ kind: "prepare_draft", target: { kind: "thread", threadId: "thr_a" }, text: "more", mode: "append" }, () => true);
    assert.equal(appended.status, "succeeded");
    assert.equal(slot.inspection.composer.text, "keep\nmore");
    assert.deepEqual(slot.inspection.composer.submits, []);
    // The host hands this composer to a queued-message editor: protected.
    await slot.behavior.setComposerScope({ kind: "queued-message", threadId: "thr_a", queuedMessageId: "q1" });
    const refused = await nativeUi.execute({ kind: "prepare_draft", target: { kind: "thread", threadId: "thr_a" }, text: "x", mode: "replace" }, () => true);
    assert.equal(refused.status, "failed");
    assert.match(refused.detail, /queued message/);
    assert.equal(slot.inspection.composer.text, "keep\nmore");
    assert.equal(controller.inspection.sidebarActionCalls.length, 0, "no navigation while a protected editor is open");
  } finally { slot.lifecycle.unmount(); controller.lifecycle.unmount(); }
});


test("a mirrored call offers transfer instead of local microphone controls", async t => {
  const transfer=t.mock.method(voiceAgent,"switchToThisDevice",()=>{});
  const slot=renderSlot({component:VoiceController},{},{rpc});
  try {
    await slot.behavior.emitRealtime("voice-presence",{nonce:"desktop-call",phase:"live",startedAt:Date.now(),client:"other-device"});
    const ui=within(slot.container);
    assert.ok(ui.getByText("Call on another device"));
    assert.equal(ui.queryByLabelText("Mute Aide microphone"),null);
    assert.equal(ui.queryByText("Connected"),null);
    await act(async()=>ui.getByRole("button",{name:"Switch voice call to this device"}).click());
    assert.equal(transfer.mock.callCount(),1);
  } finally {
    await act(async()=>voiceAgent.ingestPresence({nonce:"desktop-call",phase:"idle"}));
    slot.lifecycle.unmount();
  }
});
