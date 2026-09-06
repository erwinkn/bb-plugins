import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createFakePluginHost, experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

test("CLI previews without writes, applies only names, and skips equal values", async (t) => {
  let customAgents = JSON.stringify([{ id: "devin", displayName: "Devin", command: "devin", env: { TOKEN: "test-placeholder" } }]);
  const { bb, harness } = createFakePluginHost({ pluginId: "erwin-provider-branding", sdk: { plugins: {
    getSettings: async () => ({ schema: {}, values: { customAgents } }),
    updateSettings: async ({ values }) => { customAgents = String(values.customAgents); return { schema: {}, values: { customAgents } }; },
  } } });
  t.after(() => harness.lifecycle.dispose());
  plugin(bb);
  assert.equal(harness.inspection.sdk.calls.length, 0);
  const preview = await harness.behavior.runCli(["labels"]);
  assert.equal(preview.exitCode, 0);
  assert.ok(!preview.stdout?.includes("test-placeholder"));
  assert.equal(harness.inspection.sdk.callsTo("plugins.updateSettings").length, 0);
  assert.equal((await harness.behavior.runCli(["apply-labels"])).exitCode, 0);
  assert.equal(harness.inspection.sdk.callsTo("plugins.updateSettings").length, 1);
  assert.equal(JSON.parse(customAgents)[0].env.TOKEN, "test-placeholder");
  assert.equal(JSON.parse(customAgents)[0].displayName, "Devin CLI");
  await harness.behavior.runCli(["apply-labels"]);
  assert.equal(harness.inspection.sdk.callsTo("plugins.updateSettings").length, 1);
  assert.equal((await harness.behavior.runCli(["unknown"])).exitCode, 1);
});

test("invalid ACP config is not written or exposed", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "erwin-provider-branding", sdk: { plugins: {
    getSettings: async () => ({ schema: {}, values: { customAgents: "invalid-private-value" } }),
  } } });
  t.after(() => harness.lifecycle.dispose()); plugin(bb);
  const result = await harness.behavior.runCli(["apply-labels"]);
  assert.equal(result.exitCode, 1);
  assert.ok(!JSON.stringify(result).includes("invalid-private-value"));
  assert.equal(harness.inspection.sdk.callsTo("plugins.updateSettings").length, 0);
});

test("plugin uses public SDK imports", () => {
  const scan = experimental_scanPublicSdkOnly(fileURLToPath(new URL(".", import.meta.url)), { allow: [/^react$/, /^jsdom$/] });
  assert.deepEqual(scan.violations, []); assert.deepEqual(scan.privateDependencies, []);
});
