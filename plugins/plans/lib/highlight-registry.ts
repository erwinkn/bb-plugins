/**
 * Comment anchors are painted with the CSS Custom Highlight API so the host's
 * rendered Markdown DOM is never mutated. Highlight names are document-global,
 * so every mounted document contributes its ranges to two shared entries.
 * Browsers without the API simply show no anchors; comment cards still quote.
 */

export const HIGHLIGHT_NAME = "plans-comment";
export const ACTIVE_HIGHLIGHT_NAME = "plans-comment-active";

type HighlightLike = { add(range: AbstractRange): void; clear(): void };
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

const owners = new Map<string, { ranges: Range[]; active: Range[]; redlines: Range[]; positives: Range[] }>();

function repaint(): void {
  const current = api();
  if (current === null) return;
  const all: Range[] = [];
  const active: Range[] = [];
  const redlines: Range[] = [];
  const positives: Range[] = [];
  for (const entry of owners.values()) {
    all.push(...entry.ranges);
    active.push(...entry.active);
    redlines.push(...entry.redlines);
    positives.push(...entry.positives);
  }
  current.registry.set("plans-redline", new current.Highlight(...redlines));
  current.registry.set("plans-looks-good", new current.Highlight(...positives));
  current.registry.set(HIGHLIGHT_NAME, new current.Highlight(...all));
  current.registry.set(ACTIVE_HIGHLIGHT_NAME, new current.Highlight(...active));
}

export function setHighlightRanges(ownerId: string, ranges: Range[], active: Range[], redlines: Range[] = [], positives: Range[] = []): void {
  owners.set(ownerId, { ranges, active, redlines, positives });
  repaint();
}

export function clearHighlightRanges(ownerId: string): void {
  owners.delete(ownerId);
  repaint();
}
