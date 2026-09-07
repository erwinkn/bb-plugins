import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { CheckIcon } from "./icons";

type Decoration = { icon?: ReactNode; title?: string };
export type MenuItem =
  | (Decoration & { type?: "item"; label: string; onSelect: () => void; shortcut?: string; disabled?: boolean; keepOpen?: boolean })
  | (Decoration & { type: "toggle"; label: string; checked: boolean; onToggle: (next: boolean) => void; shortcut?: string })
  | { type: "separator" }
  | { type: "label"; label: string };

export interface MenuState {
  x: number;
  y: number;
  /** Align the menu's right edge to `x` (for menus opened from a right-side button). */
  alignRight?: boolean;
  /** The element the menu belongs to; the menu closes when that element scrolls away. */
  anchor?: HTMLElement;
  items: MenuItem[];
  className?: string;
}

const VIEWPORT_MARGIN_PX = 8;

const MENU_CLASS =
  "fixed z-50 min-w-44 max-h-[calc(100dvh-16px)] overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none animate-in fade-in-0 zoom-in-95";
const ITEM_CLASS =
  "flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-left text-xs text-foreground transition-colors select-none hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 max-md:pointer-coarse:min-h-8";

/** Anchor a menu below an element, right-aligned when it sits near the right edge. */
export function menuAt(element: HTMLElement, items: MenuItem[], className?: string): MenuState {
  const rect = element.getBoundingClientRect();
  const alignRight = rect.right > window.innerWidth / 2;
  return { x: alignRight ? rect.right : rect.left, y: rect.bottom + 4, alignRight, anchor: element, items, className };
}

export function ContextMenu({ state, onClose }: { state: MenuState | null; onClose: () => void }) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const open = state !== null;
  // Items may change while the menu is open (commits load, a list expands);
  // the listeners below must not re-run and steal focus when they do.
  const latest = useRef({ state, onClose });
  latest.current = { state, onClose };

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
    if (!open) return;
    const close = () => latest.current.onClose();
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
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
      const anchor = latest.current.state?.anchor;
      if (anchor !== undefined && event.target instanceof Node && event.target.contains(anchor)) close();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  if (state === null) return null;

  return createPortal(
    <div ref={menuRef} role="menu" style={{ left: position.x, top: position.y }} className={cn(MENU_CLASS, state.className)}>
      {state.items.map((item, index) => {
        if (item.type === "separator") return <div key={index} role="separator" className="my-1 h-px bg-border" />;
        if (item.type === "label") {
          return <div key={index} className="truncate px-2 py-1 text-[10px] text-muted-foreground" title={item.label}>{item.label}</div>;
        }
        const toggle = item.type === "toggle";
        // A plain toggle shows its check where an icon would go; one with an icon shows it at the end.
        const check = toggle && item.checked ? <CheckIcon className="text-foreground" /> : null;
        return (
          <button
            key={index}
            type="button"
            role={toggle ? "menuitemcheckbox" : "menuitem"}
            aria-checked={toggle ? item.checked : undefined}
            disabled={!toggle && item.disabled}
            title={item.title}
            onClick={() => {
              if (toggle) item.onToggle(!item.checked);
              else item.onSelect();
              if (toggle || !item.keepOpen) onClose();
            }}
            className={cn(ITEM_CLASS, "whitespace-nowrap")}
          >
            <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">{item.icon ?? check}</span>
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.shortcut ? <kbd className="ml-4 shrink-0 font-sans text-[10px] text-muted-foreground">{item.shortcut}</kbd> : null}
            {item.icon !== undefined && toggle ? <span className="flex size-3.5 shrink-0 items-center justify-center">{check}</span> : null}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
