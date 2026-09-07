import test, { after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, HTMLSelectElement: dom.window.HTMLSelectElement, IS_REACT_ACT_ENVIRONMENT: true, cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
const { installTestPluginRuntime, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { act, fireEvent, within } = await import("@testing-library/react");
installTestPluginRuntime();
const { AudioSettings, MicLevelMeter, PromptEditor } = await import("./settings-sections.tsx");
after(() => dom.window.close());

test("a microphone test stopped before permission resolves releases the late stream", async () => {
  let resolve!: (stream: MediaStream) => void;
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
    getUserMedia: () => new Promise<MediaStream>(done => { resolve = done; }),
  } });
  let stops = 0;
  const slot = renderSlot({ component: MicLevelMeter }, { deviceId: "", active: true });
  slot.lifecycle.unmount();
  await act(async () => {
    resolve({ getTracks: () => [{ stop() { stops++; } }] } as unknown as MediaStream);
    await Promise.resolve();
  });
  assert.equal(stops, 1);
});

test("prompt suggestions require review and Save before changing instructions", async () => {
  const saves: unknown[] = [];
  const slot = renderSlot({ component: PromptEditor }, {}, { rpc: {
    getPrompt: () => ({ content: "Current", defaultContent: "Default", versions: [], proposal: { id: "p1", content: "Suggested", reason: "Use short replies" } }),
    setPrompt: (args: unknown) => { saves.push(args); return { ok: true }; },
  } });
  try {
    const ui = within(slot.container);
    fireEvent.click(await ui.findByRole("button", { name: "Review suggestion" }));
    assert.equal(saves.length, 0);
    assert.equal((ui.getByRole("textbox", { name: "Voice instructions" }) as HTMLTextAreaElement).value, "Suggested");
    fireEvent.click(ui.getByRole("button", { name: "Save" }));
    await act(async () => { await Promise.resolve(); });
    assert.deepEqual(saves, [{ content: "Suggested", source: "user", note: "edited in settings", proposalId: "p1" }]);
  } finally { slot.lifecycle.unmount(); }
});


test("prompt opens for editing and stays open after save and cancel", async () => {
  const saves: unknown[] = [];
  const slot = renderSlot({ component: PromptEditor }, {}, { rpc: {
    getPrompt: () => ({ content: "Current", defaultContent: "Default", versions: [], proposal: null }),
    setPrompt: (args: unknown) => { saves.push(args); return { ok: true }; },
  } });
  try {
    const ui = within(slot.container);
    await act(async () => { await Promise.resolve(); });
    const editor = ui.getByRole("textbox", { name: "Voice instructions" }) as HTMLTextAreaElement;
    assert.equal(editor.value, "Current");
    assert.equal(ui.queryByRole("button", { name: "Preview" }), null);
    assert.equal(ui.queryByRole("button", { name: "Edit" }), null);
    fireEvent.change(editor, { target: { value: "Updated" } });
    fireEvent.click(ui.getByRole("button", { name: "Save" }));
    await act(async () => { await Promise.resolve(); });
    assert.equal(saves.length, 1);
    assert.equal(editor.value, "Updated");
    fireEvent.change(editor, { target: { value: "Discard this" } });
    fireEvent.click(ui.getByRole("button", { name: "Cancel" }));
    assert.equal(editor.value, "Updated");
    fireEvent.click(ui.getByRole("button", { name: "Reset to default" }));
    await act(async () => { await Promise.resolve(); });
    assert.equal(editor.value, "Default");
  } finally { slot.lifecycle.unmount(); }
});

test("audio settings retain the microphone controls without a speaker setting", async () => {
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
    enumerateDevices: async () => [
      { deviceId: "mic", kind: "audioinput", label: "Test microphone" },
      { deviceId: "default", kind: "audiooutput", label: "Default - Test speaker" },
    ],
  } });
  const slot = renderSlot({ component: AudioSettings }, {});
  try {
    const ui = within(slot.container);
    await ui.findByRole("option", { name: "Test microphone" });
    assert.equal(ui.getAllByRole("combobox").length, 1);
    assert.ok(ui.getByRole("button", { name: "Test microphone" }));
    assert.equal(ui.queryByText("Speaker"), null);
    assert.equal(ui.queryByText("Test speaker"), null);
  } finally { slot.lifecycle.unmount(); }
});


test("prompt updates refresh a clean editor but preserve unsaved edits", async () => {
  let content = "Current";
  const slot = renderSlot({ component: PromptEditor }, {}, { rpc: {
    getPrompt: () => ({ content, defaultContent: "Default", versions: [], proposal: null }),
  } });
  try {
    const ui = within(slot.container);
    await act(async () => { await Promise.resolve(); });
    const editor = ui.getByRole("textbox", { name: "Voice instructions" }) as HTMLTextAreaElement;
    content = "Remote update";
    await slot.behavior.emitRealtime("prompt-changed", null);
    assert.equal(editor.value, content);
    fireEvent.change(editor, { target: { value: "Unsaved draft" } });
    content = "Another update";
    await slot.behavior.emitRealtime("prompt-changed", null);
    assert.equal(editor.value, "Unsaved draft");
    fireEvent.click(ui.getByRole("button", { name: "Cancel" }));
    assert.equal(editor.value, content);
  } finally { slot.lifecycle.unmount(); }
});

test("behavior settings keep the prompt and drop the legacy plugin-command and tool catalogue controls", async () => {
  const { BehaviorSettings } = await import("./settings-sections.tsx");
  const slot = renderSlot({ component: BehaviorSettings }, {}, { rpc: {
    getPrompt: () => ({ content: "Current", defaultContent: "Default", versions: [], proposal: null }),
  } });
  try {
    const ui = within(slot.container);
    await act(async () => { await Promise.resolve(); });
    assert.ok(ui.getByRole("textbox", { name: "Voice instructions" }));
    assert.equal(ui.queryByRole("combobox"), null, "no plugin exposure picker");
    assert.equal(ui.queryByRole("button", { name: /built-in tools/i }), null);
    assert.equal(slot.inspection.rpcCalls.some(call => call.method === "getTools" || call.method === "listPlugins"), false);
  } finally { slot.lifecycle.unmount(); }
});
