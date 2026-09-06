/**
 * Builds the editor bundle this plugin serves, into `dist/monaco`.
 *
 * Monaco and Shiki cannot go through `bb plugin build`: that build emits one
 * file with no code splitting, so 5 MB of editor would parse at app boot for
 * every user, and the language workers could not be emitted at all. Building
 * here keeps them lazy: `lib/monaco-loader.ts` imports `editor.js` from a
 * `files.createPreview` URL the first time an editor opens, and esbuild's
 * code splitting turns every grammar loader in `monaco-bundle/editor.js` into
 * a chunk that loads only for files of that language.
 *
 * `server.ts` runs this script when `dist/monaco` is missing or older than
 * its inputs, so a fresh install builds on first use.
 */
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(pluginRoot, "package.json"));
const esbuild = require("esbuild");

const outDir = path.join(pluginRoot, "dist", "monaco");
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const shared = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "none",
  absWorkingDir: pluginRoot,
  // Monaco's contributions style their icons with a webfont. Inlining it keeps
  // the served bundle free of asset URLs that would have to resolve relative
  // to the preview lease.
  loader: { ".ttf": "dataurl" },
};

const editor = await esbuild.build({
  ...shared,
  entryPoints: { editor: path.join(pluginRoot, "monaco-bundle", "editor.js") },
  outdir: outDir,
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  metafile: true,
});

// Workers run in their own global scope and each must be one self-contained
// file for `new Worker(url)`, so they build without splitting.
const workers = ["editor", "typescript", "json", "css", "html"];
await Promise.all(
  workers.map((name) =>
    esbuild.build({
      ...shared,
      entryPoints: [path.join(pluginRoot, "monaco-bundle", `worker.${name}.js`)],
      outfile: path.join(outDir, `worker.${name}.js`),
    }),
  ),
);

// A bundle can be missing whole features and still load, open a file, and
// accept typing. Fail the build instead of discovering that by hand.
const inputs = Object.keys(editor.metafile.inputs);
const chunkDir = path.join(outDir, "chunks");
const chunks = await readdir(chunkDir);
// With splitting on, Monaco itself lands in a shared chunk, so feature
// strings are searched across every emitted module.
const modules = [path.join(outDir, "editor.js"), ...chunks.map((name) => path.join(chunkDir, name))];
const output = (await Promise.all(modules.map((file) => readFile(file, "utf8")))).join("\n");
const checks = [
  ["language grammars", () => inputs.some((i) => i.includes("languages/definitions/"))],
  ["editor contributions", () => inputs.some((i) => i.includes("editor/contrib/"))],
  ["find widget", () => output.includes("find-widget")],
  ["folding", () => output.includes("foldRecursively")],
  ["word navigation", () => output.includes("cursorWordLeft")],
  ["sticky scroll", () => output.includes("stickyScroll")],
  ["TypeScript language features", () => inputs.some((i) => i.includes("features/typescript/"))],
  ["Shiki core", () => inputs.some((i) => i.includes("@shikijs/core") || i.includes("shiki/dist/core"))],
  ["Shiki grammar chunks", () => chunks.length > 20],
  ["Oniguruma wasm chunk", () => inputs.some((i) => i.includes("engine-oniguruma"))],
];
const missing = checks.filter(([, present]) => !present()).map(([name]) => name);
if (missing.length > 0) {
  throw new Error(`the editor bundle is missing: ${missing.join(", ")} — check monaco-bundle/`);
}

let total = 0;
for (const name of await readdir(outDir)) {
  const info = await stat(path.join(outDir, name));
  if (info.isFile()) total += info.size;
}
for (const name of chunks) total += (await stat(path.join(chunkDir, name))).size;
console.log(
  `editor: built ${outDir} (${(total / 1024 / 1024).toFixed(1)} MB total, ${chunks.length} lazy chunks)`,
);
