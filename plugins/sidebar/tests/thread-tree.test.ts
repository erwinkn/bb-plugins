import { describe, expect, it } from "vitest";
import {
  buildThreadTree,
  familyStatus,
  pinnedThreadIds,
  flattenDescendants,
  type ThreadNode,
} from "../lib/thread-tree";
import { statusOf } from "../lib/status";
import { thread } from "./fixtures";

const rows = (...items: ReturnType<typeof thread>[]) =>
  items.map((item) => ({ thread: item, status: statusOf(item) }));
const ids = (nodes: ThreadNode[]): string[] =>
  nodes.flatMap((node) => [node.thread.id, ...ids(node.children)]);

describe("thread families", () => {
  it("flattens a deep display level in family order without changing its true parents", () => {
    const tree = buildThreadTree(
      rows(
        thread({ id: "a", updatedAt: 500 }),
        thread({ id: "b", parentThreadId: "a", updatedAt: 100 }),
        thread({ id: "c", parentThreadId: "b", updatedAt: 800 }),
        thread({ id: "d", updatedAt: 400 }),
      ),
      "updated",
    );
    const flat = flattenDescendants(tree);
    expect(flat.map((node) => node.thread.id)).toEqual(["a", "b", "c", "d"]);
    expect(flat.every((node) => node.children.length === 0)).toBe(true);
    expect(flat[2].thread.parentThreadId).toBe("b");
    expect(tree[0].children[0].children[0].thread.id).toBe("c");
  });
  it("nests children and grandchildren even when children arrive first", () => {
    const tree = buildThreadTree(
      rows(
        thread({ id: "grandchild", parentThreadId: "child" }),
        thread({ id: "child", parentThreadId: "parent" }),
        thread({ id: "parent" }),
      ),
      "updated",
    );
    expect(tree).toHaveLength(1);
    expect(tree[0].children[0].children[0].thread.id).toBe("grandchild");
    expect(ids(tree)).toEqual(["parent", "child", "grandchild"]);
  });
  it("keeps children with missing or filtered parents visible as roots", () => {
    const tree = buildThreadTree(
      rows(thread({ id: "orphan", parentThreadId: "missing" })),
      "updated",
    );
    expect(ids(tree)).toEqual(["orphan"]);
    expect(tree[0].children).toEqual([]);
  });
  it("breaks cyclic and self-parent links without losing or duplicating threads", () => {
    const tree = buildThreadTree(
      rows(
        thread({ id: "a", parentThreadId: "b" }),
        thread({ id: "b", parentThreadId: "c" }),
        thread({ id: "c", parentThreadId: "a" }),
        thread({ id: "self", parentThreadId: "self" }),
      ),
      "updated",
    );
    expect(ids(tree).sort()).toEqual(["a", "b", "c", "self"]);
  });
  it.each(["created", "updated"] as const)(
    "sorts roots and siblings by pins then %s date",
    (sortBy) => {
      const tree = buildThreadTree(
        rows(
          thread({ id: "parent", createdAt: 200, updatedAt: 300 }),
          thread({ id: "other", createdAt: 300, updatedAt: 200 }),
          thread({ id: "pin", isPinned: true }),
          thread({
            id: "old",
            parentThreadId: "parent",
            createdAt: 500,
            updatedAt: 1000,
          }),
          thread({
            id: "new",
            parentThreadId: "parent",
            createdAt: 1000,
            updatedAt: 500,
          }),
          thread({ id: "child-pin", parentThreadId: "parent", isPinned: true }),
        ),
        sortBy,
      );
      expect(tree.map((node) => node.thread.id)).toEqual(
        sortBy === "created"
          ? ["pin", "other", "parent"]
          : ["pin", "parent", "other"],
      );
      const parent = tree.find((node) => node.thread.id === "parent")!;
      expect(ids(parent.children)).toEqual(
        sortBy === "created"
          ? ["child-pin", "new", "old"]
          : ["child-pin", "old", "new"],
      );
    },
  );
  it("uses the highest visible category across descendants without changing own statuses", () => {
    const tree = buildThreadTree(
      rows(
        thread({ id: "parent" }),
        thread({
          id: "running",
          parentThreadId: "parent",
          indicator: "runtime",
        }),
        thread({ id: "unread", parentThreadId: "running", isUnread: true }),
        thread({
          id: "question",
          parentThreadId: "unread",
          hasPendingInteraction: true,
        }),
      ),
      "updated",
    );
    expect(familyStatus(tree[0])).toBe("attention");
    expect(tree[0].status).toBe("done");
    expect(tree[0].children[0].status).toBe("working");
    tree[0].children[0].children[0].children = [];
    expect(familyStatus(tree[0])).toBe("unread");
  });
});

describe("pinned families", () => {
  it("collects descendants once across nested pins and cycles, excluding ancestors", () => {
    expect([...pinnedThreadIds(rows(
      thread({ id: "parent" }),
      thread({ id: "child", parentThreadId: "pin" }),
      thread({ id: "nested", parentThreadId: "child", isPinned: true }),
      thread({ id: "pin", parentThreadId: "parent", isPinned: true }),
      thread({ id: "a", parentThreadId: "b", isPinned: true }),
      thread({ id: "b", parentThreadId: "a" }),
      thread({ id: "self", parentThreadId: "self", isPinned: true }),
      thread({ id: "orphan", parentThreadId: "missing" }),
    ))].sort()).toEqual(["a", "b", "child", "nested", "pin", "self"]);
  });
});
