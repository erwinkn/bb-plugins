/**
 * BB's code theme (`experimental_useCodeTheme`) in the form Shiki registers.
 * Pure functions, shared by the app and the tests.
 */
import type { PluginCodeThemeData } from "@get-bb/plugin-sdk/app";
import type { ThemeRegistration } from "@shikijs/types";

/**
 * The name a BB theme document is registered under. Shiki keeps a theme by
 * name forever, so the name changes whenever the colours do (a short hash of
 * everything that reaches the screen). It is hex-only on purpose: BlockNote
 * switches to a two-theme CSS-variable mode when the loaded theme names look
 * like "light" and "dark", which would leave tokens uncoloured here.
 */
export function codeThemeName(theme: PluginCodeThemeData): string {
  const parts = [theme.name, theme.type, theme.fg, theme.bg];
  for (const [key, value] of Object.entries(theme.colors)) parts.push(key, value);
  for (const rule of theme.tokenColors) {
    parts.push(String(rule.scope ?? ""), rule.settings.foreground ?? "", rule.settings.background ?? "", rule.settings.fontStyle ?? "");
  }
  // FNV-1a over the joined parts; only ever compared with itself.
  let hash = 0x811c9dc5;
  const text = parts.join("|");
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `bbsp-${hash.toString(16).padStart(8, "0")}`;
}

/**
 * Converts BB's theme document into a Shiki registration under `name`.
 *
 * VS Code themes may list several selectors in one comma-separated string.
 * Shiki's TextMate parser splits such a string only when it arrives as a
 * string; inside an array each entry is taken whole, so `"keyword, storage"`
 * in an array would never match. Every scope is therefore split here.
 */
export function toShikiTheme(name: string, theme: PluginCodeThemeData): ThemeRegistration {
  const settings = theme.tokenColors.map((rule) => {
    const scope = rule.scope === undefined ? undefined : splitScopes(rule.scope);
    return scope === undefined ? { settings: { ...rule.settings } } : { scope, settings: { ...rule.settings } };
  });
  return { name, type: theme.type, fg: theme.fg, bg: theme.bg, colors: { ...theme.colors }, settings };
}

function splitScopes(scope: string | readonly string[]): string[] {
  const list = typeof scope === "string" ? [scope] : scope;
  return list.flatMap((entry) => entry.split(",").map((part) => part.trim()).filter((part) => part !== ""));
}
