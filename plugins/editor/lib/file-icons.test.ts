import assert from "node:assert/strict";
import { test } from "node:test";
import { fileGlyph, ROLE_COLORS, roleColor, spriteSymbols, TOKEN_ROLES } from "./file-icons.js";

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

test("every sprite token has a role, and every glyph has a viewBox and markup", () => {
  for (const [id, symbol] of spriteSymbols()) {
    if (!id.startsWith("file-tree-builtin-")) continue;
    const token = id.slice("file-tree-builtin-".length);
    assert.match(symbol.viewBox, /^0 0 \d+ \d+$/, id);
    assert.ok(symbol.body.includes("<path"), id);
    assert.ok(TOKEN_ROLES[token] !== undefined, `${token} has no role`);
  }
  const sprite = new Set([...spriteSymbols().keys()].filter((id) => id.startsWith("file-tree-builtin-")).map((id) => id.slice("file-tree-builtin-".length)));
  for (const token of Object.keys(TOKEN_ROLES)) assert.ok(sprite.has(token), `${token} is not in the sprite`);
});

test("extensions map to the BB Color roles: source blue, languages amber-orange, styles purple, data amber, shell teal, images cyan, prose muted", () => {
  const role = (file: string) => fileGlyph(file)?.role;
  for (const file of ["a.ts", "a.tsx", "a.js", "a.jsx", "a.mjs"]) assert.equal(role(file), "file", file);
  for (const file of ["a.rs", "a.py", "a.go"]) assert.equal(role(file), "edit", file);
  for (const file of ["a.css", "a.scss", "a.sass"]) assert.equal(role(file), "agent", file);
  for (const file of ["a.json", "a.yaml", "a.yml", "a.toml"]) assert.equal(role(file), "attention", file);
  for (const file of ["a.sh", "a.bash", "Dockerfile", "package.json", ".gitignore"]) assert.equal(role(file), "command", file);
  for (const file of ["a.png", "a.jpg", "a.svg"]) assert.equal(role(file), "web", file);
  for (const file of ["README.md", "notes.txt", "Makefile", "a.zip"]) assert.equal(role(file), "subtle", file);
});

test("colours are role tokens with a BB fallback; subtle glyphs inherit the text colour", () => {
  for (const [role, color] of Object.entries(ROLE_COLORS)) {
    assert.match(color, new RegExp(`^var\\(--bbp-${role}, var\\(--[a-z-]+\\)\\)$`), role);
  }
  assert.equal(roleColor("subtle"), null);
  assert.equal(fileGlyph("a.ts")?.color, "var(--bbp-file, var(--timeline-accent))");
  assert.equal(fileGlyph("a.rs")?.color, "var(--bbp-edit, var(--warning-text))");
  assert.equal(fileGlyph("README.md")?.color, null);
  assert.equal(fileGlyph("a.ttf")?.color, null);
});
