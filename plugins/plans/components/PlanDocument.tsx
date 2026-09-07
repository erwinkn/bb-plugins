import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { usePointerCoarse } from "@/components/ui/hooks/use-pointer-coarse";
import { cn } from "@/lib/utils";
import type { PlanComment } from "../contract";
import {
  clearDocumentSelection,
  useSelectionQuote,
} from "../hooks/useSelectionQuote";
import {
  clearHighlightRanges,
  setHighlightRanges,
  supportsHighlights,
} from "../lib/highlight-registry";
import {
  indexTextNodes,
  MAX_QUOTE_LENGTH,
  matchQuote,
  rangeForMatch,
  sameMatch,
  type QuoteMatch,
} from "../lib/quote-anchor";

export type AnchorMap = Record<string, QuoteMatch>;

interface PlanDocumentProps {
  markdown: string;
  /** Tab visibility controls interaction, never the lifetime of the text index. */
  visible?: boolean;
  comments: PlanComment[];
  activeCommentId: string | null;
  canComment: boolean;
  /** Quote being composed; its match is reported so the composer can warn. */
  pendingQuote: string | null;
  onPendingMatch: (match: QuoteMatch | null) => void;
  /** The user asked to comment on the current selection. */
  onQuote: (quote: string) => void;
  onAnnotate?: (quote: string, kind: "redline" | "looksGood") => Promise<void>;
  onActivateComment: (commentId: string | null) => void;
  /** Where each comment's quote was found; lets cards explain missing anchors. */
  onAnchorsChange: (anchors: AnchorMap) => void;
  className?: string;
}

const FLOATING_OFFSET = 116;
const FLOATING_EDGE = 90;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * The rendered plan. It owns text selection → "Comment" affordance, paints
 * each comment's quote through the highlight registry, and answers clicks on
 * a painted quote by activating that comment. Nothing here mutates the host
 * Markdown DOM.
 */
export function PlanDocument({
  markdown,
  visible = true,
  comments,
  activeCommentId,
  canComment,
  pendingQuote,
  onPendingMatch,
  onQuote,
  onAnnotate,
  onActivateComment,
  onAnchorsChange,
  className,
}: PlanDocumentProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const ownerId = useId();
  const isCoarse = usePointerCoarse();
  const isMobile = useIsCompactViewport() || isCoarse;
  const { selection, takeRecent } = useSelectionQuote(scrollRef, contentRef, canComment && visible);
  const rangesRef = useRef<Map<string, Range>>(new Map());
  const pendingRangeRef = useRef<Range | null>(null);
  const anchorsRef = useRef<AnchorMap>({});
  const [, forceRepaint] = useState(0);

  // Re-anchor whenever the markdown, the comments, or the rendered DOM change.
  const anchor = useCallback(() => {
    const content = contentRef.current;
    if (content === null) return;
    const index = indexTextNodes(content);
    const anchors: AnchorMap = {};
    const ranges = new Map<string, Range>();
    for (const comment of comments) {
      const match = matchQuote(index.text, comment.quote);
      anchors[comment.id] = match;
      if (match.kind === "unique") {
        const range = rangeForMatch(index, match.start, match.end);
        if (range !== null) ranges.set(comment.id, range);
      }
    }
    rangesRef.current = ranges;
    // The selection clears once the composer opens; keep the passage painted
    // so the author still sees what the comment is about.
    const pendingMatch = pendingQuote === null ? null : matchQuote(index.text, pendingQuote);
    pendingRangeRef.current =
      pendingMatch?.kind === "unique" ? rangeForMatch(index, pendingMatch.start, pendingMatch.end) : null;
    forceRepaint((n) => n + 1);
    onPendingMatch(pendingMatch);
    // Notify only on a real change: a consumer may pass a fresh comments array
    // every render, and a new anchors object each time would loop.
    const previous = anchorsRef.current;
    const changed =
      Object.keys(previous).length !== Object.keys(anchors).length ||
      Object.entries(anchors).some(([id, match]) => !sameMatch(previous[id], match));
    if (changed) {
      anchorsRef.current = anchors;
      onAnchorsChange(anchors);
    }
  }, [comments, onAnchorsChange, onPendingMatch, pendingQuote]);

  useLayoutEffect(() => {
    anchor();
  }, [anchor, markdown]);

  useEffect(() => {
    const content = contentRef.current;
    if (content === null) return;
    let frame: number | null = null;
    const observer = new MutationObserver(() => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        anchor();
      });
    });
    observer.observe(content, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [anchor]);

  // Paint anchors; unresolved comments read stronger than resolved ones.
  useEffect(() => {
    if (!supportsHighlights()) return;
    const ranges: Range[] = [];
    const active: Range[] = [];
    const redlines: Range[] = [];
    const positives: Range[] = [];
    for (const comment of comments) {
      const range = rangesRef.current.get(comment.id);
      if (range === undefined) continue;
      if (!comment.resolved && comment.kind === "redline") redlines.push(range);
      else if (!comment.resolved && comment.kind === "looksGood") positives.push(range);
      else if (comment.id === activeCommentId) active.push(range);
      else if (!comment.resolved) ranges.push(range);
    }
    if (pendingRangeRef.current !== null) active.push(pendingRangeRef.current);
    setHighlightRanges(ownerId, ranges, active, redlines, positives);
    return () => clearHighlightRanges(ownerId);
  });

  // Bring the active comment's quote into view when the rail selects it.
  useEffect(() => {
    if (!visible || activeCommentId === null) return;
    const range = rangesRef.current.get(activeCommentId);
    const scroller = scrollRef.current;
    if (range === undefined || scroller === null) return;
    const bounds = range.getBoundingClientRect();
    const origin = scroller.getBoundingClientRect();
    const target = bounds.top - origin.top + scroller.scrollTop - origin.height / 3;
    scroller.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }, [activeCommentId, visible, markdown]);

  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (rangesRef.current.size === 0) return;
    const doc = event.currentTarget.ownerDocument;
    // A drag-select that ends over a highlight also fires click; leave the
    // new selection alone instead of jumping to the old comment.
    const live = doc.getSelection();
    if (live && !live.isCollapsed) return;
    const point = caretFromPoint(doc, event.clientX, event.clientY);
    if (point === null) return;
    for (const [commentId, range] of rangesRef.current) {
      if (range.isPointInRange(point.node, point.offset)) {
        onActivateComment(commentId);
        return;
      }
    }
  };

  // Commit on pointerdown: on touch devices the selection collapses before
  // click fires, and the grace period in the hook covers the rest.
  const commitQuote = (kind?: "redline" | "looksGood") => {
    const recent = takeRecent();
    if (recent === null) return;
    if (kind && onAnnotate) void onAnnotate(recent.quote, kind);
    else onQuote(recent.quote);
    clearDocumentSelection(contentRef.current);
  };
  const commitProps = (kind?: "redline" | "looksGood") => ({
    onPointerDown: (event: React.PointerEvent) => {
      event.preventDefault();
      commitQuote(kind);
    },
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        commitQuote(kind);
      }
    },
  });

  const selectionActions = (mobile: boolean) => (
    <div role="toolbar" aria-label="Annotate selection" className="pointer-events-auto flex w-40 flex-col items-stretch gap-0.5 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg">
      <Button type="button" variant="ghost" size="sm" className="h-8 justify-between rounded-md px-2 text-xs" {...commitProps()}>Comment{mobile ? null : <kbd className="ml-3 text-[10px] opacity-60">C</kbd>}</Button>
      {onAnnotate ? <>
        <Button type="button" variant="ghost" size="sm" className="h-8 justify-between rounded-md px-2 text-xs text-destructive" {...commitProps("redline")}>Redline{mobile ? null : <kbd className="ml-3 text-[10px] opacity-60">D</kbd>}</Button>
        <Button type="button" variant="ghost" size="sm" className="h-8 justify-between rounded-md px-2 text-xs text-success" {...commitProps("looksGood")}>Looks good{mobile ? null : <kbd className="ml-3 text-[10px] opacity-60">G</kbd>}</Button>
      </> : null}
    </div>
  );

  // Keyboard path: with text selected in the plan, C opens the composer.
  useEffect(() => {
    if (!canComment || !visible) return;
    const content = contentRef.current;
    if (content === null) return;
    const doc = content.ownerDocument;
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (!["c", "d", "g"].includes(key) || (key !== "c" && !onAnnotate)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const live = doc.getSelection();
      if (!live || live.isCollapsed || live.rangeCount === 0) return;
      if (!content.contains(live.getRangeAt(0).commonAncestorContainer)) return;
      event.preventDefault();
      commitQuote(key === "d" ? "redline" : key === "g" ? "looksGood" : undefined);
    };
    doc.addEventListener("keydown", onKeyDown);
    return () => doc.removeEventListener("keydown", onKeyDown);
  });

  const showFloating = visible && selection !== null && !isCoarse;
  const showBar = visible && selection !== null && isCoarse;
  const tooLong = selection?.tooLong === true;
  const limitLabel = `Selection too long (max ${MAX_QUOTE_LENGTH.toLocaleString()} characters)`;
  const floatingLeft =
    selection === null
      ? 0
      : clamp(
          selection.rect.left + selection.rect.width / 2,
          FLOATING_EDGE,
          Math.max(FLOATING_EDGE, (scrollRef.current?.clientWidth ?? 0) - FLOATING_EDGE),
        );

  return (
    <div className={cn("relative flex min-h-0 flex-1 flex-col", className)}>
      <div
        ref={scrollRef}
        className="plans-document relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <div
          ref={contentRef}
          onClick={handleClick}
          className={cn(
            "mx-auto w-full max-w-3xl px-4 pb-24 pt-5 md:px-8 md:pt-6",
            canComment && "cursor-text",
          )}
        >
          <Markdown content={markdown} />
        </div>
        {showFloating ? (
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 animate-in fade-in-0 zoom-in-95 duration-150"
            style={{
              top: Math.max(8, selection.rect.top - FLOATING_OFFSET),
              left: floatingLeft,
            }}
          >
            {tooLong ? (
              <span role="status" className="pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-popover px-3 text-xs text-muted-foreground shadow-md">
                <Icon name="AlertCircle" className="size-3.5" aria-hidden />
                {limitLabel}
              </span>
            ) : (
              selectionActions(isMobile)
            )}
          </div>
        ) : null}
      </div>
      {showBar ? (
        <div className="absolute inset-x-0 bottom-0 z-10 flex justify-center p-3 animate-in slide-in-from-bottom-2 fade-in-0 duration-150">
          {tooLong ? (
            <span role="status" className="inline-flex h-10 w-full max-w-sm items-center justify-center gap-2 rounded-full border border-border bg-popover px-4 text-sm text-muted-foreground shadow-lg">
              <Icon name="AlertCircle" className="size-4 shrink-0" aria-hidden />
              <span className="truncate">{limitLabel}</span>
            </span>
          ) : (
            selectionActions(true)
          )}
        </div>
      ) : null}
    </div>
  );
}

function caretFromPoint(
  doc: Document,
  x: number,
  y: number,
): { node: Node; offset: number } | null {
  const withPosition = doc as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (typeof withPosition.caretPositionFromPoint === "function") {
    const position = withPosition.caretPositionFromPoint(x, y);
    return position ? { node: position.offsetNode, offset: position.offset } : null;
  }
  const withRange = doc as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
  if (typeof withRange.caretRangeFromPoint === "function") {
    const range = withRange.caretRangeFromPoint(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }
  return null;
}
