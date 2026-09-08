import assert from "node:assert/strict";
import test from "node:test";
import { parsePatchFiles } from "@pierre/diffs";
import { fileDiffFromPatch, loadedSides, patchRowEstimate, sidesMatchPatch } from "./bb-diff";

const OLD = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const NEW = ["one", "two", "THREE", "four", "five", "six", "seven", "eight", "NINE", "ten", "eleven"];

const PATCH = `diff --git a/notes.txt b/notes.txt
--- a/notes.txt
+++ b/notes.txt
@@ -1,5 +1,5 @@
 one
 two
-three
+THREE
 four
 five
@@ -7,4 +7,5 @@
 seven
 eight
-nine
+NINE
 ten
+eleven
`;

const join = (lines: string[], eol = "\n") => lines.join(eol) + eol;

test("a single-file patch gives the file Pierre draws", () => {
  const fileDiff = fileDiffFromPatch(parsePatchFiles, PATCH, "test");
  assert.ok(fileDiff !== null);
  assert.equal(fileDiff.name, "notes.txt");
  assert.equal(fileDiff.type, "change");
  assert.equal(fileDiff.hunks.length, 2);
  assert.equal(fileDiff.isPartial, true);
});

test("the row estimate counts hunk lines and one separator per hunk", () => {
  // 2 separators + 6 + 6 hunk lines; the headers before the first @@ do not count.
  assert.equal(patchRowEstimate(PATCH), 14);
  assert.equal(patchRowEstimate(""), 0);
});

test("text that is not a patch gives nothing rather than throwing", () => {
  assert.equal(fileDiffFromPatch(parsePatchFiles, "just some words\n", "test"), null);
  assert.equal(fileDiffFromPatch(parsePatchFiles, "", "test"), null);
});

test("sides that agree with every hunk are accepted, with any line ending", () => {
  const fileDiff = fileDiffFromPatch(parsePatchFiles, PATCH, "test")!;
  assert.equal(sidesMatchPatch(fileDiff, join(OLD), join(NEW)), true);
  assert.equal(sidesMatchPatch(fileDiff, join(OLD, "\r\n"), join(NEW, "\r\n")), true);
  assert.equal(sidesMatchPatch(fileDiff, OLD.join("\n"), NEW.join("\n")), true, "no final newline");
});

test("a side that disagrees with the patch is refused", () => {
  const fileDiff = fileDiffFromPatch(parsePatchFiles, PATCH, "test")!;
  const shifted = ["zero", ...OLD];
  assert.equal(sidesMatchPatch(fileDiff, join(shifted), join(NEW)), false, "old side shifted by a line");
  const edited = NEW.map((line) => (line === "eleven" ? "twelve" : line));
  assert.equal(sidesMatchPatch(fileDiff, join(OLD), join(edited)), false, "an added line differs");
  assert.equal(sidesMatchPatch(fileDiff, join(OLD.slice(0, 8)), join(NEW)), false, "old side ends early");
  assert.equal(sidesMatchPatch(fileDiff, "", ""), false);
});

test("loadedSides hands Pierre both files only for a changed file whose sides agree", () => {
  const fileDiff = fileDiffFromPatch(parsePatchFiles, PATCH, "test")!;
  const sides = { old: { path: "notes.txt", content: join(OLD) }, new: { path: "notes.txt", content: join(NEW) } };
  const loaded = loadedSides(fileDiff, sides);
  assert.ok(loaded !== null);
  assert.equal(loaded.oldFile?.name, "notes.txt");
  assert.equal(loaded.newFile.contents, join(NEW));
  assert.equal(loadedSides(fileDiff, null), null);
  assert.equal(loadedSides(fileDiff, { ...sides, old: { path: "notes.txt", content: join(NEW) } }), null);

  const added = fileDiffFromPatch(parsePatchFiles, `diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+alpha
+beta
`, "test")!;
  assert.equal(added.type, "new");
  assert.equal(loadedSides(added, { old: { path: "new.txt", content: "" }, new: { path: "new.txt", content: "alpha\nbeta\n" } }), null);
});
