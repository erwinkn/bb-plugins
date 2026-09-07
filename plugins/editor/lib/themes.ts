/**
 * Code themes the Files view can put on BB. Each entry is a dark/light pair
 * that the plugin contributes to BB as an app theme (see `bb.themes` in
 * package.json): choosing one sets BB's theme, so BB's previews, the diff
 * view, and this editor all paint with it. The CSS of every entry is empty,
 * so BB keeps its default palette and only the code theme changes.
 *
 * Every name here is one BB's own code-theme registry resolves (Pierre's
 * family plus Shiki's bundled VS Code themes). The same themes ship as lazy
 * chunks of the editor bundle so the picker can preview them before BB
 * switches.
 *
 * This module is plain data shared by the server and the app, so it must
 * not import anything.
 */
export type ThemeType = "dark" | "light";

export interface ThemePair {
  /** Theme id inside the plugin; BB's id is `plugin:<pluginId>:<id>`. */
  id: string;
  label: string;
  dark: string;
  light: string;
}

/** BB's stock theme (Pierre Dark / Pierre Light with BB's default palette). */
export const BB_DEFAULT = "default";

/** Editor-side marker for "paint with whatever BB's code theme is". */
export const FOLLOW_BB = "bb";
/** Local syntax palette; it is deliberately not a BB app-theme contribution. */
export const CONDUCTOR = "conductor";

export const THEME_PAIRS: readonly ThemePair[] = [
  { id: "pierre-soft", label: "Pierre Soft", dark: "pierre-dark-soft", light: "pierre-light-soft" },
  { id: "pierre-vibrant", label: "Pierre Vibrant", dark: "pierre-dark-vibrant", light: "pierre-light-vibrant" },
  { id: "github", label: "GitHub", dark: "github-dark", light: "github-light" },
  { id: "github-default", label: "GitHub Default", dark: "github-dark-default", light: "github-light-default" },
  { id: "github-dimmed", label: "GitHub Dimmed", dark: "github-dark-dimmed", light: "github-light-default" },
  { id: "github-high-contrast", label: "GitHub High Contrast", dark: "github-dark-high-contrast", light: "github-light-high-contrast" },
  { id: "vs-code", label: "VS Code", dark: "dark-plus", light: "light-plus" },
  { id: "one", label: "One", dark: "one-dark-pro", light: "one-light" },
  { id: "catppuccin-mocha", label: "Catppuccin Mocha", dark: "catppuccin-mocha", light: "catppuccin-latte" },
  { id: "catppuccin-macchiato", label: "Catppuccin Macchiato", dark: "catppuccin-macchiato", light: "catppuccin-latte" },
  { id: "catppuccin-frappe", label: "Catppuccin Frappé", dark: "catppuccin-frappe", light: "catppuccin-latte" },
  { id: "ayu", label: "Ayu", dark: "ayu-dark", light: "ayu-light" },
  { id: "ayu-mirage", label: "Ayu Mirage", dark: "ayu-mirage", light: "ayu-light" },
  { id: "everforest", label: "Everforest", dark: "everforest-dark", light: "everforest-light" },
  { id: "gruvbox-hard", label: "Gruvbox Hard", dark: "gruvbox-dark-hard", light: "gruvbox-light-hard" },
  { id: "gruvbox-medium", label: "Gruvbox Medium", dark: "gruvbox-dark-medium", light: "gruvbox-light-medium" },
  { id: "gruvbox-soft", label: "Gruvbox Soft", dark: "gruvbox-dark-soft", light: "gruvbox-light-soft" },
  { id: "kanagawa-wave", label: "Kanagawa Wave", dark: "kanagawa-wave", light: "kanagawa-lotus" },
  { id: "kanagawa-dragon", label: "Kanagawa Dragon", dark: "kanagawa-dragon", light: "kanagawa-lotus" },
  { id: "material", label: "Material", dark: "material-theme", light: "material-theme-lighter" },
  { id: "material-ocean", label: "Material Ocean", dark: "material-theme-ocean", light: "material-theme-lighter" },
  { id: "material-palenight", label: "Material Palenight", dark: "material-theme-palenight", light: "material-theme-lighter" },
  { id: "material-darker", label: "Material Darker", dark: "material-theme-darker", light: "material-theme-lighter" },
  { id: "min", label: "Min", dark: "min-dark", light: "min-light" },
  { id: "night-owl", label: "Night Owl", dark: "night-owl", light: "night-owl-light" },
  { id: "rose-pine", label: "Rosé Pine", dark: "rose-pine", light: "rose-pine-dawn" },
  { id: "rose-pine-moon", label: "Rosé Pine Moon", dark: "rose-pine-moon", light: "rose-pine-dawn" },
  { id: "solarized", label: "Solarized", dark: "solarized-dark", light: "solarized-light" },
  { id: "vitesse", label: "Vitesse", dark: "vitesse-dark", light: "vitesse-light" },
  { id: "vitesse-black", label: "Vitesse Black", dark: "vitesse-black", light: "vitesse-light" },
  { id: "slack", label: "Slack", dark: "slack-dark", light: "slack-ochin" },
  { id: "tokyo-night", label: "Tokyo Night", dark: "tokyo-night", light: "pierre-light" },
  { id: "dracula-soft", label: "Dracula Soft", dark: "dracula-soft", light: "pierre-light" },
  { id: "aurora-x", label: "Aurora X", dark: "aurora-x", light: "pierre-light" },
  { id: "synthwave-84", label: "Synthwave '84", dark: "synthwave-84", light: "pierre-light" },
  { id: "horizon", label: "Horizon", dark: "pierre-dark", light: "horizon-bright" },
  { id: "snazzy", label: "Snazzy", dark: "pierre-dark", light: "snazzy-light" },
];

const BY_ID = new Map(THEME_PAIRS.map((pair) => [pair.id, pair]));

export function themePair(id: string): ThemePair | undefined {
  return BY_ID.get(id);
}

/** BB's app-theme id for a pair contributed by this plugin. */
export function bbThemeId(pluginId: string, pairId: string): string {
  return `plugin:${pluginId}:${pairId}`;
}

/** The pair id behind a BB theme id, or `default`; null for a theme that is not ours. */
export function pairIdFromBbTheme(pluginId: string, themeId: string): string | null {
  if (themeId === BB_DEFAULT) return BB_DEFAULT;
  const prefix = `plugin:${pluginId}:`;
  if (!themeId.startsWith(prefix)) return null;
  const id = themeId.slice(prefix.length);
  return BY_ID.has(id) ? id : null;
}

/** The theme name a pair uses in `mode`; BB's default pair for `default`. */
export function themeNameFor(pairId: string, mode: ThemeType): string | null {
  if (pairId === CONDUCTOR) return `conductor-${mode}`;
  if (pairId === FOLLOW_BB) return FOLLOW_BB;
  if (pairId === BB_DEFAULT) return mode === "dark" ? "pierre-dark" : "pierre-light";
  const pair = BY_ID.get(pairId);
  return pair === undefined ? null : pair[mode];
}

/** The `bb.themes` manifest entries for the pairs, kept in sync by a test. */
export function manifestThemes(css: string): { id: string; name: string; css: string; codeTheme: { dark: string; light: string } }[] {
  return THEME_PAIRS.map((pair) => ({ id: pair.id, name: pair.label, css, codeTheme: { dark: pair.dark, light: pair.light } }));
}
