import { build } from "esbuild";

// Compile both plugin entry points without installing or reloading a live BB.
// This does not assemble BB's plugin package or establish runtime/audio behavior.
for (const [entry, platform] of [["server.ts", "node"], ["app.tsx", "browser"]]) {
  const result = await build({
    entryPoints: [entry], bundle: true, packages: "external", platform,
    format: "esm", target: "es2022", outdir: ".build-check", write: false,
    jsx: "automatic", logLevel: "warning",
  });
  console.log(`${entry}: compiled ${result.outputFiles.length} output file(s)`);
}
