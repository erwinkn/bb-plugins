import { describe, expect, it, vi } from "vitest";
import type { Collision } from "@dnd-kit/core";
import {
  NEST_BAND_FRACTION,
  PINNED_NEST_BAND_FRACTION,
  applyDetachDecision,
  buildThreadDndLookup,
  getThreadGroupDroppableId,
  getThreadRowDroppableId,
  isThreadWithinSubtree,
  resolveRowDropState,
  resolveThreadDropDecision,
  resolveThreadRowNestCollisions,
  type DndThreadInfo,
} from "../lib/thread-dnd";

const info = (overrides: Partial<DndThreadInfo> = {}): DndThreadInfo => ({
  id: "thread",
  parentThreadId: null,
  isPinned: false,
  isArchived: false,
  ...overrides,
});

const collision = (id: string): Collision => ({
  id,
  data: { droppableContainer: { id, rect: { current: null } } },
});

const rect = (top: number, height: number) => ({
  top,
  height,
});

describe("thread dnd lookup", () => {
  it("walks descendants through nested parents", () => {
    const lookup = buildThreadDndLookup([
      info({ id: "root" }),
      info({ id: "child", parentThreadId: "root" }),
      info({ id: "grandchild", parentThreadId: "child" }),
      info({ id: "sibling" }),
    ]);
    expect(isThreadWithinSubtree(lookup, "root", "grandchild")).toBe(true);
    expect(isThreadWithinSubtree(lookup, "root", "sibling")).toBe(false);
    expect(isThreadWithinSubtree(lookup, "child", "root")).toBe(false);
  });
});

describe("resolveThreadDropDecision", () => {
  const lookup = () =>
    buildThreadDndLookup([
      info({ id: "source" }),
      info({ id: "pinned-source", isPinned: true }),
      info({ id: "nested", parentThreadId: "parent" }),
      info({ id: "nested-pinned", parentThreadId: "parent", isPinned: true }),
      info({ id: "parent" }),
      info({ id: "child-of-parent", parentThreadId: "parent" }),
      info({ id: "archived", isArchived: true }),
    ]);

  it("nests a top-level thread on an armed row", () => {
    expect(
      resolveThreadDropDecision(
        lookup(),
        "source",
        getThreadRowDroppableId("parent"),
      ),
    ).toEqual({ kind: "nest", activeId: "source", parentThreadId: "parent", unpin: false });
  });

  it("flags unpin when a pinned source nests", () => {
    expect(
      resolveThreadDropDecision(
        lookup(),
        "pinned-source",
        getThreadRowDroppableId("parent"),
      ),
    ).toEqual({
      kind: "nest",
      activeId: "pinned-source",
      parentThreadId: "parent",
      unpin: true,
    });
  });

  it("rejects a drop on itself, a descendant, its parent, or an archived row", () => {
    const l = lookup();
    expect(
      resolveThreadDropDecision(l, "source", getThreadRowDroppableId("source")),
    ).toBeNull();
    expect(
      resolveThreadDropDecision(
        l,
        "parent",
        getThreadRowDroppableId("child-of-parent"),
      ),
    ).toMatchObject({ kind: "rejected", reason: "own-subtree" });
    expect(
      resolveThreadDropDecision(l, "nested", getThreadRowDroppableId("parent")),
    ).toMatchObject({ kind: "rejected", reason: "already-child" });
    expect(
      resolveThreadDropDecision(
        l,
        "source",
        getThreadRowDroppableId("archived"),
      ),
    ).toMatchObject({ kind: "rejected", reason: "archived" });
  });

  it("detaches a nested thread dropped on a status group", () => {
    expect(
      resolveThreadDropDecision(
        lookup(),
        "nested",
        getThreadGroupDroppableId("status:working"),
      ),
    ).toEqual({
      kind: "detach",
      activeId: "nested",
      groupKey: "status:working",
      unpin: false,
    });
    expect(
      resolveThreadDropDecision(
        lookup(),
        "nested-pinned",
        getThreadGroupDroppableId("status:working"),
      ),
    ).toEqual({
      kind: "detach",
      activeId: "nested-pinned",
      groupKey: "status:working",
      unpin: true,
    });
  });

  it("unpins a top-level pinned thread dropped on a status group", () => {
    expect(
      resolveThreadDropDecision(
        lookup(),
        "pinned-source",
        getThreadGroupDroppableId("status:done"),
      ),
    ).toEqual({
      kind: "unpin",
      activeId: "pinned-source",
      groupKey: "status:done",
    });
  });

  it("pins a non-pinned thread dropped on the pinned group", () => {
    expect(
      resolveThreadDropDecision(
        lookup(),
        "source",
        getThreadGroupDroppableId("pinned"),
      ),
    ).toEqual({ kind: "pin", activeId: "source", groupKey: "pinned" });
    expect(
      resolveThreadDropDecision(
        lookup(),
        "nested",
        getThreadGroupDroppableId("pinned"),
      ),
    ).toEqual({ kind: "pin", activeId: "nested", groupKey: "pinned" });
  });

  it("is a no-op for a pinned top-level thread on the pinned group or an unrelated thread on a group", () => {
    const l = lookup();
    expect(
      resolveThreadDropDecision(
        l,
        "pinned-source",
        getThreadGroupDroppableId("pinned"),
      ),
    ).toBeNull();
    expect(
      resolveThreadDropDecision(
        l,
        "source",
        getThreadGroupDroppableId("status:working"),
      ),
    ).toBeNull();
    expect(resolveThreadDropDecision(l, "source", "other-droppable")).toBeNull();
  });
});

describe("resolveRowDropState", () => {
  it("maps decisions to row highlight states", () => {
    expect(
      resolveRowDropState({
        kind: "nest",
        activeId: "a",
        parentThreadId: "b",
        unpin: false,
      }),
    ).toEqual({ threadId: "b", state: "valid" });
    expect(
      resolveRowDropState({
        kind: "rejected",
        activeId: "a",
        overThreadId: "b",
        reason: "own-subtree",
      }),
    ).toEqual({ threadId: "b", state: "blocked" });
    expect(
      resolveRowDropState({
        kind: "rejected",
        activeId: "a",
        overThreadId: "b",
        reason: "already-child",
      }),
    ).toEqual({ threadId: "b", state: "unchanged" });
    expect(
      resolveRowDropState({
        kind: "detach",
        activeId: "a",
        groupKey: "status:done",
        unpin: false,
      }),
    ).toBeNull();
    expect(resolveRowDropState(null)).toBeNull();
  });
});

describe("resolveThreadRowNestCollisions", () => {
  const rowId = getThreadRowDroppableId("target");
  const groupId = getThreadGroupDroppableId("status:working");
  const rects = new Map([[rowId, rect(100, 40)]]);

  it("returns the group collision while a banded row is still unarmed", () => {
    const hold = vi.fn(() => false);
    const result = resolveThreadRowNestCollisions({
      collisions: [collision(rowId), collision(groupId)],
      droppableRects: rects,
      // Row spans y=100..140; center is 120; the 0.6 band is 108..132.
      pointerCoordinates: { x: 10, y: 120 },
      getBandFraction: () => NEST_BAND_FRACTION,
      holdNestCandidate: hold,
    });
    expect(hold).toHaveBeenCalledWith("target");
    expect(result.map((c) => c.id)).toEqual([groupId]);
  });

  it("puts the row first once the nest candidate is armed", () => {
    const result = resolveThreadRowNestCollisions({
      collisions: [collision(groupId), collision(rowId)],
      droppableRects: rects,
      pointerCoordinates: { x: 10, y: 120 },
      getBandFraction: () => NEST_BAND_FRACTION,
      holdNestCandidate: () => true,
    });
    expect(result.map((c) => c.id)).toEqual([rowId, groupId]);
  });

  it("ignores the row band outside the center strip", () => {
    const result = resolveThreadRowNestCollisions({
      collisions: [collision(rowId), collision(groupId)],
      droppableRects: rects,
      // y=138 is 8 px above the bottom edge, outside the 108..132 band.
      pointerCoordinates: { x: 10, y: 138 },
      getBandFraction: () => NEST_BAND_FRACTION,
      holdNestCandidate: () => true,
    });
    expect(result.map((c) => c.id)).toEqual([groupId]);
  });

  it("uses the wider armed band fraction once armed", () => {
    // y=136 is inside the armed 0.8 band (104..136) but outside 0.6.
    const result = resolveThreadRowNestCollisions({
      collisions: [collision(rowId)],
      droppableRects: rects,
      pointerCoordinates: { x: 10, y: 136 },
      getBandFraction: () => 0.8,
      holdNestCandidate: () => true,
    });
    expect(result.map((c) => c.id)).toEqual([rowId]);
  });

  it("keeps rows that can never nest so self and archived drops no-op", () => {
    const result = resolveThreadRowNestCollisions({
      collisions: [collision(rowId), collision(groupId)],
      droppableRects: rects,
      pointerCoordinates: { x: 10, y: 120 },
      getBandFraction: () => null,
      holdNestCandidate: () => true,
    });
    expect(result.map((c) => c.id)).toEqual([rowId, groupId]);
  });

  it("resolves a nested thread dropped on its own row to a no-op", () => {
    const l = buildThreadDndLookup([
      info({ id: "nested", parentThreadId: "parent" }),
      info({ id: "parent" }),
    ]);
    const ownRow = getThreadRowDroppableId("nested");
    const result = resolveThreadRowNestCollisions({
      collisions: [collision(ownRow), collision(groupId)],
      droppableRects: new Map([[ownRow, rect(100, 40)]]),
      pointerCoordinates: { x: 10, y: 120 },
      // The active row has no band fraction.
      getBandFraction: () => null,
      holdNestCandidate: () => true,
    });
    expect(String(result[0]!.id)).toBe(ownRow);
    expect(
      resolveThreadDropDecision(l, "nested", result[0]!.id),
    ).toBeNull();
  });

  it("passes collisions through when the pointer is not over a row", () => {
    const result = resolveThreadRowNestCollisions({
      collisions: [collision(groupId)],
      droppableRects: rects,
      pointerCoordinates: { x: 10, y: 200 },
      getBandFraction: () => NEST_BAND_FRACTION,
      holdNestCandidate: () => false,
    });
    expect(result.map((c) => c.id)).toEqual([groupId]);
  });

  it("applies the tighter pinned band", () => {
    // Pinned rows arm at 0.4: the band is 112..128, so y=110 is outside.
    const outside = resolveThreadRowNestCollisions({
      collisions: [collision(rowId)],
      droppableRects: rects,
      pointerCoordinates: { x: 10, y: 110 },
      getBandFraction: () => PINNED_NEST_BAND_FRACTION,
      holdNestCandidate: () => true,
    });
    expect(outside).toEqual([]);
    const inside = resolveThreadRowNestCollisions({
      collisions: [collision(rowId)],
      droppableRects: rects,
      pointerCoordinates: { x: 10, y: 112 },
      getBandFraction: () => PINNED_NEST_BAND_FRACTION,
      holdNestCandidate: () => true,
    });
    expect(inside.map((c) => c.id)).toEqual([rowId]);
  });
});

describe("applyDetachDecision", () => {
  it("detaches directly when the source is not pinned", () => {
    const reparent = vi.fn();
    const setPinned = vi.fn();
    applyDetachDecision(
      { activeId: "a", unpin: false },
      reparent,
      setPinned,
      vi.fn(),
    );
    expect(reparent).toHaveBeenCalledWith("a", null);
    expect(setPinned).not.toHaveBeenCalled();
  });

  it("unpins a pinned source before detaching it", async () => {
    const order: string[] = [];
    const reparent = vi.fn(() => void order.push("reparent"));
    const setPinned = vi.fn(async () => void order.push("unpin"));
    const onError = vi.fn();
    applyDetachDecision({ activeId: "a", unpin: true }, reparent, setPinned, onError);
    await vi.waitFor(() => expect(reparent).toHaveBeenCalledWith("a", null));
    expect(order).toEqual(["unpin", "reparent"]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("leaves the thread in place when the unpin fails", async () => {
    const reparent = vi.fn();
    const setPinned = vi.fn().mockRejectedValue(new Error("offline"));
    const onError = vi.fn();
    applyDetachDecision({ activeId: "a", unpin: true }, reparent, setPinned, onError);
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(reparent).not.toHaveBeenCalled();
  });
});
