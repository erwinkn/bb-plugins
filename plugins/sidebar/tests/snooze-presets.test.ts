import { describe, expect, it } from "vitest";
import {
  DEFAULT_SNOOZE_PRESETS,
  describeRule,
  formatWakeTime,
  normalizePresets,
  parseUntil,
  resolveRule,
  slugifyPresetId,
  snoozePresetsDocSchema,
} from "../lib/snooze-presets";
import { parseSnoozeArgs } from "../lib/sidebar-cli";

// Local-time fixtures: a Wednesday afternoon. The rules resolve in the
// process time zone, so the expectations are built the same way.
const local = (
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
) => new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
const WEDNESDAY_1430 = local(2026, 9, 16, 14, 30);

describe("default presets", () => {
  it("are 1 hour, 3 hours, tomorrow 09:00, and next week 09:00", () => {
    expect(DEFAULT_SNOOZE_PRESETS.map((preset) => preset.id)).toEqual([
      "1h",
      "3h",
      "tomorrow",
      "next-week",
    ]);
    const byId = Object.fromEntries(
      DEFAULT_SNOOZE_PRESETS.map((preset) => [preset.id, preset.rule]),
    );
    expect(resolveRule(byId["1h"]!, WEDNESDAY_1430)).toBe(
      WEDNESDAY_1430 + 3_600_000,
    );
    expect(resolveRule(byId["3h"]!, WEDNESDAY_1430)).toBe(
      WEDNESDAY_1430 + 3 * 3_600_000,
    );
    expect(resolveRule(byId.tomorrow!, WEDNESDAY_1430)).toBe(
      local(2026, 9, 17, 9, 0),
    );
    // Same weekday next week, not Monday.
    expect(resolveRule(byId["next-week"]!, WEDNESDAY_1430)).toBe(
      local(2026, 9, 23, 9, 0),
    );
    expect(new Date(local(2026, 9, 23, 9, 0)).getDay()).toBe(
      new Date(WEDNESDAY_1430).getDay(),
    );
  });

  it("resolves tomorrow 09:00 in local time even late at night and at the month end", () => {
    expect(
      resolveRule(
        { type: "time", days: 1, hour: 9, minute: 0 },
        local(2026, 9, 30, 23, 59),
      ),
    ).toBe(local(2026, 10, 1, 9, 0));
    expect(
      resolveRule(
        { type: "time", days: 7, hour: 9, minute: 0 },
        local(2026, 12, 29, 8, 0),
      ),
    ).toBe(local(2027, 1, 5, 9, 0));
  });

  it("rolls a same-day clock time forward once it has passed", () => {
    const rule = { type: "time" as const, days: 0, hour: 18, minute: 0 };
    expect(resolveRule(rule, WEDNESDAY_1430)).toBe(local(2026, 9, 16, 18, 0));
    expect(resolveRule(rule, local(2026, 9, 16, 19, 0))).toBe(
      local(2026, 9, 17, 18, 0),
    );
  });

  it("describes rules for the settings list and the CLI", () => {
    expect(describeRule({ type: "duration", minutes: 60 })).toBe("in 1 hour");
    expect(describeRule({ type: "duration", minutes: 45 })).toBe("in 45 minutes");
    expect(describeRule({ type: "duration", minutes: 2880 })).toBe("in 2 days");
    expect(describeRule({ type: "time", days: 1, hour: 9, minute: 5 })).toBe(
      "tomorrow at 09:05",
    );
    expect(describeRule({ type: "time", days: 7, hour: 9, minute: 0 })).toBe(
      "next week, same weekday, at 09:00",
    );
    expect(describeRule({ type: "time", days: 0, hour: 18, minute: 0 })).toBe(
      "today at 18:00, or tomorrow",
    );
  });
});

describe("preset settings parsing", () => {
  it("accepts the defaults unchanged and trims labels and names", () => {
    expect(normalizePresets(DEFAULT_SNOOZE_PRESETS)).toEqual(
      DEFAULT_SNOOZE_PRESETS,
    );
    expect(
      normalizePresets([
        { id: " Tonight ", label: "  Tonight ", rule: { type: "time", days: 0, hour: 18, minute: 0 } },
      ]),
    ).toEqual([
      { id: "tonight", label: "Tonight", rule: { type: "time", days: 0, hour: 18, minute: 0 } },
    ]);
  });

  it("rejects bad names, labels, rules, duplicates, and long lists", () => {
    expect(() => normalizePresets("nope")).toThrow(/list/);
    expect(() =>
      normalizePresets([{ id: "Bad Name", label: "x", rule: { type: "duration", minutes: 5 } }]),
    ).toThrow(/Preset 1: the CLI name/);
    expect(() =>
      normalizePresets([{ id: "ok", label: "", rule: { type: "duration", minutes: 5 } }]),
    ).toThrow(/label/);
    expect(() =>
      normalizePresets([{ id: "ok", label: "x", rule: { type: "duration", minutes: 0 } }]),
    ).toThrow(/minutes/);
    expect(() =>
      normalizePresets([{ id: "ok", label: "x", rule: { type: "time", days: 1, hour: 24, minute: 0 } }]),
    ).toThrow(/hour/);
    expect(() =>
      normalizePresets([
        { id: "a", label: "A", rule: { type: "duration", minutes: 5 } },
        { id: "a", label: "B", rule: { type: "duration", minutes: 6 } },
      ]),
    ).toThrow(/"a" is used twice/);
    expect(() =>
      normalizePresets([
        { id: "a", label: "Same", rule: { type: "duration", minutes: 5 } },
        { id: "b", label: "same", rule: { type: "duration", minutes: 6 } },
      ]),
    ).toThrow(/"same" is used twice/);
    expect(() =>
      normalizePresets(
        Array.from({ length: 13 }, (_, index) => ({
          id: `p${index}`,
          label: `P${index}`,
          rule: { type: "duration", minutes: 5 },
        })),
      ),
    ).toThrow(/At most 12/);
  });

  it("parses a stored document and falls back on shape errors", () => {
    expect(
      snoozePresetsDocSchema.safeParse({ revision: 2, presets: DEFAULT_SNOOZE_PRESETS }).success,
    ).toBe(true);
    expect(snoozePresetsDocSchema.safeParse({ revision: -1, presets: [] }).success).toBe(false);
    expect(snoozePresetsDocSchema.safeParse({ revision: 0 }).success).toBe(false);
  });

  it("suggests a CLI name from a label", () => {
    expect(slugifyPresetId("Next week")).toBe("next-week");
    expect(slugifyPresetId("  Tonight!  ")).toBe("tonight");
    expect(slugifyPresetId("In 2 Days")).toBe("in-2-days");
  });
});

describe("parseUntil", () => {
  const now = WEDNESDAY_1430;
  it("reads preset names, durations, and ISO times in the future", () => {
    expect(parseUntil("tomorrow", now)).toBe(local(2026, 9, 17, 9, 0));
    expect(parseUntil("NEXT-WEEK", now)).toBe(local(2026, 9, 23, 9, 0));
    expect(parseUntil("45m", now)).toBe(now + 45 * 60_000);
    expect(parseUntil("2h", now)).toBe(now + 2 * 3_600_000);
    expect(parseUntil("3d", now)).toBe(now + 3 * 86_400_000);
    expect(parseUntil("1w", now)).toBe(now + 7 * 86_400_000);
    expect(parseUntil(new Date(now + 5_000).toISOString(), now)).toBe(now + 5_000);
  });
  it("uses the supplied preset list, not the defaults", () => {
    const presets = [
      { id: "later", label: "Later", rule: { type: "duration" as const, minutes: 15 } },
    ];
    expect(parseUntil("later", now, presets)).toBe(now + 15 * 60_000);
    expect(parseUntil("tomorrow", now, presets)).toBeNull();
  });
  it("rejects the past, nonsense, and empty input", () => {
    expect(parseUntil("", now)).toBeNull();
    expect(parseUntil("soon", now)).toBeNull();
    expect(parseUntil("0m", now)).toBeNull();
    expect(parseUntil(new Date(now - 1).toISOString(), now)).toBeNull();
  });
});

describe("formatWakeTime", () => {
  const now = WEDNESDAY_1430;
  it("shows a time today, Tomorrow, a weekday within the week, or a date", () => {
    expect(formatWakeTime(local(2026, 9, 16, 18, 0), now)).toMatch(/6:00|18:00/);
    expect(formatWakeTime(local(2026, 9, 17, 9, 0), now)).toMatch(/^Tomorrow /);
    expect(formatWakeTime(local(2026, 9, 19, 9, 0), now)).toMatch(/^Sat /);
    expect(formatWakeTime(local(2026, 9, 23, 9, 0), now)).toMatch(/Sep 23/);
  });
});

describe("CLI argument parsing", () => {
  it("reads the action, an optional thread id, --until in both forms, and --json", () => {
    expect(parseSnoozeArgs(["snooze", "thr_1", "--until", "2h"])).toEqual({
      action: "snooze",
      threadId: "thr_1",
      until: "2h",
      json: false,
    });
    expect(parseSnoozeArgs(["snooze", "--until=tomorrow"])).toEqual({
      action: "snooze",
      threadId: undefined,
      until: "tomorrow",
      json: false,
    });
    expect(parseSnoozeArgs(["snoozes", "--json"])).toMatchObject({
      action: "snoozes",
      json: true,
    });
    expect(parseSnoozeArgs([])).toMatchObject({ action: undefined });
  });
  it("rejects unknown options and extra positionals", () => {
    expect(() => parseSnoozeArgs(["snooze", "--at", "2h"])).toThrow(/Unknown option --at/);
    expect(() => parseSnoozeArgs(["snooze", "a", "b"])).toThrow(/at most one thread id/);
  });
});
