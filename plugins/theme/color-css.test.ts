import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(import.meta.dirname, "themes", "color.css"), "utf8");

/** Custom properties declared inside every block whose selector list matches. */
function declared(selectorTest: (selector: string) => boolean): Set<string> {
  const names = new Set<string>();
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim().replace(/\s+/g, " ");
    if (!selectorTest(selector)) continue;
    for (const declaration of match[2].matchAll(/(--[a-z0-9-]+)\s*:/g)) names.add(declaration[1]);
  }
  return names;
}

const NEUTRAL_TOKENS = [
  "--canvas", "--ink", "--background", "--foreground", "--muted-foreground", "--subtle-foreground", "--readback-foreground",
  "--border", "--border-hairline", "--border-seam", "--input", "--ring", "--card", "--popover", "--muted", "--secondary", "--accent",
  "--sidebar", "--sidebar-foreground", "--surface-recessed", "--primary", "--primary-foreground", "--font-sans", "--font-mono",
  "--timeline-accent", "--file-accent", "--success", "--warning", "--warning-text", "--attention", "--destructive", "--destructive-text", "--pr-merged",
];

describe("color.css", () => {
  it("defines every hue token for both light and dark", () => {
    const light = declared((selector) => selector === ":root, .light" || selector === ".bb-code-highlight");
    const dark = declared((selector) => selector === ".dark" || selector === ".dark .bb-code-highlight");
    expect([...light].sort()).toEqual([...dark].sort());
    for (const token of ["--bbp-file", "--bbp-command", "--bbp-web", "--bbp-edit", "--bbp-attention", "--bbp-done", "--bbp-error", "--bbp-agent", "--sh-keyword", "--pill-icon"]) {
      expect(light.has(token), token).toBe(true);
    }
  });

  it("leaves the neutral ramp and BB's own chromatic tokens untouched", () => {
    const all = declared(() => true);
    for (const token of NEUTRAL_TOKENS) expect(all.has(token), token).toBe(false);
  });

  it("only introduces --bbp-* tokens beside BB's --sh-* and --pill-* contracts", () => {
    const all = declared(() => true);
    for (const token of all) expect(token, token).toMatch(/^--(bbp|sh|pill)-/);
  });

  it("never uses :has() and keeps every hue in oklch or a var()/color-mix of one", () => {
    const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toContain(":has(");
    expect(code).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(code).not.toMatch(/\b(rgb|hsl)a?\(/);
  });

  it("only references host tokens that BB defines", () => {
    const referenced = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]));
    const own = declared(() => true);
    const host = ["--timeline-accent", "--warning-text", "--warning", "--attention", "--success", "--destructive-text", "--pr-merged", "--muted-foreground", "--ink", "--canvas", "--border"];
    for (const token of referenced) expect(own.has(token) || host.includes(token), token).toBe(true);
  });
});
