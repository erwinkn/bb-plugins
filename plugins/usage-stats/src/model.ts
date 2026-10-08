import { z } from "zod";
import { isTimeZone } from "./calendar";
import { filterDimensions, splits } from "./shared";

// The page's contract: what the browser asks for and what the server answers. The browser imports
// only its types; runtime helpers both sides use are in shared.ts, which stays free of zod.

const DAY_MS = 24 * 60 * 60_000;

export const pageInputSchema = z
  .object({
    from: z.number().int().nonnegative(),
    to: z.number().int().positive(),
    bucket: z.enum(["hour", "day"]),
    // The browser's IANA time zone: hours and days are its local calendar's.
    timeZone: z.string().max(100).refine(isTimeZone, "Unknown time zone."),
    split: z.enum(splits),
    // One value per dimension; "" is the unknown value (no model, no thread, no Initiative).
    filter: z.partialRecord(z.enum(filterDimensions), z.string().max(200)),
  })
  .strict()
  .refine((input) => input.from < input.to, "from must be before to.")
  .refine((input) => input.to - input.from <= 400 * DAY_MS, "A range is at most 400 days.");
export type PageInput = z.infer<typeof pageInputSchema>;

const count = z.number().nonnegative();

/** The Account Pooler's additive sums for one slice of requests (its usage.stats metrics). */
export const metricsSchema = z.object({
  requests: count,
  errors: count,
  rateLimited: count,
  overloaded: count,
  withUsage: count,
  latencyMs: count,
  input: count,
  output: count,
  cacheRead: count,
  cacheWrite5m: count,
  cacheWrite1h: count,
  inputEquivalent: count,
  nativePromptTokens: count,
  nativeCacheRead: count,
  refreshes: count,
  refreshInputEquivalent: count,
  afterExpiry: count,
  coldRewrites: count,
  coldRewriteTokens: count,
  rewritesAvoided: count,
  rewriteTokensAvoided: count,
  savedInputEquivalent: count,
});
export type Metrics = z.infer<typeof metricsSchema>;

export const weightsSchema = z.object({
  input: z.number(),
  cacheRead: z.number(),
  cacheWrite5m: z.number(),
  cacheWrite1h: z.number(),
  output: z.number(),
});
export type Weights = z.infer<typeof weightsSchema>;

const labelSchema = z.object({
  // The filter value: "" for the unknown value.
  id: z.string(),
  label: z.string(),
  // A second line: the raw model id, a thread's project and role.
  detail: z.string().nullable(),
});
export type Label = z.infer<typeof labelSchema>;

export const rowSchema = labelSchema.extend({ metrics: metricsSchema });
export type Row = z.infer<typeof rowSchema>;

const quotaWindowSchema = z.object({
  name: z.string(),
  // [time, utilization 0–1], downsampled; the first may be the state at the range start.
  points: z.array(z.tuple([z.number(), z.number()])),
  // When the window reset within the range.
  resets: z.array(z.number()),
});

export const pageSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
  z.object({
    status: z.literal("ok"),
    input: z.object({ from: z.number(), to: z.number(), bucket: z.enum(["hour", "day"]) }),
    weights: weightsSchema,
    retentionDays: z.number(),
    oldestHour: z.number().nullable(),
    pendingRows: z.number(),
    totals: metricsSchema,
    series: z.object({
      // Every bucket start in range, with the totals of that bucket.
      buckets: z.array(z.object({ at: z.number(), metrics: metricsSchema })),
      // Where the last bucket ends: the next local hour or day, 23 or 25 hours on for some days.
      end: z.number(),
      // For a split other than "type": the top values (the rest folded into "Other"), and their
      // input-equivalents and requests per bucket.
      keys: z.array(labelSchema),
      cost: z.array(z.array(z.number())),
      requests: z.array(z.array(z.number())),
    }),
    breakdowns: z.object({
      provider: z.array(rowSchema),
      model: z.array(rowSchema),
      account: z.array(rowSchema),
      role: z.array(rowSchema),
      project: z.array(rowSchema),
      initiative: z.array(rowSchema),
      // The top threads by cost, and how many there are.
      thread: z.array(rowSchema),
      threadCount: z.number(),
    }),
    // The values each filter can take in range, whatever the other filters.
    options: z.record(z.enum(filterDimensions), z.array(labelSchema)),
    quota: z.array(
      z.object({
        accountId: z.string(),
        label: z.string(),
        status: z.enum(["ready", "held", "exhausted", "error", "disabled"]).nullable(),
        active: z.boolean(),
        windows: z.array(quotaWindowSchema),
      }),
    ),
  }),
]);
export type Page = z.infer<typeof pageSchema>;
export type OkPage = Extract<Page, { status: "ok" }>;
