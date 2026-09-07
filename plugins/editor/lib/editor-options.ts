export type AutoSave = "off" | "onBlur" | "afterDelay";

export type TreeSide = "left" | "right";

export interface EditorPrefs {
  fontSize: number;
  wordWrap: boolean;
  lineNumbers: boolean;
  autoSave: AutoSave;
  fileTreeSide: TreeSide;
  /** Draw BB's own diffs (timeline, diff panel) with this plugin's viewer. */
  bbDiffs: boolean;
}

const DEFAULT_PREFS: EditorPrefs = {
  fontSize: 12,
  wordWrap: false,
  lineNumbers: true,
  autoSave: "off",
  fileTreeSide: "right",
  bbDiffs: true,
};

export const AUTO_SAVE_DELAY_MS = 1000;

/** Effective preferences from the plugin's settings values (untrusted shape). */
export function prefsFrom(values: Record<string, unknown> | null | undefined): EditorPrefs {
  const fontSize = Number(values?.fontSize);
  const autoSave = values?.autoSave;
  const bool = (key: "wordWrap" | "lineNumbers" | "bbDiffs") =>
    typeof values?.[key] === "boolean" ? (values[key] as boolean) : DEFAULT_PREFS[key];
  return {
    fontSize: Number.isFinite(fontSize) && fontSize >= 9 && fontSize <= 24 ? Math.round(fontSize) : DEFAULT_PREFS.fontSize,
    wordWrap: bool("wordWrap"),
    lineNumbers: bool("lineNumbers"),
    autoSave: autoSave === "onBlur" || autoSave === "afterDelay" ? autoSave : "off",
    fileTreeSide: values?.fileTreeSide === "left" ? "left" : "right",
    bbDiffs: bool("bbDiffs"),
  };
}

export function monoFontFamily(): string | undefined {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
  return `"BB Editor Geist Mono", ${value || "monospace"}`;
}

/** The row height that keeps code readable at `fontSize`. */
export function lineHeightFor(fontSize: number): number {
  return Math.round(fontSize * 1.5);
}
