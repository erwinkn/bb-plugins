import { experimental_useCodeTheme, type PluginCodeThemeData } from "@get-bb/plugin-sdk/app";
import type { ThemeRegistration } from "@pierre/diffs";
import type { PierreRuntime } from "./pierre-loader.js";

/**
 * A theme ready for a Pierre surface: the name Pierre resolves it under, and
 * the document to register when that name is this plugin's own.
 *
 * Both panels take this from {@link usePierreTheme}, so the file editor and the
 * diff always paint with the same colors.
 */
export interface PierreThemeInput {
  /**
   * The Pierre theme name. It carries a content revision, because Pierre
   * resolves a theme name once and caches it forever; a changed document under
   * an unchanged name would keep the old colors.
   */
  id: string;
  type: "dark" | "light";
  /** null while BB's theme document is still resolving. */
  data: PluginCodeThemeData | null;
  /** A Shiki theme Pierre bundles, used until `data` arrives. */
  fallback: string;
}

/**
 * BB's current code theme, in the form a Pierre surface takes.
 *
 * `experimental_useCodeTheme` keeps the previous document while a new one
 * resolves, so this never returns an unthemed frame.
 */
export function usePierreTheme(): PierreThemeInput {
  const state = experimental_useCodeTheme();
  const fallback = state.mode === "dark" ? "pierre-dark" : "pierre-light";
  if (state.theme === null) return { id: fallback, type: state.mode, data: null, fallback };
  return { id: pierreThemeName(state.theme), type: state.theme.type, data: state.theme, fallback };
}

/**
 * The name a BB theme document is registered under.
 *
 * Pierre caches a resolved theme by name and rejects a second registration of
 * the same name, so the name has to change whenever the colors change. The
 * revision is a hash of the values that reach the screen.
 */
export function pierreThemeName(theme: PluginCodeThemeData): string {
  return `bb-${theme.type}-${theme.name.replace(/[^a-zA-Z0-9_-]/g, "-")}-${themeRevision(theme)}`;
}

/**
 * Converts BB's theme document into the Shiki registration Pierre resolves.
 *
 * Pierre checks that a resolved theme's `name` equals the name it asked for, so
 * the registration carries the name it is registered under, not BB's.
 */
export function toPierreTheme(name: string, theme: PluginCodeThemeData): ThemeRegistration {
  const settings = theme.tokenColors.map((rule) => {
    const scope = rule.scope === undefined ? undefined : Array.isArray(rule.scope) ? [...rule.scope] : [rule.scope];
    return scope === undefined ? { settings: { ...rule.settings } } : { scope, settings: { ...rule.settings } };
  });
  return {
    name,
    type: theme.type,
    fg: theme.fg,
    bg: theme.bg,
    colors: { ...theme.colors },
    settings,
  } as ThemeRegistration;
}

const registered = new Set<string>();

/**
 * Registers `theme` with Pierre once and returns the name to render with.
 *
 * Registering the same name twice makes Pierre log an error and keep the first
 * loader, so the names this module already used are remembered. A theme with no
 * document yet renders with its bundled fallback.
 */
export function applyPierreTheme(runtime: PierreRuntime, theme: PierreThemeInput): string {
  if (theme.data === null) return theme.fallback;
  if (!registered.has(theme.id)) {
    registered.add(theme.id);
    const document = toPierreTheme(theme.id, theme.data);
    runtime.registerCustomTheme(theme.id, () => Promise.resolve(document));
  }
  return theme.id;
}

/** Drops the registration record. For tests only. */
export function resetPierreThemesForTests(): void {
  registered.clear();
}

/** A short, stable hash of everything in a theme that changes the picture. */
function themeRevision(theme: PluginCodeThemeData): string {
  const parts = [theme.name, theme.type, theme.fg, theme.bg];
  for (const [key, value] of Object.entries(theme.colors)) parts.push(key, value);
  for (const rule of theme.tokenColors) {
    parts.push(
      String(rule.scope ?? ""),
      rule.settings.foreground ?? "",
      rule.settings.background ?? "",
      rule.settings.fontStyle ?? "",
    );
  }
  // FNV-1a: short, dependency free, and only ever compared with itself.
  let hash = 0x811c9dc5;
  const text = parts.join(" ");
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}
