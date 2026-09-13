import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginCodeThemeData } from "@get-bb/plugin-sdk/app";
import { createBundledHighlighter } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import { codeThemeName, toShikiTheme } from "./code-theme";
import { GRAMMAR_SOURCES } from "./grammar-sources";

const light: PluginCodeThemeData = {
  name: "pierre-light",
  type: "light",
  fg: "#24292e",
  bg: "#ffffff",
  colors: { "editor.background": "#ffffff" },
  tokenColors: [
    { settings: { foreground: "#24292e" } },
    { scope: "keyword, storage.type", settings: { foreground: "#d73a49" } },
    { scope: ["string", "string.quoted"], settings: { foreground: "#032f62", fontStyle: "italic" } },
  ],
};
const dark: PluginCodeThemeData = { ...light, name: "pierre-dark", type: "dark", fg: "#e1e4e8", bg: "#24292e", tokenColors: [
  { settings: { foreground: "#e1e4e8" } },
  { scope: "keyword, storage.type", settings: { foreground: "#f97583" } },
] };

test("names are hex-only, stable, and change with any colour", () => {
  const name = codeThemeName(light);
  assert.match(name, /^bbsp-[0-9a-f]{8}$/);
  assert.doesNotMatch(name, /light|dark/i);
  assert.equal(codeThemeName({ ...light, colors: { ...light.colors } }), name);
  assert.notEqual(codeThemeName(dark), name);
  assert.notEqual(codeThemeName({ ...light, tokenColors: [...light.tokenColors.slice(0, 2), { scope: ["string", "string.quoted"], settings: { foreground: "#032f63", fontStyle: "italic" } }] }), name);
});

test("comma-separated scopes are split so every selector matches", () => {
  const registration = toShikiTheme("bbsp-x", light);
  assert.equal(registration.name, "bbsp-x");
  assert.equal(registration.type, "light");
  assert.equal(registration.fg, "#24292e");
  assert.deepEqual(registration.colors, { "editor.background": "#ffffff" });
  assert.deepEqual(registration.settings, [
    { settings: { foreground: "#24292e" } },
    { scope: ["keyword", "storage.type"], settings: { foreground: "#d73a49" } },
    { scope: ["string", "string.quoted"], settings: { foreground: "#032f62", fontStyle: "italic" } },
  ]);
  assert.deepEqual(light.tokenColors[1], { scope: "keyword, storage.type", settings: { foreground: "#d73a49" } });
});

test("a converted theme colours tokens in light and in dark", async () => {
  const create = createBundledHighlighter<string, string>({
    langs: { typescript: GRAMMAR_SOURCES["typescript"]! },
    themes: {},
    engine: () => createJavaScriptRegexEngine({ forgiving: true }),
  });
  const lightName = codeThemeName(light);
  const darkName = codeThemeName(dark);
  const highlighter = await create({ themes: [toShikiTheme(lightName, light)], langs: ["typescript"] });
  await highlighter.loadTheme(toShikiTheme(darkName, dark));
  const first = (theme: string) => highlighter.codeToTokens("const s = 'x';", { lang: "typescript", theme }).tokens[0]!;
  const lightTokens = first(lightName);
  assert.equal(lightTokens[0]!.content, "const");
  assert.equal(lightTokens[0]!.color, "#D73A49");
  assert.equal(lightTokens.find((token) => token.content.includes("x"))?.color, "#032F62");
  const darkTokens = first(darkName);
  assert.equal(darkTokens[0]!.color, "#F97583");
  assert.equal(highlighter.codeToTokens("x", { lang: "typescript", theme: darkName }).fg, "#e1e4e8");
});
