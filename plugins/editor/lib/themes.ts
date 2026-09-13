/**
 * Predefined dark/light pairs shared by Files, Changes, and plugin settings.
 * Choosing one in the plugin changes only its code colors. The same pairs are
 * offered app-wide, paired with a colored BB palette, by the `theme` plugin
 * (`plugins/theme/lib/theme-pairs.ts`); keep the two lists in step.
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

/** SDK select settings display their stored strings, so use readable labels. */
export const CODE_THEME_CHOICES = [
  { id: FOLLOW_BB, label: "Follow BB" },
  { id: BB_DEFAULT, label: "Pierre" },
  ...THEME_PAIRS,
] as const;

export function codeThemeId(value: unknown): string {
  return CODE_THEME_CHOICES.find((choice) => choice.label === value)?.id ?? FOLLOW_BB;
}

export function codeThemeLabel(id: string): string {
  return CODE_THEME_CHOICES.find((choice) => choice.id === id)?.label ?? "Follow BB";
}

/** The theme name a pair uses in `mode`; BB's default pair for `default`. */
export function themeNameFor(pairId: string, mode: ThemeType): string | null {
  if (pairId === FOLLOW_BB) return FOLLOW_BB;
  if (pairId === BB_DEFAULT) return mode === "dark" ? "pierre-dark" : "pierre-light";
  const pair = BY_ID.get(pairId);
  return pair === undefined ? null : pair[mode];
}

