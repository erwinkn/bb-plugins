import { describe, expect, it } from "vitest";
import { createVersionPatch } from "./patch";

describe("plan version patches", () => {
  it("treats a trailing newline as identical after diff normalization", () => {
    expect(createVersionPatch("Plan", "Plan\n", "v1", "v2")).toBeNull();
    expect(createVersionPatch("Plan\n", "Plan", "v1", "v2")).toBeNull();
  });
  it("keeps real line changes", () => {
    const patch = createVersionPatch("Before", "After\n", "v1", "v2");
    expect(patch).toContain("@@");
    expect(patch).toContain("-Before");
    expect(patch).toContain("+After");
  });
});
