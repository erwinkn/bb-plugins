// One durable request table (A144 §3, A152 §3, A160 F1–F3, A170 fork amendment).
//
// Nothing about authority is stored at ingest. Each row keeps only facts:
// sender, initiator, input parts, request seq, receipt seq and creation time.
// Classes are computed whenever they are used, from those facts, the recorded
// native-parent history and the *current* context.

import {
  type EventRow,
  type EventSource,
  OWNER_PAGES,
  RECEIPT_TYPES,
  REQUEST_TYPES,
  SEED_BYTES,
  SEED_PAGES,
  SWEEP_PAGES,
  errorStatus,
  readPages,
} from "./events.js";

/** Classes whose accepted text the judge sees. CURRENT items also gate dispatch and staleness. */
export const CURRENT = new Set(["assignment-brief", "unattributed", "coordinator", "parent"]);
/** Context only: never gate, never stale, never a missed requirement. */
export const HISTORIC = new Set(["former-parent", "former-assignment-brief", "inherited"]);
export const AUTHORITATIVE = CURRENT;
export const PENDING_HORIZON_MIN = 30;
export const UNKNOWN = Symbol("unknown");

/** Initiatives ASSIGNMENT_STATES that are progress (a note at completion, never stale). */
export const PROGRESS_STATES = new Set(["dispatching", "queued", "running", "idle_no_report", "reported", "accepted"]);

export type RequirementClass =
  | "assignment-brief"
  | "former-assignment-brief"
  | "unattributed"
  | "coordinator"
  | "parent"
  | "former-parent"
  | "inherited"
  | "system"
  | "peer"
  | "unproven";

export type Proof = "native-parent-at-acceptance" | "unverified" | "none" | `assignment:${string}` | "fork-copy" | "fork-origin-unknown";

export interface Requirement {
  ref: string;
  class: RequirementClass;
  proof: Proof;
  text: string;
  partial?: boolean;
}

export interface RequestRow {
  seq: number;
  sender: string | null;
  initiator: string | null;
  source: string | null;
  parts: Array<Record<string, any>>;
  text: string;
  state: "requested" | "accepted" | "rejected";
  settledSeq: number | null;
  seenAt: number;
  createdAt: number | null;
  seedUnsettled?: boolean;
}

export interface BriefRef {
  text: string;
  state: string;
}

/**
 * A fork's identity, from threads.get: the source thread and the fork's own
 * creation time. BB copies the source's request and receipt rows into a fork
 * with their original createdAt and does not copy the parent-change history, so
 * a copied row is inherited context, not a fresh instruction to the fork.
 * Null: not a fork. "unknown": the thread read failed or lacked the fields.
 */
export type ForkOrigin = { sourceThreadId: string; createdAt: number } | null | "unknown";

/**
 * The watched thread's native parent history, from its own seq-ordered
 * system/operation ownership_change rows. Any other metadata shape makes the
 * whole history unknown rather than guessed. parentAt(seq) is a pure function
 * of recorded rows; only with no recorded change does it fall back to the
 * context's parent, and only after a drain that reached the tip (anchorOk).
 */
export class Ownership {
  changes = new Map<number, [string | null, string | null]>();
  knownFrom = 0;
  malformed: number[] = [];
  anchor: string | null;
  anchorOk = true;

  constructor(parent: string | null = null) {
    this.anchor = parent;
  }

  add(row: EventRow): void {
    const d = row.data ?? {};
    if (row.type !== "system/operation" || d.operation !== "ownership_change") return;
    const md = (d.metadata ?? {}) as Record<string, unknown>;
    if ("previousParentThreadId" in md && "nextParentThreadId" in md) {
      this.changes.set(row.seq, [md.previousParentThreadId as string | null, md.nextParentThreadId as string | null]);
    } else {
      this.malformed.push(row.seq);
    }
  }

  parentAt(seq: number | null): string | null | typeof UNKNOWN {
    if (seq === null || seq < this.knownFrom || this.malformed.length > 0) return UNKNOWN;
    const order = [...this.changes.keys()].sort((a, b) => a - b);
    for (let i = 1; i < order.length; i++) {
      if (this.changes.get(order[i - 1]!)![1] !== this.changes.get(order[i]!)![0]) return UNKNOWN; // a gap in the chain
    }
    const before = order.filter((s) => s < seq);
    if (before.length > 0) return this.changes.get(before[before.length - 1]!)![1];
    if (order.length > 0) return this.changes.get(order[0]!)![0];
    return this.anchorOk ? this.anchor : UNKNOWN;
  }
}

/**
 * Current-context authority of a sender, for gating only. An Initiative
 * member's authority is its current coordinator; a native parent that is not
 * the coordinator (a transfer in flight, a detach) is not. A thread outside any
 * Initiative answers to its native parent.
 */
export function authority(
  initiator: string | null,
  sender: string | null,
  parent: string | null,
  coordinator: string | null,
  member: boolean,
): RequirementClass {
  if (initiator === "system") return "system";
  if (sender === null) return "unattributed";
  if (member) return sender === coordinator ? "coordinator" : "peer";
  return sender === parent ? "parent" : "peer";
}

function receiptId(row: EventRow): string {
  return row.type === "turn/input/accepted" ? row.data.clientRequestId : row.data.requestId;
}

export interface RequestsContext {
  parent: string | null;
  coordinator: string | null;
  member?: boolean;
  briefs?: Record<string, BriefRef>;
}

export class Requests {
  rows = new Map<string, RequestRow>();
  parent: string | null;
  coordinator: string | null;
  member: boolean;
  briefs: Record<string, BriefRef>;
  fork: ForkOrigin;
  owner: Ownership;
  gaps: string[] = []; // gaps in the request record: requirement coverage partial
  notes: string[] = []; // provenance limits: shown on the panel, coverage unaffected
  orphanReceipts: number[] = [];
  orphans = new Map<string, EventRow>();

  constructor(ctx: Partial<RequestsContext> & { fork?: ForkOrigin } = {}) {
    this.parent = ctx.parent ?? null;
    this.coordinator = ctx.coordinator ?? null;
    this.member = ctx.member ?? this.coordinator !== null;
    this.briefs = ctx.briefs ?? {};
    this.fork = ctx.fork ?? null;
    this.owner = new Ownership(this.parent);
  }

  /** A fresh context read. The ownership anchor is trusted again only after a drain that reaches the tip. */
  setContext(ctx: RequestsContext): void {
    this.parent = ctx.parent;
    this.coordinator = ctx.coordinator;
    this.member = ctx.member ?? ctx.coordinator !== null;
    if (ctx.briefs !== undefined) this.briefs = ctx.briefs;
    this.owner.anchor = ctx.parent;
    this.owner.anchorOk = false;
  }

  drained(atTip: boolean): void {
    this.owner.anchorOk = atTip;
  }

  /** Refresh context, then ingest one drain batch in seq order (A160 F2). */
  drainBatch(ctx: RequestsContext, rows: EventRow[], atTip: boolean, nowMin = 0): void {
    this.setContext(ctx);
    for (const r of [...rows].sort((a, b) => a.seq - b.seq)) this.ingest(r, nowMin);
    this.drained(atTip);
  }

  /** A170: is this request a copy from the fork's source thread? */
  inheritance(r: RequestRow): "own" | "inherited" | "unknown" {
    if (this.fork === null) return "own";
    if (this.fork === "unknown" || r.createdAt === null) return "unknown";
    if (r.createdAt < this.fork.createdAt) return "inherited";
    if (r.createdAt === this.fork.createdAt) return "unknown";
    return "own";
  }

  /**
   * A160 F3: a request whose only visible input is exactly one current
   * assignment's briefText is that assignment's brief, whatever its sender or
   * route (spawn and fork send none, continue sends the coordinator).
   */
  private brief(r: RequestRow): [string, string] | null {
    const parts = r.parts ?? [];
    if (parts.length !== 1 || parts[0]!.type !== "text" || parts[0]!.visibility === "agent-only") return null;
    const hits = Object.keys(this.briefs)
      .sort()
      .filter((ref) => this.briefs[ref]!.text === parts[0]!.text);
    return hits.length === 1 ? [hits[0]!, this.briefs[hits[0]!]!.state] : null;
  }

  authorityNow(r: RequestRow): RequirementClass {
    if (this.inheritance(r) !== "own") return "inherited";
    const b = r.initiator !== "system" ? this.brief(r) : null;
    if (b) return PROGRESS_STATES.has(b[1]) ? "assignment-brief" : "former-assignment-brief";
    return authority(r.initiator, r.sender, this.parent, this.coordinator, this.member);
  }

  /**
   * (class, proof) of an accepted request. Current authority comes from the
   * current context alone, so the same recorded history gives the same current
   * requirements whenever the watch started. Historic needs proof that the
   * sender was the native parent when the instruction was accepted.
   */
  klass(r: RequestRow): [RequirementClass, Proof] {
    const now = this.authorityNow(r);
    if (now === "inherited") return ["inherited", this.inheritance(r) === "inherited" ? "fork-copy" : "fork-origin-unknown"];
    if (now === "assignment-brief" || now === "former-assignment-brief") return [now, `assignment:${this.brief(r)![0]}`];
    if (now === "system" || now === "unattributed") return [now, "none"];
    const at = this.owner.parentAt(r.settledSeq);
    const proven = at !== UNKNOWN && at === r.sender;
    if (CURRENT.has(now)) return [now, proven ? "native-parent-at-acceptance" : "unverified"];
    if (proven) return ["former-parent", "native-parent-at-acceptance"];
    return ["unproven", "none"]; // a peer, or a former authority nobody can prove
  }

  ingest(row: EventRow, nowMin = 0): void {
    const t = row.type;
    const d = row.data ?? {};
    if (t === "system/operation") {
      this.owner.add(row);
    } else if (t === "client/turn/requested") {
      const rid = d.requestId as string;
      if (!this.rows.has(rid)) {
        const parts = (Array.isArray(d.input) ? d.input : []) as Array<Record<string, any>>;
        this.rows.set(rid, {
          seq: row.seq,
          sender: d.senderThreadId ?? null,
          initiator: d.initiator ?? null,
          source: d.source ?? null,
          parts,
          text: parts.filter((p) => p.type === "text").map((p) => String(p.text ?? "")).join(""),
          state: "requested",
          settledSeq: null,
          seenAt: nowMin,
          createdAt: typeof row.createdAt === "number" ? row.createdAt : null,
        });
        const receipt = this.orphans.get(rid);
        if (receipt) {
          // its receipt was read first (seed window, sweep or drain order)
          this.orphans.delete(rid);
          this.orphanReceipts.splice(this.orphanReceipts.indexOf(receipt.seq), 1);
          this.ingest(receipt, nowMin);
        }
      }
    } else if ((RECEIPT_TYPES as readonly string[]).includes(t)) {
      const rid = receiptId(row);
      const r = this.rows.get(rid);
      if (r === undefined) {
        this.orphanReceipts.push(row.seq); // its request lies in an unscanned range, or is read later
        if (!this.orphans.has(rid)) this.orphans.set(rid, row);
      } else if (r.state === "requested") {
        r.state = t === "turn/input/accepted" ? "accepted" : "rejected";
        r.settledSeq = row.seq;
      }
    }
  }

  /**
   * Bounded pre-watch reads through the installed API (A160 F1):
   *  1. ownership history: desc from tip+1, system/operation, <= OWNER_PAGES pages
   *  2. the first request: asc, limit 1
   *  3. the newest request/receipt rows: desc from tip+1, <= SEED_PAGES pages
   *  4. only if (2) is older than (3) and unsettled: a bounded receipt sweep
   * Rows after `tip` belong to the drain. Ingest is idempotent and
   * order-independent, so overlap is harmless; every unread range is named.
   */
  async seed(src: EventSource, tip: number | null = null): Promise<void> {
    const before = tip === null ? null : tip + 1;
    const own = await readPages(src, { types: ["system/operation"] }, "desc", before, OWNER_PAGES, SEED_BYTES);
    for (const r of own.rows) this.owner.add(r);
    if (own.status !== "complete") {
      this.owner.knownFrom = own.rows.length > 0 ? own.rows[own.rows.length - 1]!.seq : (before ?? 0);
      this.notes.push(`ownership-history-before-#${this.owner.knownFrom}-not-scanned:${own.status}`);
    }
    let firsts: EventRow[] = [];
    try {
      firsts = await src.list({ order: "asc", limit: "1", types: ["client/turn/requested"] });
    } catch (err) {
      this.gaps.push(`first-request-read-failed-${errorStatus(err) ?? "unknown"}`);
    }
    const first = firsts.find((r) => tip === null || r.seq <= tip) ?? null;
    const newest = await readPages(src, { types: REQUEST_TYPES }, "desc", before, SEED_PAGES, SEED_BYTES);
    for (const r of newest.rows) this.ingest(r);
    const low = newest.rows.length > 0 ? newest.rows[newest.rows.length - 1]!.seq : before;
    if (newest.status !== "complete" && !newest.status.startsWith("page-cap")) {
      this.gaps.push(`seed-newest-${newest.status}`); // failed, refused or over the byte bound: named, never silent
    }
    if (first === null && newest.status !== "complete") this.gaps.push(`requests-before-#${low}-not-scanned`);
    if (first === null || newest.rows.length === 0 || first.seq >= newest.rows[newest.rows.length - 1]!.seq) return;
    this.ingest(first);
    const lo = first.seq;
    const hi = low!;
    if (hi - lo > 1) this.gaps.push(`requests-#${lo + 1}-#${hi - 1}-not-scanned`);
    const fid = first.data.requestId as string;
    if (this.rows.get(fid)!.state !== "requested") return;
    const sweep = await readPages(
      src,
      { types: RECEIPT_TYPES },
      "asc",
      lo,
      SWEEP_PAGES,
      SEED_BYTES,
      (rs) => rs.some((x) => receiptId(x) === fid) || rs[rs.length - 1]!.seq >= hi,
    );
    const receipt = sweep.rows.find((r) => r.seq < hi && receiptId(r) === fid);
    if (receipt) {
      this.ingest(receipt);
      return;
    }
    this.rows.get(fid)!.seedUnsettled = true; // never pending: it predates the whole watch
    this.gaps.push(`request-#${lo}-settlement-not-found`);
    if (sweep.status !== "complete" && sweep.status !== "stopped") this.gaps.push(`receipt-sweep-${sweep.status}`);
  }

  private pendingCandidates(): Array<[string, RequestRow]> {
    return [...this.rows.entries()].filter(
      ([, r]) => r.state === "requested" && !r.seedUnsettled && AUTHORITATIVE.has(this.authorityNow(r)),
    );
  }

  pending(nowMin = 0, horizonMin = PENDING_HORIZON_MIN): string[] {
    return this.pendingCandidates()
      .filter(([, r]) => nowMin - r.seenAt < horizonMin)
      .map(([k]) => k);
  }

  unsettledBeyondHorizon(nowMin: number, horizonMin = PENDING_HORIZON_MIN): string[] {
    return this.pendingCandidates()
      .filter(([, r]) => nowMin - r.seenAt >= horizonMin)
      .map(([k]) => k);
  }

  private accepted(): RequestRow[] {
    return [...this.rows.values()].filter((r) => r.state === "accepted").sort((a, b) => a.seq - b.seq);
  }

  requirements(): Requirement[] {
    const out: Requirement[] = [];
    for (const r of this.accepted()) {
      const [k, proof] = this.klass(r);
      if (CURRENT.has(k) || HISTORIC.has(k)) out.push({ ref: `R:${r.seq}`, class: k, proof, text: r.text });
    }
    return out;
  }

  /** Accepted requests the judge never sees, shown honestly on the panel. */
  panelHistory(): Array<{ ref: string; sender: string | null; class: RequirementClass }> {
    return this.accepted()
      .map((r) => ({ ref: `R:${r.seq}`, sender: r.sender, class: this.klass(r)[0] }))
      .filter((x) => !CURRENT.has(x.class) && !HISTORIC.has(x.class));
  }

  forkGaps(): string[] {
    return this.fork === "unknown" || [...this.rows.values()].some((r) => this.inheritance(r) === "unknown")
      ? ["fork-origin-unknown"]
      : [];
  }

  coverage(nowMin = 0, horizonMin = PENDING_HORIZON_MIN): "partial" | "complete" {
    return this.gaps.length > 0 || this.unsettledBeyondHorizon(nowMin, horizonMin).length > 0 || this.forkGaps().length > 0
      ? "partial"
      : "complete";
  }
}

/** Current items first (the first request, then newest first); historic items last, so a tight packet sheds them first. */
export function inclusionOrder(durable: Requirement[], items: Requirement[]): Requirement[] {
  const cur = items.filter((x) => !HISTORIC.has(x.class));
  const old = items.filter((x) => HISTORIC.has(x.class));
  return [...durable, ...cur.slice(0, 1), ...cur.slice(1).reverse(), ...old.reverse()];
}
