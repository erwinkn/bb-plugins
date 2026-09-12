import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export function defineSettings(bb: BbPluginApi) {
  // Former scope, permission-ceiling and quota settings are deliberately not
  // declared or read. Old installations gain owner access without losing data.
  return bb.settings.define({
    defaultHostId: { type: "string", label: "Default execution host ID (empty: auto)", default: "" },
    appUrl: { type: "string", label: "BB public app URL", default: "", experimental_schema: z.string().refine(v => !v || validUrl(v), "Use an HTTPS URL without credentials or a query.") },
    endpointUrl: { type: "string", label: "Public MCP endpoint URL", default: "", experimental_schema: z.string().refine(v => !v || validUrl(v), "Use an HTTPS URL without credentials or a query.") },
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
