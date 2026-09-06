import type * as MonacoNs from "monaco-editor";
import type { TypeScriptDiagnostics } from "./monaco-loader.js";

export type AutoSave = "off" | "onBlur" | "afterDelay";

export interface EditorPrefs {
  fontSize: number;
  wordWrap: boolean;
  minimap: boolean;
  autoSave: AutoSave;
  typescriptDiagnostics: TypeScriptDiagnostics;
}

export const DEFAULT_PREFS: EditorPrefs = {
  fontSize: 13,
  wordWrap: false,
  minimap: false,
  autoSave: "off",
  typescriptDiagnostics: "syntax",
};

export const AUTO_SAVE_DELAY_MS = 1000;

/** Effective preferences from the plugin's settings values (untrusted shape). */
export function prefsFrom(values: Record<string, unknown> | null | undefined): EditorPrefs {
  const fontSize = Number(values?.fontSize);
  const autoSave = values?.autoSave;
  const diagnostics = values?.typescriptDiagnostics;
  return {
    fontSize: Number.isFinite(fontSize) && fontSize >= 9 && fontSize <= 24 ? Math.round(fontSize) : DEFAULT_PREFS.fontSize,
    wordWrap: typeof values?.wordWrap === "boolean" ? values.wordWrap : DEFAULT_PREFS.wordWrap,
    minimap: typeof values?.minimap === "boolean" ? values.minimap : DEFAULT_PREFS.minimap,
    autoSave: autoSave === "onBlur" || autoSave === "afterDelay" ? autoSave : "off",
    typescriptDiagnostics: diagnostics === "off" || diagnostics === "semantic" ? diagnostics : "syntax",
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
    lineNumbers: "on",
    lineNumbersMinChars: 3,
    lineDecorationsWidth: 8,
    glyphMargin: false,
    folding: true,
    foldingHighlight: false,
    showFoldingControls: "mouseover",
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    cursorBlinking: "smooth",
    cursorSmoothCaretAnimation: "on",
    cursorSurroundingLines: 3,
    renderLineHighlight: "line",
    renderLineHighlightOnlyWhenFocus: true,
    renderWhitespace: "selection",
    stickyScroll: { enabled: true, maxLineCount: 3 },
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: "active", indentation: true, highlightActiveIndentation: true },
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
