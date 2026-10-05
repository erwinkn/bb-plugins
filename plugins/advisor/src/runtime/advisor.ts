// The Advisor runtime: watches, observation passes, review scheduling,
// cancellation and retention. One instance per plugin load.

import { ROUTES } from "../config/routes.js";
import { RETENTION_KEYS, REVIEW_KEYS, SECRET_KEYS, resolveConfig, type ResolvedConfig } from "../config/settings.js";
import { eligible } from "../rules/cards.js";
import type { EventQuery, EventRow } from "../rules/events.js";
import { inclusionOrder } from "../rules/requests.js";
import { briefsOf } from "../rules/snapshot.js";
import { bucketHold, freshBucket, take } from "../rules/scheduler.js";
import { hashKey, type Store, type WatchRow } from "../store/store.js";
import type { TransportDeps } from "../transport/transports.js";
import { runCheckpoint } from "./checkpoints.js";
import { dispatchGate, readContext, type WatchContext } from "./context.js";
import { drainPass } from "./drain.js";
import type { AdvisorHost } from "./host.js";
import { READ_DEADLINE_MS, readSignal } from "./host.js";
import type { InitiativeSource } from "./initiatives.js";
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
    if (existing) {
      if (!existing.enabled) this.setEnabled(existing.id, true, via);
      return this.d.store.getWatch(existing.id)!;
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

  unwatch(watchId: string, via: string): void {
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
    const startSeq = turn[0]?.seq ?? tip + 1;
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
    if (ctx.thread) {
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
    if (justSeeded) cur.state.bucket = w.state.bucket;
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
