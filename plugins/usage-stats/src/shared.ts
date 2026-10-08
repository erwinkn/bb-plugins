import type { Metrics } from "./model";

// Constants and helpers the server and the page share, kept free of zod so the page bundle
// stays small.

/** The dimensions a page can filter on. */
export const filterDimensions = [
  "provider",
  "model",
  "account",
  "role",
  "project",
  "initiative",
] as const;
export type FilterDimension = (typeof filterDimensions)[number];

/** The series key that folds the values past the top ones. */
export const OTHER_ID = "\u0000other";

/** What the page measures usage in: raw tokens, or price-weighted input-equivalents. */
export const measures = ["tokens", "cost"] as const;
export type Measure = (typeof measures)[number];

/** A slice's usage in a measure. Tokens counts every token once: what a provider's counter shows. */
export function amount(metrics: Metrics, measure: Measure): number {
  return measure === "cost"
    ? metrics.inputEquivalent
    : metrics.input + metrics.cacheRead + metrics.cacheWrite5m + metrics.cacheWrite1h + metrics.output;
}

/** What the time series stacks by: token type, or a dimension's top values. */
export const splits = ["type", "model", "account", "role", "provider"] as const;
export type Split = (typeof splits)[number];

export function emptyMetrics(): Metrics {
  return {
    requests: 0,
    errors: 0,
    rateLimited: 0,
    overloaded: 0,
    withUsage: 0,
    latencyMs: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    inputEquivalent: 0,
    nativePromptTokens: 0,
    nativeCacheRead: 0,
    refreshes: 0,
    refreshInputEquivalent: 0,
    afterExpiry: 0,
    coldRewrites: 0,
    coldRewriteTokens: 0,
    rewritesAvoided: 0,
    rewriteTokensAvoided: 0,
    savedInputEquivalent: 0,
  };
}

export function addMetrics(total: Metrics, add: Metrics): Metrics {
  for (const name of Object.keys(total) as Array<keyof Metrics>) total[name] += add[name];
  return total;
}

/** Cache reads over native Claude prompt tokens, or null without any. */
export function hitRate(metrics: Metrics): number | null {
  return metrics.nativePromptTokens === 0
    ? null
    : metrics.nativeCacheRead / metrics.nativePromptTokens;
}
