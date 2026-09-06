import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createFakePluginHost, experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

test("ping returns a bounded server reply through the RPC boundary", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "erwin-hello" });
  t.after(() => harness.lifecycle.dispose());
  plugin(bb);
  const before = Date.now();
  const reply = await harness.behavior.callRpc("ping", null);
  assert.equal(typeof reply, "object");
  assert.ok(typeof reply === "object" && reply !== null && !Array.isArray(reply));
  assert.ok("message" in reply && "serverTime" in reply);
  assert.equal(reply.message, "Hello from the BB server!");
  assert.equal(typeof reply.serverTime, "string");
  const time = Date.parse(String(reply.serverTime));
  assert.ok(time >= before && time <= Date.now());
  assert.ok(Buffer.byteLength(JSON.stringify(reply)) < 128);
  await assert.rejects(() => harness.behavior.callRpc("ping", { unexpected: true }));
});

test("plugin uses only public SDK imports", () => {
  const scan = experimental_scanPublicSdkOnly(fileURLToPath(new URL(".", import.meta.url)), { allow: [/^react$/] });
  assert.deepEqual(scan.violations, []);
  assert.deepEqual(scan.privateDependencies, []);
});
