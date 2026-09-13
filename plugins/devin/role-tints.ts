// Role hues, light and dark, the same pairs the theme plugin's palette uses
// (`--bbp-*`). Shared by the provider declaration (server side) and the row
// tint decorator (host side), so it must stay free of SDK imports: the
// server runtime cannot resolve the provider-bridge module.
//
// BB only accepts literal colors for tints (`#hex` or a color function),
// never `var()`, and renders each pair through light-dark().

export interface Tint { light: string; dark: string }

export const ROLE_TINTS = {
  file: { light: "oklch(0.55 0.1 250)", dark: "oklch(0.72 0.09 250)" },
  command: { light: "oklch(0.52 0.11 200)", dark: "oklch(0.75 0.11 200)" },
  web: { light: "oklch(0.52 0.11 230)", dark: "oklch(0.75 0.11 230)" },
  edit: { light: "oklch(0.55 0.14 50)", dark: "oklch(0.75 0.16 50)" },
  attention: { light: "oklch(0.58 0.14 80)", dark: "oklch(0.8 0.15 80)" },
  error: { light: "oklch(0.45 0.19 25.86)", dark: "oklch(0.65 0.16 22)" },
  agent: { light: "oklch(0.53 0.2 295)", dark: "oklch(0.68 0.18 295)" },
  /** Reasoning: the agent hue, receded. */
  thinking: { light: "oklch(0.55 0.12 295)", dark: "oklch(0.72 0.1 295)" },
} as const satisfies Record<string, Tint>;
