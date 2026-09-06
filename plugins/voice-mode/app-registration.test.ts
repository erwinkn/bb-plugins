import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

test("the actual app registers drawer surfaces only on mobile clients", async () => {
  // Bundle source only to handle CSS/TSX, retaining the real SDK registration
  // harness and all actual app registration code. No microphone is started.
  const directory = mkdtempSync(join(process.cwd(), ".voice-mode-registration-test-"));
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
  const descriptors = ["window", "document", "navigator"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  try {
    for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator })) {
      Object.defineProperty(globalThis, name, { value, configurable: true });
    }
    const file = join(directory, "app.mjs");
    await build({ stdin: { contents: 'export { default, AideVoiceButton } from "./app"; export { viewWorkspace } from "./view-workspace";', resolveDir: process.cwd(), sourcefile: "registration.ts" }, outfile: file, bundle: true, platform: "node", format: "esm", packages: "external", loader: { ".css": "empty" }, jsx: "automatic", logLevel: "silent" });
    for (const mobile of [false, true]) {
      Object.defineProperty(dom.window.navigator, "userAgent", { value: mobile ? "Mozilla/5.0 (iPhone) Mobile Safari" : "Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome", configurable: true });
      const app = await loadPluginApp(() => import(`${pathToFileURL(file).href}?mobile=${mobile}`));
      const page = app.navPanels.find(panel => panel.id === "sessions");
      assert.ok(page);
      const behavior = app.settingsSections.find(section => section.id === "behavior");
      assert.ok(behavior);
      assert.equal(behavior.title, undefined);
      assert.equal(page.fixedTabs?.length ?? 0, mobile ? 1 : 0);
      assert.equal(app.threadPanelActions.some(action => action.id === "thread-workspace"), mobile);
      if (mobile) {
        const mod = await import(`${pathToFileURL(file).href}?mobile=${mobile}`);
        let opened = 0;
        const slot = renderSlot({ component: mod.AideVoiceButton }, {}, {
          context: { threadId: "source", projectId: "project" },
          composer: { scope: { kind: "thread", threadId: "source" } },
          openThreadPanel: () => { opened++; return true; },
          rpc: { requestPresence: () => ({ ok: true }), logEvent: () => ({ ok: true }), getConfig: () => ({ shortcuts: {} }) },
        });
        try {
          for (const phase of ["live", "muted"]) {
            await slot.behavior.emitRealtime("voice-presence", { nonce: "call", phase, startedAt: Date.now() });
            mod.viewWorkspace.open([{ kind: "thread", id: "thread:target", threadId: "target", projectId: "project", title: "Target" }], "new", "reuse");
            assert.equal(mod.viewWorkspace.get().activeId, "thread:target");
          }
          assert.equal(opened, 2);
        } finally {
          await slot.behavior.emitRealtime("voice-presence", { nonce: "call", phase: "idle", startedAt: null });
          slot.lifecycle.unmount();
          mod.viewWorkspace.clear();
        }
      }
    }
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    dom.window.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
