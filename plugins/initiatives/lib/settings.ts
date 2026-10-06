import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { DEFAULT_PROFILES, policySchema, type Policy } from "./schema";
import {
  DEFAULT_COORDINATOR_INSTRUCTIONS,
  DEFAULT_WORKER_INSTRUCTIONS,
  upgradeDecisionGuidance,
} from "./guidance";

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
    description: "Active behavioral guidance for coordinator session construction. Saves do not hot-update running sessions or wake agents. Reset below restores the populated default.",
    default: DEFAULT_COORDINATOR_INSTRUCTIONS,
    experimental_schema: instructionSchema,
  },
  workerInstructions: {
    type: "string" as const,
    label: "Worker instructions",
    experimental_multiline: true,
    description: "Active behavioral guidance for worker session construction and the next continue/fork assignment. Fresh assignments use configured session guidance. Role, permission, ownership and Stop guards remain enforced. Reset below restores the default.",
    default: DEFAULT_WORKER_INSTRUCTIONS,
    experimental_schema: instructionSchema,
  },
  executionProfiles: {
    type: "string" as const,
    label: "Default execution profiles",
    experimental_multiline: true,
    description: "JSON using existing profile keys. Explicit task/user/delegation and Initiative policy values win. Reused worker and replacement settings inherit current native execution. Omitted serviceTier uses native inheritance; default and fast are valid. Good is deliberately selected Opus 5.5 High/default; Fast is GPT-6.1 Sol High/fast. Missing role keys use built-in defaults. Settings never rewrite Initiative policy.",
    default: JSON.stringify(DEFAULT_PROFILES, null, 2),
    experimental_schema: profilesTextSchema,
  },
};
export type Preferences = {
  coordinatorInstructions: string;
  workerInstructions: string;
  profiles: Policy["profiles"];
};
export const withProfileDefaults = (
  policy: Policy,
  preferences: Preferences,
): Policy => ({ profiles: { ...preferences.profiles, ...policy.profiles } });

export function definePreferences(bb: BbPluginApi) {
  const handle = bb.settings.define(settingsDescriptors);
  const decode = (raw: Awaited<ReturnType<typeof handle.get>>): Preferences => ({
    coordinatorInstructions: instructionSchema.parse(upgradeDecisionGuidance(raw.coordinatorInstructions, "coordinator", MAX_GUIDANCE_CHARACTERS)),
    workerInstructions: instructionSchema.parse(upgradeDecisionGuidance(raw.workerInstructions, "worker", MAX_GUIDANCE_CHARACTERS)),
    profiles: parseProfileDefaults(raw.executionProfiles),
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
    if (Object.keys(patch).length && revision === initialRevision) {
      try {
        await handle.experimental_set(patch);
      } catch (error) {
        bb.log.error(`Initiatives settings migration could not persist: ${String(error)}`);
      }
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
