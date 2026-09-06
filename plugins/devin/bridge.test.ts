import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { experimental_captureBridgeJsonRpcOutput, experimental_runBridgeConformance } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { experimental_acpProviderBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { withDevinModels } from "./model-bridge";
import { withDevinUsage } from "./usage-bridge";
import { buildDevinModels } from "./models";
const raw = { families: [{ family_uid: "test", family_label: "Test", variants: [
  { model_uid: "test-medium", label: "Test Medium", max_context_tokens: 1000 },
  { model_uid: "test-high-priority", label: "Test High Fast", max_context_tokens: 1000 },
] }] };
const catalog = buildDevinModels(raw);
const experimental_providerBridge = withDevinUsage(withDevinModels(experimental_acpProviderBridge, async () => raw));

async function checkBridge() {
  const cwd = mkdtempSync(join(tmpdir(), "bb-devin-conformance-"));
  const capture = experimental_captureBridgeJsonRpcOutput();
  try {
  const report = await experimental_runBridgeConformance({
    providerId: "acp-devin",
    transport: { send: experimental_providerBridge.handleLine, takeMessages: capture.takeMessages },
    session: {
      cwd, promptInput: [{ type: "text", text: "say hello", mentions: [] }],
      options: { model: catalog.models[1].id, reasoningLevel: "high", serviceTier: "fast", permissionMode: "full", permissionScope: "full", approvalReviewer: null, permissionEscalation: null,
        providerOptions: { acpDialect: "generic", acpLaunchSpec: {
          displayName: "Devin test peer", command: process.execPath,
          args: [fileURLToPath(new URL("./test-agent.mjs", import.meta.url))], env: {},
        } } },
    }, timeoutMs: 5000,
  });
  capture.restore();
  assert.equal(report.passed, true, JSON.stringify(report.results));
  for (const id of ["session/start-identity", "turn/lifecycle", "session/resume-identity", "stop/release-not-interrupted"]) {
    assert.equal(report.results.find((result) => result.id === id)?.status, "pass", id);
  }
  } finally { capture.restore(); rmSync(cwd, { recursive: true, force: true }); }
}
await checkBridge();
console.log("ACP bridge conformance passed: start, turn, release, resume.");
