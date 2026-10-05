// One review (S2/S3): packet, admission, exactly one request, completion
// freshness, validated findings. The frontier moves only after a validated
// current-as-of-tip result, or past a held result that expired (a named gap);
// failure, stale, cancel and budget refusal leave it. A held result is
// revalidated from what was already paid for and never sent again.

import { randomUUID } from "node:crypto";
import { ROUTES, type RouteSpec } from "../config/routes.js";
import type { ResolvedConfig } from "../config/settings.js";
import { deriveSubject } from "../rules/scope.js";
import { normPath, type Hunk } from "../rules/diff.js";
import { REQUEST_TYPES, readPages, type EventRow } from "../rules/events.js";
import { JEV_MODEL, MAX_BODY_BYTES, planJevReview, type JevCard, type JevPlan } from "../rules/jev.js";
import { ConfigError, IngestError, buildBody, render, type PacketCard, type PacketMeta } from "../rules/packet.js";
import { inclusionOrder, type Requirement } from "../rules/requests.js";
import { retain } from "../rules/retain.js";
import { citedChange, reverses } from "../rules/reversal.js";
import { classifyCompletion, type Completion, type Snapshot } from "../rules/snapshot.js";
import type { CardRow, Store, WatchRow } from "../store/store.js";
import { parseOutput, type ModelFinding } from "../transport/output.js";
import { createJevTransport, createTransport, type TransportDeps } from "../transport/transports.js";
import { fakeTransport } from "../transport/fake.js";
import type { ReviewTransport, SendResult } from "../transport/types.js";
import { acceptFindings, type PacketContext } from "../review/accept.js";
import { CHARTER } from "../review/charter.js";
import { readContext, type WatchContext } from "./context.js";
import type { AdvisorHost } from "./host.js";
import { readSignal } from "./host.js";
import type { InitiativeSource } from "./initiatives.js";
import { dayKey, reservationFor, settle } from "./ledger.js";
import { pauseOf, storePause } from "./observer.js";

export interface ReviewDeps {
  host: AdvisorHost;
  store: Store;
  initiatives: InitiativeSource;
  transportDeps: TransportDeps;
  now: () => number;
  notify: (n: { occurrenceId: string; watchId: string; severity: string; reason: string; summary: string }) => void;
  changed: () => void;
  /** Current bounds from Settings (read at use, so hot updates apply). */
  limits: () => { completionReadPages: number; heldExpiryMs: number | null; deadlineMs: number };
  /** The start of the current budget period (the day, extended by a time-zone carry). */
  budgetSince: (now: number) => number;
}

/** The rows completion freshness reads: requests, receipts, ownership changes, stops and turn ends. */
export const COMPLETION_TYPES = [...REQUEST_TYPES, "system/operation", "system/thread/interrupted", "turn/completed"] as const;

export interface ReviewOptions {
  config: ResolvedConfig;
  settingsRev: number;
  /** Preview: the selected route's packet sent to the fake reviewer. No spend, no frontier move. */
  preview: boolean;
  /** Context read just before this dispatch, after a drain that reached the tip. */
  context: WatchContext;
  requirementsCoverage: "partial" | "complete";
  requirements: Requirement[];
  signal: AbortSignal;
}

export type ReviewEnd =
  | { state: "current"; reviewId: string; accepted: number; dropped: number }
  | { state: "stale" | "held" | "expired" | "failed" | "cancelled" | "refused" | "no-call" | "nothing" | "config-error"; reviewId: string | null; why: string };

const SEVERITY_RANK: Record<string, number> = { note: 0, unrated: 1, concern: 1, critical: 2 };

function packetCard(c: CardRow, root: string | null): PacketCard & { hunks?: Hunk[]; kind: string } {
  return { id: c.id, text: c.text, encBytes: c.encBytes, seq: c.seq, path: c.path ? normPath(c.path, root) : null, hunks: c.meta.hunks as Hunk[] | undefined, kind: c.kind };
}

function issuesLines(store: Store, watchId: string): string[] {
  return store
    .listIssues(watchId)
    .filter((i) => i.state === "open")
    .slice(0, 40)
    .map((i) => `open: ${i.category} ${i.locator}`);
}

export async function runReview(d: ReviewDeps, w: WatchRow, o: ReviewOptions): Promise<ReviewEnd> {
  const route: RouteSpec = o.preview ? ROUTES.fake : ROUTES[o.config.config.route];
  const selected = ROUTES[o.config.config.route];
  const cfg = o.config.config;
  const fifo = d.store.frontierCards(w.id);
  if (fifo.length === 0) return { state: "nothing", reviewId: null, why: "no unreviewed evidence" };
  const reviewId = `rv_${randomUUID().slice(0, 10)}`;
  const now = d.now();
  const routeCats = route.id === "fake" ? selected.categories : route.categories;
  if (selected.id === "jev:typesafe" && !o.preview) return runJev(d, w, o, fifo, reviewId);

  // ---- packet: measured on the exact body the selected route would send
  // A preview sends the selected route's packet to the fake reviewer; Jev has no packet body, so its preview uses the fake's.
  const transport: ReviewTransport =
    o.preview || selected.id === "fake" ? fakeTransport(d.transportDeps.fakeFindings) : createTransport(cfg, d.transportDeps);
  const serializer = selected.id === "fake" || selected.id === "jev:typesafe" ? transport.serialize : createTransport(cfg, d.transportDeps).serialize;
  const cards = fifo.map((c) => packetCard(c, w.rootPath));
  let built: { body: string; meta: PacketMeta };
  try {
    built = buildBody(serializer, CHARTER, cfg.customInstructions, inclusionOrder([], o.requirements), issuesLines(d.store, w.id), cards, cfg.bodyCap);
  } catch (err) {
    if (err instanceof ConfigError || err instanceof IngestError) {
      d.store.addGap(w.id, "judgment", "config-error", fifo[0]!.seq, fifo[0]!.seq, err.message, now);
      return { state: "config-error", reviewId: null, why: err.message };
    }
    throw err;
  }
  const coverage = built.meta.coverage === "partial" || o.requirementsCoverage === "partial" ? "partial" : "complete";
  const categories = cfg.categories.filter(
    (c) => routeCats.includes(c) && (c !== "missed-requirement" || coverage === "complete"),
  );
  const sentCards = cards.filter((c) => built.meta.cards.includes(c.id));
  const dispatchTip = w.cursor;
  d.store.insertReview({
    id: reviewId,
    watchId: w.id,
    route: o.preview ? `preview:${selected.id}` : route.id,
    model: route.model,
    state: "dispatching",
    preview: o.preview,
    dispatchTip,
    cardIds: built.meta.cards,
    meta: { ...built.meta, coverage, categories, requirementsCoverage: o.requirementsCoverage, contextNotes: o.context.notes, contextGaps: o.context.gaps },
    dispatchSnapshot: o.context.snapshot,
    settingsRev: o.settingsRev,
    epoch: w.epoch,
    now,
  });

  // ---- admission: one atomic reservation before the request
  // Every await before this point (context read, drain) may have been cut: a canceled review reserves nothing.
  if (o.signal.aborted) return cancelledBeforeSend(d, reviewId, o.signal, now);
  const reservation = o.preview ? null : reservationFor(route, cfg, built.meta.bodyBytes);
  const ledgerId = reservation ? `lg_${reviewId}` : null;
  if (reservation && ledgerId) {
    const day = dayKey(now, cfg.budgets.timeZone);
    const adm = d.store.reserve(
      {
        id: ledgerId,
        reviewId,
        watchId: w.id,
        route: route.id,
        model: route.model,
        billing: reservation.billing,
        day,
        reservedUsd: reservation.usd,
        reservedTokens: reservation.tokens,
        priceVersion: reservation.billing === "usd" ? "2026-10-04" : null,
        basis: reservation.basis,
      },
      reservation.caps,
      now,
      d.budgetSince(now),
    );
    if (!adm.ok) {
      holdForBudget(d.store, w.id, day, JSON.stringify(reservation.caps), now);
      d.store.finishReview(reviewId, "refused-budget", null, adm.why, null, now);
      d.changed();
      return { state: "refused", reviewId, why: adm.why };
    }
    d.store.ledgerUpdate(ledgerId, { state: "sending" }, now);
  }

  // ---- exactly one request
  d.store.finishReview(reviewId, "sending", null, null, null, now);
  let result: SendResult;
  try {
    result = await transport.send({ body: built.body, cards: sentCards }, o.signal);
  } catch (err) {
    result = { outcome: "ambiguous", status: null, dispatched: "unknown", error: `transport threw: ${err instanceof Error ? err.message : String(err)}` };
  }
  const end = d.now();
  if (ledgerId) {
    const row = d.store.getLedger(ledgerId)!;
    d.store.ledgerUpdate(ledgerId, settle(row, route.model, result), end);
  }
  const cancelReason = o.signal.aborted ? String(o.signal.reason ?? "canceled") : null;
  if (cancelReason) {
    d.store.finishReview(reviewId, "cancelled", result.outcome, `canceled: ${cancelReason}`, null, end);
    d.changed();
    return { state: "cancelled", reviewId, why: cancelReason };
  }
  if (result.outcome !== "completed") {
    if (!o.preview) {
      const fresh = d.store.getWatch(w.id)!;
      const p = pauseOf(fresh);
      p.reviewFailed();
      storePause(fresh, p);
      d.store.saveWatch(fresh, end);
    }
    d.store.finishReview(reviewId, "failed", result.outcome, result.error ?? `outcome ${result.outcome}`, null, end);
    d.changed();
    return { state: "failed", reviewId, why: result.error ?? result.outcome };
  }
  const parsed = parseOutput(result.output);
  if ("error" in parsed) {
    if (!o.preview) {
      const fresh = d.store.getWatch(w.id)!;
      const p = pauseOf(fresh);
      p.reviewFailed();
      storePause(fresh, p);
      d.store.saveWatch(fresh, end);
    }
    d.store.finishReview(reviewId, "failed", "cut", parsed.error, null, end);
    d.changed();
    return { state: "failed", reviewId, why: parsed.error };
  }
  d.store.finishReview(reviewId, "completing", result.outcome, null, { parsed, usage: result.usage ?? null, model: result.model ?? null }, end);
  return completeReview(d, reviewId, o.signal);
}

function cancelledBeforeSend(d: ReviewDeps, reviewId: string, signal: AbortSignal, now: number): ReviewEnd {
  const why = String(signal.reason ?? "canceled");
  d.store.finishReview(reviewId, "cancelled", "pre-upstream", `canceled before the request: ${why}`, null, now);
  d.changed();
  return { state: "cancelled", reviewId, why };
}

/** Packet context for validation, rebuilt from the stored review and its cards. */
function packetContext(d: ReviewDeps, w: WatchRow, review: NonNullable<ReturnType<Store["getReview"]>>): PacketContext {
  const cards: PacketContext["cards"] = new Map();
  for (const c of d.store.getCards(w.id, review.cardIds)) {
    cards.set(c.id, { kind: c.kind, text: c.text, hunks: c.meta.hunks, path: c.path, seq: c.seq, ...(c.meta.side ? { side: c.meta.side } : {}) });
  }
  return {
    watchId: w.id,
    root: w.rootPath,
    cards,
    requirements: review.meta.packetRequirements ?? {},
    classes: review.meta.packetClasses ?? {},
    categories: review.meta.categories ?? [],
  };
}

/**
 * Completion: read the relevant rows after the dispatch tip (typed, bounded,
 * each read under a deadline), read a fresh context and classify. Stale is
 * discarded with the frontier unchanged. Unknown is held: later passes
 * recheck it from the stored result with no new request, until it is current,
 * stale or expired. A preview is never held.
 */
export async function completeReview(d: ReviewDeps, reviewId: string, signal: AbortSignal): Promise<ReviewEnd> {
  const review = d.store.getReview(reviewId);
  if (!review) return { state: "failed", reviewId, why: "review row missing" };
  const w = d.store.getWatch(review.watchId);
  if (!w) {
    d.store.finishReview(reviewId, "stale", review.outcome, "watch removed", review.result, d.now());
    return { state: "stale", reviewId, why: "watch removed" };
  }
  const lim = d.limits();
  const src = { list: (q: any) => d.host.listEvents(w.threadId, q, readSignal(signal, lim.deadlineMs)) };
  const after = await readPages(src, { types: COMPLETION_TYPES }, "asc", review.dispatchTip ?? 0, lim.completionReadPages, 2 * 1024 * 1024);
  const drained = after.status === "complete";
  const currentRev = Number(d.store.getMeta("settingsRev") ?? "0");
  const dispatchRefs = Object.keys((review.dispatchSnapshot as Snapshot | null)?.activeRow?.refs ?? {});
  const ctx = await readContext(d.host, d.initiatives, w.threadId, { epoch: w.epoch, settingsRev: currentRev }, dispatchRefs, signal, {
    deadlineMs: lim.deadlineMs,
    cachedThread: w.thread,
  });
  const rq = d.store.loadRequests(w.id, { parent: ctx.parent, fork: ctx.fork });
  const nowMin = d.now() / 60_000;
  const completion: Completion = classifyCompletion(review.dispatchSnapshot as Snapshot, ctx.snapshot, after.rows as EventRow[], drained, rq, nowMin);
  d.store.saveRequests(w.id, rq);
  const end = d.now();
  const result = { ...(review.result ?? {}), completion, ...(drained ? {} : { completionRead: after.status }) };
  if (completion.state === "stale") {
    d.store.finishReview(reviewId, "stale", review.outcome, completion.reasons.join(", "), result, end);
    d.changed();
    return { state: "stale", reviewId, why: completion.reasons.join(", ") };
  }
  if (completion.state === "unknown") {
    const why = completion.reasons.join(", ");
    if (review.preview) {
      d.store.finishReview(reviewId, "unknown", review.outcome, why, result, end);
    } else if (review.state !== "held") {
      d.store.holdReview(reviewId, why, result, end);
    } else if (lim.heldExpiryMs !== null && end - (review.heldAt ?? end) >= lim.heldExpiryMs) {
      expireHeld(d, w, review, why, result, end);
      d.changed();
      return { state: "expired", reviewId, why };
    } else {
      d.store.recheckHeld(reviewId, why, result, end);
    }
    d.changed();
    return { state: "held", reviewId, why };
  }
  // current-as-of-tip: validate and store
  const parsed = (review.result?.parsed ?? { findings: [], resolved: [], dropped: [] }) as {
    findings: ModelFinding[];
    resolved: Array<{ locator: string; evidence: string; note: string }>;
    dropped: Array<{ index: number; reason: string }>;
    jev?: JevScored;
  };
  const ctxP = packetContext(d, w, review);
  let accepted = 0;
  let dropped = parsed.dropped.length;
  const store = (a: { id: string; category: string; severity: string; locator: string; evidence: string; subjectVerified: boolean; summary: string; shown: any; retained: any; score?: number | null; change?: unknown }) => {
    const r = d.store.addOccurrence(
      {
        // A preview's occurrence has its own id: it never reconfirms or absorbs a real one.
        id: review.preview ? `pv:${reviewId}:${a.id}` : a.id,
        watchId: w.id,
        category: a.category,
        locator: a.locator,
        severity: a.severity,
        evidence: a.evidence,
        reviewId,
        route: review.route,
        model: review.model,
        summary: a.summary,
        shown: a.change ? { ...a.shown, change: a.change } : a.shown,
        retained: a.retained,
        asOfSeq: review.dispatchTip,
        coverage: review.meta.coverage ?? "complete",
        score: a.score ?? null,
        preview: review.preview,
        createdAt: end,
      },
      a.subjectVerified,
    );
    if (r.stored) accepted++;
    if (r.notify) d.notify({ occurrenceId: a.id, watchId: w.id, severity: a.severity, reason: r.notify, summary: a.summary });
  };
  if (parsed.jev) {
    for (const f of jevFindings(parsed.jev, ctxP)) store(f);
  } else {
    const acc = acceptFindings(parsed.findings, ctxP);
    dropped += acc.dropped.length;
    for (const a of acc.accepted) store(a);
    result.dropped = [...parsed.dropped, ...acc.dropped];
    if (!review.preview) {
      const unproven = applyResolved(d, w, ctxP, parsed.resolved, end);
      if (unproven.length > 0) result.resolvedDropped = unproven;
    }
  }
  if (!review.preview) {
    // Later cards of this same packet may already have removed the cited lines.
    d.store.noteReversals(w.id, w.rootPath, [...ctxP.cards].map(([id, c]) => ({ id, kind: c.kind, seq: c.seq ?? 0, path: c.path ?? null, hunks: c.hunks, side: c.side })), end);
    d.store.markReviewed(w.id, review.cardIds);
    const fresh = d.store.getWatch(w.id)!;
    const p = pauseOf(fresh);
    p.reviewSucceeded();
    storePause(fresh, p);
    d.store.saveWatch(fresh, end);
  }
  d.store.finishReview(reviewId, "current", review.outcome, null, { ...result, accepted, droppedCount: dropped }, end);
  d.changed();
  return { state: "current", reviewId, accepted, dropped };
}

/**
 * A model "resolved" note changes an issue only with newer proven evidence for
 * that same issue: a packet edit (or vanished checkpoint hunk) after the
 * occurrence's evidence that removes its cited lines. A passing command, a
 * claim, the citing card itself and other categories never resolve anything.
 * Unproven notes are kept as dropped, with the reason.
 */
function applyResolved(d: ReviewDeps, w: WatchRow, ctxP: PacketContext, notes: Array<{ locator: string; evidence: string; note: string }>, now: number) {
  const unproven: Array<{ locator: string; evidence: string; reason: string }> = [];
  for (const r of notes) {
    const card = ctxP.cards.get(r.evidence);
    const issues = d.store.listIssues(w.id).filter((x) => x.locator === r.locator && x.state === "open");
    const ti = issues.find((x) => x.category === "test-integrity");
    let reason: string | null = null;
    if (!card) reason = "evidence-not-in-packet";
    else if (!ti) reason = issues.length > 0 ? "category-has-no-provable-resolution" : "no-open-issue";
    else {
      const change = d.store.issueChange(w.id, ti.category, ti.locator);
      const later = { kind: card.kind, seq: card.seq ?? 0, path: card.path ?? null, hunks: card.hunks, side: card.side };
      if (!change) reason = "issue-citation-unknown";
      else if (!reverses(later, change, w.rootPath)) reason = "evidence-does-not-remove-the-cited-lines";
    }
    if (reason) unproven.push({ locator: r.locator, evidence: r.evidence, reason });
    else d.store.setIssueState(w.id, ti!.category, ti!.locator, "model-reported-resolved", ti!.subjectVerified, now);
  }
  return unproven;
}

/** A held result whose currentness stayed unknown past the configured time: its cards become a named not-judged gap. */
function expireHeld(d: ReviewDeps, w: WatchRow, review: NonNullable<ReturnType<Store["getReview"]>>, why: string, result: unknown, now: number): void {
  const cards = d.store.getCards(w.id, review.cardIds);
  const minutes = Math.round((now - (review.heldAt ?? now)) / 60_000);
  const detail = `review ${review.id} held ${minutes} min with currentness unknown (${why}); ${review.cardIds.length} cards not judged and not sent again`;
  d.store.finishReview(review.id, "expired", review.outcome, detail.slice(0, 2000), result, now);
  d.store.markReviewed(w.id, review.cardIds);
  if (cards.length > 0) d.store.addGap(w.id, "judgment", "held-expired", Math.min(...cards.map((c) => c.seq)), Math.max(...cards.map((c) => c.seq)), detail.slice(0, 2000), now);
}

// ------------------------------------------------------------------ Jev

interface JevScored {
  threshold: number;
  scores: Array<{ ref: string; card: string; hunkIndex: number; score: number }>;
}

function jevCards(fifo: CardRow[], root: string | null): JevCard[] {
  return fifo.map((c) => ({
    id: c.id,
    hunks: ((c.meta.hunks as Hunk[] | undefined) ?? []).map((h) => ({ path: normPath(h.path, root), subject: subjectOf(h), truncated: h.truncated, hunk: h })),
  }));
}

function subjectOf(h: Hunk): string {
  const l = h.lines.find((x) => x.kind === "+") ?? h.lines.find((x) => x.kind === "-");
  if (!l) return "ambiguous";
  const s = l.kind === "+" ? deriveSubject(h, "new", l.new!) : deriveSubject(h, "old", l.old!);
  return s.status === "proven" ? `${[...s.chain, s.name].join(" › ")} (proven)` : "ambiguous";
}

function jevFindings(j: JevScored, ctx: PacketContext) {
  const out = [];
  for (const s of j.scores) {
    if (s.score < j.threshold) continue;
    const card = ctx.cards.get(s.card);
    const h = card?.hunks?.[s.hunkIndex];
    if (!card || !h) continue;
    const l = h.lines.find((x) => x.kind === "+") ?? h.lines.find((x) => x.kind === "-")!;
    const side = l.kind === "+" ? "new" : "old";
    const sub = deriveSubject(h, side, (side === "new" ? l.new : l.old)!);
    const path = normPath(h.path, ctx.root);
    const proven = sub.status === "proven";
    const subject = proven ? [...sub.chain, sub.name].join(" › ") : `${path}:L${side === "new" ? l.new : l.old}`;
    const locator = proven ? `${path}::${subject}@${sub.side}:L${sub.declLine}` : `${path}@${side}:L${side === "new" ? l.new : l.old}`;
    const text = h.lines.map((x) => x.kind + x.text).join("\n");
    out.push({
      id: `${ctx.watchId}:${s.ref}`.replace(/[^\w:#/@.-]/gu, "_"),
      category: "test-integrity",
      severity: "unrated",
      locator,
      evidence: s.ref,
      subjectVerified: proven,
      summary: `Jev (${JEV_MODEL}) answered ${s.score.toFixed(2)} to: does this edit make the test accept results it rejected before, or stop checking something? Threshold ${j.threshold} (unmeasured default); unrated severity; single-answer score.`,
      shown: {
        subject,
        locator,
        subjectStatus: proven ? "verified" : "ambiguous",
        subjectVerified: proven,
        path,
        after: { path, hunk: s.hunkIndex, side: "new", lines: [h.newStart, h.newStart + h.newLen - 1], text },
        badges: [...(proven ? [] : ["ambiguous subject"]), ...(h.truncated ? ["truncated hunk"] : [])],
      },
      retained: retain({ after: { text } }),
      score: s.score,
      change: citedChange(h, ctx.root, { before: [h.oldStart, h.oldStart + Math.max(0, h.oldLen - 1)], after: [h.newStart, h.newStart + Math.max(0, h.newLen - 1)] }, ctx.cards.get(s.card)?.seq ?? 0),
    });
  }
  return out;
}

async function runJev(d: ReviewDeps, w: WatchRow, o: ReviewOptions, fifo: CardRow[], reviewId: string): Promise<ReviewEnd> {
  const cfg = o.config.config;
  const now = d.now();
  const reqText = render(inclusionOrder([], o.requirements), [], [], []).split("## Open issues")[0]!.trim();
  const plan: JevPlan | null = planJevReview(jevCards(fifo, w.rootPath), reqText, cfg.testGlobs, Math.min(MAX_BODY_BYTES, cfg.bodyCap));
  if (!plan) return { state: "nothing", reviewId: null, why: "no unreviewed evidence" };
  const win = plan.window;
  const windowCards = fifo.filter((c) => win.window.includes(c.id));
  const seqs = windowCards.map((c) => c.seq);
  const lo = Math.min(...seqs);
  const hi = Math.max(...seqs);
  const others = cfg.categories.filter((c) => c !== "test-integrity");
  const recordGaps = () => {
    for (const g of win.gaps) d.store.addGap(w.id, "judgment", "candidate-cap", lo, hi, `${g.card}: ${g.refs.join(", ")} not judged (${g.limit})`, now);
    if (win.skipped.length > 0) d.store.addGap(w.id, "judgment", "jev-skipped", lo, hi, win.skipped.map((s) => `${s.ref}: ${s.reason}`).join("; ").slice(0, 2000), now);
    if (others.length > 0) d.store.addGap(w.id, "judgment", "not-judged-by-route", lo, hi, `Jev does not judge ${others.join(" or ")}`, now);
  };
  const meta = {
    cards: win.window,
    coverage: plan.window.partialCoverage || o.requirementsCoverage === "partial" ? "partial" : "complete",
    categories: ["test-integrity"],
    packetRequirements: {},
    packetClasses: {},
    jev: { judged: win.judged, gaps: win.gaps, skipped: win.skipped, bytes: win.bytes },
  };
  d.store.insertReview({
    id: reviewId,
    watchId: w.id,
    route: "jev:typesafe",
    model: JEV_MODEL,
    state: "dispatching",
    preview: false,
    dispatchTip: w.cursor,
    cardIds: win.window,
    meta,
    dispatchSnapshot: o.context.snapshot,
    settingsRev: o.settingsRev,
    epoch: w.epoch,
    now,
  });
  const day = dayKey(now, cfg.budgets.timeZone);
  if (plan.kind === "no-call") {
    // A161 F3: no call, no reservation; the frontier moves past the window as after a completed review.
    d.store.noCall({ id: `lg_${reviewId}`, reviewId, watchId: w.id, route: "jev:typesafe", model: JEV_MODEL, day, note: plan.reason }, now);
    recordGaps();
    d.store.markReviewed(w.id, win.window);
    d.store.finishReview(reviewId, "no-call", "no-call", plan.reason, { jev: { judged: [], reason: plan.reason } }, now);
    d.changed();
    return { state: "no-call", reviewId, why: plan.reason };
  }
  const body = JSON.stringify(win.body);
  const bytes = Buffer.byteLength(body);
  if (bytes > Math.min(MAX_BODY_BYTES, cfg.bodyCap)) {
    // The window builder bounds the whole body, so this is a defect: shown, never retried silently.
    d.store.addGap(w.id, "judgment", "config-error", lo, hi, `Jev body ${bytes} bytes exceeds the cap`, now);
    d.store.finishReview(reviewId, "config-error", null, `Jev body ${bytes} bytes exceeds the cap`, null, now);
    d.changed();
    return { state: "config-error", reviewId, why: "Jev body over cap" };
  }
  if (o.signal.aborted) return cancelledBeforeSend(d, reviewId, o.signal, now);
  const res = reservationFor(ROUTES["jev:typesafe"], cfg, bytes)!;
  const adm = d.store.reserve(
    { id: `lg_${reviewId}`, reviewId, watchId: w.id, route: "jev:typesafe", model: JEV_MODEL, billing: "usd", day, reservedUsd: res.usd, reservedTokens: res.tokens, priceVersion: "2026-10-04", basis: res.basis },
    res.caps,
    now,
    d.budgetSince(now),
  );
  if (!adm.ok) {
    holdForBudget(d.store, w.id, day, JSON.stringify(res.caps), now);
    d.store.finishReview(reviewId, "refused-budget", null, adm.why, null, now);
    d.changed();
    return { state: "refused", reviewId, why: adm.why };
  }
  d.store.ledgerUpdate(`lg_${reviewId}`, { state: "sending" }, now);
  d.store.finishReview(reviewId, "sending", null, null, null, now);
  const asked = win.judged.map((j) => j.id);
  let result: SendResult;
  try {
    result = await createJevTransport(d.transportDeps).send(body, asked, o.signal);
  } catch (err) {
    result = { outcome: "ambiguous", status: null, dispatched: "unknown", error: String(err) };
  }
  const end = d.now();
  d.store.ledgerUpdate(`lg_${reviewId}`, settle(d.store.getLedger(`lg_${reviewId}`)!, JEV_MODEL, result), end);
  if (o.signal.aborted) {
    d.store.finishReview(reviewId, "cancelled", result.outcome, `canceled: ${String(o.signal.reason)}`, null, end);
    return { state: "cancelled", reviewId, why: String(o.signal.reason) };
  }
  if (result.outcome !== "completed") {
    const fresh = d.store.getWatch(w.id)!;
    const p = pauseOf(fresh);
    p.reviewFailed();
    storePause(fresh, p);
    d.store.saveWatch(fresh, end);
    d.store.finishReview(reviewId, "failed", result.outcome, result.error ?? result.outcome, null, end);
    d.changed();
    return { state: "failed", reviewId, why: result.error ?? result.outcome };
  }
  const answers = result.output as Record<string, number>;
  const scores = win.judged.map((j) => ({ ref: j.ref, card: j.card, hunkIndex: j.hunkIndex, score: answers[j.id]! }));
  recordGaps();
  d.store.finishReview(reviewId, "completing", "completed", null, { parsed: { findings: [], resolved: [], dropped: [], jev: { threshold: cfg.jevThreshold, scores } }, usage: result.usage ?? null }, end);
  return completeReview(d, reviewId, o.signal);
}

/** Pause the watch for budget on a freshly read row (other writers may have changed it). */
function holdForBudget(store: Store, watchId: string, day: string, capsKey: string, now: number): void {
  const fresh = store.getWatch(watchId);
  if (!fresh) return;
  fresh.state.budgetHold = { day, capsKey };
  const p = pauseOf(fresh);
  p.budget(true);
  storePause(fresh, p);
  store.saveWatch(fresh, now);
}

export function severityAtLeast(sev: string, threshold: string): boolean {
  return (SEVERITY_RANK[sev] ?? 0) >= (SEVERITY_RANK[threshold] ?? 0);
}
