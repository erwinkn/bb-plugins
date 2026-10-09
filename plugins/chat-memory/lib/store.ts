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
];

export const MEMORY_MODES = ["regular", "hybrid", "optchat"] as const;
export type MemoryMode = (typeof MEMORY_MODES)[number];
export type MemberState = "current" | "retired" | "done";

export interface Scope {
  id: string;
  owner: string;
  mode: MemoryMode;
  /** The scope's own compaction limit; null follows the setting for its mode. */
  compactTokens: number | null;
  /** Its owner holds automatic compaction (a paused Initiative). */
  hold: boolean;
}
export interface Member {
  scope: string;
  threadId: string;
  state: MemberState;
  lastSeq: number;
  /** Its last turn that asked for its turn context, and the provider's protocol then. */
  askedAt: number | null;
  askedProtocol: number | null;
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
  hold: Number(row.hold) === 1,
});
const member = (row: Row): Member => ({
  scope: String(row.scope),
  threadId: String(row.thread_id),
  state: row.state as MemberState,
  lastSeq: Number(row.last_seq),
  askedAt: row.asked_at == null ? null : Number(row.asked_at),
  askedProtocol: row.asked_protocol == null ? null : Number(row.asked_protocol),
  compactedSeq: row.compacted_seq == null ? null : Number(row.compacted_seq),
  compactTries: Number(row.compact_tries ?? 0),
  compactTriedAt: row.compact_tried_at == null ? null : Number(row.compact_tried_at),
  compactError: row.compact_error == null ? null : String(row.compact_error),
  compactedAt: row.compacted_at == null ? null : Number(row.compacted_at),
});

/** compacted_seq when reading the thread's context size failed: no snapshot is known. */
export const READ_FAILED = -1;

/**
 * The plugin's tables, on its one connection. The store is also the memory's lifetime: BB closes
 * the database when the plugin stops, so after close() every access throws here, before reaching
 * it. A background continuation that outlives its service fails like an abort.
 */
export class MemoryStore {
  private closed = false;
  private statements = new Map<string, Database.Statement>();
  /** The current members as close() left them: what configure, the turn gate and the hook read while a reload disposes this instance. */
  private lastCurrent: { scopes: Map<string, Scope>; members: Map<string, Member>; owners: Set<string> } | null = null;
  constructor(readonly handle: Database.Database, readonly now: () => number = Date.now) {}

  close() {
    if (!this.closed) {
      try {
        const rows = this.handle.prepare(`SELECT s.*, m.* FROM scopes s JOIN members m ON m.scope = s.id WHERE m.state = 'current'`).all() as Row[];
        this.lastCurrent = {
          scopes: new Map(rows.map((r) => [String(r.thread_id), scope(r)])),
          members: new Map(rows.map((r) => [String(r.thread_id), member(r)])),
          owners: new Set(this.handle.prepare(`SELECT DISTINCT owner FROM scopes`).pluck().all() as string[]),
        };
      } catch {
        // BB closed the database first: reads throw like every other access.
        this.lastCurrent = null;
      }
    }
    this.closed = true;
  }
  open() {
    this.closed = false;
    this.lastCurrent = null;
  }
  get isClosed() {
    return this.closed;
  }
  private get db() {
    if (this.closed) throw new Error("Chat memory is closed: the plugin stopped.");
    return this.handle;
  }
  /** A prepared statement, prepared once. */
  private sql(sql: string) {
    const db = this.db;
    let statement = this.statements.get(sql);
    if (!statement) this.statements.set(sql, (statement = db.prepare(sql)));
    return statement;
  }
  transaction<T>(work: () => T): T {
    return this.db.transaction(work)();
  }

  meta(key: string) {
    return (this.sql(`SELECT value FROM meta WHERE key = ?`).pluck().get(key) as string | undefined) ?? null;
  }
  setMeta(key: string, value: string) {
    this.sql(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(key, value);
  }

  // Scopes and members --------------------------------------------------------------------

  scope(id: string): Scope | null {
    const row = this.sql(`SELECT * FROM scopes WHERE id = ?`).get(id) as Row | undefined;
    return row ? scope(row) : null;
  }
  /** Scopes with a current thread: the ones that log and build. */
  openScopes(): Scope[] {
    return (this.sql(`SELECT * FROM scopes WHERE id IN (SELECT scope FROM members WHERE state = 'current') ORDER BY created_at, id`).all() as Row[]).map(scope);
  }
  /** Scopes with a thread still to read: current ones, and retired ones not yet quiet. */
  readingScopes(): Scope[] {
    return (this.sql(`SELECT * FROM scopes WHERE id IN (SELECT scope FROM members WHERE state != 'done') ORDER BY created_at, id`).all() as Row[]).map(scope);
  }
  ownsScopes(owner: string) {
    if (this.closed && this.lastCurrent) return this.lastCurrent.owners.has(owner);
    return this.sql(`SELECT 1 FROM scopes WHERE owner = ? LIMIT 1`).get(owner) !== undefined;
  }
  /** The scopes still reading a thread: it is current there, or retired and not yet quiet. */
  scopesReading(threadId: string): string[] {
    return this.sql(`SELECT scope FROM members WHERE thread_id = ? AND state != 'done'`).pluck().all(threadId) as string[];
  }
  ensureScope(id: string, owner: string) {
    const now = this.now();
    this.sql(`INSERT OR IGNORE INTO scopes (id, owner, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(id, owner, now, now);
  }
  saveSettings(id: string, settings: Pick<Scope, "mode" | "compactTokens">) {
    this.sql(`UPDATE scopes SET mode = ?, compact_tokens = ?, updated_at = ? WHERE id = ?`).run(settings.mode, settings.compactTokens, this.now(), id);
  }
  setHold(id: string, hold: boolean) {
    this.sql(`UPDATE scopes SET hold = ? WHERE id = ? AND hold != ?`).run(hold ? 1 : 0, id, hold ? 1 : 0);
  }
  /** The scope a thread is a current member of, if any (a thread is current in one scope at most). Once closed, as close() left it. */
  currentScopeOf(threadId: string): Scope | null {
    if (this.closed && this.lastCurrent) return this.lastCurrent.scopes.get(threadId) ?? null;
    const row = this.sql(`SELECT s.* FROM scopes s JOIN members m ON m.scope = s.id WHERE m.thread_id = ? AND m.state = 'current'`).get(threadId) as Row | undefined;
    return row ? scope(row) : null;
  }
  members(scopeId: string): Member[] {
    return (this.sql(`SELECT * FROM members WHERE scope = ? ORDER BY joined_at, rowid`).all(scopeId) as Row[]).map(member);
  }
  member(scopeId: string, threadId: string): Member | null {
    if (this.closed && this.lastCurrent) {
      const m = this.lastCurrent.members.get(threadId);
      return m?.scope === scopeId ? m : null;
    }
    const row = this.sql(`SELECT * FROM members WHERE scope = ? AND thread_id = ?`).get(scopeId, threadId) as Row | undefined;
    return row ? member(row) : null;
  }
  /**
   * The owner's current threads, in order: each listed thread is current here (and retired from any
   * other scope it was current in); a current thread no longer listed is retired. A thread joins
   * with its log read from its start. Returns the threads that were not current here before.
   */
  setMembers(scopeId: string, threadIds: readonly string[]): string[] {
    return this.transaction(() => {
      const now = this.now();
      const before = new Set(this.sql(`SELECT thread_id FROM members WHERE scope = ? AND state = 'current'`).pluck().all(scopeId) as string[]);
      this.sql(`UPDATE members SET state = 'retired' WHERE scope = ? AND state = 'current'`).run(scopeId);
      for (const [k, threadId] of threadIds.entries()) {
        this.sql(`UPDATE members SET state = 'retired' WHERE thread_id = ? AND scope != ? AND state = 'current'`).run(threadId, scopeId);
        this.sql(`INSERT INTO members (scope, thread_id, state, joined_at) VALUES (?, ?, 'current', ?) ON CONFLICT (scope, thread_id) DO UPDATE SET state = 'current'`)
          .run(scopeId, threadId, now + k);
      }
      return threadIds.filter((threadId) => !before.has(threadId));
    });
  }
  finishMember(scopeId: string, threadId: string) {
    this.sql(`UPDATE members SET state = 'done' WHERE scope = ? AND thread_id = ? AND state = 'retired'`).run(scopeId, threadId);
  }
  asked(scopeId: string, threadId: string, protocol: number) {
    this.sql(`UPDATE members SET asked_at = ?, asked_protocol = ? WHERE scope = ? AND thread_id = ?`).run(this.now(), protocol, scopeId, threadId);
  }
  /** A compaction of snapshot `seq` starts: the first try of a new snapshot, or one more. */
  compactTry(scopeId: string, threadId: string, seq: number) {
    this.sql(`UPDATE members SET compact_tries = CASE WHEN compacted_seq = ? THEN compact_tries + 1 ELSE 1 END, compacted_seq = ?, compact_tried_at = ? WHERE scope = ? AND thread_id = ?`)
      .run(seq, seq, this.now(), scopeId, threadId);
  }
  compactDone(scopeId: string, threadId: string) {
    this.sql(`UPDATE members SET compacted_at = ?, compact_error = NULL WHERE scope = ? AND thread_id = ?`).run(this.now(), scopeId, threadId);
  }
  compactFailed(scopeId: string, threadId: string, error: string) {
    this.sql(`UPDATE members SET compact_error = ? WHERE scope = ? AND thread_id = ?`).run(error, scopeId, threadId);
  }
  /** Its context size was read again after reads failed: that failure is over. Whether it was. */
  compactReadRecovered(scopeId: string, threadId: string) {
    return this.sql(`UPDATE members SET compacted_seq = NULL, compact_tries = 0, compact_error = NULL WHERE scope = ? AND thread_id = ? AND compacted_seq = ?`).run(scopeId, threadId, READ_FAILED).changes > 0;
  }
  /** Current members whose last compaction failed, fewer than `tries` times: the sweep tries them again (compaction decides when). */
  compactFailures(tries: number): Array<{ scope: string; threadId: string }> {
    return (this.sql(`SELECT scope, thread_id FROM members WHERE state = 'current' AND compact_error IS NOT NULL AND compact_tries < ?`).all(tries) as Row[]).map((r) => ({ scope: String(r.scope), threadId: String(r.thread_id) }));
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
  /**
   * The first of the log's last `within` messages logged from a thread's event `seq` or later:
   * where a turn's new message begins (it is at the log's end, so the scan stays short).
   */
  firstFrom(scopeId: string, threadId: string, seq: number, within = 1000): number | null {
    const from = Math.max(0, this.count(scopeId) - within);
    const i = this.sql(`SELECT MIN(i) FROM log WHERE scope = ? AND i >= ? AND thread_id = ? AND seq >= ?`).pluck().get(scopeId, from, threadId, seq);
    return i == null ? null : Number(i);
  }
  /**
   * Append one read of a scope's threads and move each thread's cursor, in one transaction: a
   * message is logged exactly once.
   */
  append(scopeId: string, entries: readonly LogEntry[], through: ReadonlyMap<string, number>) {
    this.transaction(() => {
      let i = this.count(scopeId);
      let size = 0;
      const insert = this.sql(`INSERT INTO log (scope, i, kind, text, size, at, thread_id, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const entry of entries) {
        const m = withSize(entry, i++);
        insert.run(scopeId, m.i, m.kind, m.text, m.size, m.at, m.threadId, m.seq);
        size += m.size;
      }
      if (size) {
        this.ensureTree(scopeId);
        this.sql(`UPDATE trees SET log_bytes = log_bytes + ? WHERE scope = ?`).run(size, scopeId);
      }
      for (const [threadId, seq] of through)
        this.sql(`UPDATE members SET last_seq = ? WHERE scope = ? AND thread_id = ? AND last_seq < ?`).run(seq, scopeId, threadId, seq);
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
