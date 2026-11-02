import { expect, it } from "vitest";
import { COMPACTION_PROMPT } from "../lib/prompt";
import { bytes, TARGET_BYTES } from "../lib/tree";

// W572: the compaction prompt shows bad and good lines for real inputs.
const examples = COMPACTION_PROMPT.slice(COMPACTION_PROMPT.indexOf("# Mistakes to avoid"));

it("pairs each example's bad line with a good one that fits the target, and stays a small prefix", () => {
  const bad = examples.match(/^ {3}Bad: .+$/gm) ?? [];
  const good = examples.match(/^ {3}Good: .+$/gm) ?? [];
  expect(bad.length).toBeGreaterThanOrEqual(2);
  expect(good.length).toBe(bad.length);
  // Models copy their examples' length: a good line never shows more than a line may hold.
  for (const line of good) expect(bytes(line.replace(/^ {3}Good: /, ""))).toBeLessThanOrEqual(TARGET_BYTES);
  // Every call sends the prompt first: it stays well under the size of a <chat> context.
  expect(bytes(COMPACTION_PROMPT)).toBeLessThan(6_000);
});
