import { useEffect, useMemo, useRef, useState } from "react";
import type { UIEvent } from "react";

/** Extra rows above and below the viewport, so a fast scroll never shows a gap. */
const OVERSCAN_ROWS = 24;

export interface PlainTextViewProps {
  content: string;
  fontSize?: number;
  lineHeight?: number;
  fontFamily?: string;
  showLineNumbers?: boolean;
  className?: string;
}

/**
 * A read-only text view that renders only the rows on screen. It backs the
 * over-limit fallback and the error boundary's "open as plain text": a file
 * too big for the editor still has to be readable.
 */
export function PlainTextView({ content, fontSize = 12, lineHeight, fontFamily, showLineNumbers = false, className }: PlainTextViewProps) {
  const rowHeight = lineHeight ?? Math.round(fontSize * 1.5);
  const lines = useMemo(() => content.split("\n"), [content]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    setViewportHeight(element.clientHeight);
    const observer = new ResizeObserver(() => setViewportHeight(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
    setViewportHeight(event.currentTarget.clientHeight);
  };

  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN_ROWS);
  const last = Math.min(lines.length, Math.ceil((scrollTop + (viewportHeight || 800)) / rowHeight) + OVERSCAN_ROWS);
  const gutterWidth = showLineNumbers ? `${String(lines.length).length + 2}ch` : null;

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      data-testid="plain-text-view"
      className={className ?? "absolute inset-0 overflow-auto bg-background"}
      style={{ fontSize, fontFamily, lineHeight: `${rowHeight}px` }}
    >
      <div className="relative font-mono" style={{ height: lines.length * rowHeight, minWidth: "max-content" }}>
        {lines.slice(first, last).map((line, index) => {
          const number = first + index;
          return (
            <div
              key={number}
              className="absolute left-0 flex w-full whitespace-pre"
              style={{ top: number * rowHeight, height: rowHeight }}
            >
              {gutterWidth === null ? null : (
                <span
                  className="shrink-0 select-none pr-4 text-right text-muted-foreground"
                  style={{ width: gutterWidth }}
                >
                  {number + 1}
                </span>
              )}
              <span className="pl-3">{line === "" ? " " : line}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
