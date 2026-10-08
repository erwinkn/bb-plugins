import type Database from "better-sqlite3";
import type { TreeStore } from "./builder";
import { withSize, type LogEntry, type MemoryKind, type MemoryMessage } from "./log";
import type { Usage } from "./summarizer";
import { emptyViews, type NodeRef, type Views } from "./tree";

/** D431: the memory tables, appended to MIGRATIONS. New tables only; nothing existing changes. */
export const MEMORY_MIGRATIONS = [
  `CREATE TABLE memory_settings (project_id TEXT PRIMARY KEY, mode TEXT NOT NULL, compact_tokens INTEGER, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE memory_log (project_id TEXT NOT NULL, i INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, size INTEGER NOT NULL, at INTEGER NOT NULL, thread_id TEXT, seq INTEGER, PRIMARY KEY (project_id, i))`,
  `CREATE TABLE memory_cursors (project_id TEXT NOT NULL, thread_id TEXT NOT NULL, last_seq INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, PRIMARY KEY (project_id, thread_id))`,
  `CREATE TABLE memory_nodes (project_id TEXT NOT NULL, l INTEGER NOT NULL, i INTEGER NOT NULL, text TEXT NOT NULL, how TEXT NOT NULL, tries INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (project_id, l, i))`,
  `CREATE TABLE memory_trees (project_id TEXT PRIMARY KEY, views TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, tries INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, cached_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, call_ms INTEGER NOT NULL DEFAULT 0, log_bytes INTEGER NOT NULL DEFAULT 0, nodes INTEGER NOT NULL DEFAULT 0, fallbacks INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`,
];

export const MEMORY_MODES = ["regular", "hybrid", "optchat"] as const;
export type MemoryMode = (typeof MEMORY_MODES)[number];
export interface MemorySettings {
  mode: MemoryMode;
  /** Per-Initiative compaction limit; null follows the setting for its mode. */
  compactTokens: number | null;
}
export interface TreeTotals {
  calls: number;
  tries: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  callMs: number;
  /** Running counts, so the dashboard never reads the history: the log's bytes, built nodes, fallbacks. */
  logBytes: number;
  nodes: number;
  fallbacks: number;
}
export interface Cursor {
  threadId: string;
  lastSeq: number;
  done: boolean;
}

type Row = Record<string, unknown>;
const message = (row: Row): MemoryMessage => ({
  i: Number(row.i),
  kind: row.kind as MemoryKind,
  text: String(row.text),
  size: Number(row.size),
  at: Number(row.at),
  threadId: (row.thread_id as string | null) ?? null,
  seq: row.seq === null ? null : Number(row.seq),
});

/**
 * The memory tables, on the plugin's one connection. The store is also the memory's lifetime:
 * BB closes the database when the plugin stops, so after close() every access throws here,
 * before reaching it. A background continuation that outlives its service fails like an abort.
 */
export class MemoryStore {
  private closed = false;
  private statements = new Map<string, Database.Statement>();
  constructor(private readonly handle: Database.Database, private readonly now: () => number = Date.now) {}

  close() {
    this.closed = true;
  }
  open() {
    this.closed = false;
  }
  private get db() {
    if (this.closed) throw new Error("Coordinator memory is closed: the service stopped.");
    return this.handle;
  }
  /** A prepared statement, prepared once. */
  private sql(sql: string) {
    const db = this.db;
    let statement = this.statements.get(sql);
    if (!statement) this.statements.set(sql, (statement = db.prepare(sql)));
    return statement;
  }

  settings(projectId: string): MemorySettings {
    const row = this.sql(`SELECT mode, compact_tokens FROM memory_settings WHERE project_id = ?`).get(projectId) as Row | undefined;
    const mode = (MEMORY_MODES as readonly string[]).includes(String(row?.mode)) ? (row!.mode as MemoryMode) : "regular";
    return { mode, compactTokens: row?.compact_tokens == null ? null : Number(row.compact_tokens) };
  }
  saveSettings(projectId: string, settings: MemorySettings) {
    this.sql(`INSERT INTO memory_settings (project_id, mode, compact_tokens, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (project_id) DO UPDATE SET mode = excluded.mode, compact_tokens = excluded.compact_tokens, updated_at = excluded.updated_at`)
      .run(projectId, settings.mode, settings.compactTokens, this.now());
  }

  // The log --------------------------------------------------------------------------

  count(projectId: string) {
    return Number((this.sql(`SELECT COALESCE(MAX(i) + 1, 0) AS n FROM memory_log WHERE project_id = ?`).get(projectId) as Row).n);
  }
  message(projectId: string, i: number): MemoryMessage | null {
    const row = this.sql(`SELECT * FROM memory_log WHERE project_id = ? AND i = ?`).get(projectId, i) as Row | undefined;
    return row ? message(row) : null;
  }
  messages(projectId: string, from = 0, to = Number.MAX_SAFE_INTEGER): MemoryMessage[] {
    return (this.sql(`SELECT * FROM memory_log WHERE project_id = ? AND i >= ? AND i < ? ORDER BY i`).all(projectId, from, to) as Row[]).map(message);
  }
  /**
   * The first of the log's last `within` messages logged from a thread's event `seq` or later:
   * where a turn's new message begins (it is at the log's end, so the scan stays short).
   */
  firstFrom(projectId: string, threadId: string, seq: number, within = 1000): number | null {
    const from = Math.max(0, this.count(projectId) - within);
    const i = this.sql(`SELECT MIN(i) FROM memory_log WHERE project_id = ? AND i >= ? AND thread_id = ? AND seq >= ?`).pluck().get(projectId, from, threadId, seq);
    return i == null ? null : Number(i);
  }
  /** Append entries and move the thread's cursor, in one transaction: a message is logged exactly once. */
  append(projectId: string, threadId: string, entries: LogEntry[], lastSeq: number) {
    this.db.transaction(() => {
      let i = this.count(projectId);
      let size = 0;
      const insert = this.sql(`INSERT INTO memory_log (project_id, i, kind, text, size, at, thread_id, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const entry of entries) {
        const m = withSize(entry, i++);
        insert.run(projectId, m.i, m.kind, m.text, m.size, m.at, m.threadId, m.seq);
        size += m.size;
      }
      if (size) {
        this.ensureTree(projectId);
        this.sql(`UPDATE memory_trees SET log_bytes = log_bytes + ? WHERE project_id = ?`).run(size, projectId);
      }
      this.sql(`UPDATE memory_cursors SET last_seq = ? WHERE project_id = ? AND thread_id = ? AND last_seq < ?`).run(lastSeq, projectId, threadId, lastSeq);
    })();
  }

  cursors(projectId: string): Cursor[] {
    return (this.sql(`SELECT thread_id, last_seq, done FROM memory_cursors WHERE project_id = ? ORDER BY created_at, rowid`).all(projectId) as Row[]).map((row) => ({
      threadId: String(row.thread_id),
      lastSeq: Number(row.last_seq),
      done: Number(row.done) === 1,
    }));
  }
  addCursor(projectId: string, threadId: string, at = this.now()) {
    this.sql(`INSERT OR IGNORE INTO memory_cursors (project_id, thread_id, last_seq, done, created_at) VALUES (?, ?, 0, 0, ?)`).run(projectId, threadId, at);
  }
  finishCursor(projectId: string, threadId: string) {
    this.sql(`UPDATE memory_cursors SET done = 1 WHERE project_id = ? AND thread_id = ?`).run(projectId, threadId);
  }

  // The tree -------------------------------------------------------------------------

  /** A built node's text, by its primary key: views and zooms read nodes one by one, never the tree. */
  node(projectId: string, l: number, i: number) {
    const text = this.sql(`SELECT text FROM memory_nodes WHERE project_id = ? AND l = ? AND i = ?`).pluck().get(projectId, l, i) as string | undefined;
    return text ?? null;
  }
  views(projectId: string): Views {
    const row = this.sql(`SELECT views FROM memory_trees WHERE project_id = ?`).get(projectId) as Row | undefined;
    if (!row) return emptyViews();
    const v = JSON.parse(String(row.views)) as Views;
    return { fed: v.fed, chat: v.chat as NodeRef[], merging: v.merging, compaction: v.compaction as NodeRef[] };
  }
  totals(projectId: string): TreeTotals {
    const row = this.sql(`SELECT * FROM memory_trees WHERE project_id = ?`).get(projectId) as Row | undefined;
    return {
      calls: Number(row?.calls ?? 0),
      tries: Number(row?.tries ?? 0),
      inputTokens: Number(row?.input_tokens ?? 0),
      cachedTokens: Number(row?.cached_tokens ?? 0),
      outputTokens: Number(row?.output_tokens ?? 0),
      reasoningTokens: Number(row?.reasoning_tokens ?? 0),
      costUsd: Number(row?.cost_usd ?? 0),
      callMs: Number(row?.call_ms ?? 0),
      logBytes: Number(row?.log_bytes ?? 0),
      nodes: Number(row?.nodes ?? 0),
      fallbacks: Number(row?.fallbacks ?? 0),
    };
  }
  private ensureTree(projectId: string) {
    this.sql(`INSERT OR IGNORE INTO memory_trees (project_id, views, updated_at) VALUES (?, ?, ?)`).run(projectId, JSON.stringify(emptyViews()), this.now());
  }

  /** The builder's store for one Initiative. */
  tree(projectId: string): TreeStore {
    const ensure = () => this.ensureTree(projectId);
    return {
      messageCount: () => this.count(projectId),
      message: (i) => this.message(projectId, i),
      node: (l, i) => this.node(projectId, l, i),
      built: (l, from, to) => (this.sql(`SELECT i FROM memory_nodes WHERE project_id = ? AND l = ? AND i >= ? AND i < ? ORDER BY i`).pluck().all(projectId, l, from, to) as number[]).map(Number),
      saveNode: (l, i, text, how, tries) => {
        this.db.transaction(() => {
          const added = this.sql(`INSERT OR IGNORE INTO memory_nodes (project_id, l, i, text, how, tries, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(projectId, l, i, text, how, tries, this.now());
          if (!added.changes) return;
          ensure();
          this.sql(`UPDATE memory_trees SET nodes = nodes + 1, fallbacks = fallbacks + ? WHERE project_id = ?`).run(how === "fallback" ? 1 : 0, projectId);
        })();
      },
      saveViews: (views) => {
        ensure();
        this.sql(`UPDATE memory_trees SET views = ?, updated_at = ? WHERE project_id = ?`).run(JSON.stringify(views), this.now(), projectId);
      },
      recordCall: ({ usage, cost, ms, tries }: { usage: Usage; cost: number; ms: number; tries: number }) => {
        ensure();
        this.sql(`UPDATE memory_trees SET calls = calls + 1, tries = tries + ?, input_tokens = input_tokens + ?, cached_tokens = cached_tokens + ?, output_tokens = output_tokens + ?, reasoning_tokens = reasoning_tokens + ?, cost_usd = cost_usd + ?, call_ms = call_ms + ?, updated_at = ? WHERE project_id = ?`)
          .run(tries, usage.input, usage.cached, usage.output, usage.reasoning, cost, ms, this.now(), projectId);
      },
    };
  }
}
