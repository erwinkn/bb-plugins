/**
 * The lazily loaded editor bundle: Monaco plus the Shiki pieces the plugin
 * uses to tokenize with the same TextMate grammars and VS Code theme document
 * that BB's own code renderer uses.
 *
 * `monaco-editor`'s root entry is Monaco's full standalone editor: the API,
 * every editor contribution (find, folding, multi-cursor, sticky scroll, …),
 * the Monarch grammars, and the CSS/HTML/JSON/TypeScript language features.
 * The language features talk to dedicated workers that `worker.*.js` build.
 *
 * `lib/monaco-loader.ts` imports this file from a `files.createPreview` URL
 * the first time an editor opens; `scripts/stage-assets.mjs` builds it with
 * code splitting so each grammar below is a separate chunk that loads only
 * when a file of that language opens.
 */
import { editor, languages } from "monaco-editor";
import {
  getTypeScriptWorker,
  typescriptDefaults,
} from "monaco-editor/languages/features/typescript/register.js";
import {
  CodeActionAdaptor,
  DefinitionAdapter,
  DiagnosticsAdapter,
  DocumentHighlightAdapter,
  FormatAdapter,
  FormatOnTypeAdapter,
  InlayHintsAdapter,
  LibFiles,
  OutlineAdapter,
  QuickInfoAdapter,
  ReferenceAdapter,
  RenameAdapter,
  SignatureHelpAdapter,
  SuggestAdapter,
} from "monaco-editor/languages/features/typescript/languageFeatures.js";

export * as monaco from "monaco-editor";
export { createHighlighterCore } from "shiki/core";
export { createOnigurumaEngine } from "shiki/engine/oniguruma";
export { EncodedTokenMetadata, FontStyle, INITIAL } from "shiki/textmate";

export function loadOnigurumaWasm() {
  return import("shiki/wasm");
}

/**
 * Serve another Monaco language id (the plugin's `typescriptreact`, so `.tsx`
 * files tokenize with the TSX grammar) from Monaco's single TypeScript worker.
 * Monaco's own setup only wires `typescript` and `javascript`; this repeats
 * its provider registrations for `languageId`, sharing the worker so
 * cross-file features and memory stay single.
 */
export async function attachTypeScriptFeatures(languageId) {
  // Requesting the `typescript` language makes Monaco start its TypeScript
  // mode; the worker accessor resolves once that asynchronous setup is done.
  editor.createModel("", "typescript").dispose();
  const worker = await retry(() => getTypeScriptWorker(), 100, 50);
  const libFiles = new LibFiles(worker);
  languages.registerCompletionItemProvider(languageId, new SuggestAdapter(worker));
  languages.registerSignatureHelpProvider(languageId, new SignatureHelpAdapter(worker));
  languages.registerHoverProvider(languageId, new QuickInfoAdapter(worker));
  languages.registerDocumentHighlightProvider(languageId, new DocumentHighlightAdapter(worker));
  languages.registerDefinitionProvider(languageId, new DefinitionAdapter(libFiles, worker));
  languages.registerReferenceProvider(languageId, new ReferenceAdapter(libFiles, worker));
  languages.registerDocumentSymbolProvider(languageId, new OutlineAdapter(worker));
  languages.registerRenameProvider(languageId, new RenameAdapter(libFiles, worker));
  languages.registerDocumentRangeFormattingEditProvider(languageId, new FormatAdapter(worker));
  languages.registerOnTypeFormattingEditProvider(languageId, new FormatOnTypeAdapter(worker));
  languages.registerCodeActionProvider(languageId, new CodeActionAdaptor(worker));
  languages.registerInlayHintsProvider(languageId, new InlayHintsAdapter(worker));
  new DiagnosticsAdapter(libFiles, typescriptDefaults, languageId, worker);
}

async function retry(attempt, times, delayMs) {
  let lastError;
  for (let i = 0; i < times; i++) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

/**
 * Shiki grammar loaders keyed by Shiki language id. Embedded languages
 * (markdown code fences, `<script>` in HTML, Vue/Svelte/Astro blocks) are
 * resolved by Shiki at load time through the same map, so the keys here must
 * include every grammar another one embeds.
 */
export const grammars = {
  astro: () => import("@shikijs/langs/astro"),
  bat: () => import("@shikijs/langs/bat"),
  c: () => import("@shikijs/langs/c"),
  clojure: () => import("@shikijs/langs/clojure"),
  cmake: () => import("@shikijs/langs/cmake"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  css: () => import("@shikijs/langs/css"),
  csv: () => import("@shikijs/langs/csv"),
  dart: () => import("@shikijs/langs/dart"),
  diff: () => import("@shikijs/langs/diff"),
  docker: () => import("@shikijs/langs/docker"),
  dotenv: () => import("@shikijs/langs/dotenv"),
  elixir: () => import("@shikijs/langs/elixir"),
  elm: () => import("@shikijs/langs/elm"),
  erlang: () => import("@shikijs/langs/erlang"),
  fish: () => import("@shikijs/langs/fish"),
  fsharp: () => import("@shikijs/langs/fsharp"),
  "git-commit": () => import("@shikijs/langs/git-commit"),
  "git-rebase": () => import("@shikijs/langs/git-rebase"),
  gleam: () => import("@shikijs/langs/gleam"),
  glsl: () => import("@shikijs/langs/glsl"),
  go: () => import("@shikijs/langs/go"),
  graphql: () => import("@shikijs/langs/graphql"),
  groovy: () => import("@shikijs/langs/groovy"),
  haskell: () => import("@shikijs/langs/haskell"),
  hcl: () => import("@shikijs/langs/hcl"),
  html: () => import("@shikijs/langs/html"),
  ini: () => import("@shikijs/langs/ini"),
  java: () => import("@shikijs/langs/java"),
  javascript: () => import("@shikijs/langs/javascript"),
  json: () => import("@shikijs/langs/json"),
  julia: () => import("@shikijs/langs/julia"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  latex: () => import("@shikijs/langs/latex"),
  less: () => import("@shikijs/langs/less"),
  log: () => import("@shikijs/langs/log"),
  lua: () => import("@shikijs/langs/lua"),
  make: () => import("@shikijs/langs/make"),
  markdown: () => import("@shikijs/langs/markdown"),
  mdx: () => import("@shikijs/langs/mdx"),
  nginx: () => import("@shikijs/langs/nginx"),
  nix: () => import("@shikijs/langs/nix"),
  "objective-c": () => import("@shikijs/langs/objective-c"),
  ocaml: () => import("@shikijs/langs/ocaml"),
  perl: () => import("@shikijs/langs/perl"),
  php: () => import("@shikijs/langs/php"),
  powershell: () => import("@shikijs/langs/powershell"),
  prisma: () => import("@shikijs/langs/prisma"),
  proto: () => import("@shikijs/langs/proto"),
  python: () => import("@shikijs/langs/python"),
  r: () => import("@shikijs/langs/r"),
  rst: () => import("@shikijs/langs/rst"),
  ruby: () => import("@shikijs/langs/ruby"),
  rust: () => import("@shikijs/langs/rust"),
  scala: () => import("@shikijs/langs/scala"),
  scss: () => import("@shikijs/langs/scss"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  sql: () => import("@shikijs/langs/sql"),
  "ssh-config": () => import("@shikijs/langs/ssh-config"),
  svelte: () => import("@shikijs/langs/svelte"),
  swift: () => import("@shikijs/langs/swift"),
  toml: () => import("@shikijs/langs/toml"),
  tsx: () => import("@shikijs/langs/tsx"),
  typescript: () => import("@shikijs/langs/typescript"),
  vue: () => import("@shikijs/langs/vue"),
  wasm: () => import("@shikijs/langs/wasm"),
  wgsl: () => import("@shikijs/langs/wgsl"),
  xml: () => import("@shikijs/langs/xml"),
  yaml: () => import("@shikijs/langs/yaml"),
  zig: () => import("@shikijs/langs/zig"),
};
