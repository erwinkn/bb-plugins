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

test("the bundle entry checks the custom element before it imports Pierre", () => {
  // `@pierre/diffs` defines `<diffs-container>` as an import side effect, and
  // only when no other copy defined it first. Reading the registry after that
  // import would always say the element exists and hide the collision.
  const ownerImport = entry.indexOf('from "./container-owner.js"');
  const pierreImport = entry.indexOf('from "@pierre/diffs"');
  assert.notEqual(ownerImport, -1);
  assert.notEqual(pierreImport, -1);
  assert.ok(ownerImport < pierreImport, "container-owner.js must be imported first");
});

test("the worker entry keeps its module from being tree shaken", () => {
  // `@pierre/diffs` leaves its worker out of the package `sideEffects` list, so
  // a specifier on its own line is dropped as unused and the built worker
  // answers no message at all. Binding the namespace and re-exporting it keeps
  // the module. The build checks for the listener; this states why it is there.
  //
  // The specifier is assembled instead of written out because the SDK's
  // public-import scan reads this file as text and would treat it as a real
  // dependency of the test.
  const specifier = ["@pierre", "diffs", "worker", "worker.js"].join("/");
  const worker = readFileSync(path.join(pluginRoot, "pierre-bundle", "worker.js"), "utf8");
  assert.ok(worker.includes(specifier), "the worker entry must point at Pierre's worker");
  assert.match(worker, /import \* as (\w+)/, "a namespace binding is what keeps it");
  assert.match(worker, /export \{ \w+ \}/, "and the re-export is what keeps the binding");
});

test("the loader asks for the exports whose absence breaks a surface", () => {
  // A missing export must fail with the bundle's name, not as `undefined is not
  // a constructor` somewhere inside a render.
  for (const name of ["CodeView", "Editor", "parseDiffFromFile", "registerCustomTheme"]) {
    assert.ok(loader.includes(`"${name}"`), `boot() should verify ${name}`);
  }
});

test("the loader builds its URLs from the opaque asset base", () => {
  // The server returns a base that carries a bundle hash, so the entry and the
  // worker must both be addressed relative to it and nothing may be assumed
  // about its shape.
  assert.ok(loader.includes("`${baseUrl}/editor.js`"));
  assert.ok(loader.includes("`${baseUrl}/worker.js`"));
});
