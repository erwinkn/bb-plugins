// Port of bb apps/app/src/components/sidebar/useSectionThreadDnd.ts at
// desktop-v0.43.0 (MIT), reduced to rows + flat groups. bb's section moves,
// pinned sibling reordering, drop previews, and direct cache mutation are
// dropped; this hook keeps the activation/collision/dwell behavior and reports
// the resolved decision for the caller to apply.
import type {
  CollisionDetection,
  DragEndEvent,
  DragMoveEvent,
  DragOverEvent,
  DragStartEvent,
} from "@dnd-kit/core";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  DROP_SETTLE_MS,
  GROUP_AUTO_EXPAND_MS,
  NEST_BAND_ARMED_FRACTION,
  NEST_BAND_FRACTION,
  NEST_HOVER_DELAY_MS,
  PINNED_NEST_BAND_ARMED_FRACTION,
  PINNED_NEST_BAND_FRACTION,
  ThreadDndProjectionGate,
  getEventIds,
  resolveRowDropState,
  resolveThreadDropDecision,
  resolveThreadRowNestCollisions,
} from "./thread-dnd";
import type {
  ThreadDndLookup,
  ThreadDropDecision,
  ThreadNestTargetState,
} from "./thread-dnd";
import { reorderCollisionDetection, useReorderDnd } from "./use-reorder-dnd";

interface NestCandidate {
  threadId: string;
  ready: boolean;
  timeoutId: number | null;
}

function isCoarseActivatorEvent(event: Event | null | undefined): boolean {
  if (!event || typeof window === "undefined" || !("TouchEvent" in window))
    return false;
  return event instanceof (window as typeof window & { TouchEvent: typeof TouchEvent }).TouchEvent;
}

export interface ThreadDndRenderState {
  activeThreadId: string | null;
  dragMoved: boolean;
  nestTarget: { threadId: string; state: ThreadNestTargetState } | null;
  dragOverGroupKey: string | null;
  consumeClickSuppression: () => boolean;
}

export interface UseThreadDndOptions {
  enabled: boolean;
  lookup: ThreadDndLookup;
  onDrop: (decision: ThreadDropDecision) => void;
  onExpandGroup: (groupKey: string) => void;
  onExpandThread: (threadId: string) => void;
}

export function useThreadDnd({
  enabled,
  lookup,
  onDrop,
  onExpandGroup,
  onExpandThread,
}: UseThreadDndOptions) {
  const lookupRef = useRef<ThreadDndLookup>(lookup);
  lookupRef.current = lookup;
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const onExpandGroupRef = useRef(onExpandGroup);
  onExpandGroupRef.current = onExpandGroup;
  const onExpandThreadRef = useRef(onExpandThread);
  onExpandThreadRef.current = onExpandThread;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const [activeId, setActiveId] = useState<string | null>(null);
  const [dragMoved, setDragMoved] = useState(false);
  const [dragOverGroupKey, setDragOverGroupKey] = useState<string | null>(null);
  const [nestTarget, setNestTarget] = useState<{
    threadId: string;
    state: ThreadNestTargetState;
  } | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const dragMovedRef = useRef(false);
  const armedNestThreadIdRef = useRef<string | null>(null);
  const coarsePointerRef = useRef(false);
  const dropSettleTimerRef = useRef<number | null>(null);
  const nestCandidateRef = useRef<NestCandidate | null>(null);
  const dwellTargetKeyRef = useRef<string | null>(null);
  const dwellTimerRef = useRef<number | null>(null);
  const projectionGateRef = useRef<ThreadDndProjectionGate | null>(null);
  if (!projectionGateRef.current)
    projectionGateRef.current = new ThreadDndProjectionGate();

  const [readyNestCandidate, setReadyNestCandidate] = useState<{
    threadId: string;
    generation: number;
  } | null>(null);
  const nestGenerationRef = useRef(0);

  const clearNestCandidate = useCallback(() => {
    const candidate = nestCandidateRef.current;
    if (candidate?.timeoutId != null)
      window.clearTimeout(candidate.timeoutId);
    nestCandidateRef.current = null;
    armedNestThreadIdRef.current = null;
    setReadyNestCandidate(null);
  }, []);

  const clearDropDwell = useCallback(() => {
    if (dwellTimerRef.current != null) {
      window.clearTimeout(dwellTimerRef.current);
      dwellTimerRef.current = null;
    }
    dwellTargetKeyRef.current = null;
  }, []);

  const clearDropSettle = useCallback(() => {
    if (dropSettleTimerRef.current != null) {
      window.clearTimeout(dropSettleTimerRef.current);
      dropSettleTimerRef.current = null;
    }
  }, []);

  const clearDropState = useCallback(() => {
    clearDropSettle();
    clearNestCandidate();
    clearDropDwell();
    setActiveId(null);
    setDragMoved(false);
    activeIdRef.current = null;
    dragMovedRef.current = false;
    armedNestThreadIdRef.current = null;
    setDragOverGroupKey(null);
    setNestTarget(null);
    projectionGateRef.current?.teardown();
  }, [clearDropSettle, clearNestCandidate, clearDropDwell]);

  const getNestBandFraction = useCallback(
    (threadId: string): number | null => {
      const activeThreadId = activeIdRef.current;
      if (!activeThreadId || threadId === activeThreadId) return null;
      const thread = lookupRef.current.threadById.get(threadId);
      if (!thread || thread.isArchived) return null;
      if (coarsePointerRef.current) return 1;
      const armed =
        readyNestCandidate?.threadId === threadId ||
        armedNestThreadIdRef.current === threadId;
      if (thread.isPinned)
        return armed
          ? PINNED_NEST_BAND_ARMED_FRACTION
          : PINNED_NEST_BAND_FRACTION;
      return armed ? NEST_BAND_ARMED_FRACTION : NEST_BAND_FRACTION;
    },
    [readyNestCandidate],
  );

  const holdNestCandidate = useCallback(
    (threadId: string | null): boolean => {
      const candidate = nestCandidateRef.current;
      if (threadId === null) {
        if (!candidate || candidate.timeoutId == null) return false;
        window.clearTimeout(candidate.timeoutId);
        nestCandidateRef.current = null;
        return false;
      }
      if (!candidate || candidate.threadId !== threadId) {
        if (candidate?.timeoutId != null)
          window.clearTimeout(candidate.timeoutId);
        const timeoutId = window.setTimeout(() => {
          const pending = nestCandidateRef.current;
          if (!pending || pending.threadId !== threadId) return;
          pending.timeoutId = null;
          pending.ready = true;
          nestGenerationRef.current += 1;
          setReadyNestCandidate({
            threadId,
            generation: nestGenerationRef.current,
          });
        }, NEST_HOVER_DELAY_MS);
        nestCandidateRef.current = { threadId, ready: false, timeoutId };
        return false;
      }
      return candidate.ready;
    },
    [],
  );

  const collisionDetection = useCallback<CollisionDetection>(
    (args) =>
      resolveThreadRowNestCollisions({
        collisions: reorderCollisionDetection(args),
        droppableRects: args.droppableRects,
        pointerCoordinates: args.pointerCoordinates,
        getBandFraction: getNestBandFraction,
        holdNestCandidate,
      }),
    [getNestBandFraction, holdNestCandidate],
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      if (!enabledRef.current) return;
      const id = String(event.active.id);
      clearDropSettle();
      clearNestCandidate();
      clearDropDwell();
      activeIdRef.current = id;
      dragMovedRef.current = false;
      setActiveId(id);
      setDragMoved(false);
      setDragOverGroupKey(null);
      setNestTarget(null);
      coarsePointerRef.current = isCoarseActivatorEvent(
        event.activatorEvent,
      );
      projectionGateRef.current?.bind();
    },
    [clearDropSettle, clearNestCandidate, clearDropDwell],
  );

  const handleDragMove = useCallback((event: DragMoveEvent) => {
    void event;
    if (dragMovedRef.current) return;
    dragMovedRef.current = true;
    setDragMoved(true);
    // A long-press context menu may already be open from the 450 ms row
    // long-press while the 200 ms touch drag stays armed; dismiss it on the
    // first move. The synthetic event lacks code === "Escape" so the dnd
    // Escape-to-cancel binding ignores it.
    if (typeof document !== "undefined")
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape" }),
      );
  }, []);

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      if (!enabledRef.current) return;
      const ids = getEventIds(event);
      if (!ids) {
        clearDropDwell();
        dwellTargetKeyRef.current = null;
        setDragOverGroupKey(null);
        setNestTarget(null);
        armedNestThreadIdRef.current = null;
        return;
      }
      const { activeId: eventActiveId, overId } = ids;
      const decision = resolveThreadDropDecision(
        lookupRef.current,
        eventActiveId,
        overId,
      );
      const nextRowDrop = resolveRowDropState(decision);
      const nextGroupKey =
        decision && decision.kind !== "nest" && decision.kind !== "rejected"
          ? decision.groupKey
          : null;
      const nextKey = nextRowDrop
        ? `row:${nextRowDrop.threadId}:${nextRowDrop.state}`
        : nextGroupKey;
      if (nextKey === dwellTargetKeyRef.current) return;
      if (
        !projectionGateRef.current?.allow(
          dwellTargetKeyRef.current,
          nextKey,
        )
      )
        return;
      clearDropDwell();
      dwellTargetKeyRef.current = nextKey;
      armedNestThreadIdRef.current = nextRowDrop?.threadId ?? null;
      setDragOverGroupKey(nextGroupKey);
      setNestTarget(nextRowDrop);
      const expand = (() => {
        if (decision?.kind === "nest" && nextRowDrop?.state === "valid")
          return () => onExpandThreadRef.current(decision.parentThreadId);
        if (nextGroupKey)
          return () => onExpandGroupRef.current(nextGroupKey);
        return null;
      })();
      if (expand) {
        dwellTimerRef.current = window.setTimeout(() => {
          dwellTimerRef.current = null;
          expand();
        }, GROUP_AUTO_EXPAND_MS);
      }
    },
    [clearDropDwell],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (!enabledRef.current) {
        clearDropState();
        return;
      }
      const ids = getEventIds(event);
      const decision =
        ids && dragMovedRef.current
          ? resolveThreadDropDecision(
              lookupRef.current,
              ids.activeId,
              ids.overId,
            )
          : null;
      clearDropSettle();
      dropSettleTimerRef.current = window.setTimeout(() => {
        dropSettleTimerRef.current = null;
        clearDropState();
      }, DROP_SETTLE_MS);
      if (decision && decision.kind !== "rejected")
        onDropRef.current(decision);
    },
    [clearDropSettle, clearDropState],
  );

  const handleDragCancel = useCallback(() => {
    clearDropState();
  }, [clearDropState]);

  const { consumeClickSuppression, dndContextProps, onClickCapture, onEscape } =
    useReorderDnd(
      {
        onDragCancel: handleDragCancel,
        onDragEnd: handleDragEnd,
        onDragMove: handleDragMove,
        onDragOver: handleDragOver,
        onDragStart: handleDragStart,
      },
      { collisionDetection },
    );

  useEffect(
    () => () => {
      clearDropState();
    },
    [clearDropState],
  );

  return {
    activeThreadId: activeId,
    dndContextProps,
    onClickCapture,
    onEscape,
    state: {
      activeThreadId: activeId,
      dragMoved,
      nestTarget,
      dragOverGroupKey,
      consumeClickSuppression,
    } satisfies ThreadDndRenderState,
  };
}

export type { ThreadDropDecision };
