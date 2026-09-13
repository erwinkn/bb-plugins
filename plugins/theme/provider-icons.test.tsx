import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import { findBbInstall, readBundleFiles } from "./lib/bb-install";
import { BB_PROVIDER_IDS } from "./lib/host-contract";
import { markColor, PROVIDER_MARKS } from "./lib/provider-marks";

const css = readFileSync(join(import.meta.dirname, "themes", "color.css"), "utf8");
const app = await loadPluginApp(() => import("./app"));

/** `--name: value;` pairs declared inside every block whose selector matches. */
function declarations(selectorTest: (selector: string) => boolean): Map<string, string> {
  const out = new Map<string, string>();
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim().replace(/\s+/g, " ");
    if (!selectorTest(selector)) continue;
    for (const declaration of match[2].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(declaration[1], declaration[2].trim());
  }
  return out;
}

/** Relative luminance (WCAG Y) of an `oklch(L C H)` color, clipped to sRGB. */
function luminance(oklch: string): number {
  const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(oklch);
  if (!match) throw new Error(`not a plain oklch() value: ${oklch}`);
  const L = Number(match[1]);
  const C = Number(match[2]);
  const h = (Number(match[3]) * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  const clip = (v: number) => Math.min(1, Math.max(0, v));
  return 0.2126 * clip(r) + 0.7152 * clip(g) + 0.0722 * clip(bl);
}

function contrast(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/* BB 0.43.1 canvases: light `--canvas: oklch(100% 0 0)`, dark `oklch(19.5% 0 0)`. */
const LIGHT_CANVAS = luminance("oklch(1 0 0)");
const DARK_CANVAS = luminance("oklch(0.195 0 0)");

describe("app.tsx provider icons", () => {
  it("registers one agent mark per provider, ids valid and unique", () => {
    const ids = app.providerIcons.map((entry) => entry.providerId);
    expect(ids).toEqual(PROVIDER_MARKS.map((mark) => mark.providerId));
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of app.providerIcons) {
      expect(entry.providerKind).toBe("agent");
      expect(entry.providerId).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
    }
    expect(app.contentScripts).toEqual([]);
  });

  it("only registers ids BB declares or our Devin plugin, and covers the configured providers", () => {
    const known = new Set([...BB_PROVIDER_IDS, "acp-devin"]);
    for (const mark of PROVIDER_MARKS) expect(known.has(mark.providerId), mark.providerId).toBe(true);
    const ids = new Set(PROVIDER_MARKS.map((mark) => mark.providerId));
    for (const id of ["claude-code", "codex", "acp-cursor", "acp-grok", "acp-opencode", "acp-devin"]) expect(ids.has(id), id).toBe(true);
    // BB tints pi itself; hermes and omp keep BB's masks until artwork is confirmed.
    for (const id of ["pi", "acp-hermes-agent", "acp-omp"]) expect(ids.has(id), id).toBe(false);
  });

  for (const mark of PROVIDER_MARKS) {
    it(`${mark.providerId}: renders an inline SVG in its brand hue with a BB fallback`, () => {
      const html = renderToStaticMarkup(createElement(mark.icon, { className: "size-full" }));
      expect(html.startsWith("<svg")).toBe(true);
      expect(html).toMatch(/viewBox="[-\d. ]+"/);
      expect(html).toContain("<path d=");
      expect(html).toContain('class="size-full"');
      expect(html).toContain('aria-hidden="true"');
      expect(html).toContain(`color:${markColor(mark.token, mark.fallback)}`);
      expect(html).toContain('fill="currentColor"');
      // No literal colors: the hue comes from the token or the fallback only.
      expect(html).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(html).not.toMatch(/\b(rgb|hsl|oklch)a?\(/);
    });
  }

  it("defines every brand token in color.css for light and dark", () => {
    const light = declarations((selector) => selector === ":root, .light");
    const dark = declarations((selector) => selector === ".dark");
    for (const mark of PROVIDER_MARKS) {
      expect(light.has(mark.token), `${mark.token} light`).toBe(true);
      expect(dark.has(mark.token), `${mark.token} dark`).toBe(true);
    }
    const brandTokens = [...light.keys()].filter((token) => token.startsWith("--bbp-brand-"));
    expect(brandTokens.sort()).toEqual(PROVIDER_MARKS.map((mark) => mark.token).sort());
  });

  it("keeps every brand glyph at 3:1 or better on BB's light and dark canvases", () => {
    const light = declarations((selector) => selector === ":root, .light");
    const dark = declarations((selector) => selector === ".dark");
    /* BB 0.43.1 `--ink`: light oklch(32.11% 0 0), dark oklch(81% 0 0). */
    const resolve = (value: string, ink: string) => (value === "var(--ink)" ? ink : value);
    for (const mark of PROVIDER_MARKS) {
      const onLight = contrast(luminance(resolve(light.get(mark.token)!, "oklch(0.3211 0 0)")), LIGHT_CANVAS);
      const onDark = contrast(luminance(resolve(dark.get(mark.token)!, "oklch(0.81 0 0)")), DARK_CANVAS);
      expect(onLight, `${mark.token} light ${onLight.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
      expect(onDark, `${mark.token} dark ${onDark.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
    }
  });

  const install = findBbInstall();
  it.skipIf(install === null)("falls back to tokens BB defines in both modes", () => {
    const bundleCss = [...readBundleFiles(install!, ".css").values()].join("\n");
    const darkBlocks = [...bundleCss.matchAll(/\.dark\{([^}]*)\}/g)].map((match) => match[1]).join(";");
    const lightBlocks = [...bundleCss.matchAll(/(?:^|\})(?::root|\.light)[^{]*\{([^}]*)\}/g)].map((match) => match[1]).join(";");
    for (const fallback of new Set(PROVIDER_MARKS.map((mark) => mark.fallback))) {
      expect(lightBlocks, `${fallback} light`).toContain(`${fallback}:`);
      expect(darkBlocks, `${fallback} dark`).toContain(`${fallback}:`);
    }
  });
});
