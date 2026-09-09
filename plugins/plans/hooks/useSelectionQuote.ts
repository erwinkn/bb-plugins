import { useEffect, useRef, useState, type RefObject } from "react";
import { indexTextNodes, MAX_QUOTE_LENGTH, selectionForRange, type QuoteContext } from "../lib/quote-anchor";

export interface SelectionQuote extends QuoteContext {
  quote: string;
  /** Set when the selection exceeds the comment limit; it cannot be committed. */
  tooLong: boolean;
  /** Selection bounds relative to the scroll container's padding box. */
  rect: { top: number; left: number; width: number; height: number };
}

const MIN_QUOTE_LENGTH = 2;
/** iOS collapses the selection on touchend, before click; keep it briefly. */
const GRACE_MS = 700;

export interface SelectionQuoteState {
  selection: SelectionQuote | null;
  /** The latest selection, including one that collapsed within the grace period. */
  takeRecent: () => SelectionQuote | null;
}

/**
 * Reports a non-empty text selection made inside `contentRef`, with bounds
 * relative to `scrollRef` so a floating action can sit beside it. The quote
 * comes from the same text index used for anchoring, so it always re-matches.
 */
export function useSelectionQuote(
  scrollRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): SelectionQuoteState {
  const [current, setCurrent] = useState<SelectionQuote | null>(null);
  const recentRef = useRef<{ value: SelectionQuote; at: number } | null>(null);

  useEffect(() => {
    if (!enabled) {
      setCurrent(null);
      return;
    }
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (scroller === null || content === null) return;
    const doc = content.ownerDocument;
    let frame: number | null = null;
    let selecting = false;

    const read = () => {
      frame = null;
      if (selecting) return;
      const selection = doc.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        setCurrent(null);
        return;
      }
      const range = selection.getRangeAt(0);
      if (!content.contains(range.startContainer) || !content.contains(range.endContainer)) {
        setCurrent(null);
        return;
      }
      const { quote, prefix, suffix, position } = selectionForRange(indexTextNodes(content), range);
      if (quote.length < MIN_QUOTE_LENGTH) {
        setCurrent(null);
        return;
      }
      const bounds = range.getBoundingClientRect();
      const origin = scroller.getBoundingClientRect();
      const next: SelectionQuote = {
        quote,
        prefix,
        suffix,
        position,
        tooLong: quote.length > MAX_QUOTE_LENGTH,
        rect: {
          top: bounds.top - origin.top + scroller.scrollTop,
          left: bounds.left - origin.left + scroller.scrollLeft,
          width: bounds.width,
          height: bounds.height,
        },
      };
      recentRef.current = { value: next, at: Date.now() };
      setCurrent(next);
    };
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(read);
    };
    const startSelection = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !content.contains(event.target)) return;
      // A touch long-press hands the gesture to the system's selection UI and
      // iOS then delivers no pointerup or pointercancel, so waiting for the
      // release would hide the actions for good. Touch selections are read as
      // they change; only mouse and pen drags hide the actions until release.
      if (event.pointerType === "touch") return;
      selecting = true;
      recentRef.current = null;
      setCurrent(null);
    };
    const finishSelection = () => {
      if (!selecting) return;
      selecting = false;
      schedule();
    };
    // Some hosts cancel the browser's own word selection on a double-click
    // (a shell that prevents mousedown with detail > 1). Select the word under
    // the pointer ourselves when nothing is selected, then read as usual.
    const doubleClick = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || !content.contains(event.target)) return;
      selecting = false;
      const selection = doc.getSelection();
      if (selection && selection.isCollapsed) {
        const range = wordRangeAtPoint(doc, event.clientX, event.clientY, event.target);
        if (range !== null) {
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }
      schedule();
    };
    doc.addEventListener("pointerdown", startSelection);
    doc.addEventListener("dblclick", doubleClick);
    doc.addEventListener("pointerup", finishSelection);
    doc.addEventListener("pointercancel", finishSelection);
    doc.defaultView?.addEventListener("blur", finishSelection);
    doc.addEventListener("selectionchange", schedule);
    return () => {
      doc.removeEventListener("pointerdown", startSelection);
      doc.removeEventListener("dblclick", doubleClick);
      doc.removeEventListener("pointerup", finishSelection);
      doc.removeEventListener("pointercancel", finishSelection);
      doc.defaultView?.removeEventListener("blur", finishSelection);
      doc.removeEventListener("selectionchange", schedule);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [scrollRef, contentRef, enabled]);

  const takeRecent = () => {
    const candidate =
      current ??
      (recentRef.current !== null && Date.now() - recentRef.current.at <= GRACE_MS
        ? recentRef.current.value
        : null);
    return candidate !== null && !candidate.tooLong ? candidate : null;
  };

  return { selection: current, takeRecent };
}

export function clearDocumentSelection(node: Node | null): void {
  const doc = node?.ownerDocument ?? (typeof document === "undefined" ? null : document);
  doc?.getSelection()?.removeAllRanges();
}

/** The word around the caret under (x, y), or under the target's first text when the host has no caret API. */
function wordRangeAtPoint(doc: Document, x: number, y: number, target: Node): Range | null {
  let node: Node | null = null;
  let offset = 0;
  const caretDoc = doc as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (typeof caretDoc.caretPositionFromPoint === "function") {
    const caret = caretDoc.caretPositionFromPoint(x, y);
    if (caret) { node = caret.offsetNode; offset = caret.offset; }
  } else if (typeof caretDoc.caretRangeFromPoint === "function") {
    const caret = caretDoc.caretRangeFromPoint(x, y);
    if (caret) { node = caret.startContainer; offset = caret.startOffset; }
  }
  if (node === null || node.nodeType !== Node.TEXT_NODE) {
    const text = doc.createTreeWalker(target, NodeFilter.SHOW_TEXT).nextNode();
    if (text === null) return null;
    node = text; offset = 0;
  }
  const data = (node as Text).data;
  const isWord = (ch: string) => /[\p{L}\p{N}_'’-]/u.test(ch);
  let start = Math.min(offset, data.length);
  let end = start;
  if (start < data.length && !isWord(data[start]!)) {
    // Caret after the last letter of a word: step back into it.
    if (start > 0 && isWord(data[start - 1]!)) start -= 1; else return null;
    end = start;
  }
  while (start > 0 && isWord(data[start - 1]!)) start -= 1;
  while (end < data.length && isWord(data[end]!)) end += 1;
  if (end <= start) return null;
  const range = doc.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  return range;
}
