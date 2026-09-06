import { execFile } from "node:child_process";
import { withoutBridgeRuntimeEnv } from "@get-bb/plugin-sdk/provider-bridge";
import { buildDevinModels } from "./models";

export async function loadDevinModels(command: string, signal?: AbortSignal) {
  const output = await new Promise<string>((resolve, reject) => {
    execFile(command, ["models", "list", "--format", "json"], {
      env: withoutBridgeRuntimeEnv(process.env), timeout: 15_000, killSignal: "SIGKILL",
      maxBuffer: 2 * 1024 * 1024, signal,
    }, (error, stdout) => error ? reject(new Error("Devin model list failed. Check devin auth status and the executable setting.")) : resolve(stdout));
  });
  try { return buildDevinModels(JSON.parse(output)); }
  catch { throw new Error("Devin returned an unsupported model catalog. Update the CLI or plugin."); }
}
