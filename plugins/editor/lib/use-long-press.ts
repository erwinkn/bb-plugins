import { useRef } from "react";
import type { PointerEvent, MouseEvent } from "react";

export interface MenuPoint {
  x: number;
  y: number;
}

/**
 * Opens a context menu from a right click, or from a long press on a touch
 * screen. iOS Safari never fires `contextmenu` for a long press, so the
 * touch path is timed here. Android fires it as well as this timer; whichever
 * comes first wins and the other is ignored for the same press. The click
 * that follows a long press is swallowed, so the row is not also activated.
 */
export function useLongPress<T extends HTMLElement>(open: (point: MenuPoint, target: T) => void, delayMs = 500) {
  const press = useRef<{ timer: ReturnType<typeof setTimeout> | null; x: number; y: number; opened: boolean }>({
    timer: null,
    x: 0,
    y: 0,
    opened: false,
  });
  const cancel = () => {
    if (press.current.timer !== null) clearTimeout(press.current.timer);
    press.current.timer = null;
  };
  return {
    onPointerDown(event: PointerEvent<T>) {
      if (event.pointerType !== "touch" || !event.isPrimary) return;
      cancel();
      const target = event.currentTarget;
      press.current = { timer: null, x: event.clientX, y: event.clientY, opened: false };
      press.current.timer = setTimeout(() => {
        press.current.timer = null;
        press.current.opened = true;
        open({ x: press.current.x, y: press.current.y }, target);
      }, delayMs);
    },
    onPointerMove(event: PointerEvent<T>) {
      if (press.current.timer === null) return;
      if (Math.abs(event.clientX - press.current.x) > 10 || Math.abs(event.clientY - press.current.y) > 10) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onClickCapture(event: MouseEvent<T>) {
      if (!press.current.opened) return;
      press.current.opened = false;
      event.preventDefault();
      event.stopPropagation();
    },
    onContextMenu(event: MouseEvent<T>) {
      event.preventDefault();
      if (press.current.opened) return;
      cancel();
      // A native long press (Android) must not be followed by the timer's own open.
      press.current.opened = (event.nativeEvent as { pointerType?: string }).pointerType === "touch";
      open({ x: event.clientX, y: event.clientY }, event.currentTarget);
    },
  };
}
