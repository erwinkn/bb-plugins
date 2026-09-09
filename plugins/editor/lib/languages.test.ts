import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CLAIMED_EXTENSIONS, FILE_TYPES } from "./languages";

test("claimed extensions satisfy BB's opener rule and are unique", () => {
  assert.ok(CLAIMED_EXTENSIONS.length > 50);
  for (const extension of CLAIMED_EXTENSIONS) assert.match(extension, /^[a-z0-9]+$/, `extension ${extension}`);
  const all = FILE_TYPES.flatMap((type) => type.extensions);
  assert.equal(new Set(all).size, all.length, "an extension belongs to one file type");
});

test("every Shiki grammar the table names ships with the syntax bundle", () => {
  const grammars = path.join(import.meta.dirname, "..", "node_modules", "@shikijs", "langs", "dist");
  for (const type of FILE_TYPES) {
    if (type.grammar === null) continue;
    assert.ok(existsSync(path.join(grammars, `${type.grammar}.mjs`)), `${type.extensions[0]} needs grammar ${type.grammar}`);
  }
});
