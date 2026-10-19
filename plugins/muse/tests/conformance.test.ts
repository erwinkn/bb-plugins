import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import {
  type CapturedBridgeJsonRpcOutput,
  experimental_captureBridgeJsonRpcOutput as captureBridgeJsonRpcOutput,
  experimental_formatConformanceReport as formatConformanceReport,
  experimental_runBridgeConformance as runBridgeConformance,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { handleLine, shutdown } from "../src/bridge.js";
import { COMPACT_INPUT, useFakeMuse } from "./harness.js";

useFakeMuse();

let output: CapturedBridgeJsonRpcOutput;
let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "bb-muse-conformance-"));
  output = captureBridgeJsonRpcOutput();
});

afterEach(() => {
  output.restore();
  rmSync(workspace, { recursive: true, force: true });
});

afterAll(shutdown);

it("passes the canonical protocol suite", async () => {
  const report = await runBridgeConformance({
    transport: { send: handleLine, takeMessages: output.takeMessages },
    providerId: "muse",
    session: {
      cwd: workspace,
      promptInput: [{ type: "text", text: "say hello", mentions: [] }],
      // Muse answers /compact on a fresh session with "noop": a turn that does no work.
      zeroWorkPromptInput: COMPACT_INPUT,
    },
    timeoutMs: 10_000,
  });
  output.restore();
  const statusById = Object.fromEntries(report.results.map((result) => [result.id, result.status]));
  expect(statusById, formatConformanceReport(report)).toEqual({
    "rpc/unknown-method": "pass",
    "rpc/invalid-params": "pass",
    "rpc/non-json-ignored": "pass",
    "rpc/response-not-request": "pass",
    "handshake/initialize": "pass",
    "skills/configure-declared": "pass",
    "session/start-identity": "pass",
    "session/start-identity-announced": "pass",
    "turn/lifecycle": "pass",
    "events/schema-valid": "pass",
    "item/opens-before-delta": "pass",
    "stop/release-not-interrupted": "pass",
    "session/resume-identity": "pass",
    "session/resume-id-uniqueness": "pass",
    "turn/settles-without-activity": "pass",
  });
  expect(report.passed).toBe(true);
}, 60_000);
