import assert from "node:assert/strict";
import test from "node:test";
import { CODE_THEMES, codeThemesOfType, FOLLOW_BB, normalizeThemeSetting, themeSettingOptions } from "./themes";
import { toThemeData } from "./monaco-loader";

test("the catalog has unique ids, both modes, and BB's own family first", () => {
  assert.equal(new Set(CODE_THEMES.map((entry) => entry.id)).size, CODE_THEMES.length);
  assert.ok(codeThemesOfType("dark").length > 10);
  assert.ok(codeThemesOfType("light").length > 5);
  assert.equal(CODE_THEMES[0]?.id, "pierre-dark");
  assert.ok(CODE_THEMES.some((entry) => entry.id === "pierre-dark-soft" && entry.type === "dark"));
});

test("theme setting options start with bb and hold only themes of that mode", () => {
  const dark = themeSettingOptions("dark");
  assert.equal(dark[0], FOLLOW_BB);
  assert.ok(dark.includes("pierre-dark-soft"));
  assert.ok(!dark.includes("pierre-light"));
  assert.ok(themeSettingOptions("light").includes("pierre-light-soft"));
});

test("normalizeThemeSetting falls back to bb for unknown ids and the wrong mode", () => {
  assert.equal(normalizeThemeSetting("pierre-dark-soft", "dark"), "pierre-dark-soft");
  assert.equal(normalizeThemeSetting("pierre-dark-soft", "light"), FOLLOW_BB);
  assert.equal(normalizeThemeSetting("nope", "dark"), FOLLOW_BB);
  assert.equal(normalizeThemeSetting(undefined, "dark"), FOLLOW_BB);
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
  const bare = toThemeData("y", { name: "Y", tokenColors: [] });
  assert.equal(bare.type, "dark");
  assert.equal(bare.fg, "#d4d4d4");
});
