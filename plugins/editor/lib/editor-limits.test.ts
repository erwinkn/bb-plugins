import assert from "node:assert/strict";
import test from "node:test";
import { contentShape, DEFAULT_EDITOR_LIMITS, limitTier, limitTierForShape } from "./editor-limits";

// The tiers come from measuring the real Pierre 1.4.1 bundle: nothing up to
// the 8 MB transport cap failed to render, highlighting is what makes a big
// file slow to become editable, and wrapped long lines are the only measured
// keystroke cliff.

test("the generated file that crashed the pane belongs in the full editor", () => {
  // The incident file: a generated JS validator, 459,211 bytes / 10,546 lines
  // with a 1,184-character longest line. Measured: ~1.1 s to editable.
  const long = `validate(${'"x"'.repeat(400)});`; // ~1,208 characters
  const lines = [long];
  while (lines.length < 10_545) lines.push(`const field${lines.length} = check(schema.f${lines.length}, input);`);
  lines.push(long);
  const content = lines.join("\n");
  const shape = contentShape(content);
  assert.ok(shape.bytes > 450_000, `about 459 KB, got ${shape.bytes}`);
  assert.equal(shape.lines, 10_546);
  assert.ok(shape.maxLineLength > 1_000);
  assert.equal(limitTierForShape(shape).tier, "editor");
});

test("an ordinary file stays in the highlighted tier", () => {
  assert.equal(limitTier("const a = 1;\n".repeat(500)).tier, "editor");
});

test("each read-only bound triggers on its own", () => {
  const { interactive } = DEFAULT_EDITOR_LIMITS;
  assert.equal(limitTier("x".repeat(interactive.bytes + 1)).tier, "read-only");
  assert.equal(limitTier("\n".repeat(interactive.lines + 1)).tier, "read-only");
  assert.equal(limitTier(`a${"x".repeat(interactive.maxLineLength + 1)}`).tier, "read-only");
  const over = limitTier("x".repeat(interactive.bytes + 1));
  assert.match(over.reason!, /too large/);
});

test("a big normal file loses highlighting but stays editable", () => {
  const { highlight } = DEFAULT_EDITOR_LIMITS;
  const wide = limitTier("x".repeat(highlight.bytes + 1));
  assert.equal(wide.tier, "unhighlighted");
  assert.match(wide.highlightDetail!, /KB/);
  const tall = limitTier("\n".repeat(highlight.lines + 1));
  assert.equal(tall.tier, "unhighlighted");
  assert.match(tall.highlightDetail!, /lines/);
  // Just under both bounds keeps highlighting.
  assert.equal(
    limitTier(Array.from({ length: highlight.lines }, () => "x".repeat(10)).join("\n")).tier,
    "editor",
  );
});

test("the read-only tier wins over the highlight tier", () => {
  const { interactive } = DEFAULT_EDITOR_LIMITS;
  const result = limitTier("\n".repeat(interactive.lines + 1));
  assert.equal(result.tier, "read-only");
  assert.ok(result.reason !== null);
  // The highlight bound is still reported: a force-opened file stays dim.
  assert.ok(result.highlightDetail !== null);
});

test("user limits reshape the tiers", () => {
  const limits = structuredClone(DEFAULT_EDITOR_LIMITS);
  limits.highlight.bytes = 10;
  assert.equal(limitTier("const a = 1;\n".repeat(10), limits).tier, "unhighlighted");
  limits.interactive.bytes = 10;
  assert.equal(limitTier("const a = 1;\n".repeat(10), limits).tier, "read-only");
  // A zero limit is a valid way to turn highlighting off everywhere.
  limits.highlight.bytes = 0;
  limits.interactive.bytes = DEFAULT_EDITOR_LIMITS.interactive.bytes;
  assert.equal(limitTier("a", limits).tier, "unhighlighted");
});

test("the byte count is UTF-8, not UTF-16 units", () => {
  const shape = contentShape("héllo €\n");
  assert.equal(shape.bytes, Buffer.byteLength("héllo €\n", "utf8"));
});
