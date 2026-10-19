// Names shared by the server registration and the bridge.

import type { PluginProviderFallbackModel } from "@get-bb/plugin-sdk";

/** Stable provider id: thread rows persist it. */
export const MUSE_PROVIDER_ID = "muse";

/** Daemon variable naming the `muse` executable (default: PATH, then ~/.local/bin). */
export const MUSE_EXECUTABLE_ENV = "BB_MUSE_EXECUTABLE";

/**
 * The MCP server name bb's injected tools are served under. Muse names the
 * tools `mcp__bb_bridge__<tool>` (it turns `-` into `_`).
 */
export const BB_MCP_SERVER_NAME = "bb-bridge";

/** MSP client name: lowercase letters, digits and `_` only. */
export const MSP_CLIENT_NAME = "bb";

export const MUSE_DEFAULT_MODEL_ID = "muse-wonder-1.0";

const REASONING_FALLBACK = [
  { reasoningEffort: "low", description: "Quick answers" },
  { reasoningEffort: "medium", description: "Balanced" },
  { reasoningEffort: "high", description: "Thorough (Muse's default)" },
  { reasoningEffort: "xhigh", description: "Deep analysis" },
  { reasoningEffort: "max", description: "Maximum effort" },
] as const;

/** Shown only until the first `model/list` answer arrives. */
export const MUSE_FALLBACK_MODELS: PluginProviderFallbackModel[] = [
  {
    id: MUSE_DEFAULT_MODEL_ID,
    displayName: "Muse Wonder 1.0",
    description: "1008k-token context",
    supportedReasoningEfforts: REASONING_FALLBACK,
    defaultReasoningEffort: "high",
    isDefault: true,
  },
  {
    id: "muse-spark-1.3",
    displayName: "Muse Spark 1.3",
    description: "1008k-token context",
    supportedReasoningEfforts: REASONING_FALLBACK,
    defaultReasoningEffort: "high",
    isDefault: false,
  },
];
