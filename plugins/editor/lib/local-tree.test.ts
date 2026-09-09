import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listLocalTree } from "./local-tree";
import { buildTree } from "./file-tree";

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "erwin-editor-tree-"));
  await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
  await mkdir(path.join(root, ".git", "objects"), { recursive: true });
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(path.join(root, ".env"), "");
  await writeFile(path.join(root, ".gitignore"), "");
  await writeFile(path.join(root, ".DS_Store"), "");
  await writeFile(path.join(root, ".github", "workflows", "ci.yml"), "");
  await writeFile(path.join(root, "src", "index.ts"), "");
  await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "");
  await symlink(path.join(root, "src"), path.join(root, "src-link"));
  await symlink(path.join(root, "missing"), path.join(root, "dangling"));
  await symlink(os.homedir(), path.join(root, "escape"));
  await symlink(path.join(root, "src", "index.ts"), path.join(root, "index-link.ts"));
  await symlink("/etc/hosts", path.join(root, "leak.txt"));
  return root;
}

test("listLocalTree includes dotfiles, hides VCS internals, and defers node_modules and symlinked dirs", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { entries, truncated } = await listLocalTree(root, "", 1000);
  assert.equal(truncated, false);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  assert.ok(byPath.has(".env"));
  assert.ok(byPath.has(".gitignore"));
  assert.ok(byPath.has(".github/workflows/ci.yml"));
  assert.ok(!byPath.has(".git"));
  assert.ok(!byPath.has(".DS_Store"));
  assert.deepEqual(byPath.get("node_modules"), { path: "node_modules", kind: "directory", deferred: true });
  assert.ok(!byPath.has("node_modules/pkg"));
  assert.deepEqual(byPath.get("src-link"), { path: "src-link", kind: "directory", deferred: true });
  assert.ok(!byPath.has("dangling"));
  // A deferred directory lists one level on request, with workspace-relative
  // paths and its own directories deferred.
  const inner = await listLocalTree(root, "node_modules", 1000);
  assert.deepEqual(inner.entries, [{ path: "node_modules/pkg", kind: "directory", deferred: true }]);
  const deeper = await listLocalTree(root, "node_modules/pkg", 1000);
  assert.deepEqual(deeper.entries, [{ path: "node_modules/pkg/index.js", kind: "file" }]);
  // A symlink inside the workspace lists; one that leaves it lists nothing.
  const linked = await listLocalTree(root, "src-link", 1000);
  assert.deepEqual(linked.entries, [{ path: "src-link/index.ts", kind: "file" }]);
  assert.ok(!byPath.has("escape"));
  assert.deepEqual(await listLocalTree(root, "escape", 1000), { entries: [], truncated: false });
  assert.deepEqual(byPath.get("index-link.ts"), { path: "index-link.ts", kind: "file" });
  assert.ok(!byPath.has("leak.txt"));
  // The limit truncates instead of listing forever.
  const capped = await listLocalTree(root, "", 2);
  assert.equal(capped.entries.length, 2);
  assert.equal(capped.truncated, true);
});

test("buildTree carries deferred through to the node", () => {
  const nodes = buildTree([
    { path: "node_modules", kind: "directory", deferred: true },
    { path: "src", kind: "directory" },
    { path: "src/a.ts", kind: "file" },
  ]);
  assert.deepEqual(
    nodes.map((node) => [node.name, node.deferred]),
    [
      ["node_modules", true],
      ["src", false],
    ],
  );
});
