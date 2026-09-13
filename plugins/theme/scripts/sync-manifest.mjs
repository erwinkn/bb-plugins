#!/usr/bin/env node
// Write lib/theme-pairs.ts into package.json `bb.themes`. Run after editing
// the pair list; manifest.test.ts fails while the two disagree.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { manifestThemes } = await import(join(root, "lib", "theme-pairs.ts"));
const path = join(root, "package.json");
const manifest = JSON.parse(readFileSync(path, "utf8"));
manifest.bb.themes = manifestThemes();
writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${manifest.bb.themes.length} themes to package.json`);
