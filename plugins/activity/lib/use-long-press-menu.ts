import { useCallback, useEffect, useRef, type PointerEvent } from "react";

export const LONG_PRESS_MS = 450;

export function useLongPressMenu(menuOpen: boolean) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchDocument = useRef<Document | null>(null);
  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);
  useEffect(() => {
    const document = touchDocument.current;
    if (!menuOpen || !document) return;
    // The browser's native hold can outlive our 450 ms menu gesture. Protect
    // the background as well as the row, including WebKit's text callout.
    // Own a temporary stylesheet instead of overwriting host inline styles.
    const style = document.createElement("style");
    style.dataset.threadTouchSelectionGuard = "";
    style.textContent =
      "html, body, body * { -webkit-user-select: none !important; user-select: none !important; -webkit-touch-callout: none !important; }";
    const preventSelection = (event: Event) => event.preventDefault();
    document.head.append(style);
    document.addEventListener("selectstart", preventSelection, true);
    document.addEventListener("contextmenu", preventSelection, true);
    return () => {
      style.remove();
      document.removeEventListener("selectstart", preventSelection, true);
      document.removeEventListener("contextmenu", preventSelection, true);
      touchDocument.current = null;
    };
  }, [menuOpen]);

  return {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      cancel();
      touchDocument.current = null;
      if (event.pointerType !== "touch" || event.isPrimary === false) return;
      const target = event.currentTarget;
      touchDocument.current = target.ownerDocument;
      const { clientX, clientY } = event;
      timer.current = setTimeout(() => {
        timer.current = null;
        // Use the same menu path as right-click. This also cancels Radix's
        // built-in 700 ms timer without preventing normal taps or scrolling.
        target.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX,
            clientY,
          }),
        );
      }, LONG_PRESS_MS);
    },
    onPointerMove: cancel,
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onContextMenu: cancel,
  };
}
