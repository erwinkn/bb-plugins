import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { BB_DEFAULT, bbThemeId, manifestThemes, pairIdFromBbTheme, THEME_PAIRS, themeNameFor, themePair } from "./themes";

const modules = path.join(import.meta.dirname, "..", "node_modules");

/** A theme name the code view can resolve: Shiki ships it, or Pierre does. */
function resolvable(name: string): boolean {
  return (
    existsSync(path.join(modules, "@shikijs", "themes", "dist", `${name}.mjs`)) ||
    existsSync(path.join(modules, "@pierre", "theme", "themes", `${name}.json`))
  );
}

test("the pairs have unique ids and BB's own family first", () => {
  assert.equal(new Set(THEME_PAIRS.map((pair) => pair.id)).size, THEME_PAIRS.length);
  assert.ok(THEME_PAIRS.length > 20);
  assert.equal(THEME_PAIRS[0]?.id, "pierre-soft");
  assert.ok(!THEME_PAIRS.some((pair) => pair.id === BB_DEFAULT));
});

test("every theme a pair names is one the code view can resolve", () => {
  for (const pair of THEME_PAIRS) {
    assert.ok(resolvable(pair.dark), `${pair.id}: ${pair.dark}`);
    assert.ok(resolvable(pair.light), `${pair.id}: ${pair.light}`);
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
