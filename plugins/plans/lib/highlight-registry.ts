/**
 * Comment anchors are painted with the CSS Custom Highlight API so the host's
 * rendered Markdown DOM is never mutated. Highlight names are document-global,
 * so every mounted document contributes its ranges to the shared entries: one
 * per annotation kind, plus an emphasized variant for the active or hovered
 * comment. Browsers without the API simply show no anchors; comment cards
 * still quote.
 */

export const HIGHLIGHT_NAME = "plans-comment";
export const ACTIVE_HIGHLIGHT_NAME = "plans-comment-active";

export type HighlightKind = "comment" | "redline" | "looksGood";

export interface HighlightEntry {
  range: Range;
  kind: HighlightKind;
  /** Active or hovered: painted stronger, above the resting highlights. */
  emphasized: boolean;
}

const NAMES: Record<HighlightKind, { rest: string; emphasis: string }> = {
  comment: { rest: HIGHLIGHT_NAME, emphasis: ACTIVE_HIGHLIGHT_NAME },
  redline: { rest: "plans-redline", emphasis: "plans-redline-active" },
  looksGood: { rest: "plans-looks-good", emphasis: "plans-looks-good-active" },
};

type HighlightLike = { add(range: AbstractRange): void; clear(): void; priority?: number };
type HighlightRegistry = {
  set(name: string, highlight: HighlightLike): void;
  delete(name: string): void;
};
type HighlightConstructor = new (...ranges: AbstractRange[]) => HighlightLike;

function api(): { registry: HighlightRegistry; Highlight: HighlightConstructor } | null {
  if (typeof globalThis === "undefined") return null;
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const ctor = (globalThis as { Highlight?: HighlightConstructor }).Highlight;
  if (!css?.highlights || typeof ctor !== "function") return null;
  return { registry: css.highlights, Highlight: ctor };
}

export const supportsHighlights = (): boolean => api() !== null;

const owners = new Map<string, HighlightEntry[]>();

function repaint(): void {
  const current = api();
  if (current === null) return;
  const groups = new Map<string, Range[]>();
  for (const { rest, emphasis } of Object.values(NAMES)) {
    groups.set(rest, []);
    groups.set(emphasis, []);
  }
  for (const entries of owners.values()) {
    for (const entry of entries) {
      const names = NAMES[entry.kind];
      groups.get(entry.emphasized ? names.emphasis : names.rest)!.push(entry.range);
    }
  }
  for (const [name, ranges] of groups) {
    const highlight = new current.Highlight(...ranges);
    // An emphasized passage paints over any resting highlight it overlaps.
    if (name.endsWith("-active")) highlight.priority = 1;
    current.registry.set(name, highlight);
  }
}

export function setHighlightRanges(ownerId: string, entries: HighlightEntry[]): void {
  owners.set(ownerId, entries);
  repaint();
}

export function clearHighlightRanges(ownerId: string): void {
  owners.delete(ownerId);
  repaint();
}
