/**
 * The Shiki highlighter behind scratchpad code blocks. app.tsx imports this
 * module lazily, so Shiki's core and its JavaScript regex engine are set up
 * only once a code block is on screen. Grammars are fetched one by one from
 * the plugin server (grammars.ts); the theme is BB's active code theme,
 * converted by code-theme.ts.
 *
 * One highlighter serves every editor on the page. BlockNote also keeps one
 * highlighter promise per page (`Symbol.for("blocknote.shikiHighlighterPromise")`)
 * and one parser that reads the theme as `getLoadedThemes()[0]` at each call,
 * so the wrapper returned by {@link createHighlighter} reports the current
 * theme first and a theme change needs no new highlighter. Decorations that
 * are already on screen keep their colours until the editor is re-created;
 * app.tsx does that when the theme changes.
 */
import { createBundledHighlighter } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import type { HighlighterGeneric, LanguageRegistration } from "@shikijs/types";
import type { PluginCodeThemeData } from "@get-bb/plugin-sdk/app";
import { codeThemeName, toShikiTheme } from "./code-theme";
import { GRAMMARS } from "./grammars";

type Highlighter = HighlighterGeneric<string, string>;

let grammarBase: (() => Promise<string>) | null = null;
let core: Promise<Highlighter> | null = null;
const loadedThemes = new Set<string>();
let requestedTheme: string | null = null;
let currentTheme: string | null = null;
let releaseFirstTheme: (() => void) | null = null;
const firstTheme = new Promise<void>((resolve) => {
  releaseFirstTheme = resolve;
});

/** Where grammar files live; asked once, the first time a grammar is needed. */
export function configureGrammars(base: () => Promise<string>): void {
  grammarBase ??= base;
}

async function fetchGrammar(id: string): Promise<{ default: LanguageRegistration[] }> {
  if (grammarBase === null) throw new Error("Scratchpad grammars are not configured.");
  const base = await grammarBase();
  const response = await fetch(`${base}/${id}.json`, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`Grammar ${id}: HTTP ${response.status}`);
  return { default: (await response.json()) as LanguageRegistration[] };
}

const createCore = createBundledHighlighter<string, string>({
  langs: Object.fromEntries(Object.entries(GRAMMARS).map(([key, id]) => [key, () => fetchGrammar(id)])),
  themes: {},
  // Patterns the translator cannot express become no-ops instead of failing
  // the whole grammar.
  engine: () => createJavaScriptRegexEngine({ forgiving: true }),
});

/**
 * Makes `theme` the one new highlights use, loading it into the highlighter
 * first. Returns its registered name. Calls may overlap when BB's theme
 * changes quickly; the most recent call wins.
 */
export async function applyCodeTheme(theme: PluginCodeThemeData): Promise<string> {
  const name = codeThemeName(theme);
  requestedTheme = name;
  if (!loadedThemes.has(name)) {
    const registration = toShikiTheme(name, theme);
    if (core === null) {
      core = createCore({ themes: [registration], langs: [] });
      await core;
    } else {
      await (await core).loadTheme(registration);
    }
    loadedThemes.add(name);
  }
  if (requestedTheme === name) {
    currentTheme = name;
    releaseFirstTheme?.();
  }
  return name;
}

/** The current theme's name, or null before the first theme is applied. */
export function currentCodeTheme(): string | null {
  return currentTheme;
}

/**
 * The highlighter as BlockNote expects it: the current theme comes first in
 * `getLoadedThemes()`, and `loadLanguage` always returns a promise. Shiki
 * throws synchronously for a name outside the bundle; BlockNote only attaches
 * `.catch`, so a synchronous throw would escape into prosemirror-highlight's
 * parse loop, drop every block's colours in that pass and repeat on each
 * change, instead of marking the language as one to skip.
 */
export function wrapForBlockNote(highlighter: Highlighter, current: () => string | null): Highlighter {
  return {
    ...highlighter,
    getLoadedThemes: () => {
      const name = current();
      const rest = highlighter.getLoadedThemes().filter((loaded) => loaded !== name);
      return name === null ? rest : [name, ...rest];
    },
    loadLanguage: async (...langs) => highlighter.loadLanguage(...langs),
  };
}

/**
 * The highlighter BlockNote's syntax-highlighting extension asks for. It
 * resolves once BB's theme has been applied, so the first highlight already
 * has colours.
 */
export async function createHighlighter(): Promise<Highlighter> {
  await firstTheme;
  return wrapForBlockNote(await core!, () => currentTheme);
}
