import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { dirname, join, sep } from "node:path";
import { ProjectError } from "./bb";
import { EDIT_MAX_BYTES, UPLOAD_MAX_BYTES, humanSize as human, type DriveChange, type DriveEntry, type DriveFile, type DriveList, type DriveSave } from "./drive-types";

/**
 * W584: an Adventure's drive, a plain folder of files on the server host (notes, plans,
 * reference docs) that every thread of the Adventure shares, outside git. Agents use it with
 * their normal file tools; the Context tab browses and edits it through the methods below. The
 * filesystem is the only record: the folder appears on the first write and outlives an archive.
 */

/** Files a brief's index names; the rest are counted. */
export const INDEX_MAX = 30;
/** Characters the named files may take in a brief, about 400 tokens; the rest are counted. */
export const INDEX_CHARS = 1500;
const WALK_MAX = 2000;
/** Files the index's walk weighs to find the newest; past it, the count is a lower bound. */
const INDEX_WALK_MAX = 20_000;
const TMP_PREFIX = ".drive-tmp-";
const COALESCE_MS = 250;

/** A refusal: the caller's own mistake, not a fault, so it reads as an Initiative error. */
export class DriveError extends ProjectError {}

/** A drive-relative path as given: "notes/plan.md". No absolute path, `.`/`..`, empty segment or backslash. */
export function cleanPath(path: string): string {
  const segments = path.split("/");
  if (
    !path || path.length > 1024 || path.includes("\0") || path.includes("\\") ||
    segments.some((s) => s === "" || s === "." || s === ".." || s.startsWith(TMP_PREFIX))
  )
    throw new DriveError(`"${path.slice(0, 200)}" is not a path inside the drive: use a relative path like notes/plan.md.`);
  return segments.join("/");
}

const PROJECT_ID = /^[A-Za-z0-9_-]{1,80}$/u;
const isInside = (root: string, real: string) => real === root || real.startsWith(root + sep);
function lstatOrNull(path: string) {
  try {
    return fs.lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function decodeText(bytes: Buffer): string | null {
  if (bytes.length > EDIT_MAX_BYTES || bytes.subarray(0, 8192).includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

const versionOf = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex").slice(0, 32);

export class Drives {
  private titles = new Map<string, { key: string; title: string | null }>();

  constructor(readonly dir: string) {}

  /** The Adventure's folder, whether or not it exists yet. Project ids are the store's own. */
  root(projectId: string) {
    if (!PROJECT_ID.test(projectId)) throw new DriveError("Unknown Initiative.");
    return join(this.dir, projectId);
  }

  /**
   * The drive folder's real path, or null before its first write (`create` makes it). It must be
   * a plain folder right in the drives folder: a link there would move the boundary itself.
   */
  private realRoot(projectId: string, create = false) {
    const base = this.root(projectId);
    if (create) fs.mkdirSync(base, { recursive: true });
    let real: string;
    try {
      real = fs.realpathSync(base);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (real !== join(fs.realpathSync(this.dir), projectId)) throw new DriveError("This Adventure's drive folder is a link; it must be a plain folder.");
    return real;
  }

  /** An existing entry's absolute path; refused when it, or a symlink on its way, leads outside the drive. */
  resolve(projectId: string, path: string): string {
    const root = this.realRoot(projectId);
    const abs = join(this.root(projectId), cleanPath(path));
    let real: string;
    try {
      if (!root) throw Object.assign(new Error(), { code: "ENOENT" });
      real = fs.realpathSync(abs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new DriveError(`${path} is not in the drive.`);
      throw error;
    }
    if (!isInside(root, real)) throw new DriveError(`${path} leads outside the drive.`);
    return abs;
  }

  /**
   * Where a new entry goes: its parent folders are created (the drive folder too, on its first
   * write) once the deepest existing one is checked to be inside the drive. The entry itself may
   * be a symlink: rename and unlink replace the link, never what it points to.
   */
  private place(projectId: string, path: string): string {
    const abs = join(this.root(projectId), cleanPath(path));
    const root = this.realRoot(projectId, true)!;
    let existing = dirname(abs);
    while (!lstatOrNull(existing)) existing = dirname(existing);
    if (!isInside(root, fs.realpathSync(existing))) throw new DriveError(`${path} leads outside the drive.`);
    fs.mkdirSync(dirname(abs), { recursive: true });
    return abs;
  }

  /** Every entry, folders first within a folder, at most WALK_MAX. */
  list(projectId: string): DriveList {
    const entries: DriveEntry[] = [];
    const truncated = this.walk(projectId, WALK_MAX, (abs, path, stat) => {
      const kind = stat.isDirectory() ? "dir" : "file";
      entries.push({ path, kind, size: kind === "dir" ? 0 : stat.size, mtimeMs: Math.round(stat.mtimeMs), title: kind === "file" ? this.title(abs, stat) : null });
    });
    return { root: this.root(projectId), entries, truncated };
  }

  /**
   * Visits at most `max` entries, folders first within a folder; true when it stopped early. A
   * symlink is visited only when it stays inside, and the walk never descends through one.
   */
  private walk(projectId: string, max: number, visit: (abs: string, path: string, stat: fs.Stats, link: boolean) => void): boolean {
    const root = this.realRoot(projectId);
    let count = 0;
    const walk = (dir: string, prefix: string) => {
      let names: fs.Dirent[] = [];
      try {
        names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => !d.name.startsWith(TMP_PREFIX));
      } catch (error) {
        if (dir === root) throw error; // An unreadable folder inside is skipped, like an unreadable entry.
      }
      names.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const d of names) {
        if (count >= max) return;
        const abs = join(dir, d.name), link = d.isSymbolicLink();
        let stat: fs.Stats;
        try {
          if (link && !isInside(root!, fs.realpathSync(abs))) continue;
          stat = fs.statSync(abs);
          if (!stat.isFile() && !stat.isDirectory()) continue;
        } catch {
          continue;
        }
        count++;
        visit(abs, prefix + d.name, stat, link);
        if (stat.isDirectory() && !link) walk(abs, `${prefix}${d.name}/`);
      }
    };
    if (root) walk(root, "");
    return count >= max;
  }

  /** A markdown file's first `#` heading, remembered while the file is unchanged. */
  private title(abs: string, stat: fs.Stats): string | null {
    if (!/\.(md|markdown)$/iu.test(abs)) return null;
    const key = `${stat.size}:${stat.mtimeMs}`;
    const known = this.titles.get(abs);
    if (known?.key === key) return known.title;
    const head = Buffer.alloc(Math.min(stat.size, 4096));
    try {
      const fd = fs.openSync(abs, "r");
      try {
        fs.readSync(fd, head, 0, head.length, 0);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
    const title = /^#[ \t]+(.+)$/mu.exec(head.toString("utf8"))?.[1]?.trim().slice(0, 80) ?? null;
    this.titles.set(abs, { key, title });
    return title;
  }

  read(projectId: string, path: string): DriveFile {
    const abs = this.resolve(projectId, path);
    const stat = fs.statSync(abs);
    if (!stat.isFile()) throw new DriveError(`${path} is not a file.`);
    if (stat.size > EDIT_MAX_BYTES) return { path, size: stat.size, mtimeMs: Math.round(stat.mtimeMs), version: `${stat.size}:${stat.mtimeMs}`, text: null };
    const bytes = fs.readFileSync(abs);
    return { path, size: bytes.length, mtimeMs: Math.round(stat.mtimeMs), version: versionOf(bytes), text: decodeText(bytes) };
  }

  /**
   * Saves text, but only over the version it was loaded at (`base`; null: a new file). Anything
   * else is a conflict that carries the file as it now is (null once it is gone), never an
   * overwrite. The check and the rename run in one synchronous step of this process.
   */
  save(projectId: string, path: string, text: string, base: string | null): DriveSave {
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length > EDIT_MAX_BYTES) throw new DriveError(`The editor saves at most ${human(EDIT_MAX_BYTES)}.`);
    // Conflicts first: a refused save creates nothing, not even the parent folders.
    const existing = lstatOrNull(join(this.root(projectId), cleanPath(path)));
    if (existing ? base === null : base !== null) return { conflict: existing ? this.read(projectId, path) : null };
    if (existing) {
      const current = this.read(projectId, path);
      if (current.version !== base) return { conflict: current };
    }
    atomicWrite(this.place(projectId, path), bytes);
    return { saved: this.read(projectId, path) };
  }

  change(projectId: string, change: DriveChange): void {
    if (change.kind === "mkdir") {
      const abs = this.place(projectId, change.path);
      if (lstatOrNull(abs)) throw new DriveError(`${change.path} already exists.`);
      fs.mkdirSync(abs);
    } else if (change.kind === "upload") {
      const bytes = Buffer.from(change.base64, "base64");
      if (bytes.length > UPLOAD_MAX_BYTES) throw new DriveError(`An upload is at most ${human(UPLOAD_MAX_BYTES)}.`);
      const abs = this.place(projectId, change.path);
      const existing = lstatOrNull(abs);
      if (existing?.isDirectory()) throw new DriveError(`${change.path} is a folder.`);
      if (existing && !change.replace) throw new DriveError(`${change.path} already exists.`);
      atomicWrite(abs, bytes);
    } else if (change.kind === "move") {
      if (`${cleanPath(change.to)}/`.startsWith(`${cleanPath(change.from)}/`)) throw new DriveError("A folder can't move into itself.");
      const from = this.entry(projectId, change.from);
      const to = this.place(projectId, change.to);
      if (lstatOrNull(to)) throw new DriveError(`${change.to} already exists.`);
      fs.renameSync(from, to);
    } else fs.rmSync(this.entry(projectId, change.path), { recursive: true });
  }

  /** An entry to move or delete: the entry itself may be a symlink (only the link is touched); its folder must be inside. */
  private entry(projectId: string, path: string) {
    const clean = cleanPath(path);
    const abs = join(this.root(projectId), clean);
    if (clean.includes("/")) this.resolve(projectId, clean.slice(0, clean.lastIndexOf("/")));
    else if (!this.realRoot(projectId)) throw new DriveError(`${path} is not in the drive.`);
    if (!lstatOrNull(abs)) throw new DriveError(`${path} is not in the drive.`);
    return abs;
  }

  /**
   * One line for briefs and the overview: where the drive is, how to use it, and its newest
   * files (path, size, date, a markdown file's heading), at most INDEX_MAX of them in INDEX_CHARS. Never contents.
   */
  indexLine(projectId: string): string {
    const head = `Adventure drive: ${this.root(projectId)}/, the files this Adventure's threads share (notes, plans, docs), outside git: read and write them with your file tools, no commit. It is on the BB server's machine; from another machine, ask your lead.`;
    const files: { abs: string; path: string; stat: fs.Stats }[] = [];
    let truncated: boolean;
    try {
      truncated = this.walk(projectId, INDEX_WALK_MAX, (abs, path, stat) => void (stat.isFile() && files.push({ abs, path, stat })));
    } catch (error) {
      return `${head} Its file list is unavailable (${(error as Error).message}): ls the folder.`;
    }
    files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    let used = 0;
    const named: string[] = [];
    for (const { abs, path, stat } of files.slice(0, INDEX_MAX)) {
      const title = this.title(abs, stat);
      const item = `${path} (${human(stat.size)}, ${new Date(stat.mtimeMs).toISOString().slice(0, 10)}${title ? `, "${title}"` : ""})`;
      if ((used += item.length + 2) > INDEX_CHARS) break;
      named.push(item);
    }
    const more = `${files.length - named.length}${truncated ? " or more" : ""}`;
    if (!files.length) return `${head} It is empty so far.`;
    if (!named.length) return `${head} It holds ${more} file${more === "1" ? "" : "s"}: ls the folder.`;
    return `${head} Files, newest first: ${named.join("; ")}${more !== "0" ? `; +${more} more: ls the folder` : ""}.`;
  }

  /**
   * Calls `changed` with the Adventure whose drive changed, once per burst (COALESCE_MS). One
   * plain watch per real folder (a recursive one would follow symlinks out of the drive), synced
   * from a walk after each burst: a new folder gets a watch, and so does one replaced in place
   * (known by inode and birth time: ext4 gives a folder recreated by `rm -rf x && mkdir x` its old inode).
   */
  watch(changed: (projectId: string) => void, warn: (message: string) => void): () => void {
    const watches = new Map<string, { id: string; watcher: fs.FSWatcher }>();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    let warned = false;
    const signal = (projectId: string) => {
      if (timers.has(projectId) || !PROJECT_ID.test(projectId)) return;
      timers.set(projectId, setTimeout(() => {
        timers.delete(projectId);
        sync();
        changed(projectId);
      }, COALESCE_MS));
    };
    const add = (seen: Set<string>, dir: string, stat: fs.Stats, projectId?: string) => {
      seen.add(dir);
      const id = `${stat.ino}:${stat.birthtimeMs}`, known = watches.get(dir);
      if (known?.id === id) return;
      known?.watcher.close();
      const watcher = fs.watch(dir, (_event, name) => signal(projectId ?? String(name)));
      watcher.on("error", () => (watcher.close(), watches.get(dir)?.watcher === watcher && watches.delete(dir)));
      watches.set(dir, { id, watcher });
    };
    const sync = () => {
      const seen = new Set<string>();
      const tryTo = (run: () => void) => {
        try {
          run();
        } catch (error) {
          if (!warned) warn(`The drive watcher missed a folder (${(error as Error).message}); the Files view refreshes every minute meanwhile.`);
          warned = true;
        }
      };
      tryTo(() => {
        fs.mkdirSync(this.dir, { recursive: true });
        add(seen, this.dir, fs.statSync(this.dir));
        for (const d of fs.readdirSync(this.dir, { withFileTypes: true })) {
          if (!d.isDirectory() || !PROJECT_ID.test(d.name)) continue;
          tryTo(() => {
            add(seen, join(this.dir, d.name), fs.statSync(join(this.dir, d.name)), d.name);
            this.walk(d.name, WALK_MAX, (abs, _path, stat, link) => void (stat.isDirectory() && !link && tryTo(() => add(seen, abs, stat, d.name))));
          });
        }
      });
      for (const [dir, { watcher }] of watches) if (!seen.has(dir)) watcher.close(), watches.delete(dir);
    };
    sync();
    return () => {
      for (const { watcher } of watches.values()) watcher.close();
      for (const timer of timers.values()) clearTimeout(timer);
      watches.clear();
      timers.clear();
    };
  }
}

/** Temp file in the same folder, then rename: a reader sees the old file or the new one, never half. */
function atomicWrite(abs: string, bytes: Buffer) {
  const tmp = join(dirname(abs), `${TMP_PREFIX}${randomBytes(6).toString("hex")}`);
  try {
    fs.writeFileSync(tmp, bytes, { flag: "wx" });
    fs.renameSync(tmp, abs);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}
