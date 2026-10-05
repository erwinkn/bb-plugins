// Every implemented behavior, as one set of host Settings descriptors with
// shared typed validation. Field-level checks run in the host's settings form,
// `bb plugin config`, experimental_set and the fake host; cross-field checks
// run in resolveConfig and are shown as the effective/error state. Unsupported
// combinations are errors: nothing is aliased or silently replaced.

import type { PluginSettingDescriptor } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { DEFAULT_TEST_GLOBS } from "../rules/checkpoint.js";
import { POLICY_ENC_CAP, enc } from "../rules/packet.js";
import { LUNA_EFFORTS, ROUTE_IDS, ROUTES, SONNET_EFFORTS, SONNET_THINKING, type RouteId } from "./routes.js";

const int = (min: number, max: number) => z.number().int().min(min).max(max);
const optionalCap = (label: string, integer: boolean) =>
  (integer ? z.number().int() : z.number()).min(0, `${label} cannot be negative`);

export function validTimeZone(tz: string): boolean {
  if (tz === "") return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const globList = z
  .string()
  .max(4096, "Test globs must be at most 4096 characters")
  .refine((v) => v.split("\n").filter((l) => l.trim()).length <= 40, "At most 40 globs");

export const SEVERITIES = ["note", "concern", "critical"] as const;
export const NOTIFICATION_POLICIES = ["badge", "toast-critical", "toast-concern"] as const;
export const WATCH_SCOPES = ["selected", "selected-and-project"] as const;

/** The descriptor object handed to bb.settings.define. */
export const settingsDescriptors = {
  // Observation (S1)
  observationEnabled: {
    type: "boolean",
    label: "Observe watched threads (reads their events; never writes to them)",
    default: true,
  },
  watchScope: {
    type: "select",
    label: "Watch scope: selected threads only, or also every thread in one project",
    options: [...WATCH_SCOPES],
    default: "selected",
  },
  watchProject: { type: "project", label: "Project watched in full (used when scope includes a project)" },
  pollSeconds: {
    type: "number",
    label: "Observation poll interval, seconds (event notices also wake it)",
    experimental_schema: int(5, 600),
    default: 15,
  },
  checkpointsEnabled: {
    type: "boolean",
    label: "Turn-end test checkpoints (catch shell edits to test files)",
    default: true,
  },
  checkpointMaxPaths: {
    type: "number",
    label: "Test paths read per checkpoint (native limit 50)",
    experimental_schema: int(1, 50),
    default: 20,
  },
  testGlobs: {
    type: "string",
    label: "Test path globs, one per line",
    experimental_multiline: true,
    experimental_schema: globList,
    default: DEFAULT_TEST_GLOBS.join("\n"),
  },
  pendingHorizonMinutes: {
    type: "number",
    label: "Minutes an unanswered instruction holds review before coverage turns partial",
    experimental_schema: int(1, 1440),
    default: 30,
  },
  // Review (S2/S3)
  reviewEnabled: {
    type: "boolean",
    label: "Run reviews (off by default; the fake reviewer never makes a network request)",
    default: false,
  },
  providerRequestsEnabled: {
    type: "boolean",
    label: "Allow model provider requests (spends money or subscription quota)",
    default: false,
  },
  route: {
    type: "select",
    label: "Reviewer route (model + transport)",
    options: [...ROUTE_IDS],
    default: "fake",
  },
  sonnetEffort: { type: "select", label: "Sonnet 5.5 effort", options: [...SONNET_EFFORTS], default: "low" },
  sonnetThinking: {
    type: "select",
    label: "Sonnet 5.5 thinking (between_tools only at effort high or below)",
    options: [...SONNET_THINKING],
    default: "adaptive",
  },
  lunaEffort: { type: "select", label: "GPT-6 Luna reasoning effort", options: [...LUNA_EFFORTS], default: "low" },
  maxOutputTokens: {
    type: "number",
    label: "Max output tokens per review (Sonnet and Luna; includes thinking)",
    experimental_schema: int(256, 16000),
    default: 2000,
  },
  jevThreshold: {
    type: "number",
    label: "Jev probability that raises a finding (unmeasured default)",
    experimental_schema: z.number().gt(0).max(1),
    default: 0.7,
  },
  customInstructions: {
    type: "string",
    label: "Custom instructions and priorities (added to the charter as user policy, at most 4 KiB encoded)",
    experimental_multiline: true,
    experimental_schema: z.string().refine((v) => enc(v) <= POLICY_ENC_CAP, `At most ${POLICY_ENC_CAP} serialized bytes`),
    default: "",
  },
  categoryTestIntegrity: { type: "boolean", label: "Category: test integrity", default: true },
  categoryUnsupportedClaim: { type: "boolean", label: "Category: unsupported completion claims", default: true },
  categoryMissedRequirement: { type: "boolean", label: "Category: missed requirements", default: true },
  triggerTestEdit: { type: "boolean", label: "Trigger: a test edit or checkpoint change", default: true },
  triggerFailedCommand: { type: "boolean", label: "Trigger: a command with a nonzero exit", default: true },
  triggerClaim: { type: "boolean", label: "Trigger: a completion claim", default: true },
  triggerTurnEnd: { type: "boolean", label: "Trigger: turn end with unreviewed evidence", default: true },
  bucketSize: {
    type: "number",
    label: "Cadence: review tokens per watch (burst)",
    experimental_schema: int(1, 10),
    default: 2,
  },
  refillMinutes: {
    type: "number",
    label: "Cadence: minutes to refill one review token",
    experimental_schema: int(1, 1440),
    default: 10,
  },
  minGapMinutes: {
    type: "number",
    label: "Cadence: minimum minutes between reviews of one watch",
    experimental_schema: int(0, 1440),
    default: 2,
  },
  bodyCapKiB: {
    type: "number",
    label: "Packet body cap, KiB (Jev is further capped at 60)",
    experimental_schema: int(24, 64),
    default: 64,
  },
  concurrency: {
    type: "number",
    label: "Reviews in flight across all watches (one per watch)",
    experimental_schema: int(1, 8),
    default: 2,
  },
  completionReadPages: {
    type: "number",
    label: "Pages (100 rows each) of request, receipt, stop and turn-end rows read when a review completes; more leaves the result held",
    experimental_schema: int(1, 50),
    default: 8,
  },
  heldExpiryMinutes: {
    type: "number",
    label: "Minutes a held review (currentness unknown) is rechecked from its paid result before its cards become a not-judged gap",
    experimental_schema: int(5, 10080),
    default: 60,
  },
  heldRechecksPerPass: {
    type: "number",
    label: "Held reviews rechecked per service pass (oldest check first)",
    experimental_schema: int(1, 50),
    default: 4,
  },
  lunaStreamCapKiB: {
    type: "number",
    label: "Pooled GPT-6 Luna: most streamed KiB read per review (text deltas are discarded; the final response is kept)",
    experimental_schema: int(256, 65536),
    default: 4096,
  },
  // Budgets: unset means USD or subscription routes refuse to start.
  usdPerDay: { type: "number", label: "Daily API spend cap, USD (unset: API routes refuse)", experimental_schema: optionalCap("Cap", false) },
  apiRequestsPerDay: {
    type: "number",
    label: "Daily API request cap (unset: API routes refuse)",
    experimental_schema: optionalCap("Cap", true),
  },
  subscriptionRequestsPerDay: {
    type: "number",
    label: "Daily subscription request cap (unset: pooled routes refuse)",
    experimental_schema: optionalCap("Cap", true),
  },
  subscriptionTokensPerDay: {
    type: "number",
    label: "Daily subscription token cap (reserved as body bytes + 1024 + max output)",
    experimental_schema: optionalCap("Cap", true),
  },
  budgetTimeZone: {
    type: "string",
    label: "Time zone of the budget day (empty: this server's zone)",
    experimental_schema: z.string().refine(validTimeZone, "Unknown IANA time zone"),
    default: "",
  },
  // Retention
  evidenceRetentionDays: { type: "number", label: "Evidence retention, days", experimental_schema: int(1, 365), default: 14 },
  evidenceRetentionMB: { type: "number", label: "Evidence retention, MB (oldest first)", experimental_schema: int(1, 2048), default: 200 },
  findingsRetentionDays: { type: "number", label: "Findings retention, days", experimental_schema: int(1, 3650), default: 90 },
  findingsMaxCount: { type: "number", label: "Findings retained at most", experimental_schema: int(10, 100000), default: 5000 },
  // Display
  severityThreshold: {
    type: "select",
    label: "Show findings at or above (lower ones stay stored, collapsed)",
    options: [...SEVERITIES],
    default: "concern",
  },
  notificationPolicy: {
    type: "select",
    label: "Notifications: panel badge only, or also a toast",
    options: [...NOTIFICATION_POLICIES],
    default: "badge",
  },
  // Secrets: server only, never sent to the frontend.
  anthropicApiKey: { type: "string", label: "Anthropic API key (sonnet:anthropic-api)", secret: true },
  openaiApiKey: { type: "string", label: "OpenAI API key (luna:openai-api)", secret: true },
  typesafeApiKey: { type: "string", label: "TypeSafe API key (jev:typesafe)", secret: true },
} satisfies Record<string, PluginSettingDescriptor>;

export const SECRET_KEYS = ["anthropicApiKey", "openaiApiKey", "typesafeApiKey"] as const;

export interface AdvisorConfig {
  observationEnabled: boolean;
  watchScope: (typeof WATCH_SCOPES)[number];
  watchProject: string | null;
  pollSeconds: number;
  checkpointsEnabled: boolean;
  checkpointMaxPaths: number;
  testGlobs: string[];
  pendingHorizonMinutes: number;
  reviewEnabled: boolean;
  providerRequestsEnabled: boolean;
  route: RouteId;
  sonnetEffort: (typeof SONNET_EFFORTS)[number];
  sonnetThinking: (typeof SONNET_THINKING)[number];
  lunaEffort: (typeof LUNA_EFFORTS)[number];
  maxOutputTokens: number;
  jevThreshold: number;
  customInstructions: string;
  categories: string[];
  triggers: { testEdit: boolean; failedCommand: boolean; claim: boolean; turnEnd: boolean };
  cadence: { size: number; refillMinutes: number; minGapMinutes: number };
  bodyCap: number;
  concurrency: number;
  completionReadPages: number;
  held: { expiryMinutes: number; rechecksPerPass: number };
  lunaStreamCap: number;
  budgets: {
    usdPerDay: number | null;
    apiRequestsPerDay: number | null;
    subscriptionRequestsPerDay: number | null;
    subscriptionTokensPerDay: number | null;
    timeZone: string;
  };
  retention: { evidenceDays: number; evidenceBytes: number; findingsDays: number; findingsMax: number };
  severityThreshold: (typeof SEVERITIES)[number];
  notificationPolicy: (typeof NOTIFICATION_POLICIES)[number];
  secretsPresent: Record<(typeof SECRET_KEYS)[number], boolean>;
}

export interface ResolvedConfig {
  config: AdvisorConfig;
  /** Problems that stop review dispatch (observation continues). */
  reviewErrors: string[];
  /** Problems that stop observation. */
  observationErrors: string[];
  /** Honest facts about the selection that are not errors. */
  notes: string[];
  /** Stored keys whose value was invalid; the config holds their documented defaults instead. */
  invalidKeys: string[];
}

/** Keys whose invalid value pauses pruning: a default could delete what the user meant to keep. */
export const RETENTION_KEYS = ["evidenceRetentionDays", "evidenceRetentionMB", "findingsRetentionDays", "findingsMaxCount"] as const;

type Raw = Record<string, unknown>;

function num(v: unknown, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}
function opt(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function bool(v: unknown, d: boolean): boolean {
  return typeof v === "boolean" ? v : d;
}
function pickOf<T extends readonly string[]>(v: unknown, opts: T, d: T[number]): T[number] {
  return typeof v === "string" && (opts as readonly string[]).includes(v) ? (v as T[number]) : d;
}

export function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Effective configuration plus cross-field errors. Pure: the same values always
 * give the same result. A stored value the descriptors reject is replaced by its
 * documented default (so nothing runs on it) and reported as a review error.
 */
export function resolveConfig(stored: Raw): ResolvedConfig {
  const invalid = invalidStored(stored);
  const raw: Raw = { ...stored };
  for (const bad of invalid) delete raw[bad.key];
  const categories = [
    raw.categoryTestIntegrity !== false ? "test-integrity" : null,
    raw.categoryUnsupportedClaim !== false ? "unsupported-claim" : null,
    raw.categoryMissedRequirement !== false ? "missed-requirement" : null,
  ].filter((c): c is string => c !== null);
  const tz = typeof raw.budgetTimeZone === "string" && raw.budgetTimeZone ? raw.budgetTimeZone : "";
  const config: AdvisorConfig = {
    observationEnabled: bool(raw.observationEnabled, true),
    watchScope: pickOf(raw.watchScope, WATCH_SCOPES, "selected"),
    watchProject: typeof raw.watchProject === "string" && raw.watchProject ? raw.watchProject : null,
    pollSeconds: num(raw.pollSeconds, 15),
    checkpointsEnabled: bool(raw.checkpointsEnabled, true),
    checkpointMaxPaths: num(raw.checkpointMaxPaths, 20),
    testGlobs: String(raw.testGlobs ?? DEFAULT_TEST_GLOBS.join("\n"))
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
    pendingHorizonMinutes: num(raw.pendingHorizonMinutes, 30),
    reviewEnabled: bool(raw.reviewEnabled, false),
    providerRequestsEnabled: bool(raw.providerRequestsEnabled, false),
    route: pickOf(raw.route, ROUTE_IDS, "fake"),
    sonnetEffort: pickOf(raw.sonnetEffort, SONNET_EFFORTS, "low"),
    sonnetThinking: pickOf(raw.sonnetThinking, SONNET_THINKING, "adaptive"),
    lunaEffort: pickOf(raw.lunaEffort, LUNA_EFFORTS, "low"),
    maxOutputTokens: num(raw.maxOutputTokens, 2000),
    jevThreshold: num(raw.jevThreshold, 0.7),
    customInstructions: typeof raw.customInstructions === "string" ? raw.customInstructions : "",
    categories,
    triggers: {
      testEdit: bool(raw.triggerTestEdit, true),
      failedCommand: bool(raw.triggerFailedCommand, true),
      claim: bool(raw.triggerClaim, true),
      turnEnd: bool(raw.triggerTurnEnd, true),
    },
    cadence: { size: num(raw.bucketSize, 2), refillMinutes: num(raw.refillMinutes, 10), minGapMinutes: num(raw.minGapMinutes, 2) },
    bodyCap: num(raw.bodyCapKiB, 64) * 1024,
    concurrency: num(raw.concurrency, 2),
    completionReadPages: num(raw.completionReadPages, 8),
    held: { expiryMinutes: num(raw.heldExpiryMinutes, 60), rechecksPerPass: num(raw.heldRechecksPerPass, 4) },
    lunaStreamCap: num(raw.lunaStreamCapKiB, 4096) * 1024,
    budgets: {
      usdPerDay: opt(raw.usdPerDay),
      apiRequestsPerDay: opt(raw.apiRequestsPerDay),
      subscriptionRequestsPerDay: opt(raw.subscriptionRequestsPerDay),
      subscriptionTokensPerDay: opt(raw.subscriptionTokensPerDay),
      timeZone: tz && validTimeZone(tz) ? tz : hostTimeZone(), // an unknown zone is a review error below; displays use this server's zone
    },
    retention: {
      evidenceDays: num(raw.evidenceRetentionDays, 14),
      evidenceBytes: num(raw.evidenceRetentionMB, 200) * 1024 * 1024,
      findingsDays: num(raw.findingsRetentionDays, 90),
      findingsMax: num(raw.findingsMaxCount, 5000),
    },
    severityThreshold: pickOf(raw.severityThreshold, SEVERITIES, "concern"),
    notificationPolicy: pickOf(raw.notificationPolicy, NOTIFICATION_POLICIES, "badge"),
    secretsPresent: {
      anthropicApiKey: typeof raw.anthropicApiKey === "string" && raw.anthropicApiKey.length > 0,
      openaiApiKey: typeof raw.openaiApiKey === "string" && raw.openaiApiKey.length > 0,
      typesafeApiKey: typeof raw.typesafeApiKey === "string" && raw.typesafeApiKey.length > 0,
    },
  };
  const reviewErrors: string[] = [];
  const observationErrors: string[] = [];
  const notes: string[] = [];
  const route = ROUTES[config.route];
  for (const bad of invalid) {
    reviewErrors.push(`Setting ${bad.key} has an invalid stored value (${bad.shown}): ${bad.why}. Reviews stay off until it is fixed.`);
    if (OBSERVATION_KEYS.has(bad.key)) notes.push(`Observation uses the default for ${bad.key} until it is fixed.`);
  }
  const invalidKeys = invalid.map((b) => b.key);
  const badRetention = RETENTION_KEYS.filter((k) => invalidKeys.includes(k));
  if (badRetention.length > 0) notes.push(`Pruning is paused until ${badRetention.join(", ")} is fixed: a default could delete evidence or findings you meant to keep.`);
  if (invalidKeys.includes("heldExpiryMinutes")) notes.push("Held reviews do not expire until heldExpiryMinutes is fixed; they are still rechecked.");
  if (config.watchScope === "selected-and-project" && config.watchProject === null) {
    observationErrors.push("Watch scope includes a project, but no project is selected.");
  }
  if (!validTimeZone(tz)) reviewErrors.push(`Budget time zone "${tz}" is not a known IANA zone.`);
  if (enc(config.customInstructions) > POLICY_ENC_CAP) {
    reviewErrors.push(`Custom instructions are ${enc(config.customInstructions)} serialized bytes; the cap is ${POLICY_ENC_CAP}.`);
  }
  if (config.categories.length === 0) reviewErrors.push("Every review category is turned off.");
  if (config.route.startsWith("sonnet") && config.sonnetThinking === "between_tools" && (config.sonnetEffort === "xhigh" || config.sonnetEffort === "max")) {
    reviewErrors.push(`Sonnet 5.5 accepts thinking "between_tools" only at effort high or below, not "${config.sonnetEffort}".`);
  }
  if (route.secret && !config.secretsPresent[route.secret]) reviewErrors.push(`Route ${route.id} needs the secret setting ${route.secret}.`);
  if (route.billing === "usd" && (config.budgets.usdPerDay === null || config.budgets.apiRequestsPerDay === null)) {
    reviewErrors.push(`Route ${route.id} bills USD: set both the daily USD cap and the daily API request cap.`);
  }
  if (
    route.billing === "subscription" &&
    (config.budgets.subscriptionRequestsPerDay === null || config.budgets.subscriptionTokensPerDay === null)
  ) {
    reviewErrors.push(`Route ${route.id} uses subscription quota: set the daily subscription request and token caps.`);
  }
  if (config.route === "jev:typesafe") {
    if (!config.categories.includes("test-integrity")) reviewErrors.push("Jev judges test integrity only, and that category is off.");
    const others = config.categories.filter((c) => c !== "test-integrity");
    if (others.length > 0) notes.push(`Jev does not judge ${others.join(" or ")}; those are recorded as not judged.`);
  }
  if (route.billing !== "none" && !config.providerRequestsEnabled) {
    notes.push("Model provider requests are off: this route dispatches nothing until they are allowed.");
  }
  return { config, reviewErrors, observationErrors, notes, invalidKeys };
}

const OBSERVATION_KEYS = new Set([
  "observationEnabled",
  "watchScope",
  "watchProject",
  "pollSeconds",
  "checkpointsEnabled",
  "checkpointMaxPaths",
  "testGlobs",
  "pendingHorizonMinutes",
]);

/**
 * Stored values the descriptors would reject (a renamed option, a value out of
 * range, the wrong type). Missing and null values are unset and keep their
 * documented defaults. resolveConfig runs every invalid value on its documented
 * default too, and reports it as a visible review error that keeps reviews off.
 * Through BB's settings read only out-of-range values arrive here: BB already
 * replaces a wrong type or an unknown option with the default (README).
 */
export function invalidStored(raw: Raw): Array<{ key: string; shown: string; why: string }> {
  const out: Array<{ key: string; shown: string; why: string }> = [];
  for (const [key, d] of Object.entries(settingsDescriptors) as Array<[string, PluginSettingDescriptor]>) {
    const v = raw[key];
    if (v === undefined || v === null) continue;
    const shown = (d as { secret?: boolean }).secret ? "secret" : JSON.stringify(v).slice(0, 60);
    let why: string | null = null;
    if (d.type === "boolean") why = typeof v === "boolean" ? null : "not true or false";
    else if (d.type === "select") why = typeof v === "string" && (d.options as readonly string[]).includes(v) ? null : `not one of ${d.options.join(", ")}`;
    else if (d.type === "number") why = typeof v === "number" && Number.isFinite(v) ? null : "not a number";
    else why = typeof v === "string" ? null : "not text";
    const schema = (d as { experimental_schema?: z.ZodType }).experimental_schema;
    if (why === null && schema) {
      const r = schema.safeParse(v);
      if (!r.success) why = r.error.issues[0]?.message ?? "rejected by its schema";
    }
    if (why !== null) out.push({ key, shown, why });
  }
  return out;
}

/** Settings keys whose change invalidates in-flight reviews (their packet, route or admission changed). */
export const REVIEW_KEYS = new Set([
  "reviewEnabled",
  "providerRequestsEnabled",
  "route",
  "sonnetEffort",
  "sonnetThinking",
  "lunaEffort",
  "maxOutputTokens",
  "jevThreshold",
  "customInstructions",
  "categoryTestIntegrity",
  "categoryUnsupportedClaim",
  "categoryMissedRequirement",
  "bodyCapKiB",
  "usdPerDay",
  "apiRequestsPerDay",
  "subscriptionRequestsPerDay",
  "subscriptionTokensPerDay",
  "budgetTimeZone",
  "testGlobs",
  "anthropicApiKey",
  "openaiApiKey",
  "typesafeApiKey",
]);
