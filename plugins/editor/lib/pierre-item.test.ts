import assert from "node:assert/strict";
import test from "node:test";
import { parseDiffFromFile } from "@pierre/diffs";
import { createPierreItem, type PierreItemInput } from "./pierre-item";

const base: PierreItemInput = {
  id: "one", name: "after.txt", cachePrefix: "test", version: 1, editable: true, content: "same\n", oldContent: "same\n",
};

test("a pure rename and an identical comparison show the existing editable file", () => {
  for (const oldName of ["before.txt", "after.txt"]) {
    const item = createPierreItem({ ...base, oldName }, parseDiffFromFile);
    assert.equal(item.type, "file");
    assert.equal(item.file.name, "after.txt");
    assert.equal(item.file.contents, "same\n");
    assert.equal(item.edit, true);
  }
});

test("empty added and deleted files render without inventing a newline or writable deleted side", () => {
  const added = createPierreItem({ ...base, content: "", oldContent: null }, parseDiffFromFile);
  assert.equal(added.type, "file");
  assert.equal(added.file.contents, "");
  assert.equal(added.edit, true);
  const deleted = createPierreItem({ ...base, content: null, oldContent: "", oldName: "gone.txt" }, parseDiffFromFile);
  assert.equal(deleted.type, "file");
  assert.equal(deleted.file.contents, "");
  assert.equal(deleted.file.name, "gone.txt");
  assert.equal(deleted.edit, false);
  const identicalEmpty = createPierreItem({ ...base, content: "", oldContent: "" }, parseDiffFromFile);
  assert.equal(identicalEmpty.type, "file");
  assert.equal(identicalEmpty.file.contents, "");
});

test("typing into a file fallback preserves its item type, text, and edit permission", () => {
  const initial = createPierreItem(base, parseDiffFromFile);
  const typed = createPierreItem({ ...base, content: "new text\n", version: 2, renderType: initial.type }, parseDiffFromFile);
  assert.equal(typed.type, "file");
  assert.equal(typed.file.contents, "new text\n");
  assert.equal(typed.edit, true);
  const mirror = createPierreItem({ ...base, content: "new text\n", version: 3, renderType: initial.type, editable: false }, parseDiffFromFile);
  assert.equal(mirror.type, "file");
  assert.equal(mirror.file.contents, "new text\n");
  assert.equal(mirror.edit, false);
  assert.equal(createPierreItem({ ...base, content: "new text\n" }, parseDiffFromFile).type, "diff", "a new comparison can display the new text changes");
});

test("nonempty additions, deletions, and modifications remain proper diffs", () => {
  for (const [oldContent, content] of [[null, "added\n"], ["deleted\n", null], ["old\n", "new\n"]] as const) {
    const item = createPierreItem({ ...base, oldContent, content }, parseDiffFromFile);
    assert.equal(item.type, "diff");
    assert.ok(item.fileDiff.hunks.length > 0);
    assert.equal(item.edit, content !== null);
  }
});
