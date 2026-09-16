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
  // Write-and-forget: a dirty buffer goes to disk shortly after typing stops.
  autoSave: "afterDelay",
  fileTreeSide: "right",
  bbDiffs: true,
};

export const AUTO_SAVE_DELAY_MS = 400;

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
    // A stored value (including an explicit "off") wins; a missing or
    // unrecognized one falls to the default. The settings store reports only
    // effective values, so an explicit "off" cannot be told from the old
    // default — whoever stored "off" before the switch now gets afterDelay.
    autoSave:
      autoSave === "off" || autoSave === "onBlur" || autoSave === "afterDelay" ? autoSave : DEFAULT_PREFS.autoSave,
    fileTreeSide: values?.fileTreeSide === "left" ? "left" : "right",
    bbDiffs: bool("bbDiffs"),
  };
}

export function monoFontFamily(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
  return `"BB Editor Geist Mono", ${value || "monospace"}`;
}

/** The row height that keeps code readable at `fontSize`. */
export function lineHeightFor(fontSize: number): number {
  return Math.round(fontSize * 1.5);
}
