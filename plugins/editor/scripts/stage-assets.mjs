/**
 * Builds the Pierre editor bundle this plugin serves, into `assets/pierre`.
 *
 * Pierre cannot go through `bb plugin build`: that build emits one file with no
 * code splitting, so every Shiki grammar and theme would parse at app boot for
 * every user, and the syntax worker could not be emitted at all. Building here
 * keeps them lazy. `lib/pierre-loader.ts` imports `editor.js` from the plugin's
 * own `/http/pierre` routes the first time a surface opens, and esbuild's code
 * splitting turns each grammar and theme loader into a chunk that loads only
 * for files of that language.
 *
 * The syntax worker builds separately, not as a second entry of the same build.
 * Shared chunks would let a module that the main thread pulls in for its DOM
 * work reach the worker's global scope, where `document` does not exist. The
 * duplicated Shiki core is worth that isolation.
 *
 * Run this during development and commit its output. The installed plugin
 * serves these files without running a build. An optional output directory
 * argument lets check-assets.mjs compare a fresh build with the committed one.
 */
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(pluginRoot, "package.json"));
const esbuild = require("esbuild");

const outDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(pluginRoot, "assets", "pierre");
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
const fontInput = "node_modules/@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2";
await copyFile(path.join(pluginRoot, fontInput), path.join(outDir, "geist-mono-5.3.0-latin.woff2"));

const shared = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  // License texts ship as `LICENSES.txt` beside the bundle instead of as a
  // comment in every chunk. See collectLicenses below.
  legalComments: "none",
  absWorkingDir: pluginRoot,
  metafile: true,
};

const editor = await esbuild.build({
  ...shared,
  entryPoints: { editor: path.join(pluginRoot, "pierre-bundle", "editor.js") },
  outdir: outDir,
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
});

// The worker runs in its own global scope. Splitting keeps `import("shiki/wasm")`
// a lazy chunk, so the worker only pays for WebAssembly when the Oniguruma
// engine is chosen. That needs `new Worker(url, { type: "module" })`.
const worker = await esbuild.build({
  ...shared,
  entryPoints: { worker: path.join(pluginRoot, "pierre-bundle", "worker.js") },
  outdir: outDir,
  splitting: true,
  chunkNames: "worker-chunks/[name]-[hash]",
});

/** Files under `dir`, as POSIX paths relative to it. */
async function listFiles(dir, prefix = "") {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await listFiles(path.join(dir, entry.name), relative)));
    else if (entry.isFile()) out.push(relative);
  }
  return out;
}

const emitted = await listFiles(outDir);
const editorModules = emitted.filter((name) => name === "editor.js" || name.startsWith("chunks/"));
const workerModules = emitted.filter((name) => name === "worker.js" || name.startsWith("worker-chunks/"));
const read = async (names) =>
  (await Promise.all(names.map((name) => readFile(path.join(outDir, name), "utf8")))).join("\n");
const editorOutput = await read(editorModules);
const workerOutput = await read(workerModules);
const editorInputs = Object.keys(editor.metafile.inputs);
const workerInputs = Object.keys(worker.metafile.inputs);
const grammarChunks = editorModules.filter((name) => name.startsWith("chunks/")).length;

// A bundle can be missing whole features and still load and render one file.
// Fail the build instead of discovering that by hand.
const checks = [
  ["Pierre core", () => editorInputs.some((i) => i.endsWith("@pierre/diffs/dist/index.js"))],
  ["the editor", () => editorInputs.some((i) => i.endsWith("@pierre/diffs/dist/editor/editor.js"))],
  ["the CodeView viewer", () => editorInputs.some((i) => i.endsWith("dist/components/CodeView.js"))],
  ["the search panel", () => editorInputs.some((i) => i.endsWith("dist/editor/searchPanel.js"))],
  ["the diffs-container element", () => editorOutput.includes("customElements.define")],
  ["custom theme registration", () => editorOutput.includes("registerCustomTheme")],
  ["lazy Shiki grammars", () => grammarChunks > 50],
  ["the worker message listener", () => workerOutput.includes('addEventListener("message"')],
  ["the worker highlighter", () => workerInputs.some((i) => i.includes("shiki"))],
  // The whole point of splitting the worker: WebAssembly must stay a chunk
  // instead of loading with every worker the pool starts.
  ["a lazy worker chunk", () => workerModules.some((name) => name.startsWith("worker-chunks/"))],
];
const missing = checks.filter(([, present]) => !present()).map(([name]) => name);
if (missing.length > 0) {
  throw new Error(`the Pierre bundle is missing: ${missing.join(", ")} — check pierre-bundle/`);
}

/**
 * A second React in the page is the failure this whole split exists to prevent:
 * the plugin's app bundle runs inside BB's React, and hooks from one copy in
 * components of another break in ways that look like unrelated render bugs.
 * `@pierre/diffs/react` would pull one in, so the metafile is the check, not the
 * intent of the entry files.
 */
const reactInputs = [...editorInputs, ...workerInputs].filter((input) =>
  /node_modules\/(react|react-dom|scheduler)\//.test(input),
);
if (reactInputs.length > 0) {
  throw new Error(
    `the Pierre bundle pulled in React: ${reactInputs.slice(0, 5).join(", ")} — ` +
      "pierre-bundle/ must use Pierre's vanilla API, not @pierre/diffs/react",
  );
}

/**
 * Collects the license text of every npm package the bundle actually pulled
 * in, so the built artifact carries its notices. `pierre-bundle/NOTICE.md`
 * holds the summary a reader sees first; this file holds the full texts.
 */
async function collectLicenses(inputs) {
  // The package directory comes from the input path, not from `require.resolve`:
  // a package whose `exports` map omits `./package.json` cannot be resolved that
  // way, and `@pierre/diffs` is one of them. Skipping it would drop the very
  // notice this file exists for.
  const dirs = new Map();
  for (const input of inputs) {
    const marker = input.lastIndexOf("node_modules/");
    if (marker === -1) continue;
    const start = marker + "node_modules/".length;
    const rest = input.slice(start).split("/");
    const name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
    dirs.set(name, path.resolve(pluginRoot, input.slice(0, start) + name));
  }
  const sections = [];
  for (const name of [...dirs.keys()].sort()) {
    const dir = dirs.get(name);
    if (!existsSync(path.join(dir, "package.json"))) continue;
    const manifest = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
    const file = (await readdir(dir)).find((entry) => /^(LICEN[CS]E|COPYING)/i.test(entry));
    const text = file === undefined ? null : await readFile(path.join(dir, file), "utf8");
    sections.push(
      [
        `## ${name} ${manifest.version ?? ""}`.trim(),
        `License: ${typeof manifest.license === "string" ? manifest.license : "see below"}`,
        "",
        text ?? "No license file was published with this package.",
      ].join("\n"),
    );
  }
  return sections;
}

const sections = await collectLicenses([...editorInputs, ...workerInputs, fontInput]);
await writeFile(
  path.join(outDir, "LICENSES.txt"),
  [
    [
      "Third-party licenses for the Pierre editor bundle of bb-plugin-editor.",
      "This file is generated by scripts/stage-assets.mjs from the packages the",
      "bundle actually includes. See pierre-bundle/NOTICE.md for the summary.",
    ].join("\n"),
    ...sections,
  ].join("\n\n"),
);
if (!existsSync(path.join(pluginRoot, "pierre-bundle", "NOTICE.md"))) {
  throw new Error("pierre-bundle/NOTICE.md is missing; the bundle must ship its attribution");
}

let total = 0;
for (const name of emitted) total += (await stat(path.join(outDir, name))).size;
console.log(
  `editor: built ${outDir} (${(total / 1024 / 1024).toFixed(1)} MB total, ` +
    `${grammarChunks} lazy chunks, ${sections.length} bundled packages)`,
);
