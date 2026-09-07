import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** Settings and creation use the same automatic target. Existing threads retain their host. */
export async function coordinatorHost(bb: BbPluginApi) {
  const [projects, hosts] = await Promise.all([
    bb.sdk.projects.list({ includePersonal: true }), bb.sdk.hosts.list(),
  ]);
  const personal = projects.find(project => project.kind === "personal");
  if (!personal) throw new Error("BB has no personal project to host the voice coordinator.");
  const connected = hosts.filter(host => host.status === "connected");
  const source = personal.sources.find(source => source.isDefault) ?? personal.sources[0];
  const host = connected.find(host => host.id === source?.hostId) ?? connected[0];
  if (!host) throw new Error("No connected machine can run the voice coordinator.");
  return { personal, host };
}

export async function coordinatorOptions(bb: BbPluginApi, providerId: string, model: string | null) {
  const { personal, host } = await coordinatorHost(bb);
  const providers = await bb.sdk.providers.list({hostId:host.id});
  const provider = providers.find(provider => provider.id === providerId && provider.available);
  if (!provider) throw new Error(`Coordinator provider ${providerId} is unavailable on ${host.name}.`);
  const catalog = await bb.sdk.providers.models({providerId,hostId:host.id});
  if (catalog.modelLoadError) throw new Error(`Could not load coordinator models: ${catalog.modelLoadError.code}.`);
  const models = catalog.models.filter(candidate => !candidate.routeProviderId || candidate.routeProviderId === providerId);
  const selected = model ? models.find(candidate => candidate.id === model || candidate.model === model) : models.find(candidate => candidate.isDefault) ?? models[0];
  if (!selected) throw new Error(`Coordinator model ${model ?? "(default)"} is not in the provider catalog.`);
  const serviceTiers = catalog.providers?.find(provider => provider.id === providerId)?.serviceTiers ?? [];
  return { personal, host, selected, serviceTiers };
}
