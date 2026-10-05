import { describe, expect, it } from "vitest";
import {
  decisionFieldsSchema,
  decisionSchema,
  projectContextSchema,
} from "../lib/schema";

describe("projectContextSchema", () => {
  it("defaults empty stored JSON to an empty context", () => {
    expect(projectContextSchema.parse({})).toEqual({
      vision: "",
      objectives: [],
      ideas: [],
    });
  });
  it("rejects unknown fields and overlong values", () => {
    expect(
      projectContextSchema.safeParse({ vision: "x", extra: 1 }).success,
    ).toBe(false);
    expect(
      projectContextSchema.safeParse({ vision: "x".repeat(2001) }).success,
    ).toBe(false);
    expect(
      projectContextSchema.safeParse({ objectives: Array(13).fill("x") })
        .success,
    ).toBe(false);
    expect(
      projectContextSchema.safeParse({ ideas: ["x".repeat(501)] }).success,
    ).toBe(false);
  });
});

describe("decisionSchema options", () => {
  const base = {
    title: "Search privacy",
    humanAttention: "needs-opinion" as const,
    question: "Include private notes in search?",
    context: "Teammates could discover content that used to be private.",
  };
  it("rejects duplicate labels after normalization", () => {
    for (const label of [" exclude ", "EXCLUDE"])
      expect(
        decisionSchema.safeParse({
          ...base,
          options: [
            { label: "Exclude", consequences: "Private notes stay hidden." },
            { label, consequences: "Something else." },
          ],
        }).success,
      ).toBe(false);
  });
  it("accepts distinct labels", () => {
    expect(
      decisionSchema.safeParse({
        ...base,
        options: [
          { label: "Exclude", consequences: "Private notes stay hidden." },
          { label: "Include", consequences: "The full index is searchable." },
        ],
      }).success,
    ).toBe(true);
  });
  it("still decodes older stored decisions carrying duplicate labels", () => {
    expect(
      decisionFieldsSchema.safeParse({
        ...base,
        options: [
          { label: "Exclude", consequences: "Private notes stay hidden." },
          { label: "Exclude", consequences: "Duplicate on disk." },
        ],
      }).success,
    ).toBe(true);
  });
});
