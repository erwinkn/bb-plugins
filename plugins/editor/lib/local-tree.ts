/**
 * Lists a workspace on this machine for the file tree, the way code editors
 * do: hidden files and directories included. BB's own lister (the host
 * daemon's `list_paths`) drops every dotfile, `node_modules`, and symlinks
 * with no way to opt in, so workspaces on the local host are read directly.
 *
 * Skipped entirely: VS Code's default `files.exclude` (`.git`, `.hg`, `.svn`,
 * `.DS_Store`, `Thumbs.db`). Listed but not descended into: `node_modules`
 * and directory symlinks; those come back `deferred` and load when expanded.
 * Symlinks whose target lies outside the workspace are omitted.
 */
import { lstat, opendir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Stats } from "node:fs";

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
  // The walk reads the resolved directory, never the path that named it, so
  // a symlink swapped after the check cannot lead it elsewhere. A symlinked
  // directory lists only when it stays inside the workspace; one that points
  // elsewhere shows as an empty folder.
  let root: string;
  try {
    root = await realpath(rootPath);
  } catch {
    return { entries, truncated: false };
  }
  const real = await resolveInside(root, start);
  if (real === null) return { entries, truncated: false };
  const truncated = await walk(real, subpath, { root, out: entries, limit, recurse: subpath === "" });
  return { entries, truncated };
}

/** The real path of `target` when it is the (real) workspace root or under it; null otherwise. */
async function resolveInside(root: string, target: string): Promise<string | null> {
  try {
    const real = await realpath(target);
    return isInside(root, real) ? real : null;
  } catch {
    return null;
  }
}

function isInside(root: string, real: string): boolean {
  if (real === root) return true;
  // A root that is itself the filesystem root already ends with the separator.
  return real.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

interface Walk {
  /** Real path of the workspace root; symlinks may only point inside it. */
  root: string;
  out: TreeEntry[];
  limit: number;
  recurse: boolean;
}

/**
 * Returns true when `limit` stopped the walk. `relativeDir` is the
 * workspace-relative name of `dir`. Entries stream from the directory and
 * stop at the limit, so a directory with millions of entries costs no more
 * than the limit.
 *
 * Node has no fd-relative directory reads, so a walk cannot be made fully
 * race-free. A child directory is checked before and after it is read: it
 * must be a real directory (not a symlink) with the same identity both
 * times, or its entries are dropped. What remains is a swap and swap-back
 * inside one read.
 */
async function walk(dir: string, relativeDir: string, walkState: Walk): Promise<boolean> {
  const { root, out, limit, recurse } = walkState;
  let handle;
  try {
    handle = await opendir(dir);
  } catch {
    return false;
  }
  try {
    for await (const dirent of handle) {
      if (EXCLUDED_NAMES.has(dirent.name)) continue;
      if (out.length >= limit) return true;
      const absolute = path.join(dir, dirent.name);
      const relative = relativeDir === "" ? dirent.name : `${relativeDir}/${dirent.name}`;
      if (dirent.isDirectory()) {
        if (!recurse || DEFERRED_DIRECTORY_NAMES.has(dirent.name)) {
          out.push({ path: relative, kind: "directory", deferred: true });
          continue;
        }
        // A directory that fails its identity check (replaced meanwhile, or a
        // junction that lstat does not report as a directory) is listed as
        // deferred, so expanding it goes through the resolved-path check.
        const before = await directoryIdentity(absolute);
        if (before === null) {
          out.push({ path: relative, kind: "directory", deferred: true });
          continue;
        }
        out.push({ path: relative, kind: "directory" });
        const mark = out.length;
        const truncated = await walk(absolute, relative, walkState);
        const after = await directoryIdentity(absolute);
        if (after === null || after.ino !== before.ino || after.dev !== before.dev) {
          out.length = mark;
          out[mark - 1] = { path: relative, kind: "directory", deferred: true };
        }
        if (truncated) return true;
        continue;
      }
      if (dirent.isSymbolicLink()) {
        // Only links that stay inside the workspace are listed; one that points
        // elsewhere would let file operations reach its target.
        let target;
        try {
          target = await stat(absolute);
          if (!isInside(root, await realpath(absolute))) continue;
        } catch {
          continue; // dangling
        }
        out.push(target.isDirectory() ? { path: relative, kind: "directory", deferred: true } : { path: relative, kind: "file" });
        continue;
      }
      if (dirent.isFile()) out.push({ path: relative, kind: "file" });
    }
  } catch {
    return false;
  }
  return false;
}

/** dev/ino of the real directory at `absolute`, or null when it is not one (or is a symlink). */
async function directoryIdentity(absolute: string): Promise<Pick<Stats, "dev" | "ino"> | null> {
  try {
    const info = await lstat(absolute);
    return info.isDirectory() ? { dev: info.dev, ino: info.ino } : null;
  } catch {
    return null;
  }
}
