import type * as MonacoNs from "monaco-editor";
import type { createHighlighterCore } from "shiki/core";
import type { createOnigurumaEngine } from "shiki/engine/oniguruma";
import type { EncodedTokenMetadata, FontStyle, INITIAL } from "shiki/textmate";
import type { LanguageRegistration, WebAssemblyInstantiator } from "shiki/core";
import { EXTRA_LANGUAGES } from "./languages.js";
import { ShikiTokenization } from "./shiki-monaco.js";

/** What `monaco-bundle/editor.js` exports (the bundle is plain JavaScript). */
export interface EditorBundle {
  monaco: typeof MonacoNs;
  createHighlighterCore: typeof createHighlighterCore;
  createOnigurumaEngine: typeof createOnigurumaEngine;
  loadOnigurumaWasm: () => Promise<{ default: WebAssemblyInstantiator }>;
  EncodedTokenMetadata: typeof EncodedTokenMetadata;
  FontStyle: typeof FontStyle;
  INITIAL: typeof INITIAL;
  grammars: Record<string, (() => Promise<{ default: LanguageRegistration[] }>) | undefined>;
  attachTypeScriptFeatures: (languageId: string) => Promise<void>;
}

export interface EditorRuntime {
  monaco: typeof MonacoNs;
  shiki: ShikiTokenization;
}

export type TypeScriptDiagnostics = "off" | "syntax" | "semantic";

let bootPromise: Promise<EditorRuntime> | null = null;

export function loadEditor(baseUrl: string): Promise<EditorRuntime> {
  bootPromise ??= boot(baseUrl).catch((error: unknown) => {
    bootPromise = null;
    throw error;
  });
  return bootPromise;
}

async function boot(baseUrl: string): Promise<EditorRuntime> {
  await injectStylesheet(`${baseUrl}/editor.css`);
  (globalThis as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
    getWorker: (_: string, label: string) =>
      new Worker(new URL(`${baseUrl}/worker.${workerFor(label)}.js`, window.location.origin), {
        type: "module",
        name: label,
      }),
  };
  const bundle = (await import(/* @vite-ignore */ `${baseUrl}/editor.js`)) as Partial<EditorBundle>;
  if (!bundle.monaco || !bundle.createHighlighterCore || !bundle.grammars || !bundle.attachTypeScriptFeatures) {
    throw new Error("the editor bundle did not expose its API");
  }
  const runtime = bundle as EditorBundle;
  const { monaco } = runtime;
  registerExtraLanguages(monaco);
  configureLanguageServices(monaco);
  const shiki = await ShikiTokenization.create(runtime, monaco);
  // Non-blocking: `.tsx` files get their language features once the
  // TypeScript worker exists; tokens do not wait for it.
  void runtime.attachTypeScriptFeatures("typescriptreact").catch((error: unknown) => {
    console.warn("[erwin-editor] TypeScript features for .tsx did not attach", error);
  });
  return { monaco, shiki };
}

function workerFor(label: string): "editor" | "typescript" | "json" | "css" | "html" {
  switch (label) {
    case "typescript":
    case "javascript":
      return "typescript";
    case "json":
      return "json";
    case "css":
    case "scss":
    case "less":
      return "css";
    case "html":
    case "handlebars":
    case "razor":
      return "html";
    default:
      return "editor";
  }
}

function registerExtraLanguages(monaco: typeof MonacoNs): void {
  const known = new Set(monaco.languages.getLanguages().map((language) => language.id));
  for (const language of EXTRA_LANGUAGES) {
    if (known.has(language.id)) continue;
    monaco.languages.register({
      id: language.id,
      extensions: language.extensions.map((extension) => `.${extension}`),
      filenames: [...(language.filenames ?? [])],
    });
    monaco.languages.setLanguageConfiguration(language.id, {
      comments: commentsFor(language.id),
      brackets: [
        ["{", "}"],
        ["[", "]"],
        ["(", ")"],
      ],
      autoClosingPairs: [
        { open: "{", close: "}" },
        { open: "[", close: "]" },
        { open: "(", close: ")" },
        { open: '"', close: '"', notIn: ["string"] },
        { open: "'", close: "'", notIn: ["string", "comment"] },
        { open: "`", close: "`", notIn: ["string", "comment"] },
      ],
      surroundingPairs: [
        { open: "{", close: "}" },
        { open: "[", close: "]" },
        { open: "(", close: ")" },
        { open: '"', close: '"' },
        { open: "'", close: "'" },
        { open: "`", close: "`" },
      ],
      folding: { markers: { start: /^\s*\/\/\s*#?region\b/, end: /^\s*\/\/\s*#?endregion\b/ } },
    });
  }
  // `.tsx` shares TypeScript's editing rules (auto-closing, on-enter, comments).
  const typescript = monaco.languages.getLanguages().find((language) => language.id === "typescript") as
    | (MonacoNs.languages.ILanguageExtensionPoint & {
        loader?: () => Promise<{ conf: MonacoNs.languages.LanguageConfiguration }>;
      })
    | undefined;
  if (typescript?.loader) {
    void typescript.loader().then((module) => {
      monaco.languages.setLanguageConfiguration("typescriptreact", module.conf);
    });
  }
}

function commentsFor(languageId: string): MonacoNs.languages.CommentRule {
  switch (languageId) {
    case "typescriptreact":
    case "zig":
    case "prisma":
    case "glsl":
    case "groovy":
    case "svelte":
    case "vue":
    case "astro":
      return { lineComment: "//", blockComment: ["/*", "*/"] };
    case "haskell":
    case "elm":
    case "gleam":
      return { lineComment: "--", blockComment: ["{-", "-}"] };
    case "ocaml":
      return { blockComment: ["(*", "*)"] };
    case "erlang":
      return { lineComment: "%" };
    case "latex":
      return { lineComment: "%" };
    case "wasm":
      return { lineComment: ";;", blockComment: ["(;", ";)"] };
    case "diff":
    case "log":
    case "csv":
    case "git-commit":
    case "git-rebase":
      return {};
    default:
      return { lineComment: "#" };
  }
}

function configureLanguageServices(monaco: typeof MonacoNs): void {
  const ts = monaco.typescript;
  const compilerOptions: MonacoNs.typescript.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    jsx: ts.JsxEmit.ReactJSX,
    allowJs: true,
    checkJs: false,
    allowNonTsExtensions: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    resolveJsonModule: true,
    skipLibCheck: true,
    noEmit: true,
    strict: true,
    lib: ["esnext", "dom", "dom.iterable"],
  };
  ts.typescriptDefaults.setCompilerOptions(compilerOptions);
  ts.javascriptDefaults.setCompilerOptions(compilerOptions);
  ts.typescriptDefaults.setEagerModelSync(true);
  ts.javascriptDefaults.setEagerModelSync(true);
  setTypeScriptDiagnostics(monaco, "syntax");
  monaco.json.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    allowComments: true,
    comments: "ignore",
    trailingCommas: "warning",
    schemaValidation: "warning",
    enableSchemaRequest: false,
  });
}

/**
 * The worker sees only the open file, so unresolved imports are expected;
 * "syntax" (the default) reports parse errors only. "semantic" adds type
 * errors but ignores the module-resolution codes that are always wrong here.
 */
export function setTypeScriptDiagnostics(monaco: typeof MonacoNs, level: TypeScriptDiagnostics): void {
  const options: MonacoNs.typescript.DiagnosticsOptions = {
    noSyntaxValidation: level === "off",
    noSemanticValidation: level !== "semantic",
    noSuggestionDiagnostics: level !== "semantic",
    diagnosticCodesToIgnore: [2307, 2792, 7016, 2305, 2306, 2614, 2304, 1259],
  };
  monaco.typescript.typescriptDefaults.setDiagnosticsOptions(options);
  monaco.typescript.javascriptDefaults.setDiagnosticsOptions({ ...options, noSemanticValidation: true });
}

function injectStylesheet(href: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`link[href="${href}"]`) !== null) {
      resolve();
      return;
    }
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.onload = () => resolve();
    link.onerror = () => reject(new Error(`Failed to load ${href}`));
    document.head.appendChild(link);
  });
}

const OVERFLOW_NODE_ID = "bb-plugin-erwin-editor-overflow-widgets";

/**
 * Monaco's suggest, hover, and find widgets render into this fixed body-level
 * node so panel `overflow: hidden` cannot clip them.
 */
export function overflowWidgetsNode(): HTMLElement {
  const existing = document.getElementById(OVERFLOW_NODE_ID);
  if (existing !== null) return existing;
  const node = document.createElement("div");
  node.id = OVERFLOW_NODE_ID;
  node.className = "monaco-editor";
  node.style.position = "absolute";
  node.style.top = "0";
  node.style.left = "0";
  node.style.zIndex = "40";
  document.body.appendChild(node);
  return node;
}

export function setOverflowWidgetsTheme(base: "vs" | "vs-dark"): void {
  const node = document.getElementById(OVERFLOW_NODE_ID);
  if (node !== null) node.className = `monaco-editor ${base}`;
}
