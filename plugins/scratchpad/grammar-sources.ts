/**
 * Server-side loaders for the grammars in grammars.ts. `@shikijs/langs` ships
 * each grammar as a module whose default export is a JSON-serialisable
 * `LanguageRegistration[]`; the imports are dynamic so the server reads a
 * grammar only when a browser first asks for it. This module must stay out
 * of the app bundle: the app build inlines dynamic imports, which would put
 * every grammar into app.js.
 */
import type { LanguageRegistration } from "@shikijs/types";

type GrammarModule = { default: LanguageRegistration[] };

export const GRAMMAR_SOURCES: Readonly<Record<string, () => Promise<GrammarModule>>> = {
  typescript: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
  javascript: () => import("@shikijs/langs/javascript"),
  jsx: () => import("@shikijs/langs/jsx"),
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  yaml: () => import("@shikijs/langs/yaml"),
  toml: () => import("@shikijs/langs/toml"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  python: () => import("@shikijs/langs/python"),
  rust: () => import("@shikijs/langs/rust"),
  go: () => import("@shikijs/langs/go"),
  css: () => import("@shikijs/langs/css"),
  scss: () => import("@shikijs/langs/scss"),
  html: () => import("@shikijs/langs/html"),
  markdown: () => import("@shikijs/langs/markdown"),
  sql: () => import("@shikijs/langs/sql"),
  diff: () => import("@shikijs/langs/diff"),
  dockerfile: () => import("@shikijs/langs/dockerfile"),
};
