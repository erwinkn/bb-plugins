import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { DEFAULT_PROFILE_INSTRUCTIONS, WORKER_BASE_PROMPT } from "./worker-prompt.ts";
import { loadWorkerCatalog } from "./provider-catalog.ts";
import { workerPermissionModeSchema } from "./permission-mode.ts";

export const WORKER_ROLES = ["investigate", "plan", "implement", "review"] as const;
export type WorkerRole = typeof WORKER_ROLES[number];
export const WORKER_PROFILE_KEY = "voice.worker-profiles.v1";
export const workerProfileSchema = z.object({
  providerId: z.string().min(1).max(64),
  model: z.string().min(1).max(128).nullable(),
  reasoningLevel: z.enum(["none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"]).nullable(),
  serviceTier: z.enum(["default", "fast"]),
}).strict();
export type WorkerProfile = z.infer<typeof workerProfileSchema>;
export const workerSettingsSchema = z.object({
  defaultProfile: workerProfileSchema.optional(),
  profiles: z.object({ investigate: workerProfileSchema, plan: workerProfileSchema, implement: workerProfileSchema, review: workerProfileSchema }).strict(),
  maxActiveWorkers: z.number().int().min(1).max(64),
}).strict();
export type WorkerSettings = z.infer<typeof workerSettingsSchema>;

export const NAMED_WORKER_PROFILE_KEY = "voice.worker-profiles.v2";
export const namedWorkerProfileSchema = workerProfileSchema.extend({
  name: z.string().trim().min(1).max(64), instructions: z.string().min(1).max(16000).refine(value => !!value.trim(), "Instructions cannot be empty"),
  // Omitted historical v2 profiles keep their documented accept-edits behavior.
  permissionMode: workerPermissionModeSchema.default("accept-edits"),
});
export type NamedWorkerProfile = z.infer<typeof namedWorkerProfileSchema>;
export const namedWorkerSettingsSchema = z.object({
  profiles: z.array(namedWorkerProfileSchema).min(1).max(64),
  defaultProfile: z.string().min(1).max(64),
  maxActiveWorkers: z.number().int().min(1).max(64),
  workerBasePrompt: z.string().min(1).max(32000),
}).strict().refine(s => new Set(s.profiles.map(p => p.name)).size === s.profiles.length && s.profiles.some(p => p.name === s.defaultProfile), "Profile names must be unique and include the default profile");
export type NamedWorkerSettings = z.infer<typeof namedWorkerSettingsSchema>;

/** Old settings remain readable for rollback. Migration writes only the new key. */
export async function migrateWorkerSettings(bb: BbPluginApi): Promise<void> {
  if (await bb.storage.kv.get(NAMED_WORKER_PROFILE_KEY) != null) return;
  const old = await bb.storage.kv.get(WORKER_PROFILE_KEY);
  if (old == null) return;
  await bb.storage.kv.set(NAMED_WORKER_PROFILE_KEY, namedSettingsFromLegacy(workerSettingsSchema.parse(old)));
}

export function namedSettingsFromLegacy(old: WorkerSettings): NamedWorkerSettings {
  return { profiles: WORKER_ROLES.map(name => ({ ...old.profiles[name], name, instructions: DEFAULT_PROFILE_INSTRUCTIONS[name], permissionMode: "accept-edits" })),
    defaultProfile: "implement", maxActiveWorkers: old.maxActiveWorkers, workerBasePrompt: WORKER_BASE_PROMPT };
}

/** Fresh profiles deliberately inherit the plugin-wide safe default. */
export function defaultNamedWorkerSettings(): NamedWorkerSettings {
  const profile = (name: WorkerRole): NamedWorkerProfile => ({ providerId: "codex", model: null, reasoningLevel: null, serviceTier: "default", name, instructions: DEFAULT_PROFILE_INSTRUCTIONS[name], permissionMode: "inherit" });
  return { profiles: WORKER_ROLES.map(profile), defaultProfile: "implement", maxActiveWorkers: 8, workerBasePrompt: WORKER_BASE_PROMPT };
}

/** Validate the complete draft on the selected machine without changing model choices. */
export async function validateNamedWorkerSettings(bb: BbPluginApi, settings: NamedWorkerSettings, hostId: string) {
  const parsed = namedWorkerSettingsSchema.parse(settings);
  const catalog = await loadWorkerCatalog(bb, hostId);
  for (const profile of parsed.profiles) {
    const provider = catalog.providers.find(p => p.id === profile.providerId && p.available);
    const models = catalog.models.filter(m => m.providerId === profile.providerId);
    const model = profile.model ? models.find(m => m.model === profile.model || m.id === profile.model) : models.find(m => m.isDefault);
    if (!provider || !model) throw new Error(`Profile ${profile.name}: the selected provider or model is unavailable on this machine.`);
    if (profile.reasoningLevel && !model.reasoningLevels.some(level => level.id === profile.reasoningLevel)) throw new Error(`Profile ${profile.name}: this model does not support ${profile.reasoningLevel} reasoning.`);
    if (profile.serviceTier === "fast" && !provider.serviceTiers.some(tier => tier.id === "fast")) throw new Error(`Profile ${profile.name}: this provider does not support Fast on this machine.`);
  }
  return parsed;
}

export async function readNamedWorkerSettings(bb: BbPluginApi): Promise<NamedWorkerSettings> {
  const saved = await bb.storage.kv.get<unknown>(NAMED_WORKER_PROFILE_KEY);
  if (saved !== null && saved !== undefined) return namedWorkerSettingsSchema.parse(saved);
  const legacy = await bb.storage.kv.get<unknown>(WORKER_PROFILE_KEY);
  if (legacy !== null && legacy !== undefined) return namedSettingsFromLegacy(workerSettingsSchema.parse(legacy));
  return defaultNamedWorkerSettings();
}

export function defaultWorkerSettings(): WorkerSettings {
  const profile = (): WorkerProfile => ({ providerId: "codex", model: null, reasoningLevel: null, serviceTier: "default" });
  return { defaultProfile: profile(), profiles: { investigate: profile(), plan: profile(), implement: profile(), review: profile() }, maxActiveWorkers: 8 };
}

export async function readWorkerSettings(bb: BbPluginApi): Promise<WorkerSettings> {
  const saved = await bb.storage.kv.get<unknown>(WORKER_PROFILE_KEY);
  // Missing settings use the independent worker provider default.
  if (saved === null || saved === undefined) return defaultWorkerSettings();
  const parsed = workerSettingsSchema.safeParse(saved);
  if (!parsed.success) throw new Error("Worker profiles are invalid. Review Voice Mode → Workers before starting work.");
  return parsed.data;
}

/** Validate on the actual destination machine; never substitute an unavailable model. */
export async function resolveWorkerModel(bb: BbPluginApi, hostId: string, profile: WorkerProfile) {
  const providers = await bb.sdk.providers.list({ hostId });
  if (!providers.some(p => p.id === profile.providerId && p.available)) throw new Error(`Worker provider ${profile.providerId} is unavailable on the selected machine.`);
  const catalog = await bb.sdk.providers.models({ hostId, providerId: profile.providerId });
  if (catalog.modelLoadError) throw new Error(`Worker model catalog could not load: ${catalog.modelLoadError.code}.`);
  const candidates = catalog.models.filter(m => !m.routeProviderId || m.routeProviderId === profile.providerId);
  const model = profile.model ? candidates.find(m => m.id === profile.model || m.model === profile.model) : candidates.find(m => m.isDefault);
  if (!model) throw new Error(`Worker model ${profile.model ?? "(provider default)"} is unavailable. Choose a model in Voice Mode → Workers.`);
  if (profile.reasoningLevel && !model.supportedReasoningEfforts?.some(e => e.reasoningEffort === profile.reasoningLevel)) throw new Error(`Worker model ${model.displayName} does not support ${profile.reasoningLevel} reasoning.`);
  if (profile.serviceTier === "fast" && !catalog.providers?.find(p => p.id === profile.providerId)?.serviceTiers?.some(t => t.id === "fast")) throw new Error("The worker provider does not support Fast service.");
  return { providerId: profile.providerId, model: model.model, ...(profile.reasoningLevel ? { reasoningLevel: profile.reasoningLevel } : {}), serviceTier: profile.serviceTier };
}
