import type { LoadSettings } from "./contract.js";

export type Tone = "normal" | "warning" | "critical";

export function toneFor(percent: number | null, settings: LoadSettings): Tone {
  if (percent === null) return "normal";
  if (percent >= settings.criticalPercent) return "critical";
  if (percent >= settings.warningPercent) return "warning";
  return "normal";
}

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

/** Binary units with three significant digits: 812 MiB, 41.2 GiB, 1.79 TiB. */
export function formatBytes(value: number): string {
  let scaled = value;
  let unit = 0;
  while (scaled >= 1000 && unit < UNITS.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits)} ${UNITS[unit]}`;
}

/** "41.2 / 251 GiB": the unit once, when both sides share it. */
export function formatUsedOfTotal(used: number, total: number): string {
  const [usedValue, usedUnit] = formatBytes(used).split(" ");
  const [totalValue, totalUnit] = formatBytes(total).split(" ");
  return usedUnit === totalUnit
    ? `${usedValue} / ${totalValue} ${totalUnit}`
    : `${usedValue} ${usedUnit} / ${totalValue} ${totalUnit}`;
}

export function formatRate(bytesPerSecond: number | null): string {
  return bytesPerSecond === null ? "–" : `${formatBytes(bytesPerSecond)}/s`;
}

export function formatPercent(value: number | null): string {
  return value === null ? "–" : `${Math.round(value)}%`;
}

export function formatUptime(seconds: number | null): string | null {
  if (seconds === null) return null;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `up ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `up ${hours} h`;
  return `up ${Math.floor(hours / 24)} d`;
}

/** Percent of `part` in `total`, or null when there is no total. */
export function percentOf(part: number, total: number): number | null {
  return total > 0 ? (part / total) * 100 : null;
}
