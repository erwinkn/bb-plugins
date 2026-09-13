/**
 * Project identity color: a deterministic hue per project name on an
 * eight-step wheel. The dot on a project header and the 2px accent on a
 * project's rows in "All projects" views share it.
 *
 * The hue is written as a `data-project-hue` step; PROJECT_HUE_CSS maps each
 * step to a color derived from BB's file blue (`--bbp-file`, falling back to
 * `--timeline-accent`) with only the hue replaced, so lightness and chroma
 * follow BB's palette in both light and dark mode. Browsers without relative
 * color syntax keep the plain blue.
 */

export const PROJECT_HUE_STEPS = 8;
/** Degrees on the oklch wheel; step 0 is BB's blue. */
export const PROJECT_HUES = [250, 295, 340, 25, 70, 115, 160, 205] as const;

export function projectHueStep(name: string): number {
  // FNV-1a keeps the step stable across sessions and machines.
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % PROJECT_HUE_STEPS;
}

export function projectHue(name: string): number {
  return PROJECT_HUES[projectHueStep(name)]!;
}

const BASE = "var(--bbp-file, var(--timeline-accent))";

export const PROJECT_HUE_CSS = PROJECT_HUES.map(
  (hue, step) =>
    `[data-project-hue="${step}"]{color:${BASE};color:oklch(from ${BASE} l c ${hue})}`,
).join("\n");

/** Mount once per surface that renders `data-project-hue` elements. */
export function ProjectHueStyle() {
  return <style data-project-hue-style="">{PROJECT_HUE_CSS}</style>;
}
