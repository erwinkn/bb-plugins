import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { resolveMachine } from "./machines.ts";

export const providerCatalogSchema = z.object({
  providers:z.array(z.object({id:z.string(),displayName:z.string(),available:z.boolean(),serviceTiers:z.array(z.object({id:z.string(),label:z.string()}).strict())}).strict()),
  models:z.array(z.object({providerId:z.string(),id:z.string(),model:z.string(),displayName:z.string(),isDefault:z.boolean(),reasoningLevels:z.array(z.object({id:z.string(),label:z.string()}).strict()),defaultReasoningLevel:z.string().nullable()}).strict()),
}).strict();
export const workerCatalogSchema = providerCatalogSchema.extend({
  hostId:z.string().nullable(), hosts:z.array(z.object({id:z.string(),name:z.string()}).strict()),
});
export type WorkerCatalog = z.infer<typeof workerCatalogSchema>;

/** Model availability is machine-specific; this is a settings preview, not execution authorization. */
export async function loadWorkerCatalog(bb: BbPluginApi, requestedHostId?: string): Promise<WorkerCatalog> {
  const allHosts = await bb.sdk.hosts.list();
  const hosts = allHosts.filter(host=>host.status === "connected").map(host=>({id:host.id,name:host.name}));
  if (!hosts.length) {
    if (requestedHostId) throw new Error("The selected worker machine is no longer connected.");
    return {hostId:null,hosts,providers:[],models:[]};
  }
  const selectedHostId = requestedHostId ?? (await bb.sdk.system.config()).primaryHostId;
  // Keep the machine selector usable when the default is offline, without
  // previewing another machine's models as though it were the default.
  if (!requestedHostId && !hosts.some(host => host.id === selectedHostId)) return {hostId:null,hosts,providers:[],models:[]};
  const host = await resolveMachine(bb, allHosts, selectedHostId ?? undefined);
  const providers = await bb.sdk.providers.list({hostId:host.id});
  const catalogs = await Promise.all(providers.map(async provider => {
    const catalog = provider.available ? await bb.sdk.providers.models({providerId:provider.id,hostId:host.id}) : null;
    if (catalog?.modelLoadError) throw new Error(`Could not load ${provider.displayName ?? provider.id} models: ${catalog.modelLoadError.code}.`);
    return {provider,catalog};
  }));
  return {hostId:host.id,hosts,
    providers:catalogs.map(({provider,catalog})=>({id:provider.id,displayName:provider.displayName ?? provider.id,available:provider.available,
      serviceTiers:(catalog?.providers?.find(item=>item.id === provider.id)?.serviceTiers ?? []).map(tier=>({id:tier.id,label:tier.label}))})),
    models:catalogs.flatMap(({provider,catalog})=>(catalog?.models ?? []).filter(model=>!model.routeProviderId || model.routeProviderId === provider.id).map(model=>({
      providerId:provider.id,id:model.id,model:model.model,displayName:model.displayName,isDefault:model.isDefault,
      reasoningLevels:(model.supportedReasoningEfforts ?? []).map(effort=>({id:effort.reasoningEffort,label:effort.reasoningEffort})),defaultReasoningLevel:model.defaultReasoningEffort ?? null,
    }))),
  };
}
