import type {
  CodeView as CodeViewClass,
  DiffsThemeNames,
  FileContents,
  FileDiffMetadata,
  ThemeRegistration,
} from "@pierre/diffs";
import type { Editor as EditorClass } from "@pierre/diffs/edit";
import type { WorkerPoolManager } from "@pierre/diffs/worker";

/**
 * What `pierre-bundle/editor.js` exports. The bundle is plain JavaScript that
 * re-exports Pierre's vanilla API, so this interface is the only description
 * TypeScript has of it.
 */
export interface PierreBundle {
  CodeView: typeof CodeViewClass;
  diffAcceptRejectHunk: typeof import("@pierre/diffs").diffAcceptRejectHunk;
  Editor: typeof EditorClass;
  parseDiffFromFile: (
    oldFile: FileContents | null,
    newFile: FileContents | null,
  ) => FileDiffMetadata;
  registerCustomTheme: (name: string, loader: () => Promise<ThemeRegistration>) => void;
  getLineEndingType: (content: string) => "CRLF" | "CR" | "LF" | "none";
  getOrCreateWorkerPoolSingleton: (props: {
    poolOptions: { workerFactory: () => Worker; poolSize?: number };
    highlighterOptions: { preferredHighlighter?: "shiki-js" | "shiki-wasm" };
  }) => WorkerPoolManager;
  terminateWorkerPoolSingleton: () => void;
  /** False when another copy of Pierre defined `<diffs-container>` first. */
  ownsContainerElement: boolean;
  version: string;
  loadFont: () => Promise<void>;
}

export interface PierreRuntime extends PierreBundle {
  /** The shared syntax worker pool, or null when workers are unavailable. */
  workerPool: WorkerPoolManager | null;
  /** Why the worker pool is null. Highlighting still works on the main thread. */
  workerError: Error | null;
}

/**
 * Which Shiki engine the highlighter uses. The JavaScript engine needs no
 * WebAssembly, so it starts faster and needs no `wasm-unsafe-eval`; the
 * Oniguruma engine matches VS Code's regex behavior exactly. Grammars that use
 * Oniguruma-only patterns can differ between the two, so this stays a choice.
 */
export type PierreHighlighter = "shiki-js" | "shiki-wasm";

/**
 * Workers tokenize whole files off the main thread. Two is enough for a panel
 * that shows one file at a time and keeps memory far below Pierre's default of
 * eight.
 */
const WORKER_POOL_SIZE = 2;

let bootPromise: Promise<PierreRuntime> | null = null;

/**
 * Loads the Pierre bundle from the plugin's own asset routes. One page loads
 * the bundle once: the module holds a live custom element, a worker pool, and a
 * theme registry, so a second copy would fight the first over all three.
 */
export function loadPierre(
  baseUrl: string,
  options: { highlighter?: PierreHighlighter } = {},
): Promise<PierreRuntime> {
  bootPromise ??= boot(baseUrl, options.highlighter ?? "shiki-js").catch((error: unknown) => {
    // A failed boot must not poison every later attempt: the asset routes may
    // simply not have been registered yet.
    bootPromise = null;
    throw error;
  });
  return bootPromise;
}

async function boot(baseUrl: string, highlighter: PierreHighlighter): Promise<PierreRuntime> {
  const bundle = (await import(/* @vite-ignore */ `${baseUrl}/editor.js`)) as Partial<PierreBundle>;
  const missing = (
    ["CodeView", "Editor", "parseDiffFromFile", "registerCustomTheme"] as const
  ).filter((name) => bundle[name] === undefined);
  if (missing.length > 0) {
    throw new Error(`the Pierre bundle did not export ${missing.join(", ")}`);
  }
  const runtime = bundle as PierreBundle;
  // Resolve metrics before creating a virtualized editor. If the optional font
  // cannot load, BB's monospace stack remains a usable fallback.
  await runtime.loadFont().catch((error: unknown) => {
    console.warn("[erwin-editor] Geist Mono could not load; using BB's monospace font", error);
  });
  if (!runtime.ownsContainerElement) {
    // BB's app registers `<diffs-container>` from its own Pierre copy. The tag
    // can only be defined once, so our elements then carry that copy's
    // stylesheet. Rendering continues; the styling is what to check.
    console.warn(
      "[erwin-editor] another copy of Pierre already defined <diffs-container>; " +
        `this surface renders with that copy's styles, not ${runtime.version}`,
    );
  }
  let workerPool: WorkerPoolManager | null = null;
  let workerError: Error | null = null;
  try {
    workerPool = runtime.getOrCreateWorkerPoolSingleton({
      poolOptions: {
        workerFactory: () =>
          new Worker(new URL(`${baseUrl}/worker.js`, window.location.origin), {
            type: "module",
            name: "erwin-editor-syntax",
          }),
        poolSize: WORKER_POOL_SIZE,
      },
      highlighterOptions: { preferredHighlighter: highlighter },
    });
  } catch (error: unknown) {
    // Highlighting falls back to the main thread, so this is a slow surface,
    // not a broken one. The caller decides whether to show it.
    workerError = error instanceof Error ? error : new Error(String(error));
    console.warn("[erwin-editor] the syntax worker pool did not start", error);
  }
  return { ...runtime, workerPool, workerError };
}

/** A Pierre theme name, which is also the key its resolved theme is cached under. */
export type PierreThemeName = DiffsThemeNames;
