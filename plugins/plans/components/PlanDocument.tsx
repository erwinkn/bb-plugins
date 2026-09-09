import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icon";
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
  type HighlightEntry,
} from "../lib/highlight-registry";
import { stateLabel } from "../lib/plan-model";
import { KindBadge, kindOf } from "./CommentKind";
import {
  definedContext,
  indexTextNodes,
  MAX_QUOTE_LENGTH,
  matchQuote,
  rangeForMatch,
  sameMatch,
  type QuoteContext,
  type QuoteMatch,
} from "../lib/quote-anchor";

export type AnchorMap = Record<string, QuoteMatch>;

interface PlanDocumentProps {
  markdown: string;
  versionId?: string;
  /** Tab visibility controls interaction, never the lifetime of the text index. */
  visible?: boolean;
  comments: PlanComment[];
  activeCommentId: string | null;
  /** Comment under the pointer, in the document or in the rail. */
  hoveredCommentId?: string | null;
  onHoverComment?: (commentId: string | null) => void;
  canComment: boolean;
  /** Quote being composed; its match is reported so the composer can warn. */
  pendingQuote: string | null;
  pendingKind?: "comment" | "ask";
  /** Where the pending quote was selected, for a passage that repeats. */
  pendingContext?: QuoteContext;
  onPendingMatch: (match: QuoteMatch | null) => void;
  /**
   * Composer for the pending quote. It floats beside the passage when the
   * quote anchors, and at the top of the document when it does not.
   */
  composer?: ReactNode;
  /** The user asked to comment on the current selection. */
  onQuote: (quote: string, context: QuoteContext, kind?: "comment" | "ask") => void;
  onAnnotate?: (quote: string, kind: "redline" | "looksGood", context: QuoteContext) => Promise<void>;
  onActivateComment: (commentId: string | null) => void;
  /** Where each comment's quote was found; lets cards explain missing anchors. */
  onAnchorsChange: (anchors: AnchorMap) => void;
  className?: string;
}

// Five rows plus gaps, separator, padding, border, and space above the quote.
const FLOATING_OFFSET = 190;
const FLOATING_EDGE = 90;
const COMPOSER_WIDTH = 320;
const COMPOSER_MARGIN = 8;
const COMPOSER_ARROW = 8;
const TOOLTIP_WIDTH = 280;

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
  versionId,
  visible = true,
  comments,
  activeCommentId,
  hoveredCommentId = null,
  onHoverComment,
  canComment,
  pendingQuote,
  pendingKind = "comment",
  pendingContext,
  onPendingMatch,
  composer,
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
      if (comment.state === "withdrawn") continue;
      const match = matchQuote(index.text, comment.quote, {
        prefix: comment.prefix, suffix: comment.suffix,
        ...(comment.versionId === versionId ? { position: comment.position } : {}),
      });
      anchors[comment.id] = match;
      if (match.kind === "unique") {
        const range = rangeForMatch(index, match.start, match.end);
        if (range !== null) ranges.set(comment.id, range);
      }
    }
    rangesRef.current = ranges;
    // The selection clears once the composer opens; keep the passage painted
    // so the author still sees what the comment is about.
    const pendingMatch = pendingQuote === null ? null : matchQuote(index.text, pendingQuote, pendingContext);
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
  }, [comments, versionId, onAnchorsChange, onPendingMatch, pendingQuote, pendingContext?.prefix, pendingContext?.suffix, pendingContext?.position]);

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

  // The composer sits at coordinates read from the DOM; recompute on resize.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => forceRepaint((n) => n + 1));
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  // Paint anchors; the active or hovered comment gets the emphasized tier of
  // its kind.
  useEffect(() => {
    if (!supportsHighlights()) return;
    const entries: HighlightEntry[] = [];
    for (const comment of comments) {
      if (comment.state === "withdrawn") continue;
      const range = rangesRef.current.get(comment.id);
      if (range === undefined) continue;
      entries.push({
        range,
        kind: comment.kind ?? "comment",
        emphasized: comment.id === activeCommentId || comment.id === hoveredCommentId,
      });
    }
    if (pendingRangeRef.current !== null) entries.push({ range: pendingRangeRef.current, kind: pendingKind, emphasized: true });
    setHighlightRanges(ownerId, entries);
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

  const commentAtPoint = (doc: Document, x: number, y: number): string | null => {
    if (rangesRef.current.size === 0) return null;
    const point = caretFromPoint(doc, x, y);
    if (point === null) return null;
    for (const [commentId, range] of rangesRef.current) {
      if (range.isPointInRange(point.node, point.offset)) return commentId;
    }
    return null;
  };

  // Hover follows the same hit test as click; throttled to a frame because
  // caretPositionFromPoint is not free on long documents.
  const hoverFrame = useRef<number | null>(null);
  // Only a hover that started in the document shows the tooltip; a hovered
  // rail card already shows its own text.
  const [pointerHoverId, setPointerHoverId] = useState<string | null>(null);
  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!onHoverComment || isCoarse || event.pointerType === "touch") return;
    if (hoverFrame.current !== null) return;
    const { clientX, clientY, currentTarget } = event;
    hoverFrame.current = requestAnimationFrame(() => {
      hoverFrame.current = null;
      const live = currentTarget.ownerDocument.getSelection();
      if (live && !live.isCollapsed) return;
      const id = commentAtPoint(currentTarget.ownerDocument, clientX, clientY);
      setPointerHoverId(id);
      onHoverComment(id);
    });
  };
  const handlePointerLeave = () => {
    if (hoverFrame.current !== null) {
      cancelAnimationFrame(hoverFrame.current);
      hoverFrame.current = null;
    }
    setPointerHoverId(null);
    onHoverComment?.(null);
  };

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
  const commitQuote = (kind?: "ask" | "redline" | "looksGood") => {
    const recent = takeRecent();
    if (recent === null) return;
    const context = definedContext(recent);
    if (kind && kind !== "ask" && onAnnotate) void onAnnotate(recent.quote, kind, context);
    else if (kind === "ask") onQuote(recent.quote, context, "ask");
    else onQuote(recent.quote, context);
    clearDocumentSelection(contentRef.current);
  };
  const commitProps = (kind?: "ask" | "redline" | "looksGood") => ({
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

  // The menu replaces the browser's own selection affordances on desktop, so
  // it carries the one everybody expects as well.
  const copySelection = async () => {
    const recent = takeRecent();
    if (recent === null) return;
    try {
      await navigator.clipboard.writeText(recent.quote);
      toast.success("Copied");
    } catch {
      toast.error("Could not copy to the clipboard");
    }
    clearDocumentSelection(contentRef.current);
  };
  const copyProps = {
    onPointerDown: (event: React.PointerEvent) => {
      event.preventDefault();
      void copySelection();
    },
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        void copySelection();
      }
    },
  };

  interface SelectionAction { label: string; icon: IconName; key: string; className: string; props: typeof copyProps }
  const actions: SelectionAction[] = [
    { label: "Comment", icon: "MessageSquarePlus", key: "C", className: "", props: commitProps() },
    { label: "Ask", icon: "MessageSquare", key: "A", className: "text-primary", props: commitProps("ask") },
    ...(onAnnotate
      ? [
          { label: "Redline", icon: "Strikethrough", key: "D", className: "text-destructive", props: commitProps("redline") } satisfies SelectionAction,
          { label: "Looks good", icon: "CircleCheck", key: "G", className: "text-success", props: commitProps("looksGood") } satisfies SelectionAction,
        ]
      : []),
  ];

  // Desktop: a popover beside the selection, with shortcuts.
  const selectionMenu = (
    <div role="toolbar" aria-label="Annotate selection" className="pointer-events-auto flex w-40 flex-col items-stretch gap-0.5 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg">
      {actions.map((action) => (
        <Button key={action.label} type="button" variant="ghost" size="sm" className={cn("h-8 justify-between rounded-md px-2 text-xs", action.className)} {...action.props}>
          {action.label}
          <kbd className="ml-3 text-[10px] opacity-60">{action.key}</kbd>
        </Button>
      ))}
      <div role="separator" className="my-0.5 border-t border-border" />
      <Button type="button" variant="ghost" size="sm" className="h-8 justify-between rounded-md px-2 text-xs" {...copyProps}>
        Copy
        <kbd className="ml-3 text-[10px] opacity-60">⌘C</kbd>
      </Button>
    </div>
  );

  // Touch: the system callout owns the space around the selection, so the
  // actions dock along the bottom edge of the document as a toolbar. Copy is
  // left to the callout, which already offers it.
  const barButton = (label: string, icon: IconName, className: string, props: typeof copyProps) => (
    <button key={label} type="button" className={cn("flex h-12 min-w-0 flex-col items-center justify-center gap-1 px-1 text-xs leading-none active:bg-state-active", className)} {...props}>
      <Icon name={icon} className="size-4 shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
    </button>
  );
  const selectionBar = (
    <div role="toolbar" aria-label="Annotate selection" className="pointer-events-auto grid w-full auto-cols-fr grid-flow-col border-t border-border bg-popover text-popover-foreground shadow-[0_-4px_12px_-6px_rgb(0_0_0/0.25)]">
      {actions.map((action) => barButton(action.label, action.icon, action.className, action.props))}
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
      if (!["c", "a", "d", "g"].includes(key) || (key !== "c" && key !== "a" && !onAnnotate)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const live = doc.getSelection();
      if (!live || live.isCollapsed || live.rangeCount === 0) return;
      if (!content.contains(live.getRangeAt(0).commonAncestorContainer)) return;
      event.preventDefault();
      commitQuote(key === "a" ? "ask" : key === "d" ? "redline" : key === "g" ? "looksGood" : undefined);
    };
    doc.addEventListener("keydown", onKeyDown);
    return () => doc.removeEventListener("keydown", onKeyDown);
  });

  const composerPosition = composerPlacement(pendingRangeRef.current, scrollRef.current);
  const hovered =
    hoveredCommentId === null || hoveredCommentId !== pointerHoverId || isCoarse
      ? null
      : comments.find((comment) => comment.id === hoveredCommentId) ?? null;
  const hoverPosition =
    hovered === null ? null : composerPlacement(rangesRef.current.get(hovered.id) ?? null, scrollRef.current, TOOLTIP_WIDTH);
  const showComposer = visible && composer !== undefined && pendingQuote !== null;
  const composerRef = useRef<HTMLDivElement>(null);
  // A quote near the bottom edge would push its composer out of view.
  useEffect(() => {
    if (!showComposer) return;
    composerRef.current?.scrollIntoView({ block: "nearest" });
  }, [showComposer, pendingQuote]);

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
        // BB's mobile panel shell is select-none; WebKit then blocks both text
        // selection and custom highlight painting in the subtree, so opt back in.
        className="plans-document relative min-h-0 flex-1 select-text overflow-y-auto overscroll-contain"
      >
        <div
          ref={contentRef}
          onClick={handleClick}
          onPointerMove={handlePointerMove}
          onPointerLeave={handlePointerLeave}
          className={cn(
            "w-full px-4 pb-24 pt-5 md:pt-6",
            canComment && "cursor-text",
          )}
        >
          <Markdown content={markdown} />
        </div>
        {visible && hovered !== null && hoverPosition !== null && pendingQuote === null ? (
          <CommentTooltip comment={hovered} position={hoverPosition} />
        ) : null}
        {showComposer && composerPosition !== null ? (
          <div
            ref={composerRef}
            role="dialog"
            aria-label={pendingKind === "ask" ? "New ask" : "New comment"}
            className="absolute z-20 animate-in fade-in-0 zoom-in-95 duration-150"
            style={{ top: composerPosition.top, left: composerPosition.left, width: COMPOSER_WIDTH }}
          >
            <span
              aria-hidden
              className="absolute -top-1 size-2 rotate-45 border-l border-t border-border bg-popover"
              style={{ left: composerPosition.arrowLeft - 4 }}
            />
            <div className="rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg">
              {composer}
            </div>
          </div>
        ) : null}
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
              selectionMenu
            )}
          </div>
        ) : null}
      </div>
      {showComposer && composerPosition === null ? (
        <div
          ref={composerRef}
          role="dialog"
          aria-label={pendingKind === "ask" ? "New ask" : "New comment"}
          className="absolute inset-x-0 top-2 z-20 mx-auto animate-in fade-in-0 zoom-in-95 duration-150"
          style={{ width: COMPOSER_WIDTH, maxWidth: "calc(100% - 16px)" }}
        >
          <div className="rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg">
            {composer}
          </div>
        </div>
      ) : null}
      {showBar ? (
        <div className="absolute inset-x-0 bottom-0 z-10 animate-in slide-in-from-bottom-2 fade-in-0 duration-150">
          {tooLong ? (
            <span role="status" className="flex h-11 w-full items-center justify-center gap-2 border-t border-border bg-popover px-4 text-sm text-muted-foreground">
              <Icon name="AlertCircle" className="size-4 shrink-0" aria-hidden />
              <span className="truncate">{limitLabel}</span>
            </span>
          ) : (
            selectionBar
          )}
        </div>
      ) : null}
    </div>
  );
}

/** What the hovered passage says, shown under it without stealing the pointer. */
function CommentTooltip({ comment, position }: { comment: PlanComment; position: { top: number; left: number; arrowLeft: number } }) {
  const kind = kindOf(comment);
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-10 animate-in fade-in-0 duration-100"
      style={{ top: position.top, left: position.left, width: TOOLTIP_WIDTH }}
    >
      <span
        aria-hidden
        className="absolute -top-1 size-2 rotate-45 border-l border-t border-border bg-popover"
        style={{ left: position.arrowLeft - 4 }}
      />
      <div className="space-y-1 rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <KindBadge kind={kind} />
          {kind === "comment" || comment.body ? <span>{stateLabel(comment)}</span> : null}
        </div>
        {comment.body ? <p className="whitespace-pre-wrap break-words leading-5">{comment.body}</p> : null}
      </div>
    </div>
  );
}

/**
 * Where the composer sits relative to the scroller's padding box: just under
 * the pending passage, with its arrow at the passage's horizontal centre.
 */
function composerPlacement(
  range: Range | null,
  scroller: HTMLElement | null,
  width = COMPOSER_WIDTH,
): { top: number; left: number; arrowLeft: number } | null {
  if (range === null || scroller === null) return null;
  const bounds = range.getBoundingClientRect();
  if (bounds.width === 0 && bounds.height === 0) return null;
  const origin = scroller.getBoundingClientRect();
  const rects = range.getClientRects();
  const last = rects.length > 0 ? rects[rects.length - 1] : bounds;
  const center = last.left + last.width / 2 - origin.left + scroller.scrollLeft;
  const available = scroller.clientWidth;
  const left = clamp(
    center - width / 2,
    COMPOSER_MARGIN,
    Math.max(COMPOSER_MARGIN, available - width - COMPOSER_MARGIN),
  );
  return {
    top: bounds.bottom - origin.top + scroller.scrollTop + COMPOSER_ARROW + 2,
    left,
    arrowLeft: clamp(center - left, 16, width - 16),
  };
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
