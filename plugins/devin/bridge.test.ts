import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { experimental_captureBridgeJsonRpcOutput, experimental_runBridgeConformance } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { experimental_providerBridge } from "./host";

async function checkBridge() {
  const cwd = mkdtempSync(join(tmpdir(), "bb-devin-conformance-"));
  const capture = experimental_captureBridgeJsonRpcOutput();
  try {
  const report = await experimental_runBridgeConformance({
    providerId: "acp-devin",
    transport: { send: experimental_providerBridge.handleLine, takeMessages: capture.takeMessages },
    session: {
      cwd, promptInput: [{ type: "text", text: "say hello", mentions: [] }],
      options: { permissionMode: "full", permissionScope: "full", approvalReviewer: null, permissionEscalation: null,
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
