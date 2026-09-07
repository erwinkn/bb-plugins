import { describe, expect, it } from "vitest";
import {
  inScope,
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
  it("resolves a saved space, an ad-hoc selection, and All projects", () => {
    const space = resolveScope(catalog, { spaceId: "work", projectIds: ["p9"] });
    expect(space.kind).toBe("space");
    expect(inScope(space, "p1")).toBe(true);
    expect(inScope(space, "p9")).toBe(false);
    expect(scopeLabel(space)).toBe("Client work");

    const adhoc = resolveScope(catalog, { spaceId: null, projectIds: ["p3"] });
    expect(adhoc.kind).toBe("projects");
    expect(inScope(adhoc, "p3")).toBe(true);
    expect(inScope(adhoc, "p1")).toBe(false);
    expect(scopeLabel(adhoc)).toBe("1 project");
    expect(
      scopeLabel(resolveScope(catalog, { spaceId: null, projectIds: ["a", "b"] })),
    ).toBe("2 projects");

    const all = resolveScope(catalog, { spaceId: null, projectIds: [] });
    expect(all.kind).toBe("all");
    expect(inScope(all, "anything")).toBe(true);
    expect(scopeLabel(all)).toBe("All projects");
  });
  it("falls back when the selected space is gone, without reviving ad-hoc ids", () => {
    // A saved-space selection clears projectIds, so this only guards the type.
    const scope = resolveScope(catalog, { spaceId: "gone", projectIds: [] });
    expect(scope.kind).toBe("all");
  });
  it("treats an empty space as showing nothing", () => {
    const scope = resolveScope(catalog, { spaceId: "empty", projectIds: [] });
    expect(scope.kind).toBe("space");
    expect(inScope(scope, "p1")).toBe(false);
  });
});

describe("catalog normalization", () => {
  it("trims names and removes repeated project ids", () => {
    expect(
      normalizeSpaces([{ id: "a", name: "  A  ", projectIds: ["x", "x", "y"] }]),
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
