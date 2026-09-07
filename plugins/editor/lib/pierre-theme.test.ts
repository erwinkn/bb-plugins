import assert from "node:assert/strict";
import test from "node:test";
import type { PluginCodeThemeData } from "@get-bb/plugin-sdk/app";
import {
  applyPierreTheme,
  pierreThemeName,
  resetPierreThemesForTests,
  toPierreTheme,
  type PierreThemeInput,
} from "./pierre-theme.js";
import type { PierreRuntime } from "./pierre-loader.js";

function theme(overrides: Partial<PluginCodeThemeData> = {}): PluginCodeThemeData {
  return {
    name: "BB Dark",
    type: "dark",
    fg: "#d4d4d4",
    bg: "#1e1e1e",
    colors: { "editor.background": "#1e1e1e" },
    tokenColors: [{ scope: "comment", settings: { foreground: "#6a9955", fontStyle: "italic" } }],
    ...overrides,
  };
}

/**
 * Pierre rejects a resolved theme whose `name` differs from the name it asked
 * for, so the registration has to carry the registered name, not BB's.
 */
test("toPierreTheme carries the registered name, not the BB name", () => {
  const converted = toPierreTheme("bb-dark-x", theme()) as { name: string; type: string };
  assert.equal(converted.name, "bb-dark-x");
  assert.equal(converted.type, "dark");
});

test("toPierreTheme normalizes token scopes to arrays and copies the colors", () => {
  const converted = toPierreTheme("bb-dark-x", theme()) as unknown as {
    colors: Record<string, string>;
    settings: { scope?: string[]; settings: { foreground?: string } }[];
  };
  assert.deepEqual(converted.settings[0].scope, ["comment"]);
  assert.equal(converted.settings[0].settings.foreground, "#6a9955");
  assert.equal(converted.colors["editor.background"], "#1e1e1e");
});

test("toPierreTheme keeps a rule that applies to every scope", () => {
  const source = theme({ tokenColors: [{ settings: { foreground: "#ffffff" } }] });
  const converted = toPierreTheme("bb-dark-x", source) as unknown as {
    settings: { scope?: string[] }[];
  };
  assert.equal(converted.settings.length, 1);
  assert.equal(converted.settings[0].scope, undefined);
});

test("toPierreTheme does not alias the BB document", () => {
  const source = theme();
  const converted = toPierreTheme("bb-dark-x", source) as unknown as {
    colors: Record<string, string>;
  };
  converted.colors["editor.background"] = "#000000";
  assert.equal(source.colors["editor.background"], "#1e1e1e");
});

/**
 * Pierre resolves a theme name once and caches the result, so a document that
 * changes under an unchanged name would keep painting the old colors.
 */
test("pierreThemeName changes when any painted value changes", () => {
  const base = pierreThemeName(theme());
  assert.equal(base, pierreThemeName(theme()), "the same document keeps its name");
  assert.notEqual(base, pierreThemeName(theme({ fg: "#ffffff" })));
  assert.notEqual(base, pierreThemeName(theme({ colors: { "editor.background": "#101010" } })));
  assert.notEqual(
    base,
    pierreThemeName(theme({ tokenColors: [{ scope: "comment", settings: { foreground: "#000000" } }] })),
  );
  assert.notEqual(base, pierreThemeName(theme({ type: "light" })));
});

test("pierreThemeName is safe to use as a theme name", () => {
  const name = pierreThemeName(theme({ name: "One Dark Pro / soft" }));
  assert.match(name, /^[a-zA-Z0-9_-]+$/);
});

function fakeRuntime(): { runtime: PierreRuntime; registered: string[] } {
  const registered: string[] = [];
  const runtime = {
    registerCustomTheme: (name: string) => {
      registered.push(name);
    },
  } as unknown as PierreRuntime;
  return { runtime, registered };
}

function input(data: PluginCodeThemeData | null): PierreThemeInput {
  return data === null
    ? { id: "pierre-dark", type: "dark", data: null, fallback: "pierre-dark" }
    : { id: pierreThemeName(data), type: data.type, data, fallback: "pierre-dark" };
}

test("applyPierreTheme registers a document once and returns its name", () => {
  resetPierreThemesForTests();
  const { runtime, registered } = fakeRuntime();
  const first = applyPierreTheme(runtime, input(theme()));
  const second = applyPierreTheme(runtime, input(theme()));
  assert.equal(first, second);
  assert.deepEqual(registered, [first], "a second registration would make Pierre log an error");
});

test("applyPierreTheme registers again after the colors change", () => {
  resetPierreThemesForTests();
  const { runtime, registered } = fakeRuntime();
  applyPierreTheme(runtime, input(theme()));
  applyPierreTheme(runtime, input(theme({ fg: "#ffffff" })));
  assert.equal(registered.length, 2);
  assert.notEqual(registered[0], registered[1]);
});

test("applyPierreTheme falls back to a bundled theme while BB is still resolving", () => {
  resetPierreThemesForTests();
  const { runtime, registered } = fakeRuntime();
  assert.equal(applyPierreTheme(runtime, input(null)), "pierre-dark");
  assert.deepEqual(registered, []);
});
