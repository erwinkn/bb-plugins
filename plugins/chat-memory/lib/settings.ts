import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

/**
 * D431: Regular compacts near 300k tokens; Hybrid at half that, since what a compaction drops stays
 * one zoom away in the tree (W216 priced Equisafe's day at $29 compacting at 150k, $39 at 300k).
 */
export const REGULAR_COMPACT_TOKENS = 300_000;
export const HYBRID_COMPACT_TOKENS = 150_000;

export const settingsDescriptors = {
  regularCompactTokens: {
    type: "number" as const,
    label: "Regular compaction limit (tokens)",
    description: "When a turn of a thread with memory in Regular mode ends with its context larger than this, the thread is compacted in place (BB's /compact) while idle, never mid-turn. Every request re-reads the whole context, so this caps what each one costs. A scope's own limit wins. 0 turns it off.",
    default: REGULAR_COMPACT_TOKENS,
    experimental_schema: z.number().int().min(0),
  },
  hybridCompactTokens: {
    type: "number" as const,
    label: "Hybrid compaction limit (tokens)",
    description: "The compaction limit in Hybrid mode: lower than the regular one, since what a compaction drops stays one zoom away in the memory tree. A scope's own limit wins. 0 turns it off.",
    default: HYBRID_COMPACT_TOKENS,
    experimental_schema: z.number().int().min(0),
  },
  summarizerEffort: {
    type: "string" as const,
    label: "Summarizer effort",
    description: "GPT-6 Luna's reasoning effort when it builds the memory trees: xhigh (best lines) or high (faster, a little worse).",
    default: "xhigh",
    experimental_schema: z.enum(["high", "xhigh"]),
  },
  summarizerConcurrency: {
    type: "number" as const,
    label: "Summarizer calls at once",
    description: "How many Luna calls the memory trees run in parallel, shared by every scope and let in by turns (8 in the OptChat design).",
    default: 8,
    experimental_schema: z.number().int().min(1).max(16),
  },
};
export interface Settings {
  regularCompactTokens: number;
  hybridCompactTokens: number;
  summarizerEffort: "high" | "xhigh";
  summarizerConcurrency: number;
}
export const DEFAULT_SETTINGS: Settings = {
  regularCompactTokens: REGULAR_COMPACT_TOKENS,
  hybridCompactTokens: HYBRID_COMPACT_TOKENS,
  summarizerEffort: "xhigh",
  summarizerConcurrency: 8,
};

/** The settings as a synchronous snapshot, kept current on every change; the defaults until the first read lands. */
export function defineSettings(bb: BbPluginApi) {
  const handle = bb.settings.define(settingsDescriptors);
  const decode = (raw: Awaited<ReturnType<typeof handle.get>>): Settings => ({
    regularCompactTokens: raw.regularCompactTokens,
    hybridCompactTokens: raw.hybridCompactTokens,
    summarizerEffort: raw.summarizerEffort === "high" ? "high" : "xhigh",
    summarizerConcurrency: raw.summarizerConcurrency,
  });
  let current = DEFAULT_SETTINGS;
  let changed = false;
  handle.onChange((next) => {
    changed = true;
    current = decode(next);
  });
  const ready = handle.get().then(
    (raw) => {
      if (!changed) current = decode(raw);
    },
    (error) => bb.log.error(`Chat memory settings could not load: ${String(error)}`),
  );
  return { ready, current: () => current };
}
