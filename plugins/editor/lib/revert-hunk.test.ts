import assert from "node:assert/strict";
import test from "node:test";
import { parseDiffFromFile, diffAcceptRejectHunk } from "@pierre/diffs";
import { revertHunkEdit } from "./revert-hunk";
const runtime = { parseDiffFromFile, diffAcceptRejectHunk };
function reverted(old: string | null, current: string, line: number, side: "additions" | "deletions" = "additions") {
  const edit = revertHunkEdit(runtime, "test.txt", old, current, line, side);
  if (!edit) return current;
  const offset = (position: { line: number; character: number }) => current.split("\n").slice(0, position.line).reduce((n, value) => n + value.length + 1, 0) + position.character;
  return current.slice(0, offset(edit.range.start)) + edit.newText + current.slice(offset(edit.range.end));
}
for (const [name, old, current] of [
  ["replacement", "one\ntwo\n", "one\nthree\n"],
  ["deletion", "one\ntwo\n", "one\n"],
  ["addition", "one\n", "one\ntwo\n"],
  ["CRLF", "one\r\ntwo\r\n", "one\r\nthree\r\n"],
  ["no final newline", "one\ntwo", "one\nthree"],
  ["remove final newline", "one\n", "one"],
  ["empty original", "", "added\n"],
  ["empty working file", "old\n", ""],
  ["Unicode", "🥖 café\n", "🥐 茶\n"],
] as const) test(`revert hunk: ${name}`, () => assert.equal(reverted(old, current, 1), old));
test("revert hunk: new file becomes empty without deleting the file", () => assert.equal(reverted(null, "new\n", 1), ""));
test("revert one hunk keeps distant changes and trailing context", () => {
  const old = Array.from({ length: 80 }, (_, i) => `line ${i}\n`).join("");
  const current = old.replace("line 5\n", "changed 5\n").replace("line 60\n", "changed 60\n");
  assert.equal(reverted(old, current, 6), old.replace("line 60\n", "changed 60\n"));
  assert.equal(reverted(old, current, 61, "deletions"), old.replace("line 5\n", "changed 5\n"));
  assert.equal(reverted(old, current, 35), current);
});
