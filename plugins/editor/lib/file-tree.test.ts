import assert from "node:assert/strict";
import test from "node:test";
import { ancestorsOf, buildTree, filterTree, fuzzyScore, mergeListing } from "./file-tree";

test("buildTree nests flat paths and sorts directories before files", () => {
  const tree = buildTree([
    { path: "readme.md", kind: "file" },
    { path: "src", kind: "directory" },
    { path: "src/index.ts", kind: "file" },
    { path: "src/lib", kind: "directory" },
    { path: "src/lib/util.ts", kind: "file" },
  ]);
  assert.deepEqual(tree.map((node) => node.name), ["src", "readme.md"]);
  assert.deepEqual(tree[0]!.children.map((node) => node.name), ["lib", "index.ts"]);
  assert.equal(tree[0]!.children[0]!.children[0]!.path, "src/lib/util.ts");
});

test("buildTree synthesises directories the listing omitted and sorts case-insensitively", () => {
  const tree = buildTree([
    { path: "a/b/c.ts", kind: "file" },
    { path: "beta.ts", kind: "file" },
    { path: "Alpha.ts", kind: "file" },
  ]);
  assert.deepEqual(tree.map((node) => node.name), ["a", "Alpha.ts", "beta.ts"]);
  assert.equal(tree[0]!.children[0]!.path, "a/b");
});

test("mergeListing replaces direct children, resolves the directory, and keeps deeper levels", () => {
  const merged = mergeListing(
    [
      { path: "src", kind: "directory", deferred: true },
      { path: "src/old.ts", kind: "file" },
      { path: "src/lib", kind: "directory" },
      { path: "src/lib/util.ts", kind: "file" },
      { path: "other.ts", kind: "file" },
    ],
    "src",
    [
      { path: "src/new.ts", kind: "file" },
      { path: "src/lib", kind: "directory" },
      { path: "src/lib/extra.ts", kind: "file" },
    ],
  );
  assert.deepEqual(merged, [
    { path: "src", kind: "directory" },
    { path: "src/new.ts", kind: "file" },
    { path: "src/lib", kind: "directory" },
    { path: "src/lib/extra.ts", kind: "file" },
    // Fetched before this listing, and the listing did not cover the level.
    { path: "src/lib/util.ts", kind: "file" },
    { path: "other.ts", kind: "file" },
  ]);
});

test("mergeListing keeps the resolved directory's own link info", () => {
  const merged = mergeListing(
    [{ path: "src-link", kind: "directory", deferred: true, link: { target: "/repo/src" } }],
    "src-link",
    [{ path: "src-link/index.ts", kind: "file" }],
  );
  assert.deepEqual(merged[0], { path: "src-link", kind: "directory", link: { target: "/repo/src" } });
});

test("mergeListing drops a deleted direct child but keeps its unrelated siblings", () => {
  const merged = mergeListing(
    [
      { path: "src", kind: "directory" },
      { path: "src/gone.ts", kind: "file" },
      { path: "src/kept.ts", kind: "file" },
    ],
    "src",
    [{ path: "src/kept.ts", kind: "file" }],
  );
  assert.deepEqual(merged, [
    { path: "src", kind: "directory" },
    { path: "src/kept.ts", kind: "file" },
  ]);
});

test("ancestorsOf lists each containing directory, nearest last", () => {
  assert.deepEqual(ancestorsOf("a/b/c.ts"), ["a", "a/b"]);
  assert.deepEqual(ancestorsOf("readme.md"), []);
});

test("filterTree keeps matches with their directories and reports which to expand", () => {
  const tree = buildTree([
    { path: "src/index.ts", kind: "file" },
    { path: "src/ui/button.tsx", kind: "file" },
    { path: "docs/guide.md", kind: "file" },
  ]);
  const filtered = filterTree(tree, "BUTTON");
  assert.equal(filtered.matchCount, 1);
  assert.deepEqual(filtered.nodes.map((node) => node.name), ["src"]);
  assert.deepEqual([...filtered.expand].sort(), ["src", "src/ui"]);
  assert.equal(filterTree(tree, "src/ui").matchCount, 1);
  assert.deepEqual(filterTree(tree, "nothing-here").nodes, []);
  assert.equal(filterTree(tree, "   ").nodes.length, 2);
});

test("fuzzyScore requires every character in order and prefers name matches", () => {
  assert.equal(fuzzyScore("src/lib/file-tree.ts", "xyz"), null);
  const nameHit = fuzzyScore("src/lib/file-tree.ts", "filetree")!;
  const pathHit = fuzzyScore("src/file/lib/tree-x.ts", "filetree")!;
  assert.ok(nameHit > pathHit, `${nameHit} > ${pathHit}`);
});
