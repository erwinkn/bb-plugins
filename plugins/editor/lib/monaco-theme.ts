import type * as MonacoNs from "monaco-editor";
import type { PluginCodeThemeData } from "@get-bb/plugin-sdk/app";

const HEX = /^([0-9A-Fa-f]{6})([0-9A-Fa-f]{2})?$/;

/** Monaco accepts only `[a-z0-9-]` theme names; BB's are namespaced. */
export function monacoThemeName(name: string): string {
  return `bb-${name.replace(/[^a-zA-Z0-9-]/g, "-")}`;
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
 * Workbench colors: the theme document's own, completed with values derived
 * from its editor background and foreground for the chrome Monaco draws
 * (gutter, line highlight, guides, widgets, scrollbars) when the document
 * does not declare them. Derived colors keep the editor coherent inside BB
 * instead of falling back to VS Code's stock grays.
 */
export function workbenchColors(theme: PluginCodeThemeData): Record<string, string> {
  const colors: Record<string, string> = {};
  for (const [id, value] of Object.entries(theme.colors)) {
    const hex = normalizeHex(typeof value === "string" ? value : undefined);
    if (hex !== undefined) colors[id] = `#${hex}`;
  }
  const bg = normalizeHex(colors["editor.background"] ?? theme.bg)?.slice(0, 6);
  const fg = normalizeHex(colors["editor.foreground"] ?? theme.fg)?.slice(0, 6);
  if (bg === undefined || fg === undefined) return colors;
  colors["editor.background"] ??= `#${bg}`;
  colors["editor.foreground"] ??= `#${fg}`;

  const dark = theme.type !== "light";
  const raised = `#${mixHex(bg, fg, dark ? 0.06 : 0.04)}`;
  const border = withAlpha(fg, 0.14);
  const defaults: Record<string, string> = {
    "editorGutter.background": `#${bg}`,
    "editorLineNumber.foreground": withAlpha(fg, 0.35),
    "editorLineNumber.activeForeground": withAlpha(fg, 0.8),
    "editor.lineHighlightBackground": withAlpha(fg, 0.05),
    "editor.lineHighlightBorder": "#00000000",
    "editorIndentGuide.background1": withAlpha(fg, 0.1),
    "editorIndentGuide.activeBackground1": withAlpha(fg, 0.28),
    "editorWhitespace.foreground": withAlpha(fg, 0.18),
    "editorCursor.foreground": `#${fg}`,
    "editor.selectionBackground": withAlpha(fg, dark ? 0.2 : 0.16),
    "editor.inactiveSelectionBackground": withAlpha(fg, 0.1),
    "editor.selectionHighlightBackground": withAlpha(fg, 0.1),
    "editor.wordHighlightBackground": withAlpha(fg, 0.1),
    "editor.wordHighlightStrongBackground": withAlpha(fg, 0.14),
    "editor.findMatchBackground": withAlpha(fg, 0.3),
    "editor.findMatchHighlightBackground": withAlpha(fg, 0.14),
    "editorBracketMatch.background": withAlpha(fg, 0.1),
    "editorBracketMatch.border": withAlpha(fg, 0.3),
    "editorOverviewRuler.border": "#00000000",
    "editorWidget.background": raised,
    "editorWidget.border": border,
    "editorWidget.foreground": `#${fg}`,
    "editorSuggestWidget.background": raised,
    "editorSuggestWidget.border": border,
    "editorSuggestWidget.selectedBackground": withAlpha(fg, 0.12),
    "editorSuggestWidget.highlightForeground": `#${fg}`,
    "editorHoverWidget.background": raised,
    "editorHoverWidget.border": border,
    "input.background": withAlpha(fg, 0.06),
    "input.border": border,
    "input.foreground": `#${fg}`,
    "input.placeholderForeground": withAlpha(fg, 0.45),
    focusBorder: withAlpha(fg, 0.35),
    "scrollbar.shadow": "#00000000",
    "scrollbarSlider.background": withAlpha(fg, 0.12),
    "scrollbarSlider.hoverBackground": withAlpha(fg, 0.2),
    "scrollbarSlider.activeBackground": withAlpha(fg, 0.28),
    "editorStickyScroll.background": `#${bg}`,
    "editorStickyScroll.shadow": withAlpha(fg, 0.12),
    "editorStickyScrollHover.background": withAlpha(fg, 0.06),
    "list.hoverBackground": withAlpha(fg, 0.06),
    "list.focusBackground": withAlpha(fg, 0.12),
    "list.activeSelectionBackground": withAlpha(fg, 0.12),
    "list.activeSelectionForeground": `#${fg}`,
    "quickInput.background": raised,
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
  for (const [id, value] of Object.entries(defaults)) colors[id] ??= value;
  return colors;
}

export function editorBackground(theme: PluginCodeThemeData | null): string | null {
  if (theme === null) return null;
  return workbenchColors(theme)["editor.background"] ?? null;
}

export function toMonacoTheme(theme: PluginCodeThemeData): MonacoNs.editor.IStandaloneThemeData {
  return {
    base: theme.type === "light" ? "vs" : "vs-dark",
    inherit: true,
    rules: tokenRules(theme),
    colors: workbenchColors(theme),
  };
}
