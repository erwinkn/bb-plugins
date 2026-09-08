import { describe, expect, it } from "vitest";
import {
  inScope,
  moveItem,
  newSpaceId,
  normalizeSpaces,
  resolveScope,
  scopeLabel,
} from "../lib/spaces";

const catalog = {
  revision: 3,
  spaces: [
    { id: "work", name: "Client work", projectIds: ["p1", "p2"] },
    { id: "empty", name: "Empty", projectIds: [] },
  ],
};

describe("scope resolution", () => {
  it("resolves a saved space and All projects", () => {
    const space = resolveScope(catalog, "work");
    expect(space.kind).toBe("space");
    expect(inScope(space, "p1")).toBe(true);
    expect(inScope(space, "p9")).toBe(false);
    expect(scopeLabel(space)).toBe("Client work");

    const all = resolveScope(catalog, null);
    expect(all.kind).toBe("all");
    expect(inScope(all, "anything")).toBe(true);
    expect(scopeLabel(all)).toBe("All projects");
  });
  it("falls back to All projects when the selected space is gone", () => {
    expect(resolveScope(catalog, "gone").kind).toBe("all");
  });
  it("treats an empty space as showing nothing", () => {
    const scope = resolveScope(catalog, "empty");
    expect(scope.kind).toBe("space");
    expect(inScope(scope, "p1")).toBe(false);
  });
});

describe("moveItem", () => {
  it("moves an item to a new index and ignores out-of-range moves", () => {
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveItem(["a", "b", "c"], 1, 1)).toEqual(["a", "b", "c"]);
    expect(moveItem(["a", "b", "c"], 1, 3)).toEqual(["a", "b", "c"]);
    expect(moveItem(["a", "b", "c"], -1, 0)).toEqual(["a", "b", "c"]);
  });
});

describe("catalog normalization", () => {
  it("trims names and removes repeated project ids", () => {
    expect(
      normalizeSpaces([
        { id: "a", name: "  A  ", projectIds: ["x", "x", "y"] },
      ]),
    ).toEqual([{ id: "a", name: "A", projectIds: ["x", "y"] }]);
  });
  it.each([
    [[{ id: "a", name: " ", projectIds: [] }], /empty/],
    [
      [
        { id: "a", name: "Same", projectIds: [] },
        { id: "b", name: "same ", projectIds: [] },
      ],
      /already exists/,
    ],
    [
      [
        { id: "a", name: "One", projectIds: [] },
        { id: "a", name: "Two", projectIds: [] },
      ],
      /unique/,
    ],
    [[{ id: "a", name: "x".repeat(61), projectIds: [] }], /60 characters/],
  ])("rejects invalid input %#", (spaces, message) => {
    expect(() => normalizeSpaces(spaces)).toThrow(message);
  });
  it("generates distinct ids", () => {
    const ids = new Set(Array.from({ length: 20 }, newSpaceId));
    expect(ids.size).toBe(20);
    for (const id of ids) expect(id).toMatch(/^space-/);
  });
});
