import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CLAIMED_EXTENSIONS, EXTRA_LANGUAGES, LANGUAGES, languageForPath } from "./languages";

test("claimed extensions satisfy BB's opener rule and map to a language", () => {
  assert.ok(CLAIMED_EXTENSIONS.length > 50);
  for (const extension of CLAIMED_EXTENSIONS) {
    assert.match(extension, /^[a-z0-9]+$/, `extension ${extension}`);
    assert.notEqual(languageForPath(`file.${extension}`).id, "");
  }
});

test("languageForPath prefers special file names, then extensions, then plaintext", () => {
  assert.equal(languageForPath("src/Dockerfile").id, "dockerfile");
  assert.equal(languageForPath("Makefile").id, "makefile");
  assert.equal(languageForPath(".env.local").id, "dotenv");
  assert.equal(languageForPath("a/b/component.tsx").id, "typescriptreact");
  assert.equal(languageForPath("a/b/module.ts").id, "typescript");
  assert.equal(languageForPath("C:\\repo\\main.rs").id, "rust");
  assert.equal(languageForPath("noext").id, "plaintext");
  assert.equal(languageForPath("trailing.").id, "plaintext");
  assert.equal(languageForPath(".hidden").id, "plaintext");
});

test("every Shiki grammar the table names has a loader in the editor bundle", () => {
  const bundle = readFileSync(path.join(import.meta.dirname, "..", "monaco-bundle", "editor.js"), "utf8");
  const loaders = new Set([...bundle.matchAll(/^\s+"?([a-z0-9-]+)"?: \(\) => import\("@shikijs\/langs\//gm)].map((m) => m[1]));
  for (const language of LANGUAGES) {
    if (language.grammar !== null) assert.ok(loaders.has(language.grammar), `${language.id} needs grammar ${language.grammar}`);
  }
  const needed = new Set(LANGUAGES.map((language) => language.grammar));
  for (const loader of loaders) assert.ok(needed.has(loader), `grammar loader ${loader} is unused`);
});

test("language ids are unique and extra languages are the non-builtin ones", () => {
  const ids = LANGUAGES.map((language) => language.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(EXTRA_LANGUAGES.some((language) => language.id === "typescriptreact"));
  assert.ok(EXTRA_LANGUAGES.every((language) => !language.builtin));
});
