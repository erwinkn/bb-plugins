import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findBbInstall, readBundledProviderPluginFiles, readBundleFiles } from "./lib/bb-install";
import { HOST_ANCHORS, PLAN_STEP_GLYPHS, TIMELINE_GLYPHS } from "./lib/host-contract";

const css = readFileSync(join(import.meta.dirname, "themes", "color.css"), "utf8");
const install = findBbInstall();

function glyphsIn(selectorPrefix: string): Set<string> {
  const names = new Set<string>();
  const pattern = new RegExp(`${selectorPrefix.replace(/[[\]"=]/g, "\\$&")}[^\\n]*?\\[data-icon="([A-Za-z0-9]+)"\\]`, "g");
  for (const match of css.matchAll(pattern)) names.add(match[1]);
  return names;
}

describe("color.css and the host contract list agree", () => {
  it("tints exactly the timeline glyphs the contract pins", () => {
    const inCss = glyphsIn("[data-timeline-row-id]");
    const inContract = new Set(TIMELINE_GLYPHS.map((entry) => entry.glyph));
    expect([...inCss].sort()).toEqual([...inContract].sort());
  });

  it("tints exactly the plan step glyphs the contract pins", () => {
    for (const { status, glyph } of PLAN_STEP_GLYPHS) {
      expect(css).toContain(`[data-plan-step-status="${status}"] [data-icon="${glyph}"]`);
    }
    const statuses = [...css.matchAll(/\[data-plan-step-status="([a-z]+)"\]/g)].map((match) => match[1]);
    expect(new Set(statuses)).toEqual(new Set(PLAN_STEP_GLYPHS.map((entry) => entry.status)));
  });

  it("names a BB source file for every host-surface block", () => {
    for (const marker of ["Source: apps/app/src/components/ui/markdown-code-highlight.css", "TimelineRowHeader.tsx", "PresentationWorkRowBodies.tsx", "theme.css (`--pill-*`", "markdown-preview.tsx"]) {
      expect(css).toContain(marker);
    }
  });
});

describe("installed BB bundle", () => {
  it.skipIf(install === null)("is found", () => {
    expect(install).not.toBeNull();
  });

  if (install === null) {
    it("is not installed here; set BB_APP_DIR or install bb-app to run the contract checks", () => {
      console.warn("theme: no bb-app install found; host contract checks skipped");
    });
    return;
  }

  const js = readBundleFiles(install, ".js");
  const cssFiles = readBundleFiles(install, ".css");
  const providerPlugins = readBundledProviderPluginFiles(install);

  for (const anchor of HOST_ANCHORS) {
    it(`still has ${anchor.source}`, () => {
      const files = anchor.bundle === "js" ? js : anchor.bundle === "css" ? cssFiles : providerPlugins;
      const missing = anchor.mustContain.filter((needle) => ![...files.values()].some((text) => text.includes(needle)));
      expect(missing, `${anchor.because}\nBB ${install.version} at ${install.root} no longer contains: ${missing.join(" | ")}`).toEqual([]);
    });
  }
});
