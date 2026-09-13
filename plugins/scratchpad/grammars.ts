/**
 * The languages scratchpad code blocks can highlight, as the names a fence or
 * BlockNote's `language` prop may carry. Each key is a Shiki grammar id or
 * one of that grammar's own aliases, so once the grammar is loaded Shiki
 * reports the key itself as loaded; BlockNote checks exactly that before it
 * highlights, and a key Shiki did not report back would be fetched again on
 * every refresh. `grammars.test.ts` proves the property for every key.
 *
 * Grammars are not bundled with the app. The server serves them as JSON from
 * `@shikijs/langs` (grammar-sources.ts) and the app fetches one the first
 * time a code block in that language appears (highlighter.ts).
 */
export const GRAMMARS: Readonly<Record<string, string>> = {
  typescript: "typescript", ts: "typescript",
  tsx: "tsx",
  javascript: "javascript", js: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "jsonc",
  yaml: "yaml", yml: "yaml",
  toml: "toml",
  shellscript: "shellscript", bash: "shellscript", sh: "shellscript", shell: "shellscript", zsh: "shellscript",
  python: "python", py: "python",
  rust: "rust", rs: "rust",
  go: "go",
  css: "css",
  scss: "scss",
  html: "html",
  markdown: "markdown", md: "markdown",
  sql: "sql",
  diff: "diff",
  dockerfile: "dockerfile", docker: "dockerfile",
};

/** Grammar ids the server serves, one file each. */
export const GRAMMAR_IDS: readonly string[] = [...new Set(Object.values(GRAMMARS))];

/**
 * Versions the grammar URLs: browsers may cache them for a year, so a change
 * of `@shikijs/langs` must change the path. `grammars.test.ts` checks it
 * against the installed package.
 */
export const GRAMMAR_REVISION = "shiki-langs-4.4.3";

/** Route path (under the plugin's `bb.http` namespace) for a grammar file. */
export function grammarRoute(id: string): string {
  return `/grammars/${GRAMMAR_REVISION}/${id}.json`;
}
