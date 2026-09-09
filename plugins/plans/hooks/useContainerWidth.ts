import { useEffect, useState, type RefObject } from "react";

/**
 * Width of a container in CSS pixels, for layout decisions JS has to make
 * (which tabs exist, where a composer mounts). Styling uses container queries;
 * this keeps the two in step by sharing the same breakpoints.
 */
export function useContainerWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    setWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** Matches Tailwind's `@3xl` container breakpoint (48rem at 16px). */
export const RAIL_BREAKPOINT_PX = 768;
