import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

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
  profiles: z.object({ investigate: workerProfileSchema, plan: workerProfileSchema, implement: workerProfileSchema, review: workerProfileSchema }).strict(),
  maxActiveWorkers: z.number().int().min(1).max(64),
}).strict();
export type WorkerSettings = z.infer<typeof workerSettingsSchema>;

export function defaultWorkerSettings(): WorkerSettings {
  const profile = (): WorkerProfile => ({ providerId: "codex", model: null, reasoningLevel: null, serviceTier: "default" });
  return { profiles: { investigate: profile(), plan: profile(), implement: profile(), review: profile() }, maxActiveWorkers: 8 };
}

export async function readWorkerSettings(bb: BbPluginApi): Promise<WorkerSettings> {
  const saved = await bb.storage.kv.get<unknown>(WORKER_PROFILE_KEY);
  // Missing settings use an independent provider default, never the coordinator model.
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

export const WORKER_ROLE_INSTRUCTIONS: Record<WorkerRole, string> = {
  investigate: "Investigate and report findings. Do not make implementation changes unless the user explicitly authorizes them. This role is an instruction, not a read-only sandbox.",
  plan: "Produce a substantive plan with relevant evidence and tradeoffs. Do not implement before the user authorizes implementation.",
  implement: "Implement the user's requested scope, run relevant checks, and distinguish verified results from remaining uncertainty.",
  review: "Review the requested work for correctness, regressions, and security. Report findings; do not apply fixes unless the user requests them.",
};
