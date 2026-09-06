import type * as MonacoNs from "monaco-editor";
import type { PluginCodeThemeData } from "@get-bb/plugin-sdk/app";
import type { BbTokens } from "./bb-tokens.js";

const HEX = /^([0-9A-Fa-f]{6})([0-9A-Fa-f]{2})?$/;

/** Monaco accepts only `[a-z0-9-]` theme names; BB's are namespaced. */
export function monacoThemeName(name: string): string {
  return `bb-${name.replace(/[^a-zA-Z0-9-]/g, "-")}`;
}

/**
 * A short stable hash of the parts of a theme document that decide colors.
 * Two documents that share a name but differ in content get different Monaco
 * and Shiki registrations, so a palette switch can never reuse stale tokens.
 */
export function themeFingerprint(theme: PluginCodeThemeData): string {
  const text = JSON.stringify([theme.type, theme.fg, theme.bg, theme.tokenColors]);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/**
 * The theme with its token colors desaturated. `intensity` scales each
 * color's chroma in OKLCH (perceptual, so hue and lightness stay put):
 * 1 keeps the theme as designed, 0.55 reads as calm tints, 0.3 is close to
 * monochrome. Grays are untouched, so comments and punctuation keep their
 * weight relative to the text.
 */
export function softenTheme(theme: PluginCodeThemeData, intensity: number): PluginCodeThemeData {
  if (intensity >= 1) return theme;
  const factor = Math.max(0, intensity);
  const soften = (value: string | undefined) => {
    const hex = normalizeHex(value);
    if (hex === undefined) return value;
    const alpha = hex.length === 8 ? hex.slice(6) : "";
    return `#${scaleChroma(hex.slice(0, 6), factor)}${alpha}`;
  };
  return {
    ...theme,
    name: `${theme.name}:chroma${Math.round(factor * 100)}`,
    tokenColors: theme.tokenColors.map((rule) => ({
      ...rule,
      settings: { ...rule.settings, ...(rule.settings.foreground === undefined ? {} : { foreground: soften(rule.settings.foreground) }) },
    })),
  };
}

/** `RRGGBB` with its OKLCH chroma multiplied by `factor`, clipped to sRGB. */
export function scaleChroma(hex: string, factor: number): string {
  const { L, a, b } = oklab(hex);
  return fromOklab(L, a * factor, b * factor);
}

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number): number {
  const c = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}

function oklab(hex: string): { L: number; a: number; b: number } {
  const r = srgbToLinear(Number.parseInt(hex.slice(0, 2), 16));
  const g = srgbToLinear(Number.parseInt(hex.slice(2, 4), 16));
  const b = srgbToLinear(Number.parseInt(hex.slice(4, 6), 16));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function fromOklab(L: number, a: number, b: number): string {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return [r, g, bl].map((channel) => linearToSrgb(channel).toString(16).padStart(2, "0")).join("");
}

/**
 * A color as `RRGGBB` or `RRGGBBAA` without `#`, which is what Monaco's rule
 * parser accepts; 3- and 4-digit forms expand. Anything else is dropped.
 */
export function normalizeHex(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) return undefined;
  const hex = raw.startsWith("#") ? raw.slice(1) : raw;
  const expanded =
    hex.length === 3 || hex.length === 4
      ? hex
          .split("")
          .map((digit) => digit + digit)
          .join("")
      : hex;
  return HEX.test(expanded) ? expanded.toLowerCase() : undefined;
}

export function normalizeFontStyle(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const styles = new Set(value.split(/[\s,]+/).map((style) => style.trim().toLowerCase()));
  const kept = ["italic", "bold", "underline", "strikethrough"].filter((style) => styles.has(style));
  return kept.length === 0 ? undefined : kept.join(" ");
}

/** Blend `top` over `base` at `alpha`; both `RRGGBB`. */
export function mixHex(base: string, top: string, alpha: number): string {
  const channel = (offset: number) => {
    const b = Number.parseInt(base.slice(offset, offset + 2), 16);
    const t = Number.parseInt(top.slice(offset, offset + 2), 16);
    return Math.round(b + (t - b) * alpha)
      .toString(16)
      .padStart(2, "0");
  };
  return channel(0) + channel(2) + channel(4);
}

function withAlpha(hex: string, alpha: number): string {
  return `#${hex.slice(0, 6)}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0")}`;
}

/** The theme's token rules, one per scope, in Monaco's shape. */
export function tokenRules(theme: PluginCodeThemeData): MonacoNs.editor.ITokenThemeRule[] {
  const rules: MonacoNs.editor.ITokenThemeRule[] = [];
  const base = normalizeHex(theme.fg);
  if (base !== undefined) rules.push({ token: "", foreground: base });
  for (const rule of theme.tokenColors) {
    const foreground = normalizeHex(rule.settings.foreground);
    const background = normalizeHex(rule.settings.background);
    const fontStyle = normalizeFontStyle(rule.settings.fontStyle);
    if (foreground === undefined && background === undefined && fontStyle === undefined) continue;
    const scopes =
      rule.scope === undefined ? [] : typeof rule.scope === "string" ? rule.scope.split(",") : rule.scope;
    for (const scope of scopes) {
      const token = scope.trim();
      if (token === "") continue;
      rules.push({
        token,
        ...(foreground === undefined ? {} : { foreground }),
        ...(background === undefined ? {} : { background }),
        ...(fontStyle === undefined ? {} : { fontStyle }),
      });
    }
  }
  return rules;
}

/**
 * Workbench colors. Token colors come from the code theme, but the chrome
 * Monaco draws (editor surface, gutter, line highlight, guides, widgets,
 * scrollbars) takes BB's own surfaces when `tokens` resolve, so the editor is
 * one piece with the panel around it instead of a foreign theme inside it.
 * Without tokens, the chrome derives from the theme's editor background and
 * foreground.
 */
export function workbenchColors(theme: PluginCodeThemeData, tokens: BbTokens | null = null): Record<string, string> {
  const declared: Record<string, string> = {};
  for (const [id, value] of Object.entries(theme.colors)) {
    const hex = normalizeHex(typeof value === "string" ? value : undefined);
    if (hex !== undefined) declared[id] = `#${hex}`;
  }
  const themeBg = normalizeHex(declared["editor.background"] ?? theme.bg)?.slice(0, 6);
  const fg = normalizeHex(declared["editor.foreground"] ?? theme.fg)?.slice(0, 6);
  if (themeBg === undefined || fg === undefined) return declared;
  const dark = theme.type !== "light";
  const bg = tokens === null ? themeBg : tokens.background.slice(1);
  const surface = tokens === null ? `#${mixHex(bg, fg, dark ? 0.06 : 0.04)}` : tokens.popover;
  const border = tokens === null ? withAlpha(fg, 0.14) : tokens.border;
  const hover = tokens === null ? withAlpha(fg, 0.1) : tokens.stateHover;
  const lineNumber = tokens === null ? withAlpha(fg, 0.35) : tokens.subtleForeground;
  const lineNumberActive = tokens === null ? withAlpha(fg, 0.8) : tokens.mutedForeground;
  const focus = tokens === null ? withAlpha(fg, 0.35) : tokens.ring;

  const chrome: Record<string, string> = {
    "editor.background": `#${bg}`,
    "editor.foreground": `#${fg}`,
    "editorGutter.background": `#${bg}`,
    "editorLineNumber.foreground": lineNumber,
    "editorLineNumber.activeForeground": lineNumberActive,
    "editor.lineHighlightBackground": withAlpha(fg, 0.04),
    "editor.lineHighlightBorder": "#00000000",
    "editorIndentGuide.background1": tokens === null ? withAlpha(fg, 0.1) : withAlpha(tokens.border.slice(1), 0.7),
    "editorIndentGuide.activeBackground1": tokens === null ? withAlpha(fg, 0.28) : withAlpha(fg, 0.3),
    "editorWhitespace.foreground": withAlpha(fg, 0.18),
    "editorCursor.foreground": `#${fg}`,
    "editorBracketMatch.background": withAlpha(fg, 0.1),
    "editorBracketMatch.border": withAlpha(fg, 0.3),
    "editorOverviewRuler.border": "#00000000",
    "editorWidget.background": surface,
    "editorWidget.border": border,
    "editorWidget.foreground": `#${fg}`,
    "editorSuggestWidget.background": surface,
    "editorSuggestWidget.border": border,
    "editorSuggestWidget.selectedBackground": hover,
    "editorSuggestWidget.highlightForeground": `#${fg}`,
    "editorHoverWidget.background": surface,
    "editorHoverWidget.border": border,
    "input.background": tokens === null ? withAlpha(fg, 0.06) : tokens.surfaceRecessed,
    "input.border": border,
    "input.foreground": `#${fg}`,
    "input.placeholderForeground": lineNumber,
    focusBorder: focus,
    "scrollbar.shadow": "#00000000",
    "scrollbarSlider.background": withAlpha(fg, 0.08),
    "scrollbarSlider.hoverBackground": withAlpha(fg, 0.16),
    "scrollbarSlider.activeBackground": withAlpha(fg, 0.24),
    "editorStickyScroll.background": `#${bg}`,
    "editorStickyScroll.shadow": border,
    "editorStickyScrollHover.background": hover,
    "list.hoverBackground": hover,
    "list.focusBackground": hover,
    "list.activeSelectionBackground": hover,
    "list.activeSelectionForeground": `#${fg}`,
    "quickInput.background": surface,
    "quickInput.foreground": `#${fg}`,
    "pickerGroup.border": border,
    "widget.shadow": withAlpha("000000", dark ? 0.4 : 0.15),
    "diffEditor.insertedTextBackground": dark ? "#2ea04333" : "#1a7f3733",
    "diffEditor.removedTextBackground": dark ? "#f8514933" : "#cf222e33",
    "diffEditor.insertedLineBackground": dark ? "#2ea0431f" : "#1a7f371a",
    "diffEditor.removedLineBackground": dark ? "#f851491f" : "#cf222e1a",
    "diffEditorGutter.insertedLineBackground": dark ? "#2ea04333" : "#1a7f3733",
    "diffEditorGutter.removedLineBackground": dark ? "#f8514933" : "#cf222e33",
  };
  // Selection and highlight colors are part of the code theme's design and
  // read fine on BB's surface, so declared values win there; the chrome above
  // wins over declared workbench colors when BB tokens resolved.
  const selection: Record<string, string> = {
    "editor.selectionBackground": withAlpha(fg, dark ? 0.2 : 0.16),
    "editor.inactiveSelectionBackground": withAlpha(fg, 0.1),
    "editor.selectionHighlightBackground": withAlpha(fg, 0.07),
    "editor.wordHighlightBackground": withAlpha(fg, 0.07),
    "editor.wordHighlightStrongBackground": withAlpha(fg, 0.1),
    "editor.findMatchBackground": withAlpha(fg, 0.3),
    "editor.findMatchHighlightBackground": withAlpha(fg, 0.14),
  };
  const colors: Record<string, string> = { ...selection, ...declared };
  if (tokens === null) {
    for (const [id, value] of Object.entries(chrome)) colors[id] ??= value;
  } else {
    Object.assign(colors, chrome);
    colors["editorCursor.foreground"] = declared["editorCursor.foreground"] ?? `#${fg}`;
  }
  return colors;
}

export function editorBackground(theme: PluginCodeThemeData | null, tokens: BbTokens | null = null): string | null {
  if (theme === null) return null;
  return workbenchColors(theme, tokens)["editor.background"] ?? null;
}

export function toMonacoTheme(theme: PluginCodeThemeData, tokens: BbTokens | null = null): MonacoNs.editor.IStandaloneThemeData {
  return {
    base: theme.type === "light" ? "vs" : "vs-dark",
    inherit: true,
    rules: tokenRules(theme),
    colors: workbenchColors(theme, tokens),
  };
}
