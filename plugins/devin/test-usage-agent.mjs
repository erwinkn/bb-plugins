#!/usr/bin/env node
// Scripted CLI peer: only initialization is allowed; no session or model request.
import { mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
// Bridge runtime variables must not reach the CLI.
if (process.argv[2] !== "acp" || realpathSync(process.cwd()) !== realpathSync(process.env.XDG_CACHE_HOME) || "ELECTRON_RUN_AS_NODE" in process.env) process.exit(2);
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.method !== "initialize") process.exit(3);
  const dir = join(process.env.XDG_CACHE_HOME, "devin", "cli");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "user_status.abcd.bin"), JSON.stringify({
    version: 1, identity_digest: "abcd", fetched_at_secs: Date.now()/1000,
    payload: "ahEKBhIEVGVzdHBLiAGApKfaBg==",
  }));
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1 } }) + "\n");
});
