import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { BB_DEFAULT, bbThemeId, manifestThemes, pairIdFromBbTheme, THEME_PAIRS, themeNameFor, themePair } from "./themes";
import { toThemeData } from "./monaco-loader";

const bundledThemeNames = (() => {
  const source = readFileSync(new URL("../monaco-bundle/editor.js", import.meta.url), "utf8");
  return new Set([...source.matchAll(/"([a-z0-9-]+)":\s*\(\)\s*=>\s*import\(/g)].map((match) => match[1]));
})();

test("the pairs have unique ids and BB's own family first", () => {
  assert.equal(new Set(THEME_PAIRS.map((pair) => pair.id)).size, THEME_PAIRS.length);
  assert.ok(THEME_PAIRS.length > 20);
  assert.equal(THEME_PAIRS[0]?.id, "pierre-soft");
  assert.ok(!THEME_PAIRS.some((pair) => pair.id === BB_DEFAULT));
});

test("every theme a pair names ships as a preview chunk of the editor bundle", () => {
  for (const pair of THEME_PAIRS) {
    assert.ok(bundledThemeNames.has(pair.dark), `${pair.id}: ${pair.dark}`);
    assert.ok(bundledThemeNames.has(pair.light), `${pair.id}: ${pair.light}`);
  }
});

test("package.json contributes exactly the pairs as BB themes", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { bb: { themes: unknown } };
  assert.deepEqual(manifest.bb.themes, manifestThemes("./themes/default.css"));
});

test("BB theme ids round-trip and foreign themes map to null", () => {
  assert.equal(bbThemeId("erwin-editor", "github"), "plugin:erwin-editor:github");
  assert.equal(pairIdFromBbTheme("erwin-editor", "plugin:erwin-editor:github"), "github");
  assert.equal(pairIdFromBbTheme("erwin-editor", BB_DEFAULT), BB_DEFAULT);
  assert.equal(pairIdFromBbTheme("erwin-editor", "nord"), null);
  assert.equal(pairIdFromBbTheme("erwin-editor", "plugin:erwin-editor:nope"), null);
  assert.equal(pairIdFromBbTheme("erwin-editor", "plugin:other:github"), null);
});

test("themeNameFor picks the mode's theme and BB's default pair", () => {
  assert.equal(themeNameFor("github", "dark"), "github-dark");
  assert.equal(themeNameFor("github", "light"), "github-light");
  assert.equal(themeNameFor(BB_DEFAULT, "dark"), "pierre-dark");
  assert.equal(themeNameFor("nope", "dark"), null);
  assert.equal(themePair("github")?.label, "GitHub");
});

test("toThemeData accepts VS Code's old and new rule keys and derives fg/bg", () => {
  const data = toThemeData("x", {
    name: "X",
    type: "light",
    colors: { "editor.background": "#fefefe", "editor.foreground": "#101010", bogus: 3 as unknown as string },
    settings: [{ settings: { foreground: "#101010" } }, { scope: ["keyword", "storage"], settings: { foreground: "#ff0000", fontStyle: "bold" } }],
  });
  assert.equal(data.name, "x");
  assert.equal(data.type, "light");
  assert.equal(data.fg, "#101010");
  assert.equal(data.bg, "#fefefe");
  assert.deepEqual(data.colors, { "editor.background": "#fefefe", "editor.foreground": "#101010" });
  assert.deepEqual(data.tokenColors, [
    { settings: { foreground: "#101010" } },
    { scope: ["keyword", "storage"], settings: { foreground: "#ff0000", fontStyle: "bold" } },
  ]);
  const bare = toThemeData("y", { name: "Y", settings: [], tokenColors: [] } as Parameters<typeof toThemeData>[1]);
  assert.equal(bare.type, "dark");
  assert.equal(bare.fg, "#d4d4d4");
});
