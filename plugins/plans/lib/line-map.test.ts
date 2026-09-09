import { describe, expect, it } from "vitest";
import { quoteLineRange } from "./line-map";

describe("quoteLineRange", () => {
  it("maps headings, bullets, emphasis and code across source lines", () => {
    const markdown = "# Storage migration\n\n- **Migrate** the users\n  table `first`\n\n```sql\nSELECT users\nFROM accounts\n```";
    expect(quoteLineRange(markdown, "Migrate the users table first")).toEqual({ start: 3, end: 4 });
    expect(quoteLineRange(markdown, " SELECT   users\nFROM accounts ")).toEqual({ start: 7, end: 8 });
    expect(quoteLineRange(markdown, "Storage migration")).toEqual({ start: 1, end: 1 });
  });
  it("omits missing, repeated and overlapping matches", () => {
    expect(quoteLineRange("One\nOne", "One")).toBeNull();
    expect(quoteLineRange("aaaa", "aaa")).toBeNull();
    expect(quoteLineRange("One", "Two")).toBeNull();
    expect(quoteLineRange("One", " ")).toBeNull();
  });
  it("keeps blank and fenced line offsets", () => {
    expect(quoteLineRange("\n\n~~~\nhello\nworld\n~~~", "hello world")).toEqual({ start: 4, end: 5 });
  });
});

it("preserves identifiers and literal fenced code", () => {
  expect(quoteLineRange("- `api_key` is **required**", "api_key is required")).toEqual({ start: 1, end: 1 });
  expect(quoteLineRange("```\na * b + user_id\n```", "a * b + user_id")).toEqual({ start: 2, end: 2 });
});

it.each([
  ["Inline a * b * c", 2, 2],
  ["First line second line", 4, 5],
  ["Heading", 1, 1],
  ["Nested item", 8, 8],
  ["const value = a * b * c;", 11, 11],
] as const)("maps %s to its exact source lines", (quote, start, end) => {
  const markdown = "## Heading\nInline `a * b * c`\n\n> First line\n> second line\n\n- Parent\n  - **Nested** item\n\n```ts\nconst value = a * b * c;\n```";
  expect(quoteLineRange(markdown, quote)).toEqual({ start, end });
});
