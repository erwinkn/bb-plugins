import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileGlyph, spriteSymbols, TOKEN_COLORS } from "./file-icons.js";

test("common files resolve to the tokens BB's tree uses", () => {
  const token = (file: string) => fileGlyph(file)?.token;
  assert.equal(token("src/app.tsx"), "react");
  assert.equal(token("src/index.ts"), "typescript");
  assert.equal(token("lib/util.js"), "javascript");
  assert.equal(token("package.json"), "npm");
  assert.equal(token("tsconfig.json"), "json");
  assert.equal(token("README.md"), "markdown");
  assert.equal(token(".gitignore"), "git");
  assert.equal(token("Dockerfile"), "docker");
  assert.equal(token("main.rs"), "rust");
  assert.equal(token("main.go"), "go");
  assert.equal(token("script.py"), "python");
  assert.equal(token("deploy.yaml"), "yml");
  assert.equal(token("logo.png"), "image");
  assert.equal(token("icon.svg"), "svg");
  assert.equal(token("data.csv"), "table");
  assert.equal(token("schema.sql"), "database");
  assert.equal(token("notes.txt"), "text");
  assert.equal(token("events.ndjson"), "json");
  assert.equal(token("Cargo.toml"), "yml");
  assert.equal(token("Makefile"), "default");
  assert.equal(token("no-extension"), "default");
});

test("every glyph has a viewBox, markup and a colour or a deliberate muted token", () => {
  const muted = new Set(["font", "nextjs", "stylelint"]);
  for (const [id, symbol] of spriteSymbols()) {
    if (!id.startsWith("file-tree-builtin-")) continue;
    const token = id.slice("file-tree-builtin-".length);
    assert.match(symbol.viewBox, /^0 0 \d+ \d+$/, id);
    assert.ok(symbol.body.includes("<path"), id);
    assert.ok(TOKEN_COLORS[token] !== undefined || muted.has(token), `${token} has no colour`);
  }
  assert.equal(fileGlyph("a.ttf")?.color, null);
  assert.equal(fileGlyph("a.ts")?.color, "light-dark(#1a85d4, #69b1ff)");
});

test("the copied palette matches the installed @pierre/trees stylesheet", () => {
  const source = readFileSync(
    path.join(import.meta.dirname, "..", "node_modules", "@pierre", "trees", "dist", "style.js"),
    "utf8",
  );
  const pairs = [...source.matchAll(/--trees-file-icon-color-([a-z]+):\s*var\(\s*--trees-file-icon-[a-z]+,\s*var\(--trees-icon-([a-z]+)\)/g)];
  assert.ok(pairs.length >= 50);
  for (const [, token, palette] of pairs) assert.equal(TOKEN_COLORS[token!], palette, token);
  assert.equal(Object.keys(TOKEN_COLORS).length, pairs.length);
  const swatches = Object.fromEntries([...source.matchAll(/--trees-icon-([a-z]+):\s*(light-dark\([^)]*\))/g)].map((m) => [m[1], m[2]]));
  assert.equal(fileGlyph("a.ts")?.color, swatches["blue"]);
  assert.equal(fileGlyph("a.md")?.color, swatches["green"]);
  assert.equal(fileGlyph(".gitignore")?.color, swatches["vermilion"]);
});
