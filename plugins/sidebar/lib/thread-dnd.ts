// Adapted from bb apps/app/src/components/sidebar/useSectionThreadDnd.ts at
// desktop-v0.43.0 (MIT). The port keeps bb's activation thresholds, center-band
// arming, and invalid-drop states but reduces the decision set to thread rows
// and flat groups: bb's section moves, pinned sibling ordering, and drop
// previews have no plugin-side model here.
import type {
  Collision,
  CollisionDetection,
  UniqueIdentifier,
} from "@dnd-kit/core";

export interface DndThreadInfo {
  id: string;
  parentThreadId: string | null;
  isPinned: boolean;
  isArchived: boolean;
}

export const NEST_BAND_FRACTION = 0.6;
export const NEST_BAND_ARMED_FRACTION = 0.8;
export const PINNED_NEST_BAND_FRACTION = 0.4;
export const PINNED_NEST_BAND_ARMED_FRACTION = 0.5;
export const NEST_HOVER_DELAY_MS = 700;
export const GROUP_AUTO_EXPAND_MS = 200;
export const DROP_SETTLE_MS = 220;

const ROW_DROPPABLE_PREFIX = "sidebar:thread-row:";
const GROUP_DROPPABLE_PREFIX = "sidebar:thread-group:";
export const PINNED_GROUP_KEY = "pinned";

export const getThreadRowDroppableId = (threadId: string) =>
  `${ROW_DROPPABLE_PREFIX}${threadId}`;
export const parseThreadRowDroppableId = (id: string) =>
  id.startsWith(ROW_DROPPABLE_PREFIX)
    ? id.slice(ROW_DROPPABLE_PREFIX.length)
    : null;
export const getThreadGroupDroppableId = (groupKey: string) =>
  `${GROUP_DROPPABLE_PREFIX}${groupKey}`;
export const parseThreadGroupDroppableId = (id: string) =>
  id.startsWith(GROUP_DROPPABLE_PREFIX)
    ? id.slice(GROUP_DROPPABLE_PREFIX.length)
    : null;

export type ThreadNestTargetState = "valid" | "blocked" | "unchanged";

export interface ThreadDndLookup {
  threadById: ReadonlyMap<string, DndThreadInfo>;
  childrenById: ReadonlyMap<string, readonly string[]>;
}

export function buildThreadDndLookup(
  threads: readonly DndThreadInfo[],
): ThreadDndLookup {
  const threadById = new Map<string, DndThreadInfo>();
  const childrenById = new Map<string, string[]>();
  for (const thread of threads) {
    threadById.set(thread.id, thread);
    if (thread.parentThreadId) {
      const siblings = childrenById.get(thread.parentThreadId);
      if (siblings) siblings.push(thread.id);
      else childrenById.set(thread.parentThreadId, [thread.id]);
    }
  }
  return { threadById, childrenById };
}

export function isThreadWithinSubtree(
  lookup: ThreadDndLookup,
  rootThreadId: string,
  candidateThreadId: string,
): boolean {
  const queue = [rootThreadId];
  const visited = new Set<string>();
  while (queue.length) {
    const current = queue.pop() as string;
    if (!visited.add(current)) continue;
    if (current === candidateThreadId) return true;
    for (const childId of lookup.childrenById.get(current) ?? [])
      queue.push(childId);
  }
  return false;
}

export type ThreadDropDecision =
  | {
      kind: "nest";
      activeId: string;
      parentThreadId: string;
      unpin: boolean;
    }
  | {
      kind: "detach";
      activeId: string;
      groupKey: string;
      unpin: boolean;
    }
  | { kind: "pin"; activeId: string; groupKey: string }
  | { kind: "unpin"; activeId: string; groupKey: string }
  | {
      kind: "rejected";
      activeId: string;
      overThreadId: string;
      reason: "own-subtree" | "already-child" | "archived";
    };

export function resolveThreadDropDecision(
  lookup: ThreadDndLookup,
  activeId: string,
  overId: UniqueIdentifier,
): ThreadDropDecision | null {
  const activeThread = lookup.threadById.get(activeId);
  if (!activeThread) return null;
  const overIdString = String(overId);
  const overThreadId = parseThreadRowDroppableId(overIdString);
  if (overThreadId) {
    if (overThreadId === activeId) return null;
    const overThread = lookup.threadById.get(overThreadId);
    if (!overThread) return null;
    if (overThread.isArchived)
      return {
        kind: "rejected",
        activeId,
        overThreadId,
        reason: "archived",
      };
    if (isThreadWithinSubtree(lookup, activeId, overThreadId))
      return {
        kind: "rejected",
        activeId,
        overThreadId,
        reason: "own-subtree",
      };
    if (activeThread.parentThreadId === overThreadId)
      return {
        kind: "rejected",
        activeId,
        overThreadId,
        reason: "already-child",
      };
    return {
      kind: "nest",
      activeId,
      parentThreadId: overThreadId,
      unpin: activeThread.isPinned,
    };
  }
  const groupKey = parseThreadGroupDroppableId(overIdString);
  if (groupKey) {
    if (groupKey === PINNED_GROUP_KEY) {
      if (!activeThread.isPinned) return { kind: "pin", activeId, groupKey };
      if (activeThread.parentThreadId)
        return { kind: "detach", activeId, groupKey, unpin: false };
      return null;
    }
    if (activeThread.parentThreadId)
      return {
        kind: "detach",
        activeId,
        groupKey,
        unpin: activeThread.isPinned,
      };
    if (activeThread.isPinned) return { kind: "unpin", activeId, groupKey };
    return null;
  }
  return null;
}

// Detach unpins first so a failed unpin leaves the thread exactly where it
// was; reparenting first could strand it detached but still pinned.
export function applyDetachDecision(
  decision: { activeId: string; unpin: boolean },
  reparent: (threadId: string, parentThreadId: string | null) => void,
  setPinned: (threadId: string, pinned: boolean) => Promise<unknown>,
  onError: (error: unknown) => void,
): void {
  if (!decision.unpin) {
    reparent(decision.activeId, null);
    return;
  }
  void setPinned(decision.activeId, false)
    .then(() => reparent(decision.activeId, null))
    .catch(onError);
}

export function resolveRowDropState(decision: ThreadDropDecision | null): {
  threadId: string;
  state: ThreadNestTargetState;
} | null {
  if (!decision) return null;
  if (decision.kind === "nest")
    return { threadId: decision.parentThreadId, state: "valid" };
  if (decision.kind === "rejected")
    return {
      threadId: decision.overThreadId,
      state: decision.reason === "already-child" ? "unchanged" : "blocked",
    };
  return null;
}

export interface ThreadRowPointerInfo {
  threadId: string;
  relativeY: number;
  nesting: boolean;
}

type DroppableRectMap = ReadonlyMap<
  UniqueIdentifier,
  { top: number; height: number }
>;

export function resolveThreadRowNestCollisions(args: {
  collisions: Collision[];
  droppableRects: DroppableRectMap;
  pointerCoordinates: { x: number; y: number } | null;
  getBandFraction: (threadId: string) => number | null;
  onRowPointer?: (info: ThreadRowPointerInfo) => void;
  holdNestCandidate: (threadId: string | null) => boolean;
}): Collision[] {
  const {
    collisions,
    droppableRects,
    pointerCoordinates,
    getBandFraction,
    onRowPointer,
    holdNestCandidate,
  } = args;
  const otherCollisions: Collision[] = [];
  let rowCollision: Collision | null = null;
  for (const collision of collisions) {
    const threadId = parseThreadRowDroppableId(String(collision.id));
    if (!threadId) {
      otherCollisions.push(collision);
      continue;
    }
    if (!rowCollision) rowCollision = collision;
  }
  if (!rowCollision || !pointerCoordinates) {
    holdNestCandidate(null);
    return otherCollisions;
  }
  const threadId = parseThreadRowDroppableId(String(rowCollision.id));
  if (!threadId) {
    holdNestCandidate(null);
    return otherCollisions;
  }
  const rect = droppableRects.get(rowCollision.id);
  if (!rect || rect.height <= 0) {
    holdNestCandidate(null);
    return otherCollisions;
  }
  const relativeY = pointerCoordinates.y - rect.top;
  const bandFraction = getBandFraction(threadId);
  const nesting =
    bandFraction != null &&
    Math.abs(relativeY - rect.height / 2) <=
      (rect.height * bandFraction) / 2;
  onRowPointer?.({ threadId, relativeY, nesting });
  if (!nesting) {
    holdNestCandidate(null);
    // Rows that can never nest (the dragged row, archived rows) still own
    // their rect: keep the collision so the drop resolves against the row
    // itself instead of falling through to the enclosing group.
    return bandFraction == null
      ? [rowCollision, ...otherCollisions]
      : otherCollisions;
  }
  return holdNestCandidate(threadId)
    ? [rowCollision, ...otherCollisions]
    : otherCollisions;
}

const PROJECTION_INPUT_EVENTS = new Set([
  "pointerdown",
  "pointermove",
  "keydown",
  "wheel",
]);

// bb's SectionThreadProjectionGate, kept for the same reason it exists there:
// dragOver fires for every droppable under the pointer and without damping the
// highlight oscillates between neighboring targets on each pixel.
export class ThreadDndProjectionGate {
  private currentKey: string | null = null;
  private lastPointerY: number | null = null;
  private removeInputListener: (() => void) | null = null;

  bind() {
    this.teardown();
    if (typeof window === "undefined") return;
    const onInput = (event: Event) => {
      this.noteInput(event);
    };
    const options = { capture: true, passive: true } as const;
    window.addEventListener("pointermove", onInput, options);
    window.addEventListener("pointerdown", onInput, options);
    window.addEventListener("keydown", onInput, options);
    window.addEventListener("wheel", onInput, options);
    this.removeInputListener = () => {
      window.removeEventListener("pointermove", onInput, options);
      window.removeEventListener("pointerdown", onInput, options);
      window.removeEventListener("keydown", onInput, options);
      window.removeEventListener("wheel", onInput, options);
    };
  }

  noteInput(event: Event) {
    if (!PROJECTION_INPUT_EVENTS.has(event.type)) return;
    const pointerEvent = event as PointerEvent | WheelEvent;
    const pointerY =
      typeof pointerEvent.clientY === "number"
        ? pointerEvent.clientY
        : null;
    this.lastPointerY = pointerY;
    this.currentKey = null;
  }

  allow(currentKey: string | null, nextKey: string | null): boolean {
    if (nextKey === this.currentKey || nextKey === currentKey) return false;
    this.currentKey = nextKey;
    return true;
  }

  reset() {
    this.currentKey = null;
    this.lastPointerY = null;
  }

  teardown() {
    this.removeInputListener?.();
    this.removeInputListener = null;
    this.reset();
  }
}

export function getEventIds(event: {
  active: { id: UniqueIdentifier };
  over: { id: UniqueIdentifier } | null;
}): { activeId: string; overId: UniqueIdentifier } | null {
  const activeId = String(event.active.id);
  if (!event.over) return null;
  return { activeId, overId: event.over.id };
}

export type ThreadDndCollisionDetection = CollisionDetection;
