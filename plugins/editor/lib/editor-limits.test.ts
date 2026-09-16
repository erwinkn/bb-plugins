import assert from "node:assert/strict";
import test from "node:test";
import { contentShape, exceedsInteractiveLimits, INTERACTIVE_LIMITS } from "./editor-limits";

test("the generated file that crashed the pane exceeds the interactive limit", () => {
  // The incident file: a generated JS validator, 459,211 bytes / 10,546 lines
  // with a 1,184-character longest line.
  const long = `validate(${'"x"'.repeat(400)});`; // ~1,208 characters
  const lines = [long];
  while (lines.length < 10_545) lines.push(`const field${lines.length} = check(schema.f${lines.length}, input);`);
  lines.push(long);
  const content = lines.join("\n");
  const shape = contentShape(content);
  assert.ok(shape.bytes > 450_000, `about 459 KB, got ${shape.bytes}`);
  assert.equal(shape.lines, 10_546);
  assert.ok(shape.maxLineLength > 1_000);
  const over = exceedsInteractiveLimits(content);
  assert.ok(over !== null);
  assert.match(over!.reason, /too large/);
});

test("an ordinary file stays inside the limit", () => {
  assert.equal(exceedsInteractiveLimits("const a = 1;\n".repeat(500)), null);
});

test("each bound triggers on its own", () => {
  assert.ok(exceedsInteractiveLimits("x".repeat(INTERACTIVE_LIMITS.bytes + 1)));
  assert.ok(exceedsInteractiveLimits("\n".repeat(INTERACTIVE_LIMITS.lines + 1)));
  assert.ok(exceedsInteractiveLimits(`a${"x".repeat(INTERACTIVE_LIMITS.maxLineLength + 1)}`));
  // Just under every bound passes.
  assert.equal(
    exceedsInteractiveLimits(
      Array.from({ length: INTERACTIVE_LIMITS.lines }, () => "x".repeat(10)).join("\n"),
    ),
    null,
  );
});

test("the byte count is UTF-8, not UTF-16 units", () => {
  const shape = contentShape("héllo €\n");
  assert.equal(shape.bytes, Buffer.byteLength("héllo €\n", "utf8"));
});
