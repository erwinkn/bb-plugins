import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract, loadRpcContract, type LoadSettings, type Machine } from "./lib/contract.js";
import { createLoadService } from "./lib/load-service.js";

const MACHINES_MAX_AGE_MS = 10_000;
const SAMPLE_TIMEOUT_MS = 10_000;

export default async function machineLoadPlugin(bb: BbPluginApi): Promise<void> {
  const settingsHandle = bb.settings.define({
    refreshSeconds: {
      type: "number",
      label: "Refresh interval (seconds)",
      description: "How often an open BB window reads the machine's load.",
      experimental_schema: z.number().int().min(1).max(60),
      default: 3,
    },
    warningPercent: {
      type: "number",
      label: "Warning at (%)",
      description: "CPU, memory, swap, disk, or load per core at or above this turns amber.",
      experimental_schema: z.number().int().min(1).max(100),
      default: 80,
    },
    criticalPercent: {
      type: "number",
      label: "Critical at (%)",
      description: "At or above this turns red.",
      experimental_schema: z.number().int().min(1).max(100),
      default: 95,
    },
  });
  const toSettings = (values: { refreshSeconds: number; warningPercent: number; criticalPercent: number }): LoadSettings => ({
    refreshMs: values.refreshSeconds * 1000,
    warningPercent: Math.min(values.warningPercent, values.criticalPercent),
    criticalPercent: values.criticalPercent,
  });
  let settings = toSettings(await settingsHandle.get());
  settingsHandle.onChange((next) => {
    settings = toSettings(next);
  });

  const host = bb.hosts.experimental_client({ contract: hostContract });

  let machines: { at: number; list: Promise<Machine[]> } | null = null;
  const listMachines = (): Promise<Machine[]> => {
    if (machines !== null && Date.now() - machines.at < MACHINES_MAX_AGE_MS) return machines.list;
    const list = Promise.all([bb.sdk.hosts.list(), bb.sdk.system.config()]).then(([hosts, config]) =>
      hosts.map((entry) => ({
        id: entry.id,
        name: entry.name,
        connected: entry.status === "connected",
        primary: entry.id === config.primaryHostId,
      })),
    );
    machines = { at: Date.now(), list };
    list.catch(() => {
      if (machines?.list === list) machines = null;
    });
    return list;
  };

  const service = createLoadService({
    listMachines,
    sampleMachine: (machineId, processes) =>
      host.call("sample", { processes }, { hostId: machineId, timeoutMs: SAMPLE_TIMEOUT_MS }),
    settings: () => settings,
    now: () => Date.now(),
  });

  bb.rpc.register(loadRpcContract, { load: (request) => service.load(request) });
}
