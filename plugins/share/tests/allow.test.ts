import { describe, expect, it } from "vitest";
import { matches, normalizeEntry, normalizeEntries } from "../lib/allow";

describe("allow list", () => {
  it("normalizes and deduplicates conventional addresses and domains", () => {
    expect(normalizeEntries([" Person+tag@Example.COM ", "person+tag@example.com", " @EXAMPLE.COM "])).toEqual(["person+tag@example.com", "@example.com"]);
  });
  it("matches exact emails and exact domains case-insensitively", () => {
    expect(matches(["PERSON@example.com"], "person@EXAMPLE.COM")).toBe(true);
    expect(matches(["@Example.com"], "PERSON@example.com")).toBe(true);
    expect(matches(["@example.com"], "person@sub.example.com")).toBe(false);
    expect(matches(["person@example.com"], "other@example.com")).toBe(false);
    expect(matches(["@example.com"], "@example.com")).toBe(false);
    expect(matches(["@example.com"], null)).toBe(false);
    expect(matches([], null)).toBe(true);
  });
  it.each(["", "person", "x@localhost", "@localhost", "@@example.com", "a b@example.com", "a..b@example.com", ".a@example.com", "a@-example.com", "a@example..com", "*@example.com*", "https://example.com", "@example.com/path"])("rejects %j with the entry in the error", (entry) => {
    expect(() => normalizeEntry(entry)).toThrow(JSON.stringify(entry));
  });
});
