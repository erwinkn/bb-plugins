// Port of bb apps/app/src/components/ui/useReorderDnd.ts and
// components/sidebar/useDragClickSuppression.ts at desktop-v0.43.0 (MIT).
// Differences from the original:
// - bb's SidebarTouchSensor only exists to disable dnd-kit's non-passive
//   touchmove listener while its compact drawer is open; a plugin cannot
//   observe that state, so plain TouchSensor (which installs the same iOS
//   Safari fix unconditionally) is used.
// - The KeyboardSensor lifts and drops with Space only: rows here are links,
//   so Enter keeps its navigation role. ArrowUp/ArrowDown move between the
//   vertical neighbours of the row the drag is over.
import {
  KeyboardCode,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type {
  CollisionDetection,
  DragEndEvent,
  DragMoveEvent,
  DragOverEvent,
  DragStartEvent,
  KeyboardCoordinateGetter,
  Modifier,
} from "@dnd-kit/core";
import type {
  KeyboardEventHandler,
  MouseEventHandler,
} from "react";
import { useCallback, useEffect, useRef } from "react";

export const reorderCollisionDetection: CollisionDetection = (args) => {
  const collisions = pointerWithin(args);
  if (collisions.length > 0) return collisions;
  return closestCenter(args);
};

export const restrictDragToVerticalAxis: Modifier = ({ transform }) => ({
  ...transform,
  x: 0,
});

/**
 * Arrow keys move a keyboard drag straight to the next or previous droppable
 * row — appropriate for a single-column list where one keypress means one
 * position, instead of the stock fixed-pixel step.
 */
export const reorderKeyboardCoordinates: KeyboardCoordinateGetter = (
  event,
  { active, context },
) => {
  const step =
    event.code === KeyboardCode.Down
      ? 1
      : event.code === KeyboardCode.Up
        ? -1
        : 0;
  if (!step) return;
  const { droppableContainers, over } = context;
  const rows = droppableContainers
    .getEnabled()
    .flatMap((container) => {
      const rect = container.rect.current;
      return rect ? [{ id: container.id, rect }] : [];
    })
    .sort((a, b) => a.rect.top - b.rect.top);
  const current = rows.findIndex((row) => row.id === (over?.id ?? active));
  const target = current >= 0 ? rows[current + step] : undefined;
  if (!target) return;
  return {
    x: target.rect.left + target.rect.width / 2,
    y: target.rect.top + target.rect.height / 2,
  };
};

const CLICK_SUPPRESSION_MS = 350;

export function useDragClickSuppression() {
  const suppressClickRef = useRef(false);
  const suppressionTimeoutRef = useRef<number | null>(null);
  const clearSuppressionTimeout = useCallback(() => {
    if (suppressionTimeoutRef.current != null) {
      window.clearTimeout(suppressionTimeoutRef.current);
      suppressionTimeoutRef.current = null;
    }
  }, []);
  const suppressPostDragClick = useCallback(() => {
    clearSuppressionTimeout();
    suppressClickRef.current = true;
    suppressionTimeoutRef.current = window.setTimeout(() => {
      suppressClickRef.current = false;
      suppressionTimeoutRef.current = null;
    }, CLICK_SUPPRESSION_MS);
  }, [clearSuppressionTimeout]);
  const onClickCapture = useCallback<MouseEventHandler<HTMLElement>>(
    (event) => {
      if (!suppressClickRef.current) return;
      event.preventDefault();
      event.stopPropagation();
    },
    [],
  );
  useEffect(() => clearSuppressionTimeout, [clearSuppressionTimeout]);
  const consumeClickSuppression = useCallback(() => {
    if (!suppressClickRef.current) return false;
    suppressClickRef.current = false;
    clearSuppressionTimeout();
    return true;
  }, [clearSuppressionTimeout]);
  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (!suppressClickRef.current) return;
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("click", handler, true);
    return () => document.removeEventListener("click", handler, true);
  }, []);
  return {
    consumeClickSuppression,
    onClickCapture,
    suppressPostDragClick,
  };
}

export interface ReorderDndHandlers {
  onDragCancel?: () => void;
  onDragEnd: (event: DragEndEvent) => void;
  onDragMove?: (event: DragMoveEvent) => void;
  onDragOver?: (event: DragOverEvent) => void;
  onDragStart?: (event: DragStartEvent) => void;
}

export interface ReorderDndOptions {
  collisionDetection?: CollisionDetection;
  /** Reports whether a drag session is active; Escape is ignored when not. */
  isActive?: () => boolean;
  /**
   * Focused rows lift on Space and drop on Space/Enter, with arrows stepping
   * between neighbours. Off by default — a list opts in when its rows have no
   * other keyboard reorder path.
   */
  keyboardReorder?: boolean;
}

export function useReorderDnd(
  {
    onDragCancel,
    onDragEnd,
    onDragMove,
    onDragOver,
    onDragStart,
  }: ReorderDndHandlers,
  options?: ReorderDndOptions,
) {
  const mouseSensor = useSensor(MouseSensor, {
    activationConstraint: { distance: 4 },
  });
  const touchSensor = useSensor(TouchSensor, {
    activationConstraint: { delay: 200, tolerance: 6 },
  });
  const keyboardSensor = useSensor(KeyboardSensor, {
    // Enter keeps following the link; Space lifts and drops the row.
    keyboardCodes: {
      start: [KeyboardCode.Space],
      cancel: [KeyboardCode.Esc],
      end: [KeyboardCode.Space, KeyboardCode.Enter],
    },
    coordinateGetter: reorderKeyboardCoordinates,
  });
  const sensors = useSensors(
    mouseSensor,
    touchSensor,
    ...(options?.keyboardReorder ? [keyboardSensor] : []),
  );
  const {
    consumeClickSuppression,
    onClickCapture,
    suppressPostDragClick,
  } = useDragClickSuppression();
  const handleDragCancel = useCallback(() => {
    suppressPostDragClick();
    onDragCancel?.();
  }, [onDragCancel, suppressPostDragClick]);
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      suppressPostDragClick();
      onDragEnd(event);
    },
    [onDragEnd, suppressPostDragClick],
  );
  const isActive = options?.isActive;
  const onEscape = useCallback<KeyboardEventHandler<HTMLElement>>(
    (event) => {
      if (event.defaultPrevented) return;
      if (event.code !== "Escape" && event.key !== "Escape") return;
      if (!isActive?.()) return;
      event.preventDefault();
      handleDragCancel();
    },
    [handleDragCancel, isActive],
  );
  return {
    consumeClickSuppression,
    dndContextProps: {
      collisionDetection:
        options?.collisionDetection ?? reorderCollisionDetection,
      modifiers: [restrictDragToVerticalAxis],
      onDragCancel: handleDragCancel,
      onDragEnd: handleDragEnd,
      onDragMove,
      onDragOver,
      onDragStart,
      sensors,
    },
    onClickCapture,
    onEscape,
  };
}
