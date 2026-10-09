import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import type Database from "better-sqlite3";
import type { MemoryStore } from "./store";

export const IMPORTED_FLAG = "imported-initiatives-memory";
const SOURCE_TABLES = ["memory_settings", "memory_cursors", "memory_log", "memory_nodes", "memory_trees", "projects"];

/**
 * Where the memory comes from (T145): `live`, the Initiatives plugin's database, is only ever
 * opened read only, once, by snapshotInitiatives, which copies it to `snapshot` (in this plugin's
 * own directory) with a manifest beside it (`<snapshot>.json`: its SHA-256 and size). The import
 * reads that snapshot alone, opened read only, after checking it against its manifest; it refuses
 * the live file.
 */
export interface ImportPaths {
  live: string;
  snapshot: string;
}
interface Manifest {
  sha256: string;
  bytes: number;
  source: string;
  at: number;
}

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
/**
 * A database opened read only (SQLITE_OPEN_READONLY): any write throws. It is BB's own SQLite, the
 * class of the connection BB gave this plugin, so the plugin brings no native module of its own.
 * (BB's build takes no URI filenames, so ATTACH cannot open a file read only.)
 */
const openReadOnly = (store: MemoryStore, path: string): Database.Database => {
  const Sqlite = store.handle.constructor as new (path: string, options: Database.Options) => Database.Database;
  return new Sqlite(path, { readonly: true, fileMustExist: true });
};
const sameFile = (a: string, b: string) => existsSync(a) && existsSync(b) && realpathSync(a) === realpathSync(b);

/**
 * A consistent copy of the Initiatives database, taken from it opened read only (VACUUM INTO reads
 * it in one transaction, so a write under way is wholly in or out), written beside the snapshot
 * first, checked (integrity, the memory tables) and only then moved into place with its manifest.
 * Replaces an earlier snapshot of this plugin's. Throws when the source is missing or broken.
 */
export function snapshotInitiatives(store: MemoryStore, paths: ImportPaths): Manifest {
  if (!existsSync(paths.live)) throw new Error(`No Initiatives database at ${paths.live}.`);
  if (sameFile(paths.live, paths.snapshot)) throw new Error("The snapshot cannot be the Initiatives database itself.");
  const partial = `${paths.snapshot}.partial`;
  rmSync(partial, { force: true });
  const live = openReadOnly(store, paths.live);
  try {
    live.prepare(`VACUUM INTO ?`).run(partial);
  } finally {
    live.close();
  }
  try {
    check(store, partial);
    const manifest: Manifest = { sha256: sha256(partial), bytes: statSync(partial).size, source: paths.live, at: store.now() };
    rmSync(`${paths.snapshot}.json`, { force: true });
    renameSync(partial, paths.snapshot);
    writeFileSync(`${paths.snapshot}.json`, JSON.stringify(manifest, null, 2));
    return manifest;
  } finally {
    rmSync(partial, { force: true });
  }
}

/** A snapshot SQLite reads whole and well, with the memory tables. */
function check(store: MemoryStore, path: string) {
  const snap = openReadOnly(store, path);
  try {
    const integrity = snap.prepare(`PRAGMA integrity_check`).pluck().all() as string[];
    if (integrity.join() !== "ok") throw new Error(`The Initiatives snapshot is damaged: ${integrity.slice(0, 3).join("; ")}`);
    const missing = SOURCE_TABLES.filter((t) => !tables(snap).has(t));
    if (missing.length && missing.length < SOURCE_TABLES.length) throw new Error(`The Initiatives snapshot lacks ${missing.join(", ")}.`);
  } finally {
    snap.close();
  }
}
const tables = (db: Database.Database) => new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).pluck().all() as string[]);

/** The snapshot's manifest when the file matches it, else why not. */
export function verifySnapshot(paths: ImportPaths): { ok: true; manifest: Manifest } | { ok: false; why: string } {
  if (sameFile(paths.live, paths.snapshot)) return { ok: false, why: "the snapshot is the Initiatives database itself" };
  if (!existsSync(paths.snapshot) || !existsSync(`${paths.snapshot}.json`)) return { ok: false, why: "no snapshot of the Initiatives database yet" };
  const manifest = JSON.parse(readFileSync(`${paths.snapshot}.json`, "utf8")) as Manifest;
  const bytes = statSync(paths.snapshot).size;
  if (bytes !== manifest.bytes || sha256(paths.snapshot) !== manifest.sha256) return { ok: false, why: "the snapshot does not match its manifest" };
  return { ok: true, manifest };
}

export type ImportResult = { imported: Record<string, number> } | { pending: string } | null;

/**
 * T145: the Initiatives plugin kept every Initiative's memory in its own database (memory_* tables)
 * until this plugin took it over. Once, this plugin copies it all from a verified snapshot (above):
 * each Initiative becomes the scope "initiatives:<id>" with its mode, compaction limit and pause,
 * its coordinator threads (the current one current, earlier ones done or still being read), its
 * log (the coordinator's "coord" kind is "agent" here), its nodes, and its tree's saved views and
 * totals, so no summary is ever paid for twice. Runs in one transaction. Null once done (or on a
 * fresh install: no Initiatives database); pending, with the reason, while there is no verified
 * snapshot: Initiatives' scopes wait for it (server.ts).
 */
export function importInitiativesMemory(store: MemoryStore, paths: ImportPaths): ImportResult {
  if (store.meta(IMPORTED_FLAG) !== null) return null;
  if (!existsSync(paths.live) && !existsSync(paths.snapshot)) {
    store.setMeta(IMPORTED_FLAG, JSON.stringify({ source: null }));
    return null;
  }
  const verified = verifySnapshot(paths);
  if (!verified.ok) return { pending: verified.why };
  const source = { snapshot: paths.snapshot, sha256: verified.manifest.sha256, from: verified.manifest.source };
  const src = openReadOnly(store, paths.snapshot);
  try {
    if (!SOURCE_TABLES.every((t) => tables(src).has(t))) {
      store.setMeta(IMPORTED_FLAG, JSON.stringify({ ...source, tables: false }));
      return { imported: {} };
    }
    const rows = (sql: string) => src.prepare(sql).raw().iterate() as IterableIterator<unknown[]>;
    const db = store.handle;
    return store.transaction(() => {
      const now = store.now();
      const copy = (sql: string, insert: string) => {
        const statement = db.prepare(insert);
        let n = 0;
        for (const row of rows(sql)) n += statement.run(...row).changes;
        return n;
      };
      // A paused Initiative holds automatic compaction from the start, as Initiatives' compactor did.
      const paused = (src.pragma("table_info(projects)") as Array<{ name: string }>).some((c) => c.name === "paused") ? "COALESCE(p.paused, 0)" : "0";
      const scopes = copy(
        `SELECT 'initiatives:' || p.id, 'initiatives', COALESCE(s.mode, 'regular'), s.compact_tokens, ${paused}, COALESCE(s.updated_at, ${now}), COALESCE(s.updated_at, ${now})
         FROM projects p LEFT JOIN memory_settings s ON s.project_id = p.id
         WHERE p.id IN (SELECT project_id FROM memory_settings UNION SELECT project_id FROM memory_cursors UNION SELECT project_id FROM memory_trees)`,
        `INSERT INTO scopes (id, owner, mode, compact_tokens, hold, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const members = copy(
        `SELECT 'initiatives:' || c.project_id, c.thread_id,
           CASE WHEN c.done = 1 THEN 'done' WHEN p.archived_at IS NULL AND p.coordinator_thread_id = c.thread_id THEN 'current' ELSE 'retired' END,
           c.last_seq, c.created_at
         FROM memory_cursors c JOIN projects p ON p.id = c.project_id`,
        `INSERT INTO members (scope, thread_id, state, last_seq, joined_at) VALUES (?, ?, ?, ?, ?)`,
      );
      const messages = copy(
        `SELECT 'initiatives:' || project_id, i, CASE kind WHEN 'coord' THEN 'agent' ELSE kind END, text, size, at, thread_id, seq FROM memory_log`,
        `INSERT INTO log (scope, i, kind, text, size, at, thread_id, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const nodes = copy(
        `SELECT 'initiatives:' || project_id, l, i, text, how, tries, created_at FROM memory_nodes`,
        `INSERT INTO nodes (scope, l, i, text, how, tries, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const trees = copy(
        `SELECT 'initiatives:' || project_id, views, calls, tries, input_tokens, cached_tokens, output_tokens, reasoning_tokens, cost_usd, call_ms, log_bytes, nodes, fallbacks, updated_at FROM memory_trees`,
        `INSERT INTO trees (scope, views, calls, tries, input_tokens, cached_tokens, output_tokens, reasoning_tokens, cost_usd, call_ms, log_bytes, nodes, fallbacks, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const counts = { scopes, members, messages, nodes, trees };
      store.setMeta(IMPORTED_FLAG, JSON.stringify({ ...source, at: now, ...counts }));
      return { imported: counts };
    });
  } finally {
    src.close();
  }
}
