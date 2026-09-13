/**
 * The unified themes this plugin contributes: one entry per code theme pair,
 * every one of them painting the same app palette (`themes/color.css`).
 *
 * Selecting `plugin:theme:<id>` in Settings → Appearance (or `bb theme set`)
 * applies BB chrome colors and the matching Pierre/Shiki code pair in one
 * step; plugins that call `experimental_useCodeTheme` (the editor's diffs and
 * file views) follow the pair automatically.
 *
 * `scripts/sync-manifest.mjs` writes this list into `package.json`, and
 * `manifest.test.ts` fails when the two drift. Plain data: no imports.
 */
export interface ThemePair {
  /** Suffix of the theme id; the manifest id is `color-<id>`. */
  id: string;
  /** Display name in BB's theme list. */
  name: string;
  /** Code theme names BB's registry resolves (Pierre family or Shiki bundled). */
  dark: string;
  light: string;
}

export const THEME_ID_PREFIX = "color-";
export const THEME_CSS = "./themes/color.css";

/** Pierre first (BB's own family), then the rest in the editor's order. */
export const THEME_PAIRS: readonly ThemePair[] = [
  { id: "pierre", name: "Pierre", dark: "pierre-dark", light: "pierre-light" },
  { id: "pierre-soft", name: "Pierre Soft", dark: "pierre-dark-soft", light: "pierre-light-soft" },
  { id: "pierre-vibrant", name: "Pierre Vibrant", dark: "pierre-dark-vibrant", light: "pierre-light-vibrant" },
  { id: "github", name: "GitHub", dark: "github-dark", light: "github-light" },
  { id: "github-default", name: "GitHub Default", dark: "github-dark-default", light: "github-light-default" },
  { id: "github-dimmed", name: "GitHub Dimmed", dark: "github-dark-dimmed", light: "github-light-default" },
  { id: "github-high-contrast", name: "GitHub High Contrast", dark: "github-dark-high-contrast", light: "github-light-high-contrast" },
  { id: "vs-code", name: "VS Code", dark: "dark-plus", light: "light-plus" },
  { id: "one", name: "One", dark: "one-dark-pro", light: "one-light" },
  { id: "catppuccin-mocha", name: "Catppuccin Mocha", dark: "catppuccin-mocha", light: "catppuccin-latte" },
  { id: "catppuccin-macchiato", name: "Catppuccin Macchiato", dark: "catppuccin-macchiato", light: "catppuccin-latte" },
  { id: "catppuccin-frappe", name: "Catppuccin Frappé", dark: "catppuccin-frappe", light: "catppuccin-latte" },
  { id: "ayu", name: "Ayu", dark: "ayu-dark", light: "ayu-light" },
  { id: "ayu-mirage", name: "Ayu Mirage", dark: "ayu-mirage", light: "ayu-light" },
  { id: "everforest", name: "Everforest", dark: "everforest-dark", light: "everforest-light" },
  { id: "gruvbox-hard", name: "Gruvbox Hard", dark: "gruvbox-dark-hard", light: "gruvbox-light-hard" },
  { id: "gruvbox-medium", name: "Gruvbox Medium", dark: "gruvbox-dark-medium", light: "gruvbox-light-medium" },
  { id: "gruvbox-soft", name: "Gruvbox Soft", dark: "gruvbox-dark-soft", light: "gruvbox-light-soft" },
  { id: "kanagawa-wave", name: "Kanagawa Wave", dark: "kanagawa-wave", light: "kanagawa-lotus" },
  { id: "kanagawa-dragon", name: "Kanagawa Dragon", dark: "kanagawa-dragon", light: "kanagawa-lotus" },
  { id: "material", name: "Material", dark: "material-theme", light: "material-theme-lighter" },
  { id: "material-ocean", name: "Material Ocean", dark: "material-theme-ocean", light: "material-theme-lighter" },
  { id: "material-palenight", name: "Material Palenight", dark: "material-theme-palenight", light: "material-theme-lighter" },
  { id: "material-darker", name: "Material Darker", dark: "material-theme-darker", light: "material-theme-lighter" },
  { id: "min", name: "Min", dark: "min-dark", light: "min-light" },
  { id: "night-owl", name: "Night Owl", dark: "night-owl", light: "night-owl-light" },
  { id: "rose-pine", name: "Rosé Pine", dark: "rose-pine", light: "rose-pine-dawn" },
  { id: "rose-pine-moon", name: "Rosé Pine Moon", dark: "rose-pine-moon", light: "rose-pine-dawn" },
  { id: "solarized", name: "Solarized", dark: "solarized-dark", light: "solarized-light" },
  { id: "vitesse", name: "Vitesse", dark: "vitesse-dark", light: "vitesse-light" },
  { id: "vitesse-black", name: "Vitesse Black", dark: "vitesse-black", light: "vitesse-light" },
  { id: "slack", name: "Slack", dark: "slack-dark", light: "slack-ochin" },
  { id: "tokyo-night", name: "Tokyo Night", dark: "tokyo-night", light: "pierre-light" },
  { id: "dracula-soft", name: "Dracula Soft", dark: "dracula-soft", light: "pierre-light" },
  { id: "aurora-x", name: "Aurora X", dark: "aurora-x", light: "pierre-light" },
  { id: "synthwave-84", name: "Synthwave '84", dark: "synthwave-84", light: "pierre-light" },
  { id: "horizon", name: "Horizon", dark: "pierre-dark", light: "horizon-bright" },
  { id: "snazzy", name: "Snazzy", dark: "pierre-dark", light: "snazzy-light" },
];

/** The `bb.themes` manifest entries, in order. */
export function manifestThemes(pairs: readonly ThemePair[] = THEME_PAIRS) {
  return pairs.map((pair) => ({
    id: `${THEME_ID_PREFIX}${pair.id}`,
    name: pair.name,
    css: THEME_CSS,
    codeTheme: { dark: pair.dark, light: pair.light },
  }));
}
