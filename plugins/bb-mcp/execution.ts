import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { assertScope, executionPermission, ids, ToolError, type Config } from "./config";

type Spawn = Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];
export type ExecutionInput = Pick<Spawn, "model" | "reasoningLevel" | "permissionMode" | "serviceTier">;
type Defaults = ExecutionInput & { providerId?: string };
type Selection = ExecutionInput & {
  projectId: string; hostId: string; environmentId?: string; providerId?: string;
  defaults?: Defaults | null; parentCeiling?: string;
};

export async function selectInheritedSend(bb: BbPluginApi, c: Config, args: Selection) {
  // Ordinary follow-ups can queue while a host is offline. Keep BB's own
  // model/reasoning defaults instead of requiring a fresh model-catalog RPC.
  const routing = args.environmentId ? { environmentId: args.environmentId } : { hostId: args.hostId };
  const [hosts, providers] = await Promise.all([bb.sdk.hosts.list(), bb.sdk.providers.list(routing)]);
  const provider = providers.find(p => p.id === args.providerId && (!ids(c.providerIds).length || ids(c.providerIds).includes(p.id)));
  if (!provider) throw new ToolError("invalid_provider", "This thread's provider is outside the configured execution scope.");
  const maximum = executionPermission(provider.capabilities.permissionModes, c.permissionMode, hosts.find(h => h.id === args.hostId)?.maxPermissionMode, args.parentCeiling);
  const permissionMode = args.permissionMode === undefined
    ? executionPermission(provider.capabilities.permissionModes, maximum, args.defaults?.permissionMode)
    : executionPermission([args.permissionMode], maximum);
  if (!provider.capabilities.permissionModes.includes(permissionMode)) throw new ToolError("unsupported_permissions", "The provider does not support the requested permission mode.");
  return { providerId: provider.id, permissionMode };
}

export async function selectExecution(bb: BbPluginApi, c: Config, args: Selection) {
  assertScope(c, args.projectId, args.hostId);
  const host = (await bb.sdk.hosts.list()).find(h => h.id === args.hostId);
  if (host?.status !== "connected") throw new ToolError("host_offline", "The selected execution host is offline.");
  const routing = args.environmentId ? { environmentId: args.environmentId } : { hostId: args.hostId };
  const providers = (await bb.sdk.providers.list(routing)).filter(p => p.available && (!ids(c.providerIds).length || ids(c.providerIds).includes(p.id)));
  const defaults = args.defaults ?? await bb.sdk.projects.defaultExecutionOptions({ projectId: args.projectId });
  const provider = providers.find(p => p.id === (args.providerId ?? defaults?.providerId)) ?? (!args.providerId ? providers[0] : undefined);
  if (!provider) throw new ToolError("invalid_provider", "Choose an available provider from bb_list_runtimes.");
  const catalog = await bb.sdk.providers.models({ ...routing, providerId: provider.id });
  if (catalog.modelLoadError) throw new ToolError("catalog_unavailable", `Model catalog unavailable (${catalog.modelLoadError.code}).`);
  const sameProvider = defaults?.providerId === provider.id;
  const selected = args.model ?? (sameProvider ? defaults?.model : undefined);
  const entry = catalog.models.find(m => m.model === selected || m.id === selected)
    ?? (!args.model ? catalog.models.find(m => m.isDefault) ?? catalog.models[0] : undefined);
  if (!entry) throw new ToolError("invalid_model", "Choose a model from bb_list_runtimes.");
  const supportsReasoning = (level: string) => entry.supportedReasoningEfforts.some(e => e.reasoningEffort === level);
  if (args.reasoningLevel !== undefined && !supportsReasoning(args.reasoningLevel))
    throw new ToolError("invalid_reasoning", "The selected model does not support this reasoning level.");
  const inheritedReasoning = sameProvider && defaults?.model === entry.model && defaults.reasoningLevel && supportsReasoning(defaults.reasoningLevel)
    ? defaults.reasoningLevel : entry.defaultReasoningEffort;
  const maximum = executionPermission(provider.capabilities.permissionModes, c.permissionMode, host.maxPermissionMode, args.parentCeiling);
  const permissionMode = args.permissionMode === undefined
    ? executionPermission(provider.capabilities.permissionModes, maximum, defaults?.permissionMode)
    : executionPermission([args.permissionMode], maximum);
  if (!provider.capabilities.permissionModes.includes(permissionMode))
    throw new ToolError("unsupported_permissions", "The provider does not support the requested permission mode.");
  const serviceTier = args.serviceTier ?? (sameProvider ? defaults?.serviceTier : undefined) ?? "default";
  if (serviceTier !== "default" && (!provider.capabilities.supportsServiceTier || (provider.serviceTiers?.length && !provider.serviceTiers.some(t => t.id === serviceTier))))
    throw new ToolError("invalid_service_tier", "The provider does not support this service tier.");
  return { providerId: provider.id, model: entry.model, reasoningLevel: args.reasoningLevel ?? inheritedReasoning, permissionMode, serviceTier };
}
