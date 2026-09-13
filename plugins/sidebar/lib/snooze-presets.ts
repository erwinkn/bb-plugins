import { z } from "zod/mini";

// Snooze presets and wake-time parsing. Shared by the CLI (server), the row
// menu, the popover, and the settings section (frontend), so this file stays
// free of SDK imports. Times are computed in the local time zone of the
// process that resolves them: the browser for the menu, the BB server for
// the CLI.

/** A fixed delay from now. */
const durationRuleSchema = z.object({
  type: z.literal("duration"),
  minutes: z.number().check(z.int(), z.positive(), z.maximum(60 * 24 * 366)),
});
/**
 * A clock time `days` days ahead. `days: 0` means today, or tomorrow once
 * the time has passed; `1` is tomorrow; `7` is the same weekday next week.
 */
const timeRuleSchema = z.object({
  type: z.literal("time"),
  days: z.number().check(z.int(), z.nonnegative(), z.maximum(366)),
  hour: z.number().check(z.int(), z.nonnegative(), z.maximum(23)),
  minute: z.number().check(z.int(), z.nonnegative(), z.maximum(59)),
});
export const snoozeRuleSchema = z.discriminatedUnion("type", [
  durationRuleSchema,
  timeRuleSchema,
]);
export type SnoozeRule = z.infer<typeof snoozeRuleSchema>;

/** CLI name: short, lower-case, so `--until tomorrow` reads well. */
export const PRESET_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const snoozePresetSchema = z.object({
  id: z.string().check(z.regex(PRESET_ID_PATTERN)),
  label: z.string().check(z.minLength(1), z.maxLength(40)),
  rule: snoozeRuleSchema,
});
export type SnoozePreset = z.infer<typeof snoozePresetSchema>;

export const MAX_PRESETS = 12;
export const snoozePresetsDocSchema = z.object({
  revision: z.number().check(z.int(), z.nonnegative()),
  presets: z.array(snoozePresetSchema).check(z.maxLength(MAX_PRESETS)),
});
export type SnoozePresetsDoc = z.infer<typeof snoozePresetsDocSchema>;

export const SNOOZE_PRESETS_CHANNEL = "snooze-presets-changed";

/** Erwin's defaults: two delays, tomorrow 09:00, and next week 09:00. */
export const DEFAULT_SNOOZE_PRESETS: readonly SnoozePreset[] = [
  { id: "1h", label: "1 hour", rule: { type: "duration", minutes: 60 } },
  { id: "3h", label: "3 hours", rule: { type: "duration", minutes: 180 } },
  {
    id: "tomorrow",
    label: "Tomorrow",
    rule: { type: "time", days: 1, hour: 9, minute: 0 },
  },
  {
    id: "next-week",
    label: "Next week",
    rule: { type: "time", days: 7, hour: 9, minute: 0 },
  },
];
export const EMPTY_SNOOZE_PRESETS: SnoozePresetsDoc = {
  revision: 0,
  presets: [...DEFAULT_SNOOZE_PRESETS],
};

export class SnoozePresetValidationError extends Error {}

/**
 * Validate a preset list from the settings form or an import: schema, then
 * unique ids and labels. Whitespace around labels is dropped.
 */
export function normalizePresets(input: unknown): SnoozePreset[] {
  const parsed = z.array(z.unknown()).safeParse(input);
  if (!parsed.success)
    throw new SnoozePresetValidationError("Presets must be a list.");
  if (parsed.data.length > MAX_PRESETS)
    throw new SnoozePresetValidationError(
      `At most ${MAX_PRESETS} presets are allowed.`,
    );
  const ids = new Set<string>();
  const labels = new Set<string>();
  return parsed.data.map((item, index) => {
    const raw =
      item && typeof item === "object"
        ? { ...(item as Record<string, unknown>) }
        : {};
    if (typeof raw.label === "string") raw.label = raw.label.trim();
    if (typeof raw.id === "string") raw.id = raw.id.trim().toLowerCase();
    const preset = snoozePresetSchema.safeParse(raw);
    if (!preset.success)
      throw new SnoozePresetValidationError(
        `Preset ${index + 1}: ${describeIssue(preset.error.issues[0])}`,
      );
    if (ids.has(preset.data.id))
      throw new SnoozePresetValidationError(
        `Preset ${index + 1}: the name "${preset.data.id}" is used twice.`,
      );
    if (labels.has(preset.data.label.toLowerCase()))
      throw new SnoozePresetValidationError(
        `Preset ${index + 1}: the label "${preset.data.label}" is used twice.`,
      );
    ids.add(preset.data.id);
    labels.add(preset.data.label.toLowerCase());
    return preset.data;
  });
}
function describeIssue(issue: { path?: PropertyKey[]; message: string } | undefined) {
  if (!issue) return "invalid preset.";
  const path = issue.path?.map(String).join(".") ?? "";
  if (path === "id")
    return "the CLI name must be 1 to 32 lower-case letters, digits, or dashes.";
  if (path === "label") return "the label must be 1 to 40 characters.";
  if (path.startsWith("rule")) return `${path.replace("rule.", "")}: ${issue.message}`;
  return issue.message;
}

/** Suggest a CLI name from a label: "Next week" becomes "next-week". */
export function slugifyPresetId(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

const at = (day: Date, hour: number, minute: number): Date => {
  const next = new Date(day);
  next.setHours(hour, minute, 0, 0);
  return next;
};
const plusDays = (day: Date, days: number): Date => {
  const next = new Date(day);
  next.setDate(next.getDate() + days);
  return next;
};

/** Epoch milliseconds for a rule, relative to `now`, in local time. */
export function resolveRule(rule: SnoozeRule, now: number): number {
  if (rule.type === "duration") return now + rule.minutes * 60_000;
  const base = new Date(now);
  const target = at(plusDays(base, rule.days), rule.hour, rule.minute);
  // A same-day time that already passed rolls to tomorrow; a later day at a
  // past time (clock changes, days: 0 at midnight) also moves forward.
  return (
    target.getTime() > now ? target : at(plusDays(target, 1), rule.hour, rule.minute)
  ).getTime();
}

export function resolvePreset(preset: SnoozePreset, now: number): number {
  return resolveRule(preset.rule, now);
}

const DURATION = /^(\d+)\s*(m|min|h|hr|d|w)$/i;
const UNIT_MS: Record<string, number> = {
  m: 60_000,
  min: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
};

/**
 * Parse a wake time for the CLI and the custom picker: a preset name, a
 * duration such as `45m`, `2h`, `3d`, or an ISO 8601 / `datetime-local`
 * value. Returns null for anything else or a time that is not in the future.
 */
export function parseUntil(
  value: string,
  now: number,
  presets: readonly SnoozePreset[] = DEFAULT_SNOOZE_PRESETS,
): number | null {
  const text = value.trim();
  if (!text) return null;
  let until: number;
  const preset = presets.find((candidate) => candidate.id === text.toLowerCase());
  if (preset) until = resolvePreset(preset, now);
  else {
    const duration = DURATION.exec(text);
    if (duration) {
      const unit = UNIT_MS[duration[2]!.toLowerCase()];
      if (unit === undefined) return null;
      until = now + Number(duration[1]) * unit;
    } else {
      const parsed = Date.parse(text);
      if (Number.isNaN(parsed)) return null;
      until = parsed;
    }
  }
  return until > now ? Math.round(until) : null;
}

const time = (date: Date) =>
  date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/** Short wake-time label for a snoozed row: time today, weekday, or date. */
export function formatWakeTime(until: number, now: number): string {
  const wake = new Date(until);
  const today = new Date(now);
  if (sameDay(wake, today)) return time(wake);
  if (sameDay(wake, plusDays(today, 1))) return `Tomorrow ${time(wake)}`;
  if (until - now < 6 * 86_400_000)
    return `${wake.toLocaleDateString(undefined, { weekday: "short" })} ${time(wake)}`;
  return `${wake.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time(wake)}`;
}

/** Human summary of a rule for the settings list and the CLI help. */
export function describeRule(rule: SnoozeRule): string {
  const clock = `${String(rule.type === "time" ? rule.hour : 0).padStart(2, "0")}:${String(rule.type === "time" ? rule.minute : 0).padStart(2, "0")}`;
  if (rule.type === "time") {
    if (rule.days === 0) return `today at ${clock}, or tomorrow`;
    if (rule.days === 1) return `tomorrow at ${clock}`;
    if (rule.days === 7) return `next week, same weekday, at ${clock}`;
    return `in ${rule.days} days at ${clock}`;
  }
  const { minutes } = rule;
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return `in ${days} day${days === 1 ? "" : "s"}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** Value for an `<input type="datetime-local">`, in local time. */
export function toDateTimeLocal(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
