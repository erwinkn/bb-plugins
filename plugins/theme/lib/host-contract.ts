/**
 * Every BB DOM or token contract `themes/color.css` depends on, anchored to
 * the BB source file that owns it and to strings that must appear in the
 * installed app bundle. `host-contract.test.ts` greps the bundle for them, so
 * a BB upgrade that renames a glyph, attribute, or token fails loudly here.
 *
 * Bundle strings are exact substrings of BB 0.43.1's minified frontend
 * (`app/dist/assets/*.js` and `*.css`); the minifier uses backtick strings.
 * When one fails, BB changed: read the named source file, then update both
 * `themes/color.css` and this list.
 */
export interface HostAnchor {
  /** BB source file (repo-relative) that owns the fact. */
  source: string;
  /** Which bundle files to search: frontend chunks, or the bundled provider plugins' server bundles. */
  bundle: "js" | "css" | "provider-plugins";
  /** Substrings that must all appear somewhere in those bundle files. */
  mustContain: readonly string[];
  /** What color.css paints from this fact. */
  because: string;
}

/**
 * Timeline leading glyphs color.css tints, keyed by the row kind that yields
 * them. The bundle strings pin the kind → glyph mapping, not only the name.
 */
export const TIMELINE_GLYPHS: readonly { glyph: string; role: string; mapping: string }[] = [
  { glyph: "FileText", role: "file", mapping: "case`file-read`:return`FileText`" },
  { glyph: "FileText", role: "file", mapping: "case`read`:return`FileText`" },
  { glyph: "Folder", role: "file", mapping: "case`list_files`:return`Folder`" },
  { glyph: "Search", role: "file", mapping: "case`search`:return`Search`" },
  { glyph: "File", role: "file", mapping: "case`image-view`:return`File`" },
  { glyph: "Terminal", role: "command", mapping: "case`command`:case`tool`:return`Terminal`" },
  { glyph: "Puzzle", role: "command", mapping: "case`extension`:return`Puzzle`" },
  { glyph: "Globe", role: "web", mapping: "case`web-fetch`:return`Globe`" },
  { glyph: "EditFile", role: "edit", mapping: "case`file-change`:return`EditFile`" },
  { glyph: "ListTodo", role: "attention", mapping: "case`plan-steps`:return`ListTodo`" },
  { glyph: "Zap", role: "attention", mapping: "return`Zap`" },
  { glyph: "Lock", role: "attention", mapping: "case`approval`:return`Lock`" },
  { glyph: "CircleQuestion", role: "attention", mapping: "case`question`:return`CircleQuestion`" },
  { glyph: "UserRoundPlus", role: "agent", mapping: "case`delegation`:return`UserRoundPlus`" },
  { glyph: "UserRound", role: "agent", mapping: "`UserRound`:`UserRoundPlus`" },
  { glyph: "AiBrain01", role: "thinking", mapping: "case`reasoning`:return`AiBrain01`" },
  { glyph: "AlertCircle", role: "error", mapping: "case`thread-interrupted`:return`AlertCircle`" },
];

/** Plan step icons color.css tints, keyed by `data-plan-step-status`. */
export const PLAN_STEP_GLYPHS: readonly { status: string; glyph: string }[] = [
  { status: "active", glyph: "Square" },
  { status: "completed", glyph: "Check" },
  { status: "failed", glyph: "X" },
];

/**
 * Agent provider ids `app.tsx` registers marks for that BB itself declares
 * (bundled provider plugins and the ACP presets). `acp-devin` is ours
 * (`plugins/devin`) and is not pinned here.
 */
export const BB_PROVIDER_IDS: readonly string[] = ["claude-code", "codex", "pi", "acp-cursor", "acp-grok", "acp-opencode", "acp-hermes-agent", "acp-omp"];

export const HOST_ANCHORS: readonly HostAnchor[] = [
  {
    source: "apps/app/src/components/plugin/ProviderIcon.tsx",
    bundle: "js",
    mustContain: ['"data-provider-logo":', ".providerIcons.push({providerKind:", "providerKind===`all`"],
    because: "Provider icons resolve a plugin `experimental_providerIcon` registration by kind and id before falling back to the masked logo; app.tsx registers agent marks through that slot.",
  },
  {
    source: "server/dist/builtin-plugins/provider-{claude-code,codex,pi,acp}",
    bundle: "provider-plugins",
    mustContain: BB_PROVIDER_IDS.map((id) => `"${id}"`),
    because: "The marks are keyed by these provider ids; a renamed or dropped bundled provider would leave a mark that never shows.",
  },
  {
    source: "apps/app/src/components/ui/markdown-code-highlight.css",
    bundle: "css",
    mustContain: [
      ".bb-code-highlight{--sh-space",
      ".dark .bb-code-highlight{",
      "--sh-keyword:",
      "--sh-string:",
      "--sh-class:",
      "--sh-property:",
      "--sh-entity:",
      "--sh-jsxliterals:",
    ],
    because: "Chat code blocks read the `--sh-*` palette scoped to `.bb-code-highlight`; color.css overrides those six tokens in both modes.",
  },
  {
    source: "packages/shared-ui/src/components/ui/icon.tsx",
    bundle: "js",
    mustContain: ['"data-icon":'],
    because: "Every host icon carries `data-icon=<name>`; all glyph tints key on it.",
  },
  {
    source: "apps/app/src/components/thread/timeline/ThreadTimelineRows.tsx",
    bundle: "js",
    mustContain: ['"data-timeline-row-id":'],
    because: "Glyph tints are scoped to timeline rows through `data-timeline-row-id`.",
  },
  {
    source: "apps/app/src/components/thread/timeline/TimelineRowHeader.tsx",
    bundle: "js",
    mustContain: ["size-3.5 shrink-0 text-muted-foreground"],
    because: "The leading glyph is a muted-foreground utility class; an attribute selector outranks it, so no `!important` is needed.",
  },
  {
    source: "packages/thread-view/src/timeline-work-row-glyph.ts",
    bundle: "js",
    mustContain: TIMELINE_GLYPHS.filter((entry) => !["AiBrain01", "UserRound", "AlertCircle"].includes(entry.glyph)).map((entry) => entry.mapping),
    because: "Work rows resolve their glyph per kind and exploration intent; the tints assume these names.",
  },
  {
    source: "apps/app/src/components/thread/timeline/ThreadTimelineRows.tsx (systemOperationLeadingIcon)",
    bundle: "js",
    mustContain: TIMELINE_GLYPHS.filter((entry) => ["AiBrain01", "UserRound", "AlertCircle"].includes(entry.glyph)).map((entry) => entry.mapping),
    because: "System rows (reasoning, parent change, interruption) resolve their glyph here.",
  },
  {
    source: "apps/app/src/components/thread/timeline/PresentationWorkRowBodies.tsx",
    bundle: "js",
    mustContain: ['"data-plan-step-status":', "pending:`Square`,active:`Square`,completed:`Check`,failed:`X`"],
    because: "Plan step rows expose their status and use Square/Check/X icons; color.css tints active, completed, and failed.",
  },
  {
    source: "apps/app/src/components/ui/theme.css (--pill-*) and apps/app/src/app.css (.prompt-mention-pill)",
    bundle: "css",
    mustContain: [
      "--pill-icon:",
      "--pill-foreground:",
      "--pill-surface:",
      "--pill-surface-border:",
      "--pill-surface-selected:",
      "--pill-surface-selected-border:",
      ".prompt-mention-pill{",
    ],
    because: "Mention pills paint themselves from the `--pill-*` tokens; color.css leans them purple.",
  },
  {
    source: "apps/app/src/components/ui/markdown-preview.tsx",
    bundle: "js",
    mustContain: [
      '"data-markdown-preview":``',
      "text-lg font-semibold text-foreground first:mt-0",
      "text-base font-semibold text-foreground first:mt-0",
    ],
    because: "Rendered Markdown carries `data-markdown-preview`; h1/h2 are `text-foreground` utilities that the heading accent overrides.",
  },
];
