/**
 * File-type icons from `@pierre/trees`, the set BB's own file trees draw
 * with, so a TypeScript file has the same shape in this plugin as in BB's
 * thread storage tree. The package ships the icons as an SVG sprite and a
 * resolver from file name to icon token.
 *
 * Colour does not come from the package. Each token maps to one of the BB
 * Color roles (`plugins/theme`, `--bbp-*`) so the tree reads with the same
 * hues as the timeline: source files blue, systems and scripting languages
 * amber-orange, stylesheets purple, data and config amber, shell and tooling
 * teal, images cyan, prose muted. Every colour is written as
 * `var(--bbp-<role>, var(<BB token>))`: the role hue when a BB Color palette
 * is selected, otherwise a BB token whose light and dark values both clear
 * 3:1 on the canvas.
 */
import { createFileTreeIconResolver, getBuiltInSpriteSheet } from "@pierre/trees";

export interface FileGlyph {
  /** The token the resolver chose, for example `typescript`. */
  token: string;
  /** The BB Color role the token is drawn in; `subtle` inherits the text tier. */
  role: IconRole;
  viewBox: string;
  /** The symbol's inner SVG markup; paths use `currentColor`. */
  body: string;
  /** A CSS colour expression, or null for a token drawn in the muted text colour. */
  color: string | null;
}

/** The roles of `plugins/theme/themes/color.css`, plus `subtle` for no tint. */
export type IconRole = "file" | "command" | "web" | "edit" | "attention" | "done" | "error" | "agent" | "subtle";

/**
 * Role colours with their fallbacks. The fallback is a BB token that is
 * legible as a glyph (≥ 3:1) in both modes: `--timeline-accent` (oklch 55% /
 * 72%), `--warning-text` (55% / 75%), `--success-foreground` (a mix toward
 * the ink), `--destructive-text` (45% / 65%), `--pr-merged` (53% / 68%). BB's
 * plain `--attention` and `--success` are too light on white for a glyph, so
 * the amber roles share `--warning-text` and green uses the foreground mix.
 */
export const ROLE_COLORS: Readonly<Record<Exclude<IconRole, "subtle">, string>> = {
  file: "var(--bbp-file, var(--timeline-accent))",
  command: "var(--bbp-command, var(--timeline-accent))",
  web: "var(--bbp-web, var(--timeline-accent))",
  edit: "var(--bbp-edit, var(--warning-text))",
  attention: "var(--bbp-attention, var(--warning-text))",
  done: "var(--bbp-done, var(--success-foreground))",
  error: "var(--bbp-error, var(--destructive-text))",
  agent: "var(--bbp-agent, var(--pr-merged))",
};

/**
 * Every token of the `complete` set (`file-tree-builtin-*` symbols in the
 * sprite) and its role. `file-icons.test.ts` fails when the installed sprite
 * gains a token this table lacks.
 */
export const TOKEN_ROLES: Readonly<Record<string, IconRole>> = {
  // Source in the web stack: blue, the file role.
  typescript: "file", javascript: "file", react: "file", vue: "file", svelte: "file", astro: "file",
  c: "file", cpp: "file", wasm: "file", vscode: "file",
  // Systems and scripting languages, and markup: amber-orange, the edit role.
  rust: "edit", python: "edit", go: "edit", ruby: "edit", swift: "edit", zig: "edit", html: "edit",
  // Stylesheets: purple.
  css: "agent", sass: "agent", postcss: "agent", tailwind: "agent", bootstrap: "agent",
  // Claude project files: purple, the agent role.
  claude: "agent",
  // Data and configuration: amber, the attention role.
  json: "attention", yml: "attention", graphql: "attention", database: "attention", table: "attention", terraform: "attention",
  // Shell, containers, package managers, build and lint tooling: teal, the command role.
  bash: "command", docker: "command", npm: "command", bun: "command", git: "command", mcp: "command",
  webpack: "command", vite: "command", nextjs: "command", babel: "command", browserslist: "command",
  eslint: "command", prettier: "command", biome: "command", oxc: "command", svgo: "command", stylelint: "command",
  // Images: cyan, the web role.
  image: "web", svg: "web",
  // Prose, plain text, archives, fonts and the generic document: no tint.
  markdown: "subtle", text: "subtle", zip: "subtle", font: "subtle", default: "subtle",
};

/** The colour expression for a role, or null for `subtle`. */
export function roleColor(role: IconRole): string | null {
  return role === "subtle" ? null : ROLE_COLORS[role];
}

const SYMBOL = /<symbol id="([^"]+)" viewBox="([^"]+)">([\s\S]*?)<\/symbol>/g;

let symbols: Map<string, { viewBox: string; body: string }> | null = null;

/** The sprite's symbols by id, parsed once on first use. */
export function spriteSymbols(): ReadonlyMap<string, { viewBox: string; body: string }> {
  if (symbols === null) {
    symbols = new Map();
    for (const match of getBuiltInSpriteSheet("complete").matchAll(SYMBOL)) {
      symbols.set(match[1]!, { viewBox: match[2]!, body: match[3]!.trim() });
    }
  }
  return symbols;
}

const resolver = createFileTreeIconResolver({
  set: "complete",
  colored: true,
  // Names the set has no rule for, sent to the icon that fits them. The set
  // ships an npm icon but no rule reaches it.
  byFileName: {
    "package.json": "file-tree-builtin-npm",
    "package-lock.json": "file-tree-builtin-npm",
    "npm-shrinkwrap.json": "file-tree-builtin-npm",
    ".npmrc": "file-tree-builtin-npm",
  },
  byFileExtension: { ndjson: "file-tree-builtin-json", toml: "file-tree-builtin-yml" },
});

/** The icon for a file path, or null when the set has none for it. */
export function fileGlyph(path: string): FileGlyph | null {
  const icon = resolver.resolveIcon("file-tree-icon-file", path);
  const symbol = spriteSymbols().get(icon.name);
  if (symbol === undefined) return null;
  const token = icon.token ?? icon.name.replace(/^file-tree-builtin-/, "");
  const role = TOKEN_ROLES[token] ?? "subtle";
  return { token, role, viewBox: symbol.viewBox, body: symbol.body, color: roleColor(role) };
}
