/**
 * File-type icons from `@pierre/trees`, the set BB's own file trees draw
 * with, so a TypeScript file looks the same in this plugin as in BB's
 * thread storage tree. The package ships the icons as an SVG sprite and a
 * resolver from file name to icon token; the colours below are its
 * `complete` set's palette, copied here because the package only exposes
 * them as CSS inside its shadow DOM.
 */
import { createFileTreeIconResolver, getBuiltInSpriteSheet } from "@pierre/trees";

export interface FileGlyph {
  /** The token the resolver chose, for example `typescript`. */
  token: string;
  viewBox: string;
  /** The symbol's inner SVG markup; paths use `currentColor`. */
  body: string;
  /** A `light-dark()` colour, or null for a token the set leaves muted. */
  color: string | null;
}

// @pierre/trees 1.0.0-beta.6, `--trees-icon-*` in dist/style.js.
const PALETTE = {
  gray: "light-dark(#84848a, #adadb1)",
  red: "light-dark(#d52c36, #ff6762)",
  vermilion: "light-dark(#ff8c5b, #d5512f)",
  orange: "light-dark(#d47628, #ffa359)",
  yellow: "light-dark(#d5a910, #ffd452)",
  green: "light-dark(#199f43, #5ecc71)",
  teal: "light-dark(#17a5af, #64d1db)",
  cyan: "light-dark(#1ca1c7, #68cdf2)",
  blue: "light-dark(#1a85d4, #69b1ff)",
  indigo: "light-dark(#693acf, #9d6afb)",
  purple: "light-dark(#a631be, #d568ea)",
  pink: "light-dark(#d32a61, #ff678d)",
  mauve: "light-dark(#594c5b, #79697b)",
} as const;

// `--trees-file-icon-color-<token>` in the same file. Tokens absent here
// (font, nextjs, stylelint) stay in the muted foreground, as in the package.
export const TOKEN_COLORS: Readonly<Record<string, keyof typeof PALETTE>> = {
  default: "gray", astro: "purple", babel: "yellow", bash: "green", biome: "blue", bootstrap: "indigo",
  browserslist: "yellow", bun: "mauve", c: "blue", cpp: "blue", claude: "orange", css: "indigo",
  database: "purple", docker: "blue", eslint: "indigo", git: "vermilion", go: "cyan", graphql: "pink",
  html: "orange", image: "pink", javascript: "yellow", json: "orange", markdown: "green", mcp: "teal",
  npm: "red", oxc: "cyan", postcss: "red", prettier: "teal", python: "blue", react: "cyan", ruby: "red",
  rust: "orange", sass: "pink", svg: "orange", svelte: "red", svgo: "green", swift: "orange", table: "teal",
  text: "gray", tailwind: "cyan", terraform: "indigo", typescript: "blue", vite: "purple", vscode: "blue",
  vue: "green", wasm: "indigo", webpack: "blue", yml: "red", zig: "orange", zip: "orange",
};

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
  const palette = TOKEN_COLORS[token];
  return { token, viewBox: symbol.viewBox, body: symbol.body, color: palette === undefined ? null : PALETTE[palette] };
}
