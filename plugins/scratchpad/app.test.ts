import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

// app.tsx imports CSS and React, so it cannot load under node; these checks
// read the source for the contracts the README states.
const source = readFileSync(path.join(import.meta.dirname, "app.tsx"), "utf8");

test("the scratchpad is reachable only as a right-panel tab", () => {
  assert.match(source, /app\.slots\.threadPanelAction\(\{ id: ACTION/);
  assert.doesNotMatch(source, /experimental_threadHeaderAction/);
  assert.doesNotMatch(source, /sp-header-action/);
  assert.doesNotMatch(readFileSync(path.join(import.meta.dirname, "style.css"), "utf8"), /sp-header-action/);
});

test("code highlighting follows BB's code theme and loads Shiki lazily", () => {
  assert.match(source, /experimental_useCodeTheme\(\)/);
  assert.match(source, /SyntaxHighlightingExtension\(\{ createHighlighter:/);
  assert.match(source, /import\("\.\/highlighter"\)/);
  // A static import would bundle Shiki into the app's start-up path.
  assert.doesNotMatch(source, /^import .* from "\.\/highlighter"/m);
  assert.doesNotMatch(source, /^import .* from "@shikijs/m);
  // The block schema is unchanged, so stored documents keep their shape.
  assert.doesNotMatch(readFileSync(path.join(import.meta.dirname, "schema.ts"), "utf8"), /supportedLanguages|createCodeBlockSpec/);
});
