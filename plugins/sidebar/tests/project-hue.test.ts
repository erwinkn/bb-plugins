import { describe, expect, it } from "vitest";
import {
  PROJECT_HUES,
  PROJECT_HUE_CSS,
  PROJECT_HUE_STEPS,
  projectHue,
  projectHueStep,
} from "../lib/project-hue";

describe("project hue", () => {
  it("is deterministic per name and stays on the eight-step wheel", () => {
    for (const name of ["One", "Two", "bb-plugins", "Unknown project", ""]) {
      const step = projectHueStep(name);
      expect(step).toBe(projectHueStep(name));
      expect(step).toBeGreaterThanOrEqual(0);
      expect(step).toBeLessThan(PROJECT_HUE_STEPS);
      expect(projectHue(name)).toBe(PROJECT_HUES[step]);
    }
    // Pinned values: a change here recolors every user's projects.
    expect(["One", "Two", "bb-plugins"].map(projectHueStep)).toEqual([7, 1, 0]);
  });
  it("spreads common names across the wheel", () => {
    const names = ["api", "web", "docs", "infra", "mobile", "cli", "sdk", "app"];
    expect(new Set(names.map(projectHueStep)).size).toBeGreaterThanOrEqual(5);
  });
  it("derives every step from BB's file blue with a plain fallback first", () => {
    const rules = PROJECT_HUE_CSS.split("\n");
    expect(rules).toHaveLength(PROJECT_HUE_STEPS);
    rules.forEach((rule, step) => {
      expect(rule).toContain(`[data-project-hue="${step}"]`);
      expect(rule).toMatch(/^\[[^{]*\{color:var\(--bbp-file, var\(--timeline-accent\)\);color:oklch\(from /);
      expect(rule).toContain(`l c ${PROJECT_HUES[step]})`);
    });
    // Tailwind never sees these values, so literal oklch is fine here.
    expect(PROJECT_HUE_CSS).not.toContain("@theme");
  });
});
