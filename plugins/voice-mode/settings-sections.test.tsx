import test, { after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
const { installTestPluginRuntime, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { act, fireEvent, within } = await import("@testing-library/react");
installTestPluginRuntime();
const { MicLevelMeter, PromptEditor } = await import("./settings-sections.tsx");
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
