// Number and time formats for the Usage page.

const compactFormat = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});
const integerFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

/** 1,284 / 12.9K / 4.2B */
export function compact(value: number): string {
  return Math.abs(value) < 10_000 ? integerFormat.format(value) : compactFormat.format(value);
}

export function integer(value: number): string {
  return integerFormat.format(value);
}

export function percent(value: number | null, digits = 1): string {
  return value === null ? "–" : `${(value * 100).toFixed(digits)}%`;
}

export function share(part: number, whole: number): string {
  if (whole === 0) return "–";
  const value = (part / whole) * 100;
  return value > 0 && value < 0.1 ? "<0.1%" : `${value.toFixed(value < 10 ? 1 : 0)}%`;
}

export function seconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

/** A bucket's start, short enough for an axis. */
export function bucketLabel(at: number, bucket: "hour" | "day"): string {
  const date = new Date(at);
  return bucket === "day"
    ? date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : date.toLocaleTimeString(undefined, { hour: "numeric" });
}

/** A bucket's span, for a tooltip. */
export function bucketTitle(at: number, bucket: "hour" | "day"): string {
  const date = new Date(at);
  if (bucket === "day")
    return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const end = new Date(at + 60 * 60_000);
  return `${date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}, ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}–${end.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

export function dateTime(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
