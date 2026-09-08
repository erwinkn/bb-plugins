import { useRef, useState } from "react";
import { clampTreeWidth } from "@/lib/layout-storage";
import { cn } from "@/lib/utils";

const KEYBOARD_STEP_PX = 24;

/** The draggable edge of a side column. Arrow keys move it too. */
export function ResizeHandle({
  side,
  label,
  width,
  available,
  onResize,
  onResizeEnd,
}: {
  /** Edge of the column the handle sits on. */
  side: "left" | "right";
  label: string;
  width: number;
  /** The panel width the column has to fit in. */
  available: number;
  onResize: (width: number) => void;
  /** Runs when a drag or key press has settled, with the final width. */
  onResizeEnd?: (width: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const start = useRef(width);
  const latest = useRef(width);
  latest.current = width;
  const grow = side === "right" ? 1 : -1;

  const applyDelta = (delta: number) => {
    const next = clampTreeWidth(start.current + delta * grow, available);
    latest.current = next;
    onResize(next);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    start.current = latest.current;
    setDragging(true);
    target.setPointerCapture(pointerId);
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId === pointerId) applyDelta(moveEvent.clientX - startX);
    };
    const finish = (finishEvent: PointerEvent) => {
      if (finishEvent.pointerId !== pointerId) return;
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", finish);
      target.removeEventListener("pointercancel", finish);
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
      setDragging(false);
      onResizeEnd?.(latest.current);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", finish);
    target.addEventListener("pointercancel", finish);
  };

  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        start.current = latest.current;
        applyDelta(event.key === "ArrowLeft" ? -KEYBOARD_STEP_PX : KEYBOARD_STEP_PX);
        onResizeEnd?.(latest.current);
      }}
      className={cn(
        "absolute top-0 z-10 h-full w-px bg-transparent transition-colors",
        side === "right" ? "-right-px" : "-left-px",
        "hover:bg-ring/50 focus-visible:bg-ring focus-visible:outline-none",
        dragging && "bg-ring/60",
      )}
    >
      <div
        aria-hidden
        onPointerDown={handlePointerDown}
        className={cn("absolute top-0 h-full w-2.5 cursor-col-resize touch-none bg-transparent", side === "right" ? "-right-1" : "-left-1")}
      />
    </div>
  );
}
