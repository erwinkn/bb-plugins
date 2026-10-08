import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { DEFAULT_PROFILES, policySchema, type Policy } from "./schema";
import {
  DEFAULT_COORDINATOR_INSTRUCTIONS,
  DEFAULT_WORKER_INSTRUCTIONS,
  GUIDANCE_RESET_FLAG,
  PREVIOUS_DEFAULTS,
} from "./guidance";
import { COLD_RESUME_DEFAULT_TOKENS } from "./cold-cache";
import { COMPACT_COORDINATOR_DEFAULT_TOKENS, COMPACT_HYBRID_DEFAULT_TOKENS } from "./compaction";

// BB truncates dynamic instructions at 4096; reserve 512 for role/start guards.
export const MAX_GUIDANCE_CHARACTERS = 4096 - 512;
const instructionSchema = z.string().min(1).max(MAX_GUIDANCE_CHARACTERS).refine(
  (s) => s.trim().length > 0,
  "Instructions must contain text; reset the field to restore defaults.",
);
export function parseProfileDefaults(value: string): Policy["profiles"] {
  return policySchema.parse({ profiles: JSON.parse(value) }).profiles;
}
const profilesTextSchema = z.string().max(16000).superRefine((value, ctx) => {
  try {
    parseProfileDefaults(value);
  } catch {
    ctx.addIssue({
      code: "custom",
      message: "Use a JSON profile map with known role keys and providerId, model, reasoningLevel, and optional serviceTier default|fast.",
    });
  }
});
export const settingsDescriptors = {
  coordinatorInstructions: {
    type: "string" as const,
    label: "Coordinator instructions",
    experimental_multiline: true,
    description: "The coordinator's standing instructions, given when its session starts. Saving does not change running sessions or wake agents. Reset restores the default.",
    default: DEFAULT_COORDINATOR_INSTRUCTIONS,
    experimental_schema: instructionSchema,
  },
  workerInstructions: {
    type: "string" as const,
    label: "Worker instructions",
    experimental_multiline: true,
    description: "Every worker's standing instructions, given when its session starts; briefs carry only the task. Saving does not change running sessions or wake agents. Reset restores the default.",
    default: DEFAULT_WORKER_INSTRUCTIONS,
    experimental_schema: instructionSchema,
  },
  executionProfiles: {
    type: "string" as const,
    label: "Default execution profiles by role",
    experimental_multiline: true,
    description: "JSON profiles by role. coordinator: the coordinator. implementation: worker, the default for spawn. straightforward: fast worker, kind fast (small, well-specified changes). experiment: experimenter, kind experimenter (prototypes and spikes). investigation: analyst, kind analyst (reads and reports). reviewOfClaude: reviewer of Claude work. reviewOfGpt: reviewer of GPT work. An explicit profile on spawn wins; a message to an existing worker keeps its model. Per-Initiative policy profiles override these keys.",
    default: JSON.stringify(DEFAULT_PROFILES, null, 2),
    experimental_schema: profilesTextSchema,
  },
  coldResumeTokens: {
    type: "number" as const,
    label: "Cold worker context limit (tokens)",
    description: "More work for an idle worker whose prompt cache has expired and whose context is larger than this is refused with the rewrite cost; the coordinator spawns a fresh worker with handoffs, or passes resumeCold:true. Cache state comes from the Account Pooler. 0 turns the check off.",
    default: COLD_RESUME_DEFAULT_TOKENS,
    experimental_schema: z.number().int().min(0),
  },
  coordinatorCompactTokens: {
    type: "number" as const,
    label: "Coordinator compaction limit (tokens)",
    description: "When a coordinator's turn ends with its context larger than this, it is compacted in place (BB's /compact) while idle, never mid-turn. Every request re-reads the whole context, so this caps what each one costs. 0 turns it off.",
    default: COMPACT_COORDINATOR_DEFAULT_TOKENS,
    experimental_schema: z.number().int().min(0),
  },
  hybridCompactTokens: {
    type: "number" as const,
    label: "Hybrid coordinator compaction limit (tokens)",
    description: "The compaction limit for Initiatives whose coordinator memory is hybrid: lower than the regular one, since what a compaction drops stays one zoom away in the memory tree. An Initiative's own limit wins. 0 turns it off.",
    default: COMPACT_HYBRID_DEFAULT_TOKENS,
    experimental_schema: z.number().int().min(0),
  },
  memoryEffort: {
    type: "string" as const,
    label: "Memory summarizer effort",
    description: "GPT-6 Luna's reasoning effort when it builds a hybrid coordinator's memory tree: xhigh (best lines) or high (faster, a little worse).",
    default: "xhigh",
    experimental_schema: z.enum(["high", "xhigh"]),
  },
  memoryConcurrency: {
    type: "number" as const,
    label: "Memory summarizer calls at once",
    description: "How many Luna calls the memory trees run in parallel, shared by every Initiative and let in by turns (8 in the OptChat design).",
    default: 8,
    experimental_schema: z.number().int().min(1).max(16),
  },
};
export type Preferences = {
  coordinatorInstructions: string;
  workerInstructions: string;
  profiles: Policy["profiles"];
  coldResumeTokens: number;
  coordinatorCompactTokens: number;
  hybridCompactTokens: number;
  memoryEffort: "high" | "xhigh";
  memoryConcurrency: number;
};
export const withProfileDefaults = (
  policy: Policy,
  preferences: Preferences,
): Policy => ({ profiles: { ...preferences.profiles, ...policy.profiles } });

/** One-time migration markers kept in the plugin's own database. */
export interface MigrationFlags { has(key: string): boolean; set(key: string): void }

export function definePreferences(bb: BbPluginApi, flags?: MigrationFlags) {
  const handle = bb.settings.define(settingsDescriptors);
  // T136 (D406): until the saved instructions have been reset once, they read as the new
  // defaults; the reset below persists that.
  const reset = () => flags !== undefined && !flags.has(GUIDANCE_RESET_FLAG);
  const decode = (raw: Awaited<ReturnType<typeof handle.get>>): Preferences => ({
    coordinatorInstructions: reset() || PREVIOUS_DEFAULTS.coordinator.includes(raw.coordinatorInstructions) ? DEFAULT_COORDINATOR_INSTRUCTIONS : instructionSchema.parse(raw.coordinatorInstructions),
    workerInstructions: reset() || PREVIOUS_DEFAULTS.worker.includes(raw.workerInstructions) ? DEFAULT_WORKER_INSTRUCTIONS : instructionSchema.parse(raw.workerInstructions),
    profiles: parseProfileDefaults(raw.executionProfiles),
    coldResumeTokens: raw.coldResumeTokens,
    coordinatorCompactTokens: raw.coordinatorCompactTokens,
    hybridCompactTokens: raw.hybridCompactTokens,
    memoryEffort: raw.memoryEffort === "high" ? "high" : "xhigh",
    memoryConcurrency: raw.memoryConcurrency,
  });
  // configure is synchronous in SDK 0.4.87. Its authoritative snapshot is
  // initialized from persisted settings and advanced on every effective edit.
  let current: Preferences | null = null;
  let revision = 0;
  handle.onChange((next) => {
    revision++;
    current = decode(next);
  });
  const initialRevision = revision;
  const ready = handle.get().then(async (raw) => {
    if (revision !== initialRevision) return;
    current = decode(raw);
    const patch: Partial<Record<"coordinatorInstructions" | "workerInstructions", string>> = {};
    for (const key of ["coordinatorInstructions", "workerInstructions"] as const)
      if (current[key] !== raw[key]) patch[key] = current[key];
    if (revision !== initialRevision) return;
    try {
      if (Object.keys(patch).length) await handle.experimental_set(patch);
      if (reset()) flags!.set(GUIDANCE_RESET_FLAG);
    } catch (error) {
      bb.log.error(`Initiatives settings migration could not persist: ${String(error)}`);
    }
  }).catch((error) => {
    bb.log.error(`Initiatives settings could not load: ${String(error)}`);
  });
  return {
    handle,
    ready,
    read: async () => decode(await handle.get()),
    configuration: () => {
      if (!current)
        throw new Error("Initiatives settings are not loaded; agent configuration cannot use assumed defaults.");
      return current;
    },
  };
}
export type PreferencesReader = ReturnType<typeof definePreferences>;
