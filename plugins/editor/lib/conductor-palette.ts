import type { PluginCodeThemeData } from "@get-bb/plugin-sdk/app";

/** Observed Conductor 0.84.2 colors, applied with our own compact scope rules. */
const PALETTES = {
  dark: {
    fg: "#eae8e6", bg: "#141110", comment: "#8e8885", keyword: "#f87272",
    string: "#ddc1b1", constant: "#61a6fa", entity: "#e852ff", variable: "#fb923c", tag: "#4ade80",
  },
  light: {
    fg: "#2c2826", bg: "#ffffff", comment: "#a5a09c", keyword: "#dc2828",
    string: "#594545", constant: "#2463eb", entity: "#cb00eb", variable: "#e9560c", tag: "#157f3c",
  },
} as const;

/**
 * Only syntax colors are local. Surface styles replace the fallback canvas
 * color with BB's background, and BB continues to draw every UI component.
 */
export function conductorCodeTheme(mode: "dark" | "light"): PluginCodeThemeData {
  const colors = PALETTES[mode];
  const rule = (scope: string[], foreground: string) => ({ scope, settings: { foreground } });
  return {
    name: `Conductor-inspired ${mode}`,
    type: mode,
    fg: colors.fg,
    bg: colors.bg,
    colors: {
      "editor.foreground": colors.fg,
      "editor.background": colors.bg,
      "editorCursor.foreground": colors.fg,
      "editor.selectionBackground": `${colors.constant}33`,
      "gitDecoration.addedResourceForeground": colors.tag,
      "gitDecoration.deletedResourceForeground": colors.keyword,
      "gitDecoration.modifiedResourceForeground": colors.entity,
    },
    tokenColors: [
      rule(["comment", "punctuation.definition.comment"], colors.comment),
      rule(["keyword", "storage"], colors.keyword),
      rule(["string", "punctuation.definition.string"], colors.string),
      rule(["constant", "support", "variable.language"], colors.constant),
      rule(["entity.name", "entity"], colors.entity),
      rule(["variable"], colors.variable),
      rule(["variable.other", "variable.parameter"], colors.fg),
      rule(["entity.name.tag"], colors.tag),
      rule(["meta.property-name", "support.type.property-name"], colors.constant),
      rule(["invalid", "markup.deleted"], colors.keyword),
      rule(["markup.inserted"], colors.tag),
      { scope: ["markup.heading"], settings: { foreground: colors.constant, fontStyle: "bold" } },
      { scope: ["markup.italic"], settings: { fontStyle: "italic" } },
      { scope: ["markup.bold"], settings: { fontStyle: "bold" } },
    ],
  };
}
