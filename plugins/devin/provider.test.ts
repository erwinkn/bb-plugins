import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createFakePluginHost, experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import { experimental_acpLaunchSpecSchema } from "@get-bb/plugin-sdk/provider-bridge/acp";
import plugin from "./server";
import { devinProvider } from "./provider";

test("Devin retains its provider ID and uses a native icon and public ACP launch", () => {
  const provider = devinProvider("/custom/devin");
  assert.equal(provider.id, "acp-devin");
  assert.equal(provider.displayName, "Devin");
  assert.equal(provider.icon, "./assets/devin.svg");
  assert.equal(provider.experimental_bridgeOptions?.acpDialect, "generic");
  assert.deepEqual(experimental_acpLaunchSpecSchema.parse(provider.experimental_bridgeOptions?.acpLaunchSpec), {
    displayName: "Devin", command: "/custom/devin", args: ["acp"], env: {},
  });
  assert.equal(provider.capabilities.fork, "none");
});

test("executable setting re-registers one provider; invalid settings preserve it", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "devin", experimental_hostEntry: true });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  assert.equal(harness.inspection.registrations.providerRegistrations.length, 1);
  assert.equal(harness.inspection.sdk.calls.length, 0);
  await harness.behavior.setSettings({ command: "/custom/devin" });
  assert.equal(harness.inspection.registrations.providerRegistrations.length, 1);
  assert.deepEqual(harness.inspection.registrations.providerRegistrations[0]?.experimental_bridgeOptions?.acpLaunchSpec,
    { displayName: "Devin", command: "/custom/devin", args: ["acp"], env: {} });
  await assert.rejects(() => harness.behavior.setSettings({ command: " " }));
  assert.equal(harness.inspection.registrations.providerRegistrations.length, 1);
  assert.equal(harness.inspection.sdk.calls.length, 0);
});

test("only public SDK imports are used", () => {
  const scan = experimental_scanPublicSdkOnly(fileURLToPath(new URL(".", import.meta.url)), { allow: [/^protobufjs$/] });
  assert.deepEqual(scan.violations, []); assert.deepEqual(scan.privateDependencies, []);
});
