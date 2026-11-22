/**
 * The BB names this bridge uses, all from the public plugin SDK.
 *
 * Upstream (`~/Code/bb/packages/provider-bridge-acp`) imports them from BB's private workspace
 * packages (`@bb/domain`, `@bb/provider-bridge-protocol`, its `bridge-kit`). The SDK ships the
 * same code, some of it under an `experimental_` name; this module gives each its upstream name
 * so the ported files keep their imports one rename away from upstream. The few names the SDK
 * does not export are defined here, copied from upstream.
 */
import {
  decodeToolCallResponsePayload,
  dynamicToolSchema as sdkDynamicToolSchema,
} from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";

export {
  BRIDGE_INBOUND_REQUEST_METHODS,
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3,
  THREAD_DELTA_NOTIFICATION_METHOD,
  acpNativeReasoningSchema,
  acpPermissionCliSchema,
  acpReasoningCliSchema,
  bridgeRequestEnvelopeSchema,
  createBridgeIo,
  createBridgeLineHandler,
  createProviderVisibilityMetadata,
  decodeBridgeJsonRpcResponse,
  decodeToolCallResponsePayload,
  errorEnvelopeSchema,
  experimental_BridgeRecoveryError as BridgeRecoveryError,
  experimental_COMPACTION_PRESENTATION as COMPACTION_PRESENTATION,
  experimental_REASONING_PRESENTATION as REASONING_PRESENTATION,
  experimental_buildBridgeToolCallContent as buildBridgeToolCallContent,
  experimental_clampPercent as clampPercent,
  experimental_defineProviderBridge,
  experimental_downloadedInstallerCommand as downloadedInstallerCommand,
  experimental_fileReadPresentation as fileReadPresentation,
  experimental_planStepsPresentation as planStepsPresentation,
  experimental_presentationFileName as presentationFileName,
  experimental_presentationTitle as presentationTitle,
  experimental_readCliVersion as readCliVersion,
  experimental_recordProviderChildIo,
  experimental_resolveExecutablePath as resolveExecutablePath,
  experimental_searchPresentation as searchPresentation,
  experimental_spawnPortableProcess as spawnPortableProcess,
  experimental_killPortableProcess as killPortableProcess,
  experimental_toolPresentation as toolPresentation,
  experimental_webFetchPresentation as webFetchPresentation,
  experimental_withTitle as withTitle,
  extractResultText,
  getStringProperty,
  hostDaemonAcpLaunchSpecSchema as acpLaunchSpecSchema,
  initializeParamsSchema,
  isApprovalPendingInteractionPayload,
  isApprovalPendingInteractionResolution,
  isRecord,
  isStandaloneBuiltinCompactCommand,
  jsonRpcEnvelopeSchema,
  mimeTypeFromExtension,
  modelListParamsSchema,
  normalizeHostDaemonAcpLaunchSpec as normalizeAcpLaunchSpec,
  pendingInteractionResolutionSchema,
  providerInstallationRunParamsSchema,
  providerInstallationStatusParamsSchema,
  providerMaintenanceParamsSchema,
  providerRawEventSchema,
  reasoningEffortsForLevels,
  reasoningLevelValues,
  runBridgeRequest,
  skillsConfigureParamsSchema,
  threadDiscardParamsSchema,
  threadForkParamsSchema,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  toOptionalString,
  turnStartParamsSchema,
  turnSteerParamsSchema,
  withoutBridgeRuntimeEnv,
} from "@get-bb/plugin-sdk/provider-bridge";

export type {
  AvailableModel,
  BridgeJsonRpcResponse,
  DeltaFileChange,
  DeltaItemShape,
  DeltaNoTurnFallback,
  DeltaPresentation,
  HostDaemonAcpLaunchSpec as AcpLaunchSpec,
  InitializeResult,
  JsonRpcMessage,
  PendingInteractionApprovalDecision,
  PendingInteractionApprovalSubject,
  PendingInteractionPayload,
  PendingInteractionResolution,
  PermissionMode,
  PromptInput,
  ProviderHealthResult,
  ProviderInstallationRunResult,
  ProviderInstallationStatus,
  ProviderRawEvent,
  ProviderRawEventDescription,
  ProviderRuntimeEvent,
  ProviderUsage,
  ProviderUsageResult,
  ProviderUsageWindow,
  ProviderVisibilityMetadata,
  ReasoningLevel,
  ServiceTier,
  ThreadDelta,
  ThreadEventItemStatus,
  ThreadEventPlanStep,
  ThreadEventTurnStatus,
} from "@get-bb/plugin-sdk/provider-bridge";

type DecodedToolCallResponse = ReturnType<typeof decodeToolCallResponsePayload>;
export type BridgeToolCallContent =
  DecodedToolCallResponse["contentBlocks"][number];
export type BridgeToolCallImage = DecodedToolCallResponse["images"][number];

/** The runtime's notice that the bridge gave up on one of its own requests (a tool call). */
export const PROVIDER_TOOL_CALL_CANCELLED_METHOD = "notifications/cancelled";
export const providerToolCallCancellationSchema = z.object({
  requestId: z.union([z.string(), z.number().int()]),
});

/**
 * A thread's dynamic tool. The SDK's 0.6.15 schema predates `alwaysLoad` (a tool the agent must
 * not defer), which BB sends and the MCP proxy advertises; parsing with the SDK's schema alone
 * would strip it.
 */
export const dynamicToolSchema = sdkDynamicToolSchema.extend({
  alwaysLoad: z.boolean().optional(),
});
export type DynamicTool = z.infer<typeof dynamicToolSchema>;
