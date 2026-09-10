import type { BbPluginApi } from "@get-bb/plugin-sdk";
type SpawnArgs = Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];
export type ExecutionInput = Pick<SpawnArgs, "model" | "reasoningLevel" | "permissionMode" | "serviceTier">;

// Preserve explicit choices and their native provenance. BB resolves omitted
// defaults and enforces host/provider/parent policy at the actual dispatch.
export function executionOptions(args: ExecutionInput & { providerId?: string }) {
  return Object.fromEntries(["providerId", "model", "reasoningLevel", "permissionMode", "serviceTier"]
    .filter(key => args[key as keyof typeof args] !== undefined)
    .map(key => [key, args[key as keyof typeof args]])) as ExecutionInput & { providerId?: string };
}
export function executionSources(args: ExecutionInput & { providerId?: string }): NonNullable<SpawnArgs["executionInputSources"]> {
  return {
    ...(args.providerId !== undefined ? { providerId: "explicit" } : {}),
    ...(args.model !== undefined ? { model: "explicit" } : {}),
    ...(args.reasoningLevel !== undefined ? { reasoningLevel: "explicit" } : {}),
    ...(args.permissionMode !== undefined ? { permissionMode: "explicit" } : {}),
    ...(args.serviceTier !== undefined ? { serviceTier: "explicit" } : {}),
  };
}
