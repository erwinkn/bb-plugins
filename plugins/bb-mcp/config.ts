import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const ids = (value: string) => [...new Set(value.split(/[\s,]+/).filter(Boolean))];
const idList = z.string().max(8192).refine(v => ids(v).every(id => /^[a-zA-Z0-9_-]+$/.test(id)), "Use comma-separated BB IDs.");
const positive = (max: number) => z.number().int().min(1).max(max);
export function defineSettings(bb: BbPluginApi) {
  return bb.settings.define({
    projectIds: { type: "string", label: "Allowed project IDs", default: "", experimental_schema: idList },
    hostIds: { type: "string", label: "Allowed host IDs", default: "", experimental_schema: idList },
    defaultHostId: { type: "string", label: "Default execution host ID", default: "" },
    providerIds: { type: "string", label: "Allowed providers (empty: all installed)", default: "", experimental_schema: idList },
    appUrl: { type: "string", label: "BB public app URL", default: "", experimental_schema: z.string().refine(v => !v || validUrl(v), "Use an HTTPS URL without credentials or a query.") },
    endpointUrl: { type: "string", label: "Public MCP endpoint URL", default: "", experimental_schema: z.string().refine(v => !v || validUrl(v), "Use an HTTPS URL without credentials or a query.") },
    permissionMode: { type: "select", label: "Maximum execution permission mode", options: ["accept-edits", "auto", "full"], default: "auto" },
    requestsPerMinute: { type: "number", label: "MCP requests per minute", default: 120, experimental_schema: positive(1000) },
    createsPerHour: { type: "number", label: "New threads per hour", default: 20, experimental_schema: positive(200) },
    maxPendingOperations: { type: "number", label: "Concurrent create/send requests", default: 4, experimental_schema: positive(16) },
  });
}
function validUrl(value: string) {
  try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash; }
  catch { return false; }
}
export type Settings = ReturnType<typeof defineSettings>;
export type Config = Awaited<ReturnType<Settings["get"]>>;
export class ToolError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export function requireConfigured(c: Config) {
  if (!ids(c.projectIds).length || !ids(c.hostIds).includes(c.defaultHostId))
    throw new ToolError("not_configured", "Configure allowed project IDs, host IDs, and a default host in BB MCP settings.");
}
export function assertScope(c: Config, projectId: string, hostId?: string) {
  requireConfigured(c);
  if (!ids(c.projectIds).includes(projectId) || (hostId !== undefined && !ids(c.hostIds).includes(hostId)))
    throw new ToolError("not_found", "The requested resource is unavailable in this connection's scope.");
}
export function threadUrl(c: Config, projectId: string, threadId: string) {
  return c.appUrl ? new URL(`/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(threadId)}`, c.appUrl).href : null;
}
export function executionPermission(allowed: string[], ceiling: string, hostCeiling = "full", parentCeiling = "full") {
  const modes = ["accept-edits", "auto", "full"] as const;
  const rank = (v: string) => modes.findIndex(m => m === v);
  const maximum = Math.min(rank(ceiling), rank(hostCeiling), rank(parentCeiling));
  const mode = [...modes].reverse().find(m => rank(m) <= maximum && allowed.includes(m));
  if (!mode) throw new ToolError("unsupported_permissions", "The provider does not support a permission mode within the configured limits.");
  return mode;
}
