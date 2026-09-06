import { z } from "zod";

export interface Branding { label?: string; icon?: string }
export interface BrandingConfig { entries: Record<string, Branding>; warnings: string[] }

// SDK provider-icon IDs permit these characters; no provider-family assumption.
const providerId = /^[a-zA-Z0-9_-]+$/;
const icon = /^data:image\/(?:png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const record = z.record(z.string(), z.unknown());

export function parseBranding(value: unknown): BrandingConfig {
  const entries: Record<string, Branding> = Object.create(null);
  const warnings: string[] = [];
  const mapping = record.safeParse(value);
  if (!mapping.success) return { entries, warnings: ["The mapping must be an object keyed by provider ID."] };
  for (const [id, raw] of Object.entries(mapping.data)) {
    if (!providerId.test(id)) { warnings.push("A provider ID has invalid characters."); continue; }
    const entry = record.safeParse(raw);
    if (!entry.success) { warnings.push(`${id}: expected an object.`); continue; }
    const result: Branding = {};
    if (entry.data.label !== undefined) {
      if (typeof entry.data.label === "string" && entry.data.label.trim().length > 0 && entry.data.label.trim().length <= 80) {
        result.label = entry.data.label.trim();
      } else warnings.push(`${id}: label ignored; use 1–80 characters.`);
    }
    if (entry.data.icon !== undefined) {
      if (typeof entry.data.icon === "string" && entry.data.icon.length <= 131072 && icon.test(entry.data.icon)) {
        result.icon = entry.data.icon;
      } else warnings.push(`${id}: icon ignored; use a PNG or WebP base64 data URL, at most 128 KiB.`);
    }
    entries[id] = result;
  }
  return { entries, warnings };
}

const agentsSchema = z.array(z.object({ id: z.string(), displayName: z.string() }).passthrough());
export function planLabels(raw: unknown, entries: Record<string, Branding>) {
  if (typeof raw !== "string") throw new Error("ACP customAgents is not a string.");
  const agents = agentsSchema.parse(JSON.parse(raw || "[]"));
  const changes: { providerId: string; before: string; after: string }[] = [];
  const next = agents.map((agent) => {
    // This ID rule belongs only to the ACP customAgents configuration contract.
    const id = `acp-${agent.id}`;
    const label = entries[id]?.label;
    if (!label || label === agent.displayName) return agent;
    changes.push({ providerId: id, before: agent.displayName, after: label });
    return { ...agent, displayName: label };
  });
  return { changes, next: JSON.stringify(next) };
}
