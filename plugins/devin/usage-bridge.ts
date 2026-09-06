import {
  createBridgeIo, experimental_defineProviderBridge, providerMaintenanceParamsSchema,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { ProviderBridgeEntry, ProviderUsageResult } from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_acpLaunchSpecSchema } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { getDevinUsage } from "./usage";
import { PROVIDER_ID } from "./provider";

// Override only the sessionless maintenance request. All ACP lifecycle and
// session traffic stays owned by the SDK, including native context updates.
export function withDevinUsage(acp: ProviderBridgeEntry, usage = getDevinUsage, write?: (line: string) => void): ProviderBridgeEntry {
  const io = createBridgeIo({ write });
  // Overlapping refreshes share one CLI probe per command instead of stacking processes.
  const inflight = new Map<string, Promise<ProviderUsageResult>>();
  function shared(command: string) {
    const existing = inflight.get(command);
    if (existing) return existing;
    const result = usage(command).finally(() => inflight.delete(command));
    inflight.set(command, result);
    return result;
  }
  return experimental_defineProviderBridge({
    start: acp.start, onClose: acp.onClose, onSigterm: acp.onSigterm, onSigint: acp.onSigint,
    handleLine(line) {
      let message;
      try { message = JSON.parse(line); } catch { acp.handleLine(line); return; }
      if (message?.method !== "provider/usage") { acp.handleLine(line); return; }
      if (message.jsonrpc !== "2.0" || (typeof message.id !== "string" && typeof message.id !== "number")) {
        acp.handleLine(line); return;
      }
      const params = providerMaintenanceParamsSchema.safeParse(message.params);
      const launch = experimental_acpLaunchSpecSchema.safeParse(params.success ? params.data.providerOptions?.acpLaunchSpec : undefined);
      if (!params.success || !launch.success) { io.sendError(message.id, -32602, "Invalid Devin usage parameters."); return; }
      if (params.data.providerId !== PROVIDER_ID) { io.sendResult(message.id, { supported: false }); return; }
      void shared(launch.data.command).then(
        (result) => io.sendResult(message.id, result),
        () => io.sendError(message.id, -32603, "Devin usage could not be loaded."),
      );
    },
  });
}
