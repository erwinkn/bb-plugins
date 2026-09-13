/**
 * Lists a workspace on this machine for the file tree, the way code editors
 * do: one level at a time, hidden files and directories included, and every
 * directory deferred so its contents load when the user expands it. BB's own
 * lister (the host daemon's `list_paths`) drops every dotfile,
 * `node_modules`, and symlinks with no way to opt in, so workspaces on the
 * local host are read directly. Quick open never walks the tree's entries;
 * it searches its own index (`listLocalFiles`).
 *
 * Skipped entirely: VS Code's default `files.exclude` (`.git`, `.hg`,
 * `.svn`, `.DS_Store`, `Thumbs.db`). Symlinks carry their target; directory
 * symlinks list as deferred folders only when their target stays inside the
 * workspace, and a dangling link lists as a broken file.
 */
import { opendir, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Stats } from "node:fs";
import type { FlatEntry, LinkInfo } from "./file-tree.js";

const EXCLUDED_NAMES = new Set([".git", ".hg", ".svn", ".DS_Store", "Thumbs.db"]);

/** Never walked for quick open, the way `search.exclude` skips them in VS Code. */
const SEARCH_SKIPPED_NAMES = new Set([...EXCLUDED_NAMES, "node_modules", ".bb"]);

/**
 * The entries directly inside `rootPath/subpath` (relative to `rootPath`).
 * Nothing is descended into: every directory comes back `deferred` and lists
 * on demand, so a workspace of any size costs one directory read. The
 * directory named by `subpath` is not an entry itself.
 */
export async function listLocalTree(rootPath: string, subpath: string): Promise<FlatEntry[]> {
  const entries: FlatEntry[] = [];
  const start = subpath === "" ? rootPath : path.join(rootPath, ...subpath.split("/"));
  // The listing reads the resolved directory, never the path that named it,
  // so a symlink swapped after the check cannot lead it elsewhere. A
  // symlinked directory lists only when it stays inside the workspace; one
  // that points elsewhere shows as an empty folder.
  let root: string;
  try {
    root = await realpath(rootPath);
  } catch {
    return entries;
  }
  const real = await resolveInside(root, start);
  if (real === null) return entries;
  let handle;
  try {
    handle = await opendir(real);
  } catch {
    return entries;
  }
  for await (const dirent of handle) {
    if (EXCLUDED_NAMES.has(dirent.name)) continue;
    const relative = subpath === "" ? dirent.name : `${subpath}/${dirent.name}`;
    if (dirent.isDirectory()) {
      entries.push({ path: relative, kind: "directory", deferred: true });
      continue;
    }
    if (dirent.isSymbolicLink()) {
      // A link lists with its target text so the tree can mark it. One whose
      // target is missing lists as broken; only links that stay inside the
      // workspace list otherwise, since one that points elsewhere would let
      // file operations reach its target.
      const absolute = path.join(real, dirent.name);
      let link: LinkInfo;
      try {
        link = { target: await readlink(absolute) };
      } catch {
        continue;
      }
      let target: Stats;
      try {
        target = await stat(absolute);
      } catch {
        entries.push({ path: relative, kind: "file", link: { ...link, broken: true } });
        continue;
      }
      try {
        if (!isInside(root, await realpath(absolute))) continue;
      } catch {
        continue;
      }
      entries.push(
        target.isDirectory() ? { path: relative, kind: "directory", deferred: true, link } : { path: relative, kind: "file", link },
      );
      continue;
    }
    if (dirent.isFile()) entries.push({ path: relative, kind: "file" });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return entries;
}

/**
 * Every file under `rootPath`, as workspace-relative POSIX paths, for quick
 * open's index. Unlike the tree this walk is recursive; the caller caches
 * the result and invalidates it on file-watcher notices, so the cost is paid
 * once per burst of changes rather than once per keystroke. Directories in
 * SEARCH_SKIPPED_NAMES are not descended. Directory symlinks are followed
 * only inside the workspace, and each real directory is walked once, so a
 * link cycle cannot loop the walk.
 */
export async function listLocalFiles(rootPath: string): Promise<string[]> {
  const files: string[] = [];
  let root: string;
  try {
    root = await realpath(rootPath);
  } catch {
    return files;
  }
  const seen = new Set<string>();
  const visit = async (dir: string, relativeDir: string): Promise<void> => {
    // Identity of the real directory, before and after the read: a swap
    // mid-read drops what it listed, and a seen identity stops a link cycle.
    const before = await directoryIdentity(dir);
    if (before === null || seen.has(`${before.dev}:${before.ino}`)) return;
    seen.add(`${before.dev}:${before.ino}`);
    let handle;
    try {
      handle = await opendir(dir);
    } catch {
      return;
    }
    const mark = files.length;
    const entries: { relative: string; dir: string }[] = [];
    try {
      for await (const dirent of handle) {
        if (SEARCH_SKIPPED_NAMES.has(dirent.name)) continue;
        const absolute = path.join(dir, dirent.name);
        const relative = relativeDir === "" ? dirent.name : `${relativeDir}/${dirent.name}`;
        if (dirent.isDirectory()) {
          entries.push({ relative, dir: absolute });
          continue;
        }
        if (dirent.isSymbolicLink()) {
          try {
            const target = await stat(absolute);
            if (!isInside(root, await realpath(absolute))) continue;
            if (target.isDirectory()) entries.push({ relative, dir: absolute });
            else if (target.isFile()) files.push(relative);
          } catch {
            continue; // dangling
          }
          continue;
        }
        if (dirent.isFile()) files.push(relative);
      }
    } catch {
      return;
    }
    const after = await directoryIdentity(dir);
    if (after === null || after.ino !== before.ino || after.dev !== before.dev) {
      files.length = mark;
      return;
    }
    // A directory reachable through both a link and its real path indexes
    // once; sorting makes the real name win regardless of read order.
    entries.sort((left, right) => left.relative.localeCompare(right.relative));
    for (const entry of entries) await visit(entry.dir, entry.relative);
  };
  await visit(root, "");
  return files;
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

/** dev/ino of the real directory at `absolute`, following links; null when it is not one. */
async function directoryIdentity(absolute: string): Promise<Pick<Stats, "dev" | "ino"> | null> {
  try {
    const info = await stat(absolute);
    return info.isDirectory() ? { dev: info.dev, ino: info.ino } : null;
  } catch {
    return null;
  }
}
