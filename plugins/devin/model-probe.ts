import { execFile } from "node:child_process";
import { withoutBridgeRuntimeEnv } from "@get-bb/plugin-sdk/provider-bridge";
import { buildDevinModels } from "./models";

// Returns the validated raw catalog JSON so it can be persisted as received.
export async function fetchDevinCatalog(command: string, signal?: AbortSignal): Promise<unknown> {
  const output = await new Promise<string>((resolve, reject) => {
    execFile(command, ["models", "list", "--format", "json"], {
      env: withoutBridgeRuntimeEnv(process.env), timeout: 15_000, killSignal: "SIGKILL",
      maxBuffer: 2 * 1024 * 1024, signal,
    }, (error, stdout) => error ? reject(new Error("Devin model list failed. Check devin auth status and the executable setting.")) : resolve(stdout));
  });
  try { const raw: unknown = JSON.parse(output); buildDevinModels(raw); return raw; }
  catch { throw new Error("Devin returned an unsupported model catalog. Update the CLI or plugin."); }
}
