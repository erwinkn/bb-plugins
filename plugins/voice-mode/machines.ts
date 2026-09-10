import type { BbPluginApi } from "@get-bb/plugin-sdk";

type Host = Awaited<ReturnType<BbPluginApi["sdk"]["hosts"]["list"]>>[number];

/** Use BB's configured primary host, never host order or repository counts. */
export async function resolveMachine(bb: BbPluginApi, hosts: readonly Host[], requestedHostId?: string): Promise<Host> {
  const hostId = requestedHostId ?? (await bb.sdk.system.config()).primaryHostId;
  if (!hostId) throw new Error("BB has no primary machine. Use list_machines to choose a connected machine.");
  const host = hosts.find(host => host.id === hostId);
  if (!host || host.status !== "connected") {
    throw new Error(`${requestedHostId ? "The selected" : "BB's primary"} machine is not connected. Use list_machines to choose a connected machine.`);
  }
  return host;
}

export async function listMachines(bb: BbPluginApi) {
  const [hosts, config] = await Promise.all([bb.sdk.hosts.list(), bb.sdk.system.config()]);
  return {
    defaultHostId: config.primaryHostId,
    machines: hosts.map(host => ({ id: host.id, name: host.name, status: host.status, isDefault: host.id === config.primaryHostId })),
  };
}
