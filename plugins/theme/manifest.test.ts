import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findBbInstall, shippedCodeThemeNames } from "./lib/bb-install";
import { manifestThemes, THEME_CSS, THEME_ID_PREFIX, THEME_PAIRS } from "./lib/theme-pairs";

interface ManifestTheme {
  id: string;
  name: string;
  css: string;
  codeTheme: { dark: string; light: string };
}

const root = import.meta.dirname;
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name: string;
  bb: { server: string; app?: string; themes: ManifestTheme[] };
};
const themes = manifest.bb.themes;

describe("bb.themes manifest", () => {
  it("is exactly the pair list (run `npm run sync` after editing lib/theme-pairs.ts)", () => {
    expect(themes).toEqual(manifestThemes());
  });

  it("has unique, prefixed ids with the Pierre pairs first", () => {
    expect(new Set(themes.map((theme) => theme.id)).size).toBe(themes.length);
    for (const theme of themes) expect(theme.id.startsWith(THEME_ID_PREFIX), theme.id).toBe(true);
    expect(themes.slice(0, 3).map((theme) => theme.id)).toEqual(["color-pierre", "color-pierre-soft", "color-pierre-vibrant"]);
    expect(THEME_PAIRS.length).toBeGreaterThan(30);
  });

  it("points every entry at the one color stylesheet, which exists", () => {
    for (const theme of themes) expect(theme.css).toBe(THEME_CSS);
    expect(existsSync(join(root, THEME_CSS))).toBe(true);
    expect(existsSync(join(root, manifest.bb.server))).toBe(true);
  });

  it("ships the provider-mark frontend entry", () => {
    expect(manifest.bb.app).toBe("./app.tsx");
    expect(existsSync(join(root, "app.tsx"))).toBe(true);
  });

  it("uses code theme names BB accepts", () => {
    for (const theme of themes) {
      for (const name of [theme.codeTheme.dark, theme.codeTheme.light]) {
        expect(name, theme.id).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
      }
    }
  });

  const install = findBbInstall();
  it.skipIf(install === null)("uses only code themes the installed BB ships", () => {
    const shipped = shippedCodeThemeNames(install!);
    expect(shipped.has("pierre-dark") && shipped.has("pierre-light")).toBe(true);
    const missing = themes.flatMap((theme) =>
      [theme.codeTheme.dark, theme.codeTheme.light].filter((name) => !shipped.has(name)).map((name) => `${theme.id}: ${name}`),
    );
    expect(missing, `BB ${install?.version} does not ship these code themes`).toEqual([]);
  });
});
