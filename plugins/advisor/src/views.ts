// Read models for the panel, the settings section and the CLI. Every view says
// what it is not: acknowledgements are not sign-off, coverage gaps are named,
// and fake results are labeled as such.

import { PRICE_VERSION, PRICES } from "./config/prices.js";
import { ROUTES, ROUTE_IDS } from "./config/routes.js";
import type { ResolvedConfig } from "./config/settings.js";
import { label } from "./rules/packet.js";
import { inclusionOrder } from "./rules/requests.js";
import { memberLabel, type Advisor } from "./runtime/advisor.js";
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
  /** The Initiative and role this thread has, as last listed by a watched Initiative. */
  initiative: MemberView | null;
  /** Why an Initiative watch stopped observing this thread (it keeps its history). */
  ended: string | null;
}

export interface MemberView {
  id: string;
  name: string;
  kind: string;
  role: string;
  worker: string | null;
  state: string;
  /** "W12 work", "coordinator", "user thread". */
  label: string;
  excluded: boolean;
}

export interface InitiativeWatchView {
  id: string;
  name: string;
  enabled: boolean;
  archived: boolean;
  since: number;
  syncedAt: number | null;
  error: string | null;
  members: { total: number; live: number; observed: number; excluded: number };
}

/**
 * The thread's Initiative and role: its own context read (current, also for a
 * thread you watch without its Initiative), else what a watched Initiative last listed.
 */
export function memberView(store: Store, threadId: string): MemberView | null {
  const own = store.getWatchByThread(threadId)?.state.initiative;
  const m = store.memberOf(threadId);
  if (own) {
    const same = m?.initiativeId === own.id;
    // A watch reads its thread's own membership; whether the thread is archived is the Initiative watch's finding.
    return { ...own, state: same && m.state === "archived" ? "archived" : own.state, label: memberLabel(own), excluded: same ? m.excluded : false };
  }
  if (!m) return null;
  return { id: m.initiativeId, name: m.initiativeName, kind: m.kind, role: m.role, worker: m.worker, state: m.state, label: memberLabel(m), excluded: m.excluded };
}

export function initiativeWatchView(store: Store, id: string): InitiativeWatchView | null {
  const iw = store.getInitiativeWatch(id);
  if (!iw) return null;
  const members = store.listMembers(id);
  const live = members.filter((m) => m.state === "active" || m.state === "stopped");
  return {
    id: iw.id,
    name: iw.name,
    enabled: iw.enabled,
    archived: iw.archived,
    since: iw.since,
    syncedAt: iw.syncedAt,
    error: iw.error,
    members: {
      total: members.length,
      live: live.length,
      observed: members.filter((m) => store.getWatchByThread(m.threadId)?.enabled === true).length,
      excluded: members.filter((m) => m.excluded).length,
    },
  };
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
  initiativeWatches: InitiativeWatchView[];
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
    initiative: memberView(store, w.threadId),
    ended: w.state.initiativeEnded,
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
    initiativeWatches: store.listInitiativeWatches().map((iw) => initiativeWatchView(store, iw.id)!),
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
  /** The watched thread, and its Initiative and role when a watched Initiative lists it. */
  threadId: string | null;
  initiative: MemberView | null;
  citation: { before: { lines: number[]; text: string; path: string | null } | null; after: { lines: number[]; text: string; path: string | null } | null; requirement: { ref: string; quote: string; status: string | null } | null; claim: string | null; command: string | null };
  badges: string[];
}

export function findingView(store: Store, o: OccurrenceRow, thread?: { threadId: string; initiative: MemberView | null }): FindingView {
  const s = o.shown as Record<string, any>;
  const threadId = thread?.threadId ?? store.getWatch(o.watchId)?.threadId ?? null;
  const initiative = thread ? thread.initiative : threadId ? memberView(store, threadId) : null;
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
    threadId,
    initiative,
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
  const thread = { threadId: w.threadId, initiative: memberView(store, w.threadId) };
  return {
    summary: watchSummary(store, advisor, w),
    requirements: reqs.map((r) => ({ ref: r.ref, label: label(r), class: r.class, text: r.text, historic: r.class === "former-parent" || r.class === "former-assignment-brief" || r.class === "inherited" })),
    panelOnly: rq.panelHistory(),
    requestCoverage: rq.coverage(now / 60_000, horizon),
    requestGaps: [...rq.gaps, ...rq.forkGaps()],
    requestNotes: rq.notes,
    pending: rq.pending(now / 60_000, horizon),
    gaps: store.listGaps(w.id, 100),
    findings: store.listOccurrences(w.id, 200).map((o) => findingView(store, o, thread)),
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

// ------------------------------------------------------------------ one feed (T105)

/** A finding in the cross-watch feed, with the thread it belongs to. */
export interface FeedItem extends FindingView {
  watchId: string;
  threadTitle: string | null;
  /** The separate thread Erwin opened to discuss it, if any. */
  discussionThreadId: string | null;
}

export interface FeedView {
  items: FeedItem[];
  next: { createdAt: number; id: string } | null;
  /** Unseen real findings at or above the display threshold, across every watch. */
  unseen: number;
  /** The same, within this filter, on every page (not only the loaded one). */
  filterUnseen: number;
  initiatives: Array<{ id: string; name: string; unseen: number }>;
  threads: Array<{ watchId: string; threadId: string; title: string | null; initiative: string | null; unseen: number }>;
}

/** Unseen real findings at or above the threshold, per watch. Preview findings never count. */
export function unseenByWatch(store: Store, threshold: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of store.unseenCounts()) if (severityRank(r.severity) >= severityRank(threshold)) out.set(r.watchId, (out.get(r.watchId) ?? 0) + r.n);
  return out;
}

export function unseenTotal(store: Store, threshold: string): number {
  let n = 0;
  for (const v of unseenByWatch(store, threshold).values()) n += v;
  return n;
}

/** The watch ids a feed filter selects: one watch, every watch of one Initiative, or all (null). */
export function feedWatchIds(store: Store, filter: { initiativeId?: string | undefined; watchId?: string | undefined }): string[] | null {
  if (filter.watchId) return [filter.watchId];
  if (!filter.initiativeId) return null;
  return store.listWatches().filter((w) => memberView(store, w.threadId)?.id === filter.initiativeId).map((w) => w.id);
}

export function feedView(
  store: Store,
  advisor: Advisor,
  filter: { initiativeId?: string | undefined; watchId?: string | undefined; before?: { createdAt: number; id: string } | undefined; limit?: number | undefined },
): FeedView {
  const threshold = advisor.resolved.config.severityThreshold;
  const limit = filter.limit ?? 50;
  const watches = new Map(store.listWatches().map((w) => [w.id, w]));
  const members = new Map([...watches.values()].map((w) => [w.id, memberView(store, w.threadId)]));
  const ids = feedWatchIds(store, filter);
  const rows = store.listFeed(ids, limit, filter.before ?? null);
  const unseen = unseenByWatch(store, threshold);
  const initiatives = new Map<string, { id: string; name: string; unseen: number }>();
  for (const [id, m] of members) {
    if (!m) continue;
    const i = initiatives.get(m.id) ?? { id: m.id, name: m.name, unseen: 0 };
    i.unseen += unseen.get(id) ?? 0;
    initiatives.set(m.id, i);
  }
  return {
    items: rows.map((o) => {
      const w = watches.get(o.watchId);
      return {
        ...findingView(store, o, { threadId: w?.threadId ?? "", initiative: members.get(o.watchId) ?? null }),
        watchId: o.watchId,
        threadTitle: w?.title ?? null,
        discussionThreadId: store.discussionOf(o.id),
      };
    }),
    next: rows.length === limit ? { createdAt: rows[rows.length - 1]!.createdAt, id: rows[rows.length - 1]!.id } : null,
    unseen: [...unseen.values()].reduce((a, b) => a + b, 0),
    filterUnseen: ids === null ? [...unseen.values()].reduce((a, b) => a + b, 0) : ids.reduce((a, id) => a + (unseen.get(id) ?? 0), 0),
    initiatives: [...initiatives.values()].sort((a, b) => a.name.localeCompare(b.name)),
    threads: [...watches.values()].map((w) => ({
      watchId: w.id,
      threadId: w.threadId,
      title: w.title,
      initiative: members.get(w.id) ? `${members.get(w.id)!.name} · ${members.get(w.id)!.label}` : null,
      unseen: unseen.get(w.id) ?? 0,
    })),
  };
}
