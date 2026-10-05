// Durable Advisor state in the plugin's own SQLite database. Evidence cards are
// immutable once written; the spend ledger and the settings log are never pruned.

import { createHash, randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { MIGRATIONS } from "./schema.js";
import { Requests, type ForkOrigin, type RequestRow } from "../rules/requests.js";
import type { EventRow } from "../rules/events.js";
import type { PauseReason } from "../rules/pause.js";
import type { Bucket } from "../rules/scheduler.js";
import { admitOccurrence, type IssueState, type NotificationReason } from "../rules/findings.js";
import type { Retained } from "../rules/retain.js";
import { reverses, type CitedChange, type LaterCard } from "../rules/reversal.js";

export type Db = ReturnType<BbPluginApi["storage"]["database"]>;

export function openStore(bb: Pick<BbPluginApi, "storage">): Store {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  return new Store(db);
}

/** The last turn-end snapshot of test-scoped paths (HEAD-relative patches). */
export interface CheckpointSnapshot {
  n: number;
  head: string | null;
  at: number;
  listed: string[]; // test paths the listing showed changed
  read: Record<string, string>; // path -> HEAD-relative patch, for the paths read this time
  unreadable: string[]; // read but truncated: their transition is unknown
}

export interface WatchState {
  pause: PauseReason[];
  failures: number;
  bucket: Bucket | null;
  budgetHold: { day: string; capsKey: string } | null;
  lastAgentMessage: { seq: number; text: string } | null;
  editsSinceCheckpoint: Record<string, string[]>;
  checkpointCursor: number;
  checkpointDue: boolean;
  pauseLog: Array<{ action: string; via: string; caller: "unverified"; at: number }>;
  /** Why the last context read forbids a dispatch (failed reads, former member); owned by observation. */
  dispatchGate: string | null;
  /** The environment root path was read (its value may still be null). */
  rootPathRead: boolean;
  /** Why an Initiative watch stopped this member watch (retired, former, thread archived or deleted, Initiative watch off); null when it did not. */
  initiativeEnded: string | null;
  /** The thread's own Initiative membership from its last successful context read (labels and feed filters only); null when it has none. */
  initiative?: { id: string; name: string; kind: string; role: string; worker: string | null; state: string } | null;
  /** Seed from the thread's first event when the thread was created at or after this time (a member that joined a watched Initiative). */
  fromStartIfCreatedAfter: number | null;
  /** When a thread read last answered BB's own 404 (the thread is deleted); a successful read clears it. */
  threadDeleted: number | null;
}

export const EMPTY_STATE: WatchState = {
  pause: [],
  failures: 0,
  bucket: null,
  budgetHold: null,
  lastAgentMessage: null,
  editsSinceCheckpoint: {},
  checkpointCursor: 0,
  checkpointDue: false,
  pauseLog: [],
  dispatchGate: null,
  rootPathRead: false,
  initiativeEnded: null,
  fromStartIfCreatedAfter: null,
  threadDeleted: null,
};

export interface WatchRow {
  id: string;
  threadId: string;
  origin: "selected" | "project" | "initiative";
  enabled: boolean;
  epoch: number;
  title: string | null;
  projectId: string | null;
  environmentId: string | null;
  rootPath: string | null;
  originPluginId: string | null;
  thread: { parentThreadId: string | null; archivedAt: number | null; createdAt: number | null; sourceThreadId: string | null } | null;
  startSeq: number | null;
  cursor: number | null;
  tip: number | null;
  atTip: boolean;
  seeded: boolean;
  state: WatchState;
  lastDrainAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface InitiativeWatchRow {
  id: string;
  name: string;
  enabled: boolean;
  /** When it was last turned on: members created since are read from their first event. */
  since: number;
  archived: boolean;
  syncedAt: number | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MemberRow {
  initiativeId: string;
  threadId: string;
  kind: string;
  role: string;
  worker: string | null;
  generation: number | null;
  state: string;
  excluded: boolean;
  firstSeen: number;
  lastSeen: number;
}

export interface CardRow {
  watchId: string;
  id: string;
  seq: number;
  ord: number;
  kind: "edit" | "state" | "command" | "claim" | "turn" | "note";
  path: string | null;
  text: string;
  encBytes: number;
  meta: Record<string, any>;
  judge: boolean;
  reviewed: boolean;
  createdAt: number;
}

export type GapLayer = "observation" | "evidence" | "judgment" | "requirements";

export interface GapRow {
  id: number;
  watchId: string;
  layer: GapLayer;
  reason: string;
  fromSeq: number | null;
  toSeq: number | null;
  detail: string | null;
  createdAt: number;
}

export type LedgerState = "reserved" | "sending" | "reconciled" | "unknown_charged" | "released" | "no-call";

export interface LedgerRow {
  id: string;
  reviewId: string;
  watchId: string;
  route: string;
  model: string | null;
  billing: "usd" | "subscription";
  state: LedgerState;
  day: string;
  reservedUsd: number;
  actualUsd: number | null;
  reservedTokens: number;
  actualTokens: number | null;
  posted: boolean;
  outcome: string | null;
  priceVersion: string | null;
  basis: string | null;
  note: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface OccurrenceRow {
  id: string;
  watchId: string;
  category: string;
  locator: string;
  severity: string;
  evidence: string;
  reviewId: string;
  route: string;
  model: string | null;
  summary: string;
  shown: Record<string, any>;
  retained: Retained | Record<string, any>;
  asOfSeq: number | null;
  coverage: string;
  score: number | null;
  preview: boolean;
  reconfirmed: string[];
  acknowledgedAt: number | null;
  cleared: boolean;
  createdAt: number;
}

const j = (v: unknown) => JSON.stringify(v);

function parseOr(text: string | null): any {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function hashKey(v: unknown): string {
  return createHash("sha256").update(j(v)).digest("hex").slice(0, 16);
}

export class Store {
  constructor(readonly db: Db) {}

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ------------------------------------------------------------------ meta

  getMeta(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  // ------------------------------------------------------------------ watches

  private toWatch(r: any): WatchRow {
    return {
      id: r.id,
      threadId: r.thread_id,
      origin: r.origin,
      enabled: !!r.enabled,
      epoch: r.epoch,
      title: r.title,
      projectId: r.project_id,
      environmentId: r.environment_id,
      rootPath: r.root_path,
      originPluginId: r.origin_plugin_id,
      thread: r.thread_json ? JSON.parse(r.thread_json) : null,
      startSeq: r.start_seq,
      cursor: r.cursor,
      tip: r.tip,
      atTip: !!r.at_tip,
      seeded: !!r.seeded,
      state: { ...EMPTY_STATE, ...JSON.parse(r.state_json) },
      lastDrainAt: r.last_drain_at,
      lastError: r.last_error,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  listWatches(): WatchRow[] {
    return (this.db.prepare("SELECT * FROM watches ORDER BY created_at").all() as any[]).map((r) => this.toWatch(r));
  }

  getWatch(id: string): WatchRow | null {
    const r = this.db.prepare("SELECT * FROM watches WHERE id = ?").get(id);
    return r ? this.toWatch(r) : null;
  }

  getWatchByThread(threadId: string): WatchRow | null {
    const r = this.db.prepare("SELECT * FROM watches WHERE thread_id = ?").get(threadId);
    return r ? this.toWatch(r) : null;
  }

  createWatch(threadId: string, origin: WatchRow["origin"], now: number): WatchRow {
    const id = `w_${randomUUID().slice(0, 8)}`;
    this.db
      .prepare(
        "INSERT INTO watches (id, thread_id, origin, enabled, epoch, state_json, created_at, updated_at) VALUES (?, ?, ?, 1, 1, ?, ?, ?)",
      )
      .run(id, threadId, origin, j(EMPTY_STATE), now, now);
    return this.getWatch(id)!;
  }

  saveWatch(w: WatchRow, now: number): void {
    this.db
      .prepare(
        `UPDATE watches SET origin=?, enabled=?, epoch=?, title=?, project_id=?, environment_id=?, root_path=?, origin_plugin_id=?,
         thread_json=?, start_seq=?, cursor=?, tip=?, at_tip=?, seeded=?, state_json=?, last_drain_at=?, last_error=?, updated_at=? WHERE id=?`,
      )
      .run(
        w.origin,
        w.enabled ? 1 : 0,
        w.epoch,
        w.title,
        w.projectId,
        w.environmentId,
        w.rootPath,
        w.originPluginId,
        w.thread ? j(w.thread) : null,
        w.startSeq,
        w.cursor,
        w.tip,
        w.atTip ? 1 : 0,
        w.seeded ? 1 : 0,
        j(w.state),
        w.lastDrainAt,
        w.lastError,
        now,
        w.id,
      );
    w.updatedAt = now;
  }

  /** Removing a watch deletes its evidence and findings; the ledger keeps its rows. */
  deleteWatch(id: string): void {
    this.tx(() => {
      this.db.prepare("DELETE FROM discussions WHERE occurrence_id IN (SELECT id FROM occurrences WHERE watch_id = ?)").run(id);
      for (const t of ["cards", "requests", "request_state", "gaps", "issues", "occurrences", "notifications", "reviews", "checkpoints"]) {
        this.db.prepare(`DELETE FROM ${t} WHERE watch_id = ?`).run(id);
      }
      this.db.prepare("DELETE FROM watches WHERE id = ?").run(id);
    });
  }

  // ------------------------------------------------------------------ Initiative watches

  private toInitiativeWatch(r: any): InitiativeWatchRow {
    return { id: r.id, name: r.name, enabled: !!r.enabled, since: r.since, archived: !!r.archived, syncedAt: r.synced_at, error: r.error, createdAt: r.created_at, updatedAt: r.updated_at };
  }

  private toMember(r: any): MemberRow {
    return { initiativeId: r.initiative_id, threadId: r.thread_id, kind: r.kind, role: r.role, worker: r.worker, generation: r.generation, state: r.state, excluded: !!r.excluded, firstSeen: r.first_seen, lastSeen: r.last_seen };
  }

  listInitiativeWatches(): InitiativeWatchRow[] {
    return (this.db.prepare("SELECT * FROM initiative_watches ORDER BY created_at").all() as any[]).map((r) => this.toInitiativeWatch(r));
  }

  getInitiativeWatch(id: string): InitiativeWatchRow | null {
    const r = this.db.prepare("SELECT * FROM initiative_watches WHERE id = ?").get(id);
    return r ? this.toInitiativeWatch(r) : null;
  }

  saveInitiativeWatch(iw: Omit<InitiativeWatchRow, "createdAt" | "updatedAt">, now: number): void {
    this.db
      .prepare(
        `INSERT INTO initiative_watches (id, name, enabled, since, archived, synced_at, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, enabled=excluded.enabled, since=excluded.since, archived=excluded.archived,
         synced_at=excluded.synced_at, error=excluded.error, updated_at=excluded.updated_at`,
      )
      .run(iw.id, iw.name, iw.enabled ? 1 : 0, iw.since, iw.archived ? 1 : 0, iw.syncedAt, iw.error, now, now);
  }

  /** Forget an Initiative watch and the members it saw; member watches are the caller's. */
  deleteInitiativeWatch(id: string): void {
    this.tx(() => {
      this.db.prepare("DELETE FROM initiative_members WHERE initiative_id = ?").run(id);
      this.db.prepare("DELETE FROM initiative_watches WHERE id = ?").run(id);
    });
  }

  listMembers(initiativeId: string): MemberRow[] {
    return (this.db.prepare("SELECT * FROM initiative_members WHERE initiative_id = ? ORDER BY first_seen, thread_id").all(initiativeId) as any[]).map((r) => this.toMember(r));
  }

  /** The thread's most recently seen membership in an Initiative the Advisor knows. */
  memberOf(threadId: string): (MemberRow & { initiativeName: string; initiativeEnabled: boolean }) | null {
    const r = this.db
      .prepare(
        `SELECT m.*, w.name AS initiative_name, w.enabled AS initiative_enabled FROM initiative_members m
         JOIN initiative_watches w ON w.id = m.initiative_id WHERE m.thread_id = ? ORDER BY m.last_seen DESC LIMIT 1`,
      )
      .get(threadId) as any;
    return r ? { ...this.toMember(r), initiativeName: r.initiative_name, initiativeEnabled: !!r.initiative_enabled } : null;
  }

  /** Record what a listing said about one member; exclusion and first sight are kept. */
  saveMember(m: Omit<MemberRow, "excluded" | "firstSeen" | "lastSeen">, now: number): void {
    this.db
      .prepare(
        `INSERT INTO initiative_members (initiative_id, thread_id, kind, role, worker, generation, state, excluded, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(initiative_id, thread_id) DO UPDATE SET kind=excluded.kind, role=excluded.role, worker=excluded.worker, generation=excluded.generation,
         state=excluded.state, last_seen=excluded.last_seen`,
      )
      .run(m.initiativeId, m.threadId, m.kind, m.role, m.worker, m.generation, m.state, now, now);
  }

  setMemberState(initiativeId: string, threadId: string, state: string, now: number): void {
    this.db.prepare("UPDATE initiative_members SET state = ?, last_seen = ? WHERE initiative_id = ? AND thread_id = ?").run(state, now, initiativeId, threadId);
  }

  /** Exclude (or include again) a thread from every Initiative watch that has seen it; returns the Initiatives affected. */
  setExcluded(threadId: string, excluded: boolean): string[] {
    const ids = (this.db.prepare("SELECT initiative_id FROM initiative_members WHERE thread_id = ? AND excluded = ?").all(threadId, excluded ? 0 : 1) as any[]).map((r) => String(r.initiative_id));
    this.db.prepare("UPDATE initiative_members SET excluded = ? WHERE thread_id = ?").run(excluded ? 1 : 0, threadId);
    return ids;
  }

  // ------------------------------------------------------------------ request table

  loadRequests(watchId: string, ctx: { parent: string | null; fork: ForkOrigin }): Requests {
    const rq = new Requests({ parent: ctx.parent, coordinator: null, member: false, fork: ctx.fork });
    for (const r of this.db.prepare("SELECT request_id, row FROM requests WHERE watch_id = ?").all(watchId) as any[]) {
      rq.rows.set(r.request_id, JSON.parse(r.row) as RequestRow);
    }
    const s = this.db.prepare("SELECT state FROM request_state WHERE watch_id = ?").get(watchId) as { state: string } | undefined;
    if (s) {
      const st = JSON.parse(s.state);
      for (const [seq, pair] of st.changes ?? []) rq.owner.changes.set(seq, pair);
      rq.owner.knownFrom = st.knownFrom ?? 0;
      rq.owner.malformed = st.malformed ?? [];
      rq.owner.anchor = st.anchor ?? ctx.parent;
      rq.owner.anchorOk = st.anchorOk ?? false;
      rq.gaps = st.gaps ?? [];
      rq.notes = st.notes ?? [];
      rq.orphanReceipts = st.orphanReceipts ?? [];
      for (const [rid, row] of st.orphans ?? []) rq.orphans.set(rid, row as EventRow);
    }
    return rq;
  }

  saveRequests(watchId: string, rq: Requests): void {
    this.tx(() => {
      const up = this.db.prepare(
        "INSERT INTO requests (watch_id, request_id, seq, row) VALUES (?, ?, ?, ?) ON CONFLICT(watch_id, request_id) DO UPDATE SET row = excluded.row",
      );
      for (const [rid, row] of rq.rows) up.run(watchId, rid, row.seq, j(row));
      const state = {
        changes: [...rq.owner.changes.entries()],
        knownFrom: rq.owner.knownFrom,
        malformed: rq.owner.malformed,
        anchor: rq.owner.anchor,
        anchorOk: rq.owner.anchorOk,
        gaps: rq.gaps,
        notes: rq.notes,
        orphanReceipts: rq.orphanReceipts,
        orphans: [...rq.orphans.entries()],
      };
      this.db
        .prepare("INSERT INTO request_state (watch_id, state) VALUES (?, ?) ON CONFLICT(watch_id) DO UPDATE SET state = excluded.state")
        .run(watchId, j(state));
    });
  }

  // ------------------------------------------------------------------ cards

  private toCard(r: any): CardRow {
    return {
      watchId: r.watch_id,
      id: r.id,
      seq: r.seq,
      ord: r.ord,
      kind: r.kind,
      path: r.path,
      text: r.text,
      encBytes: r.enc_bytes,
      meta: JSON.parse(r.meta),
      judge: !!r.judge,
      reviewed: !!r.reviewed,
      createdAt: r.created_at,
    };
  }

  /** Cards are immutable: a second insert of the same (watch, id) is ignored. */
  insertCard(c: Omit<CardRow, "reviewed">): boolean {
    const res = this.db
      .prepare(
        "INSERT OR IGNORE INTO cards (watch_id, id, seq, ord, kind, path, text, enc_bytes, meta, judge, reviewed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
      )
      .run(c.watchId, c.id, c.seq, c.ord, c.kind, c.path, c.text, c.encBytes, j(c.meta), c.judge ? 1 : 0, c.createdAt);
    return res.changes > 0;
  }

  /** Unreviewed judged cards in FIFO order from the frontier. */
  frontierCards(watchId: string, limit = 400): CardRow[] {
    return (
      this.db
        .prepare("SELECT * FROM cards WHERE watch_id = ? AND judge = 1 AND reviewed = 0 ORDER BY seq, ord LIMIT ?")
        .all(watchId, limit) as any[]
    ).map((r) => this.toCard(r));
  }

  backlog(watchId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM cards WHERE watch_id = ? AND judge = 1 AND reviewed = 0").get(watchId) as { n: number }).n;
  }

  getCards(watchId: string, ids: string[]): CardRow[] {
    if (ids.length === 0) return [];
    const q = this.db.prepare("SELECT * FROM cards WHERE watch_id = ? AND id = ?");
    return ids.flatMap((id) => {
      const r = q.get(watchId, id);
      return r ? [this.toCard(r)] : [];
    });
  }

  listCards(watchId: string, opts: { beforeSeq?: number; limit: number }): CardRow[] {
    return (
      this.db
        .prepare("SELECT * FROM cards WHERE watch_id = ? AND seq < ? ORDER BY seq DESC, ord DESC LIMIT ?")
        .all(watchId, opts.beforeSeq ?? Number.MAX_SAFE_INTEGER, opts.limit) as any[]
    ).map((r) => this.toCard(r));
  }

  markReviewed(watchId: string, ids: string[]): void {
    const q = this.db.prepare("UPDATE cards SET reviewed = 1 WHERE watch_id = ? AND id = ?");
    this.tx(() => {
      for (const id of ids) q.run(watchId, id);
    });
  }

  /** Skip to tip: every unreviewed card becomes an explicit not-judged gap. Nothing skips silently. */
  skipToTip(watchId: string, now: number, via: string): number {
    return this.tx(() => {
      const r = this.db
        .prepare("SELECT COUNT(*) AS n, MIN(seq) AS lo, MAX(seq) AS hi FROM cards WHERE watch_id = ? AND judge = 1 AND reviewed = 0")
        .get(watchId) as { n: number; lo: number | null; hi: number | null };
      if (r.n === 0) return 0;
      this.db.prepare("UPDATE cards SET reviewed = 1 WHERE watch_id = ? AND judge = 1 AND reviewed = 0").run(watchId);
      this.addGap(watchId, "judgment", "skipped-to-tip", r.lo, r.hi, `${r.n} cards not judged; Skip to tip via ${via}, caller unverified`, now);
      return r.n;
    });
  }

  // ------------------------------------------------------------------ checkpoints

  getCheckpoint(watchId: string): CheckpointSnapshot | null {
    const r = this.db.prepare("SELECT snapshot FROM checkpoints WHERE watch_id = ?").get(watchId) as { snapshot: string } | undefined;
    return r ? (JSON.parse(r.snapshot) as CheckpointSnapshot) : null;
  }

  setCheckpoint(watchId: string, snap: CheckpointSnapshot): void {
    this.db
      .prepare("INSERT INTO checkpoints (watch_id, snapshot) VALUES (?, ?) ON CONFLICT(watch_id) DO UPDATE SET snapshot = excluded.snapshot")
      .run(watchId, j(snap));
  }

  // ------------------------------------------------------------------ gaps and actions

  addGap(watchId: string, layer: GapLayer, reason: string, fromSeq: number | null, toSeq: number | null, detail: string | null, now: number): void {
    const last = this.db
      .prepare("SELECT reason, from_seq, to_seq, detail FROM gaps WHERE watch_id = ? ORDER BY id DESC LIMIT 1")
      .get(watchId) as any;
    if (last && last.reason === reason && last.from_seq === fromSeq && last.to_seq === toSeq && last.detail === detail) return;
    this.db
      .prepare("INSERT INTO gaps (watch_id, layer, reason, from_seq, to_seq, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(watchId, layer, reason, fromSeq, toSeq, detail, now);
  }

  listGaps(watchId: string, limit = 200): GapRow[] {
    return (this.db.prepare("SELECT * FROM gaps WHERE watch_id = ? ORDER BY id DESC LIMIT ?").all(watchId, limit) as any[]).map((r) => ({
      id: r.id,
      watchId: r.watch_id,
      layer: r.layer,
      reason: r.reason,
      fromSeq: r.from_seq,
      toSeq: r.to_seq,
      detail: r.detail,
      createdAt: r.created_at,
    }));
  }

  logAction(watchId: string | null, action: string, detail: string | null, via: string, now: number): void {
    this.db.prepare("INSERT INTO actions (at, watch_id, action, detail, via) VALUES (?, ?, ?, ?, ?)").run(now, watchId, action, detail, via);
  }

  listActions(limit = 50): Array<{ at: number; watchId: string | null; action: string; detail: string | null; via: string; caller: string }> {
    return (this.db.prepare("SELECT * FROM actions ORDER BY id DESC LIMIT ?").all(limit) as any[]).map((r) => ({
      at: r.at,
      watchId: r.watch_id,
      action: r.action,
      detail: r.detail,
      via: r.via,
      caller: r.caller,
    }));
  }

  // ------------------------------------------------------------------ settings log (never pruned)

  logSettings(rev: number, keys: string[], summary: string, now: number): void {
    this.db.prepare("INSERT INTO settings_log (at, settings_rev, keys, summary) VALUES (?, ?, ?, ?)").run(now, rev, j(keys), summary);
  }

  listSettingsLog(limit = 50): Array<{ at: number; settingsRev: number; keys: string[]; summary: string }> {
    return (this.db.prepare("SELECT * FROM settings_log ORDER BY id DESC LIMIT ?").all(limit) as any[]).map((r) => ({
      at: r.at,
      settingsRev: r.settings_rev,
      keys: JSON.parse(r.keys),
      summary: r.summary,
    }));
  }

  // ------------------------------------------------------------------ reviews

  insertReview(r: {
    id: string;
    watchId: string;
    route: string;
    model: string | null;
    state: string;
    preview: boolean;
    dispatchTip: number | null;
    cardIds: string[];
    meta: unknown;
    dispatchSnapshot: unknown;
    settingsRev: number;
    epoch: number;
    now: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO reviews (id, watch_id, route, model, state, preview, dispatch_tip, card_ids, meta, dispatch_snapshot, settings_rev, epoch, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.id, r.watchId, r.route, r.model, r.state, r.preview ? 1 : 0, r.dispatchTip, j(r.cardIds), j(r.meta), j(r.dispatchSnapshot), r.settingsRev, r.epoch, r.now);
  }

  finishReview(id: string, state: string, outcome: string | null, error: string | null, result: unknown, now: number): void {
    this.db
      .prepare("UPDATE reviews SET state = ?, outcome = ?, error = ?, result = ?, finished_at = ? WHERE id = ?")
      .run(state, outcome, error, result === undefined ? null : j(result), now, id);
  }

  getReview(id: string): any | null {
    const r = this.db.prepare("SELECT * FROM reviews WHERE id = ?").get(id) as any;
    return r ? this.reviewOut(r) : null;
  }

  private reviewOut(r: any) {
    return {
      id: r.id as string,
      watchId: r.watch_id as string,
      route: r.route as string,
      model: r.model as string | null,
      state: r.state as string,
      preview: !!r.preview,
      dispatchTip: r.dispatch_tip as number | null,
      cardIds: JSON.parse(r.card_ids) as string[],
      meta: JSON.parse(r.meta),
      dispatchSnapshot: r.dispatch_snapshot ? JSON.parse(r.dispatch_snapshot) : null,
      settingsRev: r.settings_rev as number,
      epoch: r.epoch as number,
      outcome: r.outcome as string | null,
      error: r.error as string | null,
      result: parseOr(r.result),
      createdAt: r.created_at as number,
      finishedAt: r.finished_at as number | null,
      heldAt: r.held_at as number | null,
      checkedAt: r.checked_at as number | null,
    };
  }

  listReviews(watchId: string | null, limit = 30) {
    const rows = (
      watchId
        ? this.db.prepare("SELECT * FROM reviews WHERE watch_id = ? ORDER BY created_at DESC LIMIT ?").all(watchId, limit)
        : this.db.prepare("SELECT * FROM reviews ORDER BY created_at DESC LIMIT ?").all(limit)
    ) as any[];
    return rows.map((r) => this.reviewOut(r));
  }

  /** Held reviews to recheck, least recently checked first. */
  heldReviews(limit = 1000): ReturnType<Store["reviewOut"]>[] {
    return (this.db.prepare("SELECT * FROM reviews WHERE state = 'held' ORDER BY COALESCE(checked_at, held_at, created_at), created_at LIMIT ?").all(limit) as any[]).map((r) =>
      this.reviewOut(r),
    );
  }

  /** The watch's held review, if any: its cards must not be sent again while it waits. */
  heldFor(watchId: string): { id: string; heldAt: number | null } | null {
    const r = this.db.prepare("SELECT id, held_at FROM reviews WHERE watch_id = ? AND state = 'held' ORDER BY created_at LIMIT 1").get(watchId) as any;
    return r ? { id: r.id, heldAt: r.held_at } : null;
  }

  /** First hold: the paid result stays; held_at is set once and never moves. */
  holdReview(id: string, error: string, result: unknown, now: number): void {
    this.db
      .prepare("UPDATE reviews SET state = 'held', error = ?, result = ?, held_at = COALESCE(held_at, ?), checked_at = ? WHERE id = ?")
      .run(error, j(result), now, now, id);
  }

  /** A recheck that is still unknown (or failed): only the reasons and the check time change. */
  recheckHeld(id: string, error: string, result: unknown | undefined, now: number): void {
    if (result === undefined) this.db.prepare("UPDATE reviews SET error = ?, checked_at = ? WHERE id = ?").run(error, now, id);
    else this.db.prepare("UPDATE reviews SET error = ?, result = ?, checked_at = ? WHERE id = ?").run(error, j(result), now, id);
  }

  /**
   * On load: reviews left dispatching or sending by a previous process ended
   * unknown. A review left completing already holds its paid, parsed result:
   * it is held for revalidation (first-held time = when the result arrived),
   * never sent again. One without a readable result is interrupted, visibly.
   */
  recoverInterrupted(now: number): number {
    return this.tx(() => {
      let n = 0;
      for (const r of this.db.prepare("SELECT id, result FROM reviews WHERE state = 'completing'").all() as any[]) {
        const parsed = (parseOr(r.result) as { parsed?: unknown } | null)?.parsed;
        if (parsed && typeof parsed === "object") {
          this.db.prepare("UPDATE reviews SET state = 'held', error = 'reloaded while completing: revalidating the stored result', held_at = COALESCE(held_at, finished_at, ?) WHERE id = ?").run(now, r.id);
        } else {
          this.db
            .prepare("UPDATE reviews SET state = 'interrupted', outcome = 'unknown', error = 'reloaded while completing; the stored result is missing or unreadable', finished_at = ? WHERE id = ?")
            .run(now, r.id);
        }
        n++;
      }
      return (
        n +
        this.db
          .prepare("UPDATE reviews SET state = 'interrupted', outcome = 'unknown', error = 'plugin stopped or reloaded during the review', finished_at = ? WHERE state IN ('dispatching', 'sending')")
          .run(now).changes
      );
    });
  }

  // ------------------------------------------------------------------ ledger (never pruned)

  private toLedger(r: any): LedgerRow {
    return {
      id: r.id,
      reviewId: r.review_id,
      watchId: r.watch_id,
      route: r.route,
      model: r.model,
      billing: r.billing,
      state: r.state,
      day: r.day,
      reservedUsd: r.reserved_usd,
      actualUsd: r.actual_usd,
      reservedTokens: r.reserved_tokens,
      actualTokens: r.actual_tokens,
      posted: !!r.posted,
      outcome: r.outcome,
      priceVersion: r.price_version,
      basis: r.basis,
      note: r.note,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /** What a day's rows count against the caps: unknown usage is charged in full and never refunded. */
  dayTotals(day: string, billing: "usd" | "subscription"): { usd: number; tokens: number; requests: number } {
    return this.totalsOf((this.db.prepare("SELECT * FROM ledger WHERE day = ? AND billing = ?").all(day, billing) as any[]).map((r) => this.toLedger(r)));
  }

  private totalsOf(rows: LedgerRow[]): { usd: number; tokens: number; requests: number } {
    let usd = 0;
    let tokens = 0;
    let requests = 0;
    for (const r of rows) {
      if (r.state === "reconciled") {
        usd += r.actualUsd ?? r.reservedUsd;
        tokens += r.actualTokens ?? r.reservedTokens;
      } else if (r.state === "reserved" || r.state === "sending" || r.state === "unknown_charged") {
        usd += r.reservedUsd;
        tokens += r.reservedTokens;
      }
      if (r.posted && r.state !== "no-call") requests++;
    }
    return { usd, tokens, requests };
  }

  /** The same charges as dayTotals, for every row reserved since a moment (the budget period's start). */
  periodTotals(since: number, billing: "usd" | "subscription"): { usd: number; tokens: number; requests: number } {
    return this.totalsOf((this.db.prepare("SELECT * FROM ledger WHERE created_at >= ? AND billing = ?").all(since, billing) as any[]).map((r) => this.toLedger(r)));
  }

  /**
   * Atomic admission: read the period's totals and write the reservation in one
   * transaction, so two reviews cannot both fit under the same remaining cap.
   * `since` is the budget period's start (the day, extended by a time-zone carry).
   */
  reserve(
    row: Omit<LedgerRow, "state" | "actualUsd" | "actualTokens" | "posted" | "outcome" | "createdAt" | "updatedAt" | "note">,
    caps: { usd: number | null; requests: number | null; tokens: number | null },
    now: number,
    since?: number,
  ): { ok: true } | { ok: false; why: string } {
    return this.tx(() => {
      const t = since === undefined ? this.dayTotals(row.day, row.billing) : this.periodTotals(since, row.billing);
      if (caps.requests === null) return { ok: false as const, why: "daily request cap is unset" };
      if (t.requests + 1 > caps.requests) return { ok: false as const, why: `daily request cap reached (${t.requests}/${caps.requests})` };
      if (row.billing === "usd") {
        if (caps.usd === null) return { ok: false as const, why: "daily USD cap is unset" };
        if (t.usd + row.reservedUsd > caps.usd + 1e-12) {
          return { ok: false as const, why: `daily USD cap: $${t.usd.toFixed(5)} charged + $${row.reservedUsd.toFixed(5)} reservation > $${caps.usd}` };
        }
      } else {
        if (caps.tokens === null) return { ok: false as const, why: "daily subscription token cap is unset" };
        if (t.tokens + row.reservedTokens > caps.tokens) {
          return { ok: false as const, why: `daily subscription token cap: ${t.tokens} + ${row.reservedTokens} reserved > ${caps.tokens}` };
        }
      }
      this.db
        .prepare(
          `INSERT INTO ledger (id, review_id, watch_id, route, model, billing, state, day, reserved_usd, reserved_tokens, posted, price_version, basis, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, 1, ?, ?, ?, ?)`,
        )
        .run(row.id, row.reviewId, row.watchId, row.route, row.model, row.billing, row.day, row.reservedUsd, row.reservedTokens, row.priceVersion, row.basis, now, now);
      return { ok: true as const };
    });
  }

  noCall(row: { id: string; reviewId: string; watchId: string; route: string; model: string | null; day: string; note: string }, now: number): void {
    this.db
      .prepare(
        `INSERT INTO ledger (id, review_id, watch_id, route, model, billing, state, day, posted, outcome, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'usd', 'no-call', ?, 0, 'no-call', ?, ?, ?)`,
      )
      .run(row.id, row.reviewId, row.watchId, row.route, row.model, row.day, row.note, now, now);
  }

  ledgerUpdate(id: string, patch: Partial<Pick<LedgerRow, "state" | "actualUsd" | "actualTokens" | "posted" | "outcome" | "note">>, now: number): void {
    const cur = this.getLedger(id);
    if (!cur) return;
    const n = { ...cur, ...patch };
    this.db
      .prepare("UPDATE ledger SET state = ?, actual_usd = ?, actual_tokens = ?, posted = ?, outcome = ?, note = ?, updated_at = ? WHERE id = ?")
      .run(n.state, n.actualUsd, n.actualTokens, n.posted ? 1 : 0, n.outcome, n.note, now, id);
  }

  getLedger(id: string): LedgerRow | null {
    const r = this.db.prepare("SELECT * FROM ledger WHERE id = ?").get(id);
    return r ? this.toLedger(r) : null;
  }

  listLedger(limit = 50): LedgerRow[] {
    return (this.db.prepare("SELECT * FROM ledger ORDER BY created_at DESC LIMIT ?").all(limit) as any[]).map((r) => this.toLedger(r));
  }

  /** On load: any row still reserved or sending is charged in full (its request may have run). */
  ledgerOnLoad(now: number): number {
    return this.db
      .prepare("UPDATE ledger SET state = 'unknown_charged', note = 'reloaded while in flight; charged in full', updated_at = ? WHERE state IN ('reserved', 'sending')")
      .run(now).changes;
  }

  // ------------------------------------------------------------------ issues, occurrences, notifications

  issueState(watchId: string, category: string, locator: string): IssueState | null {
    const r = this.db.prepare("SELECT state FROM issues WHERE watch_id = ? AND category = ? AND locator = ?").get(watchId, category, locator) as
      | { state: IssueState }
      | undefined;
    return r?.state ?? null;
  }

  setIssueState(watchId: string, category: string, locator: string, state: IssueState, subjectVerified: boolean, now: number): void {
    this.db
      .prepare(
        `INSERT INTO issues (watch_id, category, locator, state, subject_verified, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(watch_id, category, locator) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      )
      .run(watchId, category, locator, state, subjectVerified ? 1 : 0, now);
  }

  /** A later card removed the issue's cited lines (observed). The next occurrence notifies. */
  setIssueReversed(watchId: string, category: string, locator: string, by: string | null, now: number): void {
    this.db.prepare("UPDATE issues SET reversed_by = ?, updated_at = ? WHERE watch_id = ? AND category = ? AND locator = ?").run(by, now, watchId, category, locator);
  }

  /** The cited change of an issue's latest real occurrence, when it has one. */
  issueChange(watchId: string, category: string, locator: string): CitedChange | null {
    const r = this.db
      .prepare("SELECT shown FROM occurrences WHERE watch_id = ? AND category = ? AND locator = ? AND preview = 0 ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(watchId, category, locator) as { shown: string } | undefined;
    return ((r ? JSON.parse(r.shown) : null) as { change?: CitedChange } | null)?.change ?? null;
  }

  /**
   * Mark every test-integrity issue whose cited lines one of these later cards
   * removed. The issue stays as it is (no fixed verdict); only its next
   * occurrence notifies.
   */
  noteReversals(watchId: string, root: string | null, cards: Array<LaterCard & { id: string }>, now: number): number {
    const later = cards.filter((c) => c.hunks && (c.kind === "edit" || (c.kind === "state" && c.side === "removed")));
    if (later.length === 0) return 0;
    let n = 0;
    for (const i of this.listIssues(watchId)) {
      if (i.category !== "test-integrity" || i.reversedBy !== null) continue;
      const change = this.issueChange(watchId, i.category, i.locator);
      const by = change ? later.find((c) => reverses(c, change, root)) : undefined;
      if (by) {
        this.setIssueReversed(watchId, i.category, i.locator, by.id, now);
        n++;
      }
    }
    return n;
  }

  /**
   * The durable form of Findings.add: same rule (admitOccurrence), one
   * transaction. A preview occurrence is stored for display only: it never
   * touches issue state, notifications or real occurrences (its id is its own).
   */
  addOccurrence(o: Omit<OccurrenceRow, "reconfirmed" | "acknowledgedAt" | "cleared">, subjectVerified: boolean): { stored: boolean; notify: NotificationReason | null } {
    return this.tx(() => {
      const existing = this.db.prepare("SELECT reconfirmed FROM occurrences WHERE id = ?").get(o.id) as { reconfirmed: string } | undefined;
      if (o.preview) {
        if (existing) return { stored: false, notify: null };
        this.insertOccurrence(o);
        return { stored: true, notify: null };
      }
      const prior = this.issueState(o.watchId, o.category, o.locator);
      const reversed = this.reversedBy(o.watchId, o.category, o.locator) !== null;
      const r = admitOccurrence(prior, existing !== undefined, subjectVerified, reversed);
      if (existing) {
        const rc = JSON.parse(existing.reconfirmed) as string[];
        rc.push(o.reviewId);
        this.db.prepare("UPDATE occurrences SET reconfirmed = ? WHERE id = ?").run(j(rc), o.id);
        return { stored: false, notify: null };
      }
      this.insertOccurrence(o);
      if (r.nextState) this.setIssueState(o.watchId, o.category, o.locator, r.nextState, subjectVerified, o.createdAt);
      if (reversed) this.setIssueReversed(o.watchId, o.category, o.locator, null, o.createdAt);
      if (r.notify) {
        this.db
          .prepare("INSERT INTO notifications (occurrence_id, watch_id, reason, severity, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(o.id, o.watchId, r.notify, o.severity, o.createdAt);
      }
      return { stored: true, notify: r.notify };
    });
  }

  reversedBy(watchId: string, category: string, locator: string): string | null {
    const r = this.db.prepare("SELECT reversed_by FROM issues WHERE watch_id = ? AND category = ? AND locator = ?").get(watchId, category, locator) as
      | { reversed_by: string | null }
      | undefined;
    return r?.reversed_by ?? null;
  }

  private insertOccurrence(o: Omit<OccurrenceRow, "reconfirmed" | "acknowledgedAt" | "cleared">): void {
    this.db
      .prepare(
        `INSERT INTO occurrences (id, watch_id, category, locator, severity, evidence, review_id, route, model, summary, shown, retained, as_of_seq, coverage, score, preview, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        o.id,
        o.watchId,
        o.category,
        o.locator,
        o.severity,
        o.evidence,
        o.reviewId,
        o.route,
        o.model,
        o.summary,
        j(o.shown),
        j(o.retained),
        o.asOfSeq,
        o.coverage,
        o.score,
        o.preview ? 1 : 0,
        o.createdAt,
      );
  }

  private toOcc(r: any): OccurrenceRow {
    return {
      id: r.id,
      watchId: r.watch_id,
      category: r.category,
      locator: r.locator,
      severity: r.severity,
      evidence: r.evidence,
      reviewId: r.review_id,
      route: r.route,
      model: r.model,
      summary: r.summary,
      shown: JSON.parse(r.shown),
      retained: JSON.parse(r.retained),
      asOfSeq: r.as_of_seq,
      coverage: r.coverage,
      score: r.score,
      preview: !!r.preview,
      reconfirmed: JSON.parse(r.reconfirmed),
      acknowledgedAt: r.acknowledged_at,
      cleared: !!r.cleared,
      createdAt: r.created_at,
    };
  }

  listOccurrences(watchId: string | null, limit = 200): OccurrenceRow[] {
    const rows = (
      watchId
        ? this.db.prepare("SELECT * FROM occurrences WHERE watch_id = ? ORDER BY created_at DESC LIMIT ?").all(watchId, limit)
        : this.db.prepare("SELECT * FROM occurrences ORDER BY created_at DESC LIMIT ?").all(limit)
    ) as any[];
    return rows.map((r) => this.toOcc(r));
  }

  /** Findings across watches (null: every watch), newest first, strictly before a (createdAt, id) cursor. */
  listFeed(watchIds: string[] | null, limit: number, before: { createdAt: number; id: string } | null): OccurrenceRow[] {
    if (watchIds !== null && watchIds.length === 0) return [];
    const where: string[] = [];
    const args: unknown[] = [];
    if (watchIds !== null) {
      where.push(`watch_id IN (${watchIds.map(() => "?").join(",")})`);
      args.push(...watchIds);
    }
    if (before) {
      where.push("(created_at < ? OR (created_at = ? AND id < ?))");
      args.push(before.createdAt, before.createdAt, before.id);
    }
    const sql = `SELECT * FROM occurrences ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...args, limit) as any[]).map((r) => this.toOcc(r));
  }

  /** Real (not preview) findings not yet marked seen, counted per watch and severity. */
  unseenCounts(): Array<{ watchId: string; severity: string; n: number }> {
    return (
      this.db.prepare("SELECT watch_id, severity, COUNT(*) AS n FROM occurrences WHERE preview = 0 AND acknowledged_at IS NULL GROUP BY watch_id, severity").all() as any[]
    ).map((r) => ({ watchId: r.watch_id, severity: r.severity, n: Number(r.n) }));
  }

  /** Mark every unseen finding of these watches (null: all) seen; returns how many. */
  acknowledgeAll(watchIds: string[] | null, now: number): number {
    if (watchIds === null) return this.db.prepare("UPDATE occurrences SET acknowledged_at = ? WHERE acknowledged_at IS NULL").run(now).changes;
    let n = 0;
    const stmt = this.db.prepare("UPDATE occurrences SET acknowledged_at = ? WHERE watch_id = ? AND acknowledged_at IS NULL");
    this.tx(() => {
      for (const id of watchIds) n += stmt.run(now, id).changes;
    });
    return n;
  }

  discussionOf(occurrenceId: string): string | null {
    const r = this.db.prepare("SELECT thread_id FROM discussions WHERE occurrence_id = ?").get(occurrenceId) as { thread_id: string } | undefined;
    return r?.thread_id ?? null;
  }

  saveDiscussion(occurrenceId: string, threadId: string, now: number): void {
    this.db
      .prepare("INSERT INTO discussions (occurrence_id, thread_id, created_at) VALUES (?, ?, ?) ON CONFLICT(occurrence_id) DO UPDATE SET thread_id = excluded.thread_id, created_at = excluded.created_at")
      .run(occurrenceId, threadId, now);
  }

  forgetDiscussion(occurrenceId: string): void {
    this.db.prepare("DELETE FROM discussions WHERE occurrence_id = ?").run(occurrenceId);
  }

  getOccurrence(id: string): OccurrenceRow | null {
    const r = this.db.prepare("SELECT * FROM occurrences WHERE id = ?").get(id);
    return r ? this.toOcc(r) : null;
  }

  acknowledge(id: string, now: number): boolean {
    return this.db.prepare("UPDATE occurrences SET acknowledged_at = ? WHERE id = ? AND acknowledged_at IS NULL").run(now, id).changes > 0;
  }

  clearAcknowledged(watchId: string): number {
    return this.db.prepare("UPDATE occurrences SET cleared = 1 WHERE watch_id = ? AND acknowledged_at IS NOT NULL AND cleared = 0").run(watchId).changes;
  }

  listIssues(watchId: string): Array<{ category: string; locator: string; state: IssueState; subjectVerified: boolean; reversedBy: string | null; updatedAt: number }> {
    return (this.db.prepare("SELECT * FROM issues WHERE watch_id = ? ORDER BY updated_at DESC").all(watchId) as any[]).map((r) => ({
      category: r.category,
      locator: r.locator,
      state: r.state,
      subjectVerified: !!r.subject_verified,
      reversedBy: r.reversed_by ?? null,
      updatedAt: r.updated_at,
    }));
  }

  listNotifications(limit = 50): Array<{ id: number; occurrenceId: string; watchId: string; reason: string; severity: string; createdAt: number }> {
    return (this.db.prepare("SELECT * FROM notifications ORDER BY id DESC LIMIT ?").all(limit) as any[]).map((r) => ({
      id: r.id,
      occurrenceId: r.occurrence_id,
      watchId: r.watch_id,
      reason: r.reason,
      severity: r.severity,
      createdAt: r.created_at,
    }));
  }

  // ------------------------------------------------------------------ retention

  /**
   * Evidence: older than the age bound, then oldest first while over the byte
   * bound. Pruning unreviewed cards records a not-judged gap with its sequence
   * range; the frontier then starts after them. Findings keep their own
   * retained excerpts. Ledger and settings log are never pruned.
   */
  prune(now: number, r: { evidenceDays: number; evidenceBytes: number; findingsDays: number; findingsMax: number }): { cards: number; occurrences: number } {
    return this.tx(() => {
      const lost: Array<{ watch_id: string; seq: number; reviewed: number; judge: number; id: string }> = [];
      const old = this.db
        .prepare("SELECT watch_id, id, seq, reviewed, judge FROM cards WHERE created_at < ? ORDER BY created_at, seq, ord")
        .all(now - r.evidenceDays * 86_400_000) as any[];
      lost.push(...old);
      const sizeRow = this.db.prepare("SELECT COALESCE(SUM(LENGTH(CAST(text AS BLOB)) + LENGTH(CAST(meta AS BLOB))), 0) AS n FROM cards").get() as { n: number };
      let size = sizeRow.n - old.reduce((n: number, c: any) => n + this.cardBytes(c.watch_id, c.id), 0);
      if (size > r.evidenceBytes) {
        const oldIds = new Set(old.map((c: any) => `${c.watch_id}\0${c.id}`));
        for (const c of this.db.prepare("SELECT watch_id, id, seq, reviewed, judge FROM cards ORDER BY created_at, seq, ord").iterate() as Iterable<any>) {
          if (size <= r.evidenceBytes) break;
          if (oldIds.has(`${c.watch_id}\0${c.id}`)) continue;
          size -= this.cardBytes(c.watch_id, c.id);
          lost.push(c);
        }
      }
      const del = this.db.prepare("DELETE FROM cards WHERE watch_id = ? AND id = ?");
      const unreviewed = new Map<string, number[]>();
      for (const c of lost) {
        if (c.judge && !c.reviewed) unreviewed.set(c.watch_id, [...(unreviewed.get(c.watch_id) ?? []), c.seq]);
        del.run(c.watch_id, c.id);
      }
      for (const [w, seqs] of unreviewed) {
        this.addGap(w, "judgment", "pruned-before-review", Math.min(...seqs), Math.max(...seqs), `${seqs.length} cards`, now);
      }
      const occ = this.db.prepare("DELETE FROM occurrences WHERE created_at < ?").run(now - r.findingsDays * 86_400_000).changes;
      const over = this.db.prepare("SELECT COUNT(*) AS n FROM occurrences").get() as { n: number };
      let extra = 0;
      if (over.n > r.findingsMax) {
        extra = this.db
          .prepare("DELETE FROM occurrences WHERE id IN (SELECT id FROM occurrences ORDER BY created_at LIMIT ?)")
          .run(over.n - r.findingsMax).changes;
      }
      this.db.prepare("DELETE FROM notifications WHERE occurrence_id NOT IN (SELECT id FROM occurrences)").run();
      // A held review waits for revalidation or its own expiry; it is never pruned while held.
      this.db.prepare("DELETE FROM reviews WHERE state != 'held' AND finished_at IS NOT NULL AND finished_at < ?").run(now - r.findingsDays * 86_400_000);
      this.db.prepare("DELETE FROM gaps WHERE id IN (SELECT id FROM gaps g WHERE (SELECT COUNT(*) FROM gaps h WHERE h.watch_id = g.watch_id AND h.id > g.id) >= 2000)").run();
      return { cards: lost.length, occurrences: occ + extra };
    });
  }

  private cardBytes(watchId: string, id: string): number {
    const r = this.db
      .prepare("SELECT LENGTH(CAST(text AS BLOB)) + LENGTH(CAST(meta AS BLOB)) AS n FROM cards WHERE watch_id = ? AND id = ?")
      .get(watchId, id) as { n: number } | undefined;
    return r?.n ?? 0;
  }

  evidenceBytes(): number {
    return (this.db.prepare("SELECT COALESCE(SUM(LENGTH(CAST(text AS BLOB)) + LENGTH(CAST(meta AS BLOB))), 0) AS n FROM cards").get() as { n: number }).n;
  }
}
