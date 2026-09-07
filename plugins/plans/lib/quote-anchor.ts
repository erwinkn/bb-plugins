/**
 * Locates a quoted passage inside rendered text without trusting positions:
 * a comment stores only the quote, and a quote that appears more than once
 * cannot be pinned to one place. Whitespace is collapsed and block boundaries
 * count as one space, on both the index and the quote, so a selection that
 * crossed a heading or list item still matches.
 */

export const MAX_QUOTE_LENGTH = 2000;

/** Collapses whitespace runs; length is checked by callers, never truncated. */
export function normalizeQuote(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export interface TextSegment {
  node: Text;
  /** Index in the normalized text where this text node starts. */
  start: number;
  /** Maps normalized index (relative to `start`) → offset inside `node`. */
  offsets: number[];
}

export interface TextIndex {
  text: string;
  segments: TextSegment[];
}

/** Elements whose start or end separates words the way rendering does. */
const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BR", "DD", "DETAILS", "DIV", "DL", "DT",
  "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6",
  "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "SUMMARY", "TABLE",
  "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
]);

/** Renderer chrome (copy buttons, hidden labels) is not part of the plan text. */
const SKIPPED_TAGS = new Set(["BUTTON", "SCRIPT", "STYLE", "TEXTAREA", "SELECT", "SVG", "TEMPLATE", "NOSCRIPT"]);

function isSkipped(element: Element): boolean {
  return (
    SKIPPED_TAGS.has(element.tagName.toUpperCase()) ||
    element.getAttribute("aria-hidden") === "true" ||
    element.hasAttribute("hidden") ||
    element.getAttribute("role") === "button" ||
    element.getAttribute("contenteditable") === "true"
  );
}

/**
 * Concatenates the text nodes under `root` into one whitespace-normalized
 * string and records enough to turn a normalized index back into a DOM
 * position, or a DOM position into a normalized index.
 */
export function indexTextNodes(root: Node): TextIndex {
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE && isSkipped(node as Element)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const segments: TextSegment[] = [];
  let text = "";
  let pendingSpace = false;
  let current = walker.nextNode();
  while (current !== null) {
    if (current.nodeType === Node.ELEMENT_NODE) {
      if (BLOCK_TAGS.has((current as Element).tagName.toUpperCase())) pendingSpace = text.length > 0;
      current = walker.nextNode();
      continue;
    }
    const node = current as Text;
    const raw = node.data;
    const offsets: number[] = [];
    let segmentStart = 0;
    let segmentHasContent = false;
    for (let i = 0; i < raw.length; i += 1) {
      const char = raw[i]!;
      if (/\s/.test(char)) {
        pendingSpace = text.length > 0;
        continue;
      }
      if (pendingSpace) {
        text += " ";
        pendingSpace = false;
        if (segmentHasContent) offsets.push(i);
      }
      if (!segmentHasContent) {
        segmentHasContent = true;
        segmentStart = text.length;
      }
      offsets.push(i);
      text += char;
    }
    if (segmentHasContent) segments.push({ node, start: segmentStart, offsets });
    current = walker.nextNode();
  }
  return { text, segments };
}

export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (from <= haystack.length) {
    const found = haystack.indexOf(needle, from);
    if (found === -1) break;
    count += 1;
    from = found + 1;
  }
  return count;
}

export type QuoteMatch =
  | { kind: "unique"; start: number; end: number }
  | { kind: "missing" }
  | { kind: "ambiguous"; count: number };

export function matchQuote(indexText: string, quote: string): QuoteMatch {
  const needle = normalizeQuote(quote);
  if (needle.length === 0) return { kind: "missing" };
  const count = countOccurrences(indexText, needle);
  if (count === 0) return { kind: "missing" };
  if (count > 1) return { kind: "ambiguous", count };
  const start = indexText.indexOf(needle);
  return { kind: "unique", start, end: start + needle.length };
}

export function sameMatch(a: QuoteMatch | undefined, b: QuoteMatch): boolean {
  if (a === undefined || a.kind !== b.kind) return false;
  if (a.kind === "unique" && b.kind === "unique") return a.start === b.start && a.end === b.end;
  if (a.kind === "ambiguous" && b.kind === "ambiguous") return a.count === b.count;
  return true;
}

function locate(index: TextIndex, position: number, endInclusive: boolean): { node: Text; offset: number } | null {
  for (const segment of index.segments) {
    const segmentEnd = segment.start + segment.offsets.length;
    if (position >= segment.start && position < segmentEnd) {
      const offset = segment.offsets[position - segment.start]!;
      return { node: segment.node, offset: endInclusive ? offset + 1 : offset };
    }
  }
  return null;
}

/** Builds a DOM Range for a unique match; null when the index cannot map it. */
export function rangeForMatch(index: TextIndex, start: number, end: number): Range | null {
  const from = locate(index, start, false);
  const to = locate(index, end - 1, true);
  if (from === null || to === null) return null;
  const doc = from.node.ownerDocument;
  if (doc === null) return null;
  const range = doc.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
}

/**
 * Normalized index of a DOM boundary. Text boundaries map through their
 * segment; element boundaries resolve to the first indexed text at or after
 * the child they point at. Null when nothing indexed follows the boundary.
 */
export function indexPositionFor(index: TextIndex, container: Node, offset: number): number | null {
  if (container.nodeType === Node.TEXT_NODE) {
    const segment = index.segments.find((candidate) => candidate.node === container);
    if (segment === undefined) return positionAfter(index, container);
    let count = 0;
    while (count < segment.offsets.length && segment.offsets[count]! < offset) count += 1;
    return segment.start + count;
  }
  const child = container.childNodes[offset] ?? null;
  if (child === null) {
    // Boundary after the last child: the first indexed text following `container`.
    let after: Node | null = container;
    while (after !== null && after.nextSibling === null) after = after.parentNode;
    return after?.nextSibling ? positionAtOrAfter(index, after.nextSibling) : index.text.length;
  }
  return positionAtOrAfter(index, child);
}

function positionAtOrAfter(index: TextIndex, node: Node): number | null {
  for (const segment of index.segments) {
    const relation = node.compareDocumentPosition(segment.node);
    if (
      segment.node === node ||
      relation & Node.DOCUMENT_POSITION_CONTAINED_BY ||
      relation & Node.DOCUMENT_POSITION_FOLLOWING
    ) {
      return segment.start;
    }
  }
  return index.text.length;
}

function positionAfter(index: TextIndex, node: Node): number | null {
  for (const segment of index.segments) {
    if (node.compareDocumentPosition(segment.node) & Node.DOCUMENT_POSITION_FOLLOWING) return segment.start;
  }
  return index.text.length;
}

/**
 * The quote for a selection range, taken from the index so that it is
 * guaranteed to be found again. Falls back to the range's own text when the
 * boundaries cannot be mapped.
 */
export function quoteForRange(index: TextIndex, range: Range): string {
  const start = indexPositionFor(index, range.startContainer, range.startOffset);
  const end = indexPositionFor(index, range.endContainer, range.endOffset);
  if (start !== null && end !== null && end > start) {
    const quote = normalizeQuote(index.text.slice(start, end));
    if (quote.length > 0) return quote;
  }
  return normalizeQuote(range.toString());
}
