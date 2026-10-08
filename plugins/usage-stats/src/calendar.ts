// Calendar arithmetic in an IANA time zone, with Intl only: where the page's local hours and days
// start. A day lasts 23 or 25 hours across a DST change, and a zone's offset differs between
// today and a date in the range, so neither is a fixed duration from a fixed offset.

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, format);
  }
  return format;
}

export function isTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The zone's offset from UTC at an instant: local wall-clock time minus UTC, in ms. */
export function zoneOffset(at: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(at))) parts[part.type] = Number(part.value);
  const wall = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  return wall - Math.floor(at / 1_000) * 1_000;
}

/** The start of the local hour that holds at. */
export function hourStart(at: number, timeZone: string): number {
  const offset = zoneOffset(at, timeZone);
  return Math.floor((at + offset) / HOUR_MS) * HOUR_MS - offset;
}

/**
 * The first instant of the local date that holds at: midnight, the first of two when clocks fall
 * back over it, or later when it was skipped.
 */
export function dayStart(at: number, timeZone: string): number {
  const offset = zoneOffset(at, timeZone);
  const midnight = Math.floor((at + offset) / DAY_MS) * DAY_MS;
  const localDate = (instant: number) => Math.floor((instant + zoneOffset(instant, timeZone)) / DAY_MS) * DAY_MS;
  // Midnight at each offset in force around it: at's, the one a day earlier (before a change since)
  // and the one at midnight by at's. The earliest instant on the date wins.
  const candidates = [offset, zoneOffset(at - DAY_MS, timeZone), zoneOffset(midnight - offset, timeZone)]
    .map((candidate) => midnight - candidate)
    .filter((instant) => localDate(instant) === midnight);
  return Math.min(...candidates);
}

/** Where the local hour or day that starts at start ends: the next one's start. */
export function bucketEnd(start: number, bucket: "hour" | "day", timeZone: string): number {
  // A step into the middle of the next hour or day, whatever its length.
  return bucket === "day" ? dayStart(start + DAY_MS + DAY_MS / 2, timeZone) : hourStart(start + HOUR_MS + HOUR_MS / 2, timeZone);
}

/** Every local hour or day that starts in [from, to), from the one that holds from. */
export function bucketStarts(input: { from: number; to: number; bucket: "hour" | "day"; timeZone: string }): number[] {
  const startOf = input.bucket === "day" ? dayStart : hourStart;
  const starts: number[] = [];
  for (let at = startOf(input.from, input.timeZone); at < input.to; at = bucketEnd(at, input.bucket, input.timeZone)) starts.push(at);
  return starts;
}
