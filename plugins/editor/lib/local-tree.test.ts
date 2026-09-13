import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listLocalFiles, listLocalTree } from "./local-tree";
import { buildTree } from "./file-tree";

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "editor-tree-"));
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
  // A link cycle: walking it must not loop the file index.
  await symlink(root, path.join(root, "src", "loop"));
  return root;
}

test("listLocalTree lists one level, includes dotfiles, hides VCS internals, and defers every directory", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const entries = await listLocalTree(root, "");
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  assert.deepEqual(entries.filter((entry) => entry.kind === "directory"), [
    { path: ".github", kind: "directory", deferred: true },
    { path: "node_modules", kind: "directory", deferred: true },
    { path: "src", kind: "directory", deferred: true },
    { path: "src-link", kind: "directory", deferred: true, link: { target: path.join(root, "src") } },
  ]);
  assert.ok(byPath.has(".env"));
  assert.ok(byPath.has(".gitignore"));
  // One level only: a directory's contents wait for its own listing.
  assert.ok(!byPath.has(".github/workflows"));
  assert.ok(!byPath.has("src/index.ts"));
  assert.ok(!byPath.has(".git"));
  assert.ok(!byPath.has(".DS_Store"));
  // A symlink inside the workspace lists with its target; one that leaves
  // the workspace lists nothing; a dangling one lists as broken.
  assert.ok(!byPath.has("escape"));
  assert.deepEqual(await listLocalTree(root, "escape"), []);
  assert.deepEqual(byPath.get("index-link.ts"), {
    path: "index-link.ts",
    kind: "file",
    link: { target: path.join(root, "src", "index.ts") },
  });
  assert.ok(!byPath.has("leak.txt"));
  assert.deepEqual(byPath.get("dangling"), {
    path: "dangling",
    kind: "file",
    link: { target: path.join(root, "missing"), broken: true },
  });
  // Each deferred directory lists one level on request, with
  // workspace-relative paths and its own directories deferred.
  const inner = await listLocalTree(root, "node_modules");
  assert.deepEqual(inner, [{ path: "node_modules/pkg", kind: "directory", deferred: true }]);
  const deeper = await listLocalTree(root, "node_modules/pkg");
  assert.deepEqual(deeper, [{ path: "node_modules/pkg/index.js", kind: "file" }]);
  const linked = await listLocalTree(root, "src-link");
  assert.deepEqual(linked, [
    { path: "src-link/index.ts", kind: "file" },
    { path: "src-link/loop", kind: "directory", deferred: true, link: { target: root } },
  ]);
});

test("listLocalFiles walks everything the search index needs, once per real directory", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = await listLocalFiles(root);
  // src-link reaches src's contents through a link; they index under the
  // real name only, and the link cycle back to the root does not loop.
  assert.deepEqual(
    [...files].sort(),
    [".env", ".gitignore", ".github/workflows/ci.yml", "index-link.ts", "src/index.ts"].sort(),
  );
  // A link cycle terminates instead of recursing forever.
  const filesAgain = await listLocalFiles(root);
  assert.deepEqual(filesAgain.sort(), files.sort());
});

test("buildTree carries a symbolic link's target through to the node", () => {
  const nodes = buildTree([
    { path: "src-link", kind: "directory", deferred: true, link: { target: "/repo/src" } },
    { path: "broken", kind: "file", link: { target: "/repo/missing", broken: true } },
    { path: "plain.ts", kind: "file" },
  ]);
  assert.deepEqual(
    nodes.map((node) => [node.name, node.link]),
    [
      ["src-link", { target: "/repo/src" }],
      ["broken", { target: "/repo/missing", broken: true }],
      ["plain.ts", null],
    ],
  );
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
