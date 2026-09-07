/**
 * Lists a workspace on this machine for the file tree, the way code editors
 * do: hidden files and directories included. BB's own lister (the host
 * daemon's `list_paths`) drops every dotfile, `node_modules`, and symlinks
 * with no way to opt in, so workspaces on the local host are read directly.
 *
 * Skipped entirely: VS Code's default `files.exclude` (`.git`, `.hg`, `.svn`,
 * `.DS_Store`, `Thumbs.db`). Listed but not descended into: `node_modules`
 * and directory symlinks; those come back `deferred` and load when expanded.
 */
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";

export interface TreeEntry {
  /** Workspace-relative POSIX path. */
  path: string;
  kind: "file" | "directory";
  /** Directory whose contents were not listed; expand it to list them. */
  deferred?: true;
}

export interface TreeListing {
  entries: TreeEntry[];
  truncated: boolean;
}

const EXCLUDED_NAMES = new Set([".git", ".hg", ".svn", ".DS_Store", "Thumbs.db"]);
const DEFERRED_DIRECTORY_NAMES = new Set(["node_modules"]);

/**
 * Entries under `rootPath/subpath` (relative to `rootPath`), at most `limit`
 * of them. The workspace root (`subpath` empty) lists in full, depth first,
 * so quick open sees every file. A deferred directory lists one level, with
 * its child directories deferred in turn: `node_modules` alone can exceed
 * any limit, and a depth-first walk would spend it inside the first child.
 * The directory named by `subpath` is not an entry itself.
 */
export async function listLocalTree(rootPath: string, subpath: string, limit: number): Promise<TreeListing> {
  const entries: TreeEntry[] = [];
  const start = subpath === "" ? rootPath : path.join(rootPath, ...subpath.split("/"));
  // A symlinked directory is listed only when it stays inside the workspace;
  // one that points elsewhere shows as an empty folder.
  if (subpath !== "" && !(await staysInside(rootPath, start))) return { entries, truncated: false };
  const truncated = await walk(start, rootPath, entries, limit, subpath === "");
  return { entries, truncated };
}

async function staysInside(rootPath: string, target: string): Promise<boolean> {
  try {
    const root = await realpath(rootPath);
    const real = await realpath(target);
    return real === root || real.startsWith(root + path.sep);
  } catch {
    return false;
  }
}

/** Returns true when `limit` stopped the walk. */
async function walk(dir: string, root: string, out: TreeEntry[], limit: number, recurse: boolean): Promise<boolean> {
  let dirents: Dirent[];
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  dirents.sort((a, b) => a.name.localeCompare(b.name));
  for (const dirent of dirents) {
    if (EXCLUDED_NAMES.has(dirent.name)) continue;
    if (out.length >= limit) return true;
    const absolute = path.join(dir, dirent.name);
    const relative = toPosix(path.relative(root, absolute));
    if (dirent.isDirectory()) {
      if (!recurse || DEFERRED_DIRECTORY_NAMES.has(dirent.name)) {
        out.push({ path: relative, kind: "directory", deferred: true });
        continue;
      }
      out.push({ path: relative, kind: "directory" });
      if (await walk(absolute, root, out, limit, recurse)) return true;
      continue;
    }
    if (dirent.isSymbolicLink()) {
      let target;
      try {
        target = await stat(absolute);
      } catch {
        continue; // dangling
      }
      out.push(target.isDirectory() ? { path: relative, kind: "directory", deferred: true } : { path: relative, kind: "file" });
      continue;
    }
    if (dirent.isFile()) out.push({ path: relative, kind: "file" });
  }
  return false;
}

function toPosix(relative: string): string {
  return relative.split(path.sep).join("/");
}
