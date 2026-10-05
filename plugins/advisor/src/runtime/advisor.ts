// The Advisor runtime: watches, observation passes, review scheduling,
// cancellation and retention. One instance per plugin load.

import { ROUTES } from "../config/routes.js";
import { RETENTION_KEYS, REVIEW_KEYS, SECRET_KEYS, resolveConfig, type ResolvedConfig } from "../config/settings.js";
import { eligible } from "../rules/cards.js";
import type { EventQuery, EventRow } from "../rules/events.js";
import { inclusionOrder } from "../rules/requests.js";
import { briefsOf } from "../rules/snapshot.js";
import { bucketHold, freshBucket, take } from "../rules/scheduler.js";
import { hashKey, type InitiativeWatchRow, type Store, type WatchRow } from "../store/store.js";
import type { TransportDeps } from "../transport/transports.js";
import { runCheckpoint } from "./checkpoints.js";
import { dispatchGate, isNotFound, readContext, type WatchContext } from "./context.js";
import { drainPass } from "./drain.js";
import type { AdvisorHost } from "./host.js";
import { READ_DEADLINE_MS, readSignal } from "./host.js";
import type { InitiativeMembers, InitiativeSource, InitiativeSummary } from "./initiatives.js";
import { budgetSince, carryFor, dayKey, type BudgetCarry } from "./ledger.js";
import { deriveFromRows, hasTrigger, insertCards, pauseOf, storePause } from "./observer.js";
import { normPath } from "../rules/diff.js";
import { validTimeZone } from "../config/settings.js";
import { completeReview, runReview, severityAtLeast, type ReviewEnd } from "./reviewer.js";

export interface AdvisorDeps {
  host: AdvisorHost;
  store: Store;
  initiatives: InitiativeSource;
  transportDeps: TransportDeps;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  log: { info(m: string): void; warn(m: string): void };
  publish: (channel: string, payload: unknown) => void;
  /** Per-read deadline for native and Projects reads (test seam; production 10 s). */
  readDeadlineMs?: number;
}

export type RawSettings = Record<string, unknown>;

interface Inflight {
  controller: AbortController;
  promise: Promise<ReviewEnd>;
  reviewId: string | null;
}

const PRUNE_EVERY_MS = 10 * 60_000;
/** At most one member listing per watched Initiative this often, unless a thread was just created. */
const INITIATIVE_SYNC_MS = 10_000;
/** Member pages (up to 200 threads each) read per Initiative per pass; a longer walk goes on next pass. */
const INITIATIVE_PAGES_PER_PASS = 5;
/** Native thread reads per Initiative per pass to learn whether a member is archived or deleted. */
const ARCHIVE_READS_PER_PASS = 20;
/** An archived member is read again this often, in case it was unarchived without an event reaching us. */
const ARCHIVE_RECHECK_MS = 5 * 60_000;
const MIN_TICK_GAP_MS = 2000;
/** Pause reasons an observation pass sets and clears from what it read; all others belong to reviews and panel actions. */
const OBSERVED_REASONS = ["interrupted", "user-stopped"] as const;

export class Advisor {
  resolved: ResolvedConfig;
  private raw: RawSettings = {};
  private inflight = new Map<string, Inflight>();
  private lastPrune = 0;
  private wakeResolve: (() => void) | null = null;
  private disposed = false;
  /** The last project-scope listing failure, shown as an observation error until a listing succeeds. */
  scopeError: string | null = null;
  /** Last member listing attempt per Initiative watch (memory only: a reload lists at once). */
  private initiativeSyncAt = new Map<string, number>();
  private initiativeSyncDue = false;
  /** Member walks in progress: the next page cursor and every thread listed so far (memory only). */
  private walks = new Map<string, { after: string | null; seen: Set<string> }>();
  /** When a member's thread was last seen archived or deleted (memory only: a reload reads them again). */
  private goneSeenAt = new Map<string, number>();

  constructor(private d: AdvisorDeps) {
    this.resolved = resolveConfig({});
  }

  // ------------------------------------------------------------------ lifecycle

  /** On load: rows left reserved or sending are charged in full; interrupted reviews are recorded. */
  recover(): { ledger: number; reviews: number } {
    const now = this.d.now();
    return { ledger: this.d.store.ledgerOnLoad(now), reviews: this.d.store.recoverInterrupted(now) };
  }

  get settingsRev(): number {
    return Number(this.d.store.getMeta("settingsRev") ?? "0");
  }

  /**
   * Apply effective settings. A change to anything a review depends on bumps
   * the settings revision, cancels in-flight reviews (their result would be
   * stale anyway) and is logged; secrets are logged by key only.
   */
  applySettings(raw: RawSettings): { changed: string[]; rev: number } {
    const prev = this.raw;
    this.raw = { ...raw };
    this.resolved = resolveConfig(raw);
    this.trackBudgetZone();
    const keys = [...new Set([...Object.keys(prev), ...Object.keys(raw)])].filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(raw[k]));
    const stored = this.d.store.getMeta("settingsHash");
    const hash = hashKey(Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, (SECRET_KEYS as readonly string[]).includes(k) ? (v ? "set" : "unset") : v])));
    if (stored === hash) return { changed: [], rev: this.settingsRev };
    const reviewChanged = stored === null || keys.some((k) => REVIEW_KEYS.has(k));
    let rev = this.settingsRev;
    if (reviewChanged) {
      rev += 1;
      this.d.store.setMeta("settingsRev", String(rev));
      for (const [, f] of this.inflight) f.controller.abort("settings-changed");
    }
    this.d.store.setMeta("settingsHash", hash);
    const summary = keys
      .sort()
      .map((k) => ((SECRET_KEYS as readonly string[]).includes(k) ? `${k}: ${raw[k] ? "set" : "unset"}` : `${k}: ${JSON.stringify(raw[k] ?? null)}`))
      .join("; ");
    this.d.store.logSettings(rev, keys.length > 0 ? keys : ["(initial)"], summary.slice(0, 4000) || "initial settings", this.d.now());
    this.wake();
    this.changed();
    return { changed: keys, rev };
  }

  wake(): void {
    this.wakeResolve?.();
  }

  private get deadline(): number {
    return this.d.readDeadlineMs ?? READ_DEADLINE_MS;
  }

  /**
   * A budget time-zone change (live or while unloaded) never opens a fresh
   * day: the old zone's charges keep counting until the new zone's next day
   * (A230 #4). The carry and the last zone are durable, so reloads keep them.
   */
  private trackBudgetZone(): void {
    const tz = this.resolved.config.budgets.timeZone;
    if (!validTimeZone(tz)) return;
    const last = this.d.store.getMeta("budgetTz");
    if (last === tz) return;
    if (last !== null && validTimeZone(last)) {
      const now = this.d.now();
      const carry = carryFor(now, last, tz, this.budgetCarry());
      this.d.store.setMeta("budgetCarry", JSON.stringify(carry));
      this.d.store.logSettings(this.settingsRev, ["budgetTimeZone"], this.carryNote(carry) ?? "budget time zone changed", now);
    }
    this.d.store.setMeta("budgetTz", tz);
  }

  budgetCarry(): BudgetCarry | null {
    const v = this.d.store.getMeta("budgetCarry");
    return v ? (JSON.parse(v) as BudgetCarry) : null;
  }

  /** The start of the current budget period. */
  budgetSince(now: number): number {
    return budgetSince(now, this.resolved.config.budgets.timeZone, this.budgetCarry());
  }

  /** What an active carry means, in words; null when none is active. */
  carryNote(carry = this.budgetCarry(), now = this.d.now()): string | null {
    if (!carry || now >= carry.until) return null;
    return `Budget time zone changed ${carry.from} → ${carry.to}: charges since ${new Date(carry.start).toISOString()} keep counting until ${new Date(carry.until).toISOString()}, when ${carry.to}'s next day begins.`;
  }

  /** The background service loop: one tick, then wait for the poll interval or a wake. */
  async run(signal: AbortSignal): Promise<void> {
    this.recover();
    while (!signal.aborted) {
      const tickStart = this.d.now();
      try {
        await this.tick(signal);
      } catch (err) {
        this.d.log.warn(`advisor tick failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.resolved.config.pollSeconds * 1000);
        this.wakeResolve = () => {
          clearTimeout(t);
          resolve();
        };
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        }, { once: true });
      });
      this.wakeResolve = null;
      // Wakes come at most once a second per busy thread; keep ticks at least 2 s apart.
      const since = this.d.now() - tickStart;
      if (since < MIN_TICK_GAP_MS && !signal.aborted) await this.d.sleep(MIN_TICK_GAP_MS - since, signal);
    }
    await this.dispose();
  }

  /** Abort everything, wait at most 2 s, then drop. Late responses are ignored. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const [, f] of this.inflight) f.controller.abort("plugin-unloading");
    await Promise.race([Promise.allSettled([...this.inflight.values()].map((f) => f.promise)), new Promise((r) => setTimeout(r, 2000))]);
  }

  private changed(): void {
    this.d.publish("advisor.changed", { at: this.d.now() });
  }

  // ------------------------------------------------------------------ watches

  async watch(threadId: string, via: string): Promise<WatchRow> {
    const existing = this.d.store.getWatchByThread(threadId);
    const now = this.d.now();
    // Watching a thread again is the way back in after an exclusion from an Initiative watch.
    this.d.store.setExcluded(threadId, false);
    if (existing) {
      if (!existing.enabled) this.setEnabled(existing.id, true, via);
      // An explicit watch of a thread an Initiative watch started becomes yours: no Initiative
      // retirement, off or removal touches it afterwards.
      const w = this.d.store.getWatch(existing.id)!;
      if (w.origin === "initiative") {
        w.origin = "selected";
        this.d.store.saveWatch(w, now);
        this.d.store.logAction(w.id, "watch", `${threadId} (now selected explicitly)`, via, now);
        this.changed();
      }
      return w;
    }
    const thread = await this.d.host.getThread(threadId);
    const [ok, why] = eligible({ archivedAt: thread.archivedAt });
    if (!ok) throw new Error(`thread ${threadId} cannot be watched: ${why}`);
    const w = this.d.store.createWatch(threadId, "selected", now);
    w.title = thread.title ?? null;
    this.d.store.saveWatch(w, now);
    this.d.store.logAction(w.id, "watch", threadId, via, now);
    this.wake();
    this.changed();
    return w;
  }

  /** Disable or enable. Disable aborts the watch's review; enable starts a new epoch and a fresh seed. */
  setEnabled(watchId: string, enabled: boolean, via: string): void {
    const w = this.d.store.getWatch(watchId);
    if (!w || w.enabled === enabled) return;
    const now = this.d.now();
    const p = pauseOf(w);
    if (enabled) {
      p.enable();
      w.epoch = p.epoch;
      w.enabled = true;
      w.state.initiativeEnded = null;
      w.seeded = false; // re-seed: the interval while disabled is shown as not observed
      if (w.cursor !== null) this.d.store.addGap(w.id, "observation", "disabled-interval", w.cursor + 1, null, "not observed while disabled", now);
    } else {
      p.disable();
      w.enabled = false;
      this.inflight.get(w.id)?.controller.abort("watch-disabled");
    }
    storePause(w, p);
    this.d.store.saveWatch(w, now);
    this.d.store.logAction(w.id, enabled ? "enable" : "disable", null, via, now);
    this.wake();
    this.changed();
  }

  /**
   * Stop watching a thread and delete its evidence. A thread an Initiative
   * watch has seen is excluded from it, so the next listing does not add it
   * back; watching the thread again includes it. Returns those Initiatives' names.
   */
  unwatch(watchId: string, via: string): { excludedFrom: string[] } {
    const w = this.d.store.getWatch(watchId);
    const ids = w ? this.d.store.setExcluded(w.threadId, true) : [];
    this.drop(watchId, via);
    return { excludedFrom: ids.map((id) => this.d.store.getInitiativeWatch(id)?.name ?? id) };
  }

  private drop(watchId: string, via: string): void {
    this.inflight.get(watchId)?.controller.abort("watch-removed");
    this.d.store.logAction(watchId, "unwatch", null, via, this.d.now());
    this.d.store.deleteWatch(watchId);
    this.changed();
  }

  pause(watchId: string, via: string): void {
    const w = this.d.store.getWatch(watchId);
    if (!w) return;
    const p = pauseOf(w);
    p.pause(via);
    storePause(w, p);
    w.state.pauseLog = [...w.state.pauseLog.slice(-19), { action: "pause", via, caller: "unverified", at: this.d.now() }];
    this.d.store.saveWatch(w, this.d.now());
    this.d.store.logAction(w.id, "pause", null, via, this.d.now());
    this.inflight.get(w.id)?.controller.abort("paused");
    this.changed();
  }

  /** Resume clears manual, failure and interrupted only; the caller is unverified (U7). */
  resume(watchId: string, via: string): void {
    const w = this.d.store.getWatch(watchId);
    if (!w) return;
    const p = pauseOf(w);
    p.resume(via);
    storePause(w, p);
    w.state.pauseLog = [...w.state.pauseLog.slice(-19), { action: "resume", via, caller: "unverified", at: this.d.now() }];
    this.d.store.saveWatch(w, this.d.now());
    this.d.store.logAction(w.id, "resume", null, via, this.d.now());
    this.wake();
    this.changed();
  }

  skipToTip(watchId: string, via: string): number {
    const n = this.d.store.skipToTip(watchId, this.d.now(), via);
    this.d.store.logAction(watchId, "skip-to-tip", `${n} cards`, via, this.d.now());
    this.changed();
    return n;
  }

  // ------------------------------------------------------------------ one service pass

  async tick(signal: AbortSignal): Promise<void> {
    const cfg = this.resolved.config;
    if (cfg.observationEnabled && this.resolved.observationErrors.length === 0) {
      await this.syncProjectScope(signal);
      await this.syncInitiatives(signal);
      for (const w of this.d.store.listWatches()) {
        if (signal.aborted) return;
        if (!w.enabled) continue;
        try {
          await this.observe(w, signal);
        } catch (err) {
          const fresh = this.d.store.getWatch(w.id);
          if (fresh) {
            fresh.lastError = `observation failed: ${err instanceof Error ? err.message : String(err)}`;
            this.d.store.saveWatch(fresh, this.d.now());
          }
        }
      }
    }
    await this.revalidateHeld(signal);
    this.dispatchDue(signal);
    // Pruning deletes: while a retention value is invalid it waits rather than run on a default.
    const retentionValid = !RETENTION_KEYS.some((k) => this.resolved.invalidKeys.includes(k));
    if (retentionValid && this.d.now() - this.lastPrune > PRUNE_EVERY_MS) {
      this.lastPrune = this.d.now();
      this.d.store.prune(this.d.now(), cfg.retention);
    }
  }

  private async syncProjectScope(signal: AbortSignal): Promise<void> {
    const cfg = this.resolved.config;
    if (cfg.watchScope !== "selected-and-project" || !cfg.watchProject) return;
    let threads;
    try {
      threads = await this.d.host.listProjectThreads(cfg.watchProject, readSignal(signal, this.deadline));
      this.scopeError = null;
    } catch (err) {
      this.scopeError = `project scope: listing ${cfg.watchProject} failed (${err instanceof Error ? err.message : String(err)}); new project threads are not watched until it succeeds`.slice(0, 500);
      this.d.log.warn(this.scopeError);
      return;
    }
    const now = this.d.now();
    for (const t of threads) {
      if (this.d.store.getWatchByThread(t.id) || t.archivedAt !== null) continue;
      const w = this.d.store.createWatch(t.id, "project", now);
      w.title = t.title ?? null;
      this.d.store.saveWatch(w, now);
      this.d.store.logAction(w.id, "watch", `${t.id} (project scope)`, "settings", now);
    }
  }

  // ------------------------------------------------------------------ Initiative watches

  /** A thread was created somewhere: a watched Initiative may have a new member, so list at the next pass. */
  noteThreadCreated(): void {
    if (!this.d.store.listInitiativeWatches().some((i) => i.enabled)) return;
    this.initiativeSyncDue = true;
    this.wake();
  }

  /** A thread was unarchived: an archived member of a watched Initiative is read again at the next pass. */
  noteThreadUnarchived(threadId: string): void {
    if (!this.goneSeenAt.delete(threadId) || !this.d.store.listInitiativeWatches().some((i) => i.enabled)) return;
    this.initiativeSyncDue = true;
    this.wake();
  }

  /** A stored Initiative watch by exact id, or by name ignoring case. */
  findInitiativeWatch(ref: string): InitiativeWatchRow | null {
    const all = this.d.store.listInitiativeWatches();
    return all.find((i) => i.id === ref) ?? all.find((i) => i.name.toLowerCase() === ref.trim().toLowerCase()) ?? null;
  }

  /**
   * Turn on a watch of a whole Initiative: its coordinator and every current
   * member, and members that join later. An unknown Initiative is resolved
   * through the Projects context routes; when they cannot be read nothing is
   * watched and the error says why.
   */
  async watchInitiative(ref: string, via: string, signal: AbortSignal = new AbortController().signal): Promise<InitiativeWatchRow> {
    const known = this.findInitiativeWatch(ref);
    let target: { id: string; name: string };
    if (known) target = known;
    else {
      const list = await this.d.initiatives.initiatives(readSignal(signal, this.deadline));
      if (list.status !== "ok") {
        throw new Error(`cannot watch Initiative ${ref}: the Projects context routes are ${list.status === "unavailable" ? "unavailable" : "unreadable"} (${list.error}); nothing is watched`);
      }
      target = pickInitiative(list.value, ref);
    }
    const now = this.d.now();
    const on = known?.enabled === true;
    this.d.store.saveInitiativeWatch(
      { id: target.id, name: target.name, enabled: true, since: on ? known.since : now, archived: known?.archived ?? false, syncedAt: known?.syncedAt ?? null, error: known?.error ?? null },
      now,
    );
    if (!on) this.d.store.logAction(null, "watch-initiative", `${target.name} (${target.id})`, via, now);
    await this.syncInitiative(target.id, signal);
    this.changed();
    return this.d.store.getInitiativeWatch(target.id)!;
  }

  /**
   * Turn an Initiative watch off: the member watches it started stop
   * observing and keep their evidence and findings. With `remove`, those
   * watches and their evidence are deleted and the Initiative watch is forgotten.
   * Threads you watch yourself are never touched.
   */
  unwatchInitiative(ref: string, via: string, remove = false): { initiative: InitiativeWatchRow; stopped: number; deleted: number } {
    const iw = this.findInitiativeWatch(ref);
    if (!iw) throw new Error(`no Initiative watch matches ${ref}`);
    const now = this.d.now();
    let stopped = 0;
    let deleted = 0;
    this.d.store.saveInitiativeWatch({ ...iw, enabled: false }, now);
    for (const m of this.d.store.listMembers(iw.id)) {
      const w = this.d.store.getWatchByThread(m.threadId);
      if (!w || w.origin !== "initiative" || this.claimedElsewhere(m.threadId, iw.id)) continue;
      if (remove) {
        this.drop(w.id, via);
        deleted++;
      } else if (w.enabled) {
        this.endMember(w.id, "Initiative watch off");
        stopped++;
      }
    }
    if (remove) this.d.store.deleteInitiativeWatch(iw.id);
    this.d.store.logAction(null, remove ? "remove-initiative" : "unwatch-initiative", `${iw.name} (${iw.id}): ${remove ? `${deleted} member watches deleted` : `${stopped} member watches stopped`}`, via, now);
    this.initiativeSyncAt.delete(iw.id);
    this.walks.delete(iw.id);
    this.changed();
    return { initiative: { ...iw, enabled: false }, stopped, deleted };
  }

  /** Another enabled Initiative watch currently counts this thread as a live member. */
  private claimedElsewhere(threadId: string, initiativeId: string): boolean {
    return this.d.store
      .listInitiativeWatches()
      .some((i) => i.id !== initiativeId && i.enabled && !i.archived && this.d.store.listMembers(i.id).some((m) => m.threadId === threadId && !m.excluded && !memberEnded(m.state)));
  }

  /** Stop a member watch on the Initiative's behalf: history stays, observation stops, and the reason is kept. */
  private endMember(watchId: string, why: string): void {
    this.setEnabled(watchId, false, "initiative");
    const w = this.d.store.getWatch(watchId);
    if (!w) return;
    w.state.initiativeEnded = why;
    this.d.store.saveWatch(w, this.d.now());
  }

  private async syncInitiatives(signal: AbortSignal): Promise<void> {
    const due = this.initiativeSyncDue;
    this.initiativeSyncDue = false;
    const now = this.d.now();
    for (const iw of this.d.store.listInitiativeWatches()) {
      if (signal.aborted) return;
      if (!iw.enabled) continue;
      const last = this.initiativeSyncAt.get(iw.id);
      // An unfinished walk goes on at the next pass.
      if (!due && !this.walks.has(iw.id) && last !== undefined && now - last < INITIATIVE_SYNC_MS) continue;
      await this.syncInitiative(iw.id, signal);
    }
  }

  /**
   * Walk the member listing, at most INITIATIVE_PAGES_PER_PASS pages a pass:
   * new live members get a watch (read from their first event when they joined
   * after the watch was turned on), members that retired, were replaced, whose
   * thread was archived or deleted, or whose Initiative was archived stop being observed, and a member stopped
   * that way starts again if it comes back. Only a walk that reached the last
   * page stops watches of members it no longer lists (moved or removed). A
   * failed or missing page changes nothing more and is shown on the Initiative watch.
   */
  private async syncInitiative(initiativeId: string, signal: AbortSignal): Promise<void> {
    const iw = this.d.store.getInitiativeWatch(initiativeId);
    if (!iw || !iw.enabled) return;
    this.initiativeSyncAt.set(iw.id, this.d.now());
    const walk = this.walks.get(iw.id) ?? { after: null, seen: new Set<string>() };
    this.walks.set(iw.id, walk);
    let moved = false;
    const reads = { left: ARCHIVE_READS_PER_PASS };
    for (let page = 0; page < INITIATIVE_PAGES_PER_PASS; page++) {
      const r = await this.d.initiatives.members(iw.id, walk.after, readSignal(signal, this.deadline));
      const gone = r.status === "ok" ? await this.goneStates(iw.id, r.value, reads, signal) : null;
      const now = this.d.now();
      const fresh = this.d.store.getInitiativeWatch(initiativeId);
      if (!fresh || !fresh.enabled) {
        this.walks.delete(initiativeId); // turned off while listing
        return;
      }
      if (r.status !== "ok") {
        const error = (
          r.status === "unavailable"
            ? `Projects context routes unavailable (${r.error}): new members are not added and retired ones are not stopped until they can be read`
            : `member listing failed (${r.error}); retried next pass`
        ).slice(0, 500);
        if (error !== fresh.error) {
          this.d.log.warn(`Initiative watch ${fresh.name}: ${error}`);
          this.d.store.saveInitiativeWatch({ ...fresh, error }, now);
          moved = true;
        }
        break;
      }
      const v = r.value;
      for (const m of v.members) walk.seen.add(m.threadId);
      if (this.applyMembers(fresh, v, gone!, now)) moved = true;
      if (v.next === null) {
        if (this.reconcileMissing(this.d.store.getInitiativeWatch(initiativeId)!, walk.seen, now)) moved = true;
        this.walks.delete(initiativeId);
        break;
      }
      walk.after = v.next;
    }
    if (moved) {
      this.wake();
      this.changed();
    }
  }

  /**
   * Which live members on a page have a thread that is archived or deleted
   * (BB's 404), read cheaply. A member with an enabled watch needs no read: the
   * watch's own pass reads its thread. Otherwise only a member this Initiative
   * watch would start or restart is read, a gone one again every
   * ARCHIVE_RECHECK_MS (or after an unarchive event), within `reads` thread
   * reads a pass. A member that would start but was not read, or whose read
   * failed any other way, is `deferred` to a later pass.
   */
  private async goneStates(initiativeId: string, v: InitiativeMembers, reads: { left: number }, signal: AbortSignal): Promise<Gone> {
    const gone = new Map<string, GoneState>();
    const deferred = new Set<string>();
    if (v.archived) return { gone, deferred };
    const prev = new Map(this.d.store.listMembers(initiativeId).map((m) => [m.threadId, m]));
    const now = this.d.now();
    const due: Array<{ threadId: string; known: GoneState | null }> = [];
    for (const m of v.members) {
      if (memberEnded(m.state)) continue;
      const before = prev.get(m.threadId);
      const known = before?.state === "archived" || before?.state === "deleted" ? before.state : null;
      const w = this.d.store.getWatchByThread(m.threadId);
      if (w?.enabled) {
        const seen = w.state.threadDeleted !== null ? "deleted" : w.thread?.archivedAt != null ? "archived" : null;
        if (seen) {
          gone.set(m.threadId, seen);
          this.goneSeenAt.set(m.threadId, now);
        }
        continue;
      }
      const starts = !before?.excluded && (!w || (w.origin === "initiative" && w.state.initiativeEnded !== null));
      if (starts && (!known || now - (this.goneSeenAt.get(m.threadId) ?? -Infinity) >= ARCHIVE_RECHECK_MS)) due.push({ threadId: m.threadId, known });
      else if (known) gone.set(m.threadId, known);
    }
    // Unread members first: they are the ones holding back a watch.
    due.sort((a, b) => Number(a.known !== null) - Number(b.known !== null));
    for (const { threadId, known } of due) {
      let read: GoneState | "live" | null = null;
      if (reads.left > 0 && !signal.aborted) {
        reads.left--;
        try {
          read = (await this.d.host.getThread(threadId, readSignal(signal, this.deadline))).archivedAt !== null ? "archived" : "live";
        } catch (err) {
          if (isNotFound(err)) read = "deleted";
        }
      }
      if (read === null) {
        if (known) gone.set(threadId, known);
        else deferred.add(threadId);
      } else if (read === "live") this.goneSeenAt.delete(threadId);
      else {
        gone.set(threadId, read);
        this.goneSeenAt.set(threadId, now);
      }
    }
    return { gone, deferred };
  }

  /** Apply one page of members; true when anything shown moved. */
  private applyMembers(fresh: InitiativeWatchRow, v: InitiativeMembers, gone: Gone, now: number): boolean {
    const prev = new Map(this.d.store.listMembers(fresh.id).map((m) => [m.threadId, m]));
    let moved = fresh.error !== null || fresh.name !== v.name || fresh.archived !== v.archived;
    this.d.store.tx(() => {
      for (const m of v.members) {
        const before = prev.get(m.threadId);
        const state = gone.gone.get(m.threadId) ?? m.state;
        this.d.store.saveMember({ initiativeId: fresh.id, threadId: m.threadId, kind: m.kind, role: m.role, worker: m.worker, generation: m.generation, state }, now);
        if (!before || before.state !== state) moved = true;
        const ended = v.archived
          ? "Initiative archived"
          : state === "retired"
            ? "retired from the Initiative"
            : state === "former"
              ? "former Initiative member (replaced)"
              : state === "archived" || state === "deleted"
                ? `thread ${state}`
                : null;
        const wasEnded = before === undefined || fresh.archived || memberEnded(before.state);
        const w = this.d.store.getWatchByThread(m.threadId);
        if (ended === null) {
          if (before?.excluded || gone.deferred.has(m.threadId)) continue;
          if (!w) {
            const nw = this.d.store.createWatch(m.threadId, "initiative", now);
            nw.state.fromStartIfCreatedAfter = fresh.since;
            this.d.store.saveWatch(nw, now);
            this.d.store.logAction(nw.id, "watch", `${m.threadId} (Initiative ${v.name}, ${memberLabel(m)})`, "initiative", now);
            moved = true;
          } else if (w.origin === "initiative" && !w.enabled && w.state.initiativeEnded !== null) {
            this.setEnabled(w.id, true, "initiative");
            moved = true;
          }
        } else if (!wasEnded && this.endOwned(m.threadId, fresh.id, ended)) moved = true;
      }
      this.d.store.saveInitiativeWatch({ ...fresh, name: v.name, archived: v.archived, syncedAt: now, error: null }, now);
    });
    return moved;
  }

  /** After a complete walk: members still recorded as live that the listing no longer names. */
  private reconcileMissing(iw: InitiativeWatchRow, seen: Set<string>, now: number): boolean {
    let moved = false;
    this.d.store.tx(() => {
      for (const m of this.d.store.listMembers(iw.id)) {
        if (seen.has(m.threadId) || memberEnded(m.state)) continue;
        this.d.store.setMemberState(iw.id, m.threadId, "removed", now);
        this.endOwned(m.threadId, iw.id, "no longer listed in the Initiative");
        moved = true;
      }
    });
    return moved;
  }

  /**
   * Stop (or re-label) a watch this Initiative owns. A watch you selected
   * yourself, or one another watched Initiative still counts as live, is left alone.
   */
  private endOwned(threadId: string, initiativeId: string, why: string): boolean {
    const w = this.d.store.getWatchByThread(threadId);
    if (!w || w.origin !== "initiative" || this.claimedElsewhere(threadId, initiativeId)) return false;
    if (w.enabled) this.endMember(w.id, why);
    else if (w.state.initiativeEnded !== null) {
      w.state.initiativeEnded = why;
      this.d.store.saveWatch(w, this.d.now());
    } else return false;
    return true;
  }

  private source(threadId: string, signal: AbortSignal) {
    return { list: (q: EventQuery) => this.d.host.listEvents(threadId, q, readSignal(signal, this.deadline)) };
  }

  /** Seed on enable: tip, current turn start, request baseline, checkpoint baseline. */
  private async seed(w: WatchRow, ctx: WatchContext, signal: AbortSignal): Promise<void> {
    const now = this.d.now();
    const src = this.source(w.threadId, signal);
    const newest = await src.list({ order: "desc", limit: "1" });
    const tip = newest[0]?.seq ?? 0;
    const turn = await src.list({ order: "desc", limit: "1", beforeSeq: String(tip + 1), types: ["turn/started"] });
    // A member that joined a watched Initiative is read from its first event, not from the current turn.
    const since = w.state.fromStartIfCreatedAfter;
    const created = ctx.thread?.createdAt;
    const fromStart = since !== null && typeof created === "number" && created >= since;
    const startSeq = fromStart ? 1 : (turn[0]?.seq ?? tip + 1);
    const rq = this.d.store.loadRequests(w.id, { parent: ctx.parent, fork: ctx.fork });
    rq.fork = ctx.fork;
    rq.setContext({ parent: ctx.parent, coordinator: ctx.coordinator, member: ctx.member, briefs: briefsOf(ctx.snapshot) }); // trusted again only after a drain reaches the tip
    await rq.seed(src, tip);
    this.d.store.saveRequests(w.id, rq);
    w.startSeq = startSeq;
    w.cursor = startSeq - 1;
    w.tip = tip;
    w.atTip = false;
    w.seeded = true;
    w.state.bucket = freshBucket(this.resolved.config.cadence, now);
    if (startSeq > 1) this.d.store.addGap(w.id, "observation", "before-watch", 1, startSeq - 1, `not judged before #${startSeq} (the current turn's start when the watch began)`, now);
    if (ctx.thread?.environmentId) w.environmentId = ctx.thread.environmentId;
    await this.readRoot(w, signal);
    if (this.resolved.config.checkpointsEnabled) {
      await runCheckpoint(
        { host: this.d.host, store: this.d.store, now: this.d.now, sleep: this.d.sleep },
        w,
        { testGlobs: this.resolved.config.testGlobs, maxPaths: this.resolved.config.checkpointMaxPaths, atSeq: tip, baseline: true },
        signal,
      );
    }
  }

  /**
   * The environment root path, read until one read succeeds (each pass at
   * most once, under the read deadline). Until then edit paths stay absolute
   * and checkpoints name the attribution unknown; a failed read is a gap.
   */
  private async readRoot(w: WatchRow, signal: AbortSignal): Promise<void> {
    if (!w.environmentId || w.state.rootPathRead) return;
    try {
      w.rootPath = await this.d.host.envPath(w.environmentId, readSignal(signal, this.deadline));
      w.state.rootPathRead = true;
      if (w.rootPath) {
        // Edit keys recorded before the root was known were absolute: match them to checkpoint paths now.
        const edits: Record<string, string[]> = {};
        for (const [k, ids] of Object.entries(w.state.editsSinceCheckpoint)) {
          const rel = normPath(k, w.rootPath);
          edits[rel] = [...(edits[rel] ?? []), ...ids];
        }
        w.state.editsSinceCheckpoint = edits;
      }
    } catch (err) {
      // No sequence range: a repeated identical failure stays one gap row.
      this.d.store.addGap(w.id, "evidence", "root-path-unknown", null, null, `environment root path read failed (${err instanceof Error ? err.message : String(err)}); retried next pass`.slice(0, 500), this.d.now());
    }
  }

  /** One observation pass: fresh context, then a bounded drain; the parent anchor is trusted only if it reaches the tip. */
  async observe(w: WatchRow, signal: AbortSignal): Promise<void> {
    const cfg = this.resolved.config;
    const startPause = new Set(w.state.pause);
    const startGate = w.state.dispatchGate;
    const ctx = await readContext(this.d.host, this.d.initiatives, w.threadId, { epoch: w.epoch, settingsRev: this.settingsRev }, [], signal, {
      deadlineMs: this.deadline,
      cachedThread: w.thread,
    });
    w.state.dispatchGate = dispatchGate(ctx);
    if (ctx.deleted) {
      w.state.threadDeleted ??= this.d.now();
      w.lastError = "deleted: not observed";
      this.saveObserved(w, startPause);
      return;
    }
    if (ctx.thread) {
      w.state.threadDeleted = null;
      w.title = ctx.thread.title ?? w.title;
      w.projectId = ctx.thread.projectId ?? null;
      w.originPluginId = ctx.thread.originPluginId ?? null;
      w.thread = {
        parentThreadId: ctx.thread.parentThreadId ?? null,
        archivedAt: ctx.thread.archivedAt ?? null,
        createdAt: ctx.thread.createdAt ?? null,
        sourceThreadId: ctx.thread.sourceThreadId ?? null,
      };
      if (ctx.thread.archivedAt !== null) {
        w.lastError = "archived: not observed";
        this.saveObserved(w, startPause);
        return;
      }
    }
    if (!w.environmentId && ctx.thread?.environmentId) w.environmentId = ctx.thread.environmentId;
    if (!w.seeded) await this.seed(w, ctx, signal);
    else await this.readRoot(w, signal);
    const rq = this.d.store.loadRequests(w.id, { parent: ctx.parent, fork: ctx.fork });
    rq.fork = ctx.fork;
    rq.setContext({ parent: ctx.parent, coordinator: ctx.coordinator, member: ctx.member, briefs: briefsOf(ctx.snapshot) });
    const pause = pauseOf(w);
    // Projects' record of a user Stop: set and cleared only by a successful read (a failed read changes nothing).
    const m = ctx.snapshot.membership;
    if (m.status === "ok") {
      pause.projectsRead(m.value?.userStopped ?? false);
      storePause(w, pause);
    }
    // Labels and filters only: this never adds a watch for the Initiative's other members.
    if (ctx.initiative !== undefined) w.state.initiative = ctx.initiative;
    let interrupted = false;
    let turnEnded = 0;
    const info = await drainPass(this.source(w.threadId, signal), w.cursor ?? 0, (page: EventRow[], next: number) => {
      this.d.store.tx(() => {
        const cards: Parameters<typeof insertCards>[2] = [];
        const res = deriveFromRows(w, page, rq, pause, this.d.now() / 60_000, {
          card: (c) => cards.push(c),
          gap: (layer, reason, seq, detail) => this.d.store.addGap(w.id, layer, reason, seq, seq, detail, this.d.now()),
        });
        insertCards(this.d.store, w.id, cards, this.d.now());
        this.d.store.noteReversals(w.id, w.rootPath, cards.map((c) => ({ id: c.id, kind: c.kind, seq: c.seq, path: c.path, hunks: c.meta.hunks })), this.d.now());
        if (res.interrupted) interrupted = true;
        if (res.turnEnded) turnEnded = Math.max(turnEnded, page[page.length - 1]!.seq);
        this.d.store.saveRequests(w.id, rq);
        w.cursor = next;
        w.tip = Math.max(w.tip ?? 0, next);
        storePause(w, pause);
        this.saveObserved(w, startPause);
      });
    });
    rq.drained(info.atTip);
    this.d.store.saveRequests(w.id, rq);
    w.atTip = info.atTip;
    w.lastDrainAt = this.d.now();
    w.lastError = info.gap ? `drain stopped: ${info.gap}` : null;
    if (info.gap) this.d.store.addGap(w.id, "observation", "drain-gap", w.cursor, null, info.gap, this.d.now());
    if (interrupted) this.inflight.get(w.id)?.controller.abort("watched-thread-interrupted");
    let checkpointCards = 0;
    if (w.state.checkpointDue && cfg.checkpointsEnabled && info.atTip) {
      w.state.checkpointDue = false;
      const cp = await runCheckpoint(
        { host: this.d.host, store: this.d.store, now: this.d.now, sleep: this.d.sleep },
        w,
        { testGlobs: cfg.testGlobs, maxPaths: cfg.checkpointMaxPaths, atSeq: turnEnded || (w.cursor ?? 0), baseline: false },
        signal,
      );
      checkpointCards = cp.cards;
      const added = (cp.added ?? []).map((c) => ({ id: c.id, kind: c.kind, seq: c.seq, path: c.path, hunks: c.meta.hunks, side: c.meta.side }));
      this.d.store.noteReversals(w.id, w.rootPath, added, this.d.now());
    }
    this.saveObserved(w, startPause);
    // Signal the panel only when something it shows moved.
    if (info.pages > 0 || checkpointCards > 0 || info.gap || interrupted || startGate !== w.state.dispatchGate) this.changed();
  }

  /**
   * Write what an observation pass owns onto the current row. A pass holds its
   * copy across awaits, so fields owned by reviews and panel actions (failures,
   * bucket, manual pauses) are never overwritten from it; of the pause set it
   * applies only its own change to "interrupted". A pass whose watch was
   * disabled or re-enabled meanwhile is dropped.
   */
  private saveObserved(w: WatchRow, startPause: Set<string>): boolean {
    const cur = this.d.store.getWatch(w.id);
    if (!cur || cur.epoch !== w.epoch || !cur.enabled) return false;
    const justSeeded = !cur.seeded && w.seeded;
    cur.title = w.title;
    cur.projectId = w.projectId;
    cur.originPluginId = w.originPluginId;
    cur.thread = w.thread;
    cur.startSeq = w.startSeq;
    cur.cursor = w.cursor;
    cur.tip = w.tip;
    cur.atTip = w.atTip;
    cur.seeded = w.seeded;
    cur.environmentId = w.environmentId;
    cur.rootPath = w.rootPath;
    cur.lastDrainAt = w.lastDrainAt;
    cur.lastError = w.lastError;
    cur.state.lastAgentMessage = w.state.lastAgentMessage;
    cur.state.editsSinceCheckpoint = w.state.editsSinceCheckpoint;
    cur.state.checkpointCursor = w.state.checkpointCursor;
    cur.state.checkpointDue = w.state.checkpointDue;
    cur.state.dispatchGate = w.state.dispatchGate;
    cur.state.rootPathRead = w.state.rootPathRead;
    cur.state.threadDeleted = w.state.threadDeleted;
    if (w.state.initiative !== undefined) cur.state.initiative = w.state.initiative;
    if (justSeeded) {
      cur.state.bucket = w.state.bucket;
      cur.state.fromStartIfCreatedAfter = null; // only the first seed may start from the first event
    }
    const p = pauseOf(cur);
    for (const reason of OBSERVED_REASONS) {
      const had = startPause.has(reason);
      const has = w.state.pause.includes(reason);
      if (has && !had) p.reasons.add(reason);
      if (!has && had) p.reasons.delete(reason);
    }
    // Budget holds clear on day rollover or a changed cap.
    if (cur.state.budgetHold) {
      const cfg = this.resolved.config;
      const route = ROUTES[cfg.route];
      const caps =
        route.billing === "usd"
          ? { usd: cfg.budgets.usdPerDay, requests: cfg.budgets.apiRequestsPerDay, tokens: null }
          : { usd: null, requests: cfg.budgets.subscriptionRequestsPerDay, tokens: cfg.budgets.subscriptionTokensPerDay };
      if (cur.state.budgetHold.day !== dayKey(this.d.now(), cfg.budgets.timeZone) || cur.state.budgetHold.capsKey !== JSON.stringify(caps)) {
        p.budget(false);
        cur.state.budgetHold = null;
      }
    }
    storePause(cur, p);
    this.d.store.saveWatch(cur, this.d.now());
    w.state.pause = cur.state.pause;
    w.state.failures = cur.state.failures;
    w.state.budgetHold = cur.state.budgetHold;
    return true;
  }

  // ------------------------------------------------------------------ reviews

  /** Why a watch would not dispatch now, or null when it would. */
  dispatchHold(w: WatchRow, preview = false): string | null {
    const r = this.resolved;
    const cfg = r.config;
    if (!preview) {
      if (!cfg.reviewEnabled) return "reviews are off";
      if (r.reviewErrors.length > 0) return `settings: ${r.reviewErrors[0]}`;
      if (ROUTES[cfg.route].billing !== "none" && !cfg.providerRequestsEnabled) return "model provider requests are off";
      if (w.state.pause.length > 0) return `paused: ${w.state.pause.join(", ")}`;
    }
    if (!w.enabled) return "watch disabled";
    if (!w.seeded) return "not seeded yet";
    if (!w.atTip) return "drain behind the tip";
    if (this.inflight.has(w.id)) return "a review is in flight";
    if (!preview) {
      if (w.state.dispatchGate) return `context: ${w.state.dispatchGate}`;
      const held = this.d.store.heldFor(w.id);
      if (held) {
        const since = held.heldAt === null ? "" : ` since ${new Date(held.heldAt).toISOString()}`;
        return `a held review (${held.id}${since}) is rechecked from its paid result; its cards are not sent again`;
      }
    }
    return null;
  }

  private dispatchDue(signal: AbortSignal): void {
    const cfg = this.resolved.config;
    for (const w of this.d.store.listWatches()) {
      if (this.inflight.size >= cfg.concurrency) return;
      if (this.dispatchHold(w) !== null) continue;
      const now = this.d.now();
      const cards = this.d.store.frontierCards(w.id, 200);
      if (cards.length === 0) continue;
      if (hasTrigger(cards, cfg.triggers, cfg.testGlobs, w.rootPath) === null) continue;
      const bucket = w.state.bucket ?? freshBucket(cfg.cadence, now);
      if (bucketHold(bucket, cfg.cadence, now) !== null) continue;
      this.start(w, false, signal);
    }
  }

  /** Start a review (or a preview) in the background, owned by its own AbortController. */
  start(w: WatchRow, preview: boolean, parent?: AbortSignal): Promise<ReviewEnd> {
    const controller = new AbortController();
    if (parent) parent.addEventListener("abort", () => controller.abort("plugin-unloading"), { once: true });
    const promise = (async (): Promise<ReviewEnd> => {
      const cfg = this.resolved.config;
      const now = this.d.now();
      const ctx = await readContext(this.d.host, this.d.initiatives, w.threadId, { epoch: w.epoch, settingsRev: this.settingsRev }, [], controller.signal, {
        deadlineMs: this.deadline,
        cachedThread: w.thread,
      });
      if (controller.signal.aborted) return { state: "cancelled", reviewId: null, why: String(controller.signal.reason ?? "canceled") };
      if (!preview) {
        // Any failed or incomplete snapshot read, or a former member, sends nothing: the result could never be current.
        const gate = dispatchGate(ctx);
        if (gate) {
          const fresh = this.d.store.getWatch(w.id);
          if (fresh) {
            fresh.state.dispatchGate = gate;
            this.d.store.saveWatch(fresh, now);
          }
          return { state: "nothing", reviewId: null, why: gate };
        }
      }
      const rq = this.d.store.loadRequests(w.id, { parent: ctx.parent, fork: ctx.fork });
      rq.fork = ctx.fork;
      rq.setContext({ parent: ctx.parent, coordinator: ctx.coordinator, member: ctx.member, briefs: briefsOf(ctx.snapshot) });
      // Proof needs a fresh context followed by a drain that reaches the tip.
      const info = await drainPass(this.source(w.threadId, controller.signal), w.cursor ?? 0, () => {}, { pages: 1, bytes: 1 << 20, rows: 25 });
      if (controller.signal.aborted) return { state: "cancelled", reviewId: null, why: String(controller.signal.reason ?? "canceled") };
      rq.drained(info.atTip && info.pages === 0);
      const nowMin = now / 60_000;
      if (!preview && rq.pending(nowMin, cfg.pendingHorizonMinutes).length > 0) return { state: "nothing", reviewId: null, why: "an authoritative instruction is pending" };
      if (!preview && info.pages > 0) return { state: "nothing", reviewId: null, why: "new events since the last pass" };
      if (!preview) {
        const fresh = this.d.store.getWatch(w.id)!;
        fresh.state.bucket = take(fresh.state.bucket ?? freshBucket(cfg.cadence, now), cfg.cadence, now);
        this.d.store.saveWatch(fresh, now);
      }
      const reqCov = rq.coverage(nowMin, cfg.pendingHorizonMinutes) === "partial" || ctx.gaps.length > 0 ? "partial" : "complete";
      const current = this.d.store.getWatch(w.id);
      if (!current) return { state: "cancelled", reviewId: null, why: "watch removed" };
      return runReview(this.reviewDeps(), current, {
        config: this.resolved,
        settingsRev: this.settingsRev,
        preview,
        context: ctx,
        requirementsCoverage: reqCov,
        requirements: inclusionOrder([], rq.requirements()),
        signal: controller.signal,
      });
    })()
      .catch((err): ReviewEnd => {
        this.d.log.warn(`review failed: ${err instanceof Error ? err.message : String(err)}`);
        return { state: "failed", reviewId: null, why: err instanceof Error ? err.message : String(err) };
      })
      .finally(() => {
        if (this.inflight.get(w.id)?.controller === controller) this.inflight.delete(w.id);
        this.changed();
      });
    this.inflight.set(w.id, { controller, promise, reviewId: null });
    return promise;
  }

  private reviewDeps() {
    return {
      host: this.d.host,
      store: this.d.store,
      initiatives: this.d.initiatives,
      transportDeps: this.d.transportDeps,
      now: this.d.now,
      changed: () => this.changed(),
      limits: () => ({
        completionReadPages: this.resolved.config.completionReadPages,
        // A held result was paid for: it never expires on a default that replaced an invalid value.
        heldExpiryMs: this.resolved.invalidKeys.includes("heldExpiryMinutes") ? null : this.resolved.config.held.expiryMinutes * 60_000,
        deadlineMs: this.deadline,
      }),
      budgetSince: (now: number) => this.budgetSince(now),
      notify: (n: { occurrenceId: string; watchId: string; severity: string; reason: string; summary: string }) => {
        const policy = this.resolved.config.notificationPolicy;
        const toast =
          (policy === "toast-critical" && severityAtLeast(n.severity, "critical")) ||
          (policy === "toast-concern" && severityAtLeast(n.severity, "concern") && severityAtLeast(n.severity, this.resolved.config.severityThreshold));
        this.d.publish("advisor.notify", { ...n, toast });
      },
    };
  }

  /**
   * Recheck held reviews from their stored results: at most the configured
   * number per pass, least recently checked first, every read under its
   * deadline. A failure is recorded on the review, never swallowed.
   */
  private async revalidateHeld(signal: AbortSignal): Promise<void> {
    for (const r of this.d.store.heldReviews(this.resolved.config.held.rechecksPerPass)) {
      if (signal.aborted) return;
      if (this.inflight.has(r.watchId)) continue;
      try {
        await completeReview(this.reviewDeps(), r.id, signal);
      } catch (err) {
        const why = `recheck failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500);
        this.d.log.warn(`held review ${r.id}: ${why}`);
        this.d.store.recheckHeld(r.id, why, undefined, this.d.now());
      }
    }
  }

  /** Resolves when every in-flight review has ended. */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight.values()].map((f) => f.promise));
  }

  /** In-flight review ids by watch, for status. */
  inflightWatches(): string[] {
    return [...this.inflight.keys()];
  }
}

/** States in which a member is no longer observed: retired, replaced, its thread archived or deleted, or no longer listed. */
const memberEnded = (state: string) => state === "retired" || state === "former" || state === "archived" || state === "deleted" || state === "removed";

/** A member thread the Advisor found archived, or deleted (BB answered 404). */
type GoneState = "archived" | "deleted";
interface Gone {
  gone: Map<string, GoneState>;
  /** Would start, but the thread was not read yet (read budget spent, or a failure other than 404). */
  deferred: Set<string>;
}

/** "W12 work", "coordinator", "user thread". */
export function memberLabel(m: { kind: string; role: string; worker: string | null }): string {
  if (m.kind === "coordinator") return "coordinator";
  if (m.kind === "adhoc") return "user thread";
  return [m.worker, m.role].filter(Boolean).join(" ");
}

/** An Initiative by exact id, exact name (any case), or a unique partial name. */
export function pickInitiative(list: InitiativeSummary[], ref: string): InitiativeSummary {
  const q = ref.trim().toLowerCase();
  const exact = list.find((i) => i.id === ref) ?? list.find((i) => i.name.toLowerCase() === q);
  if (exact) return exact;
  const partial = list.filter((i) => i.name.toLowerCase().includes(q) || i.id.toLowerCase().startsWith(q));
  if (partial.length === 1) return partial[0]!;
  if (partial.length === 0) throw new Error(`no open Initiative matches ${ref}${list.length ? ` (open: ${list.map((i) => `${i.name} ${i.id}`).join(", ")})` : ""}`);
  throw new Error(`${ref} matches ${partial.length} Initiatives: ${partial.map((i) => `${i.name} ${i.id}`).join(", ")}; use the id`);
}
