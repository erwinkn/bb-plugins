import type Database from "better-sqlite3";
import type { TreeStore } from "./builder";
import { withSize, type LogEntry, type MemoryKind, type MemoryMessage } from "./log";
import type { Usage } from "./summarizer";
import { emptyViews, type NodeRef, type Views } from "./tree";

/**
 * Append-only (bb.storage.migrate). A scope is one memory: one log, one tree, one mode. Its id is
 * "<owner plugin>:<key>": "initiatives:prj_…" for an Initiative's coordinator and discussion
 * threads, "chat-memory:<thread id>" for a thread the user turned memory on for.
 */
export const MIGRATIONS = [
  // hold: the owner holds automatic compaction (a paused Initiative).
  `CREATE TABLE scopes (id TEXT PRIMARY KEY, owner TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'regular', compact_tokens INTEGER, hold INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  // state: current threads are read as they work; a retired one (no longer listed by the owner) is
  // read until it is quiet, then done. asked_at, asked_protocol: its last turn that asked for its
  // turn context, and the provider's protocol then. compacted_seq: the context snapshot compaction
  // last tried (READ_FAILED: reading it failed), compact_tries times (compact_error: the last one
  // failed); compacted_at: the last compaction that succeeded.
  `CREATE TABLE members (scope TEXT NOT NULL, thread_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('current', 'retired', 'done')), last_seq INTEGER NOT NULL DEFAULT 0, asked_at INTEGER, asked_protocol INTEGER, compacted_seq INTEGER, compact_tries INTEGER NOT NULL DEFAULT 0, compact_tried_at INTEGER, compact_error TEXT, compacted_at INTEGER, joined_at INTEGER NOT NULL, PRIMARY KEY (scope, thread_id))`,
  `CREATE INDEX members_thread ON members (thread_id, state)`,
  `CREATE TABLE log (scope TEXT NOT NULL, i INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, size INTEGER NOT NULL, at INTEGER NOT NULL, thread_id TEXT, seq INTEGER, PRIMARY KEY (scope, i))`,
  `CREATE TABLE nodes (scope TEXT NOT NULL, l INTEGER NOT NULL, i INTEGER NOT NULL, text TEXT NOT NULL, how TEXT NOT NULL, tries INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (scope, l, i))`,
  `CREATE TABLE trees (scope TEXT PRIMARY KEY, views TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, tries INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, cached_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, call_ms INTEGER NOT NULL DEFAULT 0, log_bytes INTEGER NOT NULL DEFAULT 0, nodes INTEGER NOT NULL DEFAULT 0, fallbacks INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  // T153 (D487, D491): one row per thread replaces members (no longer read) and hold (no longer
  // read): the scope it writes to now (null: none) and the cursor of its BB events, plus its
  // compaction bookkeeping. A thread keeps the scope it is current in, else its latest one; a
  // personal memory the user turned off (not current) stays off. Its cursor is the furthest any of
  // its memberships read, so nothing it logged anywhere is logged again.
  `CREATE TABLE threads (thread_id TEXT PRIMARY KEY, scope TEXT, cursor INTEGER NOT NULL DEFAULT 0, compacted_seq INTEGER, compact_tries INTEGER NOT NULL DEFAULT 0, compact_tried_at INTEGER, compact_error TEXT, compacted_at INTEGER)`,
  `CREATE INDEX threads_scope ON threads (scope)`,
  `INSERT OR IGNORE INTO threads (thread_id, scope, cursor, compacted_seq, compact_tries, compact_tried_at, compact_error, compacted_at)
     SELECT m.thread_id, CASE WHEN m.state = 'current' OR m.scope NOT LIKE 'chat-memory:%' THEN m.scope END,
       (SELECT MAX(last_seq) FROM members WHERE thread_id = m.thread_id), m.compacted_seq, m.compact_tries, m.compact_tried_at, m.compact_error, m.compacted_at
     FROM members m ORDER BY CASE m.state WHEN 'current' THEN 0 ELSE 1 END, m.joined_at DESC`,
];

export const MEMORY_MODES = ["regular", "hybrid", "optchat"] as const;
export type MemoryMode = (typeof MEMORY_MODES)[number];

export interface Scope {
  id: string;
  owner: string;
  mode: MemoryMode;
  /** The scope's own compaction limit; null follows the setting for its mode. */
  compactTokens: number | null;
}
/** A thread chat memory has met: the memory it writes to now, and how far its BB events are logged. */
export interface MemoryThread {
  threadId: string;
  /** The scope its next completed turns go to; null once detached (its cursor stays). */
  scope: string | null;
  /** Its last BB event sequence logged: the end of its last completed turn copied. */
  cursor: number;
  compactedSeq: number | null;
  compactTries: number;
  compactTriedAt: number | null;
  compactError: string | null;
  compactedAt: number | null;
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
  /** Running counts, so the status never reads the history: the log's bytes, built nodes, fallbacks. */
  logBytes: number;
  nodes: number;
  fallbacks: number;
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
const scope = (row: Row): Scope => ({
  id: String(row.id),
  owner: String(row.owner),
  mode: (MEMORY_MODES as readonly string[]).includes(String(row.mode)) ? (row.mode as MemoryMode) : "regular",
  compactTokens: row.compact_tokens == null ? null : Number(row.compact_tokens),
});
const thread = (row: Row): MemoryThread => ({
  threadId: String(row.thread_id),
  scope: (row.scope as string | null) ?? null,
  cursor: Number(row.cursor),
  compactedSeq: row.compacted_seq == null ? null : Number(row.compacted_seq),
  compactTries: Number(row.compact_tries ?? 0),
  compactTriedAt: row.compact_tried_at == null ? null : Number(row.compact_tried_at),
  compactError: row.compact_error == null ? null : String(row.compact_error),
  compactedAt: row.compacted_at == null ? null : Number(row.compacted_at),
});

/** compacted_seq when reading the thread's context size failed: no snapshot is known. */
export const READ_FAILED = -1;

/** The plugin's tables, on its one connection (BB closes it when the plugin stops). */
export class MemoryStore {
  private statements = new Map<string, Database.Statement>();
  constructor(readonly handle: Database.Database, readonly now: () => number = Date.now) {}

  /** A prepared statement, prepared once. */
  private sql(sql: string) {
    let statement = this.statements.get(sql);
    if (!statement) this.statements.set(sql, (statement = this.handle.prepare(sql)));
    return statement;
  }
  transaction<T>(work: () => T): T {
    return this.handle.transaction(work)();
  }

  // Scopes and threads --------------------------------------------------------------------

  scope(id: string): Scope | null {
    const row = this.sql(`SELECT * FROM scopes WHERE id = ?`).get(id) as Row | undefined;
    return row ? scope(row) : null;
  }
  ensureScope(id: string, owner: string) {
    const now = this.now();
    this.sql(`INSERT OR IGNORE INTO scopes (id, owner, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(id, owner, now, now);
  }
  saveSettings(id: string, settings: Pick<Scope, "mode" | "compactTokens">) {
    this.sql(`UPDATE scopes SET mode = ?, compact_tokens = ?, updated_at = ? WHERE id = ?`).run(settings.mode, settings.compactTokens, this.now(), id);
  }
  thread(threadId: string): MemoryThread | null {
    const row = this.sql(`SELECT * FROM threads WHERE thread_id = ?`).get(threadId) as Row | undefined;
    return row ? thread(row) : null;
  }
  /** The scope a thread writes to now, if any. */
  scopeOf(threadId: string): Scope | null {
    const row = this.sql(`SELECT s.* FROM scopes s JOIN threads t ON t.scope = s.id WHERE t.thread_id = ?`).get(threadId) as Row | undefined;
    return row ? scope(row) : null;
  }
  /** The threads that write to a scope, in the order they were first met. */
  threadsOf(scopeId: string): MemoryThread[] {
    return (this.sql(`SELECT * FROM threads WHERE scope = ? ORDER BY rowid`).all(scopeId) as Row[]).map(thread);
  }
  /** Every thread that writes to a scope. */
  attachedThreads(): MemoryThread[] {
    return (this.sql(`SELECT * FROM threads WHERE scope IS NOT NULL ORDER BY rowid`).all() as Row[]).map(thread);
  }
  /**
   * D491: the thread writes to `scopeId` from its next completed turn on (null: to none). One write;
   * its cursor stays, so what it logged stays where it is and nothing is logged twice. A thread met
   * for the first time starts from its first event.
   */
  attach(threadId: string, scopeId: string | null) {
    this.sql(`INSERT INTO threads (thread_id, scope) VALUES (?, ?) ON CONFLICT (thread_id) DO UPDATE SET scope = excluded.scope`).run(threadId, scopeId);
  }
  /** attach, for a thread chat memory has never met: one it met keeps what it has (a detach stands). */
  attachNew(threadId: string, scopeId: string) {
    this.sql(`INSERT OR IGNORE INTO threads (thread_id, scope) VALUES (?, ?)`).run(threadId, scopeId);
  }
  /** BB no longer has the thread. */
  forget(threadId: string) {
    this.sql(`DELETE FROM threads WHERE thread_id = ?`).run(threadId);
  }
  /** A compaction of snapshot `seq` starts: the first try of a new snapshot, or one more. */
  compactTry(threadId: string, seq: number) {
    this.sql(`UPDATE threads SET compact_tries = CASE WHEN compacted_seq = ? THEN compact_tries + 1 ELSE 1 END, compacted_seq = ?, compact_tried_at = ? WHERE thread_id = ?`)
      .run(seq, seq, this.now(), threadId);
  }
  compactDone(threadId: string) {
    this.sql(`UPDATE threads SET compacted_at = ?, compact_error = NULL WHERE thread_id = ?`).run(this.now(), threadId);
  }
  compactFailed(threadId: string, error: string) {
    this.sql(`UPDATE threads SET compact_error = ? WHERE thread_id = ?`).run(error, threadId);
  }
  /** Its context size was read again after reads failed: that failure is over. Whether it was. */
  compactReadRecovered(threadId: string) {
    return this.sql(`UPDATE threads SET compacted_seq = NULL, compact_tries = 0, compact_error = NULL WHERE thread_id = ? AND compacted_seq = ?`).run(threadId, READ_FAILED).changes > 0;
  }
  /** Attached threads whose last compaction failed, fewer than `tries` times: the sweep tries them again (compaction decides when). */
  compactFailures(tries: number): string[] {
    return this.sql(`SELECT thread_id FROM threads WHERE scope IS NOT NULL AND compact_error IS NOT NULL AND compact_tries < ?`).pluck().all(tries) as string[];
  }

  // The log --------------------------------------------------------------------------

  count(scopeId: string) {
    return Number((this.sql(`SELECT COALESCE(MAX(i) + 1, 0) AS n FROM log WHERE scope = ?`).get(scopeId) as Row).n);
  }
  message(scopeId: string, i: number): MemoryMessage | null {
    const row = this.sql(`SELECT * FROM log WHERE scope = ? AND i = ?`).get(scopeId, i) as Row | undefined;
    return row ? message(row) : null;
  }
  messages(scopeId: string, from = 0, to = Number.MAX_SAFE_INTEGER): MemoryMessage[] {
    return (this.sql(`SELECT * FROM log WHERE scope = ? AND i >= ? AND i < ? ORDER BY i`).all(scopeId, from, to) as Row[]).map(message);
  }
  /** Where the messages before `cut` that fit in `budget` bytes together begin, counting back from `cut`. */
  tailStart(scopeId: string, cut: number, budget: number) {
    let start = cut;
    let total = 0;
    for (const row of this.sql(`SELECT i, size FROM log WHERE scope = ? AND i < ? ORDER BY i DESC`).iterate(scopeId, cut) as IterableIterator<Row>) {
      total += Number(row.size);
      if (total > budget) break;
      start = Number(row.i);
    }
    return start;
  }
  /**
   * D487: append a thread's completed turns, read through event `through`, to the scope it writes
   * to now, and move its cursor there, in one transaction. What the cursor has passed meanwhile is
   * left out, so a message is logged exactly once. Null, and nothing moves, once it writes to none.
   */
  append(threadId: string, entries: readonly LogEntry[], through: number): { scope: string; appended: number } | null {
    return this.transaction(() => {
      const t = this.thread(threadId);
      if (!t?.scope) return null;
      let i = this.count(t.scope);
      let size = 0;
      const insert = this.sql(`INSERT INTO log (scope, i, kind, text, size, at, thread_id, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      const fresh = entries.filter((e) => (e.seq ?? 0) > t.cursor);
      for (const entry of fresh) {
        const m = withSize(entry, i++);
        insert.run(t.scope, m.i, m.kind, m.text, m.size, m.at, m.threadId, m.seq);
        size += m.size;
      }
      if (size) {
        this.ensureTree(t.scope);
        this.sql(`UPDATE trees SET log_bytes = log_bytes + ? WHERE scope = ?`).run(size, t.scope);
      }
      this.sql(`UPDATE threads SET cursor = ? WHERE thread_id = ? AND cursor < ?`).run(through, threadId, through);
      return { scope: t.scope, appended: fresh.length };
    });
  }

  // The tree -------------------------------------------------------------------------

  /** A built node's text, by its primary key: views and zooms read nodes one by one, never the tree. */
  node(scopeId: string, l: number, i: number) {
    const text = this.sql(`SELECT text FROM nodes WHERE scope = ? AND l = ? AND i = ?`).pluck().get(scopeId, l, i) as string | undefined;
    return text ?? null;
  }
  views(scopeId: string): Views {
    const row = this.sql(`SELECT views FROM trees WHERE scope = ?`).get(scopeId) as Row | undefined;
    if (!row) return emptyViews();
    const v = JSON.parse(String(row.views)) as Views;
    return { fed: v.fed, chat: v.chat as NodeRef[], merging: v.merging, compaction: v.compaction as NodeRef[] };
  }
  totals(scopeId: string): TreeTotals {
    const row = this.sql(`SELECT * FROM trees WHERE scope = ?`).get(scopeId) as Row | undefined;
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
  private ensureTree(scopeId: string) {
    this.sql(`INSERT OR IGNORE INTO trees (scope, views, updated_at) VALUES (?, ?, ?)`).run(scopeId, JSON.stringify(emptyViews()), this.now());
  }

  /** The builder's store for one scope. */
  tree(scopeId: string): TreeStore {
    const ensure = () => this.ensureTree(scopeId);
    return {
      messageCount: () => this.count(scopeId),
      message: (i) => this.message(scopeId, i),
      node: (l, i) => this.node(scopeId, l, i),
      built: (l, from, to) => (this.sql(`SELECT i FROM nodes WHERE scope = ? AND l = ? AND i >= ? AND i < ? ORDER BY i`).pluck().all(scopeId, l, from, to) as number[]).map(Number),
      saveNode: (l, i, text, how, tries) => {
        this.transaction(() => {
          const added = this.sql(`INSERT OR IGNORE INTO nodes (scope, l, i, text, how, tries, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(scopeId, l, i, text, how, tries, this.now());
          if (!added.changes) return;
          ensure();
          this.sql(`UPDATE trees SET nodes = nodes + 1, fallbacks = fallbacks + ? WHERE scope = ?`).run(how === "fallback" ? 1 : 0, scopeId);
        });
      },
      saveViews: (views) => {
        ensure();
        this.sql(`UPDATE trees SET views = ?, updated_at = ? WHERE scope = ?`).run(JSON.stringify(views), this.now(), scopeId);
      },
      recordCall: ({ usage, cost, ms, tries }: { usage: Usage; cost: number; ms: number; tries: number }) => {
        ensure();
        this.sql(`UPDATE trees SET calls = calls + 1, tries = tries + ?, input_tokens = input_tokens + ?, cached_tokens = cached_tokens + ?, output_tokens = output_tokens + ?, reasoning_tokens = reasoning_tokens + ?, cost_usd = cost_usd + ?, call_ms = call_ms + ?, updated_at = ? WHERE scope = ?`)
          .run(tries, usage.input, usage.cached, usage.output, usage.reasoning, cost, ms, this.now(), scopeId);
      },
    };
  }
}
