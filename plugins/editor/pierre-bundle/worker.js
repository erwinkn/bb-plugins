/**
 * Pierre's syntax worker, as its own entry.
 *
 * The worker tokenizes files and diffs off the main thread. It never resolves
 * grammars itself: `resolveLanguage` throws in a worker context, so the main
 * thread resolves a grammar and passes it in. The worker therefore stays small
 * and needs no grammar chunks of its own.
 *
 * The build emits this with code splitting, so `import("shiki/wasm")` stays a
 * lazy chunk that only the Oniguruma engine pulls in. That needs a module
 * worker (`new Worker(url, { type: "module" })`).
 *
 * The import re-exports its namespace instead of standing alone. `@pierre/diffs`
 * leaves its worker out of the package `sideEffects` list, so a bare import of
 * it is dropped as unused and the built worker answers no message at all.
 */
import * as pierreWorker from "@pierre/diffs/worker/worker.js";

export { pierreWorker };
