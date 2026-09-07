import assert from "node:assert/strict";
import test from "node:test";
import { createHighlighter } from "shiki/bundle/full";
import { conductorCodeTheme } from "./conductor-palette";
import { toPierreTheme } from "./pierre-theme";

test("Conductor colors tokenize TypeScript in both modes with distinct keyword and string colors", async () => {
  for (const [mode, keyword, string] of [["dark", "#f87272", "#ddc1b1"], ["light", "#dc2828", "#594545"]] as const) {
    const name = `conductor-test-${mode}`;
    const highlighter = await createHighlighter({ themes: [toPierreTheme(name, conductorCodeTheme(mode))], langs: ["typescript"] });
    try {
      const tokens = highlighter.codeToTokens('function greet() { return "hello"; }', { lang: "typescript", theme: name }).tokens.flat();
      assert.equal(tokens.find((token) => token.content === "return")?.color?.toLowerCase(), keyword);
      assert.equal(tokens.find((token) => token.content.includes("hello"))?.color?.toLowerCase(), string);
    } finally {
      highlighter.dispose();
    }
  }
});

test("Conductor palette returns independent theme documents", () => {
  const first = conductorCodeTheme("dark");
  (first.colors as Record<string, string>)["editor.background"] = "#000000";
  first.tokenColors[0].settings.foreground = "#ffffff";
  const second = conductorCodeTheme("dark");
  assert.equal(second.bg, "#141110");
  assert.equal(second.colors["editor.background"], "#141110");
  assert.equal(second.tokenColors[0].settings.foreground, "#8e8885");
});
