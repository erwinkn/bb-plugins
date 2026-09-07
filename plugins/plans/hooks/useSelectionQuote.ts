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
      const { quote, prefix, suffix } = selectionForRange(indexTextNodes(content), range);
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
      selecting = true;
      recentRef.current = null;
      setCurrent(null);
    };
    const finishSelection = () => {
      if (!selecting) return;
      selecting = false;
      schedule();
    };
    doc.addEventListener("pointerdown", startSelection);
    doc.addEventListener("pointerup", finishSelection);
    doc.addEventListener("pointercancel", finishSelection);
    doc.defaultView?.addEventListener("blur", finishSelection);
    doc.addEventListener("selectionchange", schedule);
    return () => {
      doc.removeEventListener("pointerdown", startSelection);
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
