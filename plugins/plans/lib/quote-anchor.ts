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

/**
 * Normalized text around a selection, stored with the comment so a quote that
 * appears more than once can still be pinned to the place the reviewer chose.
 */
export interface QuoteContext {
  prefix?: string;
  suffix?: string;
  /** Offset of the quote in the normalized text when it was selected; a hint, verified before use. */
  position?: number;
}

export const CONTEXT_LENGTH = 48;

function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  let from = 0;
  while (from <= haystack.length) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    found.push(at);
    from = at + 1;
  }
  return found;
}

/** Characters of `expected` that line up with `actual`, read outward from the quote. */
function agreement(expected: string, actual: string, fromEnd: boolean): number {
  let count = 0;
  while (count < expected.length && count < actual.length) {
    const a = fromEnd ? expected[expected.length - 1 - count] : expected[count];
    const b = fromEnd ? actual[actual.length - 1 - count] : actual[count];
    if (a !== b) break;
    count += 1;
  }
  return count;
}

/**
 * Finds the quote in the index text. One occurrence is a match. Several are
 * ambiguous unless the stored context picks out exactly one: the recorded
 * position wins when the quote is still there (identical repeats), otherwise
 * the occurrence whose neighbours agree most with `prefix` and `suffix`, and a
 * tie stays ambiguous rather than guessing.
 */
export function matchQuote(indexText: string, quote: string, context: QuoteContext = {}): QuoteMatch {
  const needle = normalizeQuote(quote);
  if (needle.length === 0) return { kind: "missing" };
  const found = occurrences(indexText, needle);
  if (found.length === 0) return { kind: "missing" };
  if (found.length === 1) return { kind: "unique", start: found[0]!, end: found[0]! + needle.length };
  if (context.position !== undefined && found.includes(context.position)) {
    return { kind: "unique", start: context.position, end: context.position + needle.length };
  }
  const prefix = context.prefix ?? "";
  const suffix = context.suffix ?? "";
  if (prefix.length === 0 && suffix.length === 0) return { kind: "ambiguous", count: found.length };
  let best: { start: number; score: number } | null = null;
  let tied = false;
  for (const start of found) {
    const end = start + needle.length;
    const score =
      agreement(prefix, indexText.slice(Math.max(0, start - prefix.length), start), true) +
      agreement(suffix, indexText.slice(end, end + suffix.length), false);
    if (best === null || score > best.score) {
      best = { start, score };
      tied = false;
    } else if (score === best.score) tied = true;
  }
  if (best === null || tied || best.score === 0) return { kind: "ambiguous", count: found.length };
  return { kind: "unique", start: best.start, end: best.start + needle.length };
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
  return selectionForRange(index, range).quote;
}

/** The quote plus the text on either side, for re-anchoring repeated passages. */
export function selectionForRange(index: TextIndex, range: Range): { quote: string } & QuoteContext {
  let start = indexPositionFor(index, range.startContainer, range.startOffset);
  let end = indexPositionFor(index, range.endContainer, range.endOffset);
  if (start !== null && end !== null && end > start) {
    // The index text is already normalized; only edge spaces need trimming,
    // and the context must hug the trimmed quote or it will not line up.
    while (start < end && index.text[start] === " ") start += 1;
    while (end > start && index.text[end - 1] === " ") end -= 1;
    if (end > start) {
      return {
        quote: index.text.slice(start, end),
        prefix: index.text.slice(Math.max(0, start - CONTEXT_LENGTH), start),
        suffix: index.text.slice(end, end + CONTEXT_LENGTH),
        position: start,
      };
    }
  }
  return { quote: normalizeQuote(range.toString()) };
}
