import assert from "node:assert/strict";
import test from "node:test";
import type { PluginCodeThemeData } from "@get-bb/plugin-sdk/app";
import {
  editorBackground,
  mixHex,
  monacoThemeName,
  normalizeFontStyle,
  normalizeHex,
  softenTheme,
  themeFingerprint,
  toMonacoTheme,
  workbenchColors,
} from "./monaco-theme";

function theme(overrides: Partial<PluginCodeThemeData> = {}): PluginCodeThemeData {
  return {
    name: "bb:nord:light:1f4c9a2b",
    type: "light",
    fg: "#2e3440",
    bg: "#eceff4",
    colors: {},
    tokenColors: [],
    ...overrides,
  };
}

test("monacoThemeName produces names Monaco accepts and keeps them distinct", () => {
  assert.match(monacoThemeName("bb:nord:light:1f4c9a2b"), /^[a-zA-Z0-9-]+$/);
  assert.notEqual(monacoThemeName("bb:nord:light"), monacoThemeName("bb:nord:dark"));
});

test("normalizeHex expands short forms, lowercases, and rejects non-hex", () => {
  assert.equal(normalizeHex("#ABC"), "aabbcc");
  assert.equal(normalizeHex("#11223344"), "11223344");
  assert.equal(normalizeHex(["#ff0000", "#00ff00"]), "ff0000");
  assert.equal(normalizeHex("rgba(0,0,0,0.2)"), undefined);
  assert.equal(normalizeHex(undefined), undefined);
});

test("normalizeFontStyle keeps only styles Monaco understands", () => {
  assert.equal(normalizeFontStyle("italic strikethrough wobbly"), "italic strikethrough");
  assert.equal(normalizeFontStyle("bold, underline"), "bold underline");
  assert.equal(normalizeFontStyle("normal"), undefined);
});

test("toMonacoTheme splits multi-scope rules and emits a default rule from fg", () => {
  const result = toMonacoTheme(
    theme({
      type: "dark",
      tokenColors: [
        { scope: ["variable", "entity.name"], settings: { foreground: "#111111" } },
        { scope: "constant, support.type", settings: { foreground: "#222", fontStyle: "italic" } },
        { scope: "keyword", settings: { foreground: "not-a-color" } },
        { settings: { foreground: "#333333" } },
      ],
    }),
  );
  assert.equal(result.base, "vs-dark");
  assert.equal(result.inherit, true);
  assert.deepEqual(result.rules[0], { token: "", foreground: "2e3440" });
  assert.ok(result.rules.some((rule) => rule.token === "entity.name" && rule.foreground === "111111"));
  assert.ok(result.rules.some((rule) => rule.token === "support.type" && rule.foreground === "222222" && rule.fontStyle === "italic"));
  assert.ok(!result.rules.some((rule) => rule.token === "keyword"));
});

test("workbenchColors keeps declared colors and derives the rest from bg/fg", () => {
  const colors = workbenchColors(theme({ colors: { "editor.background": "#1e1e2e", "editorCursor.foreground": "#f5e0dc", "editor.selectionBackground": "rgba(0,0,0,0.2)" } }));
  assert.equal(colors["editor.background"], "#1e1e2e");
  assert.equal(colors["editorCursor.foreground"], "#f5e0dc");
  assert.equal(colors["editor.foreground"], "#2e3440");
  assert.match(colors["editor.selectionBackground"]!, /^#2e3440[0-9a-f]{2}$/);
  assert.match(colors["editorWidget.background"]!, /^#[0-9a-f]{6}$/);
  assert.match(colors["editorLineNumber.foreground"]!, /^#2e3440[0-9a-f]{2}$/);
});

test("editorBackground falls back to the theme's own bg and to null", () => {
  assert.equal(editorBackground(theme({ colors: { "editor.background": "#1e1e2e" } })), "#1e1e2e");
  assert.equal(editorBackground(theme()), "#eceff4");
  assert.equal(editorBackground(null), null);
  assert.equal(editorBackground(theme({ bg: "not-a-color", fg: "nope" })), null);
});

test("themeFingerprint separates documents that share a name", () => {
  const a = theme({ tokenColors: [{ scope: "keyword", settings: { foreground: "#ff0000" } }] });
  const b = theme({ tokenColors: [{ scope: "keyword", settings: { foreground: "#00ff00" } }] });
  assert.notEqual(themeFingerprint(a), themeFingerprint(b));
  assert.equal(themeFingerprint(a), themeFingerprint({ ...a, colors: { "editor.background": "#000000" } }));
});

test("softenTheme pulls token colors toward the foreground and renames the theme", () => {
  const source = theme({ fg: "#000000", tokenColors: [{ scope: "keyword", settings: { foreground: "#ff0000aa" } }] });
  assert.equal(softenTheme(source, 1), source);
  const soft = softenTheme(source, 0.5);
  assert.equal(soft.tokenColors[0]!.settings.foreground, "#800000aa");
  assert.notEqual(soft.name, source.name);
});

test("workbenchColors with BB tokens paints chrome from the app surfaces", () => {
  const tokens = {
    background: "#111111",
    surfaceRaised: "#161616",
    surfaceRecessed: "#1c1c1c",
    popover: "#181818",
    stateHover: "#262626",
    border: "#333333",
    foreground: "#eeeeee",
    mutedForeground: "#999999",
    subtleForeground: "#666666",
    ring: "#8888ff",
  };
  const colors = workbenchColors(theme({ colors: { "editor.background": "#1e1e2e", "editorCursor.foreground": "#abcdef" } }), tokens);
  assert.equal(colors["editor.background"], "#111111");
  assert.equal(colors["editorWidget.background"], "#181818");
  assert.equal(colors["editorLineNumber.foreground"], "#666666");
  assert.equal(colors["editorCursor.foreground"], "#abcdef");
});

test("mixHex blends channels linearly", () => {
  assert.equal(mixHex("000000", "ffffff", 0.5), "808080");
  assert.equal(mixHex("102030", "102030", 0.3), "102030");
});
