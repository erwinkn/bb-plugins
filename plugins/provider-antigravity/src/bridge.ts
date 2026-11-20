import {
  BRIDGE_JSON_RPC_ERRORS,
  bridgeRequestEnvelopeSchema,
  createBridgeIo,
  experimental_defineProviderBridge,
  providerMaintenanceParamsSchema,
  runBridgeRequest,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { ProviderBridgeEntry, ProviderUsageResult } from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import type { AntigravityService } from "./agy.js";
import { PROVIDER_ID } from "./contract.js";
import type { UsageState } from "./contract.js";

const USAGE_METHOD = "provider/usage";
const emailSchema = z.email();

type BridgeUsage = Extract<ProviderUsageResult, { supported: true }>["usage"];

/** The usage `agy` reported, in the shape bb's `provider/usage` request answers with. */
export function bridgeUsage(state: UsageState): BridgeUsage {
  switch (state.status) {
    case "ok":
      return {
        status: "ok",
        accountEmail: emailSchema.safeParse(state.accountEmail).success ? state.accountEmail : null,
        planLabel: null,
        windows: state.windows.flatMap((window) =>
          window.label.trim() && Number.isFinite(window.usedPercent)
            ? [
                {
                  label: window.label,
                  usedPercent: Math.min(100, Math.max(0, window.usedPercent)),
                  resetsAt: window.resetsAt || null,
                },
              ]
            : [],
        ),
      };
    case "not_installed":
    case "unauthenticated":
    case "expired":
      return { status: state.status };
    case "error":
      return { status: "error", message: state.message.trim() || "Unknown error", planLabel: null, accountEmail: null };
  }
}

async function usageResult(service: Pick<AntigravityService, "usage">): Promise<ProviderUsageResult> {
  try {
    return { supported: true, usage: bridgeUsage(await service.usage()) };
  } catch (error) {
    const message = error instanceof Error ? error.message.trim() : "";
    return {
      supported: true,
      usage: { status: "error", message: message || "Unknown error", planLabel: null, accountEmail: null },
    };
  }
}

/**
 * Wraps the ACP bridge to answer `provider/usage` from `agy /usage`. Every other
 * line, and the lifecycle hooks, belong to the ACP bridge; shutdown also
 * disposes the service.
 */
export function withAntigravityUsage(
  inner: ProviderBridgeEntry,
  service: Pick<AntigravityService, "usage" | "dispose">,
  write?: (line: string) => void,
  raise: (signal: NodeJS.Signals) => void = (signal) => process.kill(process.pid, signal),
): ProviderBridgeEntry {
  const io = createBridgeIo({ write });
  const disposeThen = (hook: (() => void) | undefined) => () => {
    try {
      service.dispose();
    } finally {
      hook?.();
    }
  };
  // A signal listener replaces Node's default termination. When the inner
  // bridge has no hook of its own, dispose and then restore that default: the
  // worker registers its listeners with `once`, so raising the signal again
  // ends the process as it would have without us.
  const onSignal = (hook: (() => void) | undefined, signal: NodeJS.Signals) =>
    hook
      ? disposeThen(hook)
      : () => {
          try {
            service.dispose();
          } finally {
            raise(signal);
          }
        };

  return experimental_defineProviderBridge({
    start: inner.start,
    onClose: disposeThen(inner.onClose),
    onSigterm: onSignal(inner.onSigterm, "SIGTERM"),
    onSigint: onSignal(inner.onSigint, "SIGINT"),
    handleLine(line) {
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        inner.handleLine(line);
        return;
      }
      const request = bridgeRequestEnvelopeSchema.safeParse(json);
      if (!request.success || request.data.method !== USAGE_METHOD) {
        inner.handleLine(line);
        return;
      }
      const { id, params } = request.data;
      const maintenance = providerMaintenanceParamsSchema.safeParse(params);
      if (!maintenance.success) {
        io.sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, "Invalid Antigravity usage parameters.");
        return;
      }
      if (maintenance.data.providerId !== PROVIDER_ID) {
        io.sendResult(id, { supported: false });
        return;
      }
      runBridgeRequest({
        request: request.data,
        sendError: io.sendError,
        handleRequest: async ({ id: requestId }) => {
          io.sendResult(requestId, await usageResult(service));
        },
      });
    },
  });
}
