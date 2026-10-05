// Read models for the panel, the settings section and the CLI. Every view says
// what it is not: acknowledgements are not sign-off, coverage gaps are named,
// and fake results are labeled as such.

import { PRICE_VERSION, PRICES } from "./config/prices.js";
import { ROUTES, ROUTE_IDS } from "./config/routes.js";
import type { ResolvedConfig } from "./config/settings.js";
import { label } from "./rules/packet.js";
import { inclusionOrder } from "./rules/requests.js";
import type { Advisor } from "./runtime/advisor.js";
import { DEFERRED_STAGES, type InitiativeSource } from "./runtime/initiatives.js";
import { dayKey } from "./runtime/ledger.js";
import type { CardRow, GapRow, OccurrenceRow, Store, WatchRow } from "./store/store.js";

export interface WatchSummary {
  id: string;
  threadId: string;
  title: string | null;
  origin: string;
  enabled: boolean;
  epoch: number;
  seeded: boolean;
  atTip: boolean;
  cursor: number | null;
  tip: number | null;
  startSeq: number | null;
  pause: string[];
  failures: number;
  backlog: number;
  openFindings: number;
  unacknowledged: number;
  hold: string | null;
  inflight: boolean;
  lastDrainAt: number | null;
  lastError: string | null;
}

export interface Overview {
  activation: {
    observation: boolean;
    review: boolean;
    providerRequests: boolean;
    route: string;
    routeLabel: string;
    billing: string;
  };
  errors: { review: string[]; observation: string[] };
  notes: string[];
  settingsRev: number;
  watches: WatchSummary[];
  initiativeContext: string;
  deferred: Array<{ id: string; label: string; status: string }>;
  today: { day: string; timeZone: string; usd: { charged: number; cap: number | null; requests: number; requestCap: number | null }; subscription: { requests: number; requestCap: number | null; tokens: number; tokenCap: number | null } };
  severityThreshold: string;
}

export function watchSummary(store: Store, advisor: Advisor, w: WatchRow): WatchSummary {
  const occ = store.listOccurrences(w.id, 500).filter((o) => !o.preview);
  return {
    id: w.id,
    threadId: w.threadId,
    title: w.title,
    origin: w.origin,
    enabled: w.enabled,
    epoch: w.epoch,
    seeded: w.seeded,
    atTip: w.atTip,
    cursor: w.cursor,
    tip: w.tip,
    startSeq: w.startSeq,
    pause: w.state.pause,
    failures: w.state.failures,
    backlog: store.backlog(w.id),
    openFindings: store.listIssues(w.id).filter((i) => i.state === "open").length,
    unacknowledged: occ.filter((o) => o.acknowledgedAt === null && severityRank(o.severity) >= severityRank(advisor.resolved.config.severityThreshold)).length,
    hold: advisor.dispatchHold(w),
    inflight: advisor.inflightWatches().includes(w.id),
    lastDrainAt: w.lastDrainAt,
    lastError: w.lastError,
  };
}

export function severityRank(s: string): number {
  return s === "critical" ? 2 : s === "concern" || s === "unrated" ? 1 : 0;
}

export function overview(store: Store, advisor: Advisor, initiatives: InitiativeSource, now: number): Overview {
  const r: ResolvedConfig = advisor.resolved;
  const c = r.config;
  const route = ROUTES[c.route];
  const day = dayKey(now, c.budgets.timeZone);
  const since = advisor.budgetSince(now);
  const usd = store.periodTotals(since, "usd");
  const sub = store.periodTotals(since, "subscription");
  return {
    activation: {
      observation: c.observationEnabled,
      review: c.reviewEnabled,
      providerRequests: c.providerRequestsEnabled,
      route: route.id,
      routeLabel: route.label,
      billing: route.billing,
    },
    errors: { review: r.reviewErrors, observation: [...r.observationErrors, ...(advisor.scopeError ? [advisor.scopeError] : [])] },
    notes: [...r.notes, ...(advisor.carryNote() ? [advisor.carryNote()!] : [])],
    settingsRev: advisor.settingsRev,
    watches: store.listWatches().map((w) => watchSummary(store, advisor, w)),
    initiativeContext: initiatives.available ? initiatives.label : `${initiatives.label} Threads are reviewed as standalone threads.`,
    deferred: [...DEFERRED_STAGES],
    today: {
      day,
      timeZone: c.budgets.timeZone,
      usd: { charged: usd.usd, cap: c.budgets.usdPerDay, requests: usd.requests, requestCap: c.budgets.apiRequestsPerDay },
      subscription: { requests: sub.requests, requestCap: c.budgets.subscriptionRequestsPerDay, tokens: sub.tokens, tokenCap: c.budgets.subscriptionTokensPerDay },
    },
    severityThreshold: c.severityThreshold,
  };
}

export interface CardView {
  id: string;
  kind: string;
  seq: number;
  path: string | null;
  text: string;
  judge: boolean;
  reviewed: boolean;
  badges: string[];
  createdAt: number;
}

export function cardView(c: CardRow): CardView {
  const badges: string[] = [];
  if (c.meta.inclusion === "truncated") badges.push("truncated");
  if (c.kind === "state") badges.push(c.meta.side === "added" ? "checkpoint: new since last" : "checkpoint: gone since last", "writer unknown");
  if (c.kind === "state" && c.meta.side === "added" && Array.isArray(c.meta.observedEdits) && c.meta.observedEdits.length === 0) badges.push("no edit event (shell edit?)");
  if (c.kind === "command" && typeof c.meta.exitCode === "number" && c.meta.exitCode !== 0) badges.push(`exit ${c.meta.exitCode}`);
  if (c.kind === "command" && c.meta.outputTruncated) badges.push("output truncated");
  if (c.kind === "claim" && c.meta.truncated) badges.push("claim truncated");
  if (!c.judge) badges.push("not sent to the reviewer");
  return { id: c.id, kind: c.kind, seq: c.seq, path: c.path, text: c.text, judge: c.judge, reviewed: c.reviewed, badges, createdAt: c.createdAt };
}

export interface FindingView {
  id: string;
  category: string;
  severity: string;
  locator: string;
  subject: string;
  subjectStatus: string;
  pairing: string | null;
  claimedSubject: string | null;
  summary: string;
  route: string;
  model: string | null;
  reviewId: string;
  evidence: string;
  asOfSeq: number | null;
  coverage: string;
  score: number | null;
  preview: boolean;
  issueState: string | null;
  acknowledgedAt: number | null;
  cleared: boolean;
  createdAt: number;
  citation: { before: { lines: number[]; text: string; path: string | null } | null; after: { lines: number[]; text: string; path: string | null } | null; requirement: { ref: string; quote: string; status: string | null } | null; claim: string | null; command: string | null };
  badges: string[];
}

export function findingView(store: Store, o: OccurrenceRow): FindingView {
  const s = o.shown as Record<string, any>;
  const side = (x: any) => (x ? { lines: x.lines ?? [], text: String(x.text ?? ""), path: x.path ?? s.path ?? null } : null);
  const badges: string[] = [...(s.badges ?? [])];
  if (o.preview) badges.push("preview (fake reviewer): not a judgment");
  else if (o.route === "fake") badges.push("fake reviewer: not a judgment");
  if (o.coverage === "partial") badges.push("requirement context partial");
  if (s.subjectStatus && s.subjectStatus !== "verified") badges.push(s.subjectStatus === "rename-or-replacement" ? "rename or replacement (unverified)" : "subject unverified");
  if (s.requirementStatus) badges.push(s.requirementStatus);
  if (s.requirementSource) badges.push(s.requirementSource);
  const reversedBy = o.preview ? null : store.reversedBy(o.watchId, o.category, o.locator);
  if (reversedBy) badges.push(`cited lines removed by a later change ${reversedBy} (observed, not verified fixed)`);
  return {
    id: o.id,
    category: o.category,
    severity: o.severity,
    locator: o.locator,
    subject: String(s.subject ?? o.locator),
    subjectStatus: String(s.subjectStatus ?? "ambiguous"),
    pairing: s.pairing ?? null,
    claimedSubject: s.claimedSubject ?? null,
    summary: o.summary,
    route: o.route,
    model: o.model,
    reviewId: o.reviewId,
    evidence: o.evidence,
    asOfSeq: o.asOfSeq,
    coverage: o.coverage,
    score: o.score,
    preview: o.preview,
    issueState: o.preview ? null : store.issueState(o.watchId, o.category, o.locator),
    acknowledgedAt: o.acknowledgedAt,
    cleared: o.cleared,
    createdAt: o.createdAt,
    citation: {
      before: side(s.before),
      after: side(s.after),
      requirement: s.requirement ? { ref: s.requirement.ref, quote: s.requirement.quote, status: s.requirementStatus ?? s.requirementSource ?? null } : null,
      claim: s.claim?.text ?? null,
      command: s.command?.text ?? null,
    },
    badges,
  };
}

export interface WatchDetail {
  summary: WatchSummary;
  requirements: Array<{ ref: string; label: string; class: string; text: string; historic: boolean }>;
  panelOnly: Array<{ ref: string; sender: string | null; class: string }>;
  requestCoverage: "partial" | "complete";
  requestGaps: string[];
  requestNotes: string[];
  pending: string[];
  gaps: GapRow[];
  findings: FindingView[];
  issues: Array<{ category: string; locator: string; state: string; subjectVerified: boolean }>;
  reviews: Array<{
    id: string;
    route: string;
    state: string;
    outcome: string | null;
    error: string | null;
    createdAt: number;
    finishedAt: number | null;
    cards: number;
    preview: boolean;
    dropped: number | null;
    accepted: number | null;
    completion: string | null;
    heldAt: number | null;
    checkedAt: number | null;
    resolvedDropped: number;
  }>;
  pauseLog: WatchRow["state"]["pauseLog"];
}

export function watchDetail(store: Store, advisor: Advisor, w: WatchRow, now: number): WatchDetail {
  const rq = store.loadRequests(w.id, { parent: w.thread?.parentThreadId ?? null, fork: w.thread?.sourceThreadId && w.thread.createdAt ? { sourceThreadId: w.thread.sourceThreadId, createdAt: w.thread.createdAt } : null });
  rq.setContext({ parent: w.thread?.parentThreadId ?? null, coordinator: null, member: false });
  rq.drained(w.atTip);
  const horizon = advisor.resolved.config.pendingHorizonMinutes;
  const reqs = inclusionOrder([], rq.requirements());
  return {
    summary: watchSummary(store, advisor, w),
    requirements: reqs.map((r) => ({ ref: r.ref, label: label(r), class: r.class, text: r.text, historic: r.class === "former-parent" || r.class === "former-assignment-brief" || r.class === "inherited" })),
    panelOnly: rq.panelHistory(),
    requestCoverage: rq.coverage(now / 60_000, horizon),
    requestGaps: [...rq.gaps, ...rq.forkGaps()],
    requestNotes: rq.notes,
    pending: rq.pending(now / 60_000, horizon),
    gaps: store.listGaps(w.id, 100),
    findings: store.listOccurrences(w.id, 200).map((o) => findingView(store, o)),
    issues: store.listIssues(w.id),
    reviews: store.listReviews(w.id, 20).map((r) => ({
      id: r.id,
      route: r.route,
      state: r.state,
      outcome: r.outcome,
      error: r.error,
      createdAt: r.createdAt,
      finishedAt: r.finishedAt,
      cards: r.cardIds.length,
      preview: r.preview,
      dropped: r.result?.droppedCount ?? null,
      accepted: r.result?.accepted ?? null,
      completion: r.result?.completion?.state ?? null,
      heldAt: r.heldAt,
      checkedAt: r.checkedAt,
      resolvedDropped: Array.isArray(r.result?.resolvedDropped) ? r.result.resolvedDropped.length : 0,
    })),
    pauseLog: w.state.pauseLog,
  };
}

export function routesTable() {
  return ROUTE_IDS.map((id) => {
    const r = ROUTES[id];
    const p = r.model ? PRICES[r.model] : undefined;
    return {
      id,
      label: r.label,
      model: r.model,
      billing: r.billing,
      transport: r.transport,
      categories: [...r.categories],
      secret: r.secret,
      unverified: [...r.unverified],
      price: p && r.billing === "usd" ? { inMax: p.inMax, out: p.out, basis: p.basis, source: p.source, version: PRICE_VERSION } : null,
    };
  });
}
