import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { IMPORTED_FLAG, importInitiativesMemory } from "../lib/import";
import { fixture, type Fixture } from "./fixture";
import plugin from "../server";

/** An Initiatives database as T143 left it: the memory tables, and the projects they belong to. */
function initiativesDb(dataDir: string) {
  mkdirSync(join(dataDir, "plugins", "initiatives"), { recursive: true });
  const path = join(dataDir, "plugins", "initiatives", "data.db");
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, coordinator_thread_id TEXT, archived_at INTEGER);
    CREATE TABLE memory_settings (project_id TEXT PRIMARY KEY, mode TEXT NOT NULL, compact_tokens INTEGER, updated_at INTEGER NOT NULL);
    CREATE TABLE memory_log (project_id TEXT NOT NULL, i INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, size INTEGER NOT NULL, at INTEGER NOT NULL, thread_id TEXT, seq INTEGER, PRIMARY KEY (project_id, i));
    CREATE TABLE memory_cursors (project_id TEXT NOT NULL, thread_id TEXT NOT NULL, last_seq INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, PRIMARY KEY (project_id, thread_id));
    CREATE TABLE memory_nodes (project_id TEXT NOT NULL, l INTEGER NOT NULL, i INTEGER NOT NULL, text TEXT NOT NULL, how TEXT NOT NULL, tries INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (project_id, l, i));
    CREATE TABLE memory_trees (project_id TEXT PRIMARY KEY, views TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, tries INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, cached_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, call_ms INTEGER NOT NULL DEFAULT 0, log_bytes INTEGER NOT NULL DEFAULT 0, nodes INTEGER NOT NULL DEFAULT 0, fallbacks INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
    INSERT INTO projects VALUES ('prj_live', 'thr_now', NULL), ('prj_old', 'thr_gone', 5), ('prj_bare', 'thr_bare', NULL);
    INSERT INTO memory_settings VALUES ('prj_live', 'optchat', NULL, 10), ('prj_old', 'hybrid', 90000, 11);
    INSERT INTO memory_cursors VALUES ('prj_live', 'thr_was', 40, 1, 1), ('prj_live', 'thr_tail', 50, 0, 2), ('prj_live', 'thr_now', 70, 0, 3), ('prj_old', 'thr_gone', 9, 0, 4);
    INSERT INTO memory_log VALUES ('prj_live', 0, 'user', 'hello', 5, 100, 'thr_was', 3), ('prj_live', 1, 'coord', 'hi there', 8, 101, 'thr_was', 4), ('prj_live', 2, 'work', '[W1] done', 9, 102, 'thr_now', 60);
    INSERT INTO memory_nodes VALUES ('prj_live', 0, 0, 'user: hello', 'free', 0, 1), ('prj_live', 0, 1, 'coord: hi there', 'free', 0, 1), ('prj_live', 1, 0, 'user: hello\ncoord: hi there', 'free', 0, 1);
    INSERT INTO memory_trees (project_id, views, calls, cost_usd, log_bytes, nodes, updated_at) VALUES ('prj_live', '{"fed":3,"chat":[[1,0],[0,2]],"merging":false,"compaction":[[1,0],[0,2]]}', 7, 0.25, 22, 3, 12);
  `);
  db.close();
  return path;
}

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const snapshotPath = (f: Fixture) => join(dirname(f.store.handle.name), "initiatives-snapshot.db");

/** The cutover step: `bb chat-memory import-initiatives`. */
async function importCli(f: Fixture) {
  const run = await f.harness.behavior.runCli(["import-initiatives"]);
  if (run.exitCode !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout) as { snapshot: { path: string; sha256: string; bytes: number }; imported: Record<string, number> };
}

describe("T145 import of the Initiatives memory", () => {
  it("carries every Initiative's mode, threads, log, nodes and views over once, from a verified snapshot, and leaves the source as it was", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "chat-memory-import-"));
    const source = initiativesDb(dataDir);
    const before = sha(source);
    const f = fixture({ dataDir });
    // A471: nothing is read from the live database at start, and Initiatives' scopes wait for the import.
    expect(f.store.meta(IMPORTED_FLAG)).toBeNull();
    expect(f.store.scope("initiatives:prj_live")).toBeNull();
    await expect(f.setScope("initiatives", "prj_live", ["thr_now"])).rejects.toThrow(/not imported the Initiatives memory yet \(no snapshot of the Initiatives database yet\): run `bb chat-memory import-initiatives`/);
    const { snapshot, imported } = await importCli(f);
    expect(snapshot).toMatchObject({ path: snapshotPath(f), sha256: sha(snapshotPath(f)), bytes: statSync(snapshotPath(f)).size });
    expect(imported).toEqual({ scopes: 2, members: 4, messages: 3, nodes: 3, trees: 1 });
    expect(f.store.scope("initiatives:prj_live")).toEqual({ id: "initiatives:prj_live", owner: "initiatives", mode: "optchat", compactTokens: null, hold: false });
    expect(f.store.scope("initiatives:prj_old")).toMatchObject({ mode: "hybrid", compactTokens: 90_000 });
    expect(f.store.scope("initiatives:prj_bare")).toBeNull();
    expect(f.store.members("initiatives:prj_live").map((m) => [m.threadId, m.state, m.lastSeq])).toEqual([
      ["thr_was", "done", 40],
      ["thr_tail", "retired", 50],
      ["thr_now", "current", 70],
    ]);
    // An archived Initiative's coordinator is no longer current: its scope is closed.
    expect(f.store.members("initiatives:prj_old").map((m) => m.state)).toEqual(["retired"]);
    expect(f.store.messages("initiatives:prj_live").map((m) => `${m.kind}: ${m.text}`)).toEqual(["user: hello", "agent: hi there", "work: [W1] done"]);
    expect(f.store.node("initiatives:prj_live", 1, 0)).toBe("user: hello\ncoord: hi there");
    expect(f.store.views("initiatives:prj_live")).toEqual({ fed: 3, chat: [[1, 0], [0, 2]], merging: false, compaction: [[1, 0], [0, 2]] });
    expect(f.store.totals("initiatives:prj_live")).toMatchObject({ calls: 7, costUsd: 0.25, logBytes: 22, nodes: 3 });
    expect(JSON.parse(f.store.meta(IMPORTED_FLAG)!)).toMatchObject({ snapshot: snapshotPath(f), sha256: snapshot.sha256, from: source, scopes: 2, members: 4, messages: 3, nodes: 3, trees: 1 });
    // The coordinator's memory reads at once, before Initiatives registers anything.
    expect(f.memory.zoom("initiatives:prj_live", 0, 2)).toMatch(/0\+1\|user: hello\n.*1\+1\|coord: hi there$/);
    expect(f.store.currentScopeOf("thr_now")?.id).toBe("initiatives:prj_live");
    expect(sha(source)).toBe(before);
    expect(sha(snapshotPath(f))).toBe(snapshot.sha256);
    await expect(f.setScope("initiatives", "prj_live", ["thr_now"])).resolves.toMatchObject({ scope: "initiatives:prj_live" });
    expect((await f.harness.behavior.runCli(["import-initiatives"])).stdout).toMatch(/^Nothing to import/);
    // A reload imports nothing again.
    const reloaded = await f.harness.lifecycle.reload((bb) => void plugin(bb));
    expect(Number(reloaded.bb.storage.database().prepare(`SELECT COUNT(*) FROM log`).pluck().get())).toBe(3);
  });

  it("imports only a snapshot that matches its manifest, opened read only, and never the live database (A471)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "chat-memory-import-"));
    const source = initiativesDb(dataDir);
    const f = fixture({ dataDir });
    const live = join(dataDir, "plugins", "initiatives", "data.db");
    // The live file given as the snapshot is refused, whatever its manifest says.
    writeFileSync(`${live}.json`, JSON.stringify({ sha256: sha(live), bytes: statSync(live).size, source: live, at: 0 }));
    expect(importInitiativesMemory(f.store, { live, snapshot: source })).toEqual({ pending: "the snapshot is the Initiatives database itself" });
    // A snapshot changed after it was taken is refused.
    await importCli(f).catch(() => undefined);
    const g = fixture();
    const snap = snapshotPath(f);
    expect(existsSync(snap)).toBe(true);
    const tampered = mkdtempSync(join(tmpdir(), "chat-memory-tampered-"));
    copyFileSync(snap, join(tampered, "s.db"));
    copyFileSync(`${snap}.json`, join(tampered, "s.db.json"));
    const db = new Database(join(tampered, "s.db"));
    db.exec(`UPDATE memory_settings SET mode = 'regular'`);
    db.close();
    g.store.handle.prepare(`DELETE FROM meta`).run();
    expect(importInitiativesMemory(g.store, { live, snapshot: join(tampered, "s.db") })).toEqual({ pending: "the snapshot does not match its manifest" });
    // Imported from the snapshot, which is left byte for byte as its manifest says.
    expect(JSON.parse(readFileSync(`${snap}.json`, "utf8")).sha256).toBe(sha(snap));
    expect(f.store.scope("initiatives:prj_live")).toMatchObject({ mode: "optchat" });
  });

  it("carries a paused Initiative over as a scope its owner holds (no automatic compaction)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "chat-memory-import-"));
    const source = initiativesDb(dataDir);
    const db = new Database(source);
    db.exec(`ALTER TABLE projects ADD COLUMN paused INTEGER NOT NULL DEFAULT 0; UPDATE projects SET paused = 1 WHERE id = 'prj_live'`);
    db.close();
    const f = fixture({ dataDir });
    await importCli(f);
    expect(f.store.scope("initiatives:prj_live")).toMatchObject({ mode: "optchat", hold: true });
    expect(f.store.scope("initiatives:prj_old")).toMatchObject({ hold: false });
  });

  it("imports nothing on a fresh install", () => {
    const f = fixture();
    expect(JSON.parse(f.store.meta(IMPORTED_FLAG)!)).toEqual({ source: null });
  });

  // T145 cutover rehearsal on a copy of a real backup: CHAT_MEMORY_IMPORT_DB=<copy of initiatives data.db>.
  const backup = process.env.CHAT_MEMORY_IMPORT_DB;
  it.runIf(!!backup)("imports a real Initiatives database whole", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "chat-memory-backup-"));
    mkdirSync(join(dataDir, "plugins", "initiatives"), { recursive: true });
    const source = join(dataDir, "plugins", "initiatives", "data.db");
    copyFileSync(backup!, source);
    const before = sha(source);
    const f = fixture({ dataDir });
    const started = Date.now();
    const { snapshot } = await importCli(f);
    const ms = Date.now() - started;
    const src = new Database(source, { readonly: true });
    const count = (sql: string) => Number(src.prepare(sql).pluck().get());
    const dst = (sql: string) => Number(f.store.handle.prepare(sql).pluck().get());
    expect(dst(`SELECT COUNT(*) FROM log`)).toBe(count(`SELECT COUNT(*) FROM memory_log`));
    expect(dst(`SELECT COUNT(*) FROM nodes`)).toBe(count(`SELECT COUNT(*) FROM memory_nodes`));
    expect(dst(`SELECT COUNT(*) FROM trees`)).toBe(count(`SELECT COUNT(*) FROM memory_trees`));
    expect(dst(`SELECT COUNT(*) FROM members`)).toBe(count(`SELECT COUNT(*) FROM memory_cursors`));
    expect(dst(`SELECT COUNT(*) FROM log WHERE kind = 'coord'`)).toBe(0);
    expect(dst(`SELECT COUNT(*) FROM log WHERE kind = 'agent'`)).toBe(count(`SELECT COUNT(*) FROM memory_log WHERE kind = 'coord'`));
    // Every text, node and view byte for byte.
    expect(dst(`SELECT SUM(LENGTH(text)) FROM log`)).toBe(count(`SELECT SUM(LENGTH(text)) FROM memory_log`));
    expect(dst(`SELECT SUM(LENGTH(text)) FROM nodes`)).toBe(count(`SELECT SUM(LENGTH(text)) FROM memory_nodes`));
    for (const row of src.prepare(`SELECT project_id, views, nodes, log_bytes FROM memory_trees`).all() as Array<{ project_id: string; views: string; nodes: number; log_bytes: number }>) {
      const scope = `initiatives:${row.project_id}`;
      expect(f.store.handle.prepare(`SELECT views FROM trees WHERE scope = ?`).pluck().get(scope)).toBe(row.views);
      expect(f.store.totals(scope)).toMatchObject({ nodes: row.nodes, logBytes: row.log_bytes });
    }
    for (const row of src.prepare(`SELECT project_id, mode, compact_tokens FROM memory_settings`).all() as Array<{ project_id: string; mode: string; compact_tokens: number | null }>)
      expect(f.store.scope(`initiatives:${row.project_id}`)).toMatchObject({ mode: row.mode, compactTokens: row.compact_tokens });
    const live = src.prepare(`SELECT id, coordinator_thread_id FROM projects WHERE archived_at IS NULL AND coordinator_thread_id IN (SELECT thread_id FROM memory_cursors)`).all() as Array<{ id: string; coordinator_thread_id: string }>;
    for (const p of live) expect(f.store.currentScopeOf(p.coordinator_thread_id)?.id).toBe(`initiatives:${p.id}`);
    // Every scope's memory view renders from the imported tree.
    for (const scope of f.store.openScopes()) expect((await f.memory.status(scope.id)).tree.viewBytes).toBeGreaterThan(0);
    src.close();
    expect(sha(source)).toBe(before);
    console.log(JSON.stringify({ imported: JSON.parse(f.store.meta(IMPORTED_FLAG)!), snapshot, ms, sourceBytes: statSync(source).size, scopes: f.store.openScopes().map((s) => `${s.id} ${s.mode}`) }));
    f.memory.dispose();
  });
});
