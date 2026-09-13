import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { experimental_defineProviderBridge } from "@get-bb/plugin-sdk/provider-bridge";
import { SHIM_SOURCE, withDevinWriteShim } from "./write-shim";

test("the shim repairs result:null on fs/write_text_file responses only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bb-devin-write-shim-"));
  const proc = spawn(process.execPath, [
    (() => { const shim = join(dir, "shim.mjs"); writeFileSync(shim, SHIM_SOURCE); return shim; })(),
    process.execPath,
    fileURLToPath(new URL("./test-write-agent.mjs", import.meta.url)),
  ], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    const lines: string[] = [];
    const waiters: ((line: string) => void)[] = [];
    createInterface({ input: proc.stdout }).on("line", (line) => {
      const waiter = waiters.shift();
      if (waiter) waiter(line); else lines.push(line);
    });
    const next = (): Promise<string> => lines.length
      ? Promise.resolve(lines.shift()!)
      : new Promise((resolve) => waiters.push(resolve));
    const send = (value: unknown) => proc.stdin.write(JSON.stringify(value) + "\n");
    const echo = async () => JSON.parse((JSON.parse(await next())).params.received);

    assert.equal((JSON.parse(await next())).method, "fs/write_text_file");
    assert.equal((JSON.parse(await next())).method, "fs/write_text_file");
    assert.equal((JSON.parse(await next())).method, "fs/read_text_file");
    assert.equal((JSON.parse(await next())).method, "session/update");
    assert.equal(await next(), "not json from agent");

    send({ jsonrpc: "2.0", id: 7, result: null });
    assert.deepEqual((await echo()).result, {});
    send({ jsonrpc: "2.0", id: 8, error: { code: -32603, message: "nope" } });
    assert.equal((await echo()).error.message, "nope");
    send({ jsonrpc: "2.0", id: "nine", result: null });
    assert.equal((await echo()).result, null);
    send({ jsonrpc: "2.0", id: 7, result: null });
    assert.equal((await echo()).result, null);
    proc.stdin.write("noise from bridge\n");
    assert.equal((JSON.parse(await next())).params.received, "noise from bridge");

    // A multi-byte character split across writes must not become U+FFFD.
    const utf8Line = JSON.stringify({ jsonrpc: "2.0", method: "test/noise", params: { text: "héllo → ✓" } });
    const bytes = Buffer.from(utf8Line + "\n", "utf8");
    const cut = bytes.indexOf(0xc3); // é = 0xC3 0xA9; the first write ends mid-character
    proc.stdin.write(bytes.subarray(0, cut + 1));
    proc.stdin.write(bytes.subarray(cut + 1));
    assert.equal((JSON.parse(await next())).params.received, utf8Line);

    proc.stdin.end();
    const [code] = await once(proc, "exit");
    assert.equal(code, 0);
  } finally {
    proc.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("start installs the shim and launch specs route the agent through it", () => {
  const dir = mkdtempSync(join(tmpdir(), "bb-devin-shim-context-"));
  try {
    const captured: string[] = [];
    const bridge = withDevinWriteShim(experimental_defineProviderBridge({ handleLine: (line) => captured.push(line) }));
    bridge.start?.({ pluginId: "devin", dataDir: dir, tempDir: dir });
    const shimPath = join(dir, "acp-write-result-shim.mjs");
    assert.equal(readFileSync(shimPath, "utf8"), SHIM_SOURCE);

    const launch = { displayName: "Devin", command: "devin", args: ["acp"], env: {} };
    bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "thread/start",
      params: { threadId: "t1", cwd: "/w", options: { model: "devin-family:x", providerOptions: { acpDialect: "generic", acpLaunchSpec: launch } } } }));
    const start = JSON.parse(captured[0]);
    assert.equal(start.params.options.providerOptions.acpLaunchSpec.command, process.execPath);
    assert.deepEqual(start.params.options.providerOptions.acpLaunchSpec.args, [shimPath, "devin", "acp"]);
    assert.equal(start.params.options.providerOptions.acpLaunchSpec.displayName, "Devin");
    assert.equal(start.params.options.providerOptions.acpDialect, "generic");
    assert.equal(start.params.options.model, "devin-family:x");

    bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "provider/health",
      params: { providerId: "acp-devin", providerOptions: { acpLaunchSpec: launch } } }));
    assert.equal(JSON.parse(captured[1]).params.providerOptions.acpLaunchSpec.command, process.execPath);

    const plain = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "turn/start", params: { threadId: "t1" } });
    bridge.handleLine(plain);
    assert.equal(captured[2], plain);
    bridge.handleLine("not json acpLaunchSpec");
    assert.equal(captured[3], "not json acpLaunchSpec");
    bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "thread/start",
      params: { options: { providerOptions: { acpLaunchSpec: { command: 5 } } } } }));
    assert.equal(JSON.parse(captured[4]).params.options.providerOptions.acpLaunchSpec.command, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("before start the bridge sees every line untouched", () => {
  const captured: string[] = [];
  const bridge = withDevinWriteShim(experimental_defineProviderBridge({ handleLine: (line) => captured.push(line) }));
  const line = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "thread/start",
    params: { options: { providerOptions: { acpLaunchSpec: { displayName: "Devin", command: "devin", args: ["acp"], env: {} } } } } });
  bridge.handleLine(line);
  assert.equal(captured[0], line);
});
