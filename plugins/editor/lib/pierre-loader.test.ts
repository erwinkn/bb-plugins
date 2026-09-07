import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

/**
 * The bundle entry and the loader are two files that describe one interface:
 * `pierre-bundle/editor.js` is plain JavaScript that re-exports Pierre, and
 * `PierreBundle` in `lib/pierre-loader.ts` is the only description TypeScript
 * has of it. Nothing makes them agree, and a name that goes missing shows up as
 * "the Pierre bundle did not export ..." at run time, or as undefined much
 * later. These tests compare them directly.
 */
const pluginRoot = path.resolve(import.meta.dirname, "..");
const entry = readFileSync(path.join(pluginRoot, "pierre-bundle", "editor.js"), "utf8");
const loader = readFileSync(path.join(pluginRoot, "lib", "pierre-loader.ts"), "utf8");

/** Every name `pierre-bundle/editor.js` exports, from re-exports and declarations. */
function bundleExports(source: string): Set<string> {
  const names = new Set<string>();
  for (const block of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of block[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name !== undefined && name.length > 0) names.add(name);
    }
  }
  for (const declaration of source.matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(declaration[1]);
  }
  return names;
}

/** The property names of the `PierreBundle` interface. */
function bundleInterfaceMembers(source: string): string[] {
  const start = source.indexOf("export interface PierreBundle {");
  assert.notEqual(start, -1, "PierreBundle is the contract; it must stay named that");
  const body = source.slice(start, source.indexOf("\n}", start));
  const names: string[] = [];
  for (const line of body.split("\n").slice(1)) {
    const match = /^ {2}([A-Za-z_$][\w$]*)[?]?:/.exec(line);
    if (match !== null) names.push(match[1]);
  }
  return names;
}

test("the bundle entry exports everything PierreBundle declares", () => {
  const exported = bundleExports(entry);
  const declared = bundleInterfaceMembers(loader);
  assert.ok(declared.length > 5, "the interface should not have been parsed as empty");
  const missing = declared.filter((name) => !exported.has(name));
  assert.deepEqual(missing, [], "pierre-bundle/editor.js must re-export these");
});

test("a retained lazy runtime accepts theme registration again after the app reloads", () => {
  // Use the real plain-JavaScript entry and Pierre registry in an isolated
  // process. The two callers represent successive app-module instances.
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import { registerCustomTheme } from "./pierre-bundle/editor.js";
    import { getResolvedOrResolveTheme } from "@pierre/diffs";
    const errors = [];
    console.error = (...args) => errors.push(args);
    let firstLoads = 0;
    let secondLoads = 0;
    const name = "bb-reload-regression-theme";
    registerCustomTheme(name, async () => {
      firstLoads++;
      return { name, type: "dark", fg: "#abcdef", bg: "#101010", settings: [] };
    });
    registerCustomTheme(name, async () => {
      secondLoads++;
      return { name, type: "dark", fg: "#ffffff", bg: "#202020", settings: [] };
    });
    const theme = await getResolvedOrResolveTheme(name);
    assert.equal(theme.fg, "#abcdef");
    assert.equal(firstLoads, 1);
    assert.equal(secondLoads, 0);
    assert.deepEqual(errors, []);
  `], { cwd: pluginRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
