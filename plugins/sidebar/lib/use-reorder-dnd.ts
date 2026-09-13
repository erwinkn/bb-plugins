// Port of bb apps/app/src/components/ui/useReorderDnd.ts and
// components/sidebar/useDragClickSuppression.ts at desktop-v0.43.0 (MIT).
// Differences from the original:
// - KeyboardSensor is not ported: thread rows are links whose Enter/Space keys
//   already activate navigation, and keyboard/mobile parity for reparenting is
//   provided by the "Make child of…" / "Move to top level" menu actions.
// - bb's SidebarTouchSensor only exists to disable dnd-kit's non-passive
//   touchmove listener while its compact drawer is open; a plugin cannot
//   observe that state, so plain TouchSensor (which installs the same iOS
//   Safari fix unconditionally) is used.
import {
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
  const sensors = useSensors(mouseSensor, touchSensor);
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
  const onEscape = useCallback<KeyboardEventHandler<HTMLElement>>(
    (event) => {
      if (event.defaultPrevented) return;
      if (event.code !== "Escape" && event.key !== "Escape") return;
      event.preventDefault();
      handleDragCancel();
    },
    [handleDragCancel],
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
