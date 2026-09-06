import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { withoutBridgeRuntimeEnv } from "@get-bb/plugin-sdk/provider-bridge";
import { decodeCachedUserStatus } from "./usage-codec";

const TIMEOUT_MS = 15_000;
const MAX_CACHE_BYTES = 2 * 1024 * 1024;
const envelopeSchema = z.object({ version: z.literal(1), identity_digest: z.string().min(1), fetched_at_secs: z.number().finite(), payload: z.string().min(1).regex(/^[A-Za-z0-9+/]+={0,2}$/) });

export async function readFreshUsageCache(cache: string): Promise<unknown | undefined> {
  const dir = join(cache, "devin", "cli");
  let names: string[];
  try { names = (await readdir(dir)).filter(name => /^user_status\.[a-f0-9]+\.bin$/.test(name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (names.length === 0) return undefined;
  // Initialization has one account context. Do not guess if a future CLI emits more.
  if (names.length !== 1) throw new Error("ambiguous account cache");
  const path = join(dir, names[0]!);
  if ((await stat(path)).size > MAX_CACHE_BYTES) throw new Error("usage cache too large");
  const envelope = envelopeSchema.parse(JSON.parse(await readFile(path, "utf8")));
  return decodeCachedUserStatus(Buffer.from(envelope.payload, "base64"));
}

export async function probeDevinUsage(command: string): Promise<unknown> {
  // mkdtemp is private. No existing cache or credential file is copied into it.
  const cache = await mkdtemp(join(tmpdir(), "bb-devin-usage-"));
  let child;
  try {
    child = spawn(command, ["acp"], {
      cwd: cache, env: { ...withoutBridgeRuntimeEnv(process.env), XDG_CACHE_HOME: cache },
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
  } catch (error) { await rm(cache, { recursive: true, force: true }); throw error; }
  let exited = false, failed = false, initialized = false;
  let pending = "";
  const exit = new Promise<void>(resolve => { child.once("close", () => { exited = true; resolve(); }); });
  child.on("error", () => { failed = true; });
  child.stdin.on("error", () => { failed = true; });
  child.stderr.resume(); // Never retain or log native diagnostic output.
  child.stdout.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    if (pending.length > MAX_CACHE_BYTES) { failed = true; child.kill(); return; }
    let newline;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        if (message.id === 1) {
          if (message.result?.protocolVersion === 1) initialized = true;
          else failed = true;
        }
      } catch { failed = true; }
    }
  });
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "bb-devin-usage", version: "0.1.0" },
    } }) + "\n");
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline && !failed && !exited) {
      if (initialized) {
        const usage = await readFreshUsageCache(cache);
        if (usage !== undefined) return usage;
      }
      await delay(100);
    }
    throw new Error("Devin usage probe failed");
  } finally {
    child.kill("SIGTERM");
    const forceKill = setTimeout(() => child.kill("SIGKILL"), 1000);
    try { await exit; } finally { clearTimeout(forceKill); await rm(cache, { recursive: true, force: true }); }
  }
}
