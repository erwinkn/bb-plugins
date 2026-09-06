import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { CheckIcon } from "./icons";

export type MenuItem =
  | { type?: "item"; label: string; onSelect: () => void; shortcut?: string; disabled?: boolean }
  | { type: "toggle"; label: string; checked: boolean; onToggle: (next: boolean) => void }
  | { type: "separator" };

export interface MenuState {
  x: number;
  y: number;
  /** Align the menu's right edge to `x` (for menus opened from a right-side button). */
  alignRight?: boolean;
  /** The element the menu belongs to; the menu closes when that element scrolls away. */
  anchor?: HTMLElement;
  items: MenuItem[];
}

const VIEWPORT_MARGIN_PX = 8;

const MENU_CLASS =
  "fixed z-50 min-w-44 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none animate-in fade-in-0 zoom-in-95";
const ITEM_CLASS =
  "flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-left text-xs text-foreground transition-colors select-none hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 max-md:pointer-coarse:min-h-8";

/** Anchor a menu below an element, right-aligned when it sits near the right edge. */
export function menuAt(element: HTMLElement, items: MenuItem[]): MenuState {
  const rect = element.getBoundingClientRect();
  const alignRight = rect.right > window.innerWidth / 2;
  return { x: alignRight ? rect.right : rect.left, y: rect.bottom + 4, alignRight, anchor: element, items };
}

export function ContextMenu({ state, onClose }: { state: MenuState | null; onClose: () => void }) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    if (state === null) return;
    const menu = menuRef.current;
    const width = menu?.offsetWidth ?? 0;
    const height = menu?.offsetHeight ?? 0;
    const x = state.alignRight ? state.x - width : state.x;
    setPosition({
      x: Math.max(VIEWPORT_MARGIN_PX, Math.min(x, window.innerWidth - width - VIEWPORT_MARGIN_PX)),
      y: Math.max(VIEWPORT_MARGIN_PX, Math.min(state.y, window.innerHeight - height - VIEWPORT_MARGIN_PX)),
    });
  }, [state]);

  useEffect(() => {
    if (state === null) return;
    menuRef.current?.querySelector("button")?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const menu = menuRef.current;
      if (menu === null) return;
      const buttons = Array.from(menu.querySelectorAll("button:not(:disabled)"));
      if (buttons.length === 0) return;
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const delta = event.key === "ArrowDown" ? 1 : -1;
      (buttons[(index + delta + buttons.length) % buttons.length] as HTMLButtonElement | undefined)?.focus();
    };
    // Other panels scroll on their own (the chat follows new messages), so
    // only a scroll that moves this menu's anchor closes it.
    const onScroll = (event: Event) => {
      const anchor = state.anchor;
      if (anchor !== undefined && event.target instanceof Node && event.target.contains(anchor)) onClose();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [state, onClose]);

  if (state === null) return null;

  return createPortal(
    <div ref={menuRef} role="menu" style={{ left: position.x, top: position.y }} className={MENU_CLASS}>
      {state.items.map((item, index) => {
        if (item.type === "separator") return <div key={index} role="separator" className="my-1 h-px bg-border" />;
        if (item.type === "toggle") {
          return (
            <button
              key={item.label}
              type="button"
              role="menuitemcheckbox"
              aria-checked={item.checked}
              onClick={() => {
                item.onToggle(!item.checked);
                onClose();
              }}
              className={cn(ITEM_CLASS, "whitespace-nowrap")}
            >
              <span className="flex size-3.5 items-center justify-center text-foreground">
                {item.checked ? <CheckIcon /> : null}
              </span>
              <span className="flex-1">{item.label}</span>
            </button>
          );
        }
        return (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              item.onSelect();
              onClose();
            }}
            className={cn(ITEM_CLASS, "whitespace-nowrap")}
          >
            <span className="size-3.5" aria-hidden />
            <span className="flex-1">{item.label}</span>
            {item.shortcut ? <kbd className="ml-4 font-sans text-[10px] text-muted-foreground">{item.shortcut}</kbd> : null}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
