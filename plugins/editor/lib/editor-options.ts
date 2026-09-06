import type * as MonacoNs from "monaco-editor";
import type { TypeScriptDiagnostics } from "./monaco-loader.js";

export type AutoSave = "off" | "onBlur" | "afterDelay";

export type TreeSide = "left" | "right";

export interface EditorPrefs {
  fontSize: number;
  /** 1 keeps the code theme's colors; lower values pull them toward the foreground. */
  colorIntensity: number;
  wordWrap: boolean;
  lineNumbers: boolean;
  minimap: boolean;
  autoSave: AutoSave;
  formatOnSave: boolean;
  typescriptDiagnostics: TypeScriptDiagnostics;
  fileTreeSide: TreeSide;
}

export const DEFAULT_PREFS: EditorPrefs = {
  fontSize: 13,
  colorIntensity: 1,
  wordWrap: false,
  lineNumbers: true,
  minimap: false,
  autoSave: "off",
  formatOnSave: false,
  typescriptDiagnostics: "syntax",
  fileTreeSide: "right",
};

export const AUTO_SAVE_DELAY_MS = 1000;

/** Effective preferences from the plugin's settings values (untrusted shape). */
export function prefsFrom(values: Record<string, unknown> | null | undefined): EditorPrefs {
  const fontSize = Number(values?.fontSize);
  const autoSave = values?.autoSave;
  const diagnostics = values?.typescriptDiagnostics;
  const bool = (key: keyof EditorPrefs & ("wordWrap" | "lineNumbers" | "minimap" | "formatOnSave")) =>
    typeof values?.[key] === "boolean" ? (values[key] as boolean) : DEFAULT_PREFS[key];
  const intensity = { full: 1, soft: 0.55, muted: 0.3 }[String(values?.colorIntensity)] ?? DEFAULT_PREFS.colorIntensity;
  return {
    fontSize: Number.isFinite(fontSize) && fontSize >= 9 && fontSize <= 24 ? Math.round(fontSize) : DEFAULT_PREFS.fontSize,
    colorIntensity: intensity,
    wordWrap: bool("wordWrap"),
    lineNumbers: bool("lineNumbers"),
    minimap: bool("minimap"),
    autoSave: autoSave === "onBlur" || autoSave === "afterDelay" ? autoSave : "off",
    formatOnSave: bool("formatOnSave"),
    typescriptDiagnostics: diagnostics === "off" || diagnostics === "semantic" ? diagnostics : "syntax",
    fileTreeSide: values?.fileTreeSide === "left" ? "left" : "right",
  };
}

export function monoFontFamily(): string | undefined {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
  return value === "" ? undefined : value;
}

/** Options that depend on preferences; applied with `updateOptions` too. */
export function prefEditorOptions(prefs: EditorPrefs): MonacoNs.editor.IEditorOptions {
  return {
    fontSize: prefs.fontSize,
    lineHeight: Math.round(prefs.fontSize * 1.4),
    wordWrap: prefs.wordWrap ? "on" : "off",
    lineNumbers: prefs.lineNumbers ? "on" : "off",
    lineDecorationsWidth: prefs.lineNumbers ? 8 : 12,
    minimap: { enabled: prefs.minimap, renderCharacters: false, maxColumn: 80, showSlider: "mouseover" },
  };
}

export function baseEditorOptions(
  prefs: EditorPrefs,
  overflowWidgetsDomNode: HTMLElement,
): MonacoNs.editor.IStandaloneEditorConstructionOptions {
  return {
    ...prefEditorOptions(prefs),
    automaticLayout: true,
    fontFamily: monoFontFamily(),
    fontLigatures: true,
    lineNumbersMinChars: 3,
    glyphMargin: false,
    folding: true,
    foldingHighlight: false,
    showFoldingControls: "mouseover",
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    cursorBlinking: "smooth",
    cursorSmoothCaretAnimation: "on",
    cursorSurroundingLines: 3,
    // Like BB's own preview: no current-line band, no bracket colors, and no
    // indentation or bracket-pair guides; the active line number is the cue.
    renderLineHighlight: "gutter",
    renderWhitespace: "selection",
    stickyScroll: { enabled: true, maxLineCount: 3 },
    bracketPairColorization: { enabled: false },
    guides: { bracketPairs: false, bracketPairsHorizontal: false, indentation: false, highlightActiveIndentation: false },
    matchBrackets: "near",
    padding: { top: 8, bottom: 8 },
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
    overviewRulerBorder: false,
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: true },
    quickSuggestions: { other: true, comments: false, strings: false },
    inlayHints: { enabled: "offUnlessPressed" },
    linkedEditing: true,
    occurrencesHighlight: "singleFile",
    multiCursorModifier: "alt",
    copyWithSyntaxHighlighting: false,
    dropIntoEditor: { enabled: false },
    fixedOverflowWidgets: true,
    overflowWidgetsDomNode,
    "semanticHighlighting.enabled": false,
  };
}
