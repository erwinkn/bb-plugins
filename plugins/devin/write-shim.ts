import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { experimental_defineProviderBridge } from "@get-bb/plugin-sdk/provider-bridge";
import type { ProviderBridgeEntry } from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_acpLaunchSpecSchema } from "@get-bb/plugin-sdk/provider-bridge/acp";

// BB #3453: the shared ACP bridge answers fs/write_text_file with result:null,
// which the ACP schema forbids (WriteTextFileResponse is an object), so Devin's
// decoder reports "Parse error" on every successful write or edit. The bridge
// decodes the launch spec from providerOptions inside each bridge command, so
// this wrapper rewrites it to spawn a line-level stdio proxy that repairs just
// that response. Everything else passes through byte for byte.
const SHIM_FILE = "acp-write-result-shim.mjs";
export const SHIM_SOURCE = `// Rewrites result:null to {} on fs/write_text_file responses (BB #3453).
import { spawn } from "node:child_process";

const [command, ...agentArgs] = process.argv.slice(2);
if (command === undefined) {
  process.stderr.write("devin write shim: missing agent command\\n");
  process.exit(2);
}
const child = spawn(command, agentArgs, { stdio: ["pipe", "pipe", "inherit"] });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => { try { child.kill(signal); } catch { /* already gone */ } });
}
child.stdin.on("error", () => {});
process.stdout.on("error", () => {});
child.on("error", (error) => {
  process.stderr.write("devin write shim: cannot start " + command + ": " + error.message + "\\n");
  process.exit(127);
});
child.on("close", (code) => {
  // stdout's buffer was flushed on 'end'; release stdin so the loop drains.
  process.exitCode = code === null ? 1 : code;
  process.stdin.destroy();
});

const writeRequestIds = new Set();

function parseMessage(line) {
  try {
    const message = JSON.parse(line);
    return message !== null && typeof message === "object" && !Array.isArray(message) ? message : null;
  } catch {
    return null;
  }
}

function pipeLines(from, to, transform) {
  let pending = "";
  from.on("data", (chunk) => {
    const lines = (pending + chunk).split("\\n");
    pending = lines.pop();
    for (const line of lines) {
      if (!to.write(transform(line) + "\\n")) from.pause();
    }
  });
  to.on("drain", () => from.resume());
  from.on("end", () => {
    if (pending !== "") to.write(transform(pending));
    to.end();
  });
}

// Agent to bridge: remember the ids of fs/write_text_file requests.
pipeLines(child.stdout, process.stdout, (line) => {
  const message = parseMessage(line);
  if (message !== null && message.method === "fs/write_text_file" && message.id !== undefined && message.id !== null) {
    writeRequestIds.add(JSON.stringify(message.id));
  }
  return line;
});

// Bridge to agent: a null result on one of those ids becomes an empty object.
pipeLines(process.stdin, child.stdin, (line) => {
  const message = parseMessage(line);
  if (message !== null && message.method === undefined && message.id !== undefined && message.id !== null
      && writeRequestIds.delete(JSON.stringify(message.id))
      && "result" in message && message.result === null) {
    message.result = {};
    return JSON.stringify(message);
  }
  return line;
});
`;

export function withDevinWriteShim(acp: ProviderBridgeEntry): ProviderBridgeEntry {
  let shimPath: string | undefined;
  function ensureShim(dataDir: string): string | undefined {
    try {
      mkdirSync(dataDir, { recursive: true });
      const target = join(dataDir, SHIM_FILE);
      try {
        if (readFileSync(target, "utf8") === SHIM_SOURCE) return target;
      } catch { /* missing or unreadable: write it below */ }
      const temporary = join(dataDir, `.${SHIM_FILE}.${process.pid}.tmp`);
      writeFileSync(temporary, SHIM_SOURCE);
      renameSync(temporary, target);
      return target;
    } catch (error) {
      process.stderr.write(`Devin write shim was not installed; fs/write_text_file responses stay as the bridge sends them: ${error instanceof Error ? error.message : String(error)}\n`);
      return undefined;
    }
  }
  function shimmed(spec: unknown): unknown {
    const parsed = experimental_acpLaunchSpecSchema.safeParse(spec);
    if (!parsed.success || (parsed.data.command === process.execPath && parsed.data.args[0] === shimPath)) return spec;
    return { ...(spec as Record<string, unknown>), command: process.execPath, args: [shimPath, parsed.data.command, ...parsed.data.args] };
  }
  return experimental_defineProviderBridge({
    start(context) { shimPath = ensureShim(context.dataDir); return acp.start?.(context); },
    onClose: acp.onClose, onSigterm: acp.onSigterm, onSigint: acp.onSigint,
    handleLine(line) {
      if (shimPath === undefined || !line.includes("acpLaunchSpec")) { acp.handleLine(line); return; }
      let message;
      try { message = JSON.parse(line); } catch { acp.handleLine(line); return; }
      const params = message?.params;
      if (params === null || typeof params !== "object" || Array.isArray(params)) { acp.handleLine(line); return; }
      let changed = false;
      for (const container of [params.providerOptions, params.options?.providerOptions]) {
        if (container !== null && typeof container === "object" && "acpLaunchSpec" in container) {
          const next = shimmed(container.acpLaunchSpec);
          if (next !== container.acpLaunchSpec) { container.acpLaunchSpec = next; changed = true; }
        }
      }
      acp.handleLine(changed ? JSON.stringify(message) : line);
    },
  });
}
