import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { BB_DEFAULT, CODE_THEME_CHOICES, codeThemeId, codeThemeLabel, FOLLOW_BB, THEME_PAIRS, themeNameFor } from "./themes";

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

test("package.json contributes no BB themes; the theme plugin owns them", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { bb: { themes?: unknown } };
  assert.equal(manifest.bb.themes, undefined);
  assert.ok(!existsSync(path.join(import.meta.dirname, "..", "themes")));
});

test("themeNameFor picks the mode's theme and BB's default pair", () => {
  assert.equal(themeNameFor("github", "dark"), "github-dark");
  assert.equal(themeNameFor("github", "light"), "github-light");
  assert.equal(themeNameFor(BB_DEFAULT, "dark"), "pierre-dark");
  assert.equal(themeNameFor("nope", "dark"), null);
  assert.equal(themeNameFor(FOLLOW_BB, "dark"), "bb");
  assert.ok(!THEME_PAIRS.some((pair) => pair.id === "conductor" || pair.id === FOLLOW_BB));
});

test("settings labels and picker ids round-trip through the same catalog", () => {
  assert.equal(new Set(CODE_THEME_CHOICES.map((choice) => choice.label)).size, CODE_THEME_CHOICES.length);
  for (const choice of CODE_THEME_CHOICES) {
    assert.equal(codeThemeId(choice.label), choice.id);
    assert.equal(codeThemeLabel(choice.id), choice.label);
  }
  for (const value of [undefined, null, "conductor", "unknown", {}]) assert.equal(codeThemeId(value), FOLLOW_BB);
});
