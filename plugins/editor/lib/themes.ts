/**
 * Code themes the editor can use instead of BB's. Pierre's are BB's own
 * family (BB's default code theme is `pierre-dark`); the rest are Shiki's
 * bundled VS Code themes. Both ship as lazy chunks of the editor bundle
 * (`monaco-bundle/editor.js`), so an unused theme costs nothing.
 *
 * This module is plain data shared by the server (settings options) and the
 * app (picker), so it must not import anything.
 */
export type ThemeType = "dark" | "light";

export interface CodeThemeEntry {
  id: string;
  label: string;
  type: ThemeType;
}

/** Setting value meaning "use whatever BB's code theme is". */
export const FOLLOW_BB = "bb";

export const CODE_THEMES: readonly CodeThemeEntry[] = [
  { id: "pierre-dark", label: "Pierre Dark", type: "dark" },
  { id: "pierre-dark-soft", label: "Pierre Dark Soft", type: "dark" },
  { id: "pierre-dark-vibrant", label: "Pierre Dark Vibrant", type: "dark" },
  { id: "pierre-light", label: "Pierre Light", type: "light" },
  { id: "pierre-light-soft", label: "Pierre Light Soft", type: "light" },
  { id: "pierre-light-vibrant", label: "Pierre Light Vibrant", type: "light" },
  { id: "andromeeda", label: "Andromeeda", type: "dark" },
  { id: "aurora-x", label: "Aurora X", type: "dark" },
  { id: "ayu-dark", label: "Ayu Dark", type: "dark" },
  { id: "ayu-light", label: "Ayu Light", type: "light" },
  { id: "ayu-mirage", label: "Ayu Mirage", type: "dark" },
  { id: "catppuccin-frappe", label: "Catppuccin Frappé", type: "dark" },
  { id: "catppuccin-latte", label: "Catppuccin Latte", type: "light" },
  { id: "catppuccin-macchiato", label: "Catppuccin Macchiato", type: "dark" },
  { id: "catppuccin-mocha", label: "Catppuccin Mocha", type: "dark" },
  { id: "dark-plus", label: "Dark Plus", type: "dark" },
  { id: "dracula-soft", label: "Dracula Soft", type: "dark" },
  { id: "dracula", label: "Dracula", type: "dark" },
  { id: "everforest-dark", label: "Everforest Dark", type: "dark" },
  { id: "everforest-light", label: "Everforest Light", type: "light" },
  { id: "github-dark-default", label: "GitHub Dark Default", type: "dark" },
  { id: "github-dark-dimmed", label: "GitHub Dark Dimmed", type: "dark" },
  { id: "github-dark-high-contrast", label: "GitHub Dark High Contrast", type: "dark" },
  { id: "github-dark", label: "GitHub Dark", type: "dark" },
  { id: "github-light-default", label: "GitHub Light Default", type: "light" },
  { id: "github-light-high-contrast", label: "GitHub Light High Contrast", type: "light" },
  { id: "github-light", label: "GitHub Light", type: "light" },
  { id: "gruvbox-dark-hard", label: "Gruvbox Dark Hard", type: "dark" },
  { id: "gruvbox-dark-medium", label: "Gruvbox Dark Medium", type: "dark" },
  { id: "gruvbox-dark-soft", label: "Gruvbox Dark Soft", type: "dark" },
  { id: "gruvbox-light-hard", label: "Gruvbox Light Hard", type: "light" },
  { id: "gruvbox-light-medium", label: "Gruvbox Light Medium", type: "light" },
  { id: "gruvbox-light-soft", label: "Gruvbox Light Soft", type: "light" },
  { id: "horizon-bright", label: "Horizon Bright", type: "light" },
  { id: "horizon", label: "Horizon", type: "dark" },
  { id: "houston", label: "Houston", type: "dark" },
  { id: "kanagawa-dragon", label: "Kanagawa Dragon", type: "dark" },
  { id: "kanagawa-lotus", label: "Kanagawa Lotus", type: "light" },
  { id: "kanagawa-wave", label: "Kanagawa Wave", type: "dark" },
  { id: "laserwave", label: "LaserWave", type: "dark" },
  { id: "light-plus", label: "Light Plus", type: "light" },
  { id: "material-theme-darker", label: "Material Theme Darker", type: "dark" },
  { id: "material-theme-lighter", label: "Material Theme Lighter", type: "light" },
  { id: "material-theme-ocean", label: "Material Theme Ocean", type: "dark" },
  { id: "material-theme-palenight", label: "Material Theme Palenight", type: "dark" },
  { id: "material-theme", label: "Material Theme", type: "dark" },
  { id: "min-dark", label: "Min Dark", type: "dark" },
  { id: "min-light", label: "Min Light", type: "light" },
  { id: "monokai", label: "Monokai", type: "dark" },
  { id: "night-owl-light", label: "Night Owl Light", type: "light" },
  { id: "night-owl", label: "Night Owl", type: "dark" },
  { id: "nord", label: "Nord", type: "dark" },
  { id: "one-dark-pro", label: "One Dark Pro", type: "dark" },
  { id: "one-light", label: "One Light", type: "light" },
  { id: "plastic", label: "Plastic", type: "dark" },
  { id: "poimandres", label: "Poimandres", type: "dark" },
  { id: "red", label: "Red", type: "dark" },
  { id: "rose-pine-dawn", label: "Rosé Pine Dawn", type: "light" },
  { id: "rose-pine-moon", label: "Rosé Pine Moon", type: "dark" },
  { id: "rose-pine", label: "Rosé Pine", type: "dark" },
  { id: "slack-dark", label: "Slack Dark", type: "dark" },
  { id: "slack-ochin", label: "Slack Ochin", type: "light" },
  { id: "snazzy-light", label: "Snazzy Light", type: "light" },
  { id: "solarized-dark", label: "Solarized Dark", type: "dark" },
  { id: "solarized-light", label: "Solarized Light", type: "light" },
  { id: "synthwave-84", label: "Synthwave '84", type: "dark" },
  { id: "tokyo-night", label: "Tokyo Night", type: "dark" },
  { id: "vesper", label: "Vesper", type: "dark" },
  { id: "vitesse-black", label: "Vitesse Black", type: "dark" },
  { id: "vitesse-dark", label: "Vitesse Dark", type: "dark" },
  { id: "vitesse-light", label: "Vitesse Light", type: "light" },
];

const BY_ID = new Map(CODE_THEMES.map((entry) => [entry.id, entry]));

export function codeTheme(id: string): CodeThemeEntry | undefined {
  return BY_ID.get(id);
}

export function codeThemesOfType(type: ThemeType): CodeThemeEntry[] {
  return CODE_THEMES.filter((entry) => entry.type === type);
}

/** Valid values of the dark or light theme setting: `bb` plus every theme of that type. */
export function themeSettingOptions(type: ThemeType): string[] {
  return [FOLLOW_BB, ...codeThemesOfType(type).map((entry) => entry.id)];
}

/** The setting value, or `bb` when it names nothing of that type. */
export function normalizeThemeSetting(value: unknown, type: ThemeType): string {
  return typeof value === "string" && BY_ID.get(value)?.type === type ? value : FOLLOW_BB;
}
