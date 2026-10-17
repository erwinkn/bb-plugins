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
    description: "Every worker's standing instructions, given when its session starts; every later work message repeats them, so saving reaches live workers at their next work message. Saving wakes no one. Reset restores the default.",
    default: DEFAULT_WORKER_INSTRUCTIONS,
    experimental_schema: instructionSchema,
  },
  executionProfiles: {
    type: "string" as const,
    label: "Default execution profiles by role",
    experimental_multiline: true,
    description: "JSON profiles by role. coordinator: the coordinator. implementation: worker, the default for spawn. straightforward: fast worker, kind fast (small, well-specified changes). experiment: experimenter, kind experimenter (prototypes and spikes). mechanical: very fast worker, kind very-fast (lookups, scans, renames, simple scripted checks). investigation: explorer, kind explorer (reads and reports). reviewOfClaude: reviewer of Claude work. reviewOfGpt: reviewer of GPT work. An explicit profile on spawn wins; a message to an existing worker keeps its model. Per-Initiative policy profiles override these keys.",
    default: JSON.stringify(DEFAULT_PROFILES, null, 2),
    experimental_schema: profilesTextSchema,
  },
  coldResumeTokens: {
    type: "number" as const,
    label: "Cold worker context limit (tokens)",
    description: "More work for an idle worker whose prompt cache has expired and whose context is larger than this is refused to a lead with the rewrite cost, unless the lead resends it with resumeCold:true; otherwise it spawns a fresh worker with handoffs. Your own sends are never refused. Cache state comes from the Account Pooler; without it the work goes ahead. 0 turns the check off.",
    default: COLD_RESUME_DEFAULT_TOKENS,
    experimental_schema: z.number().int().min(0),
  },
};
export type Preferences = {
  coordinatorInstructions: string;
  workerInstructions: string;
  profiles: Policy["profiles"];
  coldResumeTokens: number;
};
export const withProfileDefaults = (
  policy: Policy,
  preferences: Preferences,
): Policy => ({ profiles: { ...preferences.profiles, ...policy.profiles } });

/** One-time migration markers kept in the plugin's own database. */
export interface MigrationFlags { has(key: string): boolean; set(key: string): void }

/**
 * v9 (§8.4): code-owned defaults are never stored. A saved instruction equal to the current or
 * an earlier default is unset on load, so each build, this one or an older one after a
 * rollback, reads its own descriptor default; any other saved text is a real edit, kept by both.
 */
const isDefault = (field: "coordinator" | "worker", text: string) =>
  text === (field === "coordinator" ? DEFAULT_COORDINATOR_INSTRUCTIONS : DEFAULT_WORKER_INSTRUCTIONS) || PREVIOUS_DEFAULTS[field].includes(text);

export function definePreferences(bb: BbPluginApi, flags?: MigrationFlags, extraDescription?: Partial<Record<keyof typeof settingsDescriptors, string>>) {
  const handle = bb.settings.define(Object.fromEntries(Object.entries(settingsDescriptors).map(([key, descriptor]) => {
    const extra = extraDescription?.[key as keyof typeof settingsDescriptors];
    return [key, extra ? { ...descriptor, description: `${extra} ${descriptor.description}` } : descriptor];
  })) as typeof settingsDescriptors);
  // T136 (D406): until the saved instructions have been reset once, they read as the new
  // defaults; the unset below persists that.
  const reset = () => flags !== undefined && !flags.has(GUIDANCE_RESET_FLAG);
  const decode = (raw: Awaited<ReturnType<typeof handle.get>>): Preferences => ({
    coordinatorInstructions: reset() || isDefault("coordinator", raw.coordinatorInstructions) ? DEFAULT_COORDINATOR_INSTRUCTIONS : instructionSchema.parse(raw.coordinatorInstructions),
    workerInstructions: reset() || isDefault("worker", raw.workerInstructions) ? DEFAULT_WORKER_INSTRUCTIONS : instructionSchema.parse(raw.workerInstructions),
    profiles: parseProfileDefaults(raw.executionProfiles),
    coldResumeTokens: raw.coldResumeTokens,
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
    // The view fills in the descriptor default for an unset field, so "stored and equal to a
    // default" and "unset" read the same here: unset both (unsetting nothing is harmless).
    const patch: Partial<Record<"coordinatorInstructions" | "workerInstructions", null>> = {};
    if (reset() || isDefault("coordinator", raw.coordinatorInstructions)) patch.coordinatorInstructions = null;
    if (reset() || isDefault("worker", raw.workerInstructions)) patch.workerInstructions = null;
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
