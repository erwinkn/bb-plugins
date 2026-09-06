import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { parseBranding } from "./branding";
import mapping from "./providers.json";

test("registers multiple exact IDs; absent and invalid icons keep the native slot", async (t) => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  Object.defineProperties(globalThis, { window: { value: dom.window, configurable: true }, document: { value: dom.window.document, configurable: true }, navigator: { value: dom.window.navigator, configurable: true } });
  t.after(() => dom.window.close());
  await loadPluginApp(() => import("./app"));
  const { createApp } = await import("./app");
  const config = parseBranding({ "acp-devin": mapping["acp-devin"], amp: { icon: mapping["acp-devin"].icon, label: "My Amp" }, "custom-agent": {}, invalid: { icon: null } });
  const app = await loadPluginApp(createApp(config));
  assert.deepEqual(app.providerIcons.map((entry) => entry.providerId), ["acp-devin", "amp"]);
  const icon = app.providerIcons[1]!;
  const slot = renderSlot({ component: icon.icon }, { className: "size-4" });
  t.after(() => slot.lifecycle.unmount());
  const element = slot.getByRole("img", { name: "My Amp" });
  assert.equal(element.getAttribute("title"), "My Amp");
  assert.equal(element.className, "size-4");
});
